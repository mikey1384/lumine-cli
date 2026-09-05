import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import {
  adminCommand,
  assertAdminOperationAllowedForRunScope,
  assertAdminTodoHandoffResult,
  canonicalAdminRunScope,
  parseAdminOperation,
  shouldRecordAdminQueueCoverage,
  writeAdminResultOutput,
} from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

test("Build comment inspection accepts typed IDs and URLs without allowing Build recommendations", () => {
  for (const args of [
    ["build:884"],
    ["https://www.twin-kle.com/app/884"],
    ["884", "--type", "build"],
  ]) {
    const operation = parseAdminOperation(
      parseArgs(["admin", "post", "comments", ...args, "--cursor", "opaque"]),
    );
    assert.equal(
      operation.path,
      "/cli/admin/posts/build/884/comments?cursor=opaque&limit=50",
    );
    assert.equal(operation.pagination.collectionKey, "comments");
    assert.equal(operation.mutates, false);
    assert.throws(() =>
      assertAdminOperationAllowedForRunScope({
        operation,
        runScope: "featured",
      }),
    );
  }
  assert.throws(() =>
    parseAdminOperation(parseArgs(["admin", "post", "recommend", "build:884"])),
  );
  assert.throws(() =>
    parseAdminOperation(
      parseArgs([
        "admin",
        "post",
        "comments",
        "build:884",
        "--type",
        "subject",
      ]),
    ),
  );
});

test("newspaper-only sessions have a distinct start and reject unrelated work", () => {
  const operation = parseAdminOperation(
    parseArgs(["admin", "daily-run", "start", "--scope", "newspaper"]),
  );
  assert.equal(operation.path, "/cli/admin/daily-runs/start/newspaper");
  assert.equal(operation.body.scope, "newspaper");
  assert.equal(operation.body.commentMode, "off");
  assert.match(operation.body.runKey, /^scoped:newspaper:/);
  assert.equal(canonicalAdminRunScope({ runScope: "newspaper" }), "newspaper");
  assert.equal(shouldRecordAdminQueueCoverage("newspaper"), false);
  for (const name of [
    "news.status",
    "news.claim",
    "news.submit",
    "news.print",
    "daily-run.complete",
    "daily-run.fail",
  ]) {
    assert.doesNotThrow(() =>
      assertAdminOperationAllowedForRunScope({
        runScope: "newspaper",
        operation: { name },
      }),
    );
  }
  for (const name of [
    "featured.add",
    "bot.output",
    "build.review",
    "post.comments",
    "daily-run.report",
    "recommendations.list",
  ]) {
    assert.throws(() =>
      assertAdminOperationAllowedForRunScope({
        runScope: "newspaper",
        operation: { name },
      }),
    );
  }
  const result = {
    data: {
      run: { id: 71, runScope: "newspaper" },
      carryoverTodos: {
        included: false,
        items: [],
        count: 0,
        surfacedForRunId: null,
        newlySurfacedCount: 0,
      },
    },
  };
  assertAdminTodoHandoffResult(result, "newspaper");
  assert.throws(
    () =>
      assertAdminTodoHandoffResult(
        { data: { ...result.data, run: { id: 71, runScope: "full" } } },
        "newspaper",
      ),
    /returned a full run/,
  );
  assert.throws(() =>
    parseAdminOperation(
      parseArgs([
        "admin",
        "daily-run",
        "start",
        "--scope",
        "newspaper",
        "--comment-mode",
        "post",
      ]),
    ),
  );
});

test("ordinary monthly --output writes canonical private JSON without a delegated run", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-output-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const canonical = {
    ok: true,
    status: "success",
    data: { monthlyAiCosts: { exact: 74.30531202 } },
  };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, run: req.headers["x-lumine-admin-run-id"] });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cli/session")
      res.end(JSON.stringify({ scopes: ["build:read"] }));
    else if (req.url === "/cli/admin/ai-costs/monthly")
      res.end(JSON.stringify(canonical));
    else {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const output = path.join(directory, "costs.json");
  const options = parseArgs([
    "admin",
    "ai-costs",
    "monthly",
    "--output",
    output,
    "--json",
  ]);
  const originalLog = console.log;
  try {
    console.log = () => {};
    await adminCommand({
      ...options,
      authToken: "fixture-token",
      apiUrl: `http://127.0.0.1:${server.address().port}`,
    });
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), canonical);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(
    requests.map((item) => item.url),
    ["/cli/session", "/cli/admin/ai-costs/monthly"],
  );
  assert.ok(requests.every((item) => !item.run));
});

test("an output-file failure retains the canonical mutation receipt", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-output-error-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const canonical = { ok: true, changed: true, data: { id: 19 } };
  assert.throws(
    () =>
      writeAdminResultOutput({
        filePath: directory,
        operation: { name: "comment.post", mutates: true },
        result: canonical,
      }),
    (error) => {
      assert.equal(error.code, "LUMINE_ADMIN_OUTPUT_WRITE_FAILED");
      assert.deepEqual(error.data.error.details.canonicalResult, canonical);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(directory), []);
});
