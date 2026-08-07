import { randomUUID } from "node:crypto";
import { assertAuthScope, resolveAuth } from "./auth.js";
import { requestJson } from "./http.js";

export async function adminCommand(options) {
  const operation = parseAdminOperation(options);
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
  if (adminOperationRequiresRun(operation)) {
    const runStatus = await requestJson({
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
    if (!runId) throw noActiveRunError();
    if (options.adminIdentity) {
      const requestedIdentity = parseIdentity(options.adminIdentity);
      if (
        requestedIdentity !== "auto" &&
        requestedIdentity !== selectedRun?.identity?.key
      ) {
        throw cliValidationError(
          `--identity ${requestedIdentity} does not match active run #${runId} (${selectedRun?.identity?.key || "unknown"}).`,
        );
      }
    }
  }
  const requestId =
    options.idempotencyKey || (operation.mutates ? `cli:${randomUUID()}` : "");
  let result;
  try {
    result = await requestJson({
      method: operation.method,
      url: `${options.apiUrl}${operation.path}`,
      authToken: auth.token,
      body: operation.body,
      headers: {
        ...(runId ? { "x-lumine-admin-run-id": String(runId) } : {}),
        ...(requestId ? { "x-lumine-idempotency-key": requestId } : {}),
      },
      timeoutMs: options.timeoutMs,
    });
    if (recommendationContentTypes) {
      result = filterRecommendationQueueResult({
        result,
        contentTypes: recommendationContentTypes,
      });
    }
  } catch (error) {
    if (operation.mutates && requestId) {
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
  if (options.json) {
    console.log(JSON.stringify(result));
    return result;
  }
  printAdminResult({ operation, result });
  return result;
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

function adminOperationRequiresRun(operation) {
  return ![
    "identity.list",
    "identity.status",
    "identity.use",
    "daily-run.start",
    "daily-run.status",
  ].includes(operation.name);
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
    if (action === "complete" || action === "fail") {
      return writeOperation(
        `daily-run.${action}`,
        "POST",
        `/cli/admin/daily-runs/${action}`,
        action === "fail" ? { reason: options.adminReason || undefined } : {},
      );
    }
  }

  if (
    (namespace === "recommend-queue" && (!action || action === "list")) ||
    (namespace === "recommendations" && action === "list")
  ) {
    const kind = String(options.adminKind || "recommend").toLowerCase();
    if (kind !== "recommend") {
      throw cliValidationError("--kind currently supports only recommend.");
    }
    return readOperation(
      "recommendations.list",
      withQuery("/cli/admin/recommendations", {
        kind,
        contentTypes: options.adminContentTypes,
        cursor: options.adminCursor,
        limit: options.limit,
      }),
    );
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
    return readOperation("comments.get", `/cli/admin/comments/${commentId}`);
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
    );
  }

  if (namespace === "comment") {
    if (action === "draft" || action === "reply") {
      const parsedTarget = parseRecommendationTarget({
        target,
        explicitType: options.adminType,
      });
      if (action === "reply" && parsedTarget.type !== "comment") {
        throw cliValidationError(
          "comment reply targets a comment: lumine admin comment reply comment:<id>.",
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
    "Usage: lumine admin identity|daily-run|recommendations|post|subjects|subject|featured|comment|audit ...",
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
    return readOperation("post.get", `/cli/admin/comments/${parsedTarget.id}`);
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

function readOperation(name, path) {
  return { name, method: "GET", path, body: undefined, mutates: false };
}

function writeOperation(name, method, path, body) {
  return { name, method, path, body, mutates: true };
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

function printAdminResult({ operation, result }) {
  const data = result?.data || {};
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

function printPagination(pagination) {
  if (!pagination) return;
  console.log(
    pagination.exhausted
      ? "End of canonical snapshot."
      : `Next cursor: ${pagination.nextCursor}`,
  );
}
