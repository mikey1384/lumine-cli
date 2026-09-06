import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { runAutomaticPagination } from "../lib/admin-workflows.js";
import { parseArgs } from "../lib/commands.js";

// Persisted checkpoint identity before discovery stopped using the report cap.
// Keep this old format fixed: these are upgrade fixtures, not the new hash API.
function reportCappedFingerprint({ schemaVersion, options, operation, runId }) {
  const url = new URL(operation.path, "https://lumine.invalid");
  url.searchParams.delete("cursor");
  return createHash("sha256")
    .update(
      JSON.stringify({
        workflowSchemaVersion: schemaVersion,
        runId,
        apiUrl: String(options.apiUrl || "").replace(/\/$/, ""),
        name: operation.name,
        path: `${url.pathname}${url.search}`,
        ...(operation.name === "builds.candidates"
          ? {
              resultTransform: {
                siteUrl: String(options.siteUrl || "").replace(/\/$/, ""),
              },
            }
          : {}),
        pagination: {
          collectionKey: operation.pagination.collectionKey,
          coverageQueue: operation.pagination.coverageQueue || null,
          coverageMode: operation.pagination.coverageMode || null,
          after: operation.pagination.after ?? null,
          filters: operation.pagination.filters || {},
        },
      }),
    )
    .digest("hex");
}

async function completedScan(t, args, schemaVersion) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-discovery-window-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    ...parseArgs(["admin", ...args]),
    adminCheckpoint: path.join(directory, "checkpoint.json"),
    adminResume: false,
    adminOutput: "",
    json: false,
  };
  const operation = parseAdminOperation(options);
  const now = 1_800_000_000;
  const runId = 74;
  await runAutomaticPagination({
    options,
    operation,
    runId,
    fetchPage: async () => ({
      ok: true,
      data: {
        [operation.pagination.collectionKey]: [],
        pagination: {
          mode: operation.pagination.coverageMode,
          after:
            operation.pagination.coverageMode === "since-run"
              ? now - (schemaVersion ? 30 : 45) * 86400
              : operation.pagination.after,
          snapshotMaxId: 100,
          snapshotTimeStamp: now,
          nextCursor: null,
          hasMore: false,
          exhausted: true,
        },
      },
    }),
    transformPage: (page) => page,
  });
  const saved = JSON.parse(fs.readFileSync(options.adminCheckpoint, "utf8"));
  if (schemaVersion) {
    saved.schemaVersion = schemaVersion;
    saved.operationFingerprint = reportCappedFingerprint({
      schemaVersion,
      options,
      operation,
      runId,
    });
    if (schemaVersion === 2) saved.items = [];
  }
  const contents = JSON.stringify(saved);
  fs.writeFileSync(options.adminCheckpoint, contents);
  return {
    options: { ...options, adminResume: true },
    operation,
    runId,
    contents,
  };
}

for (const args of [
  ["subjects", "candidates"],
  ["recommendations", "list"],
  ["builds", "candidates"],
]) {
  test(`${args.join(" ")} refuses exhausted report-capped checkpoints before recording coverage`, async (t) => {
    for (const schemaVersion of [2, 3]) {
      const fixture = await completedScan(t, args, schemaVersion);
      let coverageCalls = 0;
      await assert.rejects(
        runAutomaticPagination({
          ...fixture,
          fetchPage: async () =>
            assert.fail("Refuse the stale checkpoint before fetching"),
          transformPage: (page) => page,
          recordCoverage: async () => {
            coverageCalls++;
          },
        }),
        /checkpoint does not belong/,
      );
      assert.equal(coverageCalls, 0);
      assert.equal(
        fs.readFileSync(fixture.options.adminCheckpoint, "utf8"),
        fixture.contents,
      );
    }
  });
}

for (const flags of [["--after", "2026-08-01"], ["--include-legacy"]]) {
  test(`explicit ${flags[0]} discovery checkpoints remain resumable`, async (t) => {
    for (const schemaVersion of [2, 3]) {
      const fixture = await completedScan(
        t,
        ["subjects", "candidates", ...flags],
        schemaVersion,
      );
      let coverageCalls = 0;
      const result = await runAutomaticPagination({
        ...fixture,
        fetchPage: async () =>
          assert.fail("A valid exhausted scan should not refetch"),
        transformPage: (page) => page,
        recordCoverage: async () => {
          coverageCalls++;
        },
      });
      assert.equal(result.data.scan.resumed, true);
      assert.equal(result.data.pagination.exhausted, true);
      assert.equal(coverageCalls, 1);
    }
  });
}

test("current run-start discovery checkpoints still resume with their complete window", async (t) => {
  const fixture = await completedScan(t, ["subjects", "candidates"]);
  const coverage = [];
  const result = await runAutomaticPagination({
    ...fixture,
    fetchPage: async () =>
      assert.fail("The current exhausted checkpoint is reusable"),
    transformPage: (page) => page,
    recordCoverage: async (receipt) => {
      coverage.push(receipt);
    },
  });
  assert.equal(result.data.scan.resumed, true);
  assert.equal(result.data.pagination.after, 1_800_000_000 - 45 * 86400);
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].after, result.data.pagination.after);
});
