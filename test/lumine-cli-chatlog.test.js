import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../lib/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

test("chatlog parses its action, target and flags", () => {
  const enable = parseArgs(["chatlog", "enable", "2610"]);
  assert.equal(enable.command, "chatlog");
  assert.deepEqual(enable.positional, ["enable", "2610"]);
  const show = parseArgs([
    "chatlog",
    "2610",
    "--since",
    "2h",
    "--limit",
    "300",
    "--instance",
    "abc",
    "--json",
  ]);
  assert.equal(show.chatlogSince, "2h");
  assert.equal(show.chatlogLimit, "300");
  assert.equal(show.chatlogInstance, "abc");
  assert.equal(show.json, true);
});

test("chatlog switches logging and prints the conversation oldest first", async (t) => {
  const fixture = await createFixtureServer(t);
  const enabled = await runCli(["chatlog", "enable", "2610", ...fixture.cliArgs]);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.match(enabled.stdout, /Chat logging is ON for Ashen \(#2610\)/);

  const shown = await runCli([
    "chatlog",
    "2610",
    "--since",
    "2h",
    "--limit",
    "300",
    ...fixture.cliArgs,
  ]);
  assert.equal(shown.code, 0, shown.stderr);
  const first = shown.stdout.indexOf("mikey: first");
  const second = shown.stdout.indexOf("gf: second");
  assert.ok(first > 0 && second > first, shown.stdout);
  assert.match(shown.stdout, /\[inst1\]/);

  assert.deepEqual(
    fixture.requests
      .filter((r) => r.url.startsWith("/build/2610/"))
      .map((r) => `${r.method} ${r.url}`),
    [
      "PUT /build/2610/chat-log-setting",
      "GET /build/2610/chat-log?since=2h&limit=300",
    ],
  );
  assert.deepEqual(
    fixture.requests.find((r) => r.method === "PUT").body,
    { enabled: true },
  );
});

async function createFixtureServer(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-chatlog-"));
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({ method: req.method, url: req.url, body });
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
    if (req.method === "PUT" && req.url === "/build/2610/chat-log-setting") {
      res.end(
        JSON.stringify({
          buildId: 2610,
          title: "Ashen",
          enabled: Boolean(body?.enabled),
          retentionDays: 30,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/build/2610/chat-log?")) {
      res.end(
        JSON.stringify({
          buildId: 2610,
          title: "Ashen",
          enabled: true,
          retentionDays: 30,
          // newest first, as the API returns them
          messages: [
            { id: 2, createdAt: 1790420000, instanceId: "inst1", username: "gf", text: "second" },
            { id: 1, createdAt: 1790419990, instanceId: "inst1", username: "mikey", text: "first" },
          ],
          nextCursor: null,
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
    JSON.stringify({ token: "test-token", apiUrl, selectedBuildId: 2610 }),
    "utf8",
  );
  return {
    requests,
    cliArgs: ["--api-url", apiUrl, "--auth-file", authFile, "--no-update-check"],
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
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}
