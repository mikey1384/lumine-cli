import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  claimAppMcpPairing,
  closeAppMcpSession,
  createAppMcpCall,
  createAppMcpSession,
  loadAppMcpCall,
  setAppMcpHelperName,
} from "../api.js";
import { assertAuthScope, resolveAuth } from "../auth.js";
import { resolveRequiredBuildId } from "../util.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CALL_POLL_MS = 250;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PAIRED_SESSION_ENDED_MESSAGE =
  'The AI helper connection ended (the user clicked Disconnect or left the app). Ask them to click "Connect AI helper" in the app for a new code, then restart with lumine app-mcp <buildId> --code <code>.';

function rethrowPairedSessionError(error) {
  if (
    Number(error?.status || 0) === 404 &&
    /MCP session not found/i.test(String(error?.message || ""))
  ) {
    const ended = new Error(PAIRED_SESSION_ENDED_MESSAGE);
    ended.status = 404;
    throw ended;
  }
  throw error;
}

// MCP clients name themselves in initialize (clientInfo.name). This is only a
// label for the viewer's "AI helper connected" badge.
export function helperDisplayName(clientInfo) {
  const raw = String(clientInfo?.name || "").trim();
  if (!raw) return "";
  const known = [
    [/^claude[-_ ]?code/i, "Claude Code"],
    [/^codex/i, "Codex"],
    [/^claude/i, "Claude"],
    [/^cursor/i, "Cursor"],
  ];
  for (const [pattern, label] of known) {
    if (pattern.test(raw)) return label;
  }
  return raw.slice(0, 80);
}

// Read-only declarations travel to the MCP client as the standard
// readOnlyHint, plus a plain note for tools whose action decides.
export function toMcpTool(tool) {
  const readOnlyWhen =
    tool.readOnlyWhen && typeof tool.readOnlyWhen === "object"
      ? Object.entries(tool.readOnlyWhen)[0]
      : null;
  const note =
    readOnlyWhen && Array.isArray(readOnlyWhen[1])
      ? ` (Works without "Allow edits" when ${readOnlyWhen[0]} is ${readOnlyWhen[1].join(", ")}.)`
      : "";
  return {
    name: tool.name,
    description: `${tool.description || ""}${note}`.trim(),
    inputSchema: tool.inputSchema || {
      type: "object",
      additionalProperties: false,
    },
    ...(tool.readOnly === true ? { annotations: { readOnlyHint: true } } : {}),
  };
}

function pairedInstructions(session) {
  const readTools = (session.manifest?.tools || [])
    .filter((tool) => tool.readOnly === true)
    .map((tool) => tool.name);
  return [
    session.manifest?.description ||
      `Use the semantic tools exposed by ${session.buildTitle}.`,
    `You are attached to the user's own open ${session.buildTitle} tab: they see every change you make, live.`,
    "Start with a read-only state tool; what the user has selected or is looking at is usually in it.",
    session.allowEdits
      ? "Edits are allowed right now; the user can switch them off at any time."
      : `Edits are OFF until the user switches on "Allow edits" in the app. Until then only read-only calls work${
          readTools.length ? ` (${readTools.join(", ")})` : ""
        }; a write returns an "edits not allowed" error, so ask the user to switch it on.`,
  ].join(" ");
}

function rethrowAppMcpSessionError(error) {
  const message = String(error?.message || error);
  if (
    Number(error?.status || 0) === 404 &&
    /MCP session not found/i.test(message) &&
    !/restart the Lumine app-mcp driver/i.test(message)
  ) {
    const guided = new Error(
      `${message}. Restart the Lumine app-mcp driver and reopen its new appUrl.`,
    );
    guided.status = error.status;
    throw guided;
  }
  throw error;
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
    throw new Error(
      "Usage: lumine app-mcp <published-app-url-or-id> [--code <code>]",
    );
  }
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:read" });
  await assertAuthScope({ options, auth, scope: "build:write" });
  const paired = Boolean(options.pairingCode);
  const created = paired
    ? await claimAppMcpPairing({
        options,
        auth,
        buildId,
        code: options.pairingCode,
        helperName: options.helperName || null,
      })
    : await createAppMcpSession({ options, auth, buildId });
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
    if (paired) {
      process.stderr.write(
        `lumine app-mcp: attached to your open ${session.buildTitle} tab. ` +
          (session.allowEdits
            ? "Edits are allowed.\n"
            : 'Edits stay off until you switch on "Allow edits" in the app.\n'),
      );
    } else if (options.openBrowser !== false) {
      openApp(session.appUrl);
    } else {
      process.stderr.write(
        `lumine app-mcp: open this signed-in app tab: ${session.appUrl}\n`,
      );
    }
    if (!paired) {
      process.stderr.write(
        `lumine app-mcp: ${session.buildTitle} is pinned to artifact ${session.artifactVersionId}. ` +
          `Keep the opened Twinkle tab running.\n`,
      );
    }

    const tools = session.manifest.tools.map(toMcpTool);
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
          paired,
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
  paired = false,
}) {
  const rethrow = paired ? rethrowPairedSessionError : rethrowAppMcpSessionError;
  const created = await createAppMcpCall({
    options,
    auth,
    buildId,
    sessionId,
    name,
    arguments: toolArguments,
  }).catch(rethrow);
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
    }).catch(rethrow);
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
  }).catch(rethrow);
  if (finalPayload?.call?.status === "completed") {
    return finalPayload.call.result;
  }
  if (finalPayload?.call?.status === "failed") {
    throw new Error(finalPayload.call.errorMessage || "App tool failed.");
  }
  throw new Error(
    paired
      ? "App tool call timed out. Ask the user to keep the app tab open in front (background tabs can pause), then retry."
      : "App tool call timed out. Reload the appUrl tab, or restart the Lumine app-mcp driver and reopen its new appUrl.",
  );
}

async function handleMcpMessage({
  line,
  options,
  auth,
  buildId,
  session,
  tools,
  paired = false,
}) {
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
    const helperName = helperDisplayName(message?.params?.clientInfo);
    if (paired && helperName && !options.helperName) {
      // Label only; a failure here must never break the MCP handshake.
      await setAppMcpHelperName({
        options,
        auth,
        buildId,
        sessionId: session.id,
        helperName,
      }).catch(() => {});
    }
    return writeMcpResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: `lumine-app-${buildId}`,
        version: "1.0.0",
      },
      instructions: paired
        ? pairedInstructions(session)
        : session.manifest.description ||
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
        paired,
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
