import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  closeAppMcpSession,
  createAppMcpCall,
  createAppMcpSession,
  loadAppMcpCall,
} from "../api.js";
import { assertAuthScope, resolveAuth } from "../auth.js";
import { resolveRequiredBuildId } from "../util.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CALL_POLL_MS = 250;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openApp(url) {
  const command =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {
    process.stderr.write(
      `lumine app-mcp: open this signed-in app tab: ${url}\n`,
    );
  });
}

export async function appMcpCommand(options) {
  const buildId = resolveRequiredBuildId(options.target || options.buildIdFlag);
  if (!buildId) {
    throw new Error("Usage: lumine app-mcp <published-app-url-or-id>");
  }
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:read" });
  await assertAuthScope({ options, auth, scope: "build:write" });
  const created = await createAppMcpSession({ options, auth, buildId });
  const session = created?.session;
  if (!session?.id || !session?.manifest?.tools?.length) {
    if (session?.id) {
      await closeAppMcpSession({
        options,
        auth,
        buildId,
        sessionId: session.id,
      }).catch(() => {});
    }
    throw new Error("Twinkle did not return an app MCP session.");
  }
  try {
    if (options.openBrowser !== false) {
      openApp(session.appUrl);
    } else {
      process.stderr.write(
        `lumine app-mcp: open this signed-in app tab: ${session.appUrl}\n`,
      );
    }
    process.stderr.write(
      `lumine app-mcp: ${session.buildTitle} is pinned to artifact ${session.artifactVersionId}. ` +
        `Keep the opened Twinkle tab running.\n`,
    );

    const tools = session.manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {
        type: "object",
        additionalProperties: false,
      },
    }));
    const input = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });
    const pending = new Set();
    let toolCallQueue = Promise.resolve();
    input.on("line", (line) => {
      if (!line.trim()) return;
      const execute = () =>
        handleMcpMessage({
          line,
          options,
          auth,
          buildId,
          session,
          tools,
        });
      let isToolCall = false;
      try {
        isToolCall = JSON.parse(line)?.method === "tools/call";
      } catch {
        // The normal handler returns the canonical JSON-RPC parse error.
      }
      // App mutations are stateful and the browser runtime can execute only one
      // canonical call at a time. Preserve the MCP client's receive order so a
      // burst never depends on UUID or second-resolution database ordering.
      const operation = isToolCall
        ? (toolCallQueue = toolCallQueue.then(execute, execute))
        : execute();
      const observed = operation.catch((error) => {
        process.stderr.write(
          `lumine app-mcp: ${String(error?.message || error)}\n`,
        );
      });
      pending.add(observed);
      observed.finally(() => pending.delete(observed));
    });
    await new Promise((resolve) => input.once("close", resolve));
    await Promise.allSettled(Array.from(pending));
  } finally {
    await closeAppMcpSession({
      options,
      auth,
      buildId,
      sessionId: session.id,
    }).catch(() => {});
  }
}

async function callAppTool({
  options,
  auth,
  buildId,
  sessionId,
  name,
  arguments: toolArguments,
}) {
  const created = await createAppMcpCall({
    options,
    auth,
    buildId,
    sessionId,
    name,
    arguments: toolArguments,
  });
  const callId = created?.call?.id;
  if (!callId) throw new Error("Twinkle did not create the app tool call.");
  const deadline = Date.now() + CALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await loadAppMcpCall({
      options,
      auth,
      buildId,
      sessionId,
      callId,
    });
    const call = payload?.call;
    if (call?.status === "completed") return call.result;
    if (call?.status === "failed") {
      throw new Error(call.errorMessage || "App tool failed.");
    }
    await delay(CALL_POLL_MS);
  }
  const finalPayload = await loadAppMcpCall({
    options,
    auth,
    buildId,
    sessionId,
    callId,
  });
  if (finalPayload?.call?.status === "completed") {
    return finalPayload.call.result;
  }
  if (finalPayload?.call?.status === "failed") {
    throw new Error(finalPayload.call.errorMessage || "App tool failed.");
  }
  throw new Error("App tool call timed out. Keep the MCP app tab open.");
}

async function handleMcpMessage({ line, options, auth, buildId, session, tools }) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return writeMcpError(null, -32700, "Parse error");
  }
  const id = message?.id;
  const method = String(message?.method || "");
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    return writeMcpResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: `lumine-app-${buildId}`,
        version: "1.0.0",
      },
      instructions:
        session.manifest.description ||
        `Use the semantic tools exposed by ${session.buildTitle}.`,
    });
  }
  if (method === "ping") return writeMcpResult(id, {});
  if (method === "tools/list") return writeMcpResult(id, { tools });
  if (method === "tools/call") {
    const name = String(message?.params?.name || "");
    if (!tools.some((tool) => tool.name === name)) {
      return writeMcpError(id, -32602, `Unknown tool: ${name}`);
    }
    try {
      const result = await callAppTool({
        options,
        auth,
        buildId,
        sessionId: session.id,
        name,
        arguments: message?.params?.arguments || {},
      });
      return writeMcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent:
          result && typeof result === "object" && !Array.isArray(result)
            ? result
            : { result },
        isError: false,
      });
    } catch (error) {
      return writeMcpResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: String(error?.message || error),
            }),
          },
        ],
        isError: true,
      });
    }
  }
  return writeMcpError(id, -32601, `Method not found: ${method}`);
}

function writeMcpResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeMcpError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}
