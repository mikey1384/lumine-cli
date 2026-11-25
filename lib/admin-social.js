// `lumine admin social report [--days 1..30] [--build <id>] [--json]`
// (twinkle-api controllers/cli/admin/social.ts): counts-only telemetry for
// Twinkle.social (walk-ups, drop-in rooms, matches and notices) and the
// Twinkle.app.openLink sheet (shown / opened / cancelled / rejected). Read-only,
// no daily run needed. The full daily run reads `--days 7 --json`.
export const SOCIAL_USAGE = "Usage: lumine admin social report [--days 1..30] [--build <id>] [--json]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export function buildSocialOperation({ action, options = {} }) {
  if (action && action !== "report") throw invalid(SOCIAL_USAGE);
  const days = options.adminDays === "" || options.adminDays == null ? 1 : Number(options.adminDays);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw invalid("--days must be 1 to 30.");
  let query = `days=${days}`;
  if (options.adminBuild !== "" && options.adminBuild != null) {
    const buildId = Number(options.adminBuild);
    if (!Number.isSafeInteger(buildId) || buildId <= 0) throw invalid("--build is a build id.");
    query += `&buildId=${buildId}`;
  }
  return {
    name: "social.report",
    method: "GET",
    path: `/cli/admin/social/report?${query}`,
    body: undefined,
    mutates: false,
    requiresRun: false,
  };
}

const HEADLINE_LABELS = [
  ["joinTaps", "Join taps"],
  ["openedAppOnly", "only opened the app"],
  ["dropInAttempts", "drop-in attempts"],
  ["dropIns", "drop-ins"],
  ["walkupsQueued", "walk-ups queued"],
  ["visitorArrivals", "visitors arrived"],
  ["acceptArriving", "accepts before arrival"],
  ["accepted", "accepted"],
  ["matchReadyAcks", "match-ready acks"],
  ["togetherOk", "reportTogether ok"],
  ["noticesCreated", "notices created"],
  ["noticesUpdated", "updated"],
  ["noticeReports", "notice reports"],
  ["refusals", "refusals"],
];

function headlineLine(headline = {}) {
  return HEADLINE_LABELS.map(([key, label]) => `${headline[key] ?? 0} ${label}`).join(", ");
}

function averageLine(average) {
  if (!average) return "no measured trailing day";
  const keys = [
    ["route.calls", "Join taps"],
    ["dropin.ok", "drop-ins"],
    ["walkup.queued", "walk-ups queued"],
    ["accept.matched", "accepted"],
    ["together.ok", "reportTogether ok"],
    ["notice.created", "notices created"],
  ];
  return keys.map(([field, label]) => `${average[field] ?? 0} ${label}`).join(", ");
}

function refusalLine(counters = {}) {
  const reasons = Object.entries(counters)
    .filter(([field]) => field.startsWith("walkup.refused.") || field.startsWith("dropin.refused."))
    .sort((a, b) => b[1] - a[1]);
  if (!reasons.length) return "none";
  return reasons.map(([field, value]) => `${field.replace(".refused.", " ")} ${value}`).join(", ");
}

// Twinkle.app.openLink sheet counts (twinkle-api helpers/build/appLinkEvents.ts)
function appLinkLine(counts = {}) {
  const value = (key) => counts?.[key] ?? 0;
  return `${value("shown")} shown, ${value("opened")} opened, ${value("cancelled")} cancelled, ${value("rejected")} rejected (${value("blocked")} blocked sites)`;
}

// Blocked-site taps on posted links (twinkle-api helpers/build/postedLinkEvents.ts)
function postedLinkLine(counts = {}) {
  const value = (key) => counts?.[key] ?? 0;
  return `${value("blocked")} blocked taps, ${value("unchecked")} unchecked`;
}

function writerLine(writer) {
  if (!writer || writer.state === "ok" || writer.state === "idle") return null;
  if (writer.state === "denied")
    return `Counter writes on this API process: DENIED by Valkey (${writer.consecutiveFailures} flushes in a row): days without data are denied, not undeployed.`;
  return `Counter writes on this API process: failing (${writer.lastFailure || "error"}, ${writer.consecutiveFailures} in a row); counts wait in memory.`;
}

function dayStatus(day = {}) {
  return day.partial ? `${day.status}, partial from ${day.firstCountAt || "a late start"}` : day.status;
}

export function formatSocialResult({ data = {} }) {
  if (data.status !== "ok") {
    return [
      `Twinkle.social telemetry: UNAVAILABLE (${data.reason || "unknown"}). ${data.detail || ""}`.trim(),
      "Nothing was measured: do not read this as zero traffic.",
      writerLine(data.writer),
    ].filter(Boolean);
  }
  const scope = data.buildId ? `build ${data.buildId}` : "all builds";
  const last = data.lastCompletedDay || {};
  const today = data.inProgressDay || {};
  const lines = [
    `Twinkle.social telemetry (${scope}, ${data.store}, kept ${data.ttlDays} days) · window ${data.window?.from}..${data.window?.lastCompletedDay}`,
    `Last completed day ${last.day} (${dayStatus(last)}): ${last.status === "measured" ? headlineLine(last.headline) : "not measured (not zero traffic)"}`,
    `  refusals by reason: ${last.status === "measured" ? refusalLine(last.counters) : "-"}`,
    `Trailing ${data.trailing?.days ?? 0} day(s), ${data.trailing?.measuredDays ?? 0} measured${data.trailing?.partialDays ? ` (${data.trailing.partialDays} partial, left out of the average)` : ""}, daily average: ${averageLine(data.trailing?.dailyAverage)}`,
    `In progress ${today.day} (${dayStatus(today)}): ${today.status === "measured" ? headlineLine(today.headline) : "not measured"}`,
  ];
  const writer = writerLine(data.writer);
  if (writer) lines.push(writer);
  if (Array.isArray(data.topBuilds) && data.topBuilds.length) {
    lines.push("Top builds (window):");
    for (const row of data.topBuilds) {
      lines.push(`  #${row.buildId}: ${row.dropIns} drop-ins, ${row.walkupsQueued} walk-ups, ${row.joinTaps} Join taps, ${row.matchReadyAcks} acks, ${row.togetherOk} together, ${row.notices} notices, ${row.openEvents} open events`);
    }
  }
  if (data.appLinks) {
    lines.push(`App links (Twinkle.app.openLink sheet): last day ${appLinkLine(data.appLinks.lastCompletedDay)}; today so far ${appLinkLine(data.appLinks.inProgressDay)}; past ${data.window?.days ?? "?"} day(s) ${appLinkLine(data.appLinks.window)}`);
    if (Array.isArray(data.appLinks.topBuilds) && data.appLinks.topBuilds.length) {
      lines.push(`  Top apps by link sheets (past ${data.window?.days ?? "?"} day(s)):`);
      for (const row of data.appLinks.topBuilds) lines.push(`    #${row.buildId}: ${appLinkLine(row)}`);
    }
  }
  if (data.postedLinks) {
    lines.push(`Posted links (blocked-site list on posts, comments, chat, profiles): last day ${postedLinkLine(data.postedLinks.lastCompletedDay)}; today so far ${postedLinkLine(data.postedLinks.inProgressDay)}; past ${data.window?.days ?? "?"} day(s) ${postedLinkLine(data.postedLinks.window)}`);
  }
  if ((data.flags || []).length) {
    lines.push("Health flags:");
    for (const flag of data.flags) lines.push(`  ${flag.code} (${flag.scope}): ${flag.detail}`);
  } else {
    lines.push("Health flags: none.");
  }
  for (const note of data.notes || []) lines.push(`Note: ${note}`);
  return lines;
}
