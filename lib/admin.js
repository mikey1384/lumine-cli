import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { assertAuthScope, resolveAuth } from "./auth.js";
import { requestJson } from "./http.js";
import {
  extractNewsClaim,
  readAdminJsonFile,
  validateNewsEditorial,
  writeNewsClaimArtifacts,
} from "./admin-news.js";
import {
  forEachPaginatedResultItem,
  getPaginatedResultStorage,
  runAutomaticPagination,
  runBatchSkips,
  writePaginatedResultJson,
} from "./admin-workflows.js";
import {
  parseBuildReviewReceipt,
  runManagedBuildReview,
} from "./build-review.js";

const MAX_EDITORIAL_FILE_BYTES = 256 * 1024;
const MAX_COMPOSED_TEXT_FILE_BYTES = 64 * 1024;
const MAX_COMPOSED_TEXT_LENGTH = 10_000;
const MAX_BUILD_REVIEW_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_BUILD_REVIEW_UNDERSTANDING_LENGTH = 12_000;
const MAX_NOTABLE_NOTE_LENGTH = 2_000;
const MAX_IDENTITY_INSPECTION_REASON_LENGTH = 500;
const MAX_ESCALATION_DECISION_NOTE_LENGTH = 2_000;
const MAX_TODO_TITLE_LENGTH = 200;
const MAX_TODO_NOTE_LENGTH = 4_000;

// Operator-composed persona text (plain UTF-8, not JSON). The agent writes
// the content in the bot's persona itself; the server never invokes
// its model and no AI Energy is spent.
function readComposedTextFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError("Pass composed text with --file <file.md>.");
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_COMPOSED_TEXT_FILE_BYTES) {
    throw cliValidationError("The composed text file must be under 64KB.");
  }
  const normalized = contents.trim();
  if (!normalized) {
    throw cliValidationError(
      `${normalizedPath} is empty; composed text is required.`,
    );
  }
  if (normalized.length > MAX_COMPOSED_TEXT_LENGTH) {
    throw cliValidationError(
      `Composed text must be at most ${MAX_COMPOSED_TEXT_LENGTH} characters.`,
    );
  }
  return normalized;
}

function readBuildReviewContextFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError(
      "Pass the private reviewed understanding with --review-context <context.json>.",
    );
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (
    Buffer.byteLength(contents, "utf8") > MAX_BUILD_REVIEW_CONTEXT_FILE_BYTES
  ) {
    throw cliValidationError(
      "The Build review context file must be under 64KB.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw cliValidationError(`${normalizedPath} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliValidationError(
      "The Build review context must be a JSON object with an understanding string.",
    );
  }
  const unexpectedKeys = Object.keys(parsed).filter(
    (key) => key !== "understanding",
  );
  if (unexpectedKeys.length > 0) {
    throw cliValidationError(
      "The Build review context JSON may contain only the understanding field; version and provenance are server-owned.",
    );
  }
  const understanding =
    typeof parsed.understanding === "string" ? parsed.understanding.trim() : "";
  if (!understanding) {
    throw cliValidationError(
      "The Build review context understanding must be a non-empty string.",
    );
  }
  if (understanding.length > MAX_BUILD_REVIEW_UNDERSTANDING_LENGTH) {
    throw cliValidationError(
      `The Build review context understanding must be at most ${MAX_BUILD_REVIEW_UNDERSTANDING_LENGTH} characters.`,
    );
  }
  return understanding;
}

function readEditorialFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError(
      "Pass the editorial JSON with --file <editorial.json>.",
    );
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_EDITORIAL_FILE_BYTES) {
    throw cliValidationError("The editorial file must be under 256KB.");
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw cliValidationError(`${normalizedPath} is not valid JSON.`);
  }
}

export async function adminCommand(options) {
  const operation = parseAdminOperation(options);
  if (operation.name === "news.validate") {
    const validation = validateNewsEditorial({
      claim: operation.claim,
      editorial: operation.editorial,
    });
    const result = {
      ok: true,
      status: "success",
      changed: false,
      data: { validation },
    };
    return finishAdminOutput({ options, operation, result });
  }
  const viewFilter = resolveOperatorViewFilter({
    operation,
    unviewed: options.adminUnviewed,
    viewed: options.adminViewed,
  });
  const recommendationContentTypes =
    operation.name === "recommendations.list"
      ? parseRecommendationContentTypes(options.adminContentTypes)
      : null;
  const auth = await resolveAuth(options);
  await assertAuthScope({
    options,
    auth,
    scope: operation.mutates ? "build:write" : "build:read",
  });
  let runId = 0;
  let correctionSessionId = 0;
  let correctionSession = null;
  if (adminOperationRequiresRun(operation)) {
    if (operation.correctionEligible) {
      const correctionStatus = await requestJson({
        url: `${options.apiUrl}/cli/admin/corrections/status`,
        authToken: auth.token,
        timeoutMs: options.timeoutMs,
      });
      const correction = correctionStatus?.data?.correction || null;
      if (
        correction?.status === "active" &&
        Number(correction.correctionCommentId || 0) ===
          Number(operation.correctionCommentId || 0)
      ) {
        correctionSessionId = Number(correction.id || 0);
        correctionSession = correction;
      }
    }
    const runStatus = correctionSessionId
      ? null
      : await requestJson({
          url: `${options.apiUrl}/cli/admin/daily-runs/status`,
          authToken: auth.token,
          timeoutMs: options.timeoutMs,
        });
    const activeRun = runStatus?.data?.run || null;
    const retryableFinishedRun = [
      "daily-run.complete",
      "daily-run.fail",
    ].includes(operation.name)
      ? runStatus?.data?.lastRun || null
      : null;
    const selectedRun = activeRun || retryableFinishedRun;
    runId = Number(selectedRun?.id || 0);
    if (!runId && !correctionSessionId) {
      if (operation.correctionEligible) {
        const error = new Error(
          `Start a correction session first: lumine admin correction start ${operation.correctionCommentId}.`,
        );
        error.code = "CLI_ADMIN_CORRECTION_NOT_ACTIVE";
        throw error;
      }
      throw noActiveRunError();
    }
    if (options.adminIdentity && (selectedRun || correctionSession)) {
      const requestedIdentity = parseIdentity(options.adminIdentity);
      const canonicalIdentity = correctionSession
        ? correctionSession.identity?.key
        : selectedRun?.identity?.key;
      if (
        requestedIdentity !== "auto" &&
        requestedIdentity !== canonicalIdentity
      ) {
        throw cliValidationError(
          correctionSession
            ? `--identity ${requestedIdentity} does not match correction session #${correctionSessionId} (${canonicalIdentity || "unknown"}).`
            : `--identity ${requestedIdentity} does not match active run #${runId} (${canonicalIdentity || "unknown"}).`,
        );
      }
    }
  }
  const requestId =
    options.idempotencyKey || (operation.mutates ? `cli:${randomUUID()}` : "");
  let result;
  try {
    const fetchOperation = async (requestPath = operation.path) =>
      requestJson({
        method: operation.method,
        url: `${options.apiUrl}${requestPath}`,
        authToken: auth.token,
        body: operation.body,
        headers: {
          ...(runId ? { "x-lumine-admin-run-id": String(runId) } : {}),
          ...(correctionSessionId
            ? {
                "x-lumine-admin-correction-session-id": String(
                  correctionSessionId,
                ),
              }
            : {}),
          ...(requestId ? { "x-lumine-idempotency-key": requestId } : {}),
        },
        timeoutMs: options.timeoutMs,
      });
    const transformResult = (rawResult) =>
      transformAdminResult({
        operation,
        result: rawResult,
        options,
        recommendationContentTypes,
        viewFilter,
      });
    if (operation.name === "build.review") {
      result = await runManagedBuildReview({
        options,
        authToken: auth.token,
        buildId: operation.buildId,
      });
    } else if (operation.name === "post.skip-batch") {
      result = await runBatchSkips({
        options,
        authToken: auth.token,
        runId,
        parseTarget: parseRecommendationTarget,
      });
    } else if (options.adminAll) {
      if (options.adminCursor) {
        throw cliValidationError(
          "Use --resume with the scan checkpoint instead of combining --all with --cursor.",
        );
      }
      result = await runAutomaticPagination({
        options,
        operation,
        runId,
        fetchPage: fetchOperation,
        transformPage: transformResult,
        recordCoverage: async (coverage) =>
          requestJson({
            method: "POST",
            url: `${options.apiUrl}/cli/admin/daily-runs/coverage`,
            authToken: auth.token,
            body: coverage,
            headers: {
              "x-lumine-admin-run-id": String(runId),
              "x-lumine-idempotency-key": `cli:queue-coverage:${runId}:${adminValueFingerprint(coverage).slice(0, 32)}`,
            },
            timeoutMs: options.timeoutMs,
          }),
      });
    } else {
      if (options.adminResume) {
        throw cliValidationError("--resume requires --all or post skip-batch.");
      }
      result = transformResult(await fetchOperation());
    }
  } catch (error) {
    if (
      operation.mutates &&
      requestId &&
      operation.name !== "post.skip-batch"
    ) {
      const retryInstruction = `Retry with --idempotency-key ${requestId}.`;
      error.data = error.data || {
        ok: false,
        status: "error",
        error: {
          code: error.code || "LUMINE_ADMIN_REQUEST_FAILED",
          message: String(error.message || "The administrator request failed."),
          details: null,
        },
      };
      if (error.data?.error) {
        const details =
          error.data.error.details &&
          typeof error.data.error.details === "object" &&
          !Array.isArray(error.data.error.details)
            ? error.data.error.details
            : {};
        error.data.error.details = {
          ...details,
          retryIdempotencyKey: requestId,
        };
      }
      error.message = `${error.message} ${retryInstruction}`;
    }
    throw error;
  }
  if (
    operation.name === "comment.draft" &&
    typeof operation.body?.content === "string"
  ) {
    assertComposedCommentDraftResult({
      result,
      expectedContent: operation.body.content,
      requiresBuildReviewContext:
        typeof operation.body.buildReviewUnderstanding === "string",
    });
  }
  if (operation.name === "ai-email-policy.set") {
    assertAiEmailPolicySetResult({ operation, result });
  }
  if (operation.name === "daily-run.start") {
    assertAdminTodoHandoffResult(result);
  }
  if (operation.name === "news.claim") {
    const artifacts = writeNewsClaimArtifacts({
      result,
      outputPath: options.adminOutput,
      scaffoldPath: options.adminScaffoldFile,
    });
    result = {
      ...result,
      data: { ...(result.data || {}), artifacts },
    };
  }
  return finishAdminOutput({ options, operation, result });
}

function transformAdminResult({
  operation,
  result,
  options,
  recommendationContentTypes,
  viewFilter,
}) {
  let transformed = result;
  if (operation.name === "recommendations.list") {
    assertRecommendationWindowResult({ operation, result: transformed });
  }
  if (operation.name === "builds.candidates") {
    transformed = normalizeAdminBuildCandidatesResult({
      result: transformed,
      siteUrl: options.siteUrl,
    });
  }
  if (recommendationContentTypes) {
    transformed = filterRecommendationQueueResult({
      result: transformed,
      contentTypes: recommendationContentTypes,
    });
  }
  if (viewFilter) {
    transformed = filterListResultByOperatorView({
      result: transformed,
      viewFilter,
    });
  }
  return transformed;
}

export function assertRecommendationWindowResult({ operation, result }) {
  const mode = operation?.pagination?.coverageMode;
  if (!mode || mode === "legacy") return;
  const after = result?.data?.pagination?.after;
  const snapshotTimeStamp = result?.data?.pagination?.snapshotTimeStamp;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(snapshotTimeStamp) ||
    snapshotTimeStamp < 0
  ) {
    const error = new Error(
      "The deployed API did not confirm the bounded recommendation window and snapshot. Deploy the matching API before using this CLI; use --include-legacy only for an intentional historical scan.",
    );
    error.code = "LUMINE_ADMIN_RECOMMENDATION_WINDOW_UNSUPPORTED";
    error.data = {
      ok: false,
      status: "validation_error",
      error: {
        code: error.code,
        message: error.message,
        details: { requestedMode: mode },
      },
    };
    throw error;
  }
}

async function finishAdminOutput({ options, operation, result }) {
  const paginationStorage = getPaginatedResultStorage(result);
  if (options.json) {
    if (paginationStorage) {
      await writePaginatedResultJson({
        result,
        write: async (chunk) => {
          if (!process.stdout.write(chunk)) {
            await once(process.stdout, "drain");
          }
        },
      });
    } else {
      console.log(JSON.stringify(result));
    }
    return result;
  }
  if (paginationStorage) {
    await printSpooledAdminResult({ result, storage: paginationStorage });
    return result;
  }
  printAdminResult({ operation, result });
  return result;
}

export function normalizeAdminBuildCandidatesResult({ result, siteUrl }) {
  const builds = Array.isArray(result?.builds) ? result.builds : [];
  const nextCursor = String(result?.cursor || "").trim() || null;
  return {
    ok: true,
    status: "success",
    data: {
      builds: builds.map((build) => {
        const id = Number(build?.id || 0);
        return {
          ...build,
          url:
            id > 0
              ? `${String(siteUrl || "").replace(/\/$/, "")}/app/${id}`
              : null,
          review: {
            publishedArtifactVersionId:
              Number(build?.publishedArtifactVersionId || 0) || null,
            codePullAvailable: build?.collaborationMode === "open_source",
            requiredBeforeComment: true,
          },
        };
      }),
      pagination: {
        nextCursor,
        hasMore: Boolean(nextCursor),
        exhausted: !nextCursor,
      },
    },
  };
}

export function assertComposedCommentDraftResult({
  result,
  expectedContent,
  requiresBuildReviewContext = false,
}) {
  const draft = result?.data?.draft;
  if (
    draft?.decision === "draft" &&
    draft?.reason === "operator-composed" &&
    draft?.content === expectedContent &&
    draft?.status === "ready"
  ) {
    if (
      requiresBuildReviewContext &&
      draft?.buildReviewContextStored !== true
    ) {
      const error = new Error(
        "The API did not confirm that it stored the private Build review context. Stop without publishing this draft and deploy the context-aware API first, then retry with a new idempotency key.",
      );
      error.code = "LUMINE_ADMIN_BUILD_REVIEW_CONTEXT_UNSUPPORTED";
      error.data = {
        ok: false,
        status: "validation_error",
        error: {
          code: error.code,
          message: error.message,
          details: null,
        },
      };
      throw error;
    }
    return;
  }
  const error = new Error(
    "The API did not confirm the operator-composed draft. Stop without publishing it and deploy an API that supports composed drafts.",
  );
  error.code = "LUMINE_ADMIN_COMPOSED_COMMENT_UNSUPPORTED";
  error.data = {
    ok: false,
    status: "validation_error",
    error: {
      code: error.code,
      message: error.message,
      details: null,
    },
  };
  throw error;
}

export function assertAiEmailPolicySetResult({ operation, result }) {
  const requestedEmail = String(operation?.body?.email || "");
  const requestedMode = String(operation?.body?.mode || "");
  const policy = result?.data?.policy;
  const projection = result?.data?.projection;
  const accountUserIds = Array.isArray(result?.data?.accountUserIds)
    ? result.data.accountUserIds
    : [];
  const accountCount = Number(result?.data?.accountCount);
  const expectedIdentityType =
    requestedMode === "separate_accounts"
      ? "separate_verified_email"
      : "verified_email";
  if (
    policy?.exists === true &&
    policy?.normalizedEmail === requestedEmail &&
    policy?.mode === requestedMode &&
    Number.isSafeInteger(accountCount) &&
    accountCount >= 0 &&
    accountUserIds.length === accountCount &&
    projection?.expectedIdentityType === expectedIdentityType &&
    projection?.accountCount === accountCount &&
    projection?.matchingAccountCount === accountCount &&
    Array.isArray(projection?.mismatchedAccountUserIds) &&
    projection.mismatchedAccountUserIds.length === 0 &&
    projection?.converged === true
  ) {
    return;
  }
  const error = new Error(
    "The API did not confirm that every matching account converged to the requested AI email policy. Retry only after reviewing the canonical response and deployed API.",
  );
  error.code = "LUMINE_ADMIN_AI_EMAIL_POLICY_NOT_CONVERGED";
  error.data = {
    ok: false,
    status: "partial_failure",
    error: {
      code: error.code,
      message: error.message,
      details: {
        requestedEmail,
        requestedMode,
        canonical: result?.data || null,
      },
    },
  };
  throw error;
}

const RECOMMENDATION_CONTENT_TYPES = new Map([
  ["comment", "comment"],
  ["aistory", "aiStory"],
  ["dailyreflection", "dailyReflection"],
]);

export function parseRecommendationContentTypes(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const contentTypes = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => RECOMMENDATION_CONTENT_TYPES.get(item.toLowerCase()));
  if (
    contentTypes.length === 0 ||
    contentTypes.some((contentType) => !contentType) ||
    new Set(contentTypes).size !== contentTypes.length
  ) {
    throw cliValidationError(
      "--content-types accepts comment, aiStory, and dailyReflection.",
    );
  }
  return [...new Set(contentTypes)];
}

export function filterRecommendationQueueResult({ result, contentTypes }) {
  const items = Array.isArray(result?.data?.items) ? result.data.items : [];
  const allowed = new Set(contentTypes);
  const filteredItems = items.filter((item) => allowed.has(item?.contentType));
  return {
    ...result,
    data: {
      ...result.data,
      items: filteredItems,
      clientFilter: {
        contentTypes,
        excludedItems: items.length - filteredItems.length,
      },
    },
  };
}

// Escalation lists are only useful when they exclude what Mikey already read,
// so list output can be narrowed by his own view state. The server stamps
// `operatorViewed` on every listed item; an item missing the field (an older
// deployed API) is treated as unknown and kept, so the filter can never hide
// something by accident.
export function filterListResultByOperatorView({ result, viewFilter }) {
  if (!viewFilter) return result;
  const collections = ["items", "subjects", "comments"];
  const data = { ...(result?.data || {}) };
  let excluded = 0;
  let unknown = 0;
  for (const key of collections) {
    if (!Array.isArray(data[key])) continue;
    const kept = data[key].filter((entry) => {
      const state = entry?.operatorViewed;
      if (!state || typeof state.viewed !== "boolean") {
        unknown += 1;
        return true;
      }
      const keep = viewFilter === "unviewed" ? !state.viewed : state.viewed;
      if (!keep) excluded += 1;
      return keep;
    });
    data[key] = kept;
  }
  return {
    ...result,
    data: {
      ...data,
      operatorViewFilter: {
        mode: viewFilter,
        excludedItems: excluded,
        unknownStateItems: unknown,
      },
    },
  };
}

export function parseOperatorViewFilter({ unviewed, viewed }) {
  if (unviewed && viewed) {
    throw cliValidationError("Pass either --unviewed or --viewed, not both.");
  }
  if (unviewed) return "unviewed";
  if (viewed) return "viewed";
  return null;
}

const OPERATOR_VIEW_FILTER_OPERATIONS = new Set([
  "recommendations.list",
  "subjects.candidates",
  "featured.list",
  "subject.comments",
  "post.comments",
]);

export function resolveOperatorViewFilter({ operation, unviewed, viewed }) {
  const viewFilter = parseOperatorViewFilter({ unviewed, viewed });
  if (!viewFilter) return null;
  if (OPERATOR_VIEW_FILTER_OPERATIONS.has(operation.name)) return viewFilter;
  throw cliValidationError(
    "--unviewed and --viewed are supported only by admin content-list commands.",
  );
}

function adminOperationRequiresRun(operation) {
  return (
    ![
      "identity.list",
      "identity.status",
      "identity.use",
      "identity.inspect",
      "economy.trace",
      "rescue.wordle.audit",
      "daily-run.start",
      "daily-run.status",
      "correction.start",
      "correction.status",
      "correction.complete",
      "escalation.list",
      "escalation.set",
      "notable.add",
    ].includes(operation.name) &&
    !operation.name.startsWith("ai-bucket.") &&
    !operation.name.startsWith("ai-email-policy.") &&
    !operation.name.startsWith("todo.")
  );
}

function noActiveRunError() {
  const error = new Error(
    "Start a delegated administrator daily run before using this command.",
  );
  error.code = "CLI_ADMIN_NO_ACTIVE_RUN";
  error.data = {
    ok: false,
    status: "validation_error",
    error: {
      code: error.code,
      message: error.message,
      details: null,
    },
  };
  return error;
}

export function parseAdminOperation(options) {
  const [namespace = "", action = "", target = "", extra = ""] =
    options.positional;

  if (namespace === "correction" || namespace === "corrections") {
    if (!action || action === "status") {
      return readOperation("correction.status", "/cli/admin/corrections/status");
    }
    if (action === "start") {
      const commentId = parseRequiredInteger(target, "comment ID", 1);
      return writeOperation(
        "correction.start",
        "POST",
        "/cli/admin/corrections",
        {
          commentId,
        },
      );
    }
    if (action === "complete" || action === "stop") {
      const correctionId = parseRequiredInteger(
        target,
        "correction session ID",
        1,
      );
      return writeOperation(
        "correction.complete",
        "POST",
        `/cli/admin/corrections/${correctionId}/complete`,
        {},
      );
    }
    throw cliValidationError(
      "Usage: lumine admin correction start <commentId> | correction status | correction complete <sessionId>.",
    );
  }

  if (namespace === "identity") {
    if (action === "list") {
      return readOperation("identity.list", "/cli/admin/identities");
    }
    if (action === "status") {
      return readOperation("identity.status", "/cli/admin/identity/status");
    }
    if (action === "use") {
      return writeOperation(
        "identity.use",
        "PUT",
        "/cli/admin/identity/preference",
        { identity: parseIdentity(target) },
      );
    }
    if (action === "inspect") {
      const inspectionTarget = String(target || "").trim();
      const reason = String(options.adminReason || "").trim();
      if (!inspectionTarget) {
        throw cliValidationError(
          "Usage: lumine admin identity inspect <userId|username> --reason <management reason> [--include-private-evidence].",
        );
      }
      if (!reason) {
        throw cliValidationError(
          "Explain why private identity evidence is needed with --reason <management reason>.",
        );
      }
      if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
        throw cliValidationError(
          `An identity-inspection reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
        );
      }
      return writeOperation(
        "identity.inspect",
        "POST",
        "/cli/admin/identity/inspect",
        {
          target: inspectionTarget,
          reason,
          includePrivateEvidence: options.adminIncludePrivateEvidence === true,
        },
      );
    }
  }

  if (namespace === "economy" && action === "trace") {
    const traceTarget = String(target || "").trim();
    const reason = String(options.adminReason || "").trim();
    if (!traceTarget || !reason) {
      throw cliValidationError(
        "Usage: lumine admin economy trace <userId|username> --reason <management reason> [--days <1..30>].",
      );
    }
    if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
      throw cliValidationError(
        `An investigation reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
      );
    }
    return writeOperation("economy.trace", "POST", "/cli/admin/economy/trace", {
      target: traceTarget,
      reason,
      days: parseRequiredInteger(options.adminDays || "3", "--days", 1, 30),
    });
  }

  if (namespace === "rescue" && action === "wordle-audit") {
    const reason = String(options.adminReason || "").trim();
    if (!reason) {
      throw cliValidationError(
        "Usage: lumine admin rescue wordle-audit --reason <management reason> [--days <1..30>].",
      );
    }
    if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
      throw cliValidationError(
        `An investigation reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
      );
    }
    return writeOperation(
      "rescue.wordle.audit",
      "POST",
      "/cli/admin/rescues/wordle/audit",
      {
        reason,
        days: parseRequiredInteger(options.adminDays || "30", "--days", 1, 30),
      },
    );
  }

  if (namespace === "ai-bucket" || namespace === "ai-buckets") {
    if (action === "create") {
      return writeOperation(
        "ai-bucket.create",
        "POST",
        "/cli/admin/ai-buckets",
        {
          label: parseAiBucketLabel(options.adminLabel),
          note: parseAiBucketNote(options.note),
        },
      );
    }
    const bucketId = parseRequiredInteger(
      options.adminBucketId,
      "AI bucket ID",
      1,
    );
    if (action === "get" || action === "status") {
      return readOperation(
        "ai-bucket.get",
        `/cli/admin/ai-buckets/${bucketId}`,
      );
    }
    if (action === "accounts" && target === "add") {
      return writeOperation(
        "ai-bucket.accounts.add",
        "POST",
        `/cli/admin/ai-buckets/${bucketId}/accounts`,
        {
          userIds: parseAiBucketUserIds(options.adminUserIds),
          note: options.note || undefined,
        },
      );
    }
    if (action === "note" && target === "set") {
      return writeOperation(
        "ai-bucket.note.set",
        "PUT",
        `/cli/admin/ai-buckets/${bucketId}/note`,
        { note: parseAiBucketNote(options.note) },
      );
    }
  }

  if (namespace === "ai-email-policy" || namespace === "ai-email-policies") {
    const email = parseAiEmailPolicyEmail(options.adminEmail);
    if (action === "get" || action === "status") {
      return bodyReadOperation(
        "ai-email-policy.get",
        "POST",
        "/cli/admin/ai-email-policies/lookup",
        { email },
      );
    }
    if (action === "set") {
      return writeOperation(
        "ai-email-policy.set",
        "PUT",
        "/cli/admin/ai-email-policies",
        {
          email,
          mode: parseAiEmailPolicyMode(options.adminMode),
          note: parseAiEmailPolicyNote(options.note),
        },
      );
    }
  }

  if (namespace === "todo" || namespace === "todos") {
    if (!action || action === "list") {
      return readOperation(
        "todo.list",
        withQuery("/cli/admin/todos", {
          status: parseTodoListStatus(options.adminStatus || "pending"),
          limit: options.limit,
        }),
      );
    }
    if (action === "add" || action === "create") {
      const title = String(options.title || "").trim();
      const details = String(options.note || "").trim();
      if (!title || !details) {
        throw cliValidationError(
          "Usage: lumine admin todo add --title <title> --note <handoff and acceptance criteria> [--kind task|experiment] [--status open|in_progress|blocked].",
        );
      }
      if (title.length > MAX_TODO_TITLE_LENGTH) {
        throw cliValidationError(
          `A todo title must be at most ${MAX_TODO_TITLE_LENGTH} characters.`,
        );
      }
      if (details.length > MAX_TODO_NOTE_LENGTH) {
        throw cliValidationError(
          `Todo details must be at most ${MAX_TODO_NOTE_LENGTH} characters.`,
        );
      }
      return writeOperation("todo.add", "POST", "/cli/admin/todos", {
        kind: parseTodoKind(options.adminKind || "task"),
        title,
        details,
        status: parseTodoInitialStatus(options.adminStatus || "open"),
      });
    }
    if (action === "update") {
      const todoId = parseRequiredInteger(target, "Todo ID", 1);
      const note = String(options.note || "").trim();
      if (!note) {
        throw cliValidationError(
          "Record concrete progress, evidence, or the reason for the state change with --note <text>.",
        );
      }
      if (note.length > MAX_TODO_NOTE_LENGTH) {
        throw cliValidationError(
          `A todo progress note must be at most ${MAX_TODO_NOTE_LENGTH} characters.`,
        );
      }
      return writeOperation(
        "todo.update",
        "PUT",
        `/cli/admin/todos/${todoId}`,
        {
          status: parseTodoStatus(options.adminStatus),
          note,
        },
      );
    }
    throw cliValidationError(
      "Usage: lumine admin todo list [--status pending|open|in_progress|blocked|completed|cancelled|all] | todo add --title <title> --note <details> | todo update <id> --status <status> --note <progress>.",
    );
  }

  if (namespace === "sponsor" || namespace === "sponsors") {
    if (action === "applications") {
      if (!target || target === "list") {
        return readOperation(
          "sponsor.applications.list",
          withQuery("/cli/admin/sponsors/applications", {
            status: options.adminStatus || "pending",
            limit: options.limit,
          }),
        );
      }
      if (target === "review") {
        const applicationId = parseRequiredInteger(
          extra,
          "Sponsor application ID",
          1,
        );
        const decision = parseChoice(
          options.adminDecision || options.adminStatus,
          "--decision",
          ["approve", "reject"],
        );
        return writeOperation(
          "sponsor.application.review",
          "POST",
          `/cli/admin/sponsors/applications/${applicationId}/review`,
          { decision, note: options.note || undefined },
        );
      }
    }
    if (action === "status" && target === "set") {
      const sponsorUserId = parseRequiredInteger(extra, "Sponsor user ID", 1);
      const status = parseChoice(options.adminStatus, "--status", [
        "probationary",
        "trusted",
        "suspended",
        "revoked",
      ]);
      return writeOperation(
        "sponsor.status.set",
        "PUT",
        `/cli/admin/sponsors/${sponsorUserId}/status`,
        { status, note: options.note || undefined },
      );
    }
    if (action === "integrity") {
      if (target === "status") {
        return readOperation(
          "sponsor.integrity.status",
          "/cli/admin/daily-runs/sponsor-integrity/status",
        );
      }
      if (target === "scan") {
        return writeOperation(
          "sponsor.integrity.scan",
          "POST",
          "/cli/admin/daily-runs/sponsor-integrity/scan",
          {},
        );
      }
      if (target === "cases") {
        return readOperation(
          "sponsor.integrity.cases",
          withQuery("/cli/admin/daily-runs/sponsor-integrity/cases", {
            status: options.adminStatus || "open",
            limit: options.limit,
          }),
        );
      }
      if (target === "get") {
        const caseId = parseRequiredInteger(extra, "Integrity case ID", 1);
        return readOperation(
          "sponsor.integrity.get",
          `/cli/admin/daily-runs/sponsor-integrity/cases/${caseId}`,
        );
      }
      if (target === "review") {
        const caseId = parseRequiredInteger(extra, "Integrity case ID", 1);
        const decision = parseChoice(options.adminDecision, "--decision", [
          "clear",
          "hold",
          "flag",
          "disqualify",
        ]);
        if (decision !== "clear" && !String(options.note || "").trim()) {
          throw cliValidationError(
            "Sponsor-integrity hold, flag, and disqualify decisions require --note <evidence>.",
          );
        }
        return writeOperation(
          "sponsor.integrity.review",
          "POST",
          `/cli/admin/daily-runs/sponsor-integrity/cases/${caseId}/review`,
          { decision, note: options.note || undefined },
        );
      }
    }
    throw cliValidationError(
      "Usage: lumine admin sponsor applications list|review | sponsor status set | sponsor integrity status|scan|cases|get|review.",
    );
  }

  if (namespace === "daily-run") {
    if (action === "start") {
      return writeOperation(
        "daily-run.start",
        "POST",
        "/cli/admin/daily-runs/start",
        {
          identity: options.adminIdentity
            ? parseIdentity(options.adminIdentity)
            : undefined,
          commentMode: parseCommentMode(options.commentMode || "off"),
          runKey: options.runKey || defaultDailyRunKey(),
        },
      );
    }
    if (action === "status") {
      return readOperation("daily-run.status", "/cli/admin/daily-runs/status");
    }
    if (action === "report") {
      return readOperation("daily-run.report", "/cli/admin/daily-runs/report");
    }
    if (action === "escalation" && target === "add") {
      const rawTarget = String(options.adminTarget || "").trim();
      const summary = String(options.note || "").trim();
      if (!rawTarget || !summary) {
        throw cliValidationError(
          "Pass a concrete --target and --note when recording a run escalation.",
        );
      }
      const parsedTarget = parseAdminEscalationTarget(rawTarget);
      return writeOperation(
        "daily-run.escalation.add",
        "POST",
        "/cli/admin/daily-runs/escalations",
        {
          targetType: parsedTarget.targetType || undefined,
          targetId: parsedTarget.targetId || undefined,
          url: parsedTarget.url || undefined,
          summary,
          severity: options.adminSeverity || "attention",
        },
      );
    }
    if (action === "complete" || action === "fail") {
      return writeOperation(
        `daily-run.${action}`,
        "POST",
        `/cli/admin/daily-runs/${action}`,
        action === "fail" ? { reason: options.adminReason || undefined } : {},
      );
    }
  }

  if (namespace === "escalation" || namespace === "escalations") {
    if (!action || action === "list") {
      const status = parseEscalationListStatus(options.adminStatus || "open");
      return readOperation(
        "escalation.list",
        withQuery("/cli/admin/escalations", {
          status,
          limit: options.limit,
        }),
      );
    }
    if (action === "set") {
      const escalationAuditId = parseRequiredInteger(
        target,
        "Escalation audit ID",
        1,
      );
      const status = parseEscalationStatus(options.adminStatus);
      const note = String(options.note || "").trim();
      if (!note) {
        throw cliValidationError(
          "Record the decision or next step with --note <text>.",
        );
      }
      if (note.length > MAX_ESCALATION_DECISION_NOTE_LENGTH) {
        throw cliValidationError(
          `An escalation decision note must be at most ${MAX_ESCALATION_DECISION_NOTE_LENGTH} characters.`,
        );
      }
      return writeOperation(
        "escalation.set",
        "PUT",
        `/cli/admin/escalations/${escalationAuditId}`,
        { status, note },
      );
    }
    throw cliValidationError(
      "Usage: lumine admin escalation list [--status open|acknowledged|resolved|all] | escalation set <auditId> --status <status> --note <decision>.",
    );
  }

  if (
    (namespace === "recommend-queue" && (!action || action === "list")) ||
    (namespace === "recommendations" && action === "list")
  ) {
    const kind = String(options.adminKind || "recommend").toLowerCase();
    if (kind !== "recommend") {
      throw cliValidationError("--kind currently supports only recommend.");
    }
    const recommendationWindow = parseRecommendationWindow(options);
    return readOperation(
      "recommendations.list",
      withQuery("/cli/admin/recommendations", {
        kind,
        contentTypes: options.adminContentTypes,
        cursor: options.adminCursor,
        limit: options.limit,
        sinceRun: recommendationWindow.mode === "since-run" ? "true" : "",
        after:
          recommendationWindow.mode === "after"
            ? recommendationWindow.after
            : "",
        includeLegacy: recommendationWindow.mode === "legacy" ? "true" : "",
      }),
      {
        pagination: {
          collectionKey: "items",
          coverageQueue: "recommendations",
          coverageMode: recommendationWindow.mode,
          after:
            recommendationWindow.mode === "after"
              ? parseAfterForCoverage(recommendationWindow.after)
              : null,
          filters: {
            contentTypes: options.adminContentTypes || null,
            operatorView: options.adminUnviewed
              ? "unviewed"
              : options.adminViewed
                ? "viewed"
                : null,
          },
        },
      },
    );
  }

  if (namespace === "builds" && action === "candidates") {
    return readOperation(
      "builds.candidates",
      withQuery("/build/public/list", {
        sort: "recent",
        scope: "all",
        cursor: options.adminCursor,
        limit: options.limit,
      }),
      {
        pagination: {
          collectionKey: "builds",
          coverageQueue: "builds",
          coverageMode: "all",
          after: null,
          filters: { sort: "recent", scope: "all" },
        },
      },
    );
  }
  if (namespace === "builds" && action === "review") {
    const parsed = parseAdminCommentTarget({ target, explicitType: "build" });
    if (parsed.type !== "build") {
      throw cliValidationError(
        "Build review targets a Build URL or build:<id>.",
      );
    }
    return {
      name: "build.review",
      method: "GET",
      path: "",
      body: undefined,
      mutates: false,
      buildId: parsed.id,
    };
  }

  if (
    namespace === "subjects" &&
    (action === "list" || action === "candidates")
  ) {
    return subjectsListOperation(options);
  }
  if (namespace === "subjects" && action === "featured") {
    return readOperation("featured.list", "/cli/admin/subjects/featured");
  }
  if (namespace === "subjects") {
    return legacySubjectsOperation({ action, target, options });
  }

  if (namespace === "subject") {
    if (action === "get") return subjectGetOperation(target, options);
    if (action === "comments") {
      const subjectId = parseSubjectId(target);
      return readOperation(
        "subject.comments",
        withQuery(`/cli/admin/subjects/${subjectId}/comments`, {
          cursor: options.adminCursor,
          limit: options.limit,
        }),
        { pagination: { collectionKey: "comments" } },
      );
    }
    if (action === "reveal") {
      return subjectWrite("subject.reveal", "POST", target, "/reveal");
    }
    if (action === "effort" && target === "set") {
      const subjectId = parseSubjectId(extra);
      const level = parseRequiredInteger(options.adminLevel, "--level", 1, 3);
      return writeOperation(
        "subject.effort.set",
        "PUT",
        `/cli/admin/subjects/${subjectId}/effort`,
        { level },
      );
    }
    if (action === "creator" && target === "set-made-by-poster") {
      return subjectWrite(
        "subject.creator.set-made-by-poster",
        "PUT",
        extra,
        "/created-by-author",
      );
    }
    if (action === "feature" || action === "unfeature") {
      return subjectWrite(
        `subject.${action}`,
        action === "feature" ? "POST" : "DELETE",
        target,
        "/featured",
      );
    }
  }

  if (namespace === "featured") {
    if (action === "list") {
      return readOperation("featured.list", "/cli/admin/subjects/featured");
    }
    if (action === "reorder") {
      return featuredReorderOperation(options);
    }
  }

  if (namespace === "comments" && action === "get") {
    const commentId = parseRequiredInteger(target, "comment ID", 1);
    return readOperation("comments.get", `/cli/admin/comments/${commentId}`, {
      correctionEligible: true,
      correctionCommentId: commentId,
    });
  }

  if (namespace === "post") {
    if (action === "get") return postGetOperation(target, options);
    if (action === "comments") {
      const parsedTarget = parseRecommendationTarget({
        target,
        explicitType: options.adminType,
      });
      if (parsedTarget.type === "comment") {
        throw cliValidationError("A comment cannot contain a comment list.");
      }
      const path =
        parsedTarget.type === "subject"
          ? `/cli/admin/subjects/${parsedTarget.id}/comments`
          : `/cli/admin/posts/${parsedTarget.type}/${parsedTarget.id}/comments`;
      return readOperation(
        "post.comments",
        withQuery(path, {
          cursor: options.adminCursor,
          limit: options.limit,
        }),
        { pagination: { collectionKey: "comments" } },
      );
    }
    if (action === "recommend") {
      return recommendOperation(target, options);
    }
    if (action === "skip") {
      const parsedTarget = parseRecommendationTarget({
        target,
        explicitType: options.adminType,
      });
      if (parsedTarget.type === "subject") {
        throw cliValidationError(
          "Skips apply to comment, aiStory, and dailyReflection targets; subjects leave the queue through effort assignment.",
        );
      }
      return writeOperation(
        "post.skip",
        "POST",
        `/cli/admin/skips/${parsedTarget.type}/${parsedTarget.id}`,
        { reason: options.adminReason || undefined },
      );
    }
    if (action === "skip-batch") {
      if (!options.adminTargetFile) {
        throw cliValidationError(
          "Pass batch skip targets with --target-file <file>.",
        );
      }
      return {
        name: "post.skip-batch",
        method: "POST",
        path: "",
        body: undefined,
        mutates: true,
      };
    }
    if (action === "reward") {
      const parsedTarget = parseRecommendationTarget({
        target,
        explicitType: options.adminType,
      });
      const twinkles = parseRequiredInteger(
        options.twinkles,
        "--twinkles",
        3,
        3,
      );
      return writeOperation(
        "post.reward",
        "POST",
        `/cli/admin/rewards/${parsedTarget.type}/${parsedTarget.id}`,
        { twinkles },
      );
    }
  }

  if (namespace === "recommend" && action) {
    return recommendOperation(action, options);
  }

  if (namespace === "news") {
    if (!action || action === "status") {
      return readOperation("news.status", "/cli/admin/news");
    }
    if (action === "print") {
      return writeOperation("news.print", "POST", "/cli/admin/news/print", {});
    }
    if (action === "claim") {
      const repairDate = String(options.adminDate || "").trim();
      if (repairDate && !/^\d{4}-\d{2}-\d{2}$/.test(repairDate)) {
        throw cliValidationError("--date must be YYYY-MM-DD.");
      }
      return writeOperation("news.claim", "POST", "/cli/admin/news/claim", {
        ...(repairDate ? { date: repairDate } : {}),
      });
    }
    if (action === "validate") {
      const claim = extractNewsClaim(
        readAdminJsonFile(options.adminClaimFile, "--claim <claim.json>"),
      );
      return {
        name: "news.validate",
        local: true,
        mutates: false,
        claim,
        editorial: readEditorialFile(options.adminFile),
      };
    }
    if (action === "submit") {
      const claim = options.adminClaimFile
        ? extractNewsClaim(
            readAdminJsonFile(options.adminClaimFile, "--claim <claim.json>"),
          )
        : null;
      const editionId = claim
        ? claim.editionId
        : parseRequiredInteger(options.adminEditionId, "--edition-id", 1);
      const leaseToken = claim
        ? claim.leaseToken
        : String(options.adminLeaseToken || "").trim();
      if (!leaseToken) {
        throw cliValidationError(
          "Pass the claim's lease token with --lease-token <token>.",
        );
      }
      const editorial = readEditorialFile(options.adminFile);
      if (claim) validateNewsEditorial({ claim, editorial });
      return writeOperation("news.submit", "POST", "/cli/admin/news/submit", {
        editionId,
        leaseToken,
        editorial,
        model: options.model || undefined,
      });
    }
    throw cliValidationError(
      "Usage: lumine admin news [status] | news print | news claim | news submit --edition-id <id> --lease-token <token> --file <editorial.json>",
    );
  }

  if (namespace === "notable" && action === "add") {
    const rawTarget = String(target || "").trim();
    if (!rawTarget) {
      throw cliValidationError(
        "Usage: lumine admin notable add <userId|username> --note <text>.",
      );
    }
    const body = /^\d+$/.test(rawTarget)
      ? { userId: parseRequiredInteger(rawTarget, "user ID", 1) }
      : { username: rawTarget };
    // --note records what made them notable (the management page's reason
    // column). On an already-listed user it updates the stored reason.
    const note = String(options.note || "").trim();
    if (!note) {
      throw cliValidationError(
        "Pass what made this user notable with --note <text>.",
      );
    }
    if (note.length > MAX_NOTABLE_NOTE_LENGTH) {
      throw cliValidationError(
        `A notable-user note must be at most ${MAX_NOTABLE_NOTE_LENGTH} characters.`,
      );
    }
    body.note = note;
    return writeOperation(
      "notable.add",
      "POST",
      "/cli/admin/notable-users",
      body,
    );
  }

  if (namespace === "ai-costs") {
    if (action === "monthly" && !target && !extra) {
      if (options.adminDays) {
        throw cliValidationError(
          "ai-costs monthly uses UTC calendar months and does not accept --days.",
        );
      }
      return readOperation("ai-costs.monthly", "/cli/admin/ai-costs/monthly");
    }
    throw cliValidationError("Usage: lumine admin ai-costs monthly [--json].");
  }

  if (namespace === "media-costs") {
    if (action === "monthly" && !target && !extra) {
      if (options.adminDays) {
        throw cliValidationError(
          "media-costs monthly uses the canonical UTC ledger and does not accept --days.",
        );
      }
      return readOperation(
        "media-costs.monthly",
        "/cli/admin/media-costs/monthly",
      );
    }
    throw cliValidationError(
      "Usage: lumine admin media-costs monthly [--json].",
    );
  }

  if (namespace === "brief" && !action) {
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw cliValidationError("--days must be an integer between 1 and 30.");
      }
    }
    return readOperation(
      "insights.brief",
      withQuery("/cli/admin/insights/brief", { days: options.adminDays }),
    );
  }

  if (namespace === "announcement" && action === "post") {
    return writeOperation(
      "announcement.post",
      "POST",
      "/cli/admin/announcements",
      {
        content: readComposedTextFile(options.adminFile),
      },
    );
  }

  if (namespace === "chat" && action === "send") {
    const rawTarget = String(target || "").trim();
    if (!rawTarget) {
      throw cliValidationError(
        "Usage: lumine admin chat send <userId|username> --file <message.md>.",
      );
    }
    // Composed-only, like persona comments: the agent writes the message in
    // the bot's voice; the server never invokes a model for it.
    return writeOperation("chat.send", "POST", "/cli/admin/chat-messages", {
      target: rawTarget,
      content: readComposedTextFile(options.adminFile),
    });
  }

  if (namespace === "bot-output" && !action) {
    if (options.adminDays && options.adminCursor) {
      throw cliValidationError(
        "Continue a bot-output --cursor without changing its --days window.",
      );
    }
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw cliValidationError("--days must be an integer between 1 and 30.");
      }
    }
    return readOperation(
      "bot.output",
      withQuery("/cli/admin/bot-output", {
        days: options.adminDays,
        cursor: options.adminCursor,
      }),
    );
  }

  if (namespace === "audit" && (!action || action === "list")) {
    const runFilter = String(options.adminRun || "").trim();
    if (runFilter && !["current", "last"].includes(runFilter)) {
      parseRequiredInteger(runFilter, "--run", 1);
    }
    return readOperation(
      "audit.list",
      withQuery("/cli/admin/audit", {
        run: runFilter,
        target: options.adminTarget,
        actions: options.adminActions,
        cursor: options.adminCursor,
        limit: options.limit,
        full: options.adminFull ? "true" : "",
      }),
      { pagination: { collectionKey: "events" } },
    );
  }

  if (namespace === "comment") {
    if (action === "draft" || action === "reply") {
      const parsedTarget = parseAdminCommentTarget({
        target,
        explicitType: options.adminType,
      });
      if (action === "reply" && parsedTarget.type !== "comment") {
        throw cliValidationError(
          "comment reply targets a comment: lumine admin comment reply comment:<id>.",
        );
      }
      const reviewedBuildVersionId = options.adminReviewedBuildVersion
        ? parseRequiredInteger(
            options.adminReviewedBuildVersion,
            "--reviewed-version",
            1,
          )
        : undefined;
      const buildReviewMethod = options.adminBuildReviewMethod
        ? parseAdminBuildReviewMethod(options.adminBuildReviewMethod)
        : undefined;
      const reviewReceipt = options.adminReviewReceipt
        ? parseBuildReviewReceipt(options.adminReviewReceipt)
        : null;
      const buildReviewUnderstanding = options.adminReviewContext
        ? readBuildReviewContextFile(options.adminReviewContext)
        : undefined;
      if (reviewReceipt && (reviewedBuildVersionId || buildReviewMethod)) {
        throw cliValidationError(
          "Pass either --review-receipt or manual --reviewed-version/--reviewed-via evidence, not both.",
        );
      }
      const confirmedBuildVersionId = reviewReceipt
        ? Number(reviewReceipt.publishedArtifactVersionId)
        : reviewedBuildVersionId;
      const confirmedBuildReviewMethod = reviewReceipt
        ? "runtime"
        : buildReviewMethod;
      if (
        buildReviewUnderstanding &&
        (!confirmedBuildVersionId || !confirmedBuildReviewMethod)
      ) {
        throw cliValidationError(
          "--review-context requires confirmed Build review evidence.",
        );
      }
      if (
        (confirmedBuildVersionId || confirmedBuildReviewMethod) &&
        !buildReviewUnderstanding
      ) {
        throw cliValidationError(
          "Build review evidence requires --review-context <context.json>.",
        );
      }
      if (
        reviewReceipt &&
        parsedTarget.type === "build" &&
        Number(reviewReceipt.buildId) !== parsedTarget.id
      ) {
        throw cliValidationError(
          "The review receipt belongs to a different Build.",
        );
      }
      if (parsedTarget.type === "build") {
        if (!options.adminFile) {
          throw cliValidationError(
            "Build comments are management-agent composed only; pass --file <comment.md> after reviewing the project.",
          );
        }
        if (
          !confirmedBuildVersionId ||
          !confirmedBuildReviewMethod ||
          !buildReviewUnderstanding
        ) {
          throw cliValidationError(
            "After reviewing the project, pass review evidence and --review-context <context.json>.",
          );
        }
      } else if (
        parsedTarget.type !== "comment" &&
        (confirmedBuildVersionId || confirmedBuildReviewMethod)
      ) {
        throw cliValidationError(
          "Build review evidence applies only to build:<id> or a comment:<id> inside a Build.",
        );
      }
      return writeOperation(
        "comment.draft",
        "POST",
        "/cli/admin/comment-drafts",
        {
          targetType: parsedTarget.type,
          targetId: parsedTarget.id,
          identity: options.adminIdentity
            ? parseIdentity(options.adminIdentity)
            : undefined,
          ...(options.adminFile
            ? { content: readComposedTextFile(options.adminFile) }
            : {}),
          ...(confirmedBuildVersionId
            ? { reviewedBuildVersionId: confirmedBuildVersionId }
            : {}),
          ...(confirmedBuildReviewMethod
            ? { buildReviewMethod: confirmedBuildReviewMethod }
            : {}),
          ...(buildReviewUnderstanding ? { buildReviewUnderstanding } : {}),
        },
      );
    }
    if (action === "edit") {
      const rawTarget = String(target || "").trim();
      let commentId;
      if (/^\d+$/.test(rawTarget)) {
        commentId = parseRequiredInteger(rawTarget, "comment id", 1);
      } else {
        const parsedTarget = parseRecommendationTarget({
          target,
          explicitType: options.adminType,
        });
        if (parsedTarget.type !== "comment") {
          throw cliValidationError(
            "comment edit targets a comment: lumine admin comment edit <commentId> --file <comment.md>.",
          );
        }
        commentId = parsedTarget.id;
      }
      return writeOperation(
        "comment.edit",
        "PUT",
        `/cli/admin/comments/${commentId}`,
        { content: readComposedTextFile(options.adminFile) },
        {
          correctionEligible: true,
          correctionCommentId: commentId,
        },
      );
    }
    if (action === "post") {
      const draftId = parseRequiredInteger(
        options.draftId || target,
        "--draft-id",
        1,
      );
      return writeOperation(
        "comment.post",
        "POST",
        `/cli/admin/comment-drafts/${draftId}/publish`,
        {},
      );
    }
  }

  throw cliValidationError(
    "Usage: lumine admin identity|economy|rescue|sponsor|daily-run|escalation|todo|recommendations|builds|post|subjects|subject|featured|comment|announcement|chat|news|audit|brief|ai-costs|media-costs|bot-output|notable ...",
  );
}

function subjectsListOperation(options) {
  return readOperation(
    "subjects.candidates",
    withQuery("/cli/admin/subjects", {
      after: options.adminAfter,
      cursor: options.adminCursor,
      effort: options.adminEffort,
      limit: options.limit,
    }),
    {
      pagination: {
        collectionKey: "subjects",
        coverageQueue: "subjects",
        coverageMode: options.adminAfter ? "after" : "all",
        after: options.adminAfter
          ? parseAfterForCoverage(options.adminAfter)
          : null,
        filters: { effort: options.adminEffort || "all" },
      },
    },
  );
}

function subjectGetOperation(target, options) {
  const subjectId = parseSubjectId(target);
  return readOperation(
    "subject.get",
    withQuery(`/cli/admin/subjects/${subjectId}`, {
      includeComments: options.includeComments ? "true" : "",
    }),
  );
}

function postGetOperation(target, options) {
  const parsedTarget = parseRecommendationTarget({
    target,
    explicitType: options.adminType,
  });
  if (parsedTarget.type === "subject") {
    return subjectGetOperation(parsedTarget.id, options);
  }
  if (parsedTarget.type === "comment") {
    return readOperation("post.get", `/cli/admin/comments/${parsedTarget.id}`, {
      correctionEligible: true,
      correctionCommentId: parsedTarget.id,
    });
  }
  return readOperation(
    "post.get",
    `/cli/admin/posts/${parsedTarget.type}/${parsedTarget.id}`,
  );
}

function legacySubjectsOperation({ action, target, options }) {
  if (action === "get") return subjectGetOperation(target, options);
  if (action === "set-effort") {
    const subjectId = parseSubjectId(target);
    const level = parseRequiredInteger(options.adminLevel, "--level", 1, 3);
    return writeOperation(
      "subject.effort.set",
      "PUT",
      `/cli/admin/subjects/${subjectId}/effort`,
      { level },
    );
  }
  if (action === "mark-created-by-author") {
    return subjectWrite(
      "subject.creator.set-made-by-poster",
      "PUT",
      target,
      "/created-by-author",
    );
  }
  if (action === "feature" || action === "unfeature") {
    return subjectWrite(
      `subject.${action}`,
      action === "feature" ? "POST" : "DELETE",
      target,
      "/featured",
    );
  }
  if (action === "reorder") return featuredReorderOperation(options);
  throw cliValidationError(
    `Unknown subjects action: ${action || "(missing)"}.`,
  );
}

function subjectWrite(name, method, target, suffix) {
  const subjectId = parseSubjectId(target);
  return writeOperation(
    name,
    method,
    `/cli/admin/subjects/${subjectId}${suffix}`,
    {},
  );
}

function featuredReorderOperation(options) {
  return writeOperation(
    "featured.reorder",
    "PUT",
    "/cli/admin/subjects/featured/order",
    { ids: parseOrderedIds(options.adminIds) },
  );
}

function recommendOperation(target, options) {
  const recommendationTarget = parseRecommendationTarget({
    target,
    explicitType: options.adminType,
  });
  const rewardTwinkles = options.rewardTwinkles
    ? parseRequiredInteger(options.rewardTwinkles, "--reward-twinkles", 3, 3)
    : 0;
  if (rewardTwinkles === 3 && !options.anyoneCanReward) {
    throw cliValidationError(
      "--reward-twinkles 3 requires --anyone-can-reward.",
    );
  }
  return writeOperation(
    "post.recommend",
    "POST",
    `/cli/admin/recommendations/${recommendationTarget.type}/${recommendationTarget.id}`,
    {
      anyoneCanReward: options.anyoneCanReward,
      rewardTwinkles,
    },
  );
}

export function parseRecommendationWindow(options) {
  const selected = [
    options.adminSinceRun ? "since-run" : "",
    options.adminAfter ? "after" : "",
    options.adminIncludeLegacy ? "legacy" : "",
  ].filter(Boolean);
  if (selected.length > 1) {
    throw cliValidationError(
      "Choose one recommendation window: --since-run, --after, or --include-legacy.",
    );
  }
  const mode = selected[0] || "since-run";
  if (mode === "after") parseAfterForCoverage(options.adminAfter);
  return { mode, after: mode === "after" ? options.adminAfter : "" };
}

function parseAfterForCoverage(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  const parsedMs = Date.parse(raw);
  if (Number.isFinite(parsedMs)) return Math.floor(parsedMs / 1000);
  throw cliValidationError(
    "--after must be a Unix timestamp or ISO-8601 date.",
  );
}

export function parseSubjectId(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/(?:^subject:|\/subjects\/)(\d+)(?:[/?#]|$)/i);
  return parseRequiredInteger(match?.[1] || normalized, "subject ID", 1);
}

export function parseRecommendationTarget({ target, explicitType = "" }) {
  const normalized = String(target || "").trim();
  const prefixed = normalized.match(
    /^(subject|comment|aistory|dailyreflection):(\d+)$/i,
  );
  const subjectUrl = normalized.match(/\/subjects\/(\d+)(?:[/?#]|$)/i);
  const commentUrl = normalized.match(/\/comments\/(\d+)(?:[/?#]|$)/i);
  const aiStoryUrl = normalized.match(/\/ai-stories\/(\d+)(?:[/?#]|$)/i);
  const dailyReflectionUrl = normalized.match(
    /\/daily-reflections\/(\d+)(?:[/?#]|$)/i,
  );
  const inferredType =
    normalizeRecommendationTargetType(prefixed?.[1]) ||
    (subjectUrl
      ? "subject"
      : commentUrl
        ? "comment"
        : aiStoryUrl
          ? "aiStory"
          : dailyReflectionUrl
            ? "dailyReflection"
            : "");
  const explicitNormalizedType =
    normalizeRecommendationTargetType(explicitType);
  if (explicitType && !explicitNormalizedType) {
    throw cliValidationError(
      "--type must be subject, comment, aiStory, or dailyReflection.",
    );
  }
  const type = explicitNormalizedType || inferredType || "subject";
  if (!["subject", "comment", "aiStory", "dailyReflection"].includes(type)) {
    throw cliValidationError(
      "--type must be subject, comment, aiStory, or dailyReflection.",
    );
  }
  if (explicitType && inferredType && type !== inferredType) {
    throw cliValidationError(
      "The target and --type identify different content types.",
    );
  }
  const id = parseRequiredInteger(
    prefixed?.[2] ||
      subjectUrl?.[1] ||
      commentUrl?.[1] ||
      aiStoryUrl?.[1] ||
      dailyReflectionUrl?.[1] ||
      normalized,
    `${type} ID`,
    1,
  );
  return { type, id };
}

export function parseAdminCommentTarget({ target, explicitType = "" }) {
  const normalized = String(target || "").trim();
  const prefixed = normalized.match(
    /^(subject|comment|build|aistory|dailyreflection):(\d+)$/i,
  );
  const buildUrl = normalized.match(/\/(?:app|build)\/(\d+)(?:[/?#]|$)/i);
  const baseTarget = parseRecommendationTarget({
    target:
      prefixed?.[1]?.toLowerCase() === "build" || buildUrl
        ? `subject:${prefixed?.[2] || buildUrl?.[1]}`
        : normalized,
    explicitType:
      String(explicitType || "").toLowerCase() === "build"
        ? "subject"
        : explicitType,
  });
  const inferredBuild = prefixed?.[1]?.toLowerCase() === "build" || !!buildUrl;
  const explicitBuild = String(explicitType || "").toLowerCase() === "build";
  if (explicitType && !explicitBuild && inferredBuild) {
    throw cliValidationError(
      "The target and --type identify different content types.",
    );
  }
  if (explicitBuild && !inferredBuild && !/^\d+$/.test(normalized)) {
    throw cliValidationError(
      "The target and --type identify different content types.",
    );
  }
  if (inferredBuild || explicitBuild) {
    return { type: "build", id: baseTarget.id };
  }
  return baseTarget;
}

export function parseAdminEscalationTarget(value) {
  const normalized = String(value || "").trim();
  const genericTarget = normalized.match(
    /^([a-zA-Z][a-zA-Z0-9_-]{0,39}):(\d+)$/,
  );
  if (genericTarget) {
    return {
      targetType: genericTarget[1],
      targetId: parseRequiredInteger(
        genericTarget[2],
        "escalation target ID",
        1,
      ),
      url: null,
    };
  }
  if (/^https:\/\//i.test(normalized)) {
    let parsedUrl;
    try {
      parsedUrl = new URL(normalized);
    } catch {
      throw cliValidationError("The escalation target URL is invalid.");
    }
    if (parsedUrl.protocol !== "https:") {
      throw cliValidationError("The escalation target URL must use HTTPS.");
    }
    if (
      /\/(?:subjects|comments|ai-stories|daily-reflections|app|build)\/\d+(?:[/?#]|$)/i.test(
        normalized,
      )
    ) {
      const parsed = parseAdminCommentTarget({ target: normalized });
      return { targetType: parsed.type, targetId: parsed.id, url: normalized };
    }
    return { targetType: null, targetId: null, url: normalized };
  }
  const parsed = parseAdminCommentTarget({ target: normalized });
  return { targetType: parsed.type, targetId: parsed.id, url: null };
}

function parseAdminBuildReviewMethod(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized !== "runtime" && normalized !== "code") {
    throw cliValidationError("--reviewed-via must be runtime or code.");
  }
  return normalized;
}

function normalizeRecommendationTargetType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "subject" || normalized === "comment") return normalized;
  if (normalized === "aistory" || normalized === "ai-story") return "aiStory";
  if (normalized === "dailyreflection" || normalized === "daily-reflection") {
    return "dailyReflection";
  }
  return "";
}

export function isAdminJsonInvocation(args) {
  return (
    args[0] === "admin" &&
    args.some((arg) => /^--json(?:=(?:1|true|yes|on))?$/i.test(arg))
  );
}

export function formatAdminJsonError(error) {
  const serverResult = error?.data;
  if (serverResult?.ok === false && serverResult?.error) return serverResult;
  return {
    ok: false,
    status:
      error?.code === "CLI_ADMIN_CLI_VALIDATION" ? "validation_error" : "error",
    error: {
      code: error?.code || "LUMINE_ADMIN_ERROR",
      message: String(error?.message || "The administrator command failed."),
      details: null,
    },
  };
}

export function assertAdminTodoHandoffResult(result) {
  const runId = Number(result?.data?.run?.id || 0);
  const handoff = result?.data?.carryoverTodos;
  if (
    !runId ||
    !handoff ||
    !Array.isArray(handoff.items) ||
    Number(handoff.count) !== handoff.items.length ||
    Number(handoff.surfacedForRunId) !== runId ||
    !Number.isSafeInteger(Number(handoff.newlySurfacedCount)) ||
    Number(handoff.newlySurfacedCount) < 0 ||
    Number(handoff.newlySurfacedCount) > handoff.items.length
  ) {
    const error = cliValidationError(
      "The API did not confirm the canonical carry-over todo handoff. Deploy the todo migration/API before using this Lumine CLI for community management.",
    );
    error.code = "LUMINE_ADMIN_TODO_HANDOFF_UNSUPPORTED";
    throw error;
  }
  return handoff;
}

function readOperation(name, path, extra = {}) {
  return {
    name,
    method: "GET",
    path,
    body: undefined,
    mutates: false,
    ...extra,
  };
}

function bodyReadOperation(name, method, path, body) {
  return { name, method, path, body, mutates: false };
}

function writeOperation(name, method, path, body, extra = {}) {
  return { name, method, path, body, mutates: true, ...extra };
}

function withQuery(path, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value !== null && value !== undefined) {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function parseIdentity(value) {
  const identity = String(value || "")
    .trim()
    .toLowerCase();
  if (!["zero", "ciel", "auto"].includes(identity)) {
    throw cliValidationError("Identity must be zero, ciel, or auto.");
  }
  return identity;
}

function parseCommentMode(value) {
  const mode = String(value || "off")
    .trim()
    .toLowerCase();
  if (!["off", "draft", "post"].includes(mode)) {
    throw cliValidationError("--comment-mode must be off, draft, or post.");
  }
  return mode;
}

function parseEscalationStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (!["open", "acknowledged", "resolved"].includes(status)) {
    throw cliValidationError(
      "--status must be open, acknowledged, or resolved.",
    );
  }
  return status;
}

function parseEscalationListStatus(value) {
  const status = String(value || "open")
    .trim()
    .toLowerCase();
  if (!["open", "acknowledged", "resolved", "all"].includes(status)) {
    throw cliValidationError(
      "--status must be open, acknowledged, resolved, or all.",
    );
  }
  return status;
}

function parseTodoKind(value) {
  const kind = String(value || "task")
    .trim()
    .toLowerCase();
  if (!["task", "experiment"].includes(kind)) {
    throw cliValidationError("--kind must be task or experiment.");
  }
  return kind;
}

function parseTodoInitialStatus(value) {
  const status = String(value || "open")
    .trim()
    .toLowerCase();
  if (!["open", "in_progress", "blocked"].includes(status)) {
    throw cliValidationError(
      "A new todo --status must be open, in_progress, or blocked.",
    );
  }
  return status;
}

function parseTodoStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !["open", "in_progress", "blocked", "completed", "cancelled"].includes(
      status,
    )
  ) {
    throw cliValidationError(
      "--status must be open, in_progress, blocked, completed, or cancelled.",
    );
  }
  return status;
}

function parseTodoListStatus(value) {
  const status = String(value || "pending")
    .trim()
    .toLowerCase();
  if (status === "pending" || status === "all") return status;
  return parseTodoStatus(status);
}

function parseOrderedIds(value) {
  const ids = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseRequiredInteger(part, "Featured subject ID", 1));
  if (!String(value || "").trim()) {
    throw cliValidationError(
      "Pass the complete ordered list with --subject-ids <id,id,...>.",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw cliValidationError("Featured subject IDs must be unique.");
  }
  return ids;
}

function parseAiBucketLabel(value) {
  const label = String(value || "").trim();
  if (!label) {
    throw cliValidationError("Pass the bucket name with --label <name>.");
  }
  if (label.length > 120) {
    throw cliValidationError(
      "An AI bucket name can be at most 120 characters.",
    );
  }
  return label;
}

function parseAiBucketNote(value) {
  const note = String(value || "").trim();
  if (!note) {
    throw cliValidationError("Pass the quota-only context with --note <text>.");
  }
  if (note.length > 255) {
    throw cliValidationError(
      "An AI bucket note can be at most 255 characters.",
    );
  }
  return note;
}

function parseAiBucketUserIds(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw cliValidationError(
      "Pass explicit accounts with --user-ids <id,id,...>.",
    );
  }
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseRequiredInteger(part, "AI bucket user ID", 1));
  if (ids.length > 500) {
    throw cliValidationError(
      "An AI bucket batch can contain at most 500 users.",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw cliValidationError("AI bucket user IDs must be unique.");
  }
  return ids;
}

function parseAiEmailPolicyEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  const at = email.indexOf("@");
  if (
    !email ||
    email.length > 320 ||
    /\s/.test(email) ||
    at <= 0 ||
    at !== email.lastIndexOf("@") ||
    at === email.length - 1
  ) {
    throw cliValidationError(
      "Pass a valid verified email with --email <address>.",
    );
  }
  return email;
}

function parseAiEmailPolicyMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  if (mode !== "automatic" && mode !== "separate_accounts") {
    throw cliValidationError("--mode must be automatic or separate_accounts.");
  }
  return mode;
}

function parseAiEmailPolicyNote(value) {
  const note = String(value || "").trim();
  if (!note) {
    throw cliValidationError("Pass the policy reason with --note <text>.");
  }
  if (note.length > 255) {
    throw cliValidationError(
      "An AI email-policy note can be at most 255 characters.",
    );
  }
  return note;
}

function parseRequiredInteger(
  value,
  label,
  minimum,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const raw = String(value ?? "").trim();
  const number = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    const range =
      maximum === Number.MAX_SAFE_INTEGER
        ? `at least ${minimum}`
        : `${minimum}-${maximum}`;
    throw cliValidationError(`${label} must be an integer ${range}.`);
  }
  return number;
}

function parseChoice(value, label, choices) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!choices.includes(normalized)) {
    throw cliValidationError(`${label} must be ${choices.join(", ")}.`);
  }
  return normalized;
}

function defaultDailyRunKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `daily:${value.year}-${value.month}-${value.day}`;
}

function cliValidationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function adminValueFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function formatAdminUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "unavailable";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatAdminMonthlyCostComparison(projection, previousMonthKey) {
  const rawPercent = projection?.comparisonToPreviousMonth?.percentChange;
  const percent = rawPercent === null ? NaN : Number(rawPercent);
  if (!Number.isFinite(percent)) {
    return `comparison with ${previousMonthKey} unavailable`;
  }
  if (percent === 0) return `even with ${previousMonthKey}`;
  return `${Math.abs(percent).toFixed(2)}% ${percent < 0 ? "below" : "above"} ${previousMonthKey}`;
}

function printAdminMonthlyAiCosts(monthlyAiCosts) {
  const previous = monthlyAiCosts.previousMonth;
  const current = monthlyAiCosts.currentMonth;
  const generatedAt = new Date(
    Number(monthlyAiCosts.generatedAt) * 1000,
  ).toISOString();
  console.log(`Application AI-cost ledger (UTC; generated ${generatedAt}).`);
  console.log(
    `${previous.monthKey} closed month: ${formatAdminUsd(previous.estimatedCostUsd)} estimated cost.`,
  );
  if (current.completed.dayCount > 0) {
    console.log(
      `${current.monthKey} completed-day MTD through ${current.completed.throughDayKey}: ${formatAdminUsd(current.completed.estimatedCostUsd)} across ${current.completed.dayCount} completed UTC day(s).`,
    );
  } else {
    console.log(
      `${current.monthKey} completed-day MTD: ${formatAdminUsd(current.completed.estimatedCostUsd)}; no UTC day has completed yet.`,
    );
  }
  console.log(
    `${current.inProgressDay.dayKey} in progress: ${formatAdminUsd(current.inProgressDay.estimatedCostUsd)} so far (excluded from completed-day MTD and both projections).`,
  );

  const allPace = current.projections.allCompletedDaysPace;
  if (allPace) {
    console.log(
      `All-completed-days pace full-month projection: ${formatAdminUsd(allPace.estimatedMonthTotalUsd)} (${formatAdminUsd(allPace.dailyAverageUsd)}/day across ${allPace.basisDayCount} completed day(s); ${formatAdminMonthlyCostComparison(allPace, previous.monthKey)}).`,
    );
  } else {
    console.log(
      "All-completed-days pace full-month projection: unavailable until one UTC day has completed.",
    );
  }

  const recentPace = current.projections.recentSevenCompletedDaysPace;
  if (recentPace) {
    console.log(
      `Recent-seven-completed-day pace full-month projection: ${formatAdminUsd(recentPace.estimatedMonthTotalUsd)} (${formatAdminUsd(recentPace.dailyAverageUsd)}/day from ${recentPace.basisStartDayKey} through ${recentPace.basisEndDayKey}; ${formatAdminMonthlyCostComparison(recentPace, previous.monthKey)}).`,
    );
  } else {
    console.log(
      "Recent-seven-completed-day pace full-month projection: unavailable until seven UTC days have completed.",
    );
  }
}

function formatAdminMediaUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "unavailable";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function formatAdminMediaBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "unavailable";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
}

function printAdminMonthlyMediaCosts(monthlyMediaCosts) {
  const generatedAt = new Date(
    Number(monthlyMediaCosts.generatedAt) * 1000,
  ).toISOString();
  const current = monthlyMediaCosts.currentMonth;
  const today = monthlyMediaCosts.currentUtcDay;
  const operations = monthlyMediaCosts.operations;
  const streamAttempts = today.streamAttempts || {
    attemptedCount: 0,
    reachedLiveCount: 0,
    endedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    inProgressCount: 0,
    failureCodeCounts: [],
  };
  console.log(
    `Lumine media-cost monitor (UTC; ${monthlyMediaCosts.status}; generated ${generatedAt}).`,
  );
  console.log(
    `${current.monthKey}: ${formatAdminMediaUsd(current.estimatedSpentUsd)} settled estimate + ${formatAdminMediaUsd(current.activeReservedUsd)} active reservations + ${formatAdminMediaUsd(current.carryoverUsd)} carryover = ${formatAdminMediaUsd(current.guardedTotalUsd)} guarded of ${formatAdminMediaUsd(current.limitUsd)} (${Number(current.percentUsed).toFixed(2)}% used; ${formatAdminMediaUsd(current.remainingUsd)} remaining).`,
  );
  console.log(
    `${today.dayKey} so far: ${today.reservationsCreated} action(s) reserved, ${today.commitmentsSettled} committed, ${today.cancellationsSettled} cancelled, ${formatAdminMediaUsd(today.estimatedCostSettledUsd)} settled estimate.`,
  );
  console.log(
    `Stream attempts created ${today.dayKey} UTC: ${streamAttempts.attemptedCount} attempted / ${streamAttempts.reachedLiveCount} reached live / ${streamAttempts.endedCount} ended after live / ${streamAttempts.failedCount} failed / ${streamAttempts.cancelledCount} cancelled before live / ${streamAttempts.inProgressCount} still in progress.`,
  );
  const streamFailureCodeCounts = Array.isArray(
    streamAttempts.failureCodeCounts,
  )
    ? streamAttempts.failureCodeCounts
    : [];
  console.log(
    streamFailureCodeCounts.length > 0
      ? `Stream failure codes: ${streamFailureCodeCounts
          .map((entry) => `${entry.code}=${entry.count}`)
          .join(", ")}.`
      : "Stream failure codes: none.",
  );
  const stillActiveOrCleanupPendingCount =
    operations.live.stillActiveOrCleanupPendingCount ??
    Number(operations.live.provisioningCount || 0) +
      Number(operations.live.readyCount || 0) +
      Number(operations.live.liveCount || 0) +
      Number(operations.live.endingCount || 0) +
      Number(operations.live.cleanupFailedCount || 0);
  const replayOperations = operations.replays || {
    pendingCount: 0,
    processingCount: 0,
    readyCount: 0,
    failedCount: 0,
    deletePendingCount: 0,
    deleteFailedCount: 0,
    expiredReadyCount: 0,
    finalizationOverdueCount: 0,
    deletionOverdueCount: 0,
    storedBytes: 0,
    storedObjectCount: 0,
  };
  const replayViewers = operations.replayViewers || {
    activeGrantCount: 0,
    expiredActiveGrantCount: 0,
  };
  const kindRows = [
    ["Short clips", current.byKind.clip],
    ["Live inputs", current.byKind.liveInput],
    ["Live viewers", current.byKind.liveViewer],
  ];
  if (current.byKind.replayViewer) {
    kindRows.push(["Replay viewers", current.byKind.replayViewer]);
  }
  for (const [label, cost] of kindRows) {
    console.log(
      `${label}: ${cost.actionCount} action(s), ${cost.committedCount} committed for ${formatAdminMediaUsd(cost.estimatedSpentUsd)}, ${cost.activeReservedCount} active reservation(s) holding ${formatAdminMediaUsd(cost.activeReservedUsd)}, ${cost.cancelledCount} cancelled.`,
    );
  }
  console.log(
    `Ledger reconciliation: ${current.reconciliation.consistent ? "consistent" : "MISMATCH"}; spent delta ${formatAdminMediaUsd(current.reconciliation.spentDeltaUsd)}, reserved delta ${formatAdminMediaUsd(current.reconciliation.reservedDeltaUsd)}.`,
  );
  console.log(
    `Operations: clips ${operations.clips.completingCount} completing / ${operations.clips.processingCount} processing / ${operations.clips.staleCount} stale; live ${operations.live.liveCount} broadcasting / ${stillActiveOrCleanupPendingCount} active-or-cleanup-pending / ${operations.live.costBearingChannelCount} cost-bearing channel(s) / ${operations.live.possibleOrphanedCount ?? operations.live.cleanupOverdueCount} possible orphan(s); viewers ${operations.viewers.activeGrantCount} active / ${operations.viewers.expiredActiveGrantCount} expired-active.`,
  );
  console.log(
    `Replays: ${replayOperations.pendingCount} pending / ${replayOperations.processingCount} processing / ${replayOperations.readyCount} ready / ${replayOperations.failedCount} failed / ${replayOperations.deletePendingCount} deleting / ${replayOperations.deleteFailedCount} delete-failed; ${replayOperations.finalizationOverdueCount} finalization-overdue / ${replayOperations.deletionOverdueCount} deletion-overdue / ${replayOperations.expiredReadyCount} expired-ready; ${formatAdminMediaBytes(replayOperations.storedBytes)} across ${replayOperations.storedObjectCount} canonical object(s); viewers ${replayViewers.activeGrantCount} active / ${replayViewers.expiredActiveGrantCount} expired-active.`,
  );
  console.log(
    `Shared runtime storage context: ${operations.runtimeStorage.readyImages.assetCount} ready image(s), ${formatAdminMediaBytes(operations.runtimeStorage.readyImages.totalBytes)}; ${operations.runtimeStorage.readyClips.assetCount} ready clip(s), ${formatAdminMediaBytes(operations.runtimeStorage.readyClips.totalBytes)}. Images include all Build runtime image uploads, not only camera captures.`,
  );
  if (monthlyMediaCosts.alerts.length === 0) {
    console.log("Media-cost alerts: none.");
  } else {
    for (const alert of monthlyMediaCosts.alerts) {
      console.log(
        `Media-cost alert [${String(alert.severity).toUpperCase()}] ${alert.code}: ${alert.message}`,
      );
    }
  }
  console.log(
    "These are conservative provider-cost ledger estimates, not an AWS invoice; reconcile IVS, MediaConvert, replay S3, and shared runtime S3 Cost Explorer data separately after billing lag.",
  );
}

async function printSpooledAdminResult({ result, storage }) {
  const data = result?.data || {};
  const count = Number(storage.candidateCount || 0);
  if (storage.collectionKey === "subjects") {
    console.log(`${count} subject(s):`);
    await forEachPaginatedResultItem(result, async (subject) => {
      console.log(
        `#${subject.id} ${subject.title || "(untitled)"} — ${subject.author?.username || "unknown"} — effort ${subject.effortLevel ?? "unknown"}`,
      );
      console.log(`  ${subject.url}`);
    });
  } else if (storage.collectionKey === "events") {
    console.log(`${count} audit event(s):`);
    await forEachPaginatedResultItem(result, async (event) => {
      const target =
        event.targetType && event.targetId
          ? ` ${event.targetType}:${event.targetId}`
          : "";
      console.log(
        `#${event.id} run ${event.runId ?? "-"} ${event.action}${target} — ${event.result}${event.changed === true ? " (changed)" : event.changed === false ? " (no change)" : ""}`,
      );
    });
  } else if (storage.collectionKey === "comments") {
    console.log(
      `${count} comment(s) for ${data.subject?.url || "this target"}:`,
    );
    await forEachPaginatedResultItem(result, async (comment) => {
      console.log(
        `#${comment.id} ${comment.author?.username || "unknown"}: ${comment.content || "(empty)"}`,
      );
    });
  } else if (storage.collectionKey === "items") {
    console.log(`${count} recommendation candidate(s):`);
    await forEachPaginatedResultItem(result, async (item) => {
      console.log(`#${item.contentId} ${item.contentType}`);
      if (item.url || item.subjectUrl) {
        console.log(`  ${item.url || item.subjectUrl}`);
      }
    });
  } else if (storage.collectionKey === "builds") {
    console.log(`${count} Build candidate(s):`);
    await forEachPaginatedResultItem(result, async (build) => {
      console.log(`#${build.id} ${build.title || "(untitled)"}`);
      if (build.url) console.log(`  ${build.url}`);
    });
  } else {
    console.log(
      `${count} ${storage.collectionKey} candidate(s) saved at ${storage.spoolPath}.`,
    );
  }
  printPagination(data.pagination);
}

function printAdminResult({ operation, result }) {
  const data = result?.data || {};
  if (Array.isArray(data.applications)) {
    console.log(`${data.applications.length} sponsor application(s):`);
    for (const application of data.applications) {
      console.log(
        `  #${application.id} ${String(application.status).toUpperCase()} · ${application.username || `user ${application.userId}`} · agreement ${application.agreementVersion || "unknown"}`,
      );
    }
    return;
  }
  if (data.application) {
    console.log(
      `Sponsor application #${data.application.id}: ${String(data.application.status).toUpperCase()} · ${data.application.username || `user ${data.application.userId}`}`,
    );
    return;
  }
  if (data.sponsor) {
    console.log(
      `Sponsor ${data.sponsor.username || `user ${data.sponsor.userId}`}: ${String(data.sponsor.status).toUpperCase()}.`,
    );
    return;
  }
  if (data.scan) {
    const scan = data.scan;
    console.log(
      `Sponsor-integrity scan #${scan.id || "not started"}: ${scan.status || "not started"} · ${scan.scannedCount || 0} scanned · ${scan.selectedReviewCount || 0} selected · ${data.openCaseCount || 0} open.`,
    );
    if (Array.isArray(data.casesCreated) && data.casesCreated.length > 0) {
      console.log(
        `Created ${data.casesCreated.length} review case(s) on this page.`,
      );
    }
    return;
  }
  if (Array.isArray(data.cases)) {
    console.log(`${data.cases.length} sponsor-integrity case(s):`);
    for (const item of data.cases) {
      const flags =
        Array.isArray(item.hardFlags) && item.hardFlags.length
          ? ` · flags=${item.hardFlags.join(",")}`
          : "";
      console.log(
        `  #${item.id} ${String(item.status).toUpperCase()} · job #${item.jobId} · ${item.sponsorUsername || `sponsor ${item.sponsorUserId}`}${flags}`,
      );
    }
    return;
  }
  if (data.case) {
    const item = data.case;
    console.log(
      `Sponsor-integrity case #${item.id}: ${String(item.status).toUpperCase()} · job #${item.job?.id} · ${item.sponsorUsername || `sponsor ${item.sponsorUserId}`}.`,
    );
    const relays =
      Array.isArray(item.relays) && item.relays.length > 0
        ? item.relays
        : item.relay
          ? [item.relay]
          : [];
    console.log(
      `Relays: ${relays.map((relay) => `${relay.kind || "initial_request"}: ${relay.summary || "(missing)"}`).join(" | ") || "(missing)"}`,
    );
    console.log(
      `Provenance: ${(item.agents || []).map((agent) => `${agent.role}:${agent.provider}:${agent.resolvedModel || "unresolved"}:${agent.resolvedEffort || "unresolved"}`).join(" · ") || "missing"}`,
    );
    console.log(
      `Artifact files: ${(item.artifactFiles || []).map((file) => file.path).join(", ") || "none"}`,
    );
    return;
  }
  if (data.caseId) {
    console.log(
      `Sponsor-integrity case #${data.caseId}: ${data.decision}${data.scanCompleted ? "; scan complete" : ""}.`,
    );
    return;
  }
  if (data.review) {
    console.log(
      `Confirmed Build #${data.review.buildId} runtime at published artifact #${data.review.publishedArtifactVersionId}.`,
    );
    console.log(`Screenshot: ${data.screenshotPath}`);
    console.log(`Review receipt: ${data.receiptPath}`);
    return;
  }
  if (data.monthlyAiCosts) {
    printAdminMonthlyAiCosts(data.monthlyAiCosts);
    return;
  }
  if (data.monthlyMediaCosts) {
    printAdminMonthlyMediaCosts(data.monthlyMediaCosts);
    return;
  }
  if (data.validation) {
    console.log(
      `Editorial valid for edition #${data.validation.editionId}: ${data.validation.citedEventCount} cited and ${data.validation.coveredEventCount} covered event(s).`,
    );
    return;
  }
  if (data.batch) {
    console.log(
      `Skipped ${data.batch.completedCount} audited target(s); ${data.batch.changedCount} changed canonical state.`,
    );
    console.log(`Checkpoint: ${data.batch.checkpointPath}`);
    return;
  }
  if (data.report) {
    const report = data.report;
    console.log(
      `Run #${report.run.id}: ${report.mutations.successfulMutationCount} successful mutation(s), ${report.queueCoverage.length} queue coverage record(s), ${report.escalations.length} escalation(s), ${report.carryoverTodos?.count || 0} unfinished todo(s).`,
    );
    for (const coverage of report.queueCoverage) {
      console.log(
        `  ${coverage.queue}: ${coverage.candidateCount} candidate(s), ${coverage.scannedCount} row(s) scanned across ${coverage.pages} page(s).`,
      );
    }
    for (const escalation of report.escalations) {
      const target =
        escalation.url ||
        `${escalation.targetType || "target"}:${escalation.targetId || "?"}`;
      console.log(
        `  ${String(escalation.severity || "attention").toUpperCase()} ${target} — ${escalation.summary}`,
      );
    }
    printTodoItems(report.carryoverTodos?.items || [], "Unfinished work");
    if (report.sponsorIntegrity) {
      console.log(
        `Sponsor integrity: ${report.sponsorIntegrity.scan?.status || "not started"}; ${report.sponsorIntegrity.cases?.open || 0} open case(s); ${report.sponsorIntegrity.pendingApplications || 0} pending application(s).`,
      );
    }
    const surfaces = report.brief?.engagementPulse?.surfaces;
    if (surfaces && typeof surfaces === "object") {
      const deltas = Object.entries(surfaces)
        .filter(([, value]) => Number(value?.delta || 0) !== 0)
        .sort(
          ([, left], [, right]) =>
            Math.abs(Number(right?.delta || 0)) -
            Math.abs(Number(left?.delta || 0)),
        )
        .slice(0, 5)
        .map(
          ([name, value]) =>
            `${name} ${Number(value.delta) > 0 ? "+" : ""}${Number(value.delta)}`,
        );
      if (deltas.length)
        console.log(`Engagement deltas: ${deltas.join(", ")}.`);
    }
    const notableCount = Array.isArray(report.brief?.notableCandidates)
      ? report.brief.notableCandidates.length
      : 0;
    console.log(`Notable-user candidates in this brief: ${notableCount}.`);
    return;
  }
  if (data.inspection) {
    const inspection = data.inspection;
    console.log(
      `Identity inspection for user #${inspection.targetUserId}: ${inspection.accounts?.length || 0} candidate account(s); oldest #${inspection.oldestAccount?.userId || "unknown"}.`,
    );
    if (inspection.manualBucket) {
      console.log(
        `AI bucket #${inspection.manualBucket.id} (${inspection.manualBucket.label}); ${inspection.manualBucket.memberCount} canonical member(s).`,
      );
    }
    for (const account of inspection.accounts || []) {
      console.log(
        `  #${account.userId} ${account.username || "(no username)"} — joined ${account.joinedAt || "unknown"}; ${account.relationBasis.join(", ") || "no relation evidence"}${account.hasDateOfBirth ? "; DOB on file" : "; no DOB on file"}.`,
      );
      if (account.privateEvidence) {
        console.log(
          `    Private evidence: DOB ${account.privateEvidence.dateOfBirth || "none"}; verified email(s) ${account.privateEvidence.verifiedEmails.join(", ") || "none"}.`,
        );
      }
    }
    return;
  }
  if (Array.isArray(data.escalations)) {
    console.log(`${data.escalations.length} escalation(s):`);
    for (const escalation of data.escalations) {
      const target =
        escalation.url ||
        `${escalation.targetType || "target"}:${escalation.targetId || "?"}`;
      console.log(
        `  #${escalation.auditId} ${String(escalation.status || "open").toUpperCase()} ${target} — ${escalation.summary}`,
      );
      if (escalation.decisionNote) {
        console.log(`    Decision: ${escalation.decisionNote}`);
      }
    }
    if (data.truncated) {
      console.log(
        "More matching escalations exist than the requested limit; raise --limit or narrow --status.",
      );
    }
    return;
  }
  if (data.escalation?.decisionNote) {
    console.log(
      `Escalation #${data.escalation.auditId}: ${String(data.escalation.status).toUpperCase()} — ${data.escalation.decisionNote}`,
    );
    return;
  }
  if (Array.isArray(data.todos)) {
    printTodoItems(data.todos, "Private carry-over work");
    if (data.truncated) {
      console.log(
        "More matching todos exist than the requested limit; raise --limit or narrow --status.",
      );
    }
    return;
  }
  if (data.todo) {
    printTodoItems([data.todo], "Canonical todo");
    return;
  }
  if (data.bucket && Array.isArray(data.memberUserIds)) {
    const added = Array.isArray(data.accounts)
      ? `; added ${data.accounts.length} explicit account(s)`
      : "";
    console.log(
      `AI bucket #${data.bucket.id} (${data.bucket.label}): ${data.memberCount} canonical member account(s)${added}.`,
    );
    return;
  }
  if (data.run !== undefined) {
    if (!data.run) {
      console.log("No active delegated administrator daily run.");
      if (data.lastRun) {
        console.log(
          `Last run #${data.lastRun.id}: ${data.lastRun.status}; identity ${data.lastRun.identity.key}; comments ${data.lastRun.commentMode}.`,
        );
      }
      return;
    }
    console.log(
      `Run #${data.run.id}: ${data.run.status}; identity ${data.run.identity.key}; comments ${data.run.commentMode}.`,
    );
    if (data.scheduledDay && data.scheduledIdentity) {
      console.log(
        `Bangkok schedule for ${data.scheduledDay}: ${data.scheduledIdentity.key}.`,
      );
    }
    if (data.carryoverTodos) {
      printTodoItems(data.carryoverTodos.items || [], "Carry-over work");
    }
    return;
  }
  if (Array.isArray(data.identities)) {
    console.log(
      `Approved identities: ${data.identities.map((v) => v.key).join(", ")}.`,
    );
    console.log(`Preferred: ${data.preferredIdentity}.`);
    return;
  }
  if (Object.hasOwn(data, "activeRun")) {
    console.log(`Preferred identity: ${data.preferredIdentity}.`);
    if (data.scheduledDay && data.scheduledIdentity) {
      console.log(
        `Bangkok schedule for ${data.scheduledDay}: ${data.scheduledIdentity.key}.`,
      );
    }
    console.log(
      `Last completed identity: ${data.lastCompletedIdentity || "none"}.`,
    );
    console.log(
      data.activeRun
        ? `Active run #${data.activeRun.id}: ${data.activeRun.identity.key}; comments ${data.activeRun.commentMode}.`
        : "No active delegated administrator daily run.",
    );
    return;
  }
  if (Array.isArray(data.subjects)) {
    console.log(`${data.subjects.length} subject(s):`);
    for (const subject of data.subjects) {
      console.log(
        `#${subject.id} ${subject.title || "(untitled)"} — ${subject.author?.username || "unknown"} — effort ${subject.effortLevel ?? "unknown"}`,
      );
      console.log(`  ${subject.url}`);
    }
    printPagination(data.pagination);
    return;
  }
  if (Array.isArray(data.events)) {
    console.log(`${data.events.length} audit event(s):`);
    for (const event of data.events) {
      const target =
        event.targetType && event.targetId
          ? ` ${event.targetType}:${event.targetId}`
          : "";
      console.log(
        `#${event.id} run ${event.runId ?? "-"} ${event.action}${target} — ${event.result}${event.changed === true ? " (changed)" : event.changed === false ? " (no change)" : ""}`,
      );
    }
    printPagination(data.pagination);
    return;
  }
  if (data.claim) {
    if (data.artifacts?.claimFile) {
      console.log(
        `Claimed edition #${data.claim.editionId} (${data.claim.dateKey}): ${data.claim.events.length} event(s).`,
      );
      console.log(`Claim file: ${data.artifacts.claimFile}`);
      if (data.artifacts?.scaffoldFile) {
        console.log(`Editorial scaffold: ${data.artifacts.scaffoldFile}`);
      }
      console.log(
        `Validate before submission: lumine admin news validate --claim ${data.artifacts.claimFile} --file ${data.artifacts.scaffoldFile || "editorial.json"}`,
      );
      console.log(
        `Submit the confirmed pair: lumine admin news submit --claim ${data.artifacts.claimFile} --file ${data.artifacts.scaffoldFile || "editorial.json"}`,
      );
    } else {
      console.log(
        `Claimed edition #${data.claim.editionId} (${data.claim.dateKey}): ${data.claim.events.length} event(s); lease token ${data.claim.leaseToken}.`,
      );
      console.log(
        `Write the editorial JSON, then run: lumine admin news submit --edition-id ${data.claim.editionId} --lease-token ${data.claim.leaseToken} --file editorial.json`,
      );
    }
    return;
  }
  if (data.newspaper) {
    const paper = data.newspaper;
    if (paper.printedToday) {
      const printed = paper.latestPrinted || {};
      console.log(
        `Newspaper ${paper.dateKey}: printed (revision ${printed.revisionNumber || 1}, ${printed.sourceEventCount ?? 0} sources).`,
      );
    } else {
      console.log(
        `Newspaper ${paper.dateKey}: not printed (${paper.generationStatus}).`,
      );
    }
    if (paper.requestedAction && paper.requestedAction !== "none") {
      console.log(
        `${paper.requestedAction === "retry" ? "Queued a retry of" : "Queued"} today's edition; the press typesets it within about a minute. Re-check with: lumine admin news`,
      );
    } else if (
      !paper.printedToday &&
      ["pending", "generating"].includes(paper.generationStatus)
    ) {
      console.log(
        "An edition is being typeset now. Re-check with: lumine admin news",
      );
    }
    if (paper.failureMessage && !paper.printedToday) {
      console.log(`Last attempt failed: ${paper.failureMessage}`);
    }
    return;
  }
  if (data.notableUser) {
    console.log(
      `${result.status || "success"}: ${data.notableUser.username || "unknown"} (#${data.notableUser.userId}).`,
    );
    return;
  }
  if (data.skip) {
    console.log(
      `${result.status}: ${data.skip.contentType}:${data.skip.contentId} skipped.`,
    );
    if (data.skip.url) console.log(data.skip.url);
    return;
  }
  if (Array.isArray(data.items)) {
    console.log(`${data.items.length} recommendation candidate(s):`);
    for (const item of data.items) {
      console.log(`#${item.contentId} ${item.contentType}`);
      if (item.url || item.subjectUrl)
        console.log(`  ${item.url || item.subjectUrl}`);
    }
    printPagination(data.pagination);
    return;
  }
  if (Array.isArray(data.comments)) {
    console.log(`${data.comments.length} comment(s) for ${data.subject?.url}:`);
    for (const comment of data.comments) {
      console.log(
        `#${comment.id} ${comment.author?.username || "unknown"}: ${comment.content || "(empty)"}`,
      );
    }
    printPagination(data.pagination);
    return;
  }
  if (data.published) {
    console.log(
      `${result.status || "success"}: comment #${data.published.commentId}.`,
    );
    console.log(data.published.commentUrl || data.published.subjectUrl);
    return;
  }
  if (data.draft) {
    console.log(
      `Draft #${data.draft.id}: ${data.draft.decision} (${data.draft.status}).`,
    );
    if (data.draft.content) console.log(data.draft.content);
    const draftUrl = data.draft.targetUrl || data.draft.subjectUrl;
    if (draftUrl) console.log(draftUrl);
    return;
  }
  if (data.subject) {
    if (data.pairing) {
      console.log(
        `${result.status}: recommendation #${data.pairing.recommendationId}; reward ${data.pairing.rewardStatus}.`,
      );
    } else if (data.rewardOperation) {
      console.log(
        `${result.status}: reward ${data.rewardOperation.status || "confirmed"}.`,
      );
    } else if (data.reveal) {
      console.log(`${result.status}: ${data.reveal.status}.`);
    }
    console.log(`#${data.subject.id} ${data.subject.title || "(untitled)"}`);
    console.log(data.subject.url);
    return;
  }
  if (data.comment) {
    if (data.pairing) {
      console.log(
        `${result.status}: recommendation #${data.pairing.recommendationId}; reward ${data.pairing.rewardStatus}.`,
      );
    } else if (data.rewardOperation) {
      console.log(
        `${result.status}: reward ${data.rewardOperation.status || "confirmed"}.`,
      );
    }
    console.log(
      `#${data.comment.id} by ${data.comment.author?.username || "unknown"}`,
    );
    if (data.comment.subjectUrl) console.log(data.comment.subjectUrl);
    if (data.comment.content) console.log(data.comment.content);
    return;
  }
  console.log(
    `${result.status || "success"}${result.changed === false ? " (no change)" : ""}.`,
  );
}

function printTodoItems(items, heading) {
  console.log(`${heading}: ${items.length} item(s).`);
  for (const todo of items) {
    console.log(
      `  #${todo.id} ${String(todo.status || "open").toUpperCase()} ${todo.kind || "task"} — ${todo.title || "(untitled)"}`,
    );
    if (todo.details) console.log(`    ${todo.details}`);
    if (todo.lastProgressNote) {
      console.log(`    Latest progress: ${todo.lastProgressNote}`);
    }
  }
}

function printPagination(pagination) {
  if (!pagination) return;
  console.log(
    pagination.exhausted
      ? "End of canonical snapshot."
      : `Next cursor: ${pagination.nextCursor}`,
  );
}
