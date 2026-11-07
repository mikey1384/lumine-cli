import fs from "fs/promises";
import path from "path";

import { runBuildPreviewTool } from "./api.js";
import { ensureAuth } from "./auth.js";
import { resolveSdkBuildId } from "./sdk.js";
import {
  collectProjectFiles,
  findLocalProjectMetadata,
  isReadOnlyReferenceMetadata,
} from "./workspace.js";

// `lumine preview` and `lumine test` run Lumine's own view_preview and
// run_preview_test on Twinkle's capture browser (POST
// /cli/build/:id/preview-tool), so an agent working through the CLI checks a
// build exactly the way Lumine does in a Build run: same sandbox, same step
// format, same results. Read-only, no AI and no Energy. Each call starts at
// the app's opening screen and closes the page when it is done.

export const PREVIEW_TOOL_TIMEOUT_MS = 330_000;
export const PREVIEW_USAGE = `Usage:
  lumine preview [--viewport phone|desktop] [--actions <json|file>] [--focus <text>] [--out <file>] [--saved] [--build <id>] [--json]
  lumine test <test.json> [--viewport phone|desktop] [--name <text>] [--out <file>] [--saved] [--build <id>] [--json]
  lumine test --steps <json|file> [--name <text>] ...
Keep test files under .twinkle/tests/ so lumine save never uploads them.`;

function usageError(message) {
  const error = new Error(`${message}\n${PREVIEW_USAGE}`);
  error.exitCode = 2;
  return error;
}

// A flag value is inline JSON or a path to a JSON file.
export async function readJsonArgument(value, label) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw usageError(`${label} is not valid JSON: ${error.message}`);
    }
  }
  let fileText;
  try {
    fileText = await fs.readFile(path.resolve(text), "utf8");
  } catch (error) {
    throw usageError(`Could not read ${label} file ${text}: ${error.code || error.message}`);
  }
  try {
    return JSON.parse(fileText);
  } catch (error) {
    throw usageError(`${label} file ${text} is not valid JSON: ${error.message}`);
  }
}

function normalizeViewport(value, fallback = "phone") {
  const viewport = String(value || fallback).trim().toLowerCase();
  if (viewport !== "phone" && viewport !== "desktop") {
    throw usageError(`--viewport must be phone or desktop, not "${value}".`);
  }
  return viewport;
}

// What `lumine test` sends: a test file ({ name, viewport, steps }) or a bare
// list of steps, with flags taking precedence.
export async function resolveTestArguments(options) {
  const fromFile = options.positional?.[0]
    ? await readJsonArgument(options.positional[0], "test")
    : undefined;
  const fromFlag = options.previewSteps
    ? await readJsonArgument(options.previewSteps, "--steps")
    : undefined;
  if (fromFile === undefined && fromFlag === undefined) {
    throw usageError("Give a test file or --steps.");
  }
  const spec = Array.isArray(fromFile) ? { steps: fromFile } : fromFile || {};
  const steps = fromFlag !== undefined
    ? Array.isArray(fromFlag) ? fromFlag : fromFlag?.steps
    : spec.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw usageError("A test needs a non-empty steps list.");
  }
  return {
    name: String(options.previewName || spec.name || "test").slice(0, 80),
    viewport: normalizeViewport(options.previewViewport || spec.viewport),
    steps,
  };
}

export async function resolvePreviewArguments(options) {
  const actions = options.previewActions
    ? await readJsonArgument(options.previewActions, "--actions")
    : [];
  const list = Array.isArray(actions) ? actions : actions?.actions;
  if (!Array.isArray(list)) throw usageError("--actions must be a JSON list of steps.");
  return {
    viewport: normalizeViewport(options.previewViewport),
    focus: options.previewFocus ? String(options.previewFocus).slice(0, 160) : null,
    actions: list,
  };
}

// The working files in this workspace (saved or not), or none to preview
// the saved project. A read-only reference checkout is never sent as if it
// were the build's own files.
async function resolvePreviewProjectFiles(options, buildId) {
  if (options.previewSaved) return { projectFiles: null, source: "saved" };
  const localProject = await findLocalProjectMetadata(
    options.dir ? path.resolve(options.dir) : process.cwd(),
  );
  const localBuildId = Number(localProject?.metadata?.buildId || 0);
  if (
    !localProject?.rootDir ||
    localBuildId !== Number(buildId) ||
    isReadOnlyReferenceMetadata(localProject.metadata)
  ) {
    return { projectFiles: null, source: "saved" };
  }
  const files = await collectProjectFiles(localProject.rootDir);
  return {
    projectFiles: files.map((file) => ({ path: file.path, content: file.content })),
    source: "workspace",
    rootDir: localProject.rootDir,
  };
}

function defaultScreenshotPath({ rootDir, kind }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = rootDir
    ? path.join(rootDir, ".twinkle", "previews")
    : process.cwd();
  return path.join(base, `${kind}-${stamp}.jpg`);
}

async function saveScreenshot({ image, out, rootDir, kind }) {
  if (!image?.base64) return null;
  const target = out ? path.resolve(out) : defaultScreenshotPath({ rootDir, kind });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(image.base64, "base64"));
  return target;
}

export function formatTestReport(output) {
  const test = output?.test;
  if (!test) return [output?.error || "The test did not run."];
  const icon = { passed: "PASS", done: "done", failed: "FAIL", could_not_run: "STOP", not_run: "skip" };
  const lines = [`Test "${test.name}": ${String(test.status).toUpperCase()}`];
  for (const step of test.steps || []) {
    lines.push(`  ${String(step.step).padStart(2)}. [${icon[step.result] || step.result}] ${step.does}${step.observed ? ` (saw: ${step.observed})` : ""}${step.reason ? ` (${step.reason})` : ""}`);
  }
  if (test.meaning) lines.push(test.meaning);
  return lines;
}

export function formatPreviewReport(output) {
  if (output?.ok !== true) return [`Preview failed: ${output?.error || "no result"}`];
  const lines = [];
  const interaction = output.interaction;
  if (interaction?.status && interaction.status !== "not_requested") {
    lines.push(`Input: ${interaction.status}${interaction.completed !== undefined ? ` (${interaction.completed}/${interaction.requested} steps)` : ""}`);
  }
  if (output.walk?.steps) lines.push(`Walk: ${output.walk.steps}`);
  const runtime = output.runtime;
  if (runtime?.summary) lines.push(`Runtime: ${runtime.summary}`);
  else if (Array.isArray(runtime?.issues) && runtime.issues.length) {
    lines.push(`Runtime issues: ${runtime.issues.length}`);
  }
  if (output.captureBrowser?.note) lines.push(`Note: ${output.captureBrowser.note}`);
  return lines;
}

async function runPreviewTool(options, { tool, args, kind }) {
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  const files = await resolvePreviewProjectFiles(options, buildId);
  const result = await runBuildPreviewTool({
    options,
    auth,
    buildId,
    tool,
    arguments: args,
    projectFiles: files.projectFiles,
    timeoutMs: Math.max(options.timeoutMs || 0, PREVIEW_TOOL_TIMEOUT_MS),
  });
  const screenshot = await saveScreenshot({
    image: result?.image,
    out: options.out,
    rootDir: files.rootDir,
    kind,
  });
  return { buildId, files, result, screenshot };
}

function printJson({ buildId, files, result, screenshot }) {
  console.log(JSON.stringify({
    buildId,
    files: files.source,
    output: result?.output ?? null,
    screenshot,
    looks: result?.looks ?? null,
    looksLeft: result?.looksLeft ?? null,
  }, null, 2));
}

export async function previewCommand(options) {
  if (options.help) {
    console.log(PREVIEW_USAGE);
    return;
  }
  const args = await resolvePreviewArguments(options);
  const run = await runPreviewTool(options, { tool: "view_preview", args, kind: "preview" });
  if (options.json) printJson(run);
  else {
    console.log(`Build #${run.buildId} preview (${args.viewport}, ${run.files.source === "workspace" ? "this workspace's files" : "saved files"}):`);
    for (const line of formatPreviewReport(run.result?.output)) console.log(line);
    if (run.screenshot) console.log(`Screenshot: ${run.screenshot}`);
    console.log(`Looks left in this 10-minute window: ${run.result?.looksLeft ?? "?"}`);
  }
  if (run.result?.output?.ok !== true) process.exitCode = 1;
}

export async function testCommand(options) {
  if (options.help) {
    console.log(PREVIEW_USAGE);
    return;
  }
  const args = await resolveTestArguments(options);
  const run = await runPreviewTool(options, { tool: "run_preview_test", args, kind: "test-failure" });
  if (options.json) printJson(run);
  else {
    console.log(`Build #${run.buildId} test (${args.viewport}, ${run.files.source === "workspace" ? "this workspace's files" : "saved files"}):`);
    for (const line of formatTestReport(run.result?.output)) console.log(line);
    if (run.screenshot) console.log(`Screenshot at the failed step: ${run.screenshot}`);
    console.log(`Looks left in this 10-minute window: ${run.result?.looksLeft ?? "?"}`);
  }
  if (run.result?.output?.test?.status !== "passed") process.exitCode = 1;
}
