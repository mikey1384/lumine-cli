#!/usr/bin/env node
import fs from "fs/promises";
import os from "os";
import path from "path";
import readline from "readline/promises";
import { spawn } from "child_process";
import { stdin as input, stdout as output } from "process";

const DEFAULT_API_URL = "https://api.twinkle.network";
const DEFAULT_SITE_URL = "https://www.twin-kle.com";
const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_AUTH_FILE = path.join(
  os.homedir(),
  ".twinkle",
  "lumine-cli-auth.json",
);
const DEFAULT_TIMEOUT_MS = 20000;
const UPDATE_CHECK_TIMEOUT_MS = 1500;
const DEFAULT_PROJECT_LIMIT = 50;
const PROJECT_METADATA_DIR = ".twinkle";
const PROJECT_METADATA_FILE = "lumine-project.json";
const DEFAULT_SAVE_SUMMARY = "Saved from Lumine CLI.";
const EXCLUDED_UPLOAD_DIRS = new Set([".git", ".twinkle", "node_modules"]);
const SDK_REFERENCE_FILE = "TWINKLE_BUILD_SDK.md";
const EXCLUDED_UPLOAD_FILES = new Set([
  ".DS_Store",
  "AGENTS.md",
  "CLAUDE.md",
  SDK_REFERENCE_FILE,
]);
const LUMINE_AGENT_INSTRUCTIONS_MARKER =
  "<!-- Lumine CLI Agent Instructions -->";
const LUMINE_SDK_REFERENCE_MARKER = "<!-- Lumine CLI SDK Reference -->";
const LUMINE_REFERENCE_INSTRUCTIONS_MARKER =
  "<!-- Lumine CLI Reference Instructions -->";
const BUNDLED_SDK_REFERENCE_URL = new URL(
  "../sdk/BUILD_SDK_INDEX.md",
  import.meta.url,
);
const PACKAGE_METADATA_URL = new URL("../package.json", import.meta.url);
const SDK_REFERENCE_FALLBACK = `${LUMINE_SDK_REFERENCE_MARKER}
# Twinkle Build SDK Reference

The bundled SDK reference could not be loaded from this Lumine CLI package.

Use these current source-of-truth rules:

- Read .twinkle/lumine-project.json before editing.
- Use Twinkle.capabilities.get() or Twinkle.capabilities.can(actionName) before relying on gated SDK calls.
- Use Twinkle.privateDb for simple private per-user preferences, drafts, settings, and small JSON state.
- Use Twinkle.userDb only for advanced private SQLite tables, indexes, many rows, filtered queries, or aggregates.
- Use Twinkle.sharedDb for shared multi-user JSON data.
- Use Twinkle.aiCards.list/search/get for existing public AI Card words, exampleText sentence material, and word levels.
- Use Twinkle.aiStories.list/search/get for existing AI Story passage text, story media, and questions.
- Use Twinkle.ai.chat with history entries shaped as { role, content }, not { text }.
- Use Twinkle.preview for canvas, WebGL, Three.js, fullscreen, and game layout.
- Prefer existing documented Twinkle.* methods over guessing names from old code.
`;
const LUMINE_AGENT_INSTRUCTIONS = `${LUMINE_AGENT_INSTRUCTIONS_MARKER}
# Lumine Project Agent Guide

This directory contains Twinkle Build project files pulled by Lumine CLI. Use
Lumine CLI as the source of truth for saving this workspace back to Twinkle.

## Source Of Truth

- Read .twinkle/lumine-project.json before changing files.
- Treat build.canWrite, build.canPublish, and build.contributionRootBuildId as authoritative.
- If lumineCli.updateAvailable is true, ask the user to rerun with npx @stage5/lumine@latest before saving.
- Read ${SDK_REFERENCE_FILE} before adding, removing, or changing any Twinkle.* SDK calls.
- If build.canWrite is false, do not save changes.
- If build.canPublish is false or contributionRootBuildId is set, this checkout is a contribution branch. Save only to this branch and do not run lumine launch or lumine save --publish.
- Do not edit another local checkout to bypass branch rules.

## Workflow

- Edit only project files in this workspace.
- Keep /index.html or /index.htm as the entry file.
- Run lumine save from this folder after edits, with a short summary:

\`\`\`bash
lumine save --summary "Describe the change"
\`\`\`

- Run lumine check before launch when possible.
- Owned canonical builds may be published only when the user explicitly asks.

## App Constraints

- Use local project files with relative or root-local imports only. Do not add package imports, CDN scripts, external network calls, or app-local /api/* routes.
- Build apps run in sandboxed iframes without allow-forms. Do not use <form> elements, native form submission, requestSubmit(), or browser form navigation. Build input flows with JavaScript-handled inputs and buttons instead.
- For canvas, WebGL, Three.js, fullscreen, or game builds, use Twinkle.preview for layout. Do not size roots from 100vh, 100vw, 100dvh, 100dvw, window.innerWidth, window.innerHeight, visualViewport, or document viewport dimensions.
- For Three.js, use import * as THREE from '/build/vendor/three/0.160.0/three.module.min.js';.
- Do not invent or guess Twinkle.* SDK method names. Use ${SDK_REFERENCE_FILE} as the local SDK reference and prefer Twinkle.capabilities checks for gated features.

## Completion Report

Report the changed files, any SDK methods used, the lumine save result, the
build or branch id, and whether the result is published or unpublished changes.
`;
const LUMINE_REFERENCE_INSTRUCTIONS = `${LUMINE_REFERENCE_INSTRUCTIONS_MARKER}
# Lumine Reference Guide

This directory contains read-only reference files pulled from a public
open-source Twinkle Build. Use it for inspection and borrowing patterns, not as
the workspace to save.

## Source Of Truth

- Read .twinkle/lumine-project.json before using these files.
- If lumineCli.updateAvailable is true, ask the user to rerun with npx @stage5/lumine@latest before borrowing patterns.
- If metadata.readOnly is true or build.role is "reference", do not run lumine save from this directory.
- To start from this Build, run lumine fork with the source build id and edit the forked workspace.
- Do not edit another local checkout to bypass reference read-only semantics.
`;
const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const COMMANDS = new Set([
  "workspace",
  "login",
  "logout",
  "whoami",
  "new",
  "projects",
  "explore",
  "select",
  "pull",
  "reference",
  "fork",
  "diff",
  "merge",
  "replace-main",
  "save",
  "push",
  "check",
  "launch",
  "help",
]);

main().catch((error) => {
  console.error(`lumine: ${error?.message || error}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.lumineCli = await loadLumineCliVersionInfo({ options });
  if (options.help) {
    printHelp();
    return;
  }
  if (options.updateCheck) {
    await maybeCheckForLumineCliUpdate({ options });
  }

  if (options.command === "workspace") {
    await workspace(options);
    return;
  }
  if (options.command === "login") {
    await login(options);
    return;
  }
  if (options.command === "logout") {
    await logout(options);
    return;
  }
  if (options.command === "whoami") {
    await whoami(options);
    return;
  }
  if (options.command === "new") {
    await newBuild(options);
    return;
  }
  if (options.command === "projects") {
    await projects(options);
    return;
  }
  if (options.command === "explore") {
    await explore(options);
    return;
  }
  if (options.command === "select") {
    await selectProject(options);
    return;
  }
  if (options.command === "pull") {
    await pull(options);
    return;
  }
  if (options.command === "reference") {
    await reference(options);
    return;
  }
  if (options.command === "fork") {
    await fork(options);
    return;
  }
  if (options.command === "diff") {
    await diff(options);
    return;
  }
  if (options.command === "merge") {
    await mergeBranch(options);
    return;
  }
  if (options.command === "replace-main") {
    await replaceMainWithBranch(options);
    return;
  }
  if (options.command === "save" || options.command === "push") {
    await save(options);
    return;
  }
  if (options.command === "check") {
    await check(options);
    return;
  }
  if (options.command === "launch") {
    await launch(options);
    return;
  }

  printHelp();
}

async function login(options) {
  const start = await requestJson({
    method: "POST",
    url: `${options.apiUrl}/cli/device/start`,
    body: {
      clientName: options.clientName,
      scopes: ["build:read", "build:write", "build:check", "build:publish"],
    },
    timeoutMs: options.timeoutMs,
  });

  const approvalUrl = start.verificationUriComplete || start.verificationUri;
  console.log("Connect Lumine CLI to Twinkle.");
  if (options.openBrowser && approvalUrl) {
    console.log("Opening Twinkle in your browser...");
    const opened = await openBrowser(approvalUrl);
    if (!opened) console.log("Could not open the browser automatically.");
  }
  console.log(`Approval link: ${approvalUrl}`);
  console.log(`Code: ${start.userCode}`);
  console.log("Leave this terminal open. Waiting for approval...");

  const intervalMs = Math.max(Number(start.interval || 3), 1) * 1000;
  const startedAt = Date.now();
  const expiresInMs = Math.max(Number(start.expiresIn || 600), 1) * 1000;

  while (Date.now() - startedAt < expiresInMs) {
    await sleep(intervalMs);
    const tokenResponse = await pollToken({
      options,
      deviceCode: start.deviceCode,
    });
    if (!tokenResponse) continue;

    await writeAuth({
      options,
      token: tokenResponse.accessToken,
      username: tokenResponse.user?.username || "",
      userId: tokenResponse.user?.id || null,
      expiresAt: Date.now() + Number(tokenResponse.expiresIn || 0) * 1000,
    });
    console.log(
      `Logged in${tokenResponse.user?.username ? ` as ${tokenResponse.user.username}` : ""}.`,
    );
    console.log("You can now run `lumine` to choose a project.");
    return;
  }

  throw new Error("Login code expired. Run `lumine login` again.");
}

async function pollToken({ options, deviceCode }) {
  try {
    return await requestJson({
      method: "POST",
      url: `${options.apiUrl}/cli/device/token`,
      body: { deviceCode },
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error.status === 428 || error.data?.error === "authorization_pending") {
      return null;
    }
    throw error;
  }
}

async function logout(options) {
  let removed = false;
  try {
    await fs.unlink(options.authFile);
    removed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(
    removed
      ? `Removed Lumine CLI login at ${options.authFile}`
      : `No Lumine CLI login found at ${options.authFile}`,
  );
}

async function whoami(options) {
  const auth = await resolveAuth(options);
  const session = await requestJson({
    url: `${options.apiUrl}/cli/session`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  console.log(
    `Logged in as ${session.username || auth.username || "unknown"} ` +
      `(userId=${session.userId || auth.userId || "unknown"})`,
  );
}

async function newBuild(options) {
  const title = await resolveNewBuildTitle(options);
  const description = await resolveNewBuildDescription(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const createResult = await createBuild({
    options,
    auth,
    title,
    description,
  });
  const buildId = Number(createResult.build?.id || 0);
  if (!buildId) {
    throw new Error("Twinkle did not return a created Build.");
  }
  const result = await pullBuildFiles({ options, auth, buildId });
  await saveSelectedBuild({ options, auth, build: result.build });
  printNewBuildResult({ createResult, pullResult: result });
}

async function workspace(options) {
  const auth = await ensureAuth(options);
  const selectedBuild = options.target
    ? await loadTargetBuildMetadata({ options, auth })
    : await chooseProject({
        builds: await listBuilds({ options, auth }),
      });
  const build = await resolveEditableWorkspaceBuild({
    options,
    auth,
    build: selectedBuild,
  });

  await saveSelectedBuild({ options, auth, build });
  const result = await pullBuildFiles({ options, auth, buildId: build.id });
  await saveSelectedBuild({ options, auth, build: result.build || build });
  printPullResult(result);
}

async function projects(options) {
  const auth = await resolveAuth(options);
  const builds = await listBuilds({ options, auth });
  printBuildList(builds);
}

async function explore(options) {
  const auth = await resolveAuth(options);
  const builds = await listOpenSourceBuilds({ options, auth });
  printOpenSourceBuildList(builds, options);
}

async function selectProject(options) {
  const auth = await resolveAuth(options);
  const selectedBuild = options.target
    ? await loadTargetBuildMetadata({ options, auth })
    : await chooseProject({
        builds: await listBuilds({ options, auth }),
      });
  const build = await resolveEditableWorkspaceBuild({
    options,
    auth,
    build: selectedBuild,
  });
  await saveSelectedBuild({ options, auth, build });
  console.log(
    `Selected ${formatBuildTitle(build)}. Run \`lumine pull\` to get the files.`,
  );
}

async function pull(options) {
  const auth = await resolveAuth(options);
  const requestedBuildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const selectedBuild = await loadBuildMetadata({
    options,
    auth,
    buildId: requestedBuildId,
  });
  const build = await resolveEditableWorkspaceBuild({
    options,
    auth,
    build: selectedBuild,
  });
  const result = await pullBuildFiles({ options, auth, buildId: build.id });
  await saveSelectedBuild({ options, auth, build: result.build });
  printPullResult(result);
}

async function reference(options) {
  const auth = await resolveAuth(options);
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const result = await pullReferenceFiles({ options, auth, buildId });
  printReferenceResult(result);
}

async function fork(options) {
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const forkResult = await forkBuild({ options, auth, buildId });
  const forkedBuildId = Number(forkResult.build?.id || 0);
  if (!forkedBuildId) {
    throw new Error("Twinkle did not return a forked Build.");
  }
  const result = await pullBuildFiles({
    options,
    auth,
    buildId: forkedBuildId,
  });
  await saveSelectedBuild({ options, auth, build: result.build });
  printForkResult({ forkResult, pullResult: result });
}

async function diff(options) {
  const auth = await resolveAuth(options);
  const build = await loadTargetBuildMetadata({ options, auth });
  const { rootBuildId, contributionBuildId } =
    resolveContributionActionBuildIds(build);
  const result = await loadContributionDiff({
    options,
    auth,
    rootBuildId,
    contributionBuildId,
  });
  printContributionDiff({ result, build });
}

async function mergeBranch(options) {
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const build = await loadTargetBuildMetadata({ options, auth });
  const { rootBuildId, contributionBuildId } =
    resolveContributionActionBuildIds(build);
  const result = await mergeContributionIntoMain({
    options,
    auth,
    rootBuildId,
    contributionBuildId,
  });
  printContributionActionResult({
    action: "Merged",
    result,
    rootBuildId,
    contributionBuildId,
  });
}

async function replaceMainWithBranch(options) {
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const build = await loadTargetBuildMetadata({ options, auth });
  const { rootBuildId, contributionBuildId } =
    resolveContributionActionBuildIds(build);
  const result = await replaceMainWithContribution({
    options,
    auth,
    rootBuildId,
    contributionBuildId,
  });
  printContributionActionResult({
    action: "Replaced main with",
    result,
    rootBuildId,
    contributionBuildId,
  });
}

async function save(options) {
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  assertLocalProjectCanBeSaved(localProject);
  let buildId = await resolveRequiredBuildIdOrSelected(options, auth, {
    localProject,
  });
  let build = await resolveBuildForSave({
    options,
    auth,
    buildId,
    localProject,
  });
  if (build?.canWrite === false) {
    throw new Error(
      "This checkout is read-only for the current CLI login. Pull or diff it for review, then merge or replace main from the project owner workflow.",
    );
  }
  buildId = Number(build?.id || buildId);
  const dir = resolveProjectDirForSave({ options, localProject });
  const files = await collectProjectFiles(dir);
  const result = await saveProjectFiles({
    options,
    auth,
    buildId,
    files,
    summary: options.summary || DEFAULT_SAVE_SUMMARY,
  });
  build = result.build ||
    build ||
    (await loadBuildMetadata({ options, auth, buildId }).catch(() => null)) || {
      id: buildId,
      title: `Build ${buildId}`,
    };
  await saveSelectedBuild({ options, auth, build });
  await writeProjectMetadata({
    dir,
    options,
    build,
    manifest: result.projectManifest || null,
    lastSavedAt: new Date().toISOString(),
  });
  printSaveResult({ result, build, dir, files });

  if (options.publish) {
    if (build?.canPublish === false) {
      console.log(
        "Saved to your branch. The project owner can merge or replace main from Twinkle.",
      );
      return;
    }
    const publish = await publishBuild({ options, buildId, auth });
    if (publish.skipped) {
      console.log("Publish skipped: already up to date.");
    } else {
      console.log("Publish complete.");
    }
    console.log(`App: ${options.siteUrl}/app/${buildId}`);
  }
}

async function check(options) {
  const auth = await resolveAuth(options);
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const result = await requestJson({
    url: `${options.apiUrl}/cli/build/${buildId}/launch-check`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  printCheck(result);
  if (!result.ok) process.exitCode = 1;
}

async function launch(options) {
  const auth = await resolveAuth(options);
  if (options.saveFirst) {
    await save({
      ...options,
      publish: false,
      saveFirst: false,
    });
  }
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const checkResult = await requestJson({
    url: `${options.apiUrl}/cli/build/${buildId}/launch-check`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  printCheck(checkResult);
  const launchOk =
    typeof checkResult.launchOk === "boolean"
      ? checkResult.launchOk
      : checkResult.ok;
  if (!checkResult.ok || !launchOk) {
    process.exitCode = 1;
    return;
  }

  const publish = await publishBuild({ options, buildId, auth });
  const build = publish.build || checkResult.build || {};
  const appUrl = `${options.siteUrl}/app/${buildId}`;
  const versionId =
    Number(build.publishedArtifactVersionId || 0) ||
    Number(build.releaseStatus?.publishedArtifactVersionId || 0) ||
    0;

  const appProbe = await probeUrl({
    url: appUrl,
    timeoutMs: options.timeoutMs,
  });
  const previewProbe = versionId
    ? await probeUrl({
        url: `${options.apiUrl}/build/preview/build/${buildId}/version/${versionId}`,
        authToken: auth.token,
        timeoutMs: options.timeoutMs,
      })
    : null;

  if (publish.skipped) {
    console.log("Publish skipped: already up to date.");
  } else {
    console.log("Publish complete.");
  }
  console.log(`App: ${appUrl}`);
  console.log(
    `Prod shell: ${appProbe.ok ? "ok" : "fail"} ${appProbe.status} bytes=${appProbe.bytes}`,
  );
  if (previewProbe) {
    console.log(
      `Published preview: ${previewProbe.ok ? "ok" : "fail"} ` +
        `${previewProbe.status} bytes=${previewProbe.bytes}`,
    );
  }

  if (!appProbe.ok || (previewProbe && !previewProbe.ok) || !versionId) {
    process.exitCode = 1;
  }
}

async function publishBuild({ options, buildId, auth }) {
  if (auth.releaseStatus?.state === "up_to_date") {
    return { skipped: true };
  }
  try {
    const result = await requestJson({
      method: "POST",
      url: `${options.apiUrl}/build/${buildId}/publish`,
      authToken: auth.token,
      body: {},
      timeoutMs: options.timeoutMs,
    });
    return { skipped: false, build: result.build || null };
  } catch (error) {
    if (
      error.status === 409 &&
      error.data?.code === "build_release_up_to_date"
    ) {
      return {
        skipped: true,
        build: { releaseStatus: error.data.releaseStatus || null },
      };
    }
    throw error;
  }
}

function printCheck(result) {
  const checks = result.checks || {};
  console.log(`Launch check: ${result.ok ? "ok" : "fail"}`);
  if (checks.canonicalBuild) {
    console.log(
      `- canonical build: ${checks.canonicalBuild.ok ? "ok" : "fail"}`,
    );
  }
  console.log(
    `- project files: ${checks.projectFiles?.ok ? "ok" : "fail"} ` +
      `files=${checks.projectFiles?.fileCount ?? 0}`,
  );
  console.log(`- toolchain: ${checks.toolchain?.ok ? "ok" : "fail"}`);
  if (checks.publishPermission) {
    console.log(
      `- publish permission: ${checks.publishPermission.ok ? "ok" : "fail"}`,
    );
    if (checks.publishPermission.reason) {
      console.log(`  ${checks.publishPermission.reason}`);
    }
  }
  if (typeof result.launchOk === "boolean") {
    console.log(`- launch gate: ${result.launchOk ? "ok" : "fail"}`);
  }
  console.log(
    `- conflict markers: ${checks.conflictMarkers?.ok ? "ok" : "fail"}`,
  );
  for (const diagnostic of checks.toolchain?.diagnostics || []) {
    console.log(
      `  ${diagnostic.kind} ${diagnostic.filePath}` +
        `${diagnostic.line ? `:${diagnostic.line}` : ""} ${diagnostic.message}`,
    );
  }
  for (const conflictPath of checks.conflictMarkers?.paths || []) {
    console.log(`  conflict marker: ${conflictPath}`);
  }
}

async function ensureAuth(options) {
  try {
    return await resolveAuth(options);
  } catch (error) {
    if (options.authToken || !isMissingLoginError(error)) throw error;
  }
  await login(options);
  return await resolveAuth(options);
}

async function listBuilds({ options, auth }) {
  const url = new URL(`${options.apiUrl}/cli/builds`);
  url.searchParams.set("limit", String(options.limit));
  const result = await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  return Array.isArray(result.builds) ? result.builds : [];
}

async function listOpenSourceBuilds({ options, auth }) {
  const url = new URL(`${options.apiUrl}/cli/open-source-builds`);
  url.searchParams.set("limit", String(options.limit));
  url.searchParams.set("sort", options.sort);
  if (options.searchQuery) {
    url.searchParams.set("search", options.searchQuery);
  }
  const result = await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  return Array.isArray(result.builds) ? result.builds : [];
}

async function loadBuildMetadata({ options, auth, buildId }) {
  const result = await loadBuildFiles({
    options,
    auth,
    buildId,
    includeContent: false,
  });
  if (!result.build) {
    throw new Error(`Build ${buildId} could not be loaded.`);
  }
  return result.build;
}

async function loadTargetBuildMetadata({ options, auth }) {
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  return await loadBuildMetadata({ options, auth, buildId });
}

async function loadOpenSourceBuildFiles({
  options,
  auth,
  buildId,
  includeContent,
}) {
  const url = new URL(`${options.apiUrl}/cli/build/${buildId}/open-source-files`);
  if (!includeContent) url.searchParams.set("includeContent", "0");
  return await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

async function loadBuildFiles({ options, auth, buildId, includeContent }) {
  const url = new URL(`${options.apiUrl}/cli/build/${buildId}/files`);
  if (!includeContent) url.searchParams.set("includeContent", "0");
  return await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

async function resolveBranchBuild({
  options,
  auth,
  rootBuildId,
  branchNumber,
}) {
  const result = await requestJson({
    url: `${options.apiUrl}/cli/build/${rootBuildId}/branches/${branchNumber}`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  const branchBuildId = Number(result.build?.id || 0);
  if (!branchBuildId) {
    throw new Error(`Branch ${branchNumber} for Build ${rootBuildId} could not be loaded.`);
  }
  return result.build;
}

async function forkBuild({ options, auth, buildId }) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/fork`,
    authToken: auth.token,
    body: {},
    timeoutMs: options.timeoutMs,
  });
}

async function createBuild({ options, auth, title, description }) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/create`,
    authToken: auth.token,
    body: {
      title,
      ...(description ? { description } : {}),
    },
    timeoutMs: options.timeoutMs,
  });
}

async function saveProjectFiles({ options, auth, buildId, files, summary }) {
  return await requestJson({
    method: "PUT",
    url: `${options.apiUrl}/build/${buildId}/project-files`,
    authToken: auth.token,
    body: {
      files,
      createVersion: true,
      summary,
    },
    timeoutMs: options.timeoutMs,
  });
}

async function loadContributionDiff({
  options,
  auth,
  rootBuildId,
  contributionBuildId,
}) {
  return await requestJson({
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

async function mergeContributionIntoMain({
  options,
  auth,
  rootBuildId,
  contributionBuildId,
}) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/merge`,
    authToken: auth.token,
    body: {},
    timeoutMs: options.timeoutMs,
  });
}

async function replaceMainWithContribution({
  options,
  auth,
  rootBuildId,
  contributionBuildId,
}) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/replace-main`,
    authToken: auth.token,
    body: {},
    timeoutMs: options.timeoutMs,
  });
}

async function resolveBuildForSave({ options, auth, buildId, localProject }) {
  const localBuild = localProject?.metadata?.build;
  const localBuildId =
    Number(localBuild?.id || 0) ||
    Number(localProject?.metadata?.buildId || 0);
  const build =
    localBuild && localBuildId === Number(buildId)
      ? { ...localBuild, id: buildId }
      : await loadBuildMetadata({ options, auth, buildId });
  return await resolveEditableWorkspaceBuild({
    options,
    auth,
    build,
    skipWriteScopeCheck: true,
  });
}

async function resolveEditableWorkspaceBuild({
  options,
  auth,
  build,
  skipWriteScopeCheck = false,
}) {
  if (!shouldUseContributionBranch(build)) return build;

  if (!skipWriteScopeCheck) {
    await assertAuthScope({ options, auth, scope: "build:write" });
  }
  const branch = await ensureDefaultContributionBranch({
    options,
    auth,
    build,
  });
  console.log(
    `Using your branch ${formatBuildTitle(branch)} for team project ${formatBuildTitle(build)}.`,
  );
  return branch;
}

function shouldUseContributionBranch(build) {
  return (
    build?.role === "collaborator" &&
    build.canWrite !== true &&
    !isContributionBranch(build)
  );
}

async function ensureDefaultContributionBranch({ options, auth, build }) {
  const rootBuildId =
    Number(build?.contributionRootBuildId || 0) || Number(build?.id || 0);
  if (!rootBuildId) {
    throw new Error("Could not resolve the team project for this branch.");
  }

  const result = await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/default-branch`,
    authToken: auth.token,
    body: {},
    timeoutMs: options.timeoutMs,
  });
  const branchId = Number(result.build?.id || 0);
  if (!branchId) {
    throw new Error("Twinkle did not return a contribution branch.");
  }

  return await loadBuildMetadata({
    options,
    auth,
    buildId: branchId,
  }).catch(() =>
    normalizeContributionBranchBuild({
      branch: result.build,
      sourceBuild: build,
    }),
  );
}

function normalizeContributionBranchBuild({ branch, sourceBuild }) {
  const branchId = Number(branch?.id || 0);
  return {
    ...branch,
    id: branchId,
    title: branch?.title || `Branch ${branchId}`,
    role: "owner",
    ownerUsername:
      branch?.ownerUsername ||
      branch?.username ||
      sourceBuild?.ownerUsername ||
      null,
    canWrite: true,
    canPublish: false,
    contributionStatus: branch?.contributionStatus || "draft",
    contributionRootBuildId:
      Number(branch?.contributionRootBuildId || sourceBuild?.id || 0) || null,
    contributionContributorId:
      Number(branch?.contributionContributorId || branch?.userId || 0) || null,
    contributionBranchNumber:
      Number(branch?.contributionBranchNumber || 0) || null,
  };
}

async function assertAuthScope({ options, auth, scope }) {
  const session = await requestJson({
    url: `${options.apiUrl}/cli/session`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  const scopes = Array.isArray(session.scopes) ? session.scopes : [];
  if (!scopes.includes(scope)) {
    throw new Error(
      `Saved login is missing ${scope}. Run \`lumine login\` again to approve file saves.`,
    );
  }
}

async function chooseProject({ builds }) {
  if (!builds.length) {
    throw new Error("No owned or team Twinkle builds were found.");
  }
  if (builds.length === 1) {
    console.log(`Selected ${formatBuildTitle(builds[0])}.`);
    return builds[0];
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      "Choose a project by running `lumine select <twinkle-build-url>`.",
    );
  }

  printBuildList(builds);
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question("Choose a project number: ");
      const index = Number(answer.trim());
      if (Number.isInteger(index) && index >= 1 && index <= builds.length) {
        return builds[index - 1];
      }
      console.log(`Enter a number from 1 to ${builds.length}.`);
    }
  } finally {
    rl.close();
  }
}

async function pullBuildFiles({ options, auth, buildId }) {
  const result = await loadBuildFiles({
    options,
    auth,
    buildId,
    includeContent: true,
  });
  const build = result.build || { id: buildId, title: `Build ${buildId}` };
  const files = Array.isArray(result.projectFiles) ? result.projectFiles : [];
  const dir = path.resolve(options.dir || defaultWorkspaceDir(build));
  await writeProjectFiles({ dir, files });
  await writeAgentInstructions({ dir });
  await writeSdkReference({ dir });
  await writeProjectMetadata({
    dir,
    options,
    build,
    manifest: result.projectManifest || null,
    pulledAt: new Date().toISOString(),
  });
  return {
    build,
    dir,
    fileCount: files.length,
    manifest: result.projectManifest || null,
  };
}

async function pullReferenceFiles({ options, auth, buildId }) {
  const result = await loadOpenSourceBuildFiles({
    options,
    auth,
    buildId,
    includeContent: true,
  });
  const build = result.build || { id: buildId, title: `Build ${buildId}` };
  const files = Array.isArray(result.projectFiles) ? result.projectFiles : [];
  const dir = path.resolve(options.dir || defaultReferenceDir(build));
  await writeProjectFiles({ dir, files });
  await writeReferenceInstructions({ dir });
  await writeSdkReference({ dir });
  await writeReferenceMetadata({
    dir,
    options,
    build,
    manifest: result.projectManifest || null,
    reference: result.reference || {
      readOnly: true,
      forkable: true,
      sourceBuildId: Number(build.id || buildId),
    },
    pulledAt: new Date().toISOString(),
  });
  return {
    build,
    dir,
    fileCount: files.length,
    manifest: result.projectManifest || null,
    reference: result.reference || null,
  };
}

async function writeAgentInstructions({ dir }) {
  for (const fileName of AGENT_INSTRUCTION_FILES) {
    const filePath = path.join(dir, fileName);
    try {
      const existing = await fs.readFile(filePath, "utf8");
      if (!existing.includes(LUMINE_AGENT_INSTRUCTIONS_MARKER)) {
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(filePath, LUMINE_AGENT_INSTRUCTIONS, "utf8");
  }
}

async function writeReferenceInstructions({ dir }) {
  for (const fileName of AGENT_INSTRUCTION_FILES) {
    const filePath = path.join(dir, fileName);
    try {
      const existing = await fs.readFile(filePath, "utf8");
      if (!existing.includes(LUMINE_REFERENCE_INSTRUCTIONS_MARKER)) {
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(filePath, LUMINE_REFERENCE_INSTRUCTIONS, "utf8");
  }
}

async function writeSdkReference({ dir }) {
  const filePath = path.join(dir, SDK_REFERENCE_FILE);
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (!existing.includes(LUMINE_SDK_REFERENCE_MARKER)) {
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.writeFile(filePath, await loadSdkReference(), "utf8");
}

async function loadSdkReference() {
  try {
    const rawReference = await fs.readFile(BUNDLED_SDK_REFERENCE_URL, "utf8");
    const reference = rawReference.trim();
    if (reference) return `${LUMINE_SDK_REFERENCE_MARKER}\n${reference}\n`;
  } catch {
    // Fall through to the compact reference so pulled workspaces still guide agents.
  }
  return SDK_REFERENCE_FALLBACK;
}

async function collectProjectFiles(dir) {
  const root = path.resolve(dir);
  const files = [];
  await collectProjectFilesFromDir({ root, dir: root, files });
  if (!files.some((file) => isIndexHtmlPath(file.path))) {
    throw new Error("Project files must include /index.html or /index.htm.");
  }
  assertProjectFilesAvoidNativeFormSubmission(files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectProjectFilesFromDir({ root, dir, files }) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Project directory does not exist: ${dir}`);
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_UPLOAD_DIRS.has(entry.name)) continue;
    if (entry.isFile() && EXCLUDED_UPLOAD_FILES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectProjectFilesFromDir({ root, dir: fullPath, files });
      continue;
    }
    if (!entry.isFile()) continue;
    const buffer = await fs.readFile(fullPath);
    if (buffer.includes(0)) {
      const relativePath = localFilePathToProjectPath({
        root,
        filePath: fullPath,
      });
      throw new Error(
        `Cannot save binary file ${relativePath}. Twinkle project files must be text files.`,
      );
    }
    files.push({
      path: localFilePathToProjectPath({ root, filePath: fullPath }),
      content: buffer.toString("utf8"),
    });
  }
}

function localFilePathToProjectPath({ root, filePath }) {
  const relative = path.relative(root, filePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe local project file path: ${filePath}`);
  }
  return `/${relative}`;
}

function isIndexHtmlPath(projectPath) {
  const normalized = String(projectPath || "")
    .trim()
    .toLowerCase();
  return normalized === "/index.html" || normalized === "/index.htm";
}

function isNativeFormMarkupProjectPath(projectPath) {
  return /\.(?:html?|jsx?|tsx?|mjs|cjs)$/i.test(
    String(projectPath || "").trim(),
  );
}

function getLineColumnForSourceIndex(content, sourceIndex) {
  const before = String(content || "").slice(0, Math.max(0, sourceIndex));
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function formatProjectFileLocation({ filePath, line, column }) {
  return `${filePath}:${line}:${column}`;
}

function assertProjectFilesAvoidNativeFormSubmission(files) {
  for (const file of files) {
    const content = String(file.content || "");
    if (isNativeFormMarkupProjectPath(file.path)) {
      const formMatch = content.match(/<form\b[^>]*>/i);
      if (formMatch) {
        const { line, column } = getLineColumnForSourceIndex(
          content,
          formMatch.index || 0,
        );
        throw new Error(
          `Cannot save native form markup at ${formatProjectFileLocation({
            filePath: file.path,
            line,
            column,
          })}. Twinkle Build apps run in sandboxed iframes without form-submit permission. Replace <form> with JavaScript-handled inputs and buttons.`,
        );
      }
    }

    const requestSubmitMatch = content.match(/\brequestSubmit\s*\(/);
    if (requestSubmitMatch) {
      const { line, column } = getLineColumnForSourceIndex(
        content,
        requestSubmitMatch.index || 0,
      );
      throw new Error(
        `Cannot save native form submission at ${formatProjectFileLocation({
          filePath: file.path,
          line,
          column,
        })}. requestSubmit() is blocked by the Build iframe sandbox; use a JavaScript click handler instead.`,
      );
    }
  }
}

async function writeProjectFiles({ dir, files }) {
  await fs.mkdir(dir, { recursive: true });
  for (const file of files) {
    const filePath = resolveLocalProjectFilePath({
      rootDir: dir,
      projectPath: file.path,
    });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, String(file.content || ""), "utf8");
  }
}

async function writeProjectMetadata({
  dir,
  options,
  build,
  manifest,
  pulledAt,
  lastSavedAt,
}) {
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  await fs.writeFile(
    path.join(metadataDir, PROJECT_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        buildId: Number(build?.id || 0) || null,
        build: build
          ? {
              id: Number(build.id || 0) || null,
              title: build.title || "",
              role: build.role || "",
              ownerUsername: build.ownerUsername || null,
              contributionStatus: build.contributionStatus || "none",
              contributionRootBuildId:
                Number(build.contributionRootBuildId || 0) || null,
              contributionContributorId:
                Number(build.contributionContributorId || 0) || null,
              contributionBranchNumber:
                Number(build.contributionBranchNumber || 0) || null,
              canWrite:
                build.canWrite !== undefined
                  ? Boolean(build.canWrite)
                  : build.role === "owner",
              canPublish:
                build.canPublish !== undefined
                  ? Boolean(build.canPublish)
                  : build.role === "owner",
            }
          : null,
        apiUrl: options.apiUrl,
        siteUrl: options.siteUrl,
        lumineCli: serializeLumineCliMetadata(options),
        manifest,
        pulledAt,
        lastSavedAt,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeReferenceMetadata({
  dir,
  options,
  build,
  manifest,
  reference,
  pulledAt,
}) {
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  const sourceBuildId =
    Number(reference?.sourceBuildId || 0) || Number(build?.id || 0) || null;
  await fs.writeFile(
    path.join(metadataDir, PROJECT_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        buildId: sourceBuildId,
        readOnly: true,
        reference: {
          readOnly: true,
          forkable: true,
          sourceBuildId,
          sourceAppUrl: sourceBuildId ? `${options.siteUrl}/app/${sourceBuildId}` : null,
        },
        build: {
          id: sourceBuildId,
          title: build?.title || (sourceBuildId ? `Build ${sourceBuildId}` : ""),
          role: "reference",
          ownerUsername: build?.ownerUsername || null,
          collaborationMode: build?.collaborationMode || "open_source",
          canWrite: false,
          canPublish: false,
        },
        apiUrl: options.apiUrl,
        siteUrl: options.siteUrl,
        lumineCli: serializeLumineCliMetadata(options),
        manifest,
        pulledAt,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function findLocalProjectMetadata(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    const metadataPath = path.join(
      current,
      PROJECT_METADATA_DIR,
      PROJECT_METADATA_FILE,
    );
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      return { rootDir: current, metadata, metadataPath };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveProjectDirForSave({ options, localProject }) {
  if (options.dir) return path.resolve(options.dir);
  if (localProject?.rootDir) return localProject.rootDir;
  return process.cwd();
}

function assertLocalProjectCanBeSaved(localProject) {
  const metadata = localProject?.metadata;
  if (!metadata) return;
  if (isReadOnlyReferenceMetadata(metadata)) {
    const sourceBuildId =
      Number(metadata.reference?.sourceBuildId || 0) ||
      Number(metadata.buildId || 0) ||
      Number(metadata.build?.id || 0) ||
      0;
    throw new Error(
      `This is a read-only Lumine reference${sourceBuildId ? ` for Build ${sourceBuildId}` : ""}. Run \`lumine fork${sourceBuildId ? ` ${sourceBuildId}` : ""}\` to create an editable workspace.`,
    );
  }
  if (metadata.build?.canWrite === false) {
    throw new Error(
      "This Lumine checkout is read-only for the current CLI login. Pull or diff it for review; project-owner branch edits must go through merge or replace-main.",
    );
  }
}

function isReadOnlyReferenceMetadata(metadata) {
  return (
    metadata?.readOnly === true ||
    metadata?.reference?.readOnly === true ||
    metadata?.build?.role === "reference"
  );
}

function resolveLocalProjectFilePath({ rootDir, projectPath }) {
  const relativePath = projectPathToRelativePath(projectPath);
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && filePath.startsWith(`${root}${path.sep}`)) {
    return filePath;
  }
  throw new Error(`Unsafe project file path: ${projectPath}`);
}

function projectPathToRelativePath(projectPath) {
  const segments = String(projectPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe project file path: ${projectPath}`);
  }
  return path.join(...segments);
}

async function saveSelectedBuild({ options, auth, build }) {
  if (options.authToken || !build?.id) return;
  await writeAuthFile(options, {
    ...auth,
    selectedBuildId: Number(build.id),
    selectedBuildTitle: build.title || `Build ${build.id}`,
    selectedBuildRole: build.role || "",
    selectedAt: new Date().toISOString(),
  });
}

function serializeLumineCliMetadata(options) {
  const info = options.lumineCli || {};
  return {
    packageName: info.packageName || "@stage5/lumine",
    version: info.version || null,
    latestVersion: info.latestVersion || null,
    updateAvailable: Boolean(info.updateAvailable),
    updateCommand: info.updateCommand || "npx @stage5/lumine@latest",
    checkedAt: info.checkedAt || null,
    checkFailed: Boolean(info.checkFailed),
    checkSkipped: Boolean(info.checkSkipped),
  };
}

function printBuildList(builds) {
  if (!builds.length) {
    console.log("No owned or team Twinkle builds found.");
    return;
  }
  console.log("Twinkle builds:");
  builds.forEach((build, index) => {
    console.log(`${index + 1}. ${formatBuildListItem(build)}`);
  });
}

function printOpenSourceBuildList(builds, options) {
  if (!builds.length) {
    const searchText = options.searchQuery
      ? ` matching "${options.searchQuery}"`
      : "";
    console.log(`No public open-source Twinkle builds found${searchText}.`);
    return;
  }
  const searchText = options.searchQuery ? ` for "${options.searchQuery}"` : "";
  console.log(`Public open-source Twinkle builds${searchText}:`);
  builds.forEach((build, index) => {
    console.log(`${index + 1}. ${formatOpenSourceBuildListItem(build)}`);
  });
  console.log("Reference: lumine reference <build-id>");
  console.log("Fork: lumine fork <build-id>");
}

function formatBuildListItem(build) {
  const role =
    build.role === "owner"
      ? "owned by you"
      : `team project${build.ownerUsername ? ` with ${build.ownerUsername}` : ""}`;
  const published = build.isPublic ? "public" : "private";
  return `${formatBuildTitle(build)} - ${role}, ${published}`;
}

function formatOpenSourceBuildListItem(build) {
  const owner = build.ownerUsername ? ` by ${build.ownerUsername}` : "";
  const stats = [
    `${Math.max(0, Number(build.forkCount || 0))} forks`,
    `${Math.max(0, Number(build.viewCount || 0))} views`,
  ].join(", ");
  const appUrl = build.appUrl ? ` - ${build.appUrl}` : "";
  return `${formatBuildTitle(build)}${owner} - ${stats}${appUrl}`;
}

function formatBuildTitle(build) {
  return `${build.title || `Build ${build.id}`} (#${build.id})`;
}

function isContributionBranch(build) {
  return (
    String(build?.contributionStatus || "none") !== "none" ||
    Number(build?.contributionRootBuildId || 0) > 0 ||
    Number(build?.contributionBranchNumber || 0) > 0
  );
}

function resolveContributionActionBuildIds(build) {
  const contributionBuildId = Number(build?.id || 0);
  const rootBuildId = Number(build?.contributionRootBuildId || 0);
  if (!contributionBuildId || !rootBuildId || !isContributionBranch(build)) {
    throw new Error(
      "Pass a branch URL such as https://www.twin-kle.com/build/884/4, or run this from a pulled branch workspace.",
    );
  }
  return { rootBuildId, contributionBuildId };
}

function printPullResult(result) {
  const build = result.build || {};
  const entryPath = result.manifest?.entryPath || "unknown";
  console.log(`Selected ${formatBuildTitle(build)}.`);
  console.log(
    `Pulled ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${result.dir}`,
  );
  console.log(`Entry: ${entryPath}`);
  console.log(`SDK reference: ${SDK_REFERENCE_FILE}`);
  console.log(`Next: cd ${shellQuote(result.dir)}`);
  if (build.canWrite === false) {
    console.log("This checkout is read-only for the current CLI login.");
    if (isContributionBranch(build)) {
      console.log("Review changes: lumine diff");
      if (build.role === "project_owner") {
        console.log("Owner actions: lumine merge, or lumine replace-main");
      }
    }
    return;
  }
  if (result.fileCount === 0) {
    console.log("No project files yet. Create /index.html before your first save.");
  }
  console.log('Codex: codex "Read AGENTS.md, then make the requested change."');
  console.log(
    'Claude Code: claude "Read CLAUDE.md, then make the requested change."',
  );
  console.log('Save after edits: lumine save --summary "Describe the change"');
  if (isContributionBranch(build) && build.canPublish === false) {
    console.log("The project owner can merge or replace main from Twinkle.");
  } else {
    console.log("Run `lumine check` or `lumine launch --save` when ready.");
  }
}

function printNewBuildResult({ createResult, pullResult }) {
  const build = pullResult.build || createResult.build || {};
  console.log(`Created ${formatBuildTitle(build)}.`);
  printPullResult(pullResult);
}

function printReferenceResult(result) {
  const build = result.build || {};
  const sourceBuildId =
    Number(result.reference?.sourceBuildId || 0) || Number(build.id || 0);
  const entryPath = result.manifest?.entryPath || "unknown";
  console.log(`Referenced ${formatBuildTitle(build)}.`);
  console.log(
    `Pulled ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${result.dir}`,
  );
  console.log(`Entry: ${entryPath}`);
  console.log("Mode: read-only reference");
  console.log(`Next: cd ${shellQuote(result.dir)}`);
  if (sourceBuildId) {
    console.log(`Start from this app: lumine fork ${sourceBuildId}`);
  }
}

function printForkResult({ forkResult, pullResult }) {
  const build = pullResult.build || forkResult.build || {};
  const sourceBuildId =
    Number(forkResult.sourceBuild?.id || 0) ||
    Number(forkResult.sourceBuild?.contentId || 0) ||
    0;
  console.log(
    forkResult.alreadyExists
      ? `Using your existing fork ${formatBuildTitle(build)}.`
      : `Forked Build ${sourceBuildId || "source"} into ${formatBuildTitle(
          build,
        )}.`,
  );
  printPullResult(pullResult);
}

function printSaveResult({ result, build, dir, files }) {
  const entryPath = result.projectManifest?.entryPath || "unknown";
  const version = result.artifactVersion?.versionNumber
    ? ` v${result.artifactVersion.versionNumber}`
    : "";
  const releaseState = result.releaseStatus?.state || "unknown";
  console.log(`Saved ${formatBuildTitle(build)}${version}.`);
  console.log(
    `Uploaded ${files.length} file${files.length === 1 ? "" : "s"} from ${dir}`,
  );
  console.log(`Entry: ${entryPath}`);
  console.log(`Release status: ${releaseState}`);
  if (isContributionBranch(build) && build.canPublish === false) {
    console.log(
      "Next: the project owner can merge or replace main from Twinkle.",
    );
  } else {
    console.log(
      "Next: run `lumine launch` to publish, or `lumine save --publish` next time.",
    );
  }
}

function printContributionDiff({ result, build }) {
  const summary = result.diff?.summary || {};
  const files = Array.isArray(result.diff?.changedFiles)
    ? result.diff.changedFiles
    : [];
  const branchNumber = Number(build.contributionBranchNumber || 0) || 0;
  const branchLabel = branchNumber ? `branch ${branchNumber}` : `branch #${build.id}`;
  console.log(`Diff for ${branchLabel}:`);
  console.log(
    `- total=${summary.total ?? files.length} added=${summary.added ?? 0} ` +
      `updated=${summary.updated ?? 0} deleted=${summary.deleted ?? 0}`,
  );
  if (result.rootDrifted) {
    console.log("- main changed after this branch was created");
  }
  if (!files.length) {
    console.log("No file changes.");
    return;
  }
  for (const file of files) {
    const mergeStatus = file.mergeStatus ? ` (${file.mergeStatus})` : "";
    console.log(`- ${file.status || "changed"} ${file.path}${mergeStatus}`);
  }
}

function printContributionActionResult({
  action,
  result,
  rootBuildId,
  contributionBuildId,
}) {
  if (!result?.success) {
    console.log(result?.error || "Branch action did not complete.");
    process.exitCode = 1;
    return;
  }
  const projectFiles = Array.isArray(result.projectFiles)
    ? result.projectFiles
    : [];
  console.log(`${action} branch #${contributionBuildId} for Build #${rootBuildId}.`);
  if (projectFiles.length > 0) {
    console.log(
      `Main now has ${projectFiles.length} project file${projectFiles.length === 1 ? "" : "s"}.`,
    );
  }
  if (result.mergeConflictsWritten || result.conflicts?.length > 0) {
    console.log("Merge wrote conflict markers. Resolve them in the Build workspace.");
  }
  console.log(`Main workspace: ${rootBuildId}`);
}

async function resolveAuth(options) {
  if (options.authToken) {
    return { token: options.authToken };
  }
  try {
    const text = await fs.readFile(options.authFile, "utf8");
    const auth = JSON.parse(text);
    if (auth.apiUrl && trimTrailingSlash(auth.apiUrl) !== options.apiUrl) {
      throw new Error(
        `Saved login is for ${auth.apiUrl}. Run ` +
          `lumine login --api-url ${options.apiUrl}.`,
      );
    }
    if (auth.token) return auth;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new Error("Run `lumine login` before launching a Twinkle build.");
}

async function writeAuth({ options, token, username, userId, expiresAt }) {
  let existingAuth = {};
  try {
    existingAuth = JSON.parse(await fs.readFile(options.authFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeAuthFile(options, {
    ...existingAuth,
    token,
    username,
    userId,
    expiresAt,
    apiUrl: options.apiUrl,
    createdAt: new Date().toISOString(),
  });
}

async function writeAuthFile(options, auth) {
  await fs.mkdir(path.dirname(options.authFile), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(options.authFile, JSON.stringify(auth, null, 2), {
    mode: 0o600,
  });
  await fs.chmod(options.authFile, 0o600);
}

async function requestJson({
  method = "GET",
  url,
  authToken,
  body,
  timeoutMs,
}) {
  const response = await request({
    method,
    url,
    authToken,
    body,
    timeoutMs,
  });
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const error = new Error(
      data?.error || data?.message || `${method} ${url} failed`,
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data || {};
}

async function probeUrl({ url, authToken, timeoutMs }) {
  const response = await request({ url, authToken, timeoutMs });
  const text = await response.text();
  return {
    ok: response.ok && text.trim().length > 0,
    status: response.status,
    bytes: Buffer.byteLength(text),
  };
}

async function request({ method = "GET", url, authToken, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: {
        ...(authToken ? { authorization: authorizationHeader(authToken) } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLumineCliVersionInfo({ options }) {
  const packageMetadata = await loadLocalPackageMetadata();
  const packageName = packageMetadata.name || "@stage5/lumine";
  const version = packageMetadata.version || null;
  return {
    packageName,
    version,
    latestVersion: null,
    updateAvailable: false,
    updateCommand: `npx ${packageName}@latest`,
    checkedAt: null,
    checkFailed: false,
    checkSkipped: !options.updateCheck,
  };
}

async function loadLocalPackageMetadata() {
  try {
    const rawPackage = await fs.readFile(PACKAGE_METADATA_URL, "utf8");
    const parsedPackage = JSON.parse(rawPackage);
    return {
      name: String(parsedPackage?.name || "").trim(),
      version: String(parsedPackage?.version || "").trim(),
    };
  } catch {
    return {
      name: "@stage5/lumine",
      version: null,
    };
  }
}

async function maybeCheckForLumineCliUpdate({ options }) {
  const info = options.lumineCli || (await loadLumineCliVersionInfo({ options }));
  const checkedAt = new Date().toISOString();
  if (!info.packageName || !info.version) {
    options.lumineCli = {
      ...info,
      checkedAt,
      checkFailed: true,
      checkSkipped: false,
    };
    return;
  }

  try {
    const latestVersion = await loadLatestPackageVersion({
      packageName: info.packageName,
      registryUrl: options.npmRegistryUrl,
    });
    const updateAvailable = isNewerVersion(latestVersion, info.version);
    options.lumineCli = {
      ...info,
      latestVersion,
      updateAvailable,
      checkedAt,
      checkFailed: false,
      checkSkipped: false,
    };
    if (updateAvailable) {
      printLumineCliUpdateWarning(options.lumineCli);
    }
  } catch {
    options.lumineCli = {
      ...info,
      checkedAt,
      checkFailed: true,
      checkSkipped: false,
    };
  }
}

async function loadLatestPackageVersion({ packageName, registryUrl }) {
  const encodedPackageName = encodeURIComponent(packageName);
  const result = await requestJson({
    url: `${registryUrl}/${encodedPackageName}/latest`,
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
  });
  const latestVersion = String(result?.version || "").trim();
  if (!latestVersion) {
    throw new Error("No latest package version returned");
  }
  return latestVersion;
}

function isNewerVersion(latestVersion, currentVersion) {
  const latestParts = parseSemverParts(latestVersion);
  const currentParts = parseSemverParts(currentVersion);
  if (!latestParts || !currentParts) return false;
  for (let index = 0; index < 3; index += 1) {
    if (latestParts[index] > currentParts[index]) return true;
    if (latestParts[index] < currentParts[index]) return false;
  }
  return false;
}

function parseSemverParts(value) {
  const match = String(value || "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function printLumineCliUpdateWarning(info) {
  console.error(
    `lumine: update available for ${info.packageName}: ${info.version} -> ${info.latestVersion}.`,
  );
  console.error(`lumine: run \`${info.updateCommand}\` to use the latest CLI.`);
}

function parseArgs(args) {
  const firstArg = args[0] || "";
  const firstArgIsCommand =
    firstArg && !firstArg.startsWith("--") && COMMANDS.has(firstArg);
  const firstArgLooksLikeTarget =
    firstArg && !firstArg.startsWith("--") && resolveBuildId(firstArg) > 0;
  const command = firstArgIsCommand
    ? firstArg
    : !firstArg || firstArg.startsWith("--") || firstArgLooksLikeTarget
      ? "workspace"
      : "help";
  const rest = command === "workspace" ? args : args.slice(1);
  const raw = {};
  const positional = [];
  const booleanFlags = new Set([
    "noOpen",
    "open",
    "noDescription",
    "publish",
    "save",
    "noUpdateCheck",
  ]);

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") {
      raw.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const camelKey = toCamelCase(key);
    if (inlineValue !== undefined) {
      raw[camelKey] = inlineValue;
    } else if (booleanFlags.has(camelKey)) {
      raw[camelKey] = true;
    } else {
      raw[camelKey] = rest[i + 1] ?? "";
      i += 1;
    }
  }

  return {
    command,
    target: raw.url || raw.target || positional[0] || "",
    title:
      String(
        raw.title ||
          (command === "new" ? positional.join(" ") : ""),
      ).trim() || "",
    description:
      Object.prototype.hasOwnProperty.call(raw, "description")
        ? String(raw.description || "").trim()
        : null,
    descriptionProvided: Object.prototype.hasOwnProperty.call(
      raw,
      "description",
    ),
    noDescription: parseBoolean(raw.noDescription, false),
    searchQuery:
      String(
        raw.search ||
          raw.query ||
          (command === "explore" ? positional.join(" ") : ""),
      ).trim() || "",
    sort: normalizeOpenSourceSort(raw.sort),
    apiUrl: trimTrailingSlash(
      String(raw.apiUrl || process.env.TWINKLE_API_URL || DEFAULT_API_URL),
    ),
    siteUrl: trimTrailingSlash(
      String(raw.siteUrl || process.env.TWINKLE_SITE_URL || DEFAULT_SITE_URL),
    ),
    npmRegistryUrl: trimTrailingSlash(
      String(
        raw.npmRegistryUrl ||
          process.env.LUMINE_NPM_REGISTRY_URL ||
          DEFAULT_NPM_REGISTRY_URL,
      ),
    ),
    authFile: String(
      raw.authFile || process.env.TWINKLE_CLI_AUTH_FILE || DEFAULT_AUTH_FILE,
    ),
    authToken:
      String(raw.authToken || process.env.TWINKLE_AUTH_TOKEN || "").trim() ||
      null,
    clientName: String(raw.clientName || "Lumine CLI").slice(0, 120),
    dir: raw.dir ? String(raw.dir) : "",
    summary: raw.summary ? String(raw.summary) : "",
    publish: parseBoolean(raw.publish, false),
    saveFirst: parseBoolean(raw.save, false),
    limit: Math.min(
      Math.max(
        Number(raw.limit || process.env.TWINKLE_PROJECT_LIMIT) ||
          DEFAULT_PROJECT_LIMIT,
        1,
      ),
      100,
    ),
    openBrowser: parseBoolean(raw.noOpen, false)
      ? false
      : parseBoolean(raw.open, true),
    updateCheck: parseBoolean(raw.noUpdateCheck, false) ? false : true,
    timeoutMs: Math.max(
      Number(raw.timeoutMs || process.env.TWINKLE_TIMEOUT_MS) ||
        DEFAULT_TIMEOUT_MS,
      1000,
    ),
    help: !!raw.help || command === "help",
  };
}

async function resolveRequiredBuildIdOrSelected(
  options,
  auth,
  { localProject = null } = {},
) {
  const targetReference = resolveBuildReference(options.target);
  if (targetReference.buildId > 0) {
    return await resolveBuildReferenceBuildId({
      options,
      auth,
      reference: targetReference,
    });
  }
  const resolvedLocalProject =
    localProject ||
    (await findLocalProjectMetadata(
      path.resolve(options.dir || process.cwd()),
    ));
  if (
    resolvedLocalProject?.metadata &&
    isReadOnlyReferenceMetadata(resolvedLocalProject.metadata)
  ) {
    const sourceBuildId =
      Number(resolvedLocalProject.metadata.reference?.sourceBuildId || 0) ||
      Number(resolvedLocalProject.metadata.buildId || 0) ||
      Number(resolvedLocalProject.metadata.build?.id || 0) ||
      0;
    throw new Error(
      `This is a read-only Lumine reference${sourceBuildId ? ` for Build ${sourceBuildId}` : ""}. Run \`lumine fork${sourceBuildId ? ` ${sourceBuildId}` : ""}\` to create an editable workspace, or pass an explicit Build URL.`,
    );
  }
  const localBuildId = Number(resolvedLocalProject?.metadata?.buildId || 0);
  if (localBuildId > 0) return localBuildId;
  const selectedBuildId = Number(auth?.selectedBuildId || 0);
  if (selectedBuildId > 0) return selectedBuildId;
  throw new Error(
    "Choose a project with `lumine select`, run `lumine`, or pass a Twinkle build URL.",
  );
}

async function resolveNewBuildTitle(options) {
  const title = String(options.title || "").trim();
  if (title) return title;
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Pass a title: `lumine new "My Build"` or `lumine new --title "My Build"`.');
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Build title: ");
    const normalized = String(answer || "").trim();
    if (!normalized) {
      throw new Error("Title is required.");
    }
    return normalized;
  } finally {
    rl.close();
  }
}

async function resolveNewBuildDescription(options) {
  if (options.noDescription) return null;
  if (options.descriptionProvided) {
    return String(options.description || "").trim() || null;
  }
  if (!input.isTTY || !output.isTTY) return null;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Description (optional): ");
    return String(answer || "").trim() || null;
  } finally {
    rl.close();
  }
}

function resolveRequiredBuildId(value) {
  const buildId = resolveBuildReference(value).buildId;
  if (buildId > 0) return buildId;
  throw new Error(
    "Pass a Twinkle build URL, app URL, preview URL, or build id.",
  );
}

function resolveBuildId(value) {
  return resolveBuildReference(value).buildId;
}

async function resolveBuildReferenceBuildId({ options, auth, reference }) {
  if (reference.branchNumber > 0) {
    const build = await resolveBranchBuild({
      options,
      auth,
      rootBuildId: reference.buildId,
      branchNumber: reference.branchNumber,
    });
    return Number(build.id || 0);
  }
  return Number(reference.buildId || 0);
}

function resolveBuildReference(value) {
  const rawValue = String(value || "").trim();
  const directId = Number(rawValue);
  if (Number.isFinite(directId) && directId > 0) {
    return { buildId: directId, branchNumber: 0 };
  }
  if (!rawValue) return { buildId: 0, branchNumber: 0 };

  try {
    const parsedUrl = new URL(rawValue);
    const host = parsedUrl.hostname.toLowerCase();
    const previewHost = host.match(/^b-(\d+)\.preview\.lumine\.app$/);
    if (previewHost) {
      return { buildId: Number(previewHost[1]) || 0, branchNumber: 0 };
    }

    const parts = parsedUrl.pathname.split("/").filter(Boolean);
    const appIndex = parts.indexOf("app");
    if (appIndex >= 0) {
      return { buildId: Number(parts[appIndex + 1]) || 0, branchNumber: 0 };
    }

    const buildIndex = parts.indexOf("build");
    if (buildIndex >= 0) {
      if (parts[buildIndex + 1] === "preview") {
        const nestedBuildIndex = parts.indexOf("build", buildIndex + 2);
        return {
          buildId: Number(parts[nestedBuildIndex + 1]) || 0,
          branchNumber: 0,
        };
      }
      return {
        buildId: Number(parts[buildIndex + 1]) || 0,
        branchNumber: Number(parts[buildIndex + 2]) || 0,
      };
    }

    return {
      buildId:
        Number(parsedUrl.searchParams.get("buildId")) ||
        Number(parsedUrl.searchParams.get("build")) ||
        0,
      branchNumber: 0,
    };
  } catch {
    const match = rawValue.match(
      /(?:^|\/)(?:app|build)\/(?:preview\/build\/)?(\d+)(?:\/(\d+))?(?:\/|$)/,
    );
    return {
      buildId: Number(match?.[1] || 0) || 0,
      branchNumber: Number(match?.[2] || 0) || 0,
    };
  }
}

function parseJson(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function authorizationHeader(authToken) {
  const token = String(authToken || "").trim();
  if (!token) return "";
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

function isMissingLoginError(error) {
  return String(error?.message || "").includes("Run `lumine login`");
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeOpenSourceSort(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["recent", "popular", "forks"].includes(normalized)) return normalized;
  return "forks";
}

async function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWorkspaceDir(build) {
  const titleSlug = slugify(build?.title || "");
  const buildId = Number(build?.id || 0) || "build";
  return `twinkle-${titleSlug || "build"}-${buildId}`;
}

function defaultReferenceDir(build) {
  const titleSlug = slugify(build?.title || "");
  const buildId = Number(build?.id || 0) || "build";
  return `twinkle-reference-${titleSlug || "build"}-${buildId}`;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function printHelp() {
  console.log(`Usage:
  lumine
  lumine login
  lumine whoami
  lumine logout
  lumine new [title]
  lumine projects
  lumine explore [search terms]
  lumine select [twinkle-build-url]
  lumine pull [twinkle-build-url]
  lumine reference <twinkle-build-url>
  lumine fork <twinkle-build-url>
  lumine diff <twinkle-branch-url>
  lumine merge <twinkle-branch-url>
  lumine replace-main <twinkle-branch-url>
  lumine save
  lumine check [twinkle-build-url]
  lumine launch [twinkle-build-url]

Examples:
  npx @stage5/lumine@latest
  npx @stage5/lumine@latest login
  npx @stage5/lumine@latest new "Daily Reflection App"
  npx @stage5/lumine@latest new --title "Daily Reflection App" --description "Private journal with streaks"
  npx @stage5/lumine@latest explore --sort forks
  npx @stage5/lumine@latest reference https://www.twin-kle.com/app/123
  npx @stage5/lumine@latest fork https://www.twin-kle.com/app/123
  npx @stage5/lumine@latest diff https://www.twin-kle.com/build/884/4
  npx @stage5/lumine@latest merge https://www.twin-kle.com/build/884/4
  npx @stage5/lumine@latest pull
  npx @stage5/lumine@latest save
  npx @stage5/lumine@latest save --publish
  npx @stage5/lumine@latest launch --save
  npx @stage5/lumine@latest launch https://www.twin-kle.com/app/123

Options:
  --api-url <url>       Twinkle API origin
  --site-url <url>      Twinkle website origin
  --auth-file <path>    Saved login path
  --auth-token <token>  Override saved login
  --dir <path>          Directory for pulled project files
  --title <text>        New Build title
  --description <text>  Optional New Build description
  --no-description      Skip the New Build description prompt
  --summary <text>      Save summary
  --search <text>       Search public open-source Builds
  --sort <sort>         Sort open-source Builds: forks, popular, recent
  --publish             Publish after saving
  --save                Save local files before launch
  --limit <number>      Number of projects to show
  --no-update-check     Skip the npm latest-version check
  --no-open             Print the approval URL without opening a browser
`);
}
