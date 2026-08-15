import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadBuildMetadata,
  loadExternalAgentRuntime,
  validateExternalAgentCandidate,
} from "./api.js";
import { assertAuthScope, resolveAuth } from "./auth.js";
import {
  assertLocalProjectCanBeSaved,
  assertProjectFilesWithinLimits,
  collectProjectFilesFromDir,
  findLocalProjectMetadata,
  isIndexHtmlPath,
} from "./workspace.js";
import { resolveExternalAgentProvider } from "./agent/providers/index.js";
import {
  createExternalAgentToolSession,
  replaceWorkspaceProjectFiles,
} from "./agent/tool-session.js";
import {
  appendAgentTrace,
  createAgentRunArtifacts,
  readAgentTrace,
  summarizeAgentTraceForReview,
  writeAgentFeedback,
  writeAgentRuntimeFile,
} from "./agent/trace.js";

const CLI_PATH = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));
const MAX_AGENT_REQUEST_LENGTH = 20_000;
const LOOP_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "observations"],
  properties: {
    summary: { type: "string", maxLength: 500 },
    observations: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "severity", "evidence", "improvement"],
        properties: {
          area: {
            type: "string",
            enum: [
              "prompt",
              "tool_contract",
              "validation",
              "adapter",
              "workflow",
            ],
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
          },
          evidence: { type: "string", maxLength: 800 },
          improvement: { type: "string", maxLength: 800 },
        },
      },
    },
  },
};

export async function agentCommand(options, { saveWorkspace }) {
  const userMessage = String(options.agentPrompt || "").trim();
  if (!userMessage) {
    throw new Error(
      'Pass the Build request, for example: lumine agent --provider codex "Add keyboard controls".',
    );
  }
  if (userMessage.length > MAX_AGENT_REQUEST_LENGTH) {
    throw new Error(
      `The Build request must be at most ${MAX_AGENT_REQUEST_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }
  const provider = resolveExternalAgentProvider(options.provider);
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:read" });
  await assertAuthScope({ options, auth, scope: "build:write" });
  const workspace = await loadExternalAgentWorkspace({ options, auth });
  const runtimeResult = await loadExternalAgentRuntime({
    options,
    auth,
    buildId: workspace.buildId,
    userMessage,
    projectFiles: workspace.files,
    baseFilesHash: workspace.baseFilesHash,
  });
  if (runtimeResult.runtime?.billing?.usesTwinkleAiEnergy !== false) {
    throw new Error(
      "Twinkle did not return the zero-energy external-agent runtime contract.",
    );
  }

  const artifacts = await createAgentRunArtifacts({
    dir: workspace.dir,
    provider: provider.id,
    userMessage,
    runtime: runtimeResult.runtime,
  });
  const isolationDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-agent-isolation-"),
  );
  let runtime = runtimeResult.runtime;
  let currentFiles = workspace.files;
  let scopeBaseFiles = workspace.files;
  let finalText = "";
  let scopeRepairAttempts = 0;
  let validationRepairAttempts = 0;

  console.log(
    `Running ${provider.label} through Lumine's workspace loop (Twinkle AI Energy: 0).`,
  );
  console.log(`Build: ${workspace.build.title || workspace.buildId}`);

  try {
    // Each failed validation pass receives the same canonical repair prompt and
    // a fresh tool read-set, matching the hosted Lumine repair boundary.
    for (;;) {
      await writeAgentRuntimeFile({
        runtimeFile: artifacts.runtimeFile,
        runtime,
        runId: artifacts.runId,
        provider: provider.id,
        userMessage,
      });
      const toolSession =
        provider.id === "codex"
          ? await createExternalAgentToolSession({
              options,
              auth,
              buildId: workspace.buildId,
              baseFilesHash: workspace.baseFilesHash,
              dir: workspace.dir,
              runtime,
              traceFile: artifacts.traceFile,
              provider: provider.id,
              initialFiles: currentFiles,
            })
          : null;
      const providerResult = await provider.runPass({
        options,
        runtime,
        toolSession,
        isolationDir,
        mcp: {
          cliPath: CLI_PATH,
          dir: workspace.dir,
          runtimeFile: artifacts.runtimeFile,
          traceFile: artifacts.traceFile,
          buildId: workspace.buildId,
          baseFilesHash: workspace.baseFilesHash,
        },
      });
      finalText = String(providerResult?.finalText || "").trim() || finalText;
      await appendAgentTrace(artifacts.traceFile, {
        type: "provider_completed",
        provider: provider.id,
        phase: runtime.phase,
        ok: true,
      });

      const candidateFiles = await collectAgentProjectFiles(workspace.dir);
      const validation = await validateExternalAgentCandidate({
        options,
        auth,
        buildId: workspace.buildId,
        baseFilesHash: workspace.baseFilesHash,
        userMessage,
        phase: runtime.phase,
        validationBaseFiles: workspace.files,
        scopeBaseFiles,
        candidateFiles,
      });
      if (validation.ok) {
        // Validation returns the canonical normalized snapshot. Make the
        // workspace converge on that response before the ordinary guarded save
        // collects files from disk.
        await replaceWorkspaceWithSnapshot({
          dir: workspace.dir,
          currentFiles: candidateFiles,
          snapshotFiles: validation.projectFiles,
        });
        currentFiles = validation.projectFiles;
        await appendAgentTrace(artifacts.traceFile, {
          type: "validation_passed",
          provider: provider.id,
          phase: runtime.phase,
          ok: true,
        });
        break;
      }

      await appendAgentTrace(artifacts.traceFile, {
        type: "validation_failed",
        provider: provider.id,
        phase: runtime.phase,
        ok: false,
        result: validation.kind,
        reason: String(validation.reason || "").slice(0, 1000),
      });
      console.error(`Lumine validation: ${validation.reason}`);

      if (validation.kind === "scope") {
        if (runtime.phase === "validation_repair") {
          // A validation-repair pass is intentionally allowed only a tiny
          // corrective diff. If it exceeds that scope, retire its local file
          // mutations before returning the failure; otherwise a rejected
          // candidate could remain in the workspace and be saved manually
          // after Lumine explicitly refused it.
          await replaceWorkspaceWithSnapshot({
            dir: workspace.dir,
            currentFiles: candidateFiles,
            snapshotFiles: scopeBaseFiles,
          });
          currentFiles = scopeBaseFiles;
          throw new Error(
            `The validation repair exceeded Lumine's repair scope: ${validation.reason}`,
          );
        }
        if (scopeRepairAttempts >= 1) {
          await replaceWorkspaceWithSnapshot({
            dir: workspace.dir,
            currentFiles: candidateFiles,
            snapshotFiles: scopeBaseFiles,
          });
          throw new Error(
            `The external agent still exceeded Lumine's run scope after repair. The oversized pass was not saved.`,
          );
        }
        scopeRepairAttempts += 1;
        await replaceWorkspaceWithSnapshot({
          dir: workspace.dir,
          currentFiles: candidateFiles,
          snapshotFiles: scopeBaseFiles,
        });
        currentFiles = scopeBaseFiles;
      } else {
        if (validationRepairAttempts >= 2) {
          throw new Error(
            "The external agent could not pass Lumine validation after two repair attempts. Its local candidate remains unsaved for inspection.",
          );
        }
        validationRepairAttempts += 1;
        scopeBaseFiles = candidateFiles;
        currentFiles = candidateFiles;
      }
      runtime = validation.runtime;
    }

    const changedPaths = listChangedPaths(workspace.files, currentFiles);
    if (changedPaths.length > 0) {
      await saveWorkspace({
        ...options,
        dir: workspace.dir,
        publish: false,
        externalAgentProvider: provider.id,
        summary:
          options.summary ||
          `External ${provider.label} agent: ${userMessage.slice(0, 160)}`,
      });
      await appendAgentTrace(artifacts.traceFile, {
        type: "save_completed",
        provider: provider.id,
        phase: runtime.phase,
        ok: true,
        changedPaths,
      });
    } else {
      console.log("No project files changed; nothing was saved.");
    }

    console.log("");
    console.log(finalText || "The Lumine pass completed.");
    let feedback = null;
    if (options.reviewLoop) {
      feedback = await reviewLoopSafely({
        options,
        provider,
        isolationDir,
        artifacts,
      });
    }
    console.log(`\nLoop trace: ${artifacts.traceFile}`);
    await appendAgentTrace(artifacts.traceFile, {
      type: "run_completed",
      provider: provider.id,
      phase: runtime.phase,
      ok: true,
      changedPaths,
      feedbackObservationCount: feedback?.observations?.length || 0,
    });
    return {
      provider: provider.id,
      buildId: workspace.buildId,
      changedPaths,
      finalText,
      traceFile: artifacts.traceFile,
      feedbackFile: feedback ? artifacts.feedbackFile : null,
    };
  } catch (error) {
    await appendAgentTrace(artifacts.traceFile, {
      type: "run_failed",
      provider: provider.id,
      phase: runtime?.phase || null,
      ok: false,
      error: String(error?.message || error).slice(0, 1000),
    }).catch(() => undefined);
    error.message = `${error.message}\nLoop trace: ${artifacts.traceFile}`;
    throw error;
  } finally {
    await fs.rm(isolationDir, { recursive: true, force: true });
  }
}

async function loadExternalAgentWorkspace({ options, auth }) {
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  assertLocalProjectCanBeSaved(localProject);
  const buildId =
    Number(localProject?.metadata?.buildId || 0) ||
    Number(localProject?.metadata?.build?.id || 0);
  if (!buildId || !localProject?.rootDir) {
    throw new Error(
      "Run `lumine pull` first, then start the external agent from that pulled workspace.",
    );
  }
  const baseFilesHash = String(localProject.metadata?.filesHash || "").trim();
  if (!baseFilesHash) {
    throw new Error(
      "This workspace has no server filesHash. Run `lumine pull` before starting the external agent.",
    );
  }
  const build = await loadBuildMetadata({ options, auth, buildId });
  if (build?.canWrite === false) {
    throw new Error(
      "This checkout is read-only. Pull your contribution branch or an owned Build before starting the external agent.",
    );
  }
  const files = await collectAgentProjectFiles(localProject.rootDir);
  if (!files.some((file) => isIndexHtmlPath(file.path))) {
    throw new Error("Project files must include /index.html or /index.htm.");
  }
  assertProjectFilesWithinLimits(files, build?.projectLimits);
  return {
    localProject,
    buildId,
    build,
    dir: localProject.rootDir,
    baseFilesHash,
    files,
  };
}

async function collectAgentProjectFiles(dir) {
  const root = path.resolve(dir);
  const files = [];
  await collectProjectFilesFromDir({ root, dir: root, files });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function replaceWorkspaceWithSnapshot({
  dir,
  currentFiles,
  snapshotFiles,
}) {
  await replaceWorkspaceProjectFiles({
    dir,
    previousFiles: currentFiles,
    nextFiles: snapshotFiles,
  });
}

function listChangedPaths(beforeFiles, afterFiles) {
  const before = new Map(beforeFiles.map((file) => [file.path, file.content]));
  const after = new Map(afterFiles.map((file) => [file.path, file.content]));
  return Array.from(new Set([...before.keys(), ...after.keys()]))
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort();
}

async function reviewLoopSafely({
  options,
  provider,
  isolationDir,
  artifacts,
}) {
  try {
    const events = await readAgentTrace(artifacts.traceFile);
    const traceSummary = summarizeAgentTraceForReview(events);
    const feedback = await provider.reviewLoop({
      options,
      isolationDir,
      systemPrompt:
        "You are reviewing the observable trace of a Lumine tool loop powered by this same local provider. Identify only evidence-backed runtime friction. Do not infer hidden reasoning, critique the app implementation, or suggest generic features. If the loop was clean, return an empty observations array.",
      prompt: `Review this sanitized Lumine runtime trace and return structured feedback.\n\n${JSON.stringify(traceSummary)}`,
      outputSchema: LOOP_REVIEW_OUTPUT_SCHEMA,
    });
    const normalizedFeedback = normalizeLoopFeedback(feedback);
    await writeAgentFeedback(artifacts.feedbackFile, normalizedFeedback);
    console.log("\nLumine loop review:");
    console.log(normalizedFeedback.summary || "No runtime friction observed.");
    for (const observation of normalizedFeedback.observations) {
      console.log(
        `- [${observation.severity}] ${observation.improvement} (evidence: ${observation.evidence})`,
      );
    }
    console.log(`Feedback: ${artifacts.feedbackFile}`);
    return normalizedFeedback;
  } catch (error) {
    console.error(
      `Lumine loop review skipped: ${String(error?.message || error)}`,
    );
    return null;
  }
}

function normalizeLoopFeedback(value) {
  const allowedAreas = new Set([
    "prompt",
    "tool_contract",
    "validation",
    "adapter",
    "workflow",
  ]);
  const allowedSeverities = new Set(["low", "medium", "high"]);
  return {
    summary: String(value?.summary || "").trim().slice(0, 500),
    observations: (Array.isArray(value?.observations) ? value.observations : [])
      .slice(0, 6)
      .map((observation) => ({
        area: allowedAreas.has(observation?.area)
          ? observation.area
          : "workflow",
        severity: allowedSeverities.has(observation?.severity)
          ? observation.severity
          : "low",
        evidence: String(observation?.evidence || "").trim().slice(0, 800),
        improvement: String(observation?.improvement || "")
          .trim()
          .slice(0, 800),
      }))
      .filter((observation) => observation.evidence && observation.improvement),
  };
}
