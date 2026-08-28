import { spawn } from "node:child_process";
import readline from "node:readline";

import { createSubscriptionAgentEnvironment } from "./environment.js";

const CODEX_DISABLED_BUILT_IN_FEATURES = [
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "default_mode_request_user_input",
  "deferred_executor",
  "deferred_tool_world_state",
  "enable_mcp_apps",
  "exec_permission_approvals",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "goals",
  "guardian_approval",
  "guardianv2",
  "hooks",
  "image_generation",
  "in_app_browser",
  "js_repl",
  "js_repl_tools_only",
  "memories",
  "multi_agent",
  "network_proxy",
  "plugins",
  "plugin_sharing",
  "recommended_plugins",
  "remote_plugin",
  "request_permissions_tool",
  "respect_system_proxy",
  "realtime_conversation",
  "skill_mcp_dependency_install",
  "skill_search",
  "shell_snapshot",
  "shell_tool",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "use_agent_identity",
  "view_image",
  "workspace_dependencies",
];
const CODEX_PREFLIGHT_OUTPUT_LIMIT = 1024 * 1024;
const CODEX_PREFLIGHT_TIMEOUT_MS = 10_000;

const CODEX_RUNTIME_BASE_INSTRUCTIONS = `You are the model inside a Lumine external-agent runtime.
Use only the dynamic Lumine tools supplied by the host for project inspection and changes.
Do not use shell commands, filesystem tools, patches, web search, subagents, or skills.
The real project is not mounted in your working directory; Lumine tools are its only source of truth.
Follow the developer instructions and return only the requested short user-facing final response.
Never reveal hidden chain-of-thought or private reasoning.`;

export async function runCodexAgentPass({
  options,
  runtime,
  toolSession,
  isolationDir,
}) {
  const result = await runCodexAppServerTurn({
    options,
    isolationDir,
    baseInstructions: CODEX_RUNTIME_BASE_INSTRUCTIONS,
    developerInstructions: runtime.systemPrompt,
    prompt: runtime.initialPrompt,
    tools: runtime.tools,
    toolSession,
  });
  return {
    finalText: result.finalText,
    provenance: result.provenance,
  };
}

export async function reviewCodexAgentLoop({
  options,
  isolationDir,
  prompt,
  systemPrompt,
  outputSchema,
}) {
  const result = await runCodexAppServerTurn({
    options,
    isolationDir,
    baseInstructions:
      "Review only the supplied observable runtime trace. Do not use tools or expose hidden reasoning. Return JSON matching the requested schema.",
    developerInstructions: systemPrompt,
    prompt,
    tools: [],
    toolSession: null,
    outputSchema,
  });
  return parseStructuredResult(result.finalText);
}

async function runCodexAppServerTurn({
  options,
  isolationDir,
  baseInstructions,
  developerInstructions,
  prompt,
  tools,
  toolSession,
  outputSchema,
}) {
  const binary =
    options.providerPath || process.env.LUMINE_CODEX_PATH || "codex";
  const providerEnvironment = createSubscriptionAgentEnvironment();
  let isolationArgs;
  try {
    isolationArgs = await loadCodexIsolationArgs({
      binary,
      cwd: isolationDir,
      environment: providerEnvironment,
      signal: options.agentAbortSignal,
    });
  } catch (error) {
    throw normalizeProviderLaunchError(error, binary, "Codex");
  }
  const child = spawn(binary, ["app-server", "--stdio", ...isolationArgs], {
    cwd: isolationDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: providerEnvironment,
    ...(options.agentAbortSignal ? { signal: options.agentAbortSignal } : {}),
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let childInputError = null;
  child.stdin.on("error", (error) => {
    childInputError ||= error;
  });

  let nextRequestId = 1;
  const pendingRequests = new Map();
  let completedTurn = null;
  let initializedServer = null;
  let startedThreadResult = null;
  let latestThreadSettings = null;
  let latestTokenUsage = null;
  let reroutedModel = null;
  let completedTurnResolve;
  const completedTurnPromise = new Promise((resolve) => {
    completedTurnResolve = resolve;
  });
  const completedMessages = [];
  let deltaText = "";
  const inheritedMcpServers = new Set();

  function send(message) {
    if (childInputError || child.stdin.destroyed || child.stdin.writableEnded) {
      return false;
    }
    // App-server uses JSON-RPC semantics but intentionally omits the jsonrpc
    // header on its JSONL wire format.
    const { jsonrpc: _jsonrpc, ...wireMessage } = message;
    try {
      child.stdin.write(`${JSON.stringify(wireMessage)}\n`);
      return true;
    } catch (error) {
      childInputError ||= error;
      return false;
    }
  }

  function request(method, params) {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      if (!send({ jsonrpc: "2.0", id, method, params })) {
        pendingRequests.delete(id);
        reject(new Error("Codex app-server input closed."));
      }
    });
  }

  async function handleServerRequest(message) {
    if (message.method !== "item/tool/call") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported Codex server request: ${message.method}`,
        },
      });
      return;
    }
    if (!toolSession) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                ok: false,
                error: "Tools are disabled for this turn.",
              }),
            },
          ],
          success: false,
        },
      });
      return;
    }
    try {
      const output = await toolSession.call(
        message.params?.tool,
        message.params?.arguments || {},
      );
      const success = output?.ok !== false && !output?.error;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contentItems: [{ type: "inputText", text: JSON.stringify(output) }],
          success,
        },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                ok: false,
                error: String(error?.message || error),
              }),
            },
          ],
          success: false,
        },
      });
    }
  }

  const output = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
    terminal: false,
  });
  output.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            message.error?.message || "Codex app-server request failed.",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      void handleServerRequest(message);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      deltaText += String(message.params?.delta || "");
      return;
    }
    if (message.method === "mcpServer/startupStatus/updated") {
      const status = String(message.params?.status || "");
      const name = String(message.params?.name || "").trim();
      if (name && (status === "starting" || status === "ready")) {
        inheritedMcpServers.add(name);
      }
      return;
    }
    if (message.method === "thread/settings/updated") {
      latestThreadSettings = message.params?.threadSettings || null;
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      latestTokenUsage = message.params?.tokenUsage || null;
      return;
    }
    if (message.method === "model/rerouted") {
      reroutedModel = firstNonEmptyString(message.params?.toModel);
      return;
    }
    if (
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage"
    ) {
      const text = String(message.params.item.text || "").trim();
      if (text) completedMessages.push(text);
      return;
    }
    if (message.method === "turn/completed") {
      completedTurn = message.params?.turn || null;
      completedTurnResolve(completedTurn);
    }
  });

  const childErrorPromise = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (completedTurn) return;
      reject(
        new Error(
          `Codex app-server exited before the turn completed (${signal || code}).`,
        ),
      );
    });
  });

  try {
    initializedServer = await Promise.race([
      request("initialize", {
        clientInfo: {
          name: "lumine-cli",
          title: "Lumine CLI",
          version: "1",
        },
        // Dynamic tools are an experimental app-server capability. Without
        // this explicit opt-in Codex may silently omit Lumine's tool surface.
        capabilities: { experimentalApi: true },
      }),
      childErrorPromise,
    ]);
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const threadResult = await request("thread/start", {
      ...(options.model ? { model: options.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      cwd: isolationDir,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      historyMode: "paginated",
      environments: [],
      baseInstructions,
      developerInstructions,
      dynamicTools: toCodexDynamicTools(tools),
    });
    startedThreadResult = threadResult || null;
    const threadId = String(threadResult?.thread?.id || "");
    if (!threadId) throw new Error("Codex did not return a thread ID.");
    await delay(250);
    const mcpInventory = await request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
      limit: 100,
    });
    const inheritedToolServers = (
      Array.isArray(mcpInventory?.data) ? mcpInventory.data : []
    )
      .filter((server) => Object.keys(server?.tools || {}).length > 0)
      .map((server) => String(server?.name || "").trim())
      .filter(Boolean);
    if (mcpInventory?.nextCursor) {
      throw new Error(
        "Codex reported more inherited MCP servers than Lumine could verify safely.",
      );
    }
    const inheritedServerNames = Array.from(
      new Set([...inheritedMcpServers, ...inheritedToolServers]),
    ).sort();
    if (inheritedServerNames.length > 0) {
      throw new Error(
        `Codex still exposed non-Lumine MCP tools (${inheritedServerNames.join(", ")}). The run was stopped before the model received the project prompt.`,
      );
    }
    await request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(options.agentEffort ? { effort: options.agentEffort } : {}),
      ...(outputSchema ? { outputSchema } : {}),
    });
    const turn = await Promise.race([completedTurnPromise, childErrorPromise]);
    if (turn?.status !== "completed") {
      throw new Error(
        turn?.error?.message || `Codex turn ended with status ${turn?.status}.`,
      );
    }
    const finalText =
      completedMessages.at(-1) || String(deltaText || "").trim();
    const resolvedModel = firstNonEmptyString(
      reroutedModel,
      latestThreadSettings?.model,
      startedThreadResult?.model,
      startedThreadResult?.thread?.model,
    );
    const resolvedEffort = firstNonEmptyString(
      latestThreadSettings?.effort,
      startedThreadResult?.reasoningEffort,
      startedThreadResult?.thread?.effort,
      startedThreadResult?.thread?.reasoningEffort,
    );
    const resolvedServiceTier = firstNonEmptyString(
      latestThreadSettings?.serviceTier,
      startedThreadResult?.serviceTier,
      startedThreadResult?.thread?.serviceTier,
      startedThreadResult?.thread?.service_tier,
    );
    return {
      finalText,
      provenance: {
        resolvedModel,
        resolvedEffort,
        resolvedServiceTier,
        runtimeVersion: firstNonEmptyString(
          initializedServer?.userAgent,
          initializedServer?.serverInfo?.version,
          initializedServer?.server_info?.version,
        ),
        evidenceTier:
          resolvedModel || resolvedEffort || resolvedServiceTier
            ? "runtime_observed"
            : "requested_only",
        usage: normalizeUsageEvidence(
          latestTokenUsage?.last || latestTokenUsage?.total || turn?.usage,
        ),
      },
    };
  } catch (error) {
    throw normalizeProviderLaunchError(error, binary, "Codex");
  } finally {
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error("Codex app-server closed."));
    }
    pendingRequests.clear();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    output.close();
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized.slice(0, 160);
  }
  return null;
}

function normalizeUsageEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, amount]) =>
        ["number", "string", "boolean"].includes(typeof amount),
      )
      .slice(0, 30),
  );
}

async function loadCodexIsolationArgs({ binary, cwd, environment, signal }) {
  const [featureOutput, mcpOutput] = await Promise.all([
    runCodexInspectionCommand({
      binary,
      args: ["features", "list"],
      cwd,
      environment,
      signal,
      label: "feature inventory",
    }),
    runCodexInspectionCommand({
      binary,
      args: ["mcp", "list", "--json"],
      cwd,
      environment,
      signal,
      label: "MCP inventory",
    }),
  ]);
  const availableFeatures = new Set(
    featureOutput
      .split("\n")
      .map(
        (line) =>
          String(line || "")
            .trim()
            .split(/\s+/)[0],
      )
      .filter((name) => /^[a-z][a-z0-9_]*$/.test(name)),
  );
  let mcpServers;
  try {
    mcpServers = JSON.parse(mcpOutput);
  } catch {
    throw new Error(
      "Codex returned an invalid MCP inventory; Lumine cannot prove tool isolation.",
    );
  }
  if (!Array.isArray(mcpServers)) {
    throw new Error(
      "Codex returned an invalid MCP inventory; Lumine cannot prove tool isolation.",
    );
  }

  const args = [];
  for (const feature of CODEX_DISABLED_BUILT_IN_FEATURES) {
    if (availableFeatures.has(feature)) args.push("--disable", feature);
  }
  for (const server of mcpServers) {
    if (server?.enabled !== true) continue;
    const name = String(server?.name || "").trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(
        `Codex MCP server ${name || "(unnamed)"} cannot be disabled safely for an isolated Lumine run.`,
      );
    }
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

async function runCodexInspectionCommand({
  binary,
  args,
  cwd,
  environment,
  signal,
  label,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
      ...(signal ? { signal } : {}),
    });
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `Codex ${label} timed out; Lumine cannot prove tool isolation.`,
        ),
      );
    }, CODEX_PREFLIGHT_TIMEOUT_MS);
    const finish = (error, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > CODEX_PREFLIGHT_OUTPUT_LIMIT) {
        child.kill();
        finish(
          new Error(
            `Codex ${label} was unexpectedly large; Lumine cannot prove tool isolation.`,
          ),
        );
      }
    });
    child.stderr.resume();
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(null, stdout);
      else {
        finish(
          new Error(
            `Codex ${label} failed (${signal || code}); Lumine cannot prove tool isolation.`,
          ),
        );
      }
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toCodexDynamicTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool?.type === "function" && tool?.name)
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.parameters || {
        type: "object",
        additionalProperties: true,
      },
    }));
}

function parseStructuredResult(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("Codex did not return valid loop-review JSON.");
  }
}

function normalizeProviderLaunchError(error, binary, label) {
  if (error?.code === "ENOENT") {
    return new Error(
      `${label} CLI was not found at ${binary}. Install it, sign in with your subscription, or pass --provider-path.`,
    );
  }
  return error;
}
