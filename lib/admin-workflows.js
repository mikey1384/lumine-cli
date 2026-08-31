import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { writeAdminJsonFile, readAdminJsonFile } from "./admin-news.js";
import { requestJson } from "./http.js";

const MAX_BATCH_TARGET_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_TARGETS = 20_000;
const MAX_AUTOMATIC_PAGES = 100_000;
const MAX_LEGACY_ADMIN_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_PAGINATION_CHECKPOINT_BYTES = 256 * 1024;
const MAX_BATCH_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const ADMIN_PAGINATION_SCHEMA_VERSION = 3;
const LEGACY_ADMIN_PAGINATION_SCHEMA_VERSION = 2;
const ADMIN_BATCH_SCHEMA_VERSION = 2;
const PAGINATED_RESULT_STORAGE = Symbol("lumineAdminPaginationStorage");
const SPOOL_READ_BUFFER_BYTES = 64 * 1024;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeBoundary(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw validationError(`The API returned an invalid ${label} boundary.`);
  }
  return normalized;
}

function normalizeScannedCount(value, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw validationError("The API returned an invalid scannedCount value.");
  }
  return candidate;
}

function assertStableBoundary(label, expected, actual) {
  if (expected === actual) return;
  throw validationError(
    `The API changed ${label} while paging one canonical snapshot. Start a fresh scan.`,
  );
}

function pathWithCursor(requestPath, cursor) {
  const url = new URL(requestPath, "https://lumine.invalid");
  if (cursor) url.searchParams.set("cursor", cursor);
  else url.searchParams.delete("cursor");
  return `${url.pathname}${url.search}`;
}

function defaultCheckpointPath({ runId, operationName }) {
  const safeName = String(operationName).replace(/[^a-z0-9_.-]+/gi, "-");
  return path.join(os.tmpdir(), `lumine-admin-run-${runId}-${safeName}.json`);
}

function operationFingerprintValue({
  schemaVersion,
  options,
  operation,
  runId,
}) {
  return fingerprint({
    workflowSchemaVersion: schemaVersion,
    runId,
    apiUrl: String(options.apiUrl || "").replace(/\/$/, ""),
    name: operation.name,
    path: pathWithCursor(operation.path, ""),
    pagination: {
      collectionKey: operation.pagination.collectionKey,
      coverageQueue: operation.pagination.coverageQueue || null,
      coverageMode: operation.pagination.coverageMode || null,
      after: operation.pagination.after ?? null,
      filters: operation.pagination.filters || {},
    },
  });
}

function candidateSpoolPath(checkpointPath) {
  return `${checkpointPath}.candidates-${randomUUID()}.ndjson`;
}

function candidateSpoolBelongsToCheckpoint({ checkpointPath, spoolPath }) {
  const resolvedCheckpoint = path.resolve(checkpointPath);
  const resolvedSpool = path.resolve(String(spoolPath || ""));
  const expectedPrefix = `${path.basename(resolvedCheckpoint)}.candidates-`;
  const spoolName = path.basename(resolvedSpool);
  const spoolIdentifier = spoolName.slice(
    expectedPrefix.length,
    -".ndjson".length,
  );
  return (
    path.dirname(resolvedSpool) === path.dirname(resolvedCheckpoint) &&
    spoolName.startsWith(expectedPrefix) &&
    spoolName.endsWith(".ndjson") &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      spoolIdentifier,
    )
  );
}

function createCandidateSpool(checkpointPath) {
  const spoolPath = candidateSpoolPath(checkpointPath);
  mkdirSync(path.dirname(spoolPath), { recursive: true });
  const descriptor = openSync(spoolPath, "wx", 0o600);
  closeSync(descriptor);
  chmodSync(spoolPath, 0o600);
  return {
    spoolPath,
    spoolHash: createHash("sha256"),
    spoolBytes: 0,
    spoolSha256: createHash("sha256").digest("hex"),
  };
}

function loadSupersededCandidateSpool(checkpointPath) {
  let saved;
  try {
    saved = readAdminJsonFile(checkpointPath, "the previous pagination checkpoint", {
      maxBytes: MAX_LEGACY_ADMIN_CHECKPOINT_BYTES,
    });
  } catch {
    return null;
  }
  const spoolPath = path.resolve(String(saved?.spoolPath || ""));
  if (
    saved?.kind !== "admin-pagination" ||
    Number(saved?.schemaVersion) !== ADMIN_PAGINATION_SCHEMA_VERSION ||
    !candidateSpoolBelongsToCheckpoint({ checkpointPath, spoolPath })
  ) {
    return null;
  }
  try {
    const fileState = lstatSync(spoolPath);
    return fileState.isFile() && !fileState.isSymbolicLink() ? spoolPath : null;
  } catch {
    return null;
  }
}

function appendCandidateItems({ spoolPath, spoolHash, items }) {
  const lines = items.map((item) => {
    const serialized = JSON.stringify(item);
    if (serialized === undefined) {
      throw validationError(
        "The API returned a pagination candidate that cannot be serialized.",
      );
    }
    return serialized;
  });
  if (lines.length === 0) {
    return { addedBytes: 0, spoolSha256: spoolHash.copy().digest("hex") };
  }
  const payload = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  const descriptor = openSync(spoolPath, "a", 0o600);
  try {
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  spoolHash.update(payload);
  return {
    addedBytes: payload.byteLength,
    spoolSha256: spoolHash.copy().digest("hex"),
  };
}

function normalizeCheckpointCount(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw validationError(`The pagination checkpoint has an invalid ${label}.`);
  }
  return normalized;
}

function normalizeFilterCount(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw validationError(`Pagination has an invalid ${label}.`);
  }
  return normalized;
}

function normalizeClientFilterSummary(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Pagination has invalid client-filter metadata.");
  }
  if (
    !Array.isArray(value.contentTypes) ||
    value.contentTypes.some(
      (contentType) =>
        typeof contentType !== "string" || !contentType.trim(),
    )
  ) {
    throw validationError(
      "Pagination has invalid client-filter content types.",
    );
  }
  return {
    contentTypes: value.contentTypes.map((contentType) => contentType.trim()),
    excludedItems: normalizeFilterCount(
      value.excludedItems,
      "client-filter excludedItems count",
    ),
  };
}

function accumulateClientFilterSummary(previous, pageValue) {
  const page = normalizeClientFilterSummary(pageValue);
  if (!page) return previous;
  if (!previous) return page;
  if (
    JSON.stringify(previous.contentTypes) !== JSON.stringify(page.contentTypes)
  ) {
    throw validationError(
      "The client-side content filter changed while paging one canonical snapshot.",
    );
  }
  return {
    ...previous,
    excludedItems: normalizeFilterCount(
      previous.excludedItems + page.excludedItems,
      "client-filter aggregate excludedItems count",
    ),
  };
}

function normalizeOperatorViewFilterSummary(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Pagination has invalid operator-view metadata.");
  }
  const mode = String(value.mode || "").trim();
  if (!mode) {
    throw validationError("Pagination has an invalid operator-view mode.");
  }
  return {
    mode,
    excludedItems: normalizeFilterCount(
      value.excludedItems,
      "operator-view excludedItems count",
    ),
    unknownStateItems: normalizeFilterCount(
      value.unknownStateItems,
      "operator-view unknownStateItems count",
    ),
  };
}

function accumulateOperatorViewFilterSummary(previous, pageValue) {
  const page = normalizeOperatorViewFilterSummary(pageValue);
  if (!page) return previous;
  if (!previous) return page;
  if (previous.mode !== page.mode) {
    throw validationError(
      "The operator-view filter changed while paging one canonical snapshot.",
    );
  }
  return {
    ...previous,
    excludedItems: normalizeFilterCount(
      previous.excludedItems + page.excludedItems,
      "operator-view aggregate excludedItems count",
    ),
    unknownStateItems: normalizeFilterCount(
      previous.unknownStateItems + page.unknownStateItems,
      "operator-view aggregate unknownStateItems count",
    ),
  };
}

function verifyCandidateSpool({
  checkpointPath,
  spoolPath,
  spoolBytes,
  spoolSha256,
  candidateCount,
  discardUnconfirmedTail,
}) {
  if (!candidateSpoolBelongsToCheckpoint({ checkpointPath, spoolPath })) {
    throw validationError(
      "The pagination checkpoint references an invalid candidate spool.",
    );
  }
  const confirmedBytes = normalizeCheckpointCount(spoolBytes, "spoolBytes");
  const confirmedCount = normalizeCheckpointCount(
    candidateCount,
    "candidateCount",
  );
  const expectedDigest = String(spoolSha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw validationError(
      "The pagination checkpoint has an invalid candidate-spool digest.",
    );
  }
  let fileState;
  try {
    fileState = lstatSync(spoolPath);
  } catch {
    throw validationError(`Could not read pagination candidates at ${spoolPath}.`);
  }
  if (!fileState.isFile() || fileState.isSymbolicLink()) {
    throw validationError(
      "The pagination candidate spool must be a regular private file.",
    );
  }
  if (fileState.size < confirmedBytes) {
    throw validationError(
      "The pagination candidate spool is shorter than its confirmed checkpoint.",
    );
  }
  if (fileState.size > confirmedBytes) {
    if (!discardUnconfirmedTail) {
      throw validationError(
        "The pagination candidate spool changed after its checkpoint was confirmed.",
      );
    }
    truncateSync(spoolPath, confirmedBytes);
  }
  chmodSync(spoolPath, 0o600);
  const spoolHash = createHash("sha256");
  const descriptor = openSync(spoolPath, "r");
  const buffer = Buffer.allocUnsafe(SPOOL_READ_BUFFER_BYTES);
  let remaining = confirmedBytes;
  let lineCount = 0;
  try {
    while (remaining > 0) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, remaining),
        null,
      );
      if (bytesRead <= 0) {
        throw validationError(
          "The pagination candidate spool ended before its confirmed boundary.",
        );
      }
      const chunk = buffer.subarray(0, bytesRead);
      spoolHash.update(chunk);
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] === 10) lineCount += 1;
      }
      remaining -= bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  if (lineCount !== confirmedCount) {
    throw validationError(
      "The pagination candidate spool count does not match its checkpoint.",
    );
  }
  if (spoolHash.copy().digest("hex") !== expectedDigest) {
    throw validationError(
      "The pagination candidate spool does not match its confirmed checkpoint digest.",
    );
  }
  return spoolHash;
}

function writePaginationCheckpoint(checkpointPath, state) {
  const { resumed: _resumed, ...checkpoint } = state;
  writeAdminJsonFile(
    checkpointPath,
    { ...checkpoint, updatedAt: new Date().toISOString() },
    { privateFile: true, maxBytes: MAX_PAGINATION_CHECKPOINT_BYTES },
  );
}

function paginationStorageFromResult(result) {
  return result?.[PAGINATED_RESULT_STORAGE] || null;
}

export function getPaginatedResultStorage(result) {
  const storage = paginationStorageFromResult(result);
  return storage ? { ...storage } : null;
}

function attachPaginationStorage(result, storage) {
  Object.defineProperty(result, PAGINATED_RESULT_STORAGE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...storage }),
  });
  return result;
}

function serializedObjectEntries(value, excludedKeys = new Set()) {
  const entries = [];
  for (const [key, entryValue] of Object.entries(value || {})) {
    if (excludedKeys.has(key)) continue;
    const serialized = JSON.stringify(entryValue);
    if (serialized !== undefined) {
      entries.push(`${JSON.stringify(key)}:${serialized}`);
    }
  }
  return entries;
}

export async function forEachPaginatedResultItem(result, visit) {
  const storage = paginationStorageFromResult(result);
  if (!storage) {
    throw validationError("The result does not contain spooled pagination data.");
  }
  verifyCandidateSpool({ ...storage, discardUnconfirmedTail: false });
  const input = createReadStream(storage.spoolPath, { encoding: "utf8" });
  const observedHash = createHash("sha256");
  let observedBytes = 0;
  input.on("data", (chunk) => {
    observedHash.update(chunk, "utf8");
    observedBytes += Buffer.byteLength(chunk, "utf8");
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let index = 0;
  try {
    for await (const line of lines) {
      if (!line) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        throw validationError(
          "The pagination candidate spool contains invalid JSON.",
        );
      }
      await visit(item, index);
      index += 1;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (index !== storage.candidateCount) {
    throw validationError(
      "The pagination candidate spool changed while it was being read.",
    );
  }
  if (
    observedBytes !== storage.spoolBytes ||
    observedHash.digest("hex") !== storage.spoolSha256
  ) {
    throw validationError(
      "The pagination candidate spool changed while it was being read.",
    );
  }
}

export async function writePaginatedResultJson({ result, write }) {
  const storage = paginationStorageFromResult(result);
  if (!storage) {
    await write(`${JSON.stringify(result)}\n`);
    return;
  }
  const outerEntries = serializedObjectEntries(result, new Set(["data"]));
  const dataEntries = serializedObjectEntries(
    result.data,
    new Set([storage.collectionKey]),
  );
  let prefix = "{";
  if (outerEntries.length > 0) prefix += outerEntries.join(",");
  if (outerEntries.length > 0) prefix += ",";
  prefix += `${JSON.stringify("data")}:{`;
  if (dataEntries.length > 0) prefix += `${dataEntries.join(",")},`;
  prefix += `${JSON.stringify(storage.collectionKey)}:[`;
  await write(prefix);
  let wroteItem = false;
  await forEachPaginatedResultItem(result, async (item) => {
    await write(`${wroteItem ? "," : ""}${JSON.stringify(item)}`);
    wroteItem = true;
  });
  await write("]}}\n");
}

async function writePaginatedResultFile(filePath, result) {
  const resolved = path.resolve(String(filePath || "").trim());
  if (!String(filePath || "").trim()) {
    throw validationError("An output file path is required.");
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    await writePaginatedResultJson({
      result,
      write: async (chunk) => writeFileSync(descriptor, chunk, "utf8"),
    });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, resolved);
    chmodSync(resolved, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The failed write may already have closed the descriptor.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Exclusive create or successful rename may leave nothing to clean.
    }
    throw error;
  }
  return resolved;
}

function aggregatePageResult({ operation, lastPage, checkpointPath, state }) {
  const last = lastPage || { ok: true, status: "success", data: {} };
  const lastData = { ...(last.data || {}) };
  delete lastData[operation.pagination.collectionKey];
  const lastPagination = { ...(last.data?.pagination || {}) };
  const pageScannedCount = normalizeScannedCount(
    lastPagination.scannedCount,
    0,
  );
  delete lastPagination.scannedCount;
  if (state.filterSummariesComplete) {
    if (state.clientFilter) lastData.clientFilter = state.clientFilter;
    else delete lastData.clientFilter;
    if (state.operatorViewFilter) {
      lastData.operatorViewFilter = state.operatorViewFilter;
    } else {
      delete lastData.operatorViewFilter;
    }
  } else {
    // Legacy v2 checkpoints stored filtered candidates but not exact per-page
    // exclusion counters. Do not present a last-page subtotal as a full-scan
    // total after migrating one of those checkpoints.
    delete lastData.clientFilter;
    delete lastData.operatorViewFilter;
  }
  const candidateStorage = {
    format: "ndjson",
    path: state.spoolPath,
    byteLength: state.spoolBytes,
    sha256: state.spoolSha256,
  };
  const result = {
    ...last,
    data: {
      ...lastData,
      pagination: {
        ...lastPagination,
        pageScannedCount,
        nextCursor: state.nextCursor,
        hasMore: !state.exhausted,
        exhausted: state.exhausted,
        after: state.after,
        snapshotMaxId: state.snapshotMaxId,
        snapshotTimeStamp: state.snapshotTimeStamp,
      },
      scan: {
        pages: state.pages,
        scannedCount: state.scannedCount,
        candidateCount: state.candidateCount,
        checkpointPath,
        resumed: state.resumed,
        filterSummariesComplete: state.filterSummariesComplete,
        candidateStorage,
      },
    },
  };
  return attachPaginationStorage(result, {
    checkpointPath,
    collectionKey: operation.pagination.collectionKey,
    spoolPath: state.spoolPath,
    spoolBytes: state.spoolBytes,
    spoolSha256: state.spoolSha256,
    candidateCount: state.candidateCount,
  });
}

export async function runAutomaticPagination({
  options,
  operation,
  runId,
  fetchPage,
  transformPage,
  recordCoverage,
  reportProgress = (message) => process.stderr.write(`${message}\n`),
}) {
  if (!operation.pagination) {
    throw validationError("--all is supported only by paginated admin listings.");
  }
  const checkpointPath = path.resolve(
    options.adminCheckpoint ||
      defaultCheckpointPath({ runId, operationName: operation.name }),
  );
  const requestedOutputPath = String(options.adminOutput || "").trim();
  if (options.adminOutput && !requestedOutputPath) {
    throw validationError("An output file path is required.");
  }
  const outputPath = requestedOutputPath
    ? path.resolve(requestedOutputPath)
    : null;
  if (outputPath === checkpointPath) {
    throw validationError(
      "The pagination checkpoint and result output must use different files.",
    );
  }
  const operationFingerprint = operationFingerprintValue({
    schemaVersion: ADMIN_PAGINATION_SCHEMA_VERSION,
    options,
    operation,
    runId,
  });
  const legacyOperationFingerprint = operationFingerprintValue({
    schemaVersion: LEGACY_ADMIN_PAGINATION_SCHEMA_VERSION,
    options,
    operation,
    runId,
  });
  let state = {
    schemaVersion: ADMIN_PAGINATION_SCHEMA_VERSION,
    kind: "admin-pagination",
    operationFingerprint,
    runId,
    operationName: operation.name,
    nextCursor: "",
    exhausted: false,
    pages: 0,
    scannedCount: 0,
    snapshotMaxId: null,
    snapshotTimeStamp: null,
    after: operation.pagination.after ?? null,
    boundariesConfirmed: false,
    candidateCount: 0,
    spoolPath: "",
    spoolBytes: 0,
    spoolSha256: "",
    filterSummariesComplete: true,
    clientFilter: null,
    operatorViewFilter: null,
    resumed: false,
    updatedAt: new Date().toISOString(),
  };
  let spoolHash;
  if (options.adminResume) {
    const saved = readAdminJsonFile(
      checkpointPath,
      "the pagination checkpoint",
      { maxBytes: MAX_LEGACY_ADMIN_CHECKPOINT_BYTES },
    );
    const savedSchemaVersion = Number(saved?.schemaVersion);
    const savedPages = normalizeCheckpointCount(saved?.pages, "pages");
    const savedScannedCount = normalizeCheckpointCount(
      saved?.scannedCount,
      "scannedCount",
    );
    const baseMatches =
      saved?.kind === "admin-pagination" &&
      Number(saved?.runId) === runId &&
      ((savedPages === 0 && saved?.boundariesConfirmed === false) ||
        (savedPages > 0 && saved?.boundariesConfirmed === true));
    const currentMatches =
      savedSchemaVersion === ADMIN_PAGINATION_SCHEMA_VERSION &&
      saved?.operationFingerprint === operationFingerprint;
    const legacyMatches =
      savedSchemaVersion === LEGACY_ADMIN_PAGINATION_SCHEMA_VERSION &&
      saved?.operationFingerprint === legacyOperationFingerprint &&
      Array.isArray(saved?.items) &&
      savedPages > 0;
    if (!baseMatches || (!currentMatches && !legacyMatches)) {
      throw validationError(
        "The checkpoint does not belong to this run and exact listing request.",
      );
    }
    const savedNextCursor = String(saved?.nextCursor || "");
    const savedExhausted = saved?.exhausted;
    if (
      typeof savedExhausted !== "boolean" ||
      (!savedExhausted && savedPages > 0 && !savedNextCursor) ||
      (savedExhausted && savedNextCursor)
    ) {
      throw validationError(
        "The pagination checkpoint has inconsistent exhaustion metadata.",
      );
    }
    if (legacyMatches) {
      const createdSpool = createCandidateSpool(checkpointPath);
      spoolHash = createdSpool.spoolHash;
      let spoolBytes = 0;
      let spoolSha256 = createdSpool.spoolSha256;
      try {
        for (let index = 0; index < saved.items.length; index += 250) {
          const appended = appendCandidateItems({
            spoolPath: createdSpool.spoolPath,
            spoolHash,
            items: saved.items.slice(index, index + 250),
          });
          spoolBytes += appended.addedBytes;
          spoolSha256 = appended.spoolSha256;
        }
        state = {
          ...state,
          nextCursor: savedNextCursor,
          exhausted: savedExhausted,
          pages: savedPages,
          scannedCount: savedScannedCount,
          snapshotMaxId: normalizeBoundary(
            saved?.snapshotMaxId,
            "snapshotMaxId",
          ),
          snapshotTimeStamp: normalizeBoundary(
            saved?.snapshotTimeStamp,
            "snapshotTimeStamp",
          ),
          after: normalizeBoundary(saved?.after, "after"),
          boundariesConfirmed: true,
          candidateCount: saved.items.length,
          spoolPath: createdSpool.spoolPath,
          spoolBytes,
          spoolSha256,
          filterSummariesComplete: false,
          resumed: true,
        };
        writePaginationCheckpoint(checkpointPath, state);
      } catch (error) {
        try {
          unlinkSync(createdSpool.spoolPath);
        } catch {
          // A failed migration may have created no durable candidate spool.
        }
        throw error;
      }
    } else {
      const candidateCount = normalizeCheckpointCount(
        saved?.candidateCount,
        "candidateCount",
      );
      state = {
        ...state,
        nextCursor: savedNextCursor,
        exhausted: savedExhausted,
        pages: savedPages,
        scannedCount: savedScannedCount,
        snapshotMaxId:
          savedPages > 0
            ? normalizeBoundary(saved?.snapshotMaxId, "snapshotMaxId")
            : null,
        snapshotTimeStamp:
          savedPages > 0
            ? normalizeBoundary(
                saved?.snapshotTimeStamp,
                "snapshotTimeStamp",
              )
            : null,
        after:
          savedPages > 0
            ? normalizeBoundary(saved?.after, "after")
            : operation.pagination.after ?? null,
        boundariesConfirmed: saved?.boundariesConfirmed,
        candidateCount,
        spoolPath: path.resolve(String(saved?.spoolPath || "")),
        spoolBytes: normalizeCheckpointCount(saved?.spoolBytes, "spoolBytes"),
        spoolSha256: String(saved?.spoolSha256 || "").toLowerCase(),
        filterSummariesComplete:
          savedPages === 0 || saved?.filterSummariesComplete === true,
        clientFilter:
          savedPages > 0 && saved?.filterSummariesComplete === true
            ? normalizeClientFilterSummary(saved?.clientFilter)
            : null,
        operatorViewFilter:
          savedPages > 0 && saved?.filterSummariesComplete === true
            ? normalizeOperatorViewFilterSummary(saved?.operatorViewFilter)
            : null,
        resumed: true,
      };
      spoolHash = verifyCandidateSpool({
        checkpointPath,
        spoolPath: state.spoolPath,
        spoolBytes: state.spoolBytes,
        spoolSha256: state.spoolSha256,
        candidateCount: state.candidateCount,
        discardUnconfirmedTail: true,
      });
    }
  } else {
    const supersededSpoolPath = loadSupersededCandidateSpool(checkpointPath);
    const createdSpool = createCandidateSpool(checkpointPath);
    spoolHash = createdSpool.spoolHash;
    state.spoolPath = createdSpool.spoolPath;
    state.spoolBytes = createdSpool.spoolBytes;
    state.spoolSha256 = createdSpool.spoolSha256;
    try {
      writePaginationCheckpoint(checkpointPath, state);
    } catch (error) {
      try {
        unlinkSync(state.spoolPath);
      } catch {
        // The failed initialization may leave no spool to clean.
      }
      throw error;
    }
    if (supersededSpoolPath && supersededSpoolPath !== state.spoolPath) {
      try {
        unlinkSync(supersededSpoolPath);
      } catch (error) {
        reportProgress(
          `Lumine admin ${operation.name}: could not remove superseded candidate spool ${supersededSpoolPath} (${error?.message || error}).`,
        );
      }
    }
  }
  if (outputPath === path.resolve(state.spoolPath)) {
    throw validationError(
      "The pagination candidate spool and result output must use different files.",
    );
  }
  const progressEnabled = options.json === true;
  if (progressEnabled) {
    reportProgress(
      `Lumine admin ${operation.name}: ${state.resumed ? "resuming" : "starting"} canonical scan; checkpoint ${checkpointPath}.`,
    );
  }
  let lastPage = null;
  while (!state.exhausted) {
    if (state.pages >= MAX_AUTOMATIC_PAGES) {
      throw validationError(
        `Automatic pagination stopped at the ${MAX_AUTOMATIC_PAGES}-page safety ceiling. Start a narrower request with a new checkpoint.`,
      );
    }
    const requestPath = pathWithCursor(operation.path, state.nextCursor);
    const raw = await fetchPage(requestPath);
    const page = transformPage(raw);
    lastPage = page;
    const data = page?.data || {};
    const pagination = data.pagination;
    if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
      throw validationError("The API response is missing canonical pagination metadata.");
    }
    const items = Array.isArray(data[operation.pagination.collectionKey])
      ? data[operation.pagination.collectionKey]
      : [];
    if (typeof pagination.exhausted !== "boolean") {
      throw validationError(
        "The API must explicitly confirm whether the canonical snapshot is exhausted.",
      );
    }
    const nextCursor = String(pagination.nextCursor || "");
    if (nextCursor && nextCursor === state.nextCursor) {
      throw validationError("The API returned the same pagination cursor twice.");
    }
    if (!pagination.exhausted && !nextCursor) {
      throw validationError(
        "The API reported more canonical pages without returning the next cursor.",
      );
    }
    if (pagination.exhausted && nextCursor) {
      throw validationError(
        "The API returned a next cursor after declaring the canonical snapshot exhausted.",
      );
    }
    const pageSnapshotMaxId = normalizeBoundary(
      pagination.snapshotMaxId,
      "snapshotMaxId",
    );
    const pageSnapshotTimeStamp = normalizeBoundary(
      pagination.snapshotTimeStamp,
      "snapshotTimeStamp",
    );
    const pageAfter = normalizeBoundary(pagination.after, "after");
    if (state.boundariesConfirmed) {
      assertStableBoundary("snapshotMaxId", state.snapshotMaxId, pageSnapshotMaxId);
      assertStableBoundary(
        "snapshotTimeStamp",
        state.snapshotTimeStamp,
        pageSnapshotTimeStamp,
      );
      assertStableBoundary("after", state.after, pageAfter);
    } else {
      const requestedAfter = normalizeBoundary(operation.pagination.after, "after");
      if (requestedAfter !== null) {
        assertStableBoundary("after", requestedAfter, pageAfter);
      }
      state.snapshotMaxId = pageSnapshotMaxId;
      state.snapshotTimeStamp = pageSnapshotTimeStamp;
      state.after = requestedAfter ?? pageAfter;
      state.boundariesConfirmed = true;
    }
    const appended = appendCandidateItems({
      spoolPath: state.spoolPath,
      spoolHash,
      items,
    });
    const clientFilter = state.filterSummariesComplete
      ? accumulateClientFilterSummary(state.clientFilter, data.clientFilter)
      : null;
    const operatorViewFilter = state.filterSummariesComplete
      ? accumulateOperatorViewFilterSummary(
          state.operatorViewFilter,
          data.operatorViewFilter,
        )
      : null;
    const nextState = {
      ...state,
      pages: state.pages + 1,
      scannedCount:
        state.scannedCount +
        normalizeScannedCount(
          pagination.scannedCount,
          items.length,
        ),
      candidateCount: state.candidateCount + items.length,
      spoolBytes: state.spoolBytes + appended.addedBytes,
      spoolSha256: appended.spoolSha256,
      clientFilter,
      operatorViewFilter,
      nextCursor,
      exhausted: pagination.exhausted,
      updatedAt: new Date().toISOString(),
    };
    writePaginationCheckpoint(checkpointPath, nextState);
    state = nextState;
    if (
      progressEnabled &&
      (state.pages === 1 || state.pages % 10 === 0 || state.exhausted)
    ) {
      reportProgress(
        `Lumine admin ${operation.name}: ${state.pages} page(s), ${state.scannedCount} row(s) scanned, ${state.candidateCount} candidate(s)${state.exhausted ? "; canonical snapshot exhausted." : "; continuing."}`,
      );
    }
  }
  const result = aggregatePageResult({
    operation,
    lastPage,
    checkpointPath,
    state,
  });
  if (recordCoverage && operation.pagination.coverageQueue) {
    await recordCoverage({
      queue: operation.pagination.coverageQueue,
      mode: operation.pagination.coverageMode || "all",
      after: state.after,
      pages: state.pages,
      scannedCount: state.scannedCount,
      candidateCount: state.candidateCount,
      snapshotMaxId: state.snapshotMaxId,
      snapshotTimeStamp: state.snapshotTimeStamp,
      exhausted: state.exhausted,
      filters: operation.pagination.filters || {},
    });
  }
  if (outputPath) {
    result.data.scan.outputPath = outputPath;
    await writePaginatedResultFile(outputPath, result);
  }
  return result;
}

export function readBatchSkipTargets({ filePath, parseTarget, defaultReason }) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw validationError("Pass batch skip targets with --target-file <file>.");
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw validationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_BATCH_TARGET_FILE_BYTES) {
    throw validationError("The batch target file must be under 2 MB.");
  }
  let values;
  try {
    const parsed = JSON.parse(contents);
    values = Array.isArray(parsed) ? parsed : parsed?.targets;
  } catch {
    values = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw validationError("The batch target file contains no targets.");
  }
  if (values.length > MAX_BATCH_TARGETS) {
    throw validationError(`A batch can contain at most ${MAX_BATCH_TARGETS} targets.`);
  }
  const deduped = new Map();
  for (const value of values) {
    const rawTarget =
      typeof value === "string" ? value : value?.target || value?.url || value?.id;
    const parsed = parseTarget({
      target: rawTarget,
      explicitType: typeof value === "object" ? value?.type || "" : "",
    });
    if (parsed.type === "subject") {
      throw validationError(
        "Batch skips accept comment, aiStory, or dailyReflection targets, not subjects.",
      );
    }
    const key = `${parsed.type}:${parsed.id}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        key,
        type: parsed.type,
        id: parsed.id,
        reason:
          typeof value === "object" && value?.reason
            ? String(value.reason)
            : String(defaultReason || "") || undefined,
      });
    }
  }
  return [...deduped.values()];
}

export async function runBatchSkips({
  options,
  authToken,
  runId,
  parseTarget,
}) {
  const targets = readBatchSkipTargets({
    filePath: options.adminTargetFile,
    parseTarget,
    defaultReason: options.adminReason,
  });
  const batchFingerprint = fingerprint({
    workflowSchemaVersion: ADMIN_BATCH_SCHEMA_VERSION,
    apiUrl: String(options.apiUrl || "").replace(/\/$/, ""),
    targets,
  });
  const checkpointPath = path.resolve(
    options.adminCheckpoint ||
      defaultCheckpointPath({ runId, operationName: "post.skip-batch" }),
  );
  let state = {
    schemaVersion: ADMIN_BATCH_SCHEMA_VERSION,
    kind: "admin-skip-batch",
    runId,
    batchFingerprint,
    targetCount: targets.length,
    completed: {},
    updatedAt: new Date().toISOString(),
  };
  if (options.adminResume) {
    const saved = readAdminJsonFile(checkpointPath, "the batch checkpoint", {
      maxBytes: MAX_BATCH_CHECKPOINT_BYTES,
    });
    if (
      saved?.schemaVersion !== ADMIN_BATCH_SCHEMA_VERSION ||
      saved?.kind !== "admin-skip-batch" ||
      Number(saved.runId) !== runId ||
      saved.batchFingerprint !== batchFingerprint ||
      !saved.completed ||
      typeof saved.completed !== "object"
    ) {
      throw validationError("The checkpoint does not match this exact skip batch.");
    }
    state = saved;
  } else {
    writeAdminJsonFile(checkpointPath, state, {
      privateFile: true,
      maxBytes: MAX_BATCH_CHECKPOINT_BYTES,
    });
  }
  for (const target of targets) {
    if (state.completed[target.key]) continue;
    const result = await requestJson({
      method: "POST",
      url: `${options.apiUrl}/cli/admin/skips/${target.type}/${target.id}`,
      authToken,
      body: { reason: target.reason },
      headers: {
        "x-lumine-admin-run-id": String(runId),
        "x-lumine-idempotency-key": `cli:skip-batch:${runId}:${batchFingerprint.slice(0, 12)}:${fingerprint(target.key).slice(0, 24)}`,
      },
      timeoutMs: options.timeoutMs,
    });
    state.completed[target.key] = {
      status: result?.status || "success",
      changed: result?.changed === true,
      completedAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    writeAdminJsonFile(checkpointPath, state, {
      privateFile: true,
      maxBytes: MAX_BATCH_CHECKPOINT_BYTES,
    });
  }
  const result = {
    ok: true,
    status: "success",
    changed: Object.values(state.completed).some((entry) => entry.changed),
    data: {
      batch: {
        targetCount: targets.length,
        completedCount: Object.keys(state.completed).length,
        changedCount: Object.values(state.completed).filter((entry) => entry.changed)
          .length,
        checkpointPath,
        resumed: options.adminResume === true,
        targets: state.completed,
      },
    },
  };
  if (options.adminOutput) {
    result.data.batch.outputPath = writeAdminJsonFile(options.adminOutput, result, {
      privateFile: true,
      maxBytes: MAX_BATCH_CHECKPOINT_BYTES,
    });
  }
  return result;
}
