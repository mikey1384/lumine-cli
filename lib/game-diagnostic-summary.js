import { createHash } from "node:crypto";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 10000;
const DELIVERY_NUMBERS = new Set([
  "v", "pending", "acknowledged", "requestFailures", "evicted", "expired",
  "exhausted", "storageFailures", "oversized", "invalid", "attempt", "attempts",
  "failures", "localEvictions", "coalescedBatches", "retryInMs"
]);
const DELIVERY_FIELDS = new Set([...DELIVERY_NUMBERS, "sending", "lastOutcome"]);
const KINDS = new Set([
  "lifecycle", "launch-outcome", "save-failed", "save-ok", "save-load-failed",
  "save-protected", "save-recovered", "soundtrack-diagnostics", "error", "startup"
]);
const EVENTS = new Set([
  "hidden", "visible", "blur", "focus", "pagehide", "session_started", "action",
  "battle_choice", "board_solved", "board_started", "fight_left", "fight_result",
  "fight_started", "input", "lesson_step", "progress", "puzzle_progress",
  "runtime_error", "save_status", "scene", "stalled"
]);
const SOUNDTRACK_COUNTERS = new Set([
  "ready", "recommendations", "recommendations-empty", "tag-load", "tag-search",
  "tag-submit", "tag-remove", "lock-open", "lock-open-failed", "progress-load", "progress-save"
]);
const record = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const stableId = value => typeof value === "string" && /^[\w:.-]{1,160}$/.test(value);
const hash = text => createHash("sha256").update(text).digest("hex");

// Validate the pure helper too: a caller need not have used the CLI's file cap.
// Sort keys for semantic comparison, but never mutate the retained source.
function canonicalJson(value, limit = MAX_BYTES) {
  let bytes = 0;
  const ancestors = new Set();
  const token = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > limit) throw new Error("Game diagnostic JSON exceeds its byte limit.");
    return text;
  };
  function visit(item, depth) {
    if (depth > 32) throw new Error("Game diagnostic JSON exceeds depth 32.");
    if (item === null || typeof item === "boolean") return token(JSON.stringify(item));
    if (typeof item === "number" && Number.isFinite(item)) return token(JSON.stringify(item));
    if (typeof item === "string") {
      if (item.length > limit) throw new Error("Game diagnostic JSON exceeds its byte limit.");
      return token(JSON.stringify(item));
    }
    if ((!Array.isArray(item) && !record(item)) || ancestors.has(item)) throw new Error("Game diagnostics require finite, acyclic JSON values.");
    ancestors.add(item);
    const parts = [];
    if (Array.isArray(item)) {
      parts.push(token("["));
      for (let i = 0; i < item.length; i++) {
        if (i) parts.push(token(","));
        parts.push(visit(item[i], depth + 1));
      }
      parts.push(token("]"));
    } else {
      parts.push(token("{"));
      for (const key of Object.keys(item).sort()) {
        if (parts.length > 1) parts.push(token(","));
        parts.push(token(JSON.stringify(key)), token(":"), visit(item[key], depth + 1));
      }
      parts.push(token("}"));
    }
    ancestors.delete(item);
    return parts.join("");
  }
  return visit(value, 0);
}

function semanticJson(data) {
  if (!record(data.delivery)) return canonicalJson(data, 16384);
  const semantic = { ...data };
  const remaining = Object.entries(data.delivery).filter(([key]) => !DELIVERY_FIELDS.has(key));
  if (remaining.length) semantic.delivery = Object.fromEntries(remaining);
  else delete semantic.delivery;
  return canonicalJson(semantic, 16384);
}

function deliverySnapshot(data) {
  if (!record(data.delivery)) return null;
  const snapshot = {};
  for (const key of DELIVERY_NUMBERS) {
    const value = data.delivery[key];
    if (Number.isSafeInteger(value) && value >= 0) snapshot[key] = value;
  }
  if (typeof data.delivery.sending === "boolean") snapshot.sending = data.delivery.sending;
  if (["none", "viewer-changed", "acknowledged", "failed"].includes(data.delivery.lastOutcome)) snapshot.lastOutcome = data.delivery.lastOutcome;
  return Object.keys(snapshot).length ? snapshot : null;
}

function coverageOf(value) {
  if (value !== undefined && !record(value)) throw new Error("Game diagnostic coverage must be an object.");
  const coverage = { complete: value?.complete === true };
  if (value?.complete !== undefined && typeof value.complete !== "boolean") throw new Error("Coverage complete must be a boolean.");
  for (const key of ["since", "until"]) if (value?.[key] !== undefined) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("Coverage boundaries must be nonnegative integers.");
    coverage[key] = value[key];
  }
  if (coverage.since !== undefined && coverage.until !== undefined && coverage.since >= coverage.until) throw new Error("Coverage until must be after since.");
  return coverage;
}

/** Local, metadata-only summary. Input rows remain the canonical evidence. */
export function summarizeGameDiagnostics(envelope) {
  if (!record(envelope) || !positiveId(envelope.buildId) ||
      typeof envelope.topic !== "string" || !/^[\w.-]{1,100}$/.test(envelope.topic) ||
      !Array.isArray(envelope.entries) || envelope.entries.length > MAX_ROWS) {
    throw new Error("Expected {buildId, topic, entries}; buildId must be positive, topic a technical name and entries at most 10000 rows.");
  }
  canonicalJson(envelope);
  const collection = coverageOf(envelope.coverage);
  const receipts = new Map(), groups = new Map(), legacy = [], observations = [];
  let duplicateInputRows = 0, stableRows = 0, unknownArtifactRows = 0;
  for (const entry of envelope.entries) {
    if (!record(entry) || !positiveId(entry.id) || !positiveId(entry.userId) || !positiveId(entry.topicId) || !record(entry.data)) {
      throw new Error("Every diagnostic entry requires canonical positive id, userId, topicId and object data; payload viewerId is not identity.");
    }
    if (entry.buildId !== undefined && entry.buildId !== envelope.buildId) throw new Error("Entry buildId does not match the envelope.");
    const data = entry.data;
    if (data.artifactVersionId != null && !positiveId(data.artifactVersionId)) throw new Error("artifactVersionId must be positive or unknown.");
    for (const field of ["eventId", "batchId"]) if (data[field] != null && !stableId(data[field])) throw new Error(`Invalid diagnostic ${field}.`);
    const exact = canonicalJson(data, 16384);
    const receiptHash = hash(canonicalJson([entry.userId, entry.topicId, data.artifactVersionId ?? null, exact]));
    if (receipts.has(entry.id)) {
      if (receipts.get(entry.id) !== receiptHash) throw new Error("Conflicting copies of one canonical entry ID; inspect the retained raw source.");
      duplicateInputRows++;
      continue;
    }
    receipts.set(entry.id, receiptHash);
    const artifactVersionId = data.artifactVersionId ?? null;
    if (artifactVersionId === null) unknownArtifactRows++;
    const fields = { entryId: entry.id, userId: entry.userId, topicId: entry.topicId, artifactVersionId };
    const snapshot = deliverySnapshot(data);
    if (snapshot) observations.push({ ...fields, delivery: snapshot });
    const idType = data.eventId != null ? "eventId" : data.batchId != null ? "batchId" : null;
    if (!idType) { legacy.push(data); continue; }
    stableRows++;
    const key = canonicalJson([envelope.buildId, envelope.topic, entry.topicId, entry.userId, artifactVersionId, idType, data[idType]]);
    let group = groups.get(key);
    if (!group) {
      group = { ...fields, idType, stableId: data[idType], hashes: new Map(), rows: 0 };
      groups.set(key, group);
    }
    group.rows++;
    const fingerprint = hash(semanticJson(data));
    let variant = group.hashes.get(fingerprint);
    if (!variant) { variant = { data, entryIds: [] }; group.hashes.set(fingerprint, variant); }
    variant.entryIds.push(entry.id);
  }

  const counted = [...legacy], collisions = [];
  let uniqueStableEvents = 0, retryDuplicateReceipts = 0, collisionGroups = 0, collidingReceipts = 0;
  for (const group of groups.values()) {
    if (group.hashes.size > 1) {
      collisionGroups++; collidingReceipts += group.rows;
      if (collisions.length < 100) collisions.push({ userId: group.userId, topicId: group.topicId,
        artifactVersionId: group.artifactVersionId, idType: group.idType, stableId: group.stableId,
        receipts: group.rows, variants: [...group.hashes].slice(0, 20).map(([sha256, variant]) => ({ sha256,
          entryIds: variant.entryIds.slice(0, 20), omittedEntryIds: Math.max(0, variant.entryIds.length - 20) })),
        omittedVariants: Math.max(0, group.hashes.size - 20) });
      continue;
    }
    uniqueStableEvents++; retryDuplicateReceipts += group.rows - 1;
    counted.push(group.hashes.values().next().value.data);
  }
  const byKind = {}, alzebraEventNames = {}, soundtrackCounters = {};
  let invalidCounterMetrics = 0;
  for (const data of counted) {
    const kind = data.batchId && !data.kind ? "alzebra-batch" : KINDS.has(data.kind) ? data.kind : "other";
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (kind === "alzebra-batch" && Array.isArray(data.events)) for (const event of data.events) {
      const name = EVENTS.has(event?.name) ? event.name : "other";
      alzebraEventNames[name] = (alzebraEventNames[name] || 0) + 1;
    }
    if (kind === "soundtrack-diagnostics" && record(data.counters)) for (const name of SOUNDTRACK_COUNTERS) {
      const value = data.counters[name];
      if (value === undefined) continue;
      if (!record(value) || !["count", "failed", "durationMs", "maxMs"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1e11) || value.failed > value.count) {
        invalidCounterMetrics++;
        continue;
      }
      const total = soundtrackCounters[name] ||= { count: 0, failed: 0, durationMs: 0, maxMs: 0 };
      total.count += value.count; total.failed += value.failed; total.durationMs += value.durationMs;
      total.maxMs = Math.max(total.maxMs, value.maxMs);
    }
  }
  observations.sort((a, b) => b.entryId - a.entryId);
  return {
    schema: 1, buildId: envelope.buildId, topic: envelope.topic, collection,
    rows: { input: envelope.entries.length, canonical: receipts.size, duplicateInputRows,
      stableRows, legacyRows: legacy.length, unknownArtifactRows },
    deduplication: { coverage: receipts.size === 0 ? "empty" : legacy.length || unknownArtifactRows || collisionGroups ? "partial" : "complete",
      uniqueStableEvents, retryDuplicateReceipts, collisionGroups, collidingReceipts,
      countedEvents: counted.length, collisions, omittedCollisions: Math.max(0, collisionGroups - collisions.length) },
    counts: { byKind, alzebraEventNames, soundtrackCounters, invalidCounterMetrics },
    delivery: { observations: observations.slice(0, 100), totalObservations: observations.length,
      omittedObservations: Math.max(0, observations.length - 100),
      note: "Per-receipt client snapshots; cumulative counters are not summed. An acknowledged count concerns earlier client receipts, not this row's gameplay save." },
    note: "Preserve and read the raw receipts. Legacy rows remain separate and may contain retries; unknown artifacts are not version evidence. Collisions are excluded from event counts. Collection completeness describes supplied server rows, not successful delivery of every client event."
  };
}
