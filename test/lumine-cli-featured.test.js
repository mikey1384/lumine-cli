import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../lib/commands.js";
import {
  parseAdminOperation,
  assertAdminOperationAllowedForRunScope,
} from "../lib/admin.js";
import {
  featuredFingerprint,
  readApprovedFeaturedPlan,
  readFeaturedSelections,
  runFeaturedWorkflow,
} from "../lib/admin-featured.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-featured-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
function workflowOptions(dir, extra = {}) {
  return {
    apiUrl: "https://api.example.test",
    timeoutMs: 1000,
    adminCheckpoint: path.join(dir, "scan.json"),
    ...extra,
  };
}
const operate = (name, options, request) =>
  runFeaturedWorkflow({
    options,
    operation: { featuredWorkflow: name },
    authToken: "fixture",
    runId: 73,
    request,
  });

test("Featured command parsing keeps scoped encouragement separate from generic recommendations", () => {
  for (const action of ["scan", "acknowledge", "recommend", "report"]) {
    const operation = parseAdminOperation(
      parseArgs([
        "admin",
        "featured",
        "comments",
        action,
        "--checkpoint",
        "scan.json",
      ]),
    );
    assert.equal(operation.featuredWorkflow, action);
    assert.doesNotThrow(() =>
      assertAdminOperationAllowedForRunScope({
        operation,
        runScope: "featured",
      }),
    );
  }
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "featured", "comments", "scan", "--unviewed"]),
      ),
    /every comment/,
  );
  const ordinary = parseAdminOperation(
    parseArgs(["admin", "post", "recommend", "comment:8"]),
  );
  assert.deepEqual(ordinary.body, {
    anyoneCanReward: false,
    rewardTwinkles: 0,
  });
  assert.throws(() =>
    assertAdminOperationAllowedForRunScope({
      operation: ordinary,
      runScope: "featured",
    }),
  );
  const plan = parseAdminOperation(
    parseArgs([
      "admin",
      "featured",
      "plan",
      "--remove-subject-ids",
      "1,2",
      "--add-subject-ids",
      "10,11",
      "--subject-ids",
      "11,10",
      "--posted-after",
      "2026-09-01",
    ]),
  );
  assert.deepEqual(plan.body, {
    removeIds: [1, 2],
    addIds: [10, 11],
    finalIds: [11, 10],
    postedAfter: "2026-09-01",
  });
});

test("Featured approval binds the exact plan and verifies final live ordering without extra mutations", async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "plan.json");
  const plan = {
    schemaVersion: 1,
    id: 44,
    runId: 73,
    expectedIds: [1, 2],
    finalIds: [11, 10],
    replacements: [
      { remove: { id: 1, title: "Old" }, add: { id: 10, title: "New" } },
    ],
  };
  const planHash = featuredFingerprint(plan);
  write(file, { ok: true, data: { plan, planHash } });
  assert.throws(() => readApprovedFeaturedPlan(file, ""), /go-ahead/);
  assert.equal(readApprovedFeaturedPlan(file, planHash).planHash, planHash);
  const calls = [];
  let liveIds = [11, 10];
  const request = async (args) => {
    calls.push(args);
    if (args.method === "POST")
      return {
        ok: true,
        status: "success",
        changed: true,
        data: {
          appliedPlanId: 44,
          approvedHash: planHash,
          subjects: [11, 10].map((id) => ({ id })),
        },
      };
    return { ok: true, data: { subjects: liveIds.map((id) => ({ id })) } };
  };
  const options = workflowOptions(dir, {
    adminFile: file,
    adminApprove: planHash,
  });
  assert.deepEqual(
    (await operate("apply", options, request)).data.verifiedFinalIds,
    [11, 10],
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST", "GET"],
  );
  assert.deepEqual(calls[0].body, { planId: 44, approvedHash: planHash });
  liveIds = [10, 11];
  await assert.rejects(operate("apply", options, request), (error) => {
    assert.equal(
      error.data.error.details.canonicalResult.data.appliedPlanId,
      44,
    );
    return true;
  });
  assert.equal(
    calls[0].headers["x-lumine-idempotency-key"],
    calls[2].headers["x-lumine-idempotency-key"],
  );
  await assert.rejects(
    operate("apply", options, async (args) => {
      if (args.method === "GET") throw new Error("Connection lost");
      return request(args);
    }),
    (error) => {
      assert.equal(
        error.data.error.details.canonicalResult.data.appliedPlanId,
        44,
      );
      assert.equal(
        error.data.error.details.verificationError,
        "Connection lost",
      );
      return true;
    },
  );
  write(file, { data: { plan: { ...plan, finalIds: [10, 11] }, planHash } });
  assert.throws(
    () => readApprovedFeaturedPlan(file, planHash),
    /Modified plans/,
  );
});

function scanServer() {
  const review = {
    id: 100,
    runId: 73,
    publicActorUserId: 8411,
    subjects: [
      { id: 1, title: "Series", snapshotMaxId: 120 },
      { id: 2, title: "Empty", snapshotMaxId: 0 },
      { id: 3, title: "Secret", snapshotMaxId: 5 },
    ],
  };
  const byKey = new Map();
  const pages = new Map();
  const calls = [];
  let id = 1000;
  let lostPage = false;
  let secretLocked = true;
  let coverage = null;
  const request = async (args) => {
    calls.push(args);
    const pathname = new URL(args.url).pathname;
    const key = args.headers["x-lumine-idempotency-key"];
    if (byKey.has(key)) return byKey.get(key);
    if (pathname.endsWith("/reviews")) {
      const result = { ok: true, data: { review } };
      byKey.set(key, result);
      return result;
    }
    if (pathname.endsWith("/pages")) {
      const subjectId = args.body.subjectId;
      if (subjectId === 3 && secretLocked)
        throw Object.assign(new Error("Reveal required"), {
          code: "CLI_ADMIN_SECRET_REVEAL_REQUIRED",
        });
      const previous = pages.get(args.body.previousPageId)?.data;
      const previousCount = previous?.page.commentsRead || 0;
      const all =
        subjectId === 1
          ? Array.from({ length: 101 }, (_, i) => ({
              id: 120 - i,
              author: { id: 7 },
              content:
                i === 100 ? "😊" : "A child's complete reply ".repeat(100),
              parentCommentId: i ? 120 : null,
              replyToCommentId: i > 1 ? 119 : null,
            }))
          : [];
      const comments = all.slice(previousCount, previousCount + 50);
      const exhausted = previousCount + comments.length === all.length;
      const page = {
        id: ++id,
        reviewId: 100,
        subjectId,
        snapshotMaxId: subjectId === 1 ? 120 : subjectId === 3 ? 5 : 0,
        previousPageId: args.body.previousPageId,
        nextCursor: exhausted ? null : "server-owned-cursor",
        exhausted,
        pages: (previous?.page.pages || 0) + 1,
        commentsRead: previousCount + comments.length,
      };
      const result = {
        ok: true,
        data: {
          page,
          comments,
          subject: { id: subjectId, description: "Full root context" },
        },
      };
      pages.set(page.id, result);
      byKey.set(key, result);
      if (subjectId === 1 && page.pages === 2 && !lostPage) {
        lostPage = true;
        throw new Error("Lost response after server receipt committed");
      }
      return result;
    }
    if (pathname.endsWith("/coverage")) {
      assert.equal(args.body.reviewed, true);
      const covered = args.body.pageIds.map(
        (pageId) => pages.get(pageId).data.page,
      );
      assert.ok(covered.every((page) => page.exhausted));
      coverage = {
        id: ++id,
        reviewId: 100,
        reviewed: true,
        coveredSubjectIds: covered.map((page) => page.subjectId),
        complete: covered.length === 3,
        commentsRead: covered.reduce((sum, page) => sum + page.commentsRead, 0),
      };
      const result = { ok: true, data: { coverage } };
      byKey.set(key, result);
      return result;
    }
    if (pathname.endsWith("/report"))
      return { ok: true, data: { review, coverage, encouragement: {} } };
    throw new Error(`Unexpected request ${pathname}`);
  };
  return {
    request,
    calls,
    pages,
    unlock: () => {
      secretLocked = false;
    },
  };
}

test("Featured scan resumes exact full-page receipts, distinguishes locked/empty threads, and requires read acknowledgement", async (t) => {
  const dir = fixture(t),
    options = workflowOptions(dir),
    api = scanServer();
  await assert.rejects(operate("scan", options, api.request), /Lost response/);
  const state = JSON.parse(fs.readFileSync(options.adminCheckpoint));
  assert.equal(state.subjects[1].pages.length, 1);
  const resumed = await operate(
    "scan",
    { ...options, adminResume: true },
    api.request,
  );
  assert.equal(resumed.data.fetched.commentsFetched, 101);
  assert.equal(resumed.data.fetched.subjectsCompleted, 2);
  assert.equal(resumed.data.fetched.complete, false);
  assert.equal(resumed.data.reviewedCoverage, null);
  assert.equal(resumed.data.fetched.blocked[0].subjectId, 3);
  assert.equal(resumed.data.pageFiles.length, 4);
  for (const entry of resumed.data.pageFiles)
    assert.equal(fs.statSync(entry.file).mode & 0o777, 0o600);
  const lastThreadPage = JSON.parse(
    fs.readFileSync(resumed.data.pageFiles[2].file),
  );
  assert.equal(lastThreadPage.data.comments[0].content, "😊");
  assert.equal(lastThreadPage.data.comments[0].parentCommentId, 120);
  await assert.rejects(
    operate("acknowledge", options, api.request),
    /--reviewed/,
  );
  const partial = await operate(
    "acknowledge",
    { ...options, adminReviewed: true },
    api.request,
  );
  assert.equal(partial.data.reviewedCoverage.complete, false);
  api.unlock();
  const complete = await operate(
    "scan",
    { ...options, adminResume: true },
    api.request,
  );
  assert.equal(complete.data.fetched.complete, true);
  // A prior partial read receipt is not silently upgraded by downloading.
  assert.equal(complete.data.reviewedCoverage.complete, false);
  const acknowledged = await operate(
    "acknowledge",
    { ...options, adminReviewed: true },
    api.request,
  );
  assert.equal(acknowledged.data.reviewedCoverage.complete, true);
  const firstPageCalls = api.calls.filter(
    (call) => call.body?.subjectId === 1 && call.body?.previousPageId === null,
  );
  assert.equal(firstPageCalls.length, 1);
  const pageTwoCalls = api.calls.filter(
    (call) => call.body?.previousPageId === state.subjects[1].lastPageId,
  );
  assert.equal(pageTwoCalls.length, 2);
  assert.equal(
    pageTwoCalls[0].headers["x-lumine-idempotency-key"],
    pageTwoCalls[1].headers["x-lumine-idempotency-key"],
  );
  assert.ok(!api.calls.some((call) => call.url.endsWith("/reveal")));
  await assert.rejects(
    operate(
      "scan",
      { ...options, adminResume: true, apiUrl: "https://different.test" },
      api.request,
    ),
    /different run/,
  );
  fs.appendFileSync(acknowledged.data.pageFiles[0].file, " ");
  await assert.rejects(
    operate("acknowledge", { ...options, adminReviewed: true }, api.request),
    /changed or is incomplete/,
  );
});

test("Featured selected recommendations default to reward-disabled and resume lost responses without duplicate decisions", async (t) => {
  const dir = fixture(t),
    file = path.join(dir, "decisions.json");
  const selection = {
    reviewId: 100,
    coverageId: 1050,
    selections: [
      { commentId: 120, pageId: 1001 },
      {
        commentId: 119,
        pageId: 1001,
        anyoneCanReward: true,
        rewardTwinkles: 3,
      },
    ],
  };
  write(file, selection);
  assert.equal(
    readFeaturedSelections(file).selections[0].anyoneCanReward,
    false,
  );
  const options = workflowOptions(dir, { adminFile: file });
  const keys = new Map(),
    calls = [];
  let lost = false;
  const request = async (args) => {
    calls.push(args);
    if (args.method === "GET")
      return { ok: true, data: { encouragement: { newRecommendations: 2 } } };
    const key = args.headers["x-lumine-idempotency-key"];
    if (keys.has(key)) return keys.get(key);
    const item = args.body;
    const result = {
      ok: true,
      data: {
        encouragement: {
          reviewId: 100,
          coverageId: 1050,
          commentId: item.commentId,
          pageId: item.pageId,
          anyoneCanRewardRequested: item.anyoneCanReward,
          rewardTwinklesRequested: item.rewardTwinkles,
          changed: true,
          status: "success",
        },
      },
    };
    keys.set(key, result);
    if (item.commentId === 119 && !lost) {
      lost = true;
      throw new Error("Response lost");
    }
    return result;
  };
  await assert.rejects(operate("recommend", options, request), (error) => {
    assert.equal(error.featuredProgress.completedCount, 1);
    return true;
  });
  const completed = await operate(
    "recommend",
    { ...options, adminResume: true },
    request,
  );
  assert.equal(completed.data.batch.completedCount, 2);
  assert.equal(keys.size, 2);
  assert.equal(calls.filter((call) => call.body?.commentId === 120).length, 1);
  assert.deepEqual(calls[0].body, {
    commentId: 120,
    pageId: 1001,
    coverageId: 1050,
    anyoneCanReward: false,
    rewardTwinkles: 0,
  });
  write(file, { ...selection, selections: [{ commentId: 118, pageId: 1001 }] });
  await assert.rejects(
    operate("recommend", { ...options, adminResume: true }, request),
    /different run/,
  );
  write(file, {
    ...selection,
    selections: [{ commentId: 120, pageId: 1001, rewardTwinkles: 3 }],
  });
  assert.throws(() => readFeaturedSelections(file), /anyoneCanReward=true/);
});
