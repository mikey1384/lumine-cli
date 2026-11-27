import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runFeaturedWorkflow } from "../lib/admin-featured.js";

const API_URL = "https://api.example.test";
const AUTH_TOKEN = "test-token";

function makeTempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumine-featured-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeApi({ runId = 251, reviewId = 100, coverageId = 1050, failOnCommentId = null } = {}) {
  const calls = [];
  let failOnce = failOnCommentId;
  const request = async ({ method, url, body }) => {
    const pathname = new URL(url).pathname;
    calls.push({ method, pathname, body });
    if (method === "POST" && pathname === "/cli/admin/subjects/featured/reviews") {
      return {
        ok: true,
        data: {
          review: {
            id: reviewId,
            runId,
            subjects: [{ id: 10, snapshotMaxId: 500 }],
          },
        },
      };
    }
    if (method === "POST" && pathname === `/cli/admin/subjects/featured/reviews/${reviewId}/pages`) {
      return {
        ok: true,
        data: {
          page: {
            id: 1001,
            reviewId,
            subjectId: 10,
            snapshotMaxId: 500,
            previousPageId: null,
            pages: 1,
            commentsRead: 2,
            exhausted: true,
            nextCursor: null,
          },
          comments: [
            { id: 120, content: "Great project!" },
            { id: 119, content: "Thoughtful feedback!" },
          ],
        },
      };
    }
    if (method === "POST" && pathname === `/cli/admin/subjects/featured/reviews/${reviewId}/coverage`) {
      return {
        ok: true,
        data: {
          coverage: { id: coverageId, reviewId, reviewed: true },
        },
      };
    }
    const recMatch = pathname.match(
      new RegExp(`^/cli/admin/subjects/featured/reviews/${reviewId}/recommendations/(\\d+)$`),
    );
    if (method === "POST" && recMatch) {
      const commentId = Number(recMatch[1]);
      if (failOnce === commentId) {
        failOnce = null;
        throw new Error("Transient upstream failure");
      }
      return {
        ok: true,
        data: {
          encouragement: {
            commentId,
            reviewId,
            pageId: body.pageId,
            coverageId: body.coverageId,
            anyoneCanRewardRequested: body.anyoneCanReward,
            rewardTwinklesRequested: body.rewardTwinkles,
            changed: true,
          },
        },
      };
    }
    if (method === "GET" && pathname === `/cli/admin/subjects/featured/reviews/${reviewId}/report`) {
      return {
        ok: true,
        data: { reviewId, status: "ok" },
      };
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  };
  return { calls, request };
}

async function scanAndAcknowledge({ dir, request, runId = 251 }) {
  const checkpoint = path.join(dir, "featured-read.json");
  const decisionsFile = path.join(dir, "featured-decisions.json");
  await runFeaturedWorkflow({
    options: { apiUrl: API_URL, adminCheckpoint: checkpoint },
    operation: { featuredWorkflow: "scan" },
    authToken: AUTH_TOKEN,
    runId,
    request,
  });
  await runFeaturedWorkflow({
    options: {
      apiUrl: API_URL,
      adminCheckpoint: checkpoint,
      adminReviewed: true,
      adminDecisionsTemplate: decisionsFile,
    },
    operation: { featuredWorkflow: "acknowledge" },
    authToken: AUTH_TOKEN,
    runId,
    request,
  });
  const template = JSON.parse(readFileSync(decisionsFile, "utf8"));
  writeFileSync(
    decisionsFile,
    JSON.stringify(
      {
        ...template,
        selections: [
          { commentId: 120, pageId: 1001 },
          { commentId: 119, pageId: 1001, anyoneCanReward: true, rewardTwinkles: 3 },
        ],
      },
      null,
      2,
    ),
  );
  return { checkpoint, decisionsFile };
}

test("featured comments recommend accepts the scan checkpoint directly and preserves report state", async (t) => {
  const dir = makeTempDir(t);
  const { calls, request } = createFakeApi();
  const { checkpoint, decisionsFile } = await scanAndAcknowledge({ dir, request });

  const recommended = await runFeaturedWorkflow({
    options: {
      apiUrl: API_URL,
      adminCheckpoint: checkpoint,
      adminFile: decisionsFile,
    },
    operation: { featuredWorkflow: "recommend" },
    authToken: AUTH_TOKEN,
    runId: 251,
    request,
  });
  assert.equal(recommended.ok, true);
  assert.equal(recommended.changed, true);
  assert.equal(recommended.data.batch.completedCount, 2);
  assert.equal(recommended.data.batch.checkpointPath, checkpoint);

  // Report must continue working on the same scan checkpoint after recommend.
  const report = await runFeaturedWorkflow({
    options: { apiUrl: API_URL, adminCheckpoint: checkpoint },
    operation: { featuredWorkflow: "report" },
    authToken: AUTH_TOKEN,
    runId: 251,
    request,
  });
  assert.equal(report.ok, true);
  assert.equal(report.data.reviewId, 100);

  // Re-running the same recommendation batch without --resume must still be rejected.
  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: {
          apiUrl: API_URL,
          adminCheckpoint: checkpoint,
          adminFile: decisionsFile,
        },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    /already recorded in the checkpoint.*--resume/i,
  );
  const recCalls = calls.filter((c) => c.pathname.includes("/recommendations/"));
  assert.equal(recCalls.length, 2);
});

test("featured comments recommend on a scan checkpoint resumes interrupted batches without replaying completed comments", async (t) => {
  const dir = makeTempDir(t);
  const { calls, request } = createFakeApi({ failOnCommentId: 119 });
  const { checkpoint, decisionsFile } = await scanAndAcknowledge({ dir, request });

  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: {
          apiUrl: API_URL,
          adminCheckpoint: checkpoint,
          adminFile: decisionsFile,
        },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    (error) => {
      assert.match(error.message, /Transient upstream failure/);
      assert.equal(error.featuredProgress.completedCount, 1);
      assert.equal(error.featuredProgress.failedCommentId, 119);
      return true;
    },
  );

  // --resume with a different decisions selection must be refused.
  const alteredDecisions = path.join(dir, "altered-decisions.json");
  writeFileSync(
    alteredDecisions,
    JSON.stringify({
      reviewId: 100,
      coverageId: 1050,
      selections: [{ commentId: 120, pageId: 1001 }],
    }),
  );
  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: {
          apiUrl: API_URL,
          adminCheckpoint: checkpoint,
          adminFile: alteredDecisions,
          adminResume: true,
        },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    /no matching recommendation batch to resume/i,
  );

  // Resuming the exact selection finishes comment 119 without replaying comment 120.
  const resumed = await runFeaturedWorkflow({
    options: {
      apiUrl: API_URL,
      adminCheckpoint: checkpoint,
      adminFile: decisionsFile,
      adminResume: true,
    },
    operation: { featuredWorkflow: "recommend" },
    authToken: AUTH_TOKEN,
    runId: 251,
    request,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.batch.completedCount, 2);
  const recCommentIds = calls
    .filter((c) => c.pathname.includes("/recommendations/"))
    .map((c) => c.body.commentId);
  assert.deepEqual(recCommentIds, [120, 119, 119]);
});

test("featured comments recommend enforces review, coverage, run, server and page-chain safety on scan checkpoints", async (t) => {
  const dir = makeTempDir(t);
  const { request } = createFakeApi();
  const { checkpoint, decisionsFile } = await scanAndAcknowledge({ dir, request });

  // Mismatched reviewId
  const wrongReview = path.join(dir, "wrong-review.json");
  writeFileSync(
    wrongReview,
    JSON.stringify({
      reviewId: 999,
      coverageId: 1050,
      selections: [{ commentId: 120, pageId: 1001 }],
    }),
  );
  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: { apiUrl: API_URL, adminCheckpoint: checkpoint, adminFile: wrongReview },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    /belongs to review 100, not decisions reviewId 999/,
  );

  // Mismatched coverageId
  const wrongCoverage = path.join(dir, "wrong-coverage.json");
  writeFileSync(
    wrongCoverage,
    JSON.stringify({
      reviewId: 100,
      coverageId: 2099,
      selections: [{ commentId: 120, pageId: 1001 }],
    }),
  );
  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: { apiUrl: API_URL, adminCheckpoint: checkpoint, adminFile: wrongCoverage },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    /acknowledged coverage 1050, not decisions coverageId 2099/,
  );

  // Different runId
  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: { apiUrl: API_URL, adminCheckpoint: checkpoint, adminFile: decisionsFile },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 252,
        request,
      }),
    /different run or server/i,
  );

  // Tampered downloaded page file
  writeFileSync(`${checkpoint}.page-1001.json`, '{"tampered":true}\n');
  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: { apiUrl: API_URL, adminCheckpoint: checkpoint, adminFile: decisionsFile },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    /downloaded page changed/i,
  );
});

test("featured comments recommend still supports standalone batch checkpoint files", async (t) => {
  const dir = makeTempDir(t);
  const { request } = createFakeApi();
  const { decisionsFile } = await scanAndAcknowledge({ dir, request });
  const batchCheckpoint = path.join(dir, "featured-recommend.json");

  const result = await runFeaturedWorkflow({
    options: {
      apiUrl: API_URL,
      adminCheckpoint: batchCheckpoint,
      adminFile: decisionsFile,
    },
    operation: { featuredWorkflow: "recommend" },
    authToken: AUTH_TOKEN,
    runId: 251,
    request,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.batch.completedCount, 2);

  await assert.rejects(
    () =>
      runFeaturedWorkflow({
        options: {
          apiUrl: API_URL,
          adminCheckpoint: batchCheckpoint,
          adminFile: decisionsFile,
        },
        operation: { featuredWorkflow: "recommend" },
        authToken: AUTH_TOKEN,
        runId: 251,
        request,
      }),
    /checkpoint already exists.*--resume/i,
  );
});
