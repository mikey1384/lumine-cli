import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLumineSaveClientContext } from "../lib/api.js";
import { resolveExternalAgentProvider } from "../lib/agent/providers/index.js";
import { runCodexAgentPass } from "../lib/agent/providers/codex.js";
import {
  reviewClaudeCodeAgentLoop,
  runClaudeCodeAgentPass,
} from "../lib/agent/providers/claude-code.js";
import { createSubscriptionAgentEnvironment } from "../lib/agent/providers/environment.js";
import { createExternalAgentToolSession } from "../lib/agent/tool-session.js";
import { readAgentTrace } from "../lib/agent/trace.js";
import { parseArgs } from "../lib/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

test("a rejected validation-repair scope pass restores the accepted workspace snapshot", async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, "../lib/agent.js"),
    "utf8",
  );
  const repairScopeFailure = source.slice(
    source.indexOf('if (runtime.phase === "validation_repair")'),
    source.indexOf("if (scopeRepairAttempts >= 1)"),
  );
  assert.match(
    repairScopeFailure,
    /replaceWorkspaceWithSnapshot\([\s\S]*?currentFiles: candidateFiles[\s\S]*?snapshotFiles: scopeBaseFiles/,
  );
  assert.match(repairScopeFailure, /currentFiles = scopeBaseFiles/);
  assert.match(repairScopeFailure, /throw new Error/);
});

test("agent command requires an explicit provider and keeps the request intact", () => {
  const options = parseArgs([
    "agent",
    "--provider",
    "claude-code",
    "Fix",
    "the",
    "mobile",
    "layout",
    "--no-review-loop",
  ]);
  assert.equal(options.command, "agent");
  assert.equal(options.provider, "claude-code");
  assert.equal(options.agentPrompt, "Fix the mobile layout");
  assert.equal(options.reviewLoop, false);
  assert.equal(resolveExternalAgentProvider("claude").id, "claude-code");
  assert.equal(resolveExternalAgentProvider("codex").id, "codex");
  assert.throws(() => resolveExternalAgentProvider("unknown"), /--provider/);
});

test("agent request size is rejected locally before authentication", async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, "../lib/agent.js"),
    "utf8",
  );
  const requestLimit = source.indexOf(
    "userMessage.length > MAX_AGENT_REQUEST_LENGTH",
  );
  const authentication = source.indexOf(
    "const auth = await resolveAuth(options)",
  );
  assert.ok(requestLimit >= 0 && authentication > requestLimit);
  assert.match(source, /const MAX_AGENT_REQUEST_LENGTH = 20_000/);
});

test("external provider provenance overrides the process that launched Lumine", () => {
  assert.equal(
    createLumineSaveClientContext(
      {
        lumineCli: { version: "0.2.39" },
        externalAgentProvider: "claude-code",
      },
      { CODEX_CI: "1" },
    ).agentEnvironment,
    "claude_code",
  );
});

test("subscription provider processes do not inherit Twinkle or API-key credentials", () => {
  assert.deepEqual(
    createSubscriptionAgentEnvironment({
      HOME: "/Users/example",
      PATH: "/usr/bin",
      TWINKLE_AUTH_TOKEN: "twinkle-secret",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    }),
    {
      HOME: "/Users/example",
      PATH: "/usr/bin",
    },
  );
});

test("tool session applies only the project snapshot returned by Lumine and records a sanitized trace", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-agent-tool-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "index.html"), "<main>SECRET old</main>");
  const traceFile = path.join(dir, "trace.jsonl");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => ({
    ok: true,
    status: 200,
    async text() {
      const body = JSON.parse(init.body);
      assert.equal(body.name, "edit_project_file");
      return JSON.stringify({
        projectFiles: [
          { path: "/index.html", content: "<main>SECRET new</main>" },
        ],
        readPaths: ["/index.html"],
        output: { ok: true, path: "/index.html" },
      });
    },
  });

  const session = await createExternalAgentToolSession({
    options: { apiUrl: "https://api.example.test", timeoutMs: 1000 },
    auth: { token: "test-token" },
    buildId: 73,
    baseFilesHash: "a".repeat(64),
    dir,
    runtime: { maxToolRounds: 1, phase: "implementation" },
    traceFile,
    provider: "codex",
    initialFiles: [{ path: "/index.html", content: "<main>SECRET old</main>" }],
  });
  const output = await session.call("edit_project_file", {
    path: "/index.html",
    old_string: "SECRET old",
    new_string: "SECRET new",
    replace_all: false,
  });
  assert.equal(output.ok, true);
  assert.equal(
    await fs.readFile(path.join(dir, "index.html"), "utf8"),
    "<main>SECRET new</main>",
  );
  const traceText = await fs.readFile(traceFile, "utf8");
  assert.doesNotMatch(traceText, /SECRET/);
  const events = await readAgentTrace(traceFile);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_call", "tool_result"],
  );
  assert.deepEqual(events[1].changedPaths, ["/index.html"]);
  for (let call = 2; call <= 8; call += 1) {
    const withinHostedRoundAllowance = await session.call("edit_project_file", {
      path: "/index.html",
      old_string: "unused",
      new_string: `unused-${call}`,
      replace_all: false,
    });
    assert.equal(withinHostedRoundAllowance.ok, true);
  }
  const overCallSafetyCeiling = await session.call("edit_project_file", {});
  assert.equal(overCallSafetyCeiling.ok, false);
  assert.match(overCallSafetyCeiling.error, /after 8 tool calls/);
});

test("agent-mcp owns stdout and exposes only the supplied Lumine tools", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-agent-mcp-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtimeFile = path.join(dir, "runtime.json");
  const traceFile = path.join(dir, "trace.jsonl");
  const authFile = path.join(dir, "auth.json");
  await fs.writeFile(path.join(dir, "index.html"), "<main>ok</main>");
  await fs.writeFile(
    runtimeFile,
    JSON.stringify({
      schemaVersion: 1,
      runId: "test-run",
      provider: "claude-code",
      runtime: {
        phase: "implementation",
        maxToolRounds: 16,
        tools: [
          {
            type: "function",
            name: "read_project_files",
            description: "Read files",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    }),
  );
  await fs.writeFile(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl: "http://127.0.0.1:9" }),
  );

  const child = spawn(
    process.execPath,
    [
      cliPath,
      "agent-mcp",
      "--dir",
      dir,
      "--runtime-file",
      runtimeFile,
      "--trace-file",
      traceFile,
      "--api-url",
      "http://127.0.0.1:9",
      "--auth-file",
      authFile,
      "--build",
      "73",
      "--base-files-hash",
      "a".repeat(64),
      "--no-update-check",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
      "",
    ].join("\n"),
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  const messages = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(
    messages[1].result.tools.map((tool) => tool.name),
    ["read_project_files"],
  );
});

test("tool snapshots cannot write through a workspace symlink", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-agent-link-"));
  const outsideDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-agent-outside-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "index.html"), "<main>safe</main>");
  await fs.symlink(outsideDir, path.join(dir, "escape"));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        projectFiles: [
          { path: "/index.html", content: "<main>safe</main>" },
          { path: "/escape/secret.txt", content: "must stay contained" },
        ],
        readPaths: [],
        output: { ok: true },
      });
    },
  });
  const session = await createExternalAgentToolSession({
    options: { apiUrl: "https://api.example.test", timeoutMs: 1000 },
    auth: { token: "test-token" },
    buildId: 73,
    baseFilesHash: "a".repeat(64),
    dir,
    runtime: { maxToolRounds: 1, phase: "implementation" },
    traceFile: path.join(dir, "trace.jsonl"),
    provider: "codex",
    initialFiles: [{ path: "/index.html", content: "<main>safe</main>" }],
  });

  await assert.rejects(
    () => session.call("apply_project_file_changes", { operations: [] }),
    /traverses a symbolic link/,
  );
  await assert.rejects(
    () => fs.access(path.join(outsideDir, "secret.txt")),
    /ENOENT/,
  );
});

test("Codex adapter answers app-server dynamic tool calls through the Lumine session", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-codex-adapter-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fakeCodex = path.join(dir, "fake-codex");
  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] === "features") {
  process.stdout.write("apps stable true\\ncode_mode_host stable true\\nshell_tool stable true\\nunified_exec stable true\\n");
  process.exit(0);
}
if (process.argv[2] === "mcp") {
  process.stdout.write("[]\\n");
  process.exit(0);
}
if (!process.argv.includes("--disable") || !process.argv.includes("code_mode_host")) process.exit(3);
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.experimentalApi !== true) process.exit(4);
    send({ id: message.id, result: { userAgent: "codex-cli/1.2.3" } });
  }
  if (message.method === "thread/start") {
    if (message.params?.model !== "gpt-5.6" || message.params?.serviceTier !== "priority") process.exit(5);
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.6", reasoningEffort: "medium", serviceTier: "priority" } });
  }
  if (message.method === "mcpServerStatus/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "turn/start") {
    if (message.params?.effort !== "max") process.exit(6);
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
    send({ jsonrpc: "2.0", method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: { model: "gpt-5.6-sol", effort: "max", serviceTier: "priority" } } });
    send({ jsonrpc: "2.0", id: 91, method: "item/tool/call", params: { tool: "read_project_files", arguments: { paths: ["/index.html"] } } });
  }
  if (message.id === 91 && !message.method) {
    send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 120, outputTokens: 30 } } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text: "Changed through Lumine." } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed", error: null } } });
  }
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(fakeCodex, 0o755);
  const calls = [];
  const result = await runCodexAgentPass({
    options: {
      providerPath: fakeCodex,
      model: "gpt-5.6",
      agentEffort: "max",
      serviceTier: "priority",
    },
    runtime: {
      systemPrompt: "Lumine system",
      initialPrompt: "Do the work",
      tools: [
        {
          type: "function",
          name: "read_project_files",
          description: "Read",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    toolSession: {
      async call(name, args) {
        calls.push({ name, args });
        return { ok: true };
      },
    },
    isolationDir: dir,
  });
  assert.equal(result.finalText, "Changed through Lumine.");
  assert.deepEqual(result.provenance, {
    resolvedModel: "gpt-5.6-sol",
    resolvedEffort: "max",
    resolvedServiceTier: "priority",
    runtimeVersion: "codex-cli/1.2.3",
    evidenceTier: "runtime_observed",
    usage: { inputTokens: 120, outputTokens: 30 },
  });
  assert.deepEqual(calls, [
    {
      name: "read_project_files",
      args: { paths: ["/index.html"] },
    },
  ]);
});

test("Claude Code adapter uses the selected local subscription CLI", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-claude-adapter-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fakeClaude = path.join(dir, "fake-claude");
  await fs.writeFile(
    fakeClaude,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", claude_code_version: "2.1.0" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", effort: "high", usage: { input_tokens: 80 }, content: [{ type: "text", text: "Worked through MCP." }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "Worked through MCP.", service_tier: "subscription", usage: { output_tokens: 20 } }) + "\\n");
`,
    { mode: 0o755 },
  );
  await fs.chmod(fakeClaude, 0o755);
  const result = await runClaudeCodeAgentPass({
    options: {
      providerPath: fakeClaude,
      authToken: null,
      authFile: path.join(dir, "auth.json"),
      apiUrl: "https://api.example.test",
      model: "",
      agentEffort: "",
    },
    runtime: {
      systemPrompt: "Lumine system",
      initialPrompt: "Do the work",
    },
    isolationDir: dir,
    mcp: {
      cliPath,
      dir,
      runtimeFile: path.join(dir, "runtime.json"),
      traceFile: path.join(dir, "trace.jsonl"),
      buildId: 73,
      baseFilesHash: "a".repeat(64),
    },
  });
  assert.equal(result.finalText, "Worked through MCP.");
  assert.deepEqual(result.provenance, {
    resolvedModel: "claude-opus-5",
    resolvedEffort: "high",
    resolvedServiceTier: "subscription",
    runtimeVersion: "2.1.0",
    evidenceTier: "provider_reported",
    usage: { input_tokens: 80, output_tokens: 20 },
  });
});

test("Claude Code loop review excludes inherited tools and MCP servers", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-claude-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fakeClaude = path.join(dir, "fake-claude-review");
  await fs.writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const strictIndex = args.indexOf("--strict-mcp-config");
const configIndex = args.indexOf("--mcp-config");
const allowedIndex = args.indexOf("--allowedTools");
if (strictIndex < 0 || configIndex < 0 || allowedIndex < 0) process.exit(4);
const config = JSON.parse(args[configIndex + 1]);
if (Object.keys(config.mcpServers || {}).length !== 0 || args[allowedIndex + 1] !== "") process.exit(5);
process.stdout.write(JSON.stringify({ result: "", structured_output: { summary: "clean", observations: [] } }));
`,
    { mode: 0o755 },
  );
  await fs.chmod(fakeClaude, 0o755);

  assert.deepEqual(
    await reviewClaudeCodeAgentLoop({
      options: { providerPath: fakeClaude, model: "", agentEffort: "" },
      isolationDir: dir,
      prompt: "Review the trace",
      systemPrompt: "Return JSON",
      outputSchema: { type: "object" },
    }),
    { summary: "clean", observations: [] },
  );
});

test("agent command completes the Lumine tool-validation-save pipeline without a Twinkle model call", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-agent-e2e-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [];
  const filesHash = "a".repeat(64);
  const nextFilesHash = "b".repeat(64);
  const build = {
    id: 73,
    title: "Loop Test",
    role: "owner",
    canWrite: true,
    canPublish: true,
    contributionStatus: "none",
    contributionRootBuildId: null,
    projectLimits: {
      maxFilesPerProject: 100,
      maxProjectBytes: 1024 * 1024,
      maxFileLines: 500,
    },
  };
  const server = http.createServer(async (req, res) => {
    const bodyText = await new Promise((resolve) => {
      let value = "";
      req.on("data", (chunk) => {
        value += chunk;
      });
      req.on("end", () => resolve(value));
    });
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      return res.end(
        JSON.stringify({
          userId: 7,
          username: "tester",
          scopes: ["build:read", "build:write"],
        }),
      );
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/build/73/files?includeContent=0"
    ) {
      return res.end(JSON.stringify({ build }));
    }
    if (req.method === "POST" && req.url === "/cli/build/73/agent/runtime") {
      assert.equal(body.baseFilesHash, filesHash);
      return res.end(
        JSON.stringify({
          build,
          baseFilesHash: filesHash,
          runtime: {
            version: 1,
            phase: "implementation",
            systemPrompt: "Use Lumine tools.",
            initialPrompt: "Change old to new.",
            maxToolRounds: 16,
            billing: {
              modelProvider: "external_local_agent",
              usesTwinkleAiEnergy: false,
            },
            tools: [
              {
                type: "function",
                name: "read_project_files",
                description: "Read",
                parameters: { type: "object", properties: {} },
              },
              {
                type: "function",
                name: "edit_project_file",
                description: "Edit",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        }),
      );
    }
    if (req.method === "POST" && req.url === "/cli/build/73/agent/tool") {
      if (body.name === "read_project_files") {
        return res.end(
          JSON.stringify({
            projectFiles: body.projectFiles,
            readPaths: ["/index.html"],
            output: {
              ok: true,
              matchedFiles: [
                { path: "/index.html", content: "1 | <main>old</main>" },
              ],
            },
          }),
        );
      }
      assert.equal(body.name, "edit_project_file");
      assert.deepEqual(body.readPaths, ["/index.html"]);
      return res.end(
        JSON.stringify({
          projectFiles: [{ path: "/index.html", content: "<main>new</main>" }],
          readPaths: ["/index.html"],
          output: { ok: true, path: "/index.html" },
        }),
      );
    }
    if (req.method === "POST" && req.url === "/cli/build/73/agent/validate") {
      assert.deepEqual(body.candidateFiles, [
        { path: "/index.html", content: "<main>new</main>" },
      ]);
      return res.end(
        JSON.stringify({
          ok: true,
          changed: true,
          projectFiles: [
            { path: "/index.html", content: "<main>canonical</main>" },
          ],
        }),
      );
    }
    if (req.method === "PUT" && req.url === "/build/73/project-files") {
      assert.equal(body.baseFilesHash, filesHash);
      assert.equal(body.clientContext.agentEnvironment, "codex");
      assert.deepEqual(body.files, [
        { path: "/index.html", content: "<main>canonical</main>" },
      ]);
      return res.end(
        JSON.stringify({
          success: true,
          build,
          filesHash: nextFilesHash,
          projectManifest: { entryPath: "/index.html" },
          artifactVersion: { versionId: 9, versionNumber: 2 },
          releaseStatus: { state: "unpublished_changes" },
        }),
      );
    }
    res.statusCode = 404;
    return res.end(
      JSON.stringify({ error: `Unhandled ${req.method} ${req.url}` }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const metadataDir = path.join(dir, ".twinkle");
  const authFile = path.join(metadataDir, "auth.json");
  await fs.mkdir(metadataDir);
  await fs.writeFile(path.join(dir, "index.html"), "<main>old</main>");
  await fs.writeFile(authFile, JSON.stringify({ token: "test-token", apiUrl }));
  await fs.writeFile(
    path.join(metadataDir, "lumine-project.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: 73,
      build,
      apiUrl,
      siteUrl: "https://www.twin-kle.com",
      filesHash,
    }),
  );
  const fakeCodex = path.join(dir, "fake-codex");
  await fs.writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] === "features") {
  process.stdout.write("apps stable true\\nshell_tool stable true\\nunified_exec stable true\\n");
  process.exit(0);
}
if (process.argv[2] === "mcp") {
  process.stdout.write("[]\\n");
  process.exit(0);
}
if (!process.argv.includes("--disable")) process.exit(3);
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.experimentalApi !== true) process.exit(4);
    send({ id: message.id, result: {} });
  }
  if (message.method === "thread/start") send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
  if (message.method === "mcpServerStatus/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
    send({ jsonrpc: "2.0", id: 91, method: "item/tool/call", params: { tool: "read_project_files", arguments: { paths: ["/index.html"] } } });
  }
  if (message.id === 91 && !message.method) send({ jsonrpc: "2.0", id: 92, method: "item/tool/call", params: { tool: "edit_project_file", arguments: { path: "/index.html", old_string: "old", new_string: "new", replace_all: false } } });
  if (message.id === 92 && !message.method) {
    send({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", text: "Updated the greeting through Lumine." } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { status: "completed", error: null } } });
  }
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(fakeCodex, 0o755);

  const child = spawn(
    process.execPath,
    [
      cliPath,
      "agent",
      "--provider",
      "codex",
      "Change the greeting",
      "--provider-path",
      fakeCodex,
      "--dir",
      dir,
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-review-loop",
      "--no-update-check",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Twinkle AI Energy: 0/);
  assert.match(stdout, /Saved Loop Test \(#73\) v2/);
  assert.match(stdout, /Updated the greeting through Lumine/);
  assert.equal(
    await fs.readFile(path.join(dir, "index.html"), "utf8"),
    "<main>canonical</main>",
  );
  assert.equal(
    requests.some((request) => String(request.url).includes("build_generate")),
    false,
  );
});
