import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";
import { requestJson } from "./http.js";

const SESSION_SCHEMA_VERSION = 1;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
// The API bounds complete error captures at 256 MB and every normal-output
// segment at an 8 MB tail (up to 32 files), so this client ceiling only guards
// against a malformed manifest, never a legitimate snapshot.
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const START_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;
const MAX_SNAPSHOT_SEGMENTS = 32;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LOG_FILE_NAME = /^[A-Za-z0-9._-]+\.(?:err|out)\.log$/;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function requestHeaders({ requestId, leaseToken }) {
  return {
    ...(requestId ? { "x-lumine-idempotency-key": requestId } : {}),
    ...(leaseToken ? { "x-lumine-admin-runtime-log-token": leaseToken } : {}),
  };
}

function deterministicRequestId(action, ...parts) {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part || "")).join("\n"))
    .digest("hex")
    .slice(0, 40);
  return `cli:runtime-logs:${action}:${digest}`;
}

function normalizeApiUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function validateReview(value) {
  const id = Number(value?.id || 0);
  const leaseToken = String(value?.leaseToken || "").trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !UUID.test(leaseToken)) {
    throw validationError(
      "The API did not return a valid production-log review lease.",
    );
  }
  return { ...value, id, leaseToken };
}

function readSession(filePath, apiUrl) {
  const resolved = path.resolve(String(filePath || "").trim());
  if (!String(filePath || "").trim()) {
    throw validationError(
      "Pass the production-log review session with --review-session <file>.",
    );
  }
  const session = readAdminJsonFile(
    resolved,
    "the runtime-log review session",
    {
      maxBytes: MAX_SESSION_BYTES,
    },
  );
  if (
    session?.schemaVersion !== SESSION_SCHEMA_VERSION ||
    session?.kind !== "lumine-admin-runtime-log-review" ||
    !Number.isSafeInteger(Number(session.reviewId)) ||
    Number(session.reviewId) <= 0 ||
    !UUID.test(String(session.leaseToken || ""))
  ) {
    throw validationError(
      "The runtime-log review session is missing its review ID or lease token.",
    );
  }
  if (normalizeApiUrl(session.apiUrl) !== normalizeApiUrl(apiUrl)) {
    throw validationError(
      "The runtime-log review session belongs to a different API origin.",
    );
  }
  return { ...session, sessionPath: resolved };
}

function writeSession(session) {
  const { sessionPath, ...stored } = session;
  writeAdminJsonFile(
    sessionPath,
    { ...stored, updatedAt: new Date().toISOString() },
    { privateFile: true, maxBytes: MAX_SESSION_BYTES },
  );
  return session;
}

// A `start` response carries the only copy of the lease token. If it is lost
// in transit the server still holds an active review, so the request key is
// persisted BEFORE the request goes out; rerunning `start` replays that key
// and the server answers idempotently with the same review.
function startIntentPath(options) {
  const session = String(options.adminReviewSession || "").trim();
  if (session) return `${path.resolve(session)}.start-intent.json`;
  const outputDirectory = String(options.adminOutputDir || "").trim();
  if (outputDirectory) {
    return path.join(
      path.resolve(outputDirectory),
      "runtime-log-review-start-intent.json",
    );
  }
  // Shared temp directories are per host, not per operator login; key the
  // fallback to this account so two operator accounts never replay each
  // other's start key. Two shells of the same account still share it, which
  // is why a replayed start rotates the lease server-side.
  const account = createHash("sha256")
    .update(`${os.userInfo().username}\n${os.homedir()}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    os.tmpdir(),
    `lumine-admin-runtime-log-review-start-intent-${account}.json`,
  );
}

function readStartIntent(intentPath, apiUrl, host = "primary") {
  if (!existsSync(intentPath)) return null;
  const intent = readAdminJsonFile(
    intentPath,
    "the runtime-log review start intent",
    { maxBytes: MAX_SESSION_BYTES },
  );
  if (
    intent?.kind !== "lumine-admin-runtime-log-review-start" ||
    normalizeApiUrl(intent.apiUrl) !== normalizeApiUrl(apiUrl) ||
    !REQUEST_ID.test(String(intent.requestId || "")) ||
    !(Date.now() - Date.parse(intent.createdAt || "") < START_INTENT_MAX_AGE_MS)
  ) {
    return null;
  }
  if ((intent.host || "primary") !== host) {
    throw validationError(`A ${intent.host || "primary"} runtime-log start has an unresolved outcome. Replay that host's start before choosing ${host}; its request key was preserved.`);
  }
  return intent;
}

function clearStartIntent(intentPath) {
  rmSync(intentPath, { force: true });
}

function createSession({ options, apiUrl, review }) {
  const requestedOutputDirectory = String(options.adminOutputDir || "").trim();
  const outputDirectory = requestedOutputDirectory
    ? ensurePrivateDirectory(
        path.resolve(
          requestedOutputDirectory,
          `lumine-admin-runtime-log-review-${review.id}`,
        ),
      )
    : mkdtempSync(
        path.join(os.tmpdir(), `lumine-admin-runtime-log-review-${review.id}-`),
      );
  chmodSync(outputDirectory, 0o700);
  const sessionPath = path.resolve(
    String(options.adminReviewSession || "").trim() ||
      path.join(outputDirectory, "review-session.json"),
  );
  return writeSession({
    schemaVersion: SESSION_SCHEMA_VERSION,
    kind: "lumine-admin-runtime-log-review",
    apiUrl,
    reviewId: review.id,
    ...(review.ownerHostId ? { ownerHostId: review.ownerHostId } : {}),
    leaseToken: review.leaseToken,
    status: review.status,
    outputDirectory,
    latestSnapshotId: null,
    latestAcknowledgedSnapshotId: null,
    artifacts: [],
    sessionPath,
  });
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), byteLength: bytes };
}

function safeLogName(value) {
  const normalized = path.basename(String(value || "log"));
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw validationError(
      `Runtime-log artifact path ${directory} must be a real directory, not a link.`,
    );
  }
  chmodSync(directory, 0o700);
  return directory;
}

function validateSnapshot(value) {
  const snapshot = value;
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !UUID.test(String(snapshot.snapshotId || "")) ||
    !Number.isSafeInteger(Number(snapshot.sequence)) ||
    Number(snapshot.sequence) <= 0 ||
    !["baseline", "delta", "post_clear"].includes(snapshot.phase) ||
    !Array.isArray(snapshot.segments) ||
    snapshot.segments.length > MAX_SNAPSHOT_SEGMENTS ||
    !Array.isArray(snapshot.missingFiles)
  ) {
    throw validationError(
      "The API response is missing a valid production-log snapshot manifest.",
    );
  }
  const segmentIds = new Set();
  let totalBytes = 0;
  for (const segment of snapshot.segments) {
    const start = Number(segment?.startOffset);
    const end = Number(segment?.endOffsetExclusive);
    const byteLength = Number(segment?.byteLength);
    if (
      !UUID.test(String(segment?.segmentId || "")) ||
      segmentIds.has(segment.segmentId) ||
      !LOG_FILE_NAME.test(String(segment?.fileName || "")) ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(end) ||
      end < start ||
      !Number.isSafeInteger(byteLength) ||
      byteLength !== end - start ||
      !/^[a-f0-9]{64}$/.test(String(segment?.sha256 || ""))
    ) {
      throw validationError(
        "The API returned an invalid production-log segment boundary.",
      );
    }
    segmentIds.add(segment.segmentId);
    totalBytes += byteLength;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw validationError(
        `The API returned a production-log snapshot above the ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MiB client safety limit.`,
      );
    }
  }
  if (
    !Number.isSafeInteger(Number(snapshot.totalBytes)) ||
    Number(snapshot.totalBytes) !== totalBytes
  ) {
    throw validationError(
      "The API returned an inconsistent production-log snapshot byte total.",
    );
  }
  return snapshot;
}

async function downloadSegment({
  options,
  authToken,
  session,
  snapshot,
  segment,
  segmentIndex,
  snapshotPath,
}) {
  const fileName = `${String(segmentIndex + 1).padStart(2, "0")}-${safeLogName(segment.fileName)}-${segment.startOffset}-${segment.endOffsetExclusive}.log`;
  const finalPath = path.join(snapshotPath, fileName);
  if (existsSync(finalPath)) {
    const metadata = lstatSync(finalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw validationError(
        `Existing runtime-log artifact ${finalPath} must be a regular file, not a link.`,
      );
    }
    const existing = await hashFile(finalPath);
    if (
      existing.byteLength === Number(segment.byteLength) &&
      existing.sha256 === String(segment.sha256)
    ) {
      chmodSync(finalPath, 0o600);
      return {
        segmentId: segment.segmentId,
        fileName: segment.fileName,
        path: finalPath,
        ...existing,
      };
    }
    throw validationError(
      `Existing runtime-log artifact ${finalPath} does not match the server manifest. Preserve it and choose a different --output-dir.`,
    );
  }

  const temporary = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let offset = 0;
  try {
    while (offset < Number(segment.byteLength)) {
      const result = await requestJson({
        url:
          `${normalizeApiUrl(options.apiUrl)}/cli/admin/runtime-logs/reviews/${session.reviewId}` +
          `/snapshots/${snapshot.snapshotId}/segments/${segment.segmentId}` +
          `?offset=${offset}&limit=${CHUNK_BYTES}`,
        authToken,
        headers: requestHeaders({ leaseToken: session.leaseToken }),
        timeoutMs: options.timeoutMs,
      });
      const chunk = result?.data?.chunk;
      if (
        Number(chunk?.offset) !== offset ||
        String(chunk?.segmentId || "") !== String(segment.segmentId)
      ) {
        throw validationError(
          "The API returned a production-log chunk for the wrong boundary.",
        );
      }
      const bytes = Buffer.from(String(chunk.contentBase64 || ""), "base64");
      if (
        bytes.length !== Number(chunk.byteLength) ||
        Number(chunk.nextOffset) !== offset + bytes.length ||
        (bytes.length === 0 && offset < Number(segment.byteLength))
      ) {
        throw validationError(
          "The API returned an invalid production-log chunk length.",
        );
      }
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(
          descriptor,
          bytes,
          written,
          bytes.length - written,
          offset + written,
        );
        if (count <= 0) {
          throw new Error("The runtime-log artifact write made no progress.");
        }
        written += count;
      }
      hash.update(bytes);
      offset += bytes.length;
    }
    const sha256 = hash.digest("hex");
    if (
      offset !== Number(segment.byteLength) ||
      sha256 !== String(segment.sha256)
    ) {
      throw validationError(
        `Downloaded runtime-log artifact ${finalPath} does not match its canonical digest.`,
      );
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, finalPath);
    chmodSync(finalPath, 0o600);
    return {
      segmentId: segment.segmentId,
      fileName: segment.fileName,
      path: finalPath,
      byteLength: offset,
      sha256,
    };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // The successful path or failed write may already have closed it.
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Exclusive create may have failed before a temporary file existed.
    }
    throw error;
  }
}

async function materializeSnapshot({ options, authToken, session, snapshot }) {
  snapshot = validateSnapshot(snapshot);
  const outputDirectory = path.resolve(session.outputDirectory);
  const snapshotPath = path.join(
    outputDirectory,
    `snapshot-${snapshot.sequence}-${snapshot.snapshotId}`,
  );
  ensurePrivateDirectory(snapshotPath);
  const artifacts = [];
  for (const [index, segment] of snapshot.segments.entries()) {
    artifacts.push(
      await downloadSegment({
        options,
        authToken,
        session,
        snapshot,
        segment,
        segmentIndex: index,
        snapshotPath,
      }),
    );
  }
  const manifestPath = path.join(snapshotPath, "manifest.json");
  writeAdminJsonFile(manifestPath, snapshot, {
    privateFile: true,
    maxBytes: MAX_SESSION_BYTES,
  });
  return { snapshotPath, manifestPath, artifacts };
}

async function acknowledgeSnapshot({
  options,
  authToken,
  session,
  snapshot,
  materialized,
}) {
  await requestJson({
    method: "POST",
    url:
      `${normalizeApiUrl(options.apiUrl)}/cli/admin/runtime-logs/reviews/${session.reviewId}` +
      `/snapshots/${snapshot.snapshotId}/acknowledge`,
    authToken,
    body: {
      receipts: materialized.artifacts.map((artifact) => ({
        segmentId: artifact.segmentId,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
      })),
    },
    headers: requestHeaders({
      leaseToken: session.leaseToken,
      requestId: deterministicRequestId(
        "ack",
        session.reviewId,
        snapshot.snapshotId,
      ),
    }),
    timeoutMs: options.timeoutMs,
  });
  return recordSnapshotArtifact({ session, snapshot, materialized });
}

function recordSnapshotArtifact({ session, snapshot, materialized }) {
  session.latestSnapshotId = snapshot.snapshotId;
  session.latestAcknowledgedSnapshotId = snapshot.snapshotId;
  const artifact = {
    snapshotId: snapshot.snapshotId,
    sequence: snapshot.sequence,
    phase: snapshot.phase,
    capturedAt: snapshot.capturedAt,
    totalBytes: snapshot.totalBytes,
    boundaryLosses: snapshot.segments
      .filter((segment) => segment.boundaryLost)
      .map((segment) => ({
        fileName: segment.fileName,
        reason: segment.boundaryLossReason,
        previousBoundary: segment.previousBoundary,
        currentBoundary: segment.currentBoundary,
      })),
    missingFiles: snapshot.missingFiles,
    ...materialized,
  };
  session.artifacts = [
    ...(Array.isArray(session.artifacts)
      ? session.artifacts.filter(
          (entry) => entry?.snapshotId !== snapshot.snapshotId,
        )
      : []),
    artifact,
  ];
  writeSession(session);
  return artifact;
}

async function recoverPendingSnapshot({ options, authToken, session }) {
  const status = await requestJson({
    url: `${normalizeApiUrl(options.apiUrl)}/cli/admin/runtime-logs/reviews/${session.reviewId}`,
    authToken,
    headers: requestHeaders({ leaseToken: session.leaseToken }),
    timeoutMs: options.timeoutMs,
  });
  const review = status?.data?.review;
  if (review && String(review.status || "") !== "active") {
    // Completed, abandoned, expired, or failed elsewhere: the server has
    // released this review's artifacts, so downloading would only 409.
    session.status = String(review.status);
    writeSession(session);
    return { status, recoveredArtifact: null, inactive: true };
  }
  const snapshot = review?.latestSnapshot;
  let recoveredArtifact = null;
  if (snapshot && review.latestSnapshotAcknowledged !== true) {
    const materialized = await materializeSnapshot({
      options,
      authToken,
      session,
      snapshot,
    });
    recoveredArtifact = await acknowledgeSnapshot({
      options,
      authToken,
      session,
      snapshot,
      materialized,
    });
  } else if (snapshot && review.latestSnapshotAcknowledged === true) {
    const recorded = Array.isArray(session.artifacts)
      ? session.artifacts.find(
          (entry) => entry?.snapshotId === snapshot.snapshotId,
        )
      : null;
    if (!recorded) {
      const materialized = await materializeSnapshot({
        options,
        authToken,
        session,
        snapshot,
      });
      recoveredArtifact = recordSnapshotArtifact({
        session,
        snapshot,
        materialized,
      });
    } else {
      session.latestSnapshotId = snapshot.snapshotId;
      session.latestAcknowledgedSnapshotId = snapshot.snapshotId;
    }
  }
  session.status = String(review?.status || session.status || "active");
  writeSession(session);
  return { status, recoveredArtifact };
}

function scrubLeaseToken(result, session, artifact) {
  const review = result?.data?.review || {};
  const { leaseToken: _leaseToken, ...safeReview } = review;
  return {
    ...result,
    data: {
      ...(result.data || {}),
      review: safeReview,
      artifacts: {
        reviewSessionPath: session.sessionPath,
        outputDirectory: session.outputDirectory,
        latestSnapshot: artifact || null,
      },
    },
  };
}

export async function runAdminRuntimeLogWorkflow({
  options,
  operation,
  authToken,
  requestId,
}) {
  const apiUrl = normalizeApiUrl(options.apiUrl);
  if (operation.runtimeLogAction === "start") {
    const host = operation.runtimeLogHost || "primary";
    if (!["primary", "target"].includes(host)) throw validationError("Invalid runtime-log host.");
    const intentPath = startIntentPath(options);
    const intent = options.idempotencyKey
      ? null
      : readStartIntent(intentPath, apiUrl, host);
    const startRequestId = intent?.requestId || requestId;
    if (!intent) {
      writeAdminJsonFile(
        intentPath,
        {
          kind: "lumine-admin-runtime-log-review-start",
          apiUrl,
          host,
          requestId: startRequestId,
          createdAt: new Date().toISOString(),
        },
        { privateFile: true, maxBytes: MAX_SESSION_BYTES },
      );
    }
    let result;
    try {
      result = await requestJson({
        method: "POST",
        url: `${apiUrl}/cli/admin/runtime-logs${operation.runtimeLogHost ? `/hosts/${host}` : ""}/reviews`,
        authToken,
        body: {},
        headers: requestHeaders({ requestId: startRequestId }),
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      const status = Number(error?.status || 0);
      // Transport failures, timeouts, and 5xx leave the server outcome
      // unknown: keep the key so a rerun replays it. A 4xx is the server's
      // definitive answer for this key, so replaying it can never succeed.
      if (!(status >= 400 && status < 500)) throw error;
      clearStartIntent(intentPath);
      if (
        intent &&
        error?.data?.error?.code === "CLI_ADMIN_RUNTIME_LOG_REVIEW_NOT_ACTIVE"
      ) {
        // The persisted key belongs to a review that already finished or
        // failed; start over once with a fresh key.
        return runAdminRuntimeLogWorkflow({
          options,
          operation,
          authToken,
          requestId: `cli:${randomUUID()}`,
        });
      }
      throw error;
    }
    const review = validateReview(result?.data?.review);
    if (operation.runtimeLogHost && (!/^i-[a-f0-9]{17}$/.test(review.ownerHostId || "") || review.ownerHostRole !== host)) {
      throw validationError("The API did not confirm a host-owned review. Preserve the start intent and recover it; do not clear logs.");
    }
    const session = createSession({ options, apiUrl, review });
    // The session now holds the lease; a later rerun must start fresh.
    clearStartIntent(intentPath);
    const snapshot = result?.data?.snapshot;
    const materialized = await materializeSnapshot({
      options,
      authToken,
      session,
      snapshot,
    });
    const artifact = await acknowledgeSnapshot({
      options,
      authToken,
      session,
      snapshot,
      materialized,
    });
    return scrubLeaseToken(result, session, artifact);
  }

  if (operation.runtimeLogAction === "resume") {
    const result = await requestJson({
      method: "POST",
      url: `${apiUrl}/cli/admin/runtime-logs/reviews/resume`,
      authToken,
      body: {},
      headers: requestHeaders({ requestId }),
      timeoutMs: options.timeoutMs,
    });
    const review = validateReview(result?.data?.review);
    const session = createSession({ options, apiUrl, review });
    clearStartIntent(startIntentPath(options));
    const snapshot = result?.data?.snapshot;
    let artifact = null;
    if (snapshot) {
      const materialized = await materializeSnapshot({
        options,
        authToken,
        session,
        snapshot,
      });
      artifact =
        review.latestSnapshotAcknowledged === true
          ? recordSnapshotArtifact({ session, snapshot, materialized })
          : await acknowledgeSnapshot({
              options,
              authToken,
              session,
              snapshot,
              materialized,
            });
    }
    return scrubLeaseToken(result, session, artifact);
  }

  if (operation.runtimeLogAction === "abandon") {
    const sessionPath = String(options.adminReviewSession || "").trim();
    const session = sessionPath ? readSession(sessionPath, apiUrl) : null;
    const result = await requestJson({
      method: "POST",
      url: `${apiUrl}/cli/admin/runtime-logs/reviews/abandon`,
      authToken,
      body: session ? { reviewId: session.reviewId } : {},
      headers: requestHeaders({}),
      timeoutMs: options.timeoutMs,
    });
    clearStartIntent(startIntentPath(options));
    if (!session) return result;
    session.status = String(result?.data?.review?.status || "abandoned");
    writeSession(session);
    return scrubLeaseToken(result, session, null);
  }

  const session = readSession(options.adminReviewSession, apiUrl);
  if (operation.runtimeLogAction === "status") {
    const result = await requestJson({
      url: `${apiUrl}/cli/admin/runtime-logs/reviews/${session.reviewId}`,
      authToken,
      headers: requestHeaders({ leaseToken: session.leaseToken }),
      timeoutMs: options.timeoutMs,
    });
    return scrubLeaseToken(result, session, null);
  }

  const recovered = await recoverPendingSnapshot({
    options,
    authToken,
    session,
  });
  if (recovered.recoveredArtifact) {
    return scrubLeaseToken(
      {
        ...recovered.status,
        data: {
          ...(recovered.status.data || {}),
          completionStatus: "needs_review",
        },
      },
      session,
      recovered.recoveredArtifact,
    );
  }
  if (recovered.inactive) {
    return scrubLeaseToken(
      {
        ...recovered.status,
        status: "already_done",
        changed: false,
        data: {
          ...(recovered.status.data || {}),
          completionStatus: String(recovered.status.data.review.status),
        },
      },
      session,
      null,
    );
  }
  const action = operation.runtimeLogAction;
  const result = await requestJson({
    method: "POST",
    url: `${apiUrl}/cli/admin/runtime-logs/reviews/${session.reviewId}/${action}`,
    authToken,
    body:
      action === "complete"
        ? { reviewedSnapshotId: session.latestAcknowledgedSnapshotId }
        : {},
    headers: requestHeaders({
      leaseToken: session.leaseToken,
      requestId,
    }),
    timeoutMs: options.timeoutMs,
  });
  const snapshot = result?.data?.snapshot;
  let artifact = null;
  if (snapshot) {
    const materialized = await materializeSnapshot({
      options,
      authToken,
      session,
      snapshot,
    });
    artifact = await acknowledgeSnapshot({
      options,
      authToken,
      session,
      snapshot,
      materialized,
    });
  }
  session.status = String(result?.data?.review?.status || session.status);
  writeSession(session);
  return scrubLeaseToken(result, session, artifact);
}
