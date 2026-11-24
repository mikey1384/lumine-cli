import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import {
  adminMergeRequestKey,
  adminPublishRequestKey,
  describeMergePreview,
  runAdminBuildMergeWorkflow,
} from "../lib/admin-build-merge.js";

// lumine admin builds merge: Mikey merges a teammate's branch into another
// creator's Main (and publishes it); the diff comes first, nothing changes
// without --yes or a typed "y".

const op = (...args) => {
  const options = parseArgs(["admin", "builds", "merge", ...args]);
  return { options, operation: parseAdminOperation(options) };
};

const mergePreview = {
  dryRun: true,
  action: "would_merge",
  rootBuild: { id: 2915, title: "Baduk", ownerUserId: 44, ownerUsername: "KenGo", isPublic: true, ownedByOperator: false },
  branch: { id: 3045, branchNumber: 28, status: "draft", contributorUserId: 5, contributorUsername: "mikey" },
  openSuggestionMessageId: 900,
  diff: { summary: { total: 2, added: 1, updated: 1, deleted: 0 }, changedFiles: [{ path: "/walkup.js", status: "added" }, { path: "/index.html", status: "updated" }] },
  conflicts: [],
  refusals: [],
  charges: { storageQuotaUserId: 44 },
};
const approval = { buildId: 2915, sourceVersionId: 77, sourceHash: "b".repeat(64), sheetHash: "c".repeat(64), configHash: "d".repeat(64) };
const publishPreview = (rewards) => ({
  dryRun: true,
  action: "would_publish",
  build: { id: 2915, title: "Baduk", ownerUserId: 44, isPublic: true },
  filesHash: "f".repeat(64),
  checks: { projectFiles: { ok: true }, toolchain: { ok: true }, conflictMarkers: { ok: true } },
  publishPath: rewards ? "reward_review" : "publish",
  rewards,
  refusals: [],
});

function fakeApi(responses) {
  const calls = [];
  const request = async (call) => {
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${call.url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, request };
}

test("parses a branch id, build:<id> or a /build/<main>/<branch> URL; --reward-rules needs --publish", () => {
  const byId = op("3045").operation;
  assert.equal(byId.name, "build.admin-merge");
  assert.equal(byId.requiresRun, false);
  assert.equal(byId.mutates, true);
  assert.equal(byId.buildMergeWorkflow, true);
  assert.deepEqual(byId.branch, { branchBuildId: 3045 });
  assert.equal(byId.publish, false);
  assert.deepEqual(op("build:3045").operation.branch, { branchBuildId: 3045 });
  assert.deepEqual(op("https://www.twin-kle.com/build/2915/28").operation.branch, { rootBuildId: 2915, branchNumber: 28 });
  const publish = op("3045", "--publish", "--reward-rules", "live").operation;
  assert.equal(publish.publish, true);
  assert.equal(publish.rewardRules, "live");
  assert.throws(() => op("3045", "--reward-rules", "live").operation, /only applies with --publish/);
  assert.throws(() => op("3045", "--publish", "--reward-rules", "more").operation, /proposed or live/);
  assert.throws(() => op().operation, /Usage/);
});

test("the dry run is shown first; without --yes and without a terminal nothing changes", async () => {
  const { options, operation } = op("3045");
  const api = fakeApi([{ ok: true, data: mergePreview }]);
  const lines = [];
  const result = await runAdminBuildMergeWorkflow({
    options: { ...options, apiUrl: "https://api.test" },
    operation,
    authToken: "t",
    request: api.request,
    confirm: async () => null,
    log: (line) => lines.push(line),
  });
  assert.equal(result.status, "aborted");
  assert.equal(result.changed, false);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body, { branchBuildId: 3045 });
  assert.ok(lines.some((line) => /Changes: 2 files \(1 added, 1 updated, 0 deleted\)/.test(line)));
  assert.ok(lines.some((line) => /Charged to: the owner's storage quota \(user 44\)/.test(line)));
  assert.ok(lines.some((line) => /re-run with --yes/.test(line)));
  // "n" at the prompt aborts too.
  const declined = await runAdminBuildMergeWorkflow({
    options: { ...options, apiUrl: "https://api.test" },
    operation,
    authToken: "t",
    request: fakeApi([{ ok: true, data: mergePreview }]).request,
    confirm: async () => false,
  });
  assert.equal(declined.status, "aborted");
});

test("--yes merges with the previewed owner and a stable key; without --publish the owner is told by the merge", async () => {
  const { options, operation } = op("3045", "--yes");
  const api = fakeApi([
    { ok: true, data: mergePreview },
    { ok: true, data: { merged: true, rootBuildId: 2915, branchBuildId: 3045, branchNumber: 28, afterVersionNumber: 41, auditId: 7 } },
  ]);
  const result = await runAdminBuildMergeWorkflow({
    options: { ...options, apiUrl: "https://api.test" },
    operation,
    authToken: "t",
    request: api.request,
    confirm: async () => { throw new Error("must not ask with --yes"); },
  });
  assert.equal(result.status, "success");
  assert.equal(api.calls[1].url, "https://api.test/cli/admin/builds/admin-merge");
  assert.deepEqual(api.calls[1].body, { branchBuildId: 3045, expectedOwnerUserId: 44, notifyOwner: true, dryRun: false });
  assert.equal(api.calls[1].headers["x-lumine-idempotency-key"], adminMergeRequestKey(3045));
});

test("--publish: merge, publish dry run, then publish that exact snapshot with the reward receipt; one owner notice", async () => {
  const { options, operation } = op("3045", "--publish", "--yes");
  const rewards = { ready: true, approval, live: { reviewId: 492 }, matchesLive: true };
  const api = fakeApi([
    { ok: true, data: mergePreview },
    { ok: true, data: { merged: true, rootBuildId: 2915, branchBuildId: 3045, branchNumber: 28, auditId: 7 } },
    { ok: true, data: publishPreview(rewards) },
    { ok: true, data: { published: true, path: "reward_review", publishedVersion: 42, rewardReview: { reviewId: 901 }, auditId: 8, ownerNotified: true } },
  ]);
  const result = await runAdminBuildMergeWorkflow({
    options: { ...options, apiUrl: "https://api.test" },
    operation,
    authToken: "t",
    request: api.request,
  });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(api.calls[1].body.notifyOwner, false);
  assert.equal(api.calls[2].url, "https://api.test/cli/admin/builds/2915/admin-publish");
  assert.deepEqual(api.calls[2].body, {});
  assert.deepEqual(api.calls[3].body, {
    dryRun: false,
    expectedOwnerUserId: 44,
    expectedFilesHash: "f".repeat(64),
    expectedApproval: approval,
    rewardRules: "proposed",
    branchBuildId: 3045,
  });
  assert.equal(api.calls[3].headers["x-lumine-idempotency-key"], adminPublishRequestKey(2915, "f".repeat(64)));
});

test("--publish stops before publishing when rewards differ from the live approval, unless --reward-rules live", async () => {
  const rewards = { ready: true, approval, live: { reviewId: 492 }, matchesLive: false };
  const responses = () => [
    { ok: true, data: mergePreview },
    { ok: true, data: { merged: true, rootBuildId: 2915, branchBuildId: 3045, auditId: 7 } },
    { ok: true, data: publishPreview(rewards) },
  ];
  const previousExitCode = process.exitCode;
  try {
    const plain = op("3045", "--publish", "--yes");
    const api = fakeApi(responses());
    const refused = await runAdminBuildMergeWorkflow({ options: { ...plain.options, apiUrl: "https://api.test" }, operation: plain.operation, authToken: "t", request: api.request });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "build_admin_publish_reward_rules_differ");
    assert.match(refused.error.message, /^Merged, not published/);
    assert.equal(api.calls.length, 3);

    const live = op("3045", "--publish", "--yes", "--reward-rules", "live");
    const liveApi = fakeApi([...responses(), { ok: true, data: { published: true, path: "reward_review", auditId: 9 } }]);
    const kept = await runAdminBuildMergeWorkflow({ options: { ...live.options, apiUrl: "https://api.test" }, operation: live.operation, authToken: "t", request: liveApi.request });
    assert.equal(kept.status, "success");
    assert.equal(liveApi.calls[3].body.rewardRules, "live");
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("a refused preview or a server refusal is reported, never retried as something else", async () => {
  const previousExitCode = process.exitCode;
  try {
    const { options, operation } = op("3045", "--yes");
    const conflicted = { ...mergePreview, action: "refused", conflicts: ["/index.html"], refusals: [{ code: "build_admin_merge_conflicts", message: "This branch overlaps Main." }] };
    const api = fakeApi([{ ok: true, data: conflicted }]);
    const refused = await runAdminBuildMergeWorkflow({ options: { ...options, apiUrl: "https://api.test" }, operation, authToken: "t", request: api.request });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "build_admin_merge_conflicts");
    assert.equal(api.calls.length, 1);
    assert.ok(describeMergePreview(conflicted).includes("Overlapping files: /index.html"));

    const forbidden = Object.assign(new Error("Forbidden"), {
      status: 403,
      data: { ok: false, error: { code: "CLI_ADMIN_BUILD_MERGE_FORBIDDEN", message: "Only Mikey can merge into or publish another creator's app." } },
    });
    const staff = await runAdminBuildMergeWorkflow({
      options: { ...options, apiUrl: "https://api.test" },
      operation,
      authToken: "t",
      request: fakeApi([forbidden]).request,
    });
    assert.equal(staff.ok, false);
    assert.equal(staff.error.code, "CLI_ADMIN_BUILD_MERGE_FORBIDDEN");
  } finally {
    process.exitCode = previousExitCode;
  }
});
