import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildJevRoutingReviewOperation, formatJevRoutingReview } from "../lib/admin-jev-review.js";
import { runAutomaticPagination } from "../lib/admin-workflows.js";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";

const request = { action: "review", options: { adminSince: "1793059200", adminUntil: "1793145600" } };

test("fixed JEV review is an owner-only paginated read with no active run", () => {
  const op = parseAdminOperation(parseArgs([
    "admin", "jev-routing", "review", "--since", "1793059200", "--until", "1793145600",
  ]));
  assert.equal(op.name, "jevRouting.review");
  assert.equal(op.method, "GET");
  assert.equal(op.mutates, false);
  assert.equal(op.requiresRun, false);
  assert.equal(op.path, "/cli/admin/jev-routing/review?since=1793059200&until=1793145600&limit=20");
  assert.deepEqual(op.pagination.filters, { since: "1793059200", until: "1793145600", includeSynthetic: false });
  assert.equal(op.pagination.collectionKey, "items");
  assert.equal(op.body, undefined);
});

test("JEV cursor and explicit synthetic flag are preserved without changing the fixed window", () => {
  const op = parseAdminOperation(parseArgs([
    "admin", "jev-routing", "review", "--since", "2026-10-27T00:00:00Z",
    "--until", "2026-10-28", "--cursor", "opaque_cursor", "--include-synthetic", "--limit", "3",
  ]));
  const query = new URL(op.path, "https://example.test").searchParams;
  assert.equal(query.get("since"), "2026-10-27T00:00:00Z");
  assert.equal(query.get("until"), "2026-10-28");
  assert.equal(query.get("cursor"), "opaque_cursor");
  assert.equal(query.get("includeSynthetic"), "true");
  assert.equal(query.get("limit"), "3");
});

test("JEV review rejects moving windows, oversized pages and accidental mutation-shaped commands", () => {
  for (const changes of [
    { adminSince: "2h" }, { adminUntil: "" }, { adminUntil: "1793059200" },
    { adminUntil: "1794059200" }, { adminSince: "2026-10-27T00:00:00" },
    { adminLimit: 21 }, { adminLimit: 0 }, { adminLimit: 1.5 },
  ]) {
    assert.throws(() => buildJevRoutingReviewOperation({ ...request, options: { ...request.options, ...changes } }));
  }
  assert.throws(() => buildJevRoutingReviewOperation({ ...request, action: "apply" }));
  assert.throws(() => buildJevRoutingReviewOperation({ ...request, target: "5" }));
  assert.throws(() => buildJevRoutingReviewOperation({
    ...request, options: { ...request.options, adminAll: true, adminCursor: "resume-position" },
  }), /from the beginning/);
});

test("summary distinguishes missing context and resumed coverage without printing private prompt text", () => {
  const text = formatJevRoutingReview({
    collectionWindow: { since: 1, until: 2, includeSynthetic: false },
    coverage: { status: "exhausted", fromBeginning: false },
    items: [
      { eventId: 7, route: "lumine_model", reviewReasons: ["auto_fallback"], selectedSource: "llm", contextAvailable: true, context: { prompt: "PRIVATE ORIGINAL TEXT" } },
      { eventId: 8, route: "chat_extended", reviewReasons: ["paired_disagreement"], contextAvailable: false, contextUnavailableReason: "expired" },
    ],
    nextCursor: null,
  }).join("\n");
  assert.match(text, /resumed after a cursor/);
  assert.match(text, /frozen input available/);
  assert.match(text, /frozen input expired/);
  assert.match(text, /Collection is not review/);
  assert.doesNotMatch(text, /PRIVATE ORIGINAL TEXT|complete day/i);
});

test("--all retains both JEV pages and exact window metadata in a persistent receipt", async () => {
  const workRoot = fileURLToPath(new URL("../../work/daily-context-followup-20261028/pagination-tests/", import.meta.url));
  fs.mkdirSync(workRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(workRoot, "jev-all-"));
  const output = path.join(directory, "result.json");
  const calls = [];
  const collectionWindow = { since: 1793059200, until: 1793145600, includeSynthetic: false };
  await runAutomaticPagination({
    options: { adminCheckpoint: path.join(directory, "checkpoint.json"), adminOutput: output, json: true },
    operation: buildJevRoutingReviewOperation(request),
    runId: 0,
    fetchPage: async (requestPath) => {
      const cursor = new URL(requestPath, "https://example.test").searchParams.get("cursor");
      calls.push(cursor);
      const exhausted = cursor === "second-page";
      assert.ok(cursor === null || exhausted);
      const item = { eventId: exhausted ? 8 : 7, context: { prompt: exhausted ? "Second frozen input" : "First frozen input" } };
      return {
        ok: true, status: "success", data: {
          collectionWindow, items: [item],
          coverage: { scope: "page", status: exhausted ? "exhausted" : "partial", fromBeginning: !cursor, fullWindowInThisPage: false },
          notes: ["Collection is not review."],
          pagination: { nextCursor: exhausted ? null : "second-page", exhausted, hasMore: !exhausted, after: collectionWindow.since, snapshotTimeStamp: collectionWindow.until, scannedCount: 1 },
        },
      };
    },
    transformPage: (page) => page,
    reportProgress: () => {},
  });
  const receipt = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.deepEqual(calls, [null, "second-page"]);
  assert.deepEqual(receipt.data.items.map((item) => item.eventId), [7, 8]);
  assert.equal(receipt.data.items[0].context.prompt, "First frozen input");
  assert.equal(receipt.data.items[1].context.prompt, "Second frozen input");
  assert.deepEqual(receipt.data.collectionWindow, collectionWindow);
  assert.equal(receipt.data.scan.pages, 2);
  assert.equal(receipt.data.scan.candidateCount, 2);
  assert.equal(receipt.data.pagination.exhausted, true);
  assert.equal(receipt.data.pagination.after, collectionWindow.since);
  assert.equal(receipt.data.pagination.snapshotTimeStamp, collectionWindow.until);
  assert.equal(receipt.data.coverage.scope, "page");
  assert.equal(receipt.data.coverage.fullWindowInThisPage, false);
  assert.deepEqual(receipt.data.notes, ["Collection is not review."]);
});
