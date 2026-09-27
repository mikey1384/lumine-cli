import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseAdminOperation } from "../lib/admin.js";
import { formatStorageApproval } from "../lib/assets.js";
import { parseArgs } from "../lib/commands.js";
import { formatBytes, parseStorageSizeBytes } from "../lib/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");
const MB = 1024 * 1024;
const GB = 1024 * MB;

test("storage sizes parse as binary MB/GB like the server quota", () => {
  assert.equal(parseStorageSizeBytes("500MB"), 500 * MB);
  assert.equal(parseStorageSizeBytes("1gb"), GB);
  assert.equal(parseStorageSizeBytes("1.5 GB"), 1.5 * GB);
  assert.equal(parseStorageSizeBytes("750"), 750 * MB);
  assert.throws(() => parseStorageSizeBytes("lots"), /500MB, 1GB or 2GB/);
  assert.throws(() => parseStorageSizeBytes("0"), /positive/);
  assert.equal(formatBytes(2 * GB), "2.0 GB");
  assert.equal(formatBytes(150 * MB), "150.0 MB");
});

test("admin storage operations map to the Mikey-only admin routes", () => {
  const grant = parseAdminOperation(
    parseArgs([
      "admin",
      "storage",
      "grant",
      "5",
      "--size",
      "2GB",
      "--reason",
      "first approval",
    ]),
  );
  assert.deepEqual(
    {
      name: grant.name,
      method: grant.method,
      path: grant.path,
      body: grant.body,
      mutates: grant.mutates,
      requiresRun: grant.requiresRun,
    },
    {
      name: "storage.grant",
      method: "PUT",
      path: "/cli/admin/storage-limits/users/5",
      body: { sizeBytes: 2 * GB, reason: "first approval" },
      mutates: true,
      requiresRun: false,
    },
  );

  const approve = parseAdminOperation(
    parseArgs(["admin", "storage", "approve", "12", "--size", "500MB"]),
  );
  assert.equal(approve.path, "/cli/admin/storage-limits/requests/12");
  assert.deepEqual(approve.body, {
    decision: "approve",
    reason: "",
    sizeBytes: 500 * MB,
  });

  const list = parseAdminOperation(
    parseArgs(["admin", "storage", "list", "--status", "all"]),
  );
  assert.equal(list.path, "/cli/admin/storage-limits/requests?status=all");
  assert.equal(list.requiresRun, false);

  const show = parseAdminOperation(
    parseArgs(["admin", "storage", "show", "@mikey"]),
  );
  assert.equal(show.path, "/cli/admin/storage-limits/users/mikey");

  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "storage", "grant", "5"])),
    /needs --size/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "storage", "reject", "12", "--size", "1GB"]),
      ),
    /only used with approve/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "storage", "grant", "5", "--size", "huge"]),
      ),
    /500MB, 1GB or 2GB/,
  );
});

test("storage status names the pending request or the next command", () => {
  const pending = formatStorageApproval({
    maxRuntimeFileStorageBytes: 150 * MB,
    hasOverride: false,
    runtimeFileStorageBytes: 149 * MB,
    runtimeFileCount: 12,
    canRequest: true,
    requestTiers: [500 * MB, GB, 2 * GB],
    latestRequest: {
      requestId: 3,
      status: "pending",
      requestedMaxRuntimeFileStorageBytes: GB,
    },
  });
  assert.match(pending[0], /150\.0 MB · 149\.0 MB used across 12 file/);
  assert.match(pending[1], /Request #3 for 1\.0 GB is waiting/);
  assert.equal(pending.length, 2);

  const open = formatStorageApproval({
    maxRuntimeFileStorageBytes: 150 * MB,
    canRequest: true,
    requestTiers: [500 * MB, GB, 2 * GB],
    latestRequest: null,
  });
  assert.match(
    open.at(-1),
    /lumine assets request-storage --size <500MB\|1GB\|2GB>/,
  );
});

test("creators request storage and admins grant it through the CLI", async (t) => {
  const fixture = await createFixtureServer(t);

  const requested = await runCli([
    "assets",
    "request-storage",
    "--size",
    "1GB",
    "--reason",
    "rendered soundtrack",
    ...fixture.cliArgs,
  ]);
  assert.equal(requested.code, 0, requested.stderr);
  assert.match(
    requested.stdout,
    /Sent storage request #12 for 1\.0 GB to Mikey\. Nothing changes until he approves it\./,
  );

  const status = await runCli(["assets", "storage", ...fixture.cliArgs]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Request #12 for 1\.0 GB is waiting/);

  const granted = await runCli([
    "admin",
    "storage",
    "grant",
    "5",
    "--size",
    "2GB",
    ...fixture.cliArgs,
  ]);
  assert.equal(granted.code, 0, granted.stderr);
  assert.match(
    granted.stdout,
    /mikey \(5\) now has 2\.0 GB of Lumine file storage\./,
  );

  const requestCalls = fixture.requests.filter(
    (request) => request.url === "/build/runtime-storage-limit-request",
  );
  assert.deepEqual(
    requestCalls.map((request) => ({
      method: request.method,
      body: request.body,
    })),
    [
      {
        method: "POST",
        body: { requestedBytes: GB, reason: "rendered soundtrack" },
      },
    ],
  );
  const grantCall = fixture.requests.find(
    (request) => request.url === "/cli/admin/storage-limits/users/5",
  );
  assert.equal(grantCall?.method, "PUT");
  assert.deepEqual(grantCall?.body, { sizeBytes: 2 * GB, reason: "" });
  assert.match(
    String(grantCall?.headers["x-lumine-idempotency-key"] || ""),
    /^cli:/,
  );
});

async function createFixtureServer(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-storage-"));
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const pendingRequest = {
    requestId: 12,
    userId: 44,
    username: "builder",
    requestedMaxRuntimeFileStorageBytes: GB,
    approvedMaxRuntimeFileStorageBytes: null,
    status: "pending",
  };
  const approval = {
    maxRuntimeFileStorageBytes: 150 * MB,
    hasOverride: false,
    runtimeFileStorageBytes: 149 * MB,
    runtimeFileCount: 12,
    canRequest: true,
    requestTiers: [500 * MB, GB, 2 * GB],
    latestRequest: pendingRequest,
  };
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      body,
      headers: req.headers,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 5,
          username: "mikey",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/build/runtime-storage-limit-request"
    ) {
      res.end(
        JSON.stringify({
          success: true,
          changed: true,
          request: pendingRequest,
          storageLimitApproval: approval,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/build/runtime-storage-limit") {
      res.end(
        JSON.stringify({ success: true, storageLimitApproval: approval }),
      );
      return;
    }
    if (
      req.method === "PUT" &&
      req.url === "/cli/admin/storage-limits/users/5"
    ) {
      res.end(
        JSON.stringify({
          ok: true,
          status: "ok",
          changed: true,
          data: {
            user: { id: 5, username: "mikey" },
            request: null,
            maxRuntimeFileStorageBytes: 2 * GB,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );
  return {
    requests,
    cliArgs: [
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
    ],
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}
