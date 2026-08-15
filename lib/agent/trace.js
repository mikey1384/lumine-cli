import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function createAgentRunArtifacts({
  dir,
  provider,
  userMessage,
  runtime,
}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(4).toString("hex");
  const runId = `${timestamp}-${suffix}`;
  const runDir = path.join(dir, ".twinkle", "agent-runs", runId);
  const runtimeFile = path.join(runDir, "runtime.json");
  const traceFile = path.join(runDir, "trace.jsonl");
  const feedbackFile = path.join(runDir, "feedback.json");
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeAgentRuntimeFile({
    runtimeFile,
    runtime,
    runId,
    provider,
    userMessage,
  });
  await appendAgentTrace(traceFile, {
    type: "run_started",
    runId,
    provider,
    runtimeVersion: runtime?.version || null,
    phase: runtime?.phase || "implementation",
    at: new Date().toISOString(),
  });
  return { runId, runDir, runtimeFile, traceFile, feedbackFile };
}

export async function writeAgentRuntimeFile({
  runtimeFile,
  runtime,
  runId,
  provider,
  userMessage,
}) {
  await fs.writeFile(
    runtimeFile,
    JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        provider,
        userMessage,
        runtime,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(runtimeFile, 0o600);
}

export async function readAgentRuntimeFile(runtimeFile) {
  const parsed = JSON.parse(await fs.readFile(runtimeFile, "utf8"));
  if (!parsed?.runtime || !parsed?.runId) {
    throw new Error("Invalid Lumine external-agent runtime file.");
  }
  return parsed;
}

export async function appendAgentTrace(traceFile, event) {
  const normalized = {
    ...event,
    at: event?.at || new Date().toISOString(),
  };
  await fs.appendFile(traceFile, `${JSON.stringify(normalized)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readAgentTrace(traceFile) {
  const text = await fs.readFile(traceFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function summarizeAgentTraceForReview(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) =>
      [
        "run_started",
        "provider_completed",
        "tool_call",
        "tool_result",
        "validation_failed",
        "validation_passed",
        "save_completed",
        "run_failed",
      ].includes(event?.type),
    )
    .map((event) => {
      const summary = {
        type: event.type,
        phase: event.phase || null,
        sequence: event.sequence || null,
        tool: event.tool || null,
        durationMs: Number(event.durationMs || 0) || null,
        ok: typeof event.ok === "boolean" ? event.ok : null,
        changedPaths: Array.isArray(event.changedPaths)
          ? event.changedPaths.slice(0, 20)
          : [],
        result: event.result || null,
        reason: event.reason || null,
        error: event.error || null,
      };
      return summary;
    });
}

export async function writeAgentFeedback(feedbackFile, feedback) {
  await fs.writeFile(feedbackFile, `${JSON.stringify(feedback, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(feedbackFile, 0o600);
}
