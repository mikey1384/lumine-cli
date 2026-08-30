import { requestJson } from "./http.js";
import { sleep } from "./util.js";

const FORUM_SCOPE_MODES = new Set(["all", "branch", "main"]);
const FORUM_EVENT_TYPES = new Set(["thread", "reply"]);
const MAX_FORUM_SNAPSHOT_PAGES = 100_000;

function forumProtocolError(message) {
  const error = new Error(`Invalid Forum response: ${message}`);
  error.code = "lumine_forum_protocol_error";
  error.retryable = false;
  return error;
}

function normalizeForumSequence(value, label) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw forumProtocolError(`${label} must be a non-negative safe integer`);
  }
  return sequence;
}

function normalizePositiveForumId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw forumProtocolError(`${label} must be a positive safe integer`);
  }
  return id;
}

export function buildForumScopeKey(scope) {
  const mode = String(scope?.mode || "");
  if (!FORUM_SCOPE_MODES.has(mode)) {
    throw forumProtocolError("scope.mode is not recognized");
  }
  const rootBuildId = normalizePositiveForumId(
    scope?.rootBuildId,
    "scope.rootBuildId",
  );
  const workspaceBuildId = normalizePositiveForumId(
    scope?.workspaceBuildId,
    "scope.workspaceBuildId",
  );
  const contributionBuildId = scope?.contributionBuildId
    ? normalizePositiveForumId(
        scope.contributionBuildId,
        "scope.contributionBuildId",
      )
    : 0;
  if (mode === "branch" && contributionBuildId !== workspaceBuildId) {
    throw forumProtocolError(
      "branch scope does not match its contribution workspace",
    );
  }
  if (mode !== "branch" && contributionBuildId !== 0) {
    throw forumProtocolError("non-branch scope has a contribution build");
  }
  return `${mode}:${rootBuildId}:${workspaceBuildId}:${contributionBuildId}`;
}

export async function loadBuildForumPage({
  options,
  auth,
  buildId,
  afterActivitySeq,
  snapshotActivitySeq,
  limit,
}) {
  const url = new URL(`${options.apiUrl}/cli/build/${buildId}/forum`);
  url.searchParams.set("afterActivitySeq", String(afterActivitySeq));
  if (snapshotActivitySeq > 0) {
    url.searchParams.set("snapshotActivitySeq", String(snapshotActivitySeq));
  }
  url.searchParams.set("limit", String(limit));
  return await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

function validateForumPage({
  page,
  buildId,
  pageCursor,
  snapshotActivitySeq,
  expectedScopeKey,
}) {
  const projectId = normalizePositiveForumId(page?.project?.id, "project.id");
  const requestedBuildId = normalizePositiveForumId(
    page?.requestedBuildId,
    "requestedBuildId",
  );
  if (requestedBuildId !== buildId) {
    throw forumProtocolError("requestedBuildId changed during the read");
  }
  const scopeKey = buildForumScopeKey(page?.scope);
  if (Number(page?.scope?.rootBuildId) !== projectId) {
    throw forumProtocolError("project.id does not match scope.rootBuildId");
  }
  if (expectedScopeKey && scopeKey !== expectedScopeKey) {
    throw forumProtocolError(
      "the authorized Forum workspace changed; restart the listener",
    );
  }

  const pageSnapshotActivitySeq = normalizeForumSequence(
    page?.pagination?.snapshotActivitySeq,
    "pagination.snapshotActivitySeq",
  );
  if (
    snapshotActivitySeq > 0 &&
    pageSnapshotActivitySeq !== snapshotActivitySeq
  ) {
    throw forumProtocolError("snapshotActivitySeq changed between pages");
  }
  if (pageSnapshotActivitySeq < pageCursor) {
    throw forumProtocolError("snapshotActivitySeq precedes the page cursor");
  }

  const events = Array.isArray(page?.events) ? page.events : null;
  if (!events) throw forumProtocolError("events is not an array");
  const pageLimit = Number(page?.pagination?.limit);
  if (
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > 100 ||
    events.length > pageLimit
  ) {
    throw forumProtocolError("pagination.limit does not bound the page");
  }
  let lastActivitySeq = pageCursor;
  for (const event of events) {
    if (!FORUM_EVENT_TYPES.has(String(event?.type || ""))) {
      throw forumProtocolError("event.type is not recognized");
    }
    normalizePositiveForumId(event?.id, "event.id");
    normalizePositiveForumId(event?.threadId, "event.threadId");
    const activitySeq = normalizeForumSequence(
      event?.activitySeq,
      "event.activitySeq",
    );
    if (
      activitySeq <= lastActivitySeq ||
      activitySeq > pageSnapshotActivitySeq
    ) {
      throw forumProtocolError(
        "events are not strictly ordered inside the snapshot",
      );
    }
    lastActivitySeq = activitySeq;
  }

  if (typeof page?.pagination?.hasMore !== "boolean") {
    throw forumProtocolError("pagination.hasMore is not boolean");
  }
  const nextActivitySeq = normalizeForumSequence(
    page?.pagination?.nextActivitySeq,
    "pagination.nextActivitySeq",
  );
  if (page.pagination.hasMore) {
    if (
      events.length === 0 ||
      nextActivitySeq !== lastActivitySeq ||
      nextActivitySeq <= pageCursor ||
      nextActivitySeq >= pageSnapshotActivitySeq
    ) {
      throw forumProtocolError("the next Forum page cursor is not progressive");
    }
  } else if (nextActivitySeq !== pageSnapshotActivitySeq) {
    throw forumProtocolError(
      "the final Forum page did not confirm the full snapshot cursor",
    );
  }

  return {
    events,
    nextActivitySeq,
    pageSnapshotActivitySeq,
    scopeKey,
  };
}

export async function readCompleteBuildForumSnapshot({
  options,
  auth,
  buildId,
  afterActivitySeq = 0,
  expectedScopeKey = "",
  loadPage = loadBuildForumPage,
  maxPages = MAX_FORUM_SNAPSHOT_PAGES,
}) {
  const normalizedBuildId = normalizePositiveForumId(buildId, "buildId");
  const startingActivitySeq = normalizeForumSequence(
    afterActivitySeq,
    "afterActivitySeq",
  );
  let pageCursor = startingActivitySeq;
  let snapshotActivitySeq = 0;
  let scopeKey = expectedScopeKey;
  let firstPage = null;
  const events = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const page = await loadPage({
      options,
      auth,
      buildId: normalizedBuildId,
      afterActivitySeq: pageCursor,
      snapshotActivitySeq,
      limit: options.limit,
    });
    const validated = validateForumPage({
      page,
      buildId: normalizedBuildId,
      pageCursor,
      snapshotActivitySeq,
      expectedScopeKey: scopeKey,
    });
    if (!firstPage) firstPage = page;
    if (!scopeKey) scopeKey = validated.scopeKey;
    snapshotActivitySeq = validated.pageSnapshotActivitySeq;
    events.push(...validated.events);
    pageCursor = validated.nextActivitySeq;
    if (!page.pagination.hasMore) {
      return {
        project: firstPage.project,
        requestedBuildId: normalizedBuildId,
        scope: firstPage.scope,
        events,
        pagination: {
          fromActivitySeq: startingActivitySeq,
          snapshotActivitySeq,
          nextActivitySeq: pageCursor,
          hasMore: false,
        },
        scopeKey,
      };
    }
  }

  throw forumProtocolError("snapshot exceeded the safe pagination bound");
}

export function isRetryableForumListenerError(error) {
  if (error?.retryable === false) return false;
  const status = Number(error?.status || 0);
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function formatForumTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown time";
  return new Date(timestamp * 1000).toISOString();
}

function formatForumLocation(event) {
  if (!event?.branch) return "Main";
  const branchNumber = Number(event.branch.number || 0);
  return branchNumber > 0
    ? `Branch #${branchNumber}`
    : `Branch build #${event.branch.id}`;
}

function sanitizeForumTerminalText(value) {
  // Forum text is user-authored. Preserve canonical content in JSON output,
  // but prevent control, escape, carriage-return, and bidi override bytes from
  // driving or visually rewriting a human reader's terminal.
  return String(value || "").replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

function printIndented(value) {
  for (const line of sanitizeForumTerminalText(value).split("\n")) {
    console.log(`    ${line}`);
  }
}

export function printBuildForumSnapshot(snapshot, { json, kind }) {
  const output = {
    type: kind,
    project: snapshot.project,
    requestedBuildId: snapshot.requestedBuildId,
    scope: snapshot.scope,
    events: snapshot.events,
    cursor: {
      fromActivitySeq: snapshot.pagination.fromActivitySeq,
      throughActivitySeq: snapshot.pagination.nextActivitySeq,
    },
  };
  if (json) {
    console.log(JSON.stringify(output));
    return;
  }

  const projectTitle =
    sanitizeForumTerminalText(snapshot.project?.title).trim() ||
    `Build #${snapshot.project?.id || snapshot.requestedBuildId}`;
  console.log(`${projectTitle} — Team Forum`);
  if (snapshot.events.length === 0) {
    console.log("No new visible Forum posts or replies.");
    return;
  }
  for (const event of snapshot.events) {
    const author =
      sanitizeForumTerminalText(event?.author?.username).trim() ||
      (event?.author?.role === "lumine" ? "Lumine" : "unknown user");
    const action = event.type === "reply" ? "replied in" : "opened";
    console.log(
      `${formatForumTimestamp(event.createdAt)}  ${formatForumLocation(event)}  ${author} ${action} #${event.threadId} “${sanitizeForumTerminalText(event.threadTitle)}”`,
    );
    if (event.replyTo) {
      const target =
        sanitizeForumTerminalText(event.replyTo.username).trim() ||
        `reply #${event.replyTo.replyId}`;
      console.log(`    ↳ replying to ${target}`);
    }
    printIndented(event.body);
  }
}

export async function runBuildForumCommand({ options, auth, buildId }) {
  const listen = options.forumAction === "listen";
  let cursor = options.forumCursor;
  let scopeKey = "";
  let firstSnapshot = true;
  let consecutiveFailures = 0;

  while (true) {
    let snapshot;
    try {
      snapshot = await readCompleteBuildForumSnapshot({
        options,
        auth,
        buildId,
        afterActivitySeq: cursor,
        expectedScopeKey: scopeKey,
      });
    } catch (error) {
      if (!listen || !isRetryableForumListenerError(error)) throw error;
      consecutiveFailures += 1;
      const retryDelayMs = Math.min(
        options.forumPollMs * 2 ** Math.min(consecutiveFailures - 1, 4),
        30_000,
      );
      console.error(
        `Forum listener temporarily lost contact (${error?.message || error}). Retrying from confirmed cursor ${cursor} in ${retryDelayMs}ms.`,
      );
      await sleep(retryDelayMs);
      continue;
    }

    if (firstSnapshot || snapshot.events.length > 0) {
      printBuildForumSnapshot(snapshot, {
        json: options.json,
        kind: firstSnapshot ? "forum.snapshot" : "forum.update",
      });
    }
    cursor = snapshot.pagination.nextActivitySeq;
    scopeKey = snapshot.scopeKey;
    if (!listen) return;

    if (firstSnapshot) {
      console.error(
        `Listening for canonical Forum updates from cursor ${cursor}. Press Ctrl-C to stop.`,
      );
    }
    firstSnapshot = false;
    consecutiveFailures = 0;
    await sleep(options.forumPollMs);
  }
}
