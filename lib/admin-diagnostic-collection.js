// Fixed-window keyset collection. Every page stays a separate acknowledged
// source; aggregates are conveniences, never proof that the source was read.
function jevPosition(cursor, since, until) {
  try {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) return null;
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.version !== 1 || value.kind !== "jev-routing-review" ||
        value.since !== since || value.until !== until || value.includeSynthetic !== false ||
        !Number.isSafeInteger(value.createdAt) || value.createdAt < since || value.createdAt >= until ||
        !Number.isSafeInteger(value.id) || value.id <= 0) return null;
    return value;
  } catch { return null; }
}

export function collectDiagnosticPages({ name, command, since, until, ownerTrace = false, jevReview = false, step, failLast }) {
  const events = [];
  const ids = new Set();
  const cursors = new Set();
  const sourceFiles = [];
  let cursor = null;
  let pages = 0;
  let duplicateRows = 0;
  let complete = false;
  let deferred = false;
  let failure = null;
  const pageLimit = ownerTrace ? 20 : 100;
  for (;;) {
    pages++;
    const args = [...command, "--until", String(until)];
    if (cursor !== null) args.push("--cursor", String(cursor));
    const file = `${name}${pages === 1 ? "" : `-${pages}`}.json`;
    const result = step(`${name}${pages === 1 ? "" : `-page-${pages}`}`, args, file);
    sourceFiles.push(file);
    if (!result.ok) {
      deferred = Boolean(result.deferred);
      failure = deferred ? result.reason : "source-read-failed";
      break;
    }
    const data = result.json?.data;
    const next = data?.nextCursor;
    const rows = jevReview ? data?.items : data?.events;
    const window = jevReview ? data?.collectionWindow : data;
    const validCursor = next === null || (jevReview ? Boolean(jevPosition(next, since, until)) : ownerTrace
      ? typeof next === "string" && /^\d+:\d+$/.test(next)
      : Number.isSafeInteger(next) && next > 0 && (cursor === null || next < cursor));
    if (!Array.isArray(rows) || window?.since !== since || window?.until !== until ||
        !validCursor || data.coverage === "unavailable" ||
        (jevReview && (window.includeSynthetic !== false || data.after !== cursor ||
          data.hasMore !== (next !== null) || data.coverage?.scope !== "page" ||
          data.coverage?.status !== (next === null ? "exhausted" : "partial"))) ||
        (ownerTrace && data.truncated !== (next !== null))) {
      failure = "Invalid diagnostic page or fixed-window coverage; deploy the matching API before collecting.";
      failLast(failure);
      break;
    }
    const idOf = row => jevReview ? row.eventId : row.id;
    if (rows.some(row => !Number.isSafeInteger(idOf(row)) || idOf(row) <= 0)) {
      failure = "Diagnostic page contains an invalid event ID.";
      failLast(failure);
      break;
    }
    if (jevReview && cursor !== null && next !== null) {
      const old = jevPosition(cursor, since, until), current = jevPosition(next, since, until);
      if (!(current.createdAt > old.createdAt || current.createdAt === old.createdAt && current.id > old.id)) {
        failure = "JEV review cursor did not advance.";
        failLast(failure);
        break;
      }
    }
    if (ownerTrace && cursor !== null && next !== null) {
      const [oldTime, oldId] = cursor.split(":").map(Number);
      const [time, id] = next.split(":").map(Number);
      if (!(time < oldTime || time === oldTime && id < oldId)) {
        failure = "Owner trace cursor did not advance.";
        failLast(failure);
        break;
      }
    }
    for (const row of rows) {
      if (ids.has(idOf(row))) { duplicateRows++; continue; }
      ids.add(idOf(row));
      events.push(row);
    }
    if (next === null) { complete = true; break; }
    if (cursors.has(next) || pages >= pageLimit) {
      failure = `Diagnostic pagination repeated a cursor or reached its ${pageLimit}-page bound.`;
      failLast(failure);
      break;
    }
    cursors.add(next);
    cursor = next;
  }
  if (ownerTrace) events.sort((a, b) => a.serverTime - b.serverTime || a.id - b.id);
  return { since, until, complete, pages, rows: events.length, duplicateRows,
    sourceFiles, deferred, failure, events, truncated: !complete };
}

export function diagnosticCollectionSummary(collection) {
  const { events, ...summary } = collection;
  const outcomes = {};
  for (const row of events) {
    const key = `${row.source || row.type || row.route || "unknown"}:${row.operation || ""}:${row.outcome || row.selectedSource || ""}`;
    outcomes[key] = (outcomes[key] || 0) + 1;
  }
  return { ...summary, outcomes, note: "Metadata only. Read the source pages; this summary does not acknowledge review or prove member outcomes." };
}
