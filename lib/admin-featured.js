import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { requestJson } from "./http.js";
import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";
import {
  acquireCheckpointLock,
  releaseCheckpointLock,
} from "./admin-workflows.js";

const MAX_BYTES = 16 * 1024 * 1024;
const BASE = "/cli/admin/subjects/featured";
const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const featuredFingerprint = (value) =>
  hashBytes(JSON.stringify(canonical(value)));

function invalid(message, details) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_FEATURED_WORKFLOW_INVALID";
  if (details)
    error.data = {
      ok: false,
      status: "partial_failure",
      error: {
        code: error.code,
        message,
        details,
      },
    };
  return error;
}
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw invalid(`${label} must be a positive integer.`);
  return value;
}
function save(file, value) {
  writeAdminJsonFile(file, value, { privateFile: true, maxBytes: MAX_BYTES });
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readApprovedFeaturedPlan(file, approval) {
  const raw = readAdminJsonFile(file, "the prepared Featured plan", {
    maxBytes: MAX_BYTES,
  });
  const { plan, planHash } = raw.data || raw;
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.finalIds) ||
    !Array.isArray(plan.expectedIds) ||
    !planHash ||
    featuredFingerprint(plan) !== planHash ||
    approval !== planHash
  ) {
    throw invalid(
      "Read the prepared plan, obtain Mikey's go-ahead, then pass --approve <exact-plan-hash>. Modified plans cannot be applied.",
    );
  }
  positive(plan.id, "Plan ID");
  return { plan, planHash };
}

export function readFeaturedSelections(file) {
  const raw = readAdminJsonFile(file, "agent-selected comment decisions", {
    maxBytes: 2 * 1024 * 1024,
  });
  positive(raw?.reviewId, "Review ID");
  positive(raw?.coverageId, "Reviewed coverage ID");
  if (!Array.isArray(raw.selections) || raw.selections.length > 20_000) {
    throw invalid(
      "selections must be an array of at most 20000 agent-selected comments.",
    );
  }
  const seen = new Set();
  const selections = raw.selections.map((item) => {
    positive(item?.commentId, "Comment ID");
    positive(item?.pageId, "Page receipt ID");
    if (seen.has(item.commentId))
      throw invalid("Duplicate selected comment ID.");
    seen.add(item.commentId);
    if (
      item.anyoneCanReward !== undefined &&
      typeof item.anyoneCanReward !== "boolean"
    ) {
      throw invalid("anyoneCanReward must be a boolean.");
    }
    const anyoneCanReward = item.anyoneCanReward === true;
    const rewardTwinkles = item.rewardTwinkles ?? 0;
    if (
      ![0, 3].includes(rewardTwinkles) ||
      (rewardTwinkles && !anyoneCanReward)
    ) {
      throw invalid(
        "rewardTwinkles must be 0, or 3 with anyoneCanReward=true.",
      );
    }
    return {
      commentId: item.commentId,
      pageId: item.pageId,
      anyoneCanReward,
      rewardTwinkles,
    };
  });
  return { reviewId: raw.reviewId, coverageId: raw.coverageId, selections };
}

function verifyPageFiles(state, checkpoint) {
  if (!state.review) {
    if (Object.keys(state.subjects || {}).length)
      throw invalid("Checkpoint subjects have no review snapshot.");
    return;
  }
  const ids = state.review.subjects.map((item) => String(item.id)).sort();
  if (
    JSON.stringify(ids) !==
    JSON.stringify(Object.keys(state.subjects || {}).sort())
  ) {
    throw invalid(
      "The checkpoint omits or adds Subjects relative to its review snapshot.",
    );
  }
  for (const subject of Object.values(state.subjects || {})) {
    const manifest = state.review.subjects.find(
      (item) => item.id === subject.id,
    );
    if (!manifest || manifest.snapshotMaxId !== subject.snapshotMaxId)
      throw invalid("Subject boundary changed.");
    const verified = {
      id: subject.id,
      snapshotMaxId: subject.snapshotMaxId,
      pages: [],
      lastPageId: null,
      commentsFetched: 0,
      complete: false,
      lastCommentId: subject.snapshotMaxId + 1,
    };
    let previous = null;
    for (const entry of subject.pages || []) {
      if (
        entry.file !==
        `${checkpoint}.page-${positive(entry.id, "Page ID")}.json`
      ) {
        throw invalid("A page file does not belong to this checkpoint.");
      }
      const bytes = readFileSync(entry.file);
      if (bytes.length > MAX_BYTES || hashBytes(bytes) !== entry.sha256)
        throw invalid(
          "A downloaded page changed or is incomplete; do not claim review coverage.",
        );
      const result = JSON.parse(bytes.toString("utf8"));
      assertPageResult(result, state, verified);
      const page = result.data?.page;
      if (
        page?.id !== entry.id ||
        page.reviewId !== state.review.id ||
        page.subjectId !== subject.id ||
        page.previousPageId !== previous ||
        page.snapshotMaxId !== subject.snapshotMaxId
      )
        throw invalid("Page receipt chain does not match this review.");
      previous = page.id;
      verified.pages.push(entry);
      verified.lastPageId = page.id;
      verified.commentsFetched = page.commentsRead;
      verified.complete = page.exhausted;
      verified.lastCommentId =
        result.data.comments.at(-1)?.id ?? verified.lastCommentId;
    }
    if (
      subject.lastPageId !== previous ||
      subject.complete !== verified.complete ||
      subject.commentsFetched !== verified.commentsFetched ||
      subject.lastCommentId !== verified.lastCommentId
    ) {
      throw invalid("Checkpoint progress does not match its downloaded pages.");
    }
  }
}

function assertPageResult(result, state, subject) {
  const page = result?.data?.page;
  positive(page?.id, "Canonical page ID");
  const comments = result.data.comments;
  if (
    result.ok !== true ||
    page.reviewId !== state.review.id ||
    page.subjectId !== subject.id ||
    page.snapshotMaxId !== subject.snapshotMaxId ||
    page.previousPageId !== subject.lastPageId ||
    page.pages !== subject.pages.length + 1 ||
    !Array.isArray(comments) ||
    page.commentsRead !== subject.commentsFetched + comments.length ||
    typeof page.exhausted !== "boolean" ||
    (page.exhausted ? page.nextCursor !== null : !page.nextCursor) ||
    (!page.exhausted && !comments.length) ||
    comments.some(
      (item) =>
        !Number.isSafeInteger(item.id) ||
        item.id <= 0 ||
        item.id > subject.snapshotMaxId,
    ) ||
    new Set(comments.map((item) => item.id)).size !== comments.length
  ) {
    throw invalid(
      "The API did not confirm the exact continuing comment snapshot.",
    );
  }
  if (
    comments.some(
      (item, index) =>
        item.id >= (index ? comments[index - 1].id : subject.lastCommentId),
    )
  ) {
    throw invalid(
      "Comment pages repeated rows or did not advance in canonical order.",
    );
  }
  return page;
}

export async function runFeaturedWorkflow({
  options,
  operation,
  authToken,
  runId,
  request = requestJson,
}) {
  const apiUrl = String(options.apiUrl).replace(/\/$/, "");
  const call = async (suffix, body, key) =>
    request({
      method: body === undefined ? "GET" : "POST",
      url: `${apiUrl}${BASE}${suffix}`,
      authToken,
      body,
      timeoutMs: options.timeoutMs,
      headers: {
        "x-lumine-admin-run-id": String(runId),
        ...(key ? { "x-lumine-idempotency-key": key } : {}),
      },
    });
  if (operation.featuredWorkflow === "apply") {
    const { plan, planHash } = readApprovedFeaturedPlan(
      options.adminFile,
      options.adminApprove,
    );
    if (plan.runId !== runId)
      throw invalid(
        "This plan belongs to a different run; prepare and approve a fresh plan.",
      );
    const result = await call(
      "/plan/apply",
      { planId: plan.id, approvedHash: planHash },
      `cli:featured-apply:${runId}:${planHash.slice(0, 32)}`,
    );
    let listed;
    try {
      listed = await call("");
    } catch (error) {
      throw invalid(
        "The server returned an apply receipt, but the final board read failed. Inspect the receipt and retry the same approved plan; do not assume no change occurred.",
        {
          canonicalResult: result,
          expectedFinalIds: plan.finalIds,
          verificationError: error.message,
        },
      );
    }
    const actual = listed?.data?.subjects?.map((item) => item.id);
    if (
      listed?.ok !== true ||
      result?.ok !== true ||
      result.data?.appliedPlanId !== plan.id ||
      result.data?.approvedHash !== planHash ||
      JSON.stringify(actual) !== JSON.stringify(plan.finalIds)
    ) {
      throw invalid(
        "The approved plan's final board could not be verified. Do not restore or overwrite intervening changes.",
        {
          canonicalResult: result,
          liveBoard: listed,
          expectedFinalIds: plan.finalIds,
        },
      );
    }
    return { ...result, data: { ...result.data, verifiedFinalIds: actual } };
  }

  const workflow = operation.featuredWorkflow;
  if (!options.adminCheckpoint)
    throw invalid(
      "Pass --checkpoint <private-file.json> for resumable Featured work.",
    );
  const checkpoint = path.resolve(options.adminCheckpoint);
  const selection =
    workflow === "recommend" ? readFeaturedSelections(options.adminFile) : null;
  const fingerprint = featuredFingerprint({
    apiUrl,
    runId,
    kind: selection ? "recommend" : "scan",
    selection,
  });
  const lock = acquireCheckpointLock(checkpoint, fingerprint);
  try {
    let state;
    if (
      options.adminResume ||
      workflow === "acknowledge" ||
      workflow === "report"
    ) {
      state = readAdminJsonFile(checkpoint, "the Featured checkpoint", {
        maxBytes: MAX_BYTES,
      });
      if (
        state.schemaVersion !== 1 ||
        state.fingerprint !== fingerprint ||
        state.runId !== runId ||
        state.apiUrl !== apiUrl
      ) {
        throw invalid(
          "This checkpoint belongs to a different run, server, or selection. Resume the exact original operation.",
        );
      }
      if (!selection) verifyPageFiles(state, checkpoint);
    } else {
      if (existsSync(checkpoint))
        throw invalid(
          "The checkpoint already exists. Use --resume or choose a new file.",
        );
      state = {
        schemaVersion: 1,
        fingerprint,
        apiUrl,
        runId,
        requestId: `cli:featured-review:${randomUUID()}`,
        subjects: {},
        completed: {},
      };
      save(checkpoint, state);
    }

    if (workflow === "recommend") {
      for (const item of selection.selections) {
        if (state.completed[item.commentId]) continue;
        try {
          const result = await call(
            `/reviews/${selection.reviewId}/recommendations/${item.commentId}`,
            {
              ...item,
              coverageId: selection.coverageId,
            },
            `cli:featured-rec:${runId}:${fingerprint.slice(0, 24)}:${item.commentId}`,
          );
          const outcome = result?.data?.encouragement;
          if (
            result?.ok !== true ||
            outcome?.commentId !== item.commentId ||
            outcome?.reviewId !== selection.reviewId ||
            outcome?.pageId !== item.pageId ||
            outcome?.coverageId !== selection.coverageId ||
            outcome?.anyoneCanRewardRequested !== item.anyoneCanReward ||
            outcome?.rewardTwinklesRequested !== item.rewardTwinkles
          ) {
            throw invalid(
              "The API did not confirm this exact comment decision.",
              { canonicalResult: result },
            );
          }
          state.completed[item.commentId] = outcome;
          save(checkpoint, state);
        } catch (error) {
          error.featuredProgress = {
            checkpointPath: checkpoint,
            completedCount: Object.keys(state.completed).length,
            failedCommentId: item.commentId,
            targetCount: selection.selections.length,
          };
          throw error;
        }
      }
      const report = await call(`/reviews/${selection.reviewId}/report`);
      return {
        ok: true,
        status: "success",
        changed: Object.values(state.completed).some((item) => item.changed),
        data: {
          batch: {
            targetCount: selection.selections.length,
            completedCount: Object.keys(state.completed).length,
            checkpointPath: checkpoint,
            outcomes: state.completed,
          },
          featuredReport: report.data,
        },
      };
    }

    if (!state.review) {
      const result = await call("/reviews", {}, state.requestId);
      const review = result?.data?.review;
      positive(review?.id, "Canonical review ID");
      if (
        result.ok !== true ||
        review.runId !== runId ||
        !Array.isArray(review.subjects) ||
        review.subjects.length > 100 ||
        new Set(review.subjects.map((item) => item.id)).size !==
          review.subjects.length
      ) {
        throw invalid(
          "The API did not return a complete bounded Featured review snapshot.",
        );
      }
      state.review = review;
      for (const subject of review.subjects) {
        positive(subject.id, "Subject ID");
        if (
          !Number.isSafeInteger(subject.snapshotMaxId) ||
          subject.snapshotMaxId < 0
        )
          throw invalid("Invalid comment boundary.");
        state.subjects[subject.id] = {
          ...subject,
          pages: [],
          lastPageId: null,
          lastCommentId: subject.snapshotMaxId + 1,
          commentsFetched: 0,
          complete: false,
          blocked: null,
        };
      }
      save(checkpoint, state);
    }

    if (workflow === "scan") {
      for (const subject of Object.values(state.subjects)) {
        subject.blocked = null;
        while (!subject.complete) {
          if (subject.pages.length >= 100_000)
            throw invalid("Page safety limit reached; coverage is incomplete.");
          try {
            const result = await call(
              `/reviews/${state.review.id}/pages`,
              {
                subjectId: subject.id,
                previousPageId: subject.lastPageId,
              },
              `cli:featured-page:${runId}:${state.review.id}:${subject.id}:${subject.lastPageId || 0}`,
            );
            const page = assertPageResult(result, state, subject);
            const file = `${checkpoint}.page-${page.id}.json`;
            save(file, result);
            subject.pages.push({
              id: page.id,
              file,
              sha256: hashBytes(readFileSync(file)),
            });
            subject.lastPageId = page.id;
            subject.commentsFetched = page.commentsRead;
            subject.lastCommentId =
              result.data.comments.at(-1)?.id ?? subject.lastCommentId;
            subject.complete = page.exhausted;
            save(checkpoint, state);
          } catch (error) {
            const code = error?.data?.error?.code || error.code;
            if (
              ![
                "CLI_ADMIN_SECRET_REVEAL_REQUIRED",
                "CLI_ADMIN_SUBJECT_NOT_FOUND",
                "CLI_ADMIN_NOT_FOUND",
              ].includes(code)
            ) {
              error.featuredProgress = {
                checkpointPath: checkpoint,
                failedSubjectId: subject.id,
                subjectsCompleted: Object.values(state.subjects).filter(
                  (item) => item.complete,
                ).length,
              };
              throw error;
            }
            subject.blocked = { code, message: error.message };
            save(checkpoint, state);
            break;
          }
        }
      }
    } else if (workflow === "acknowledge") {
      if (!options.adminReviewed)
        throw invalid("Read every downloaded page before passing --reviewed.");
      const pageIds = Object.values(state.subjects)
        .filter((item) => item.complete)
        .map((item) => item.lastPageId);
      const result = await call(
        `/reviews/${state.review.id}/coverage`,
        { pageIds, reviewed: true },
        `cli:featured-covered:${runId}:${featuredFingerprint({ reviewId: state.review.id, pageIds }).slice(0, 32)}`,
      );
      if (
        result?.ok !== true ||
        result.data?.coverage?.reviewId !== state.review.id ||
        result.data?.coverage?.reviewed !== true
      ) {
        throw invalid("The API did not confirm reviewed coverage.");
      }
      state.coverage = result.data.coverage;
      save(checkpoint, state);
    } else if (workflow === "report") {
      return call(`/reviews/${state.review.id}/report`);
    }
    const subjects = Object.values(state.subjects);
    return {
      ok: true,
      status: "success",
      changed: false,
      data: {
        review: state.review,
        checkpointPath: checkpoint,
        fetched: {
          complete: subjects.every((item) => item.complete),
          subjectsCompleted: subjects.filter((item) => item.complete).length,
          commentsFetched: subjects.reduce(
            (sum, item) => sum + item.commentsFetched,
            0,
          ),
          blocked: subjects
            .filter((item) => item.blocked)
            .map((item) => ({ subjectId: item.id, ...item.blocked })),
        },
        // Downloading is not a claim that the agent read the content.
        reviewedCoverage: state.coverage || null,
        pageFiles: subjects.flatMap((item) => item.pages),
      },
    };
  } finally {
    releaseCheckpointLock(lock);
  }
}
