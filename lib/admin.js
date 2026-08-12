import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertAuthScope, resolveAuth } from "./auth.js";
import { requestJson } from "./http.js";

const MAX_EDITORIAL_FILE_BYTES = 256 * 1024;
const MAX_COMPOSED_COMMENT_FILE_BYTES = 64 * 1024;
const MAX_COMPOSED_COMMENT_LENGTH = 10_000;
const MAX_NOTABLE_NOTE_LENGTH = 2_000;

// Operator-composed persona comment text (plain UTF-8, not JSON). The agent
// writes the comment in the bot's persona itself; the server never invokes
// its model and no AI Energy is spent.
function readComposedCommentFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError(
      "Pass composed comment text with --file <comment.md>.",
    );
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_COMPOSED_COMMENT_FILE_BYTES) {
    throw cliValidationError("The composed comment file must be under 64KB.");
  }
  const normalized = contents.trim();
  if (!normalized) {
    throw cliValidationError(
      `${normalizedPath} is empty; a composed comment needs text.`,
    );
  }
  if (normalized.length > MAX_COMPOSED_COMMENT_LENGTH) {
    throw cliValidationError(
      `A composed comment must be at most ${MAX_COMPOSED_COMMENT_LENGTH} characters.`,
    );
  }
  return normalized;
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
    if (viewFilter) {
      result = filterListResultByOperatorView({ result, viewFilter });
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
  if (
    operation.name === "comment.draft" &&
    typeof operation.body?.content === "string"
  ) {
    assertComposedCommentDraftResult({
      result,
      expectedContent: operation.body.content,
    });
  }
  if (options.json) {
    console.log(JSON.stringify(result));
    return result;
  }
  printAdminResult({ operation, result });
  return result;
}

export function assertComposedCommentDraftResult({ result, expectedContent }) {
  const draft = result?.data?.draft;
  if (
    draft?.decision === "draft" &&
    draft?.reason === "operator-composed" &&
    draft?.content === expectedContent &&
    draft?.status === "ready"
  ) {
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
      "daily-run.start",
      "daily-run.status",
    ].includes(operation.name) && !operation.name.startsWith("ai-bucket.")
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

  if (namespace === "ai-bucket" || namespace === "ai-buckets") {
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
    if (action === "submit") {
      const editionId = parseRequiredInteger(
        options.adminEditionId,
        "--edition-id",
        1,
      );
      const leaseToken = String(options.adminLeaseToken || "").trim();
      if (!leaseToken) {
        throw cliValidationError(
          "Pass the claim's lease token with --lease-token <token>.",
        );
      }
      return writeOperation("news.submit", "POST", "/cli/admin/news/submit", {
        editionId,
        leaseToken,
        editorial: readEditorialFile(options.adminFile),
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
      content: readComposedCommentFile(options.adminFile),
    });
  }

  if (namespace === "bot-output" && !action) {
    if (options.adminDays !== undefined) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw cliValidationError("--days must be an integer between 1 and 30.");
      }
    }
    return readOperation(
      "bot.output",
      withQuery("/cli/admin/bot-output", { days: options.adminDays }),
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
          ...(options.adminFile
            ? { content: readComposedCommentFile(options.adminFile) }
            : {}),
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
        { content: readComposedCommentFile(options.adminFile) },
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
    "Usage: lumine admin identity|daily-run|recommendations|post|subjects|subject|featured|comment|chat|news|audit|brief|bot-output|notable ...",
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
  if (data.claim) {
    console.log(
      `Claimed edition #${data.claim.editionId} (${data.claim.dateKey}): ${data.claim.events.length} event(s); lease token ${data.claim.leaseToken}.`,
    );
    console.log(
      `Write the editorial JSON, then run: lumine admin news submit --edition-id ${data.claim.editionId} --lease-token ${data.claim.leaseToken} --file editorial.json`,
    );
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

function printPagination(pagination) {
  if (!pagination) return;
  console.log(
    pagination.exhausted
      ? "End of canonical snapshot."
      : `Next cursor: ${pagination.nextCursor}`,
  );
}
