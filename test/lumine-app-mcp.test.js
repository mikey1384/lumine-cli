import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");
const sessionId = "11111111-1111-4111-8111-111111111111";
const callId = "22222222-2222-4222-8222-222222222222";
const secondCallId = "33333333-3333-4333-8333-333333333333";

test("app-mcp serves pinned tools over clean stdio and closes its session", async (t) => {
  const fixture = await createFixtureServer(t);
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "app-mcp",
      "73",
      "--api-url",
      fixture.apiUrl,
      "--auth-file",
      fixture.authFile,
      "--no-open",
      "--no-update-check",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_state", arguments: { view: "home" } },
    })}\n`,
  );

  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  const responses = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 3, stdout);
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.protocolVersion, "2025-06-18");
  assert.deepEqual(byId.get(2).result.tools, [
    {
      name: "get_state",
      description: "Read the visible state",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ]);
  assert.deepEqual(byId.get(3).result.structuredContent, {
    result: [{ view: "home", ready: true }],
  });
  assert.match(
    stderr,
    new RegExp(`open this signed-in app tab: .*appMcpSession=${sessionId}`),
  );

  const callRequest = fixture.requests.find(
    (request) =>
      request.method === "POST" && request.url.endsWith("/calls"),
  );
  assert.deepEqual(callRequest?.body, {
    name: "get_state",
    arguments: { view: "home" },
  });
  assert.equal(
    fixture.requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url === `/cli/build/73/app-mcp/sessions/${sessionId}`,
    ),
    true,
  );
});

test("app-mcp preserves burst tool order and accepts large pipe frames", async (t) => {
  const fixture = await createFixtureServer(t, { probeOrdering: true });
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "app-mcp",
      "73",
      "--api-url",
      fixture.apiUrl,
      "--auth-file",
      fixture.authFile,
      "--no-open",
      "--no-update-check",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const largeValue = "step-data:" + "x".repeat(32 * 1024);
  const messages = [
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "get_state", arguments: { sequence: 1, largeValue } },
    },
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "get_state", arguments: { sequence: 2 } },
    },
  ];
  child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");

  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  const responses = stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(10).result.structuredContent.sequence, 1);
  assert.equal(byId.get(10).result.structuredContent.largeValueLength, largeValue.length);
  assert.equal(byId.get(11).result.structuredContent.sequence, 2);
  assert.equal(fixture.probe.secondCreatedBeforeFirstCompleted, false);
  assert.deepEqual(fixture.probe.createdSequences, [1, 2]);
});

test("app-mcp closes a malformed session before failing", async (t) => {
  const fixture = await createFixtureServer(t, { tools: [] });
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "app-mcp",
      "73",
      "--api-url",
      fixture.apiUrl,
      "--auth-file",
      fixture.authFile,
      "--no-open",
      "--no-update-check",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [code] = await once(child, "close");
  assert.notEqual(code, 0);
  assert.match(stderr, /Twinkle did not return an app MCP session/);
  assert.equal(
    fixture.requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.url === `/cli/build/73/app-mcp/sessions/${sessionId}`,
    ),
    true,
  );
});

test("app-mcp explains how to recover an expired session", async (t) => {
  const fixture = await createFixtureServer(t, { staleSession: true });
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "app-mcp",
      "73",
      "--api-url",
      fixture.apiUrl,
      "--auth-file",
      fixture.authFile,
      "--no-open",
      "--no-update-check",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "get_state", arguments: {} },
    })}\n`,
  );

  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.result.isError, true);
  const payload = JSON.parse(response.result.content[0].text);
  assert.match(payload.error, /Restart the Lumine app-mcp driver/);
  assert.match(payload.error, /reopen its new appUrl/);
});

test("app-mcp surfaces an unresponsive browser heartbeat without waiting for its local timeout", async (t) => {
  const fixture = await createFixtureServer(t, { unresponsiveCall: true });
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "app-mcp",
      "73",
      "--api-url",
      fixture.apiUrl,
      "--auth-file",
      fixture.authFile,
      "--no-open",
      "--no-update-check",
    ],
    {
      cwd: path.resolve(__dirname, ".."),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "get_state", arguments: {} },
    })}\n`,
  );

  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(JSON.parse(stdout.trim()).result.content[0].text);
  assert.match(payload.error, /MCP session unresponsive/);
  assert.match(payload.error, /Reload the appUrl tab/);
  assert.match(payload.error, /verify state, then retry/);
});

async function createFixtureServer(
  t,
  {
    tools = null,
    probeOrdering = false,
    staleSession = false,
    unresponsiveCall = false,
  } = {},
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-app-mcp-"));
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const calls = new Map();
  const probe = {
    firstCallCompleted: false,
    secondCreatedBeforeFirstCompleted: false,
    createdSequences: [],
  };
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "mikey",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/build/73/app-mcp/sessions"
    ) {
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          session: {
            id: sessionId,
            buildId: 73,
            buildTitle: "State Viewer",
            artifactVersionId: 91,
            appUrl: `https://www.twin-kle.com/app/73?appMcpSession=${sessionId}`,
            expiresAt: 9_999_999_999,
            manifest: {
              version: 1,
              name: "State Viewer",
              description: "Inspect the app",
              tools:
                tools || [
                  {
                    name: "get_state",
                    description: "Read the visible state",
                    inputSchema: {
                      type: "object",
                      additionalProperties: false,
                    },
                  },
                ],
            },
          },
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === `/cli/build/73/app-mcp/sessions/${sessionId}/calls`
    ) {
      if (staleSession) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "MCP session not found" }));
        return;
      }
      const sequence = calls.size + 1;
      const nextCallId = sequence === 1 ? callId : secondCallId;
      calls.set(nextCallId, { sequence, arguments: body?.arguments || {} });
      probe.createdSequences.push(Number(body?.arguments?.sequence || sequence));
      if (sequence === 2 && !probe.firstCallCompleted) {
        probe.secondCreatedBeforeFirstCompleted = true;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ call: { id: nextCallId, status: "pending" } }));
      return;
    }
    const statusPrefix = `/cli/build/73/app-mcp/sessions/${sessionId}/calls/`;
    if (req.method === "POST" && req.url?.startsWith(statusPrefix) && req.url.endsWith("/status")) {
      const statusCallId = req.url.slice(statusPrefix.length, -"/status".length);
      const call = calls.get(statusCallId);
      if (!call) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "call not found" }));
        return;
      }
      if (probeOrdering && call.sequence === 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        probe.firstCallCompleted = true;
      }
      res.end(
        JSON.stringify({
          call: {
            id: statusCallId,
            status: unresponsiveCall ? "failed" : "completed",
            errorMessage: unresponsiveCall
              ? "MCP session unresponsive. The call may have partially run. Reload the appUrl tab, verify state, then retry, or restart the Lumine app-mcp driver and reopen its new appUrl."
              : null,
            result: unresponsiveCall
              ? null
              : probeOrdering
                ? {
                    sequence: call.sequence,
                    largeValueLength: String(call.arguments.largeValue || "").length,
                  }
                : [{ view: "home", ready: true }],
          },
        }),
      );
      return;
    }
    if (
      req.method === "DELETE" &&
      req.url === `/cli/build/73/app-mcp/sessions/${sessionId}`
    ) {
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(async () => {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  await fs.writeFile(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );
  return { apiUrl, authFile, requests, probe };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
