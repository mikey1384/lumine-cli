import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

import {
  ASSETS_METADATA_FILE,
  COMMANDS,
  DEFAULT_API_URL,
  DEFAULT_AUTH_FILE,
  DEFAULT_NPM_REGISTRY_URL,
  DEFAULT_PROJECT_LIMIT,
  DEFAULT_SAVE_SUMMARY,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MS,
  LUMINE_MAIN_CHECKOUT_INSTRUCTIONS,
  LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER,
  LUMINE_VERSION_CHECKOUT_INSTRUCTIONS,
  LUMINE_VERSION_CHECKOUT_INSTRUCTIONS_MARKER,
  MAIN_CHECKOUT_READONLY_COMMANDS,
  PROJECT_METADATA_DIR,
  SDK_REFERENCE_FILE,
} from "./constants.js";
import {
  createBuild,
  fetchAllRuntimeAssets,
  forkBuild,
  listBuilds,
  listOpenSourceBuilds,
  loadBuildFiles,
  loadBuildMetadata,
  loadBuildVersionFiles,
  loadBuildVersions,
  loadContributionDiff,
  loadLumineCliVersionInfo,
  loadOpenSourceBuildFiles,
  maybeCheckForLumineCliUpdate,
  mergeContributionIntoMain,
  mintBuildApiToken,
  publishBuild,
  replaceMainWithContribution,
  resolveBranchBuild,
  saveProjectFiles,
} from "./api.js";
import { assetsCommand, writeAssetsManifest } from "./assets.js";
import { thumbnailCommand } from "./thumbnail.js";
import {
  assertAuthScope,
  ensureAuth,
  login,
  logout,
  resolveAuth,
  saveSelectedBuild,
  whoami,
} from "./auth.js";
import { probeUrl, requestJson } from "./http.js";
import { sdkCommand } from "./sdk.js";
import { doctorCommand, normalizePreviewUrl } from "./doctor.js";
import {
  defaultMainCheckoutDir,
  defaultReferenceDir,
  defaultVersionCheckoutDir,
  defaultWorkspaceDir,
  parseBoolean,
  resolveBuildId,
  resolveBuildReference,
  resolveRequiredBuildId,
  shellQuote,
  toCamelCase,
  trimTrailingSlash,
} from "./util.js";
import {
  assertLocalProjectCanBeSaved,
  assertProjectFilesWithinLimits,
  collectProjectFiles,
  collectProjectLimitFindings,
  findLocalProjectMetadata,
  isIndexHtmlPath,
  isReadOnlyReferenceMetadata,
  removeLocalProjectFilesNotIn,
  resolveProjectDirForSave,
  writeAgentInstructions,
  writeInstructionFiles,
  writeMainCheckoutMetadata,
  writeProjectFiles,
  writeVersionCheckoutMetadata,
  writeProjectMetadata,
  writeReferenceInstructions,
  writeReferenceMetadata,
  writeSdkReference,
} from "./workspace.js";

export async function main() {
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
  if (options.command === "update-from-main") {
    await updateBranchFromMain(options);
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
  if (options.command === "versions") {
    await versionsCommand(options);
    return;
  }
  if (options.command === "restore") {
    await restoreVersion(options);
    return;
  }
  if (options.command === "launch") {
    await launch(options);
    return;
  }
  if (options.command === "sdk") {
    await sdkCommand(options);
    return;
  }
  if (options.command === "assets") {
    await assetsCommand(options);
    return;
  }
  if (options.command === "thumbnail") {
    await thumbnailCommand(options);
    return;
  }
  if (options.command === "doctor") {
    await doctorCommand(options);
    return;
  }

  printHelp();
}

export async function newBuild(options) {
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

export async function workspace(options) {
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

export async function projects(options) {
  const auth = await resolveAuth(options);
  const builds = await listBuilds({ options, auth });
  printBuildList(builds);
}

export async function explore(options) {
  const auth = await resolveAuth(options);
  const builds = await listOpenSourceBuilds({ options, auth });
  printOpenSourceBuildList(builds, options);
}

export async function selectProject(options) {
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

export async function pull(options) {
  if (options.versionProvided && !(options.pullVersion > 0)) {
    throw new Error(
      "Pass a save number: `lumine pull --version <n>` (run `lumine versions` to see save numbers).",
    );
  }
  const auth = await resolveAuth(options);
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  const requestedBuildId = await resolveRequiredBuildIdOrSelected(
    options,
    auth,
    options.pullMain ? { localProject } : {},
  );
  const selectedBuild = await loadBuildMetadata({
    options,
    auth,
    buildId: requestedBuildId,
  });
  if (options.pullVersion > 0) {
    await pullVersionBuildFiles({ options, auth, build: selectedBuild });
    return;
  }
  if (options.pullMain) {
    await pullMainBuildFiles({ options, auth, build: selectedBuild });
    return;
  }
  const build = await resolveEditableWorkspaceBuild({
    options,
    auth,
    build: selectedBuild,
  });
  const result = await pullBuildFiles({ options, auth, buildId: build.id });
  await saveSelectedBuild({ options, auth, build: result.build });
  printPullResult(result);
}

// Sync a contribution branch with its team project's main: the server runs a
// three-way merge (auto-merging where it can, writing git-style conflict
// markers where it cannot) and saves the result to the branch. When run inside
// the branch's workspace, local edits are sent along as the branch's pending
// state and the merged files are written back to disk.
export async function updateBranchFromMain(options) {
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth, {
    localProject,
  });
  const build = await loadBuildMetadata({ options, auth, buildId });
  const rootBuildId = Number(build?.contributionRootBuildId || 0);
  const contributionBuildId = Number(build?.id || 0);
  if (!rootBuildId || !contributionBuildId) {
    throw new Error(
      "update-from-main only applies to contribution branches of a team project. Pull the team project first so your branch workspace exists.",
    );
  }
  let dir = null;
  let projectFiles = null;
  if (Number(localProject?.metadata?.buildId || 0) === contributionBuildId) {
    dir = resolveProjectDirForSave({ options, localProject });
    projectFiles = await collectProjectFiles(dir);
  }
  const result = await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/update-from-main`,
    authToken: auth.token,
    body: projectFiles ? { projectFiles } : {},
    timeoutMs: options.timeoutMs,
  });
  const mergedFiles = Array.isArray(result.projectFiles)
    ? result.projectFiles
    : [];
  if (dir && mergedFiles.length > 0) {
    await writeProjectFiles({ dir, files: mergedFiles });
    await removeLocalProjectFilesNotIn({ dir, files: mergedFiles });
    const refreshed = await loadBuildMetadata({
      options,
      auth,
      buildId: contributionBuildId,
    }).catch(() => null);
    if (refreshed) {
      await writeProjectMetadata({
        dir,
        options,
        build: refreshed,
        manifest: localProject?.metadata?.manifest || null,
        pulledAt: new Date().toISOString(),
      });
    }
  }
  printUpdateFromMainResult({ result, build, dir, mergedFiles });
}

export async function reference(options) {
  const auth = await resolveAuth(options);
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const result = await pullReferenceFiles({ options, auth, buildId });
  printReferenceResult(result);
}

export async function fork(options) {
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

export async function diff(options) {
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

export async function mergeBranch(options) {
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

export async function replaceMainWithBranch(options) {
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

export async function save(options) {
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
  assertProjectFilesWithinLimits(files);
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

export async function check(options) {
  await reportLocalProjectFindings(options);
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

// Local, network-free half of `lumine check`: validate the workspace against
// the platform's project-file rules so agents see violations before saving.
export async function reportLocalProjectFindings(options) {
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  if (!localProject?.rootDir || localProject?.metadata?.readOnly) return;
  let files;
  try {
    files = await collectProjectFiles(localProject.rootDir);
  } catch (error) {
    console.error(`Local check failed: ${error?.message || error}`);
    process.exitCode = 1;
    return;
  }
  const { errors, warnings } = collectProjectLimitFindings(files);
  for (const warning of warnings) {
    console.error(`Local check warning: ${warning}`);
  }
  for (const errorMessage of errors) {
    console.error(`Local check error: ${errorMessage}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `Local check: ${files.length} project file${files.length === 1 ? "" : "s"} within limits.`,
    );
  }
}

export async function launch(options) {
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

export function printCheck(result) {
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

export async function loadTargetBuildMetadata({ options, auth }) {
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  return await loadBuildMetadata({ options, auth, buildId });
}

export async function resolveBuildForSave({ options, auth, buildId, localProject }) {
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

export async function resolveEditableWorkspaceBuild({
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

export function shouldUseContributionBranch(build) {
  return (
    build?.role === "collaborator" &&
    build.canWrite !== true &&
    !isContributionBranch(build)
  );
}

// A canonical team build the viewer contributes to: plain pull/restore would
// switch to their contribution branch, so version-history follow-up commands
// for THIS build's history need --main. An owner's canonical build is their
// editable workspace and never needs it.
export function isCollaboratorMainBuild(build) {
  return (
    build?.role === "collaborator" &&
    build.canWrite !== true &&
    !Number(build?.contributionRootBuildId || 0)
  );
}

export async function ensureDefaultContributionBranch({ options, auth, build }) {
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

export function normalizeContributionBranchBuild({ branch, sourceBuild }) {
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

export async function chooseProject({ builds }) {
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

export async function pullBuildFiles({ options, auth, buildId }) {
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
  // Best-effort asset manifest so terminal agents know what media already
  // exists (the workspace UI gives Lumine the same context). Never fail the
  // pull over it.
  let assetCount = null;
  try {
    const { token } = await mintBuildApiToken({
      options,
      auth,
      buildId: Number(build.id || buildId),
      scopes: ["files:read"],
    });
    const { assets, usage, projectAssets } = await fetchAllRuntimeAssets({
      options,
      auth,
      buildId: Number(build.id || buildId),
      buildApiToken: token,
    });
    await writeAssetsManifest({
      dir,
      buildId: Number(build.id || buildId),
      assets,
      usage,
      projectAssets,
      codeFiles: files,
    });
    assetCount = assets.length + (projectAssets?.length || 0);
  } catch (error) {
    console.error(
      `lumine: skipped ${ASSETS_METADATA_FILE} (${error?.message || error})`,
    );
  }
  return {
    build,
    dir,
    fileCount: files.length,
    manifest: result.projectManifest || null,
    assetCount,
  };
}

export async function pullReferenceFiles({ options, auth, buildId }) {
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

// Read-only checkout of a team project's MAIN workspace. Collaborators edit on
// their contribution branch; this exists so branch work can consult what main
// currently looks like without the pull auto-redirecting to the branch.
export async function pullMainBuildFiles({ options, auth, build }) {
  const rootBuildId =
    Number(build?.contributionRootBuildId || 0) || Number(build?.id || 0);
  if (!rootBuildId) {
    throw new Error("Could not resolve the team project for --main.");
  }
  const result = await loadBuildFiles({
    options,
    auth,
    buildId: rootBuildId,
    includeContent: true,
  });
  const rootBuild = result.build || { id: rootBuildId, title: `Build ${rootBuildId}` };
  const files = Array.isArray(result.projectFiles) ? result.projectFiles : [];
  // Never nest a main checkout inside another Lumine workspace (a later save
  // there would upload it as project files) — default to a sibling instead.
  // Running from a main checkout of this same build refreshes it in place,
  // and the refresh prunes files main has deleted (a snapshot must not lie).
  const enclosing = options.dir
    ? null
    : await findLocalProjectMetadata(process.cwd());
  const enclosingIsThisMain =
    enclosing?.metadata?.mainCheckout === true &&
    Number(enclosing.metadata.buildId || 0) === rootBuildId;
  const dir = path.resolve(
    options.dir ||
      (enclosingIsThisMain
        ? enclosing.rootDir
        : enclosing
          ? path.join(path.dirname(enclosing.rootDir), defaultMainCheckoutDir(rootBuild))
          : defaultMainCheckoutDir(rootBuild)),
  );
  await writeProjectFiles({ dir, files });
  if (files.some((file) => isIndexHtmlPath(String(file.path)))) {
    await removeLocalProjectFilesNotIn({ dir, files });
  }
  await writeInstructionFiles({
    dir,
    marker: LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER,
    content: LUMINE_MAIN_CHECKOUT_INSTRUCTIONS,
  });
  await writeSdkReference({ dir });
  await writeMainCheckoutMetadata({
    dir,
    options,
    build: rootBuild,
    manifest: result.projectManifest || null,
    pulledAt: new Date().toISOString(),
  });
  console.log(`Pulled main for ${formatBuildTitle(rootBuild)} (read-only).`);
  console.log(`Pulled ${files.length} file${files.length === 1 ? "" : "s"} to ${dir}`);
  console.log(
    `Edits belong on your branch: \`lumine pull ${rootBuildId}\`, and \`lumine update-from-main\` brings main's changes into it.`,
  );
}

// Read-only checkout of ONE previous save (`lumine pull --version <n>`).
// Without --main it targets the build the workspace edits (your branch on team
// projects); with --main it targets the team project's main history.
export async function pullVersionBuildFiles({ options, auth, build }) {
  const versionNumber = options.pullVersion;
  let targetBuild = build;
  if (options.pullMain) {
    const rootBuildId =
      Number(build?.contributionRootBuildId || 0) || Number(build?.id || 0);
    targetBuild =
      rootBuildId === Number(build?.id || 0)
        ? build
        : await loadBuildMetadata({ options, auth, buildId: rootBuildId });
  } else {
    targetBuild = await resolveEditableWorkspaceBuild({
      options,
      auth,
      build,
    });
  }
  const buildId = Number(targetBuild?.id || 0);
  const result = await loadBuildVersionFiles({
    options,
    auth,
    buildId,
    versionNumber,
  });
  const resolvedBuild = result.build || targetBuild;
  const version = result.version || { version: versionNumber };
  const files = Array.isArray(result.projectFiles) ? result.projectFiles : [];
  // Same nesting rules as a main checkout: never create a version checkout
  // inside another Lumine workspace; re-pulling the same checkout refreshes it
  // in place.
  const enclosing = options.dir
    ? null
    : await findLocalProjectMetadata(process.cwd());
  const enclosingIsThisCheckout =
    enclosing?.metadata?.versionCheckout === true &&
    Number(enclosing.metadata.buildId || 0) === buildId &&
    Number(enclosing.metadata.checkoutVersion || 0) ===
      Number(version.version || 0);
  const dirName = defaultVersionCheckoutDir(resolvedBuild, version.version);
  const dir = path.resolve(
    options.dir ||
      (enclosingIsThisCheckout
        ? enclosing.rootDir
        : enclosing
          ? path.join(path.dirname(enclosing.rootDir), dirName)
          : dirName),
  );
  await writeProjectFiles({ dir, files });
  if (files.some((file) => isIndexHtmlPath(String(file.path)))) {
    await removeLocalProjectFilesNotIn({ dir, files });
  }
  await writeInstructionFiles({
    dir,
    marker: LUMINE_VERSION_CHECKOUT_INSTRUCTIONS_MARKER,
    content: LUMINE_VERSION_CHECKOUT_INSTRUCTIONS,
  });
  await writeSdkReference({ dir });
  await writeVersionCheckoutMetadata({
    dir,
    options,
    build: resolvedBuild,
    manifest: result.projectManifest || null,
    version,
    pulledAt: new Date().toISOString(),
  });
  const summaryText = version.summary ? ` — "${version.summary}"` : "";
  console.log(
    `Pulled save v${version.version} of ${formatBuildTitle(resolvedBuild)} (read-only)${summaryText}`,
  );
  console.log(
    `Pulled ${files.length} file${files.length === 1 ? "" : "s"} to ${dir}`,
  );
  console.log(
    isCollaboratorMainBuild(resolvedBuild)
      ? `Restore it with \`lumine restore ${version.version} --main\` from your branch workspace, then \`lumine save\`.`
      : `Restore it with \`lumine restore ${version.version}\` from Build ${buildId}'s editable workspace, then \`lumine save\`.`,
  );
}

// List a build's previous saves (every workspace/CLI save creates one).
// Targets the SAME build `lumine pull --version <n>` would snapshot, so the
// listed numbers and the printed follow-up commands always agree: without
// --main that's the editable workspace build (a collaborator's branch on team
// projects), with --main the team project's main.
export async function versionsCommand(options) {
  const auth = await resolveAuth(options);
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  const requestedBuildId = options.buildIdFlag
    ? resolveRequiredBuildId(options.buildIdFlag)
    : await resolveRequiredBuildIdOrSelected(options, auth, { localProject });
  const requestedBuild = await loadBuildMetadata({
    options,
    auth,
    buildId: requestedBuildId,
  });
  // Standing in a read-only checkout (pull --main / pull --version), the
  // resolved id IS the build being looked at — don't bounce it to the
  // viewer's contribution branch.
  const resolvedFromReadOnlyCheckout =
    !options.buildIdFlag &&
    !(resolveBuildReference(options.target).buildId > 0) &&
    (localProject?.metadata?.mainCheckout === true ||
      localProject?.metadata?.versionCheckout === true);
  let buildId = requestedBuildId;
  if (options.pullMain) {
    buildId =
      Number(requestedBuild?.contributionRootBuildId || 0) || requestedBuildId;
  } else if (!resolvedFromReadOnlyCheckout) {
    const editableBuild = await resolveEditableWorkspaceBuild({
      options,
      auth,
      build: requestedBuild,
    });
    buildId = Number(editableBuild?.id || 0) || requestedBuildId;
  }
  const result = await loadBuildVersions({
    options,
    auth,
    buildId,
    limit: options.limit,
  });
  printVersionList({ result });
}

export function printVersionList({ result }) {
  const build = result.build || {};
  const versions = Array.isArray(result.versions) ? result.versions : [];
  if (!versions.length) {
    console.log(`No previous saves found for ${formatBuildTitle(build)}.`);
    return;
  }
  console.log(
    `Previous saves for ${formatBuildTitle(build)} (newest first):`,
  );
  for (const version of versions) {
    const author =
      version.createdByUsername ||
      (version.createdByRole === "assistant" ? "Lumine" : null) ||
      version.createdByRole ||
      "unknown";
    const fileText =
      Number(version.fileCount || 0) > 0
        ? `${version.fileCount} file${Number(version.fileCount) === 1 ? "" : "s"}`
        : "single-file save";
    const summaryText = version.summary ? ` — ${version.summary}` : "";
    console.log(
      `  v${version.version}  ${formatVersionTimestamp(version.createdAt)}  by ${author}  (${fileText})${summaryText}`,
    );
  }
  // The follow-up commands must hit exactly the history that was just listed,
  // regardless of where the user runs them or which flags produced this list.
  // Embedding the listed build id makes pull workspace-independent; --main is
  // needed only when the listed build is a canonical team build the viewer
  // contributes to (plain pull/restore would switch to their branch — mirrors
  // shouldUseContributionBranch). An owner's canonical build never needs
  // --main: it IS their editable workspace.
  const listedBuildId = Number(build.id || 0);
  const collaboratorMain = isCollaboratorMainBuild(build);
  const pullTarget = listedBuildId ? ` ${listedBuildId}` : "";
  console.log(
    `View one read-only: lumine pull${pullTarget} --version <n>${collaboratorMain ? " --main" : ""}`,
  );
  console.log(
    collaboratorMain
      ? `Bring one back: lumine restore <n> --main (run from your branch workspace; then lumine save)`
      : `Bring one back: lumine restore <n> (run from ${listedBuildId ? `Build ${listedBuildId}'s` : "the build's"} editable workspace; then lumine save)`,
  );
}

function formatVersionTimestamp(seconds) {
  const timestamp = Number(seconds || 0);
  if (!timestamp) return "unknown time";
  const date = new Date(timestamp * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Write a previous save's files into the CURRENT editable workspace. Local
// only on purpose: the user reviews the result and `lumine save` makes it a
// new version (nothing on the server is rewritten in place). With --main in a
// branch workspace, the save is read from the team project's MAIN history —
// the recovery path when work was lost on main itself.
export async function restoreVersion(options) {
  // Same strictness as `pull --version`: only a plain positive integer may
  // reach the workspace-overwriting path below. "2.5" must error, not
  // silently restore v2.
  const rawInput = String(options.positional[0] ?? "").trim();
  let versionNumber = 0;
  if (rawInput) {
    if (!/^\d+$/.test(rawInput)) {
      throw new Error(
        "Pass a plain save number, e.g. `lumine restore 41` (see `lumine versions`).",
      );
    }
    versionNumber = parseInt(rawInput, 10);
  } else if (options.pullVersion > 0) {
    // --version <n>, already strict-parsed by parseArgs.
    versionNumber = options.pullVersion;
  } else if (options.versionProvided) {
    throw new Error(
      "Pass a plain save number, e.g. `lumine restore 41` (see `lumine versions`).",
    );
  }
  if (!(versionNumber > 0)) {
    throw new Error(
      "Pass the save number to restore, e.g. `lumine restore 41` (see `lumine versions`).",
    );
  }
  const auth = await resolveAuth(options);
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  if (!Number(localProject?.metadata?.buildId || 0)) {
    throw new Error(
      "Run `lumine restore` inside a pulled Lumine workspace (or pass --dir <workspace>).",
    );
  }
  assertLocalProjectCanBeSaved(localProject);
  const workspaceBuildId = Number(localProject.metadata.buildId);
  let sourceBuildId = workspaceBuildId;
  if (options.pullMain) {
    const rootBuildId = Number(
      localProject.metadata.build?.contributionRootBuildId || 0,
    );
    if (!rootBuildId) {
      throw new Error(
        "--main restores from the team project's main history, which needs a contribution-branch workspace.",
      );
    }
    sourceBuildId = rootBuildId;
  }
  const result = await loadBuildVersionFiles({
    options,
    auth,
    buildId: sourceBuildId,
    versionNumber,
  });
  const files = Array.isArray(result.projectFiles) ? result.projectFiles : [];
  if (!files.length) {
    throw new Error(`Save v${versionNumber} has no files to restore.`);
  }
  const dir = resolveProjectDirForSave({ options, localProject });
  await writeProjectFiles({ dir, files });
  if (files.some((file) => isIndexHtmlPath(String(file.path)))) {
    await removeLocalProjectFilesNotIn({ dir, files });
  }
  const version = result.version || { version: versionNumber };
  const sourceBuild = result.build || { id: sourceBuildId };
  const summaryText = version.summary ? ` ("${version.summary}")` : "";
  console.log(
    `Restored ${files.length} file${files.length === 1 ? "" : "s"} from ${formatBuildTitle(sourceBuild)} save v${version.version}${summaryText} into ${dir}`,
  );
  console.log("Local only so far — review the files, then run:");
  console.log(
    `  lumine save --summary ${shellQuote(`Restore from ${options.pullMain ? "main " : ""}v${version.version}`)}`,
  );
}

export function printBuildList(builds) {
  if (!builds.length) {
    console.log("No owned or team Twinkle builds found.");
    return;
  }
  console.log("Twinkle builds:");
  builds.forEach((build, index) => {
    console.log(`${index + 1}. ${formatBuildListItem(build)}`);
  });
}

export function printOpenSourceBuildList(builds, options) {
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

export function formatBuildListItem(build) {
  const role =
    build.role === "owner"
      ? "owned by you"
      : `team project${build.ownerUsername ? ` with ${build.ownerUsername}` : ""}`;
  const published = build.isPublic ? "public" : "private";
  return `${formatBuildTitle(build)} - ${role}, ${published}`;
}

export function formatOpenSourceBuildListItem(build) {
  const owner = build.ownerUsername ? ` by ${build.ownerUsername}` : "";
  const stats = [
    `${Math.max(0, Number(build.forkCount || 0))} forks`,
    `${Math.max(0, Number(build.viewCount || 0))} views`,
  ].join(", ");
  const appUrl = build.appUrl ? ` - ${build.appUrl}` : "";
  return `${formatBuildTitle(build)}${owner} - ${stats}${appUrl}`;
}

export function formatBuildTitle(build) {
  return `${build.title || `Build ${build.id}`} (#${build.id})`;
}

export function isContributionBranch(build) {
  return (
    String(build?.contributionStatus || "none") !== "none" ||
    Number(build?.contributionRootBuildId || 0) > 0 ||
    Number(build?.contributionBranchNumber || 0) > 0
  );
}

export function resolveContributionActionBuildIds(build) {
  const contributionBuildId = Number(build?.id || 0);
  const rootBuildId = Number(build?.contributionRootBuildId || 0);
  if (!contributionBuildId || !rootBuildId || !isContributionBranch(build)) {
    throw new Error(
      "Pass a branch URL such as https://www.twin-kle.com/build/884/4, or run this from a pulled branch workspace.",
    );
  }
  return { rootBuildId, contributionBuildId };
}

export function printPullResult(result) {
  const build = result.build || {};
  const entryPath = result.manifest?.entryPath || "unknown";
  console.log(`Selected ${formatBuildTitle(build)}.`);
  console.log(
    `Pulled ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} to ${result.dir}`,
  );
  console.log(`Entry: ${entryPath}`);
  console.log(`SDK reference: ${SDK_REFERENCE_FILE}`);
  if (typeof result.assetCount === "number") {
    console.log(
      result.assetCount > 0
        ? `Assets: ${result.assetCount} uploaded (URLs in ${PROJECT_METADATA_DIR}/${ASSETS_METADATA_FILE})`
        : "Assets: none uploaded yet (add media with `lumine assets upload <file>`)",
    );
  }
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

export function printNewBuildResult({ createResult, pullResult }) {
  const build = pullResult.build || createResult.build || {};
  console.log(`Created ${formatBuildTitle(build)}.`);
  printPullResult(pullResult);
}

export function printReferenceResult(result) {
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

export function printForkResult({ forkResult, pullResult }) {
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

export function printSaveResult({ result, build, dir, files }) {
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

export function printContributionDiff({ result, build }) {
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

export function printUpdateFromMainResult({ result, build, dir, mergedFiles }) {
  const branchNumber = Number(build?.contributionBranchNumber || 0) || 0;
  const branchLabel = branchNumber
    ? `branch ${branchNumber}`
    : `branch #${build?.id}`;
  const autoMerged = Array.isArray(result.autoMergedPaths)
    ? result.autoMergedPaths
    : [];
  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  console.log(
    `Updated ${branchLabel} from main (${mergedFiles.length} file${mergedFiles.length === 1 ? "" : "s"}).`,
  );
  if (autoMerged.length > 0) {
    console.log(`Auto-merged: ${autoMerged.join(", ")}`);
  }
  if (conflicts.length > 0) {
    const conflictPaths = conflicts.map((conflict) =>
      typeof conflict === "string" ? conflict : conflict?.path || "unknown",
    );
    console.log(`CONFLICTS (markers written): ${conflictPaths.join(", ")}`);
    console.log(
      dir
        ? "Resolve the <<<<<<< / >>>>>>> markers in the files above, then run `lumine save`."
        : "Pull the branch, resolve the <<<<<<< / >>>>>>> markers, then run `lumine save`.",
    );
  } else if (!dir) {
    console.log(
      "The branch was updated on Twinkle. Run `lumine pull` to refresh your local workspace.",
    );
  } else {
    console.log(`Local workspace updated: ${dir}`);
  }
}

export function printContributionActionResult({
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

export function parseArgs(args) {
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
    "allowWrite",
    "main",
    "yes",
    "json",
    "keepAssets",
    "noBrowser",
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
    positional,
    repeat: Math.min(Math.max(Math.floor(Number(raw.repeat) || 1), 1), 20),
    allowWrite: parseBoolean(raw.allowWrite, false),
    assumeYes: parseBoolean(raw.yes, false),
    sdkPath: raw.path ? String(raw.path) : "",
    sdkScopes: String(raw.scopes || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    buildIdFlag: raw.build ? String(raw.build) : "",
    model: raw.model ? String(raw.model) : "",
    quality: raw.quality ? String(raw.quality) : "",
    assetName: raw.name ? String(raw.name) : "",
    out: raw.out ? String(raw.out) : "",
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
    previewUrl: normalizePreviewUrl(
      raw.previewUrl ||
        process.env.TWINKLE_PREVIEW_URL ||
        process.env.TWINKLE_BUILD_PREVIEW_URL,
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
    pullMain: parseBoolean(raw.main, false),
    // Strict: only a plain positive integer counts. Anything else (missing
    // value, "foo", a swallowed flag like "--main", "2.5") stays 0 and the
    // consuming command must reject it via versionProvided instead of
    // silently falling back to a live pull.
    versionProvided: Object.prototype.hasOwnProperty.call(raw, "version"),
    pullVersion: /^\d+$/.test(String(raw.version ?? "").trim())
      ? parseInt(String(raw.version).trim(), 10)
      : 0,
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
    json: parseBoolean(raw.json, false),
    keepAssets: parseBoolean(raw.keepAssets, false),
    noBrowser: parseBoolean(raw.noBrowser, false),
    updateCheck: parseBoolean(raw.noUpdateCheck, false) ? false : true,
    timeoutMs: Math.max(
      Number(raw.timeoutMs || process.env.TWINKLE_TIMEOUT_MS) ||
        DEFAULT_TIMEOUT_MS,
      1000,
    ),
    help: !!raw.help || command === "help",
  };
}

export async function resolveRequiredBuildIdOrSelected(
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
  // A `pull --main` checkout is read-only but still knows its root build id.
  // Read-only commands run from it (check, diff, a refreshing `pull --main`)
  // resolve that id instead of bouncing off the reference/fork error — but
  // mutating commands (launch would PUBLISH main, save, merge, …) stay blocked
  // with main-checkout-specific guidance.
  if (resolvedLocalProject?.metadata?.mainCheckout === true) {
    const mainBuildId =
      Number(resolvedLocalProject.metadata.buildId || 0) ||
      Number(resolvedLocalProject.metadata.build?.id || 0);
    if (!MAIN_CHECKOUT_READONLY_COMMANDS.has(options.command)) {
      throw new Error(
        `This is a read-only checkout of main${mainBuildId ? ` for Build ${mainBuildId}` : ""}; \`lumine ${options.command}\` isn't available here. Run it from your branch workspace or the canonical checkout, or pass an explicit Build URL.`,
      );
    }
    if (mainBuildId > 0) return mainBuildId;
  }
  // Same deal for a `pull --version <n>` checkout: read-only commands resolve
  // the build it snapshots; mutating commands are pointed back at the
  // editable workspace.
  if (resolvedLocalProject?.metadata?.versionCheckout === true) {
    const checkoutBuildId =
      Number(resolvedLocalProject.metadata.buildId || 0) ||
      Number(resolvedLocalProject.metadata.build?.id || 0);
    const checkoutVersion =
      Number(resolvedLocalProject.metadata.checkoutVersion || 0) || 0;
    if (!MAIN_CHECKOUT_READONLY_COMMANDS.has(options.command)) {
      throw new Error(
        `This is a read-only checkout of a previous save${checkoutVersion ? ` (v${checkoutVersion})` : ""}${checkoutBuildId ? ` for Build ${checkoutBuildId}` : ""}; \`lumine ${options.command}\` isn't available here. Run it from the editable workspace, or pass an explicit Build URL.`,
      );
    }
    if (checkoutBuildId > 0) return checkoutBuildId;
  }
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

export async function resolveNewBuildTitle(options) {
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

export async function resolveNewBuildDescription(options) {
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

export async function resolveBuildReferenceBuildId({ options, auth, reference }) {
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

export function normalizeOpenSourceSort(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["recent", "popular", "forks"].includes(normalized)) return normalized;
  return "forks";
}

export function printHelp() {
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
  lumine pull [twinkle-build-url] --main
  lumine pull [twinkle-build-url] --version <n> [--main]
  lumine versions [twinkle-build-url] [--main] [--limit <n>]
  lumine restore <n> [--main]
  lumine reference <twinkle-build-url>
  lumine fork <twinkle-build-url>
  lumine diff <twinkle-branch-url>
  lumine merge <twinkle-branch-url>
  lumine replace-main <twinkle-branch-url>
  lumine update-from-main [twinkle-branch-url]
  lumine save
  lumine check [twinkle-build-url]
  lumine launch [twinkle-build-url]
  lumine sdk list
  lumine sdk call <namespace.method> [jsonArgs]
  lumine assets [list]
  lumine assets upload <file...>
  lumine assets generate "<prompt>" --model <gpt-image-2|nano-banana>
  lumine assets delete <assetId>
  lumine assets prune [--yes]
  lumine thumbnail set <file>
  lumine thumbnail capture [--out <file>]
  lumine thumbnail generate ["<prompt>"] --model <gpt-image-2|nano-banana>
  lumine doctor runtime-assets

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
  npx @stage5/lumine@latest pull 884 --main
  npx @stage5/lumine@latest versions --main
  npx @stage5/lumine@latest pull --version 41 --main
  npx @stage5/lumine@latest restore 41 --main
  npx @stage5/lumine@latest update-from-main
  npx @stage5/lumine@latest pull
  npx @stage5/lumine@latest save
  npx @stage5/lumine@latest save --publish
  npx @stage5/lumine@latest launch --save
  npx @stage5/lumine@latest launch https://www.twin-kle.com/app/123
  npx @stage5/lumine@latest sdk call aiStories.chapters '{"limit": 5}'
  npx @stage5/lumine@latest sdk call privateDb.get '{"key": "prefs"}' --build 1374
  npx @stage5/lumine@latest sdk call aiStories.list '{"difficulty": 1}' --repeat 5
  npx @stage5/lumine@latest assets upload art/hero.png sounds/theme.mp3
  npx @stage5/lumine@latest assets list --build 917
  npx @stage5/lumine@latest assets generate "pixel-art forest background" --model nano-banana
  npx @stage5/lumine@latest thumbnail set art/cover.png
  npx @stage5/lumine@latest thumbnail capture --out capture.png
  npx @stage5/lumine@latest thumbnail generate --model gpt-image-2 --yes
  npx @stage5/lumine@latest doctor runtime-assets --build 917 --json

Options:
  --api-url <url>       Twinkle API origin
  --site-url <url>      Twinkle website origin
  --preview-url <url>   Twinkle Build preview origin
  --auth-file <path>    Saved login path
  --auth-token <token>  Override saved login
  --dir <path>          Directory for pulled project files
  --main                With pull/versions/restore: target the team project's main
  --version <n>         With pull: read-only checkout of previous save v<n>
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
  --build <id>          Build id for sdk/assets/thumbnail calls outside a workspace
  --repeat <n>          Repeat an sdk call (1-20) and print latency stats
  --allow-write         Permit sdk methods that mutate app data
  --path <api/...>      Call an sdk endpoint not in the curated list
  --scopes <a,b>        Override requested build API token scopes
  --json                Print machine-readable output for doctor commands
  --keep-assets         Keep doctor probe assets instead of deleting them
  --no-browser          Skip doctor browser probes
  --model <model>       Image model for generate: gpt-image-2 or nano-banana (required, no default)
  --quality <q>         gpt-image-2 quality: low, medium, high (default high)
  --name <fileName>     File name hint for a generated asset
  --out <path>          With thumbnail capture: also save the capture locally
  --yes                 Skip confirmation prompts (assets prune/generate, thumbnail)
`);
}
