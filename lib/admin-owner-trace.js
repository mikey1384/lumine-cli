// `lumine admin owner-trace`: the owner's client trace from Mikey's own
// devices (routes, Home feed card opens, scroll-anchor restores, content-page
// scroll positions, window errors), read when he reports a UI issue. Read-only;
// no daily run needed. The server keeps 30 days.

export const OWNER_TRACE_USAGE =
  "Usage: lumine admin owner-trace [--since 2h|30m|3d|<iso>|<unix>] [--type route,feed-open,scroll-anchor,content-scroll,error,...] [--perf] [--path <substring>] [--limit 300] [--json].";

// --perf: only the performance events (tap-to-page timeline, slow API
// requests, main-thread stalls, page load).
export const OWNER_TRACE_PERF_TYPES = [
  "nav-timing",
  "slow-request",
  "stall",
  "page-load",
];

const MAX_LIMIT = 2000;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function normalizeSince(value) {
  const raw = String(value || "").trim();
  if (!raw) return "2h";
  if (/^\d+\s*[smhd]$/i.test(raw) || /^\d{9,14}$/.test(raw)) {
    return raw.replace(/\s+/g, "");
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw validationError(
      "--since must look like 30m, 2h, 3d, an ISO date or a unix time.",
    );
  }
  return String(Math.floor(parsed / 1000));
}

export function buildOwnerTraceOperation(options) {
  const limitRaw = options.adminLimit;
  let limit = 300;
  if (limitRaw !== null && limitRaw !== undefined && limitRaw !== "") {
    limit = Number(String(limitRaw).trim());
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw validationError(`--limit must be an integer 1-${MAX_LIMIT}.`);
    }
  }
  const query = new URLSearchParams();
  query.set("since", normalizeSince(options.adminSince));
  query.set("limit", String(limit));
  const types = String(options.adminType || "")
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  if (options.adminPerf) {
    for (const type of OWNER_TRACE_PERF_TYPES) {
      if (!types.includes(type)) types.push(type);
    }
  }
  if (types.length) query.set("type", types.join(","));
  if (options.adminPath) query.set("path", String(options.adminPath));
  return {
    name: "owner-trace.read",
    method: "GET",
    path: `/cli/admin/owner-trace?${query.toString()}`,
    body: undefined,
    mutates: false,
    requiresRun: false,
  };
}

function pad(value, size) {
  return String(value).padStart(size, "0");
}

function formatClock(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

function formatDay(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

function pairs(data, skip = []) {
  return Object.entries(data || {})
    .filter(([key, value]) => !skip.includes(key) && value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
    .join(" ");
}

function describeSession(data = {}, path = "") {
  const parts = [
    data.version ? `v${data.version}` : "",
    data.vw && data.vh ? `${data.vw}x${data.vh}${data.dpr ? ` @${data.dpr}x` : ""}` : "",
    data.vvh ? `visual ${data.vvh}h` : "",
    data.platform || "",
    data.mobile ? "mobile" : "",
    data.standalone ? "standalone (PWA)" : "browser tab",
    data.touch ? `touch ${data.touch}` : "",
  ].filter(Boolean);
  if (path) parts.push(`at ${path}`);
  return `${parts.join(" · ")}${data.ua ? `\n      ua: ${data.ua}` : ""}`;
}

export function describeOwnerTraceEvent(event) {
  const data = event.data || {};
  switch (event.type) {
    case "route": {
      const feed = data.feedNav
        ? ` · feedNav ${data.feedNav.ct}:${data.feedNav.id}${data.feedNav.action ? ` ${data.feedNav.action}` : ""}`
        : "";
      const intent = data.feedIntent ? ` · intent ${data.feedIntent}` : "";
      const otherKeys = (data.stateKeys || []).filter(
        (key) => key !== "homeFeedNavigation" && key !== "homeFeedActionIntent",
      );
      return `${data.nav || "?"}${data.from ? ` from ${data.from}` : ""}${feed}${intent}${otherKeys.length ? ` · state ${otherKeys.join(",")}` : ""}${data.hash ? ` · ${data.hash}` : ""}`;
    }
    case "feed-open":
      return `${data.action || "open"} ${data.ct}:${data.id}${data.via ? ` via ${data.via}` : ""}${data.el ? ` (${data.el})` : ""}${data.to ? ` → ${data.to}` : ""}${data.pos ? ` · card #${data.pos}` : ""}${data.surface && data.surface !== "home" ? ` · ${data.surface}` : ""}`;
    case "scroll-anchor":
      return `${data.e || "?"} ${pairs(data, ["e"])}`.trim();
    case "content-scroll":
      return `${data.phase} ${data.ct}:${data.id} scrollTop=${data.st} height=${data.sh} viewport=${data.vh}`;
    case "nav-timing":
      return describeNavTiming(data);
    case "slow-request": {
      const extra = [
        data.q ? `queued ${data.q}ms` : "",
        data.tries ? `${data.tries} tries` : "",
      ].filter(Boolean);
      return `${data.m || "?"} ${data.api || "?"} → ${data.status ?? "?"} in ${data.ms}ms${extra.length ? ` (${extra.join(", ")})` : ""}`;
    }
    case "stall":
      return `main thread blocked ${data.ms}ms${data.n > 1 ? ` (${data.n} stalls, ${data.total}ms blocked over ${data.span}ms)` : ""}`;
    case "page-load": {
      const parts = [
        data.type || "",
        data.ttfb !== undefined ? `ttfb ${data.ttfb}` : "",
        data.dcl !== undefined ? `domcontentloaded ${data.dcl}` : "",
        data.load !== undefined ? `load ${data.load}` : "",
        data.route !== undefined ? `first route ${data.route}` : "",
      ].filter(Boolean);
      return `${parts.join(" · ")} ms${data.cached ? " (document from cache)" : ""}`;
    }
    case "error":
    case "rejection":
      return `${data.msg || "(no message)"}${data.src ? ` (${data.src}:${data.line}:${data.col})` : ""}${data.status ? ` HTTP ${data.status}` : ""}`;
    default:
      return pairs(data);
  }
}

// "tap→page 4210ms · PUSH via nav · url +90 · gate +4180 (probe timeout,
// waited 4100ms) · commit +4210 · ready +4600": offsets are ms from the tap.
function describeNavTiming(data) {
  const end = data.ready ?? data.commit;
  const head =
    end !== undefined
      ? `${data.via === "url" || data.via === "pop" ? "start" : "tap"}→${data.ready !== undefined ? "ready" : "page"} ${end}ms`
      : `cut after ${data.total}ms`;
  const steps = [
    data.url !== undefined ? `url +${data.url}` : "",
    data.gate !== undefined
      ? `gate +${data.gate}${data.probe ? ` (probe ${data.probe}${data.probeMs ? `, waited ${data.probeMs}ms` : ""})` : ""}`
      : "",
    data.commit !== undefined ? `commit +${data.commit}` : "",
    data.ready !== undefined ? `ready +${data.ready}` : "",
  ].filter(Boolean);
  const tail = [
    data.result ? `gate ${data.result}` : "",
    data.cut ? `cut by ${data.cut}` : "",
  ].filter(Boolean);
  return [head, `${data.nav || "?"} via ${data.via || "?"}`, ...steps, ...tail].join(" · ");
}

export function formatOwnerTrace(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const lines = [];
  const sessions = new Set(events.map((event) => event.sessionId));
  const since = Number(data?.since || 0);
  lines.push(
    `Owner trace since ${since ? `${formatDay(since * 1000)} ${formatClock(since * 1000).slice(0, 5)}` : "?"} · ${events.length} event(s) · ${sessions.size} session(s)${data?.truncated ? " · older events cut off (raise --limit or narrow --since)" : ""}`,
  );
  if (!events.length) {
    lines.push("Nothing recorded in this window.");
    return lines;
  }
  let day = "";
  let session = "";
  for (const event of events) {
    const ms = Number(event.clientTime) || Number(event.serverTime) * 1000;
    const eventDay = formatDay(ms);
    if (eventDay !== day) {
      day = eventDay;
      lines.push(`── ${day}`);
    }
    if (event.sessionId !== session) {
      session = event.sessionId;
      if (event.type !== "session") {
        lines.push(`  · session ${String(session).slice(0, 8)} (continued)`);
      }
    }
    if (event.type === "session") {
      lines.push(
        `  ${formatClock(ms)}  ── session ${String(session).slice(0, 8)} · ${describeSession(event.data, event.path)}`,
      );
      continue;
    }
    lines.push(
      `  ${formatClock(ms)}  ${event.type.padEnd(14)} ${event.path || "-"}  ${describeOwnerTraceEvent(event)}`.trimEnd(),
    );
  }
  return lines;
}

export function printOwnerTrace(data) {
  for (const line of formatOwnerTrace(data)) console.log(line);
}
