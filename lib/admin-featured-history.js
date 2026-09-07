import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";
import {
  acquireCheckpointLock,
  releaseCheckpointLock,
  runAutomaticPagination,
  combinePaginatedResults,
  writePaginatedResultFile,
} from "./admin-workflows.js";

// API read bound, deliberately unrelated to the delegated addition policy.
export const FEATURED_HISTORY_BATCH_SIZE = 100;

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export async function runBatchedFeaturedHistory(args) {
  const { options, operation, runId } = args;
  if (options.adminCursor) {
    throw invalid("Use --resume with --all, not a single-batch --cursor.");
  }
  const subjectIds = operation.pagination.filters.subjectIds;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        runId,
        apiUrl: options.apiUrl,
        path: operation.path,
      }),
    )
    .digest("hex");
  const checkpointPath = path.resolve(
    options.adminCheckpoint ||
      path.join(
        os.tmpdir(),
        `lumine-admin-run-${runId}-featured-history-${fingerprint}.json`,
      ),
  );
  const outputPath = options.adminOutput
    ? path.resolve(options.adminOutput)
    : null;
  if (
    outputPath === checkpointPath ||
    outputPath?.startsWith(`${checkpointPath}.`)
  ) {
    throw invalid(
      "History output must not overwrite its checkpoint or batch files.",
    );
  }
  const lock = acquireCheckpointLock(checkpointPath, fingerprint);
  try {
    let generation;
    if (options.adminResume) {
      const saved = readAdminJsonFile(
        checkpointPath,
        "the Featured history batch checkpoint",
      );
      if (
        saved.kind !== "featured-history-batches" ||
        saved.fingerprint !== fingerprint ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          saved.generation || "",
        )
      ) {
        throw invalid(
          "The checkpoint does not belong to this run and exact history request.",
        );
      }
      generation = saved.generation;
    } else {
      generation = randomUUID();
      writeAdminJsonFile(
        checkpointPath,
        { kind: "featured-history-batches", fingerprint, generation },
        { privateFile: true },
      );
    }
    const results = [];
    for (
      let offset = 0;
      offset < subjectIds.length;
      offset += FEATURED_HISTORY_BATCH_SIZE
    ) {
      const ids = subjectIds.slice(
        offset,
        offset + FEATURED_HISTORY_BATCH_SIZE,
      );
      const batchIndex = offset / FEATURED_HISTORY_BATCH_SIZE;
      const batchCheckpoint = `${checkpointPath}.${generation}.batch-${batchIndex}.json`;
      const url = new URL(operation.path, "https://lumine.invalid");
      url.searchParams.set("subjectIds", ids.join(","));
      const result = await runAutomaticPagination({
        ...args,
        options: {
          ...options,
          adminOutput: undefined,
          adminCheckpoint: batchCheckpoint,
          adminResume: !!options.adminResume && existsSync(batchCheckpoint),
        },
        operation: {
          ...operation,
          path: `${url.pathname}${url.search}`,
          pagination: { ...operation.pagination, filters: { subjectIds: ids } },
        },
      });
      if (
        JSON.stringify(result.data.subjects?.map((subject) => subject.id)) !==
        JSON.stringify(ids)
      ) {
        throw invalid(
          "The API did not return a canonical summary for every requested subject.",
        );
      }
      results.push(result);
    }
    const firstCoverage = results[0].data.coverage;
    const uniformCoverage = results.every(
      (result) =>
        result.data.coverage?.complete === firstCoverage.complete &&
        result.data.coverage?.startedAt === firstCoverage.startedAt,
    );
    const result = combinePaginatedResults(
      {
        ok: true,
        status: "success",
        data: {
          coverage: uniformCoverage
            ? firstCoverage
            : { complete: false, startedAt: null },
          subjects: results.flatMap((result) => result.data.subjects),
          pagination: {
            nextCursor: null,
            hasMore: false,
            exhausted: true,
            snapshotMaxId: null,
            snapshotTimeStamp: null,
            after: null,
            snapshotScope: "per-batch",
            eventOrder: "subject-batch-then-id-descending",
          },
          scan: {
            checkpointPath,
            resumed: !!options.adminResume,
            pages: results.reduce(
              (sum, result) => sum + result.data.scan.pages,
              0,
            ),
            scannedCount: results.reduce(
              (sum, result) => sum + result.data.scan.scannedCount,
              0,
            ),
            candidateCount: results.reduce(
              (sum, result) => sum + result.data.scan.candidateCount,
              0,
            ),
            batches: results.map((result, index) => ({
              subjectIds: subjectIds.slice(
                index * FEATURED_HISTORY_BATCH_SIZE,
                (index + 1) * FEATURED_HISTORY_BATCH_SIZE,
              ),
              coverage: result.data.coverage,
              pagination: result.data.pagination,
              scan: result.data.scan,
            })),
          },
        },
      },
      results,
    );
    if (outputPath) {
      result.data.scan.outputPath = outputPath;
      await writePaginatedResultFile(outputPath, result);
    }
    return result;
  } finally {
    releaseCheckpointLock(lock);
  }
}
