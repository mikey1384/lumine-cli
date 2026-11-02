// `lumine admin member-trace ...`: the owner trace switched on for specific
// member accounts, so a bug one member reports (and Mikey cannot reproduce)
// can be read the way his own are. The server keeps 30 days.
//
//   lumine admin member-trace list
//   lumine admin member-trace on <username> --reason "<why>"
//   lumine admin member-trace off <username>
//   lumine admin member-trace <username> [--since 2h] [--source all|client|server] [...]
//     (`member-trace read <username>` is the same, for a member named list/on/off/read)

import { buildOwnerTraceOperation, formatOwnerTrace } from "./admin-owner-trace.js";

export const MEMBER_TRACE_USAGE =
  "Usage: lumine admin member-trace list | on <username> --reason <why> | off <username> | [read] <username> [--since 2h|30m|3d|<iso>|<unix>] [--until <unix-second>] [--cursor <time:id>] [--source all|client|server] [--type reload,route,chat-select,error,api,...] [--path <substring>] [--limit 300] [--json].";

const ACTIONS = new Set(["list", "on", "off", "read"]);
const SOURCES = new Set(["all", "client", "server"]);

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function memberName(value) {
  const name = String(value || "").trim().replace(/^@/, "");
  if (!name) throw validationError(MEMBER_TRACE_USAGE);
  if (!/^[^\s/?#]{1,40}$/.test(name)) {
    throw validationError("Name the member by username or user id.");
  }
  return name;
}

export function buildMemberTraceOperation({ action = "", target = "", options }) {
  if (action === "list") {
    return {
      name: "member-trace.list",
      method: "GET",
      path: "/cli/admin/member-trace/accounts",
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "on") {
    const reason = String(options.adminReason || "").trim();
    if (!reason) {
      throw validationError(
        'Say why with --reason (for example --reason "General chat main keeps reloading").',
      );
    }
    return {
      name: "member-trace.on",
      method: "POST",
      path: "/cli/admin/member-trace/on",
      body: { user: memberName(target), reason: reason.slice(0, 255) },
      mutates: true,
      requiresRun: false,
    };
  }
  if (action === "off") {
    return {
      name: "member-trace.off",
      method: "POST",
      path: "/cli/admin/member-trace/off",
      body: { user: memberName(target) },
      mutates: true,
      requiresRun: false,
    };
  }
  const user = memberName(action === "read" ? target : action);
  if (!ACTIONS.has(action) && target) {
    throw validationError(MEMBER_TRACE_USAGE);
  }
  // the owner trace's filters (--since/--until/--cursor/--type/--path/--limit)
  const owner = buildOwnerTraceOperation(options);
  const query = new URLSearchParams(owner.path.split("?")[1] || "");
  query.set("user", user);
  const source = String(options.adminTraceSource || "").trim();
  if (source) {
    if (!SOURCES.has(source)) {
      throw validationError("--source is all, client (the website on the device) or server (the API's view of its requests).");
    }
    query.set("source", source);
  }
  return {
    name: "member-trace.read",
    method: "GET",
    path: `/cli/admin/member-trace?${query.toString()}`,
    body: undefined,
    mutates: false,
    requiresRun: false,
  };
}

function formatWhen(seconds) {
  const value = Number(seconds);
  if (!value) return "never";
  return new Date(value * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function formatMemberTraceList(data) {
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  if (!accounts.length) return ["No member is traced."];
  const lines = [`${accounts.length} traced member account(s):`];
  for (const account of accounts) {
    lines.push(
      `  ${account.username || "?"} (#${account.userId}) · on since ${formatWhen(account.enabledAt)}${account.enabledByUsername ? ` by ${account.enabledByUsername}` : ""} · ${account.reason || "(no reason)"}`,
    );
    lines.push(
      `      last 24 h: ${account.clientRows24h ?? "?"} website event(s) (last ${formatWhen(account.lastClientAt)}), ${account.serverRows24h ?? "?"} API request row(s) (last ${formatWhen(account.lastServerAt)})`,
    );
  }
  return lines;
}

export function formatMemberTraceSwitch(data) {
  const who = `${data?.username || "?"} (#${data?.userId ?? "?"})`;
  if (data?.enabled) {
    return [
      data.alreadyOn
        ? `Member trace was already on for ${who}.`
        : `Member trace is on for ${who}. Every API process picks it up within ${data.effectiveWithinSeconds ?? 30} s; the website starts tracing at the member's next page load.`,
    ];
  }
  return [
    data?.wasOn
      ? `Member trace is off for ${who}. Rows already kept expire after ${data.keptRowsExpireAfterDays ?? 30} days.`
      : `Member trace was not on for ${who}.`,
  ];
}

function count(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function listCounts(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ×${n}`)
    .join(", ");
}

// The plain-words summary the daily run reports: which website build the
// device runs (as the website says and as the API saw it), page loads and how
// they were opened, self-reloads by reason, errors.
export function summarizeMemberTrace(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const client = events.filter((event) => event.type !== "api" && event.type !== "api-dropped");
  const server = events.filter((event) => event.type === "api" || event.type === "api-dropped");
  const versions = new Map();
  const bundles = new Map();
  const navTypes = new Map();
  const reloads = new Map();
  const errors = new Map();
  const loadCauses = new Map();
  let socketDrops = 0;
  let socketDropsVisible = 0;
  let chatLoadingScreens = 0;
  for (const event of client) {
    const data = event.data || {};
    if (event.type === "session") {
      count(versions, data.version || "?");
      if (data.entry) count(bundles, data.entry);
      count(navTypes, data.navType || "?");
    } else if (event.type === "boot") {
      count(
        loadCauses,
        data.byCode ? `code:${data.byCode}` : data.on ? "tracing switched on" : data.navType === "reload" ? "reload by hand/browser" : data.navType || "?",
      );
    } else if (event.type === "socket" && data.e === "disconnect") {
      socketDrops += 1;
      if (data.vis === "visible") socketDropsVisible += 1;
    } else if (event.type === "chat-loading" && data.e === "shown") {
      chatLoadingScreens += 1;
    } else if (event.type === "reload") {
      count(reloads, data.reason || "?");
    } else if (event.type === "error" || event.type === "rejection" || event.type === "boundary-error") {
      count(errors, `${event.type}: ${String(data.msg || "").slice(0, 80)}`);
    }
  }
  const apiVersions = new Map();
  const statuses = new Map();
  const devices = new Set();
  let sessionLoads = 0;
  for (const event of server) {
    const data = event.data || {};
    if (event.type !== "api") continue;
    count(apiVersions, data.v || "?");
    devices.add(event.sessionId);
    const status = data.s === "aborted" ? "aborted" : Number(data.s) >= 400 ? String(data.s) : null;
    if (status) count(statuses, status);
    if (String(event.path || "").startsWith("/user/session") && !String(event.path).startsWith("/user/session/")) {
      sessionLoads += 1;
    }
  }
  const lines = [];
  lines.push(
    `Website: ${client.filter((event) => event.type === "session").length} page load(s)${navTypes.size ? ` (opened by ${listCounts(navTypes)})` : ""}${versions.size ? ` · version ${listCounts(versions)}` : ""}${bundles.size ? ` · bundle ${listCounts(bundles)}` : ""}`,
  );
  if (loadCauses.size) lines.push(`Why pages loaded: ${listCounts(loadCauses)}`);
  lines.push(`Self-reloads: ${reloads.size ? listCounts(reloads) : "none recorded"}`);
  lines.push(
    `Socket drops: ${socketDrops}${socketDrops ? ` (${socketDropsVisible} while the page was visible)` : ""} · full chat loading screens: ${chatLoadingScreens}`,
  );
  lines.push(`Errors: ${errors.size ? listCounts(errors) : "none recorded"}`);
  lines.push(
    `API view: ${server.length} request row(s) from ${devices.size} device(s)${apiVersions.size ? ` · reported website version ${listCounts(apiVersions)}` : ""} · session loads ${sessionLoads}${statuses.size ? ` · failures ${listCounts(statuses)}` : ""}`,
  );
  if (!client.length && server.length) {
    lines.push(
      "  No website events: the device has not run a website build with the member trace yet (an older cached bundle?), or it has not loaded since tracing was switched on.",
    );
  }
  return lines;
}

export function formatMemberTrace(data) {
  const user = data?.user || {};
  const who = `${user.username || "?"} (#${user.id ?? "?"})`;
  const lines = [
    `Member trace for ${who}${user.traced ? `, on since ${formatWhen(user.enabledAt)}: ${user.reason || ""}` : ", tracing is OFF (older rows only)"}${data?.source && data.source !== "all" ? ` · ${data.source} rows only` : ""}${data?.duplicates ? ` · ${data.duplicates} re-sent duplicate(s) hidden` : ""}`,
  ];
  for (const line of summarizeMemberTrace(data)) lines.push(`  ${line}`);
  const events = Array.isArray(data?.events) ? data.events : [];
  const client = events.filter((event) => event.type !== "api" && event.type !== "api-dropped");
  const server = events.filter((event) => event.type === "api" || event.type === "api-dropped");
  if (data?.source !== "server") {
    lines.push("");
    lines.push(...formatOwnerTrace({ ...data, events: client }, { title: "Website events (from the device)" }));
  }
  if (data?.source !== "client") {
    lines.push("");
    lines.push(...formatOwnerTrace({ ...data, events: server }, { title: "API view (requests from this account; session = device tag)" }));
  }
  return lines;
}

export function printMemberTraceResult(operation, data) {
  const lines =
    operation.name === "member-trace.list"
      ? formatMemberTraceList(data)
      : operation.name === "member-trace.read"
        ? formatMemberTrace(data)
        : formatMemberTraceSwitch(data);
  for (const line of lines) console.log(line);
}
