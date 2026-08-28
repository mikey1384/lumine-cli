import { spawn } from "node:child_process";
import readline from "node:readline";

import { createSubscriptionAgentEnvironment } from "./environment.js";

const CLAUDE_RUNTIME_SUFFIX = `

EXTERNAL LUMINE RUNTIME:
- Use only the Lumine MCP tools supplied for this run.
- Do not use built-in filesystem, shell, web, skill, or subagent tools.
- The real project is available only through Lumine tools.
- Never reveal hidden chain-of-thought or private reasoning.`;

export async function runClaudeCodeAgentPass({
  options,
  runtime,
  isolationDir,
  mcp,
}) {
  if (options.authToken) {
    throw new Error(
      "Claude Code external-agent runs require a saved `lumine login`; --auth-token is not forwarded into an MCP child process.",
    );
  }
  const binary =
    options.providerPath || process.env.LUMINE_CLAUDE_PATH || "claude";
  const mcpConfig = {
    mcpServers: {
      lumine: {
        type: "stdio",
        command: process.execPath,
        args: [
          mcp.cliPath,
          "agent-mcp",
          "--dir",
          mcp.dir,
          "--runtime-file",
          mcp.runtimeFile,
          "--trace-file",
          mcp.traceFile,
          "--api-url",
          options.apiUrl,
          "--auth-file",
          options.authFile,
          "--build",
          String(mcp.buildId),
          "--base-files-hash",
          mcp.baseFilesHash,
          "--no-update-check",
        ],
      },
    },
  };
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--allowedTools",
    "mcp__lumine__*",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--system-prompt",
    `${runtime.systemPrompt}${CLAUDE_RUNTIME_SUFFIX}`,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.agentEffort ? ["--effort", options.agentEffort] : []),
    runtime.initialPrompt,
  ];
  const result = await runClaudeProcess({
    binary,
    args,
    cwd: isolationDir,
    streamJson: true,
    signal: options.agentAbortSignal,
  });
  return {
    finalText: result.finalText,
    provenance: result.provenance,
  };
}

export async function reviewClaudeCodeAgentLoop({
  options,
  isolationDir,
  prompt,
  systemPrompt,
  outputSchema,
}) {
  const binary =
    options.providerPath || process.env.LUMINE_CLAUDE_PATH || "claude";
  const result = await runClaudeProcess({
    binary,
    cwd: isolationDir,
    streamJson: false,
    signal: options.agentAbortSignal,
    args: [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--no-chrome",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--allowedTools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--system-prompt",
      systemPrompt,
      "--json-schema",
      JSON.stringify(outputSchema),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.agentEffort ? ["--effort", options.agentEffort] : []),
      prompt,
    ],
  });
  if (result.structuredOutput) return result.structuredOutput;
  try {
    return JSON.parse(result.finalText);
  } catch {
    throw new Error("Claude Code did not return valid loop-review JSON.");
  }
}

async function runClaudeProcess({ binary, args, cwd, streamJson, signal }) {
  const child = spawn(binary, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: createSubscriptionAgentEnvironment(),
    ...(signal ? { signal } : {}),
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  let finalText = "";
  let structuredOutput = null;
  let rawOutput = "";
  let providerModel = null;
  let providerEffort = null;
  let providerUsage = {};
  let providerServiceTier = null;
  let providerRuntimeVersion = null;

  if (streamJson) {
    const lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      terminal: false,
    });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === "assistant") {
        providerModel =
          firstNonEmptyString(event.message?.model, providerModel) || null;
        providerEffort =
          firstNonEmptyString(
            event.message?.effort,
            event.message?.reasoning_effort,
            providerEffort,
          ) || null;
        providerUsage = mergeUsageEvidence(providerUsage, event.message?.usage);
        const texts = (event.message?.content || [])
          .filter((block) => block?.type === "text")
          .map((block) => String(block.text || "").trim())
          .filter(Boolean);
        if (texts.length > 0) finalText = texts.join("\n\n");
      }
      if (event?.type === "system") {
        providerModel = firstNonEmptyString(event.model, providerModel) || null;
        providerRuntimeVersion =
          firstNonEmptyString(
            event.claude_code_version,
            event.claudeCodeVersion,
            event.version,
            providerRuntimeVersion,
          ) || null;
      }
      if (event?.type === "result") {
        providerModel = firstNonEmptyString(event.model, providerModel) || null;
        providerEffort =
          firstNonEmptyString(
            event.effort,
            event.reasoning_effort,
            providerEffort,
          ) || null;
        providerServiceTier =
          firstNonEmptyString(
            event.service_tier,
            event.serviceTier,
            providerServiceTier,
          ) || null;
        providerUsage = mergeUsageEvidence(providerUsage, event.usage);
        providerRuntimeVersion =
          firstNonEmptyString(
            event.claude_code_version,
            event.claudeCodeVersion,
            event.version,
            providerRuntimeVersion,
          ) || null;
        if (typeof event.result === "string" && event.result.trim()) {
          finalText = event.result.trim();
        }
        if (event.structured_output) {
          structuredOutput = event.structured_output;
        }
      }
    });
  } else {
    child.stdout.on("data", (chunk) => {
      rawOutput += chunk.toString("utf8");
    });
  }

  const result = await new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(normalizeProviderLaunchError(error, binary)),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve({ code });
      reject(
        new Error(
          `Claude Code exited before completing the Lumine pass (${signal || code}).`,
        ),
      );
    });
  });
  void result;

  if (!streamJson) {
    let parsed;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      throw new Error("Claude Code returned an invalid JSON result.");
    }
    finalText = String(parsed?.result || "").trim();
    structuredOutput = parsed?.structured_output || null;
    providerModel = firstNonEmptyString(parsed?.model) || null;
    providerEffort =
      firstNonEmptyString(parsed?.effort, parsed?.reasoning_effort) || null;
    providerServiceTier =
      firstNonEmptyString(parsed?.service_tier, parsed?.serviceTier) || null;
    providerRuntimeVersion =
      firstNonEmptyString(
        parsed?.claude_code_version,
        parsed?.claudeCodeVersion,
        parsed?.version,
      ) || null;
    providerUsage = mergeUsageEvidence(providerUsage, parsed?.usage);
  }
  return {
    finalText,
    structuredOutput,
    provenance: {
      resolvedModel: providerModel,
      resolvedEffort: providerEffort,
      resolvedServiceTier: providerServiceTier,
      runtimeVersion: providerRuntimeVersion,
      evidenceTier:
        providerModel || providerEffort || providerServiceTier
          ? "provider_reported"
          : "requested_only",
      usage: providerUsage,
    },
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized.slice(0, 160);
  }
  return null;
}

function mergeUsageEvidence(current, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return current;
  }
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(value)
        .filter(([, amount]) =>
          ["number", "string", "boolean"].includes(typeof amount),
        )
        .slice(0, 30),
    ),
  };
}

function normalizeProviderLaunchError(error, binary) {
  if (error?.code === "ENOENT") {
    return new Error(
      `Claude Code CLI was not found at ${binary}. Install it, sign in with your subscription, or pass --provider-path.`,
    );
  }
  return error;
}
