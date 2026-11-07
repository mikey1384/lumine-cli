import fs from "node:fs/promises";
import path from "node:path";

import { executeExternalAgentTool, runBuildPreviewTool } from "../api.js";
import { PREVIEW_TOOL_TIMEOUT_MS } from "../preview.js";
import {
  collectWorkspaceTextFilesLenient,
  resolveLocalProjectFilePath,
  writeProjectFiles,
} from "../workspace.js";
import { appendAgentTrace } from "./trace.js";

const EXTERNAL_AGENT_MAX_TOOL_CALLS_PER_HOSTED_ROUND = 8;
// Lumine's preview tools run on Twinkle's capture browser through POST
// /cli/build/:id/preview-tool (the same route as lumine preview / lumine
// test), not through /agent/tool. Each call takes one look from the member's
// shared look quota. Twinkle keeps no page between calls, so this session
// keeps the walk the last call recorded and sends it back: "continue"
// replays it before the new input, exactly like a Build run after an edit.
const EXTERNAL_AGENT_PREVIEW_TOOL_NAMES = new Set([
  "view_preview",
  "run_preview_test",
]);

export async function createExternalAgentToolSession({
  options,
  auth,
  buildId,
  baseFilesHash,
  dir,
  runtime,
  traceFile,
  provider,
  initialFiles,
}) {
  const projectFiles = Array.isArray(initialFiles)
    ? normalizeProjectFiles(initialFiles)
    : normalizeProjectFiles(await collectWorkspaceTextFilesLenient(dir));
  return new ExternalAgentToolSession({
    options,
    auth,
    buildId,
    baseFilesHash,
    dir,
    runtime,
    traceFile,
    provider,
    projectFiles,
  });
}

export class ExternalAgentToolSession {
  constructor({
    options,
    auth,
    buildId,
    baseFilesHash,
    dir,
    runtime,
    traceFile,
    provider,
    projectFiles,
  }) {
    this.options = options;
    this.auth = auth;
    this.buildId = buildId;
    this.baseFilesHash = baseFilesHash;
    this.dir = dir;
    this.runtime = runtime;
    this.traceFile = traceFile;
    this.provider = provider;
    this.projectFiles = projectFiles;
    this.readPaths = [];
    this.previewWalk = null;
    this.sequence = 0;
    this.queue = Promise.resolve();
  }

  // The tool output only (text tools and adapters without image support).
  async call(name, toolArguments) {
    return (await this.callTool(name, toolArguments)).output;
  }

  // { output, image }: image is a preview screenshot ({ mimeType, width,
  // height, base64 }) for the adapter to attach to the tool result, or null.
  callTool(name, toolArguments) {
    const pending = this.queue.then(() => this.#call(name, toolArguments));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  offersPreviewTool(toolName) {
    return (
      EXTERNAL_AGENT_PREVIEW_TOOL_NAMES.has(toolName) &&
      (Array.isArray(this.runtime?.tools) ? this.runtime.tools : []).some(
        (tool) => tool?.name === toolName,
      )
    );
  }

  async #callPreview(toolName, toolArguments) {
    try {
      const result = await runBuildPreviewTool({
        options: this.options,
        auth: this.auth,
        buildId: this.buildId,
        tool: toolName,
        arguments: toolArguments,
        projectFiles: this.projectFiles,
        agent: { walk: this.previewWalk },
        timeoutMs: Math.max(
          Number(this.options?.timeoutMs || 0),
          PREVIEW_TOOL_TIMEOUT_MS,
        ),
      });
      if (result && "walk" in result) this.previewWalk = result.walk || null;
      return {
        output: result?.output ?? { ok: false, error: "No preview result." },
        image: result?.image?.base64 ? result.image : null,
      };
    } catch (error) {
      // A refusal (look quota, busy, not the owner) is a tool result the
      // model can act on, not a crash of the pass.
      if (!error?.status) throw error;
      return {
        output: {
          ok: false,
          error: String(error.message || "The preview request failed."),
          ...(error.data?.code ? { code: error.data.code } : {}),
        },
        image: null,
      };
    }
  }

  async #call(name, toolArguments) {
    this.sequence += 1;
    const sequence = this.sequence;
    const maxToolRounds = Math.max(
      1,
      Number(this.runtime?.maxToolRounds || 16),
    );
    // Hosted Lumine limits provider response rounds, and one response may
    // contain several tool calls. App-server/MCP adapters expose calls rather
    // than provider-round boundaries, so keep an equivalent safety ceiling
    // without incorrectly treating every call as a whole hosted round.
    const maxToolCalls =
      maxToolRounds * EXTERNAL_AGENT_MAX_TOOL_CALLS_PER_HOSTED_ROUND;
    if (sequence > maxToolCalls) {
      const output = {
        ok: false,
        error: `Lumine stopped after ${maxToolCalls} tool calls in this pass. Finish with a short summary.`,
      };
      await appendAgentTrace(this.traceFile, {
        type: "tool_result",
        provider: this.provider,
        phase: this.runtime?.phase || null,
        sequence,
        tool: String(name || ""),
        durationMs: 0,
        ok: false,
        result: output.error,
      });
      return { output, image: null };
    }

    const toolName = String(name || "").trim();
    await appendAgentTrace(this.traceFile, {
      type: "tool_call",
      provider: this.provider,
      phase: this.runtime?.phase || null,
      sequence,
      tool: toolName,
      argumentKeys:
        toolArguments && typeof toolArguments === "object"
          ? Object.keys(toolArguments).sort()
          : [],
    });
    const startedAt = Date.now();
    if (this.offersPreviewTool(toolName)) {
      try {
        const { output, image } = await this.#callPreview(
          toolName,
          toolArguments,
        );
        await appendAgentTrace(this.traceFile, {
          type: "tool_result",
          provider: this.provider,
          phase: this.runtime?.phase || null,
          sequence,
          tool: toolName,
          durationMs: Date.now() - startedAt,
          ok: output?.ok !== false && !output?.error,
          changedPaths: [],
          result: summarizeToolResult(output),
        });
        return { output, image };
      } catch (error) {
        await appendAgentTrace(this.traceFile, {
          type: "tool_result",
          provider: this.provider,
          phase: this.runtime?.phase || null,
          sequence,
          tool: toolName,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: String(error?.message || error).slice(0, 500),
        });
        throw error;
      }
    }
    const previousFiles = this.projectFiles;
    try {
      const result = await executeExternalAgentTool({
        options: this.options,
        auth: this.auth,
        buildId: this.buildId,
        baseFilesHash: this.baseFilesHash,
        projectFiles: previousFiles,
        readPaths: this.readPaths,
        name: toolName,
        arguments: toolArguments,
      });
      const nextFiles = normalizeProjectFiles(result.projectFiles);
      const changedPaths = listChangedProjectPaths(previousFiles, nextFiles);
      if (changedPaths.length > 0) {
        await replaceWorkspaceProjectFiles({
          dir: this.dir,
          previousFiles,
          nextFiles,
        });
      }
      this.projectFiles = nextFiles;
      this.readPaths = Array.isArray(result.readPaths)
        ? result.readPaths.map(String)
        : this.readPaths;
      const output = result.output ?? {};
      const ok = output?.ok !== false && !output?.error;
      await appendAgentTrace(this.traceFile, {
        type: "tool_result",
        provider: this.provider,
        phase: this.runtime?.phase || null,
        sequence,
        tool: toolName,
        durationMs: Date.now() - startedAt,
        ok,
        changedPaths,
        result: summarizeToolResult(output),
      });
      return { output, image: null };
    } catch (error) {
      await appendAgentTrace(this.traceFile, {
        type: "tool_result",
        provider: this.provider,
        phase: this.runtime?.phase || null,
        sequence,
        tool: toolName,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: String(error?.message || error).slice(0, 500),
      });
      throw error;
    }
  }
}

export function normalizeProjectFiles(files) {
  const byPath = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = String(file?.path || "").trim();
    if (!filePath || byPath.has(filePath)) continue;
    byPath.set(filePath, String(file?.content || ""));
  }
  return Array.from(byPath, ([filePath, content]) => ({
    path: filePath,
    content,
  })).sort((left, right) => left.path.localeCompare(right.path));
}

export function listChangedProjectPaths(beforeFiles, afterFiles) {
  const before = new Map(
    normalizeProjectFiles(beforeFiles).map((file) => [file.path, file.content]),
  );
  const after = new Map(
    normalizeProjectFiles(afterFiles).map((file) => [file.path, file.content]),
  );
  return Array.from(new Set([...before.keys(), ...after.keys()]))
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort();
}

export async function replaceWorkspaceProjectFiles({
  dir,
  previousFiles,
  nextFiles,
}) {
  const rootDir = path.resolve(dir);
  const nextPaths = new Set(nextFiles.map((file) => file.path));
  const deletedPaths = previousFiles
    .map((file) => file.path)
    .filter((filePath) => !nextPaths.has(filePath))
    .sort((left, right) => right.length - left.length);

  for (const projectPath of new Set([
    ...deletedPaths,
    ...nextFiles.map((file) => file.path),
  ])) {
    await assertProjectPathDoesNotTraverseSymlink({ rootDir, projectPath });
  }

  for (const projectPath of deletedPaths) {
    const filePath = resolveLocalProjectFilePath({ rootDir, projectPath });
    await fs.unlink(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await removeEmptyProjectParents({ rootDir, filePath: path.dirname(filePath) });
  }

  for (const file of nextFiles) {
    const filePath = resolveLocalProjectFilePath({
      rootDir,
      projectPath: file.path,
    });
    const stat = await fs.lstat(filePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isDirectory()) {
      await fs.rmdir(filePath);
    }
  }
  await writeProjectFiles({ dir: rootDir, files: nextFiles });
}

async function assertProjectPathDoesNotTraverseSymlink({
  rootDir,
  projectPath,
}) {
  let current = resolveLocalProjectFilePath({ rootDir, projectPath });
  while (current !== rootDir && current.startsWith(`${rootDir}${path.sep}`)) {
    const stat = await fs.lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `Refusing to write ${projectPath}: its local path traverses a symbolic link.`,
      );
    }
    current = path.dirname(current);
  }
}

async function removeEmptyProjectParents({ rootDir, filePath }) {
  let current = path.resolve(filePath);
  const metadataRoot = path.join(rootDir, ".twinkle");
  while (
    current !== rootDir &&
    current.startsWith(`${rootDir}${path.sep}`) &&
    current !== metadataRoot
  ) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return;
      throw error;
    }
    current = path.dirname(current);
  }
}

function summarizeToolResult(output) {
  if (!output || typeof output !== "object") {
    return String(output || "").slice(0, 500);
  }
  if (output.error) return String(output.error).slice(0, 500);
  if (typeof output.message === "string") return output.message.slice(0, 500);
  const summary = {};
  for (const key of [
    "ok",
    "path",
    "prefix",
    "matchingPathCount",
    "pathsIncluded",
    "pathsOmitted",
    "matchCount",
    "filesRead",
    "capturesLeft",
  ]) {
    if (output[key] !== undefined) summary[key] = output[key];
  }
  // Preview results: what happened, never the screenshot or page text.
  if (typeof output.test?.status === "string") summary.test = output.test.status;
  if (typeof output.interaction?.status === "string") {
    summary.interaction = output.interaction.status;
  }
  if (typeof output.replay?.status === "string") summary.replay = output.replay.status;
  return Object.keys(summary).length > 0 ? summary : "completed";
}
