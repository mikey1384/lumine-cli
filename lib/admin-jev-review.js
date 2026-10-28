// Bounded owner-only frozen evidence. Collection never acknowledges reading
// and never reconstructs missing input from the member's edited chat history.
export const JEV_REVIEW_USAGE =
  "Usage: lumine admin jev-routing review --since <unix|ISO> --until <unix|ISO> [--limit 1..20] [--cursor <cursor>] [--include-synthetic] [--all] [--json].";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

function explicitTimestamp(value, name) {
  if (typeof value !== "string" && typeof value !== "number") invalid(JEV_REVIEW_USAGE);
  const text = String(value).trim();
  if (!/^\d+$/.test(text) && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) {
    invalid(`--${name} requires an explicit Unix timestamp or ISO date, not a relative window.`);
  }
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.floor(Date.parse(text) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) invalid(`Invalid --${name} timestamp.`);
  // Keep ISO input intact for the API's strict calendar/date-zone validation.
  return { text, seconds };
}

export function buildJevRoutingReviewOperation({ action, target, extra, options = {} }) {
  if (action !== "review" || target || extra) invalid(JEV_REVIEW_USAGE);
  if (options.adminAll && options.adminCursor) {
    invalid("Use --all from the beginning of the window, or --resume with its saved checkpoint; use --cursor only for an individual page.");
  }
  const since = explicitTimestamp(options.adminSince, "since");
  const until = explicitTimestamp(options.adminUntil, "until");
  if (until.seconds <= since.seconds || until.seconds - since.seconds > 8 * 86400) {
    invalid("Use a fixed window with since < until, at most eight days.");
  }
  // The global parser's `limit` defaults to 50 for unrelated commands.
  // `adminLimit` records only an explicitly supplied --limit.
  const rawLimit = options.adminLimit;
  const limit = rawLimit == null || rawLimit === "" ? 20 : Number(rawLimit);
  if ((rawLimit != null && !["string", "number"].includes(typeof rawLimit)) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 20) invalid("--limit must be 1–20.");
  if (options.adminIncludeSynthetic !== undefined && typeof options.adminIncludeSynthetic !== "boolean") {
    invalid("--include-synthetic is a flag without a value.");
  }
  const includeSynthetic = options.adminIncludeSynthetic === true;
  const query = new URLSearchParams({ since: since.text, until: until.text, limit: String(limit) });
  if (includeSynthetic) query.set("includeSynthetic", "true");
  if (options.adminCursor) query.set("cursor", String(options.adminCursor));
  return {
    name: "jevRouting.review",
    method: "GET",
    path: `/cli/admin/jev-routing/review?${query.toString()}`,
    body: undefined,
    mutates: false,
    requiresRun: false,
    pagination: {
      collectionKey: "items",
      after: since.seconds,
      summaryKeys: ["collectionWindow", "coverage", "notes"],
      filters: { since: since.text, until: until.text, includeSynthetic },
    },
  };
}

export function formatJevRoutingReview(data = {}) {
  const window = data.collectionWindow || {};
  const coverage = data.coverage || {};
  const lines = [
    `JEV review: [${window.since ?? "?"}, ${window.until ?? "?"}) · synthetic ${window.includeSynthetic ? "included" : "excluded"}`,
    `${data.items?.length || 0} events returned · page ${coverage.status || "coverage unknown"}${coverage.fromBeginning === false ? " · resumed after a cursor" : ""}`,
  ];
  for (const item of data.items || []) {
    lines.push(`#${item.eventId} ${item.route} · ${(item.reviewReasons || []).join(", ")} · selected ${item.selectedSource || "not recorded"} · frozen input ${item.contextAvailable ? "available" : item.contextUnavailableReason || "unavailable"}`);
  }
  if (data.nextCursor) lines.push(`Next cursor: ${data.nextCursor}`);
  lines.push("Collection is not review. Read the JSON source pages; an exhausted resumed page does not prove the whole window was collected.");
  return lines;
}
