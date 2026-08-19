import path from "path";

import { ensureAuth, assertAuthScope } from "./auth.js";
import { mintBuildApiToken } from "./api.js";
import { request } from "./http.js";
import { parseJson, resolveBuildId } from "./util.js";
import { findLocalProjectMetadata } from "./workspace.js";

// Build SDK data-API methods callable from the CLI. Method names match the
// SDK manifest (constants/buildSdkIndex.json in twinkle-api); paths are the
// HTTP endpoints the Build runtime parent proxies those methods to. The args
// JSON object is sent verbatim as the POST body, so arg shapes follow
// TWINKLE_BUILD_SDK.md. Methods that mutate data require --allow-write.
// Anything not listed can be called with --path api/<endpoint>.
export const SDK_CLI_METHODS = {
  "aiStories.list": { path: "api/content/ai-stories/list", scopes: ["content:read"] },
  "aiStories.chapters": { path: "api/content/ai-stories/chapters", scopes: ["content:read"] },
  "aiStories.search": { path: "api/content/ai-stories/search", scopes: ["content:read"] },
  "aiStories.get": { path: "api/content/ai-story", scopes: ["content:read"] },
  "aiCards.list": { path: "api/content/ai-cards/list", scopes: ["content:read"] },
  "aiCards.search": { path: "api/content/ai-cards/search", scopes: ["content:read"] },
  "aiCards.get": { path: "api/content/ai-card", scopes: ["content:read"] },
  "grammarbles.listQuestions": { path: "api/content/grammarbles/questions", scopes: ["content:read"] },
  "grammarbles.getMyQuestionHistory": { path: "api/content/grammarbles/history", scopes: ["content:read"] },
  "subjects.getMySubjects": { path: "api/content/my-subjects", scopes: ["content:read"] },
  "subjects.search": { path: "api/content/subjects/search", scopes: ["content:read"] },
  "subjects.getSubject": { path: "api/content/subject", scopes: ["content:read"] },
  "subjects.getSubjectComments": { path: "api/content/subject-comments", scopes: ["content:read"] },
  "subjectComments.list": { path: "api/content/subject-comment-list", scopes: ["content:read"] },
  "profileComments.getProfileComments": { path: "api/content/profile-comments", scopes: ["content:read"] },
  "profileComments.getProfileCommentIds": { path: "api/content/profile-comment-ids", scopes: ["content:read"] },
  "profileComments.getCommentsByIds": { path: "api/content/profile-comments-by-ids", scopes: ["content:read"] },
  "profileComments.getProfileCommentCounts": { path: "api/content/profile-comment-counts", scopes: ["content:read"] },
  "privateDb.get": { path: "api/private-db/get", scopes: ["privateDb:read"] },
  "privateDb.list": { path: "api/private-db/list", scopes: ["privateDb:read"] },
  "privateDb.set": { path: "api/private-db/set", scopes: ["privateDb:write"], write: true },
  "privateDb.remove": { path: "api/private-db/delete", scopes: ["privateDb:write"], write: true },
  "sharedDb.getTopics": { path: "api/shared-db/topics", scopes: ["sharedDb:read"] },
  "sharedDb.createTopic": { path: "api/shared-db/topic", scopes: ["sharedDb:write"], write: true },
  "sharedDb.getEntries": { path: "api/shared-db/entries", scopes: ["sharedDb:read"] },
  "sharedDb.getEntriesByIds": { path: "api/shared-db/entries/by-ids", scopes: ["sharedDb:read"] },
  "sharedDb.addEntry": { path: "api/shared-db/entry", scopes: ["sharedDb:write"], write: true },
  "sharedDb.addEntries": { path: "api/shared-db/entries/batch", scopes: ["sharedDb:write"], write: true },
  "sharedDb.updateEntry": { path: "api/shared-db/entry/update", scopes: ["sharedDb:write"], write: true },
  "sharedDb.deleteEntry": { path: "api/shared-db/entry/delete", scopes: ["sharedDb:write"], write: true },
  "sharedDb.deleteEntries": { path: "api/shared-db/entries/delete", scopes: ["sharedDb:write"], write: true },
  "sharedDb.kv.get": { path: "api/shared-db/kv/get", scopes: ["sharedDb:read"] },
  "sharedDb.kv.list": { path: "api/shared-db/kv/list", scopes: ["sharedDb:read"] },
  // The kv/set endpoint is batch-shaped ({ namespace, items }); kv.set keeps
  // the SDK's single-key signature and maps to one item.
  "sharedDb.kv.set": {
    path: "api/shared-db/kv/set",
    scopes: ["sharedDb:write"],
    write: true,
    mapArgs: (args) => ({
      namespace: args.namespace,
      items: [{ key: args.key, value: args.value }],
    }),
    sdkReshape: "the SDK takes (namespace, key, value) and returns { item }",
  },
  "sharedDb.kv.setMany": { path: "api/shared-db/kv/set", scopes: ["sharedDb:write"], write: true },
  "sharedDb.kv.remove": { path: "api/shared-db/kv/delete", scopes: ["sharedDb:write"], write: true },
  "chat.listRooms": { path: "api/chat/rooms/list", scopes: ["chat:read"] },
  "chat.createRoom": { path: "api/chat/rooms/create", scopes: ["chat:write"], write: true },
  "chat.listMessages": { path: "api/chat/messages/list", scopes: ["chat:read"] },
  "chat.sendMessage": { path: "api/chat/messages/send", scopes: ["chat:write"], write: true },
  "chat.deleteMessage": { path: "api/chat/messages/delete", scopes: ["chat:write"], write: true },
  "users.getUser": {
    path: "api/user",
    scopes: ["user:read"],
    sdkReshape: "the SDK returns the user object directly (unwraps { user })",
  },
  "users.getUsers": { path: "api/users", scopes: ["users:read"] },
  "reflections.getDailyReflections": { path: "api/daily-reflections", scopes: ["dailyReflections:read"] },
  "reminders.list": { path: "api/reminders/list", scopes: ["reminders:read"] },
  // getDue's backend defaults autoAcknowledge to true, which persists writes
  // (lastTriggeredAt, and disabling one-shot reminders). Force read-only
  // probes to autoAcknowledge:false; acknowledging is a write that needs
  // --allow-write.
  "reminders.getDue": {
    path: "api/reminders/due",
    scopes: ["reminders:read"],
    writeWhen: (args) => args.autoAcknowledge === true,
    mapArgs: (args) => ({
      ...args,
      autoAcknowledge: args.autoAcknowledge === true,
    }),
  },
  "reminders.create": { path: "api/reminders/create", scopes: ["reminders:write"], write: true },
  "reminders.update": { path: "api/reminders/update", scopes: ["reminders:write"], write: true },
  "reminders.remove": { path: "api/reminders/delete", scopes: ["reminders:write"], write: true },
  "files.list": {
    path: "api/files/list",
    scopes: ["files:read"],
    sdkReshape: "the SDK returns { assets, usage }",
  },
  "files.delete": {
    path: "api/files/delete",
    scopes: ["files:write"],
    write: true,
    sdkReshape: "the SDK returns { success, usage }",
  },
  "notifications.getSubscription": { path: "api/notifications/subscription", scopes: ["notifications:read"] },
  "notifications.subscribe": { path: "api/notifications/subscription/subscribe", scopes: ["notifications:write"], write: true },
  "notifications.unsubscribe": { path: "api/notifications/subscription/unsubscribe", scopes: ["notifications:write"], write: true },
  "notifications.subscribeMany": { path: "api/notifications/subscriptions/subscribe", scopes: ["notifications:write"], write: true },
  "notifications.unsubscribeMany": { path: "api/notifications/subscriptions/unsubscribe", scopes: ["notifications:write"], write: true },
  "notifications.notifySubscribers": { path: "api/notifications/notify-subscribers", scopes: ["notifications:emit"], write: true },
  "notifications.getSubjectUpdateSubscription": { path: "api/notifications/subject-update-subscription", scopes: ["notifications:read"] },
  "notifications.subscribeToSubjectUpdates": { path: "api/notifications/subject-update-subscription/subscribe", scopes: ["notifications:write"], write: true },
  "notifications.unsubscribeFromSubjectUpdates": { path: "api/notifications/subject-update-subscription/unsubscribe", scopes: ["notifications:write"], write: true },
  // Leaderboards use the public leaderboard routes (regular login auth, no
  // build API token). args.boardKey selects the board; remaining args are
  // query params (get) or the POST body (submit).
  "leaderboards.get": { special: "leaderboardGet" },
  "leaderboards.submit": { special: "leaderboardSubmit", write: true },
  // userDb (the viewer's private SQLite) lives at /viewer-db/*, which uses
  // session auth directly — no build API token. query reads, exec mutates.
  // Body is { sql, params }. The backend's query route accepts any
  // row-returning statement, including INSERT/UPDATE/DELETE ... RETURNING,
  // so SQL that mutates is gated behind --allow-write here too.
  "userDb.query": { special: "userDbQuery", writeWhen: (args) => sqlMutates(args.sql) },
  "userDb.exec": { special: "userDbExec", write: true },
};

// Heuristic write-detection for raw SQL. SELECT/EXPLAIN/VALUES cannot mutate;
// a WITH (CTE) can wrap DML; everything else is treated as write-capable.
// Errs toward over-gating (safe) rather than under-gating.
export function sqlMutates(sql) {
  const normalized = String(sql || "")
    .trim()
    .replace(/^\(+/, "");
  const leadingKeyword = (normalized.match(/^\s*([a-z]+)/i)?.[1] || "").toUpperCase();
  if (
    leadingKeyword === "SELECT" ||
    leadingKeyword === "EXPLAIN" ||
    leadingKeyword === "VALUES"
  ) {
    return false;
  }
  if (leadingKeyword === "WITH") {
    return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(normalized);
  }
  return true;
}

// Reverse index of curated endpoint paths -> method name(s). Used to reject
// raw --path calls to curated endpoints: --path is for endpoints not in the
// list, and routing a curated endpoint through --path would strip its
// write/writeWhen/mapArgs safety handling (e.g. api/reminders/due defaults
// autoAcknowledge to true and mutates under a read scope).
export const SDK_CLI_METHOD_NAMES_BY_PATH = (() => {
  const byPath = new Map();
  for (const [name, entry] of Object.entries(SDK_CLI_METHODS)) {
    if (!entry.path) continue;
    if (!byPath.has(entry.path)) byPath.set(entry.path, []);
    byPath.get(entry.path).push(name);
  }
  return byPath;
})();

// Default token scopes for --path calls. Never fall through to the server's
// default scope set: it includes write/emit scopes, which must not be minted
// without --allow-write.
export const SDK_CLI_READ_SCOPES = [
  "files:read",
  "user:read",
  "users:read",
  "dailyReflections:read",
  "content:read",
  "sharedDb:read",
  "privateDb:read",
  "chat:read",
  "notifications:read",
  "reminders:read",
];

export function isWriteCapableScope(scope) {
  return /:(write|emit)$/.test(String(scope));
}

export async function sdkCommand(options) {
  const subcommand = String(options.positional[0] || "list");
  if (subcommand === "list") {
    printSdkMethodList();
    return;
  }
  if (subcommand !== "call") {
    throw new Error(
      'Usage: lumine sdk list | lumine sdk call <namespace.method> [jsonArgs]',
    );
  }
  await sdkCall(options);
}

export function printSdkMethodList() {
  console.log(
    "Callable Build endpoints (args JSON = request body). Prints the raw\n" +
      "endpoint response, which can differ from the SDK return shape (*).\n",
  );
  const byNamespace = new Map();
  for (const [name, entry] of Object.entries(SDK_CLI_METHODS)) {
    const namespace = name.split(".")[0];
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
    byNamespace.get(namespace).push({ name, entry });
  }
  for (const [namespace, methods] of byNamespace) {
    console.log(`  ${namespace}`);
    for (const { name, entry } of methods) {
      const writeTag = entry.write ? "  [write: needs --allow-write]" : "";
      const reshapeTag = entry.sdkReshape ? "  *" : "";
      const pathText = entry.path || `(${entry.special})`;
      console.log(
        `    ${name.padEnd(44)} ${pathText}${writeTag}${reshapeTag}`,
      );
    }
  }
  console.log(`
Usage:
  lumine sdk call aiStories.chapters '{"limit": 5}'
  lumine sdk call privateDb.set '{"key": "k", "value": {"a": 1}}' --allow-write
  lumine sdk call leaderboards.get '{"boardKey": "default", "limit": 10}'
  lumine sdk call aiStories.list '{"difficulty": 1}' --repeat 5 --build 1374
  lumine sdk call userDb.query '{"sql": "SELECT * FROM sqlite_master"}'

Request-body (args) shapes follow TWINKLE_BUILD_SDK.md. Output is the raw
endpoint response; (*) methods are reshaped by their Twinkle.* SDK wrapper, so
check TWINKLE_BUILD_SDK.md for the real SDK return shape. Add --repeat <n> for
latency stats, --build <id> to target a build outside the current workspace.
Use --path api/<endpoint> only for endpoints not listed above.`);
}

export async function sdkCall(options) {
  const usingRawPath = Boolean(options.sdkPath);
  const methodName = usingRawPath ? "" : String(options.positional[1] || "");
  const argsText = String(
    (usingRawPath ? options.positional[1] : options.positional[2]) || "",
  ).trim();

  let args = {};
  if (argsText) {
    try {
      args = JSON.parse(argsText);
    } catch (error) {
      throw new Error(`Args must be valid JSON: ${error.message}`);
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Args must be a JSON object, e.g. '{\"limit\": 5}'.");
    }
  }

  let endpoint;
  if (usingRawPath) {
    let normalizedPath = String(options.sdkPath).replace(/^\/+/, "");
    if (!/^api\/[a-zA-Z0-9/_-]+$/.test(normalizedPath)) {
      throw new Error("--path must look like api/<endpoint> (no query string).");
    }
    // Normalize the way Express routes (case-insensitive, non-strict, slashes
    // collapsed) so route-equivalent variants like api/Token or
    // api/reminders/due/ cannot dodge the guards below. Guard and call the
    // same normalized path so the checked string is the executed string.
    normalizedPath = normalizedPath
      .toLowerCase()
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "");
    // api/token is control-plane: the CLI mints the build API token itself,
    // and that endpoint's response is a token whose scopes come from the
    // request body, not from the CLI mint — so the write gate cannot see
    // them. Calling it as a data endpoint would hand back a write-capable
    // token without --allow-write. It is not a data method; reject it.
    if (/^api\/token(\/|$)/.test(normalizedPath)) {
      throw new Error(
        "api/token is not a callable SDK endpoint. The CLI mints build API " +
          "tokens internally for sdk calls.",
      );
    }
    // --path is for endpoints not in the curated list. Reject curated paths
    // so their read/write safety handling cannot be bypassed via --path.
    const curatedMethodNames = SDK_CLI_METHOD_NAMES_BY_PATH.get(normalizedPath);
    if (curatedMethodNames) {
      throw new Error(
        `${normalizedPath} is a curated SDK endpoint. Call it as ` +
          `${curatedMethodNames.join(" or ")} (applies the correct read/` +
          "write handling). --path is only for endpoints not in `lumine sdk list`.",
      );
    }
    endpoint = { path: normalizedPath, scopes: SDK_CLI_READ_SCOPES };
  } else {
    if (!methodName) {
      throw new Error(
        'Usage: lumine sdk call <namespace.method> [jsonArgs]. Run `lumine sdk list`.',
      );
    }
    endpoint = SDK_CLI_METHODS[methodName];
    if (!endpoint) {
      throw new Error(
        `Unknown SDK method "${methodName}". Run \`lumine sdk list\`, or call ` +
          "the endpoint directly with --path api/<endpoint>.",
      );
    }
  }

  // Token-capability gate: a write-capable build API token must never be
  // minted (and write-tagged methods never called) without --allow-write,
  // regardless of whether the call came from the curated table, --path, or a
  // --scopes override.
  const requestedScopes = options.sdkScopes.length
    ? options.sdkScopes
    : endpoint.scopes || [];
  const writeScopes = requestedScopes.filter(isWriteCapableScope);
  // writeWhen covers endpoints that mutate under a read scope depending on
  // their args (e.g. reminders.getDue acknowledging due reminders).
  const writeByArgs =
    typeof endpoint.writeWhen === "function" && endpoint.writeWhen(args);
  const writeCapable =
    Boolean(endpoint.write) || writeScopes.length > 0 || writeByArgs;
  if (writeCapable && !options.allowWrite) {
    const reason = writeScopes.length
      ? `write scopes: ${writeScopes.join(", ")}`
      : "this call writes app data";
    throw new Error(
      `${methodName || endpoint.path} can mutate real app data ` +
        `(${reason}). Re-run with --allow-write.`,
    );
  }

  // Resolve the build target (local-only: --build or workspace metadata)
  // before any auth side effects, so invalid local input fails immediately
  // instead of after starting the device-login flow.
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  const attempts = [];
  let lastResult = null;

  if (endpoint.special === "leaderboardGet" || endpoint.special === "leaderboardSubmit") {
    const boardKey = String(args.boardKey || "default");
    const rest = { ...args };
    delete rest.boardKey;
    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      if (endpoint.special === "leaderboardGet") {
        const url = new URL(
          `${options.apiUrl}/build/${buildId}/leaderboards/${encodeURIComponent(boardKey)}`,
        );
        for (const [key, value] of Object.entries(rest)) {
          if (value !== null && value !== undefined) {
            url.searchParams.set(key, String(value));
          }
        }
        lastResult = await executeSdkHttpCall({
          options,
          method: "GET",
          url: url.toString(),
          authToken: auth.token,
        });
      } else {
        lastResult = await executeSdkHttpCall({
          options,
          method: "POST",
          url: `${options.apiUrl}/build/${buildId}/leaderboards/${encodeURIComponent(boardKey)}/submit`,
          authToken: auth.token,
          body: rest,
        });
      }
      attempts.push(lastResult);
      printSdkAttemptLine(attempts.length, lastResult);
    }
  } else if (
    endpoint.special === "userDbQuery" ||
    endpoint.special === "userDbExec"
  ) {
    // viewer-db uses session auth (no build API token). Body is { sql, params }.
    const route = endpoint.special === "userDbExec" ? "exec" : "query";
    const body = { sql: args.sql, params: args.params };
    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      lastResult = await executeSdkHttpCall({
        options,
        method: "POST",
        url: `${options.apiUrl}/build/${buildId}/viewer-db/${route}`,
        authToken: auth.token,
        body,
      });
      attempts.push(lastResult);
      printSdkAttemptLine(attempts.length, lastResult);
    }
  } else {
    // Always request explicit scopes: an empty scopes body makes the server
    // fall back to its default scope set, which is write-capable.
    const scopes = requestedScopes.length
      ? requestedScopes
      : SDK_CLI_READ_SCOPES;
    const tokenResult = await mintBuildApiToken({
      options,
      auth,
      buildId,
      scopes,
    });
    console.error(
      `token minted in ${tokenResult.ms}ms (scopes: ${
        tokenResult.scopes.join(", ") || "default"
      })`,
    );
    const body = endpoint.mapArgs ? endpoint.mapArgs(args) : args;
    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      lastResult = await executeSdkHttpCall({
        options,
        method: "POST",
        url: `${options.apiUrl}/build/${buildId}/${endpoint.path}`,
        authToken: auth.token,
        body,
        buildApiToken: tokenResult.token,
      });
      attempts.push(lastResult);
      printSdkAttemptLine(attempts.length, lastResult);
    }
  }

  if (options.repeat > 1) {
    const timings = attempts.map((entry) => entry.ms);
    const total = timings.reduce((sum, ms) => sum + ms, 0);
    console.error(
      `latency over ${timings.length} calls: min ${Math.min(...timings)}ms · ` +
        `avg ${Math.round(total / timings.length)}ms · max ${Math.max(...timings)}ms`,
    );
  }

  // The printed JSON is the raw endpoint response. Some SDK wrappers reshape
  // it, so warn precisely where the SDK return shape differs.
  if (endpoint && endpoint.sdkReshape) {
    console.error(
      `note: raw endpoint response below — ${methodName}'s SDK wrapper ` +
        `reshapes it (${endpoint.sdkReshape}). See TWINKLE_BUILD_SDK.md.`,
    );
  }
  if (lastResult) {
    console.log(JSON.stringify(lastResult.data ?? lastResult.text, null, 2));
  }
  if (lastResult && !lastResult.ok) {
    process.exitCode = 1;
  }
}

export function printSdkAttemptLine(attemptNumber, result) {
  console.error(
    `#${attemptNumber} ${result.status}${result.ok ? " OK" : ""} · ` +
      `${result.bytes.toLocaleString()} bytes · ${result.ms}ms`,
  );
}

export async function executeSdkHttpCall({
  options,
  method,
  url,
  authToken,
  body,
  buildApiToken,
}) {
  const startedAt = Date.now();
  const response = await request({
    method,
    url,
    authToken,
    body,
    timeoutMs: options.timeoutMs,
    headers: buildApiToken ? { "x-build-api-token": buildApiToken } : {},
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    ms: Date.now() - startedAt,
    bytes: Buffer.byteLength(text),
    data: parseJson(text),
    text,
  };
}

export async function resolveSdkBuildId(options) {
  if (options.buildIdFlag) {
    const buildId = resolveBuildId(options.buildIdFlag);
    if (buildId > 0) return buildId;
    throw new Error(`Invalid --build value: ${options.buildIdFlag}`);
  }
  const localProject = await findLocalProjectMetadata(
    options.dir ? path.resolve(options.dir) : process.cwd(),
  );
  const buildId = Number(localProject?.metadata?.buildId || 0);
  if (buildId > 0) return buildId;
  throw new Error(
    "No build workspace found. Run from a pulled workspace, pass --dir, or pass --build <id>.",
  );
}
