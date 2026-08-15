import readline from "node:readline";

import { resolveAuth } from "../auth.js";
import { createExternalAgentToolSession } from "./tool-session.js";
import { readAgentRuntimeFile } from "./trace.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

export async function agentMcpCommand(options) {
  if (!options.runtimeFile) {
    throw new Error("agent-mcp requires --runtime-file.");
  }
  if (!options.traceFile) {
    throw new Error("agent-mcp requires --trace-file.");
  }
  const runtimeEnvelope = await readAgentRuntimeFile(options.runtimeFile);
  const runtime = runtimeEnvelope.runtime;
  const buildId = Number(options.buildIdFlag || 0);
  if (!buildId) throw new Error("agent-mcp requires --build.");
  if (!options.baseFilesHash) {
    throw new Error("agent-mcp requires --base-files-hash.");
  }
  const auth = await resolveAuth(options);
  const session = await createExternalAgentToolSession({
    options,
    auth,
    buildId,
    baseFilesHash: options.baseFilesHash,
    dir: options.dir,
    runtime,
    traceFile: options.traceFile,
    provider: runtimeEnvelope.provider || "external",
  });
  const tools = (Array.isArray(runtime.tools) ? runtime.tools : [])
    .filter((tool) => tool?.type === "function" && tool?.name)
    .map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.parameters || {
        type: "object",
        additionalProperties: true,
      },
    }));

  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const pending = new Set();
  input.on("line", (line) => {
    if (!line.trim()) return;
    const operation = handleMcpMessage({ line, session, tools }).catch(
      (error) => {
        process.stderr.write(
          `lumine agent-mcp: ${String(error?.message || error)}\n`,
        );
      },
    );
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
  });
  await new Promise((resolve) => input.once("close", resolve));
  await Promise.allSettled(Array.from(pending));
}

async function handleMcpMessage({ line, session, tools }) {
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
      protocolVersion:
        String(message?.params?.protocolVersion || "") || MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "lumine-external-agent-runtime",
        version: "1.0.0",
      },
    });
  }
  if (method === "ping") return writeMcpResult(id, {});
  if (method === "tools/list") {
    return writeMcpResult(id, { tools });
  }
  if (method === "tools/call") {
    const toolName = String(message?.params?.name || "");
    const toolArguments = message?.params?.arguments || {};
    try {
      const output = await session.call(toolName, toolArguments);
      const isError = output?.ok === false || Boolean(output?.error);
      return writeMcpResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(output),
          },
        ],
        isError,
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
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    })}\n`,
  );
}
