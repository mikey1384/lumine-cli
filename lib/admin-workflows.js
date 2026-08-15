import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeAdminJsonFile, readAdminJsonFile } from "./admin-news.js";
import { requestJson } from "./http.js";

const MAX_BATCH_TARGET_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_TARGETS = 20_000;
const MAX_AUTOMATIC_PAGES = 100_000;
const MAX_ADMIN_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const ADMIN_PAGINATION_SCHEMA_VERSION = 2;
const ADMIN_BATCH_SCHEMA_VERSION = 2;

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

function aggregatePageResult({ operation, pages, checkpointPath, state }) {
  const last = pages[pages.length - 1] || { ok: true, status: "success", data: {} };
  return {
    ...last,
    data: {
      ...(last.data || {}),
      [operation.pagination.collectionKey]: state.items,
      pagination: {
        ...(last.data?.pagination || {}),
        nextCursor: state.nextCursor,
        hasMore: !state.exhausted,
        exhausted: state.exhausted,
        after: state.after,
        snapshotTimeStamp: state.snapshotTimeStamp,
      },
      scan: {
        pages: state.pages,
        scannedCount: state.scannedCount,
        candidateCount: state.items.length,
        checkpointPath,
        resumed: state.resumed,
      },
    },
  };
}

export async function runAutomaticPagination({
  options,
  operation,
  runId,
  fetchPage,
  transformPage,
  recordCoverage,
}) {
  if (!operation.pagination) {
    throw validationError("--all is supported only by paginated admin listings.");
  }
  const checkpointPath = path.resolve(
    options.adminCheckpoint ||
      defaultCheckpointPath({ runId, operationName: operation.name }),
  );
  const operationFingerprint = fingerprint({
    workflowSchemaVersion: ADMIN_PAGINATION_SCHEMA_VERSION,
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
    items: [],
    resumed: false,
    updatedAt: new Date().toISOString(),
  };
  if (options.adminResume) {
    const saved = readAdminJsonFile(
      checkpointPath,
      "the pagination checkpoint",
      { maxBytes: MAX_ADMIN_CHECKPOINT_BYTES },
    );
    if (
      saved?.schemaVersion !== ADMIN_PAGINATION_SCHEMA_VERSION ||
      saved?.kind !== "admin-pagination" ||
      saved?.operationFingerprint !== operationFingerprint ||
      Number(saved?.runId) !== runId ||
      !Array.isArray(saved?.items) ||
      saved?.boundariesConfirmed !== true
    ) {
      throw validationError(
        "The checkpoint does not belong to this run and exact listing request.",
      );
    }
    state = { ...state, ...saved, resumed: true };
  }
  const pages = [];
  while (!state.exhausted) {
    if (state.pages >= MAX_AUTOMATIC_PAGES) {
      throw validationError(
        `Automatic pagination stopped at the ${MAX_AUTOMATIC_PAGES}-page safety ceiling. Resume after narrowing the request.`,
      );
    }
    const requestPath = pathWithCursor(operation.path, state.nextCursor);
    const raw = await fetchPage(requestPath);
    const page = transformPage(raw);
    pages.push(page);
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
    state.items.push(...items);
    state.pages += 1;
    state.scannedCount += normalizeScannedCount(
      pagination.scannedCount,
      items.length,
    );
    state.nextCursor = nextCursor;
    state.exhausted = pagination.exhausted;
    state.updatedAt = new Date().toISOString();
    writeAdminJsonFile(checkpointPath, state, {
      privateFile: true,
      maxBytes: MAX_ADMIN_CHECKPOINT_BYTES,
    });
  }
  const result = aggregatePageResult({
    operation,
    pages,
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
      candidateCount: state.items.length,
      snapshotMaxId: state.snapshotMaxId,
      snapshotTimeStamp: state.snapshotTimeStamp,
      exhausted: state.exhausted,
      filters: operation.pagination.filters || {},
    });
  }
  if (options.adminOutput) {
    result.data.scan.outputPath = writeAdminJsonFile(options.adminOutput, result, {
      privateFile: true,
      maxBytes: MAX_ADMIN_CHECKPOINT_BYTES,
    });
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
      maxBytes: MAX_ADMIN_CHECKPOINT_BYTES,
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
      maxBytes: MAX_ADMIN_CHECKPOINT_BYTES,
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
      maxBytes: MAX_ADMIN_CHECKPOINT_BYTES,
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
      maxBytes: MAX_ADMIN_CHECKPOINT_BYTES,
    });
  }
  return result;
}
