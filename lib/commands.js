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
  adoptBuildThumbnailSuggestion,
  createBuild,
  fetchAllRuntimeAssets,
  forkBuild,
  listBuilds,
  listBuildSuggestions,
  listOpenSourceBuilds,
  loadBuildFiles,
  loadBuildMetadata,
  loadBuildVersionFiles,
  loadBuildVersions,
  loadContributionDiff,
  listContributionBranches,
  loadLumineCliVersionInfo,
  loadOpenSourceBuildFiles,
  maybeCheckForLumineCliUpdate,
  mergeContributionIntoMain,
  mintBuildApiToken,
  notifyBuildOwnerOfContribution,
  publishBuild,
  replaceMainWithContribution,
  resolveBranchBuild,
  saveProjectFiles,
  suggestBuildThumbnailToOwner,
  updateBuildMetadata,
  upgradeBuildProjectLimits,
} from "./api.js";
import { assetsCommand, confirmPrompt, writeAssetsManifest } from "./assets.js";
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
import { adminCommand } from "./admin.js";
import { runBuildForumCommand } from "./forum.js";
import { agentCommand } from "./agent.js";
import { agentMcpCommand } from "./agent/mcp-server.js";
import { appMcpCommand } from "./app-mcp/server.js";
import { sponsorCommand } from "./sponsor.js";
import {
  defaultMainCheckoutDir,
  defaultReferenceDir,
  defaultVersionCheckoutDir,
  defaultWorkspaceDir,
  formatBytes,
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
  isReadOnlyProjectMetadata,
  isReadOnlyReferenceMetadata,
  removeLocalProjectFilesNotIn,
  stashLocalProjectFilesBeforePull,
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
  // MCP stdio must remain protocol-clean: no update checks, help text, or
  // other stdout can run before the server takes ownership of the stream.
  if (options.command === "agent-mcp") {
    await agentMcpCommand(options);
    return;
  }
  if (options.command === "app-mcp") {
    await appMcpCommand(options);
    return;
  }
  options.lumineCli = await loadLumineCliVersionInfo({ options });
  if (options.help) {
    printHelp();
    return;
  }
  if (options.updateCheck && !(options.command === "admin" && options.json)) {
    await maybeCheckForLumineCliUpdate({ options });
  }

  if (options.command === "admin") {
    await adminCommand(options);
    return;
  }

  if (options.command === "sponsor") {
    await sponsorCommand(options, {
      saveWorkspace: save,
      pullWorkspace: pullBuildFiles,
    });
    return;
  }

  if (options.command === "agent") {
    await agentCommand(options, { saveWorkspace: save });
    return;
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
  if (options.command === "rename") {
    await renameBuild(options);
    return;
  }
  if (options.command === "describe") {
    await describeBuild(options);
    return;
  }
  if (options.command === "upgrade") {
    await upgradeProject(options);
    return;
  }
  if (options.command === "projects") {
    await projects(options);
    return;
  }
  if (options.command === "branches") {
    await branches(options);
    return;
  }
  if (options.command === "forum") {
    await forum(options);
    return;
  }
  if (options.command === "suggest") {
    await sendSuggestion(options);
    return;
  }
  if (options.command === "suggestions") {
    await suggestions(options);
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

export async function renameBuild(options) {
  const title = String(options.title || "").trim();
  if (!title) {
    throw new Error(
      'Pass a title: `lumine rename "My New Build Title"` or `lumine rename --title "My New Build Title"`.',
    );
  }
  const { buildId, updatedBuild } = await updateOwnedBuildDetails({
    options,
    patch: { title },
    permissionError: (id) => `You cannot rename Build #${id}.`,
    failureMessage: "Failed to rename the Build.",
  });
  console.log(`Renamed Build #${buildId} to "${updatedBuild.title}".`);
}

export async function describeBuild(options) {
  const description = await resolveBuildDescriptionUpdate(options);
  const { updatedBuild } = await updateOwnedBuildDetails({
    options,
    patch: { description },
    permissionError: (id) => `You cannot update Build #${id}.`,
    failureMessage: "Failed to update the Build description.",
  });
  console.log(
    description
      ? `Updated description for ${formatBuildTitle(updatedBuild)}.`
      : `Cleared description for ${formatBuildTitle(updatedBuild)}.`,
  );
}

export async function upgradeProject(options) {
  if (options.positional?.length > 1) {
    throw new Error("Usage: lumine upgrade [twinkle-build-url-or-id]");
  }
  const explicitTarget = String(options.target || "").trim();
  const explicitBuildId = explicitTarget
    ? resolveRequiredBuildId(explicitTarget)
    : 0;
  if (
    explicitTarget &&
    (!Number.isSafeInteger(explicitBuildId) || explicitBuildId <= 0)
  ) {
    throw new Error("Pass a Twinkle build URL or positive integer build id.");
  }
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  // A branch URL already contains canonical Main's id. Let the server resolve
  // numeric branch build ids, but do not require private-project read access
  // merely to translate a reviewer-provided branch URL.
  const buildId = explicitTarget
    ? explicitBuildId
    : await resolveRequiredBuildIdOrSelected(options, auth);
  if (!Number.isSafeInteger(buildId) || buildId <= 0) {
    throw new Error("Pass a Twinkle build URL or positive integer build id.");
  }
  const result = await upgradeBuildProjectLimits({
    options,
    auth,
    buildId,
  });
  const upgradedBuild = result?.build;
  const canonicalBuildId = Number(upgradedBuild?.id || 0);
  const maxFilesPerProject = Number(
    upgradedBuild?.projectLimits?.maxFilesPerProject || 0,
  );
  const maxProjectBytes = Number(
    upgradedBuild?.projectLimits?.maxProjectBytes || 0,
  );
  if (
    result?.success !== true ||
    canonicalBuildId <= 0 ||
    maxFilesPerProject <= 0 ||
    maxProjectBytes <= 0
  ) {
    throw new Error("Twinkle did not return the upgraded project limits.");
  }
  const buildLabel = formatBuildTitle(upgradedBuild);
  const limitsLabel = `${maxFilesPerProject} project files and ${formatBytes(maxProjectBytes)}`;
  console.log(
    result.changed
      ? `Upgraded ${buildLabel} to ${limitsLabel}.`
      : `${buildLabel} already has ${limitsLabel}.`,
  );
}

async function updateOwnedBuildDetails({
  options,
  patch,
  permissionError,
  failureMessage,
}) {
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth, {
    localProject,
  });
  const currentBuild = await loadBuildMetadata({ options, auth, buildId });
  if (currentBuild.canWrite === false) {
    throw new Error(permissionError(buildId));
  }
  if (Number(currentBuild.contributionRootBuildId || 0) > 0) {
    throw new Error(
      "Contribution branches use the original Build details and cannot change them.",
    );
  }
  const result = await updateBuildMetadata({
    options,
    auth,
    buildId,
    patch,
  });
  if (result?.success !== true || !result?.build) {
    throw new Error(result?.error || failureMessage);
  }
  const updatedBuild = { ...currentBuild, ...result.build };
  await saveSelectedBuild({ options, auth, build: updatedBuild });
  if (
    localProject?.rootDir &&
    Number(localProject.metadata?.buildId || 0) === buildId &&
    !isReadOnlyProjectMetadata(localProject.metadata)
  ) {
    await writeProjectMetadata({
      dir: localProject.rootDir,
      options,
      build: updatedBuild,
      manifest: localProject.metadata.manifest || null,
      pulledAt: localProject.metadata.pulledAt || null,
      lastSavedAt: localProject.metadata.lastSavedAt || null,
      filesHash: localProject.metadata.filesHash || null,
    });
  }
  return { buildId, updatedBuild };
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

export async function branches(options) {
  const auth = await resolveAuth(options);
  const requestedBuildId = await resolveRequiredBuildIdOrSelected(
    options,
    auth,
  );
  const requestedBuild = await loadBuildMetadata({
    options,
    auth,
    buildId: requestedBuildId,
  });
  const rootBuildId =
    Number(requestedBuild.contributionRootBuildId || 0) ||
    Number(requestedBuild.id || 0);
  const rootBuild =
    rootBuildId === Number(requestedBuild.id || 0)
      ? requestedBuild
      : await loadBuildMetadata({ options, auth, buildId: rootBuildId });
  const result = await listContributionBranches({
    options,
    auth,
    buildId: rootBuildId,
    limit: options.limit,
  });
  printContributionBranches({ result, rootBuild, options });
}

export async function forum(options) {
  const explicitAction = ["read", "listen"].includes(
    String(options.positional?.[0] || ""),
  );
  const maximumPositionals = explicitAction ? 2 : 1;
  if ((options.positional?.length || 0) > maximumPositionals) {
    throw new Error(
      "Usage: lumine forum [read|listen] [twinkle-build-url-or-id]",
    );
  }
  if (options.forumCursor === null) {
    throw new Error("--cursor must be a non-negative integer.");
  }
  if (options.forumPollMs === null) {
    throw new Error("--poll-ms must be an integer from 1000 through 60000.");
  }
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:read" });
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  await runBuildForumCommand({ options, auth, buildId });
}

export async function sendSuggestion(options) {
  const suggestionType = String(options.suggestionAction || "").trim();
  if (suggestionType !== "branch" && suggestionType !== "thumbnail") {
    throw new Error(
      "Usage: lumine suggest branch [--note <message>] | lumine suggest thumbnail",
    );
  }
  const auth = await resolveAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const build = await loadTargetBuildMetadata({ options, auth });
  const { rootBuildId, contributionBuildId } =
    resolveContributionActionBuildIds(build);

  if (suggestionType === "branch") {
    await notifyBuildOwnerOfContribution({
      options,
      auth,
      rootBuildId,
      contributionBuildId,
      note: options.note,
    });
    console.log(
      `Sent branch #${contributionBuildId} to the owner of Build #${rootBuildId} for review.`,
    );
    return;
  }

  await suggestBuildThumbnailToOwner({
    options,
    auth,
    rootBuildId,
    contributionBuildId,
  });
  console.log(
    `Suggested branch #${contributionBuildId}'s thumbnail to the owner of Build #${rootBuildId}.`,
  );
}

export async function suggestions(options) {
  const auth = await resolveAuth(options);
  const rootBuildId = await resolveSuggestionRootBuildId(options, auth);
  const action = String(options.suggestionAction || "list");
  const requestedSuggestionId = Number(options.suggestionId || 0);
  if (
    action !== "list" &&
    (!Number.isSafeInteger(requestedSuggestionId) || requestedSuggestionId <= 0)
  ) {
    throw new Error(
      `Pass a suggestion ID: lumine suggestions ${action} <suggestion-id>`,
    );
  }
  const result = await listBuildSuggestions({
    options,
    auth,
    rootBuildId,
    cursor: action === "list" ? options.cursor : 0,
    suggestionId: action === "list" ? 0 : requestedSuggestionId,
  });
  const items = Array.isArray(result?.suggestions) ? result.suggestions : [];

  if (action === "list") {
    if (options.json) {
      console.log(
        JSON.stringify({
          buildId: rootBuildId,
          suggestions: items,
          hasMore: Boolean(result?.hasMore),
          nextCursor: Number(result?.nextCursor || 0) || null,
        }),
      );
      return;
    }
    printBuildSuggestions({
      rootBuildId,
      suggestions: items,
      hasMore: Boolean(result?.hasMore),
      nextCursor: Number(result?.nextCursor || 0),
    });
    return;
  }

  const suggestionId = requestedSuggestionId;
  const suggestion = items.find(
    (item) => Number(item?.id || 0) === suggestionId,
  );
  if (!suggestion) {
    throw new Error(
      `Open suggestion #${suggestionId} was not found for Build #${rootBuildId}. Run \`lumine suggestions --build ${rootBuildId}\` to refresh the inbox.`,
    );
  }
  await assertAuthScope({ options, auth, scope: "build:write" });
  const contributionBuildId = Number(suggestion.branchBuildId || 0);
  if (!contributionBuildId) {
    throw new Error(`Suggestion #${suggestionId} has no active branch.`);
  }

  if (action === "merge") {
    if (suggestion.type !== "branch") {
      throw new Error(
        `Suggestion #${suggestionId} is not a branch suggestion.`,
      );
    }
    const mergeResult = await mergeContributionIntoMain({
      options,
      auth,
      rootBuildId,
      contributionBuildId,
    });
    printContributionActionResult({
      action: "Merged",
      result: mergeResult,
      rootBuildId,
      contributionBuildId,
    });
    return;
  }

  if (action === "replace-main") {
    if (suggestion.type !== "branch") {
      throw new Error(
        `Suggestion #${suggestionId} is not a branch suggestion.`,
      );
    }
    const replaceResult = await replaceMainWithContribution({
      options,
      auth,
      rootBuildId,
      contributionBuildId,
    });
    printContributionActionResult({
      action: "Replaced main with",
      result: replaceResult,
      rootBuildId,
      contributionBuildId,
    });
    return;
  }

  if (action === "adopt-thumbnail") {
    if (suggestion.type !== "thumbnail") {
      throw new Error(
        `Suggestion #${suggestionId} is not a thumbnail suggestion.`,
      );
    }
    if (suggestion.currentThumbnailUrl && !options.assumeYes) {
      const confirmed = await confirmPrompt(
        `Replace Build #${rootBuildId}'s thumbnail with suggestion #${suggestionId}? [y/N] `,
      );
      if (confirmed === null) {
        console.log("Not a TTY — re-run with --yes to replace the thumbnail.");
        return;
      }
      if (!confirmed) {
        console.log("Aborted. Thumbnail unchanged.");
        return;
      }
    }
    const adoptResult = await adoptBuildThumbnailSuggestion({
      options,
      auth,
      rootBuildId,
      contributionBuildId,
      suggestionMessageId: suggestionId,
      thumbnailUrl: suggestion.suggestedThumbnailUrl,
    });
    const canonicalThumbnailUrl = String(
      adoptResult?.build?.thumbnailUrl || "",
    );
    console.log(
      `Applied thumbnail suggestion #${suggestionId} to Build #${rootBuildId}.`,
    );
    if (canonicalThumbnailUrl) console.log(`  ${canonicalThumbnailUrl}`);
    return;
  }

  throw new Error(
    "Usage: lumine suggestions [build] | lumine suggestions merge|replace-main|adopt-thumbnail <suggestion-id> [--build <id>]",
  );
}

async function resolveSuggestionRootBuildId(options, auth) {
  const requestedBuildId = options.buildIdFlag
    ? resolveRequiredBuildId(options.buildIdFlag)
    : await resolveRequiredBuildIdOrSelected(options, auth);
  const build = await loadBuildMetadata({
    options,
    auth,
    buildId: requestedBuildId,
  });
  return Number(build?.contributionRootBuildId || 0) || Number(build?.id || 0);
}

export function printBuildSuggestions({
  rootBuildId,
  suggestions,
  hasMore = false,
  nextCursor = 0,
}) {
  console.log(`Open suggestions for Build #${rootBuildId}:`);
  if (!suggestions.length) {
    console.log(
      hasMore
        ? "No open branch or thumbnail suggestions on this page."
        : "No open branch or thumbnail suggestions.",
    );
    if (hasMore && nextCursor > 0) {
      console.log(
        `Next page: lumine suggestions --build ${rootBuildId} --cursor ${nextCursor}`,
      );
    }
    return;
  }
  for (const suggestion of suggestions) {
    const suggestionId = Number(suggestion.id || 0);
    const branchNumber = Number(suggestion.branchNumber || 0);
    const branchLabel = branchNumber
      ? `branch ${branchNumber}`
      : `branch #${suggestion.branchBuildId}`;
    const contributor = suggestion.contributorUsername || "a contributor";
    const createdAt = formatVersionTimestamp(suggestion.createdAt);
    if (suggestion.type === "branch") {
      console.log(
        `[#${suggestionId}] ${contributor} submitted ${branchLabel} (${createdAt})`,
      );
      if (suggestion.note) console.log(`  ${suggestion.note}`);
      const summary = suggestion.diffSummary || {};
      console.log(
        `  files: ${Number(summary.total || suggestion.changedFiles?.length || 0)} changed`,
      );
      if (suggestion.hasNewerWorkSinceSubmission) {
        console.log("  note: the branch changed after this suggestion");
      }
      console.log(
        `  merge: lumine suggestions merge ${suggestionId} --build ${rootBuildId}`,
      );
      console.log(
        `  replace: lumine suggestions replace-main ${suggestionId} --build ${rootBuildId}`,
      );
      continue;
    }
    console.log(
      `[#${suggestionId}] ${contributor} suggested a thumbnail from ${branchLabel} (${createdAt})`,
    );
    console.log(`  ${suggestion.suggestedThumbnailUrl}`);
    if (suggestion.hasNewerThumbnailSinceSuggestion) {
      console.log("  note: the branch has a newer thumbnail now");
    }
    console.log(
      `  apply: lumine suggestions adopt-thumbnail ${suggestionId} --build ${rootBuildId}`,
    );
  }
  if (hasMore && nextCursor > 0) {
    console.log(
      `Next page: lumine suggestions --build ${rootBuildId} --cursor ${nextCursor}`,
    );
  }
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
  let baseFilesHash = null;
  if (Number(localProject?.metadata?.buildId || 0) === contributionBuildId) {
    dir = resolveProjectDirForSave({ options, localProject });
    projectFiles = await collectProjectFiles(dir);
    baseFilesHash =
      typeof localProject?.metadata?.filesHash === "string" &&
      localProject.metadata.filesHash.trim()
        ? localProject.metadata.filesHash.trim()
        : null;
    if (!baseFilesHash) {
      throw new Error(
        "This branch workspace has no verified server file base. Run `lumine pull` before `lumine update-from-main` so local edits cannot overwrite newer branch work.",
      );
    }
  }
  let result;
  try {
    result = await requestJson({
      method: "POST",
      url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/update-from-main`,
      authToken: auth.token,
      body: projectFiles ? { projectFiles, baseFilesHash } : {},
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error?.data?.code === "build_project_files_stale") {
      throw new Error(
        [
          "Update from main rejected: this branch changed on the server after the workspace was loaded.",
          "Run `lumine pull` to load the canonical branch first, then reapply the backed-up local edits and retry.",
        ].join("\n"),
      );
    }
    throw error;
  }
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
    const returnedContribution =
      Number(result?.contribution?.id || 0) === contributionBuildId
        ? result.contribution
        : null;
    // The sync response has already committed these files and their hash. A
    // transient follow-up metadata failure must not leave the workspace with
    // its pre-merge base hash, or its next legitimate save will be rejected.
    // Preserve CLI permission fields from the confirmed pre-sync load when
    // falling back to the canonical contribution returned by the mutation.
    const metadataBuild = refreshed || {
      ...build,
      ...(returnedContribution || {}),
      id: contributionBuildId,
    };
    await writeProjectMetadata({
      dir,
      options,
      build: metadataBuild,
      manifest: localProject?.metadata?.manifest || null,
      pulledAt: new Date().toISOString(),
      filesHash: typeof result.filesHash === "string" ? result.filesHash : null,
    });
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
  assertProjectFilesWithinLimits(files, build?.projectLimits);
  // Only claim a base snapshot when this workspace was pulled from the same
  // build we are saving to. Missing filesHash used to mean "unguarded save",
  // which let stale checkouts silently rewind newer server versions — refuse
  // that path unless --force is explicit.
  const metadataBuildId = Number(localProject?.metadata?.buildId || 0);
  const metadataFilesHash =
    typeof localProject?.metadata?.filesHash === "string" &&
    localProject.metadata.filesHash.trim()
      ? localProject.metadata.filesHash.trim()
      : null;
  const baseFilesHash =
    !options.force && metadataBuildId === Number(buildId) && metadataFilesHash
      ? metadataFilesHash
      : null;
  if (!options.force && !baseFilesHash) {
    throw new Error(
      [
        "Save refused: this workspace has no filesHash (server snapshot token).",
        "That usually means an old or stale checkout that never recorded what",
        "it was based on — saving it would overwrite the server without a guard.",
        "Run `lumine pull` to sync with the server (local edits are preserved),",
        "then save again. To intentionally overwrite the server with these",
        "local files, re-run with --force.",
      ].join("\n"),
    );
  }
  if (options.force && !baseFilesHash) {
    console.error(
      "lumine: warning — saving with --force and no filesHash; this overwrites the server project with local files and skips the stale-workspace guard.",
    );
  }
  let result;
  try {
    result = await saveProjectFiles({
      options,
      auth,
      buildId,
      files,
      summary: options.summary || DEFAULT_SAVE_SUMMARY,
      baseFilesHash,
      force: Boolean(options.force),
    });
  } catch (error) {
    if (error?.data?.code === "build_project_files_stale") {
      throw new Error(
        [
          "Save rejected: the project changed on the server since this workspace was pulled",
          "(for example a merged branch or a save from another session).",
          "Run `lumine pull` to sync the canonical server files first,",
          "or re-run with --force to overwrite the server's current files anyway.",
        ].join("\n"),
      );
    }
    if (error?.data?.code === "build_project_files_base_required") {
      throw new Error(
        [
          "Save rejected: the server requires a filesHash base for this project",
          "(non-empty projects cannot be saved from a workspace that never",
          "recorded its server snapshot).",
          "Run `lumine pull` to establish a base, then save again,",
          "or re-run with --force to overwrite deliberately.",
        ].join("\n"),
      );
    }
    throw error;
  }
  build = result.build ? { ...build, ...result.build } : build;
  if (result.copilotPolicy?.limits) {
    build = {
      ...build,
      projectLimits: {
        maxProjectBytes: result.copilotPolicy.limits.maxProjectBytes,
        maxFilesPerProject: result.copilotPolicy.limits.maxFilesPerProject,
        maxFileLines: result.copilotPolicy.limits.maxFileLines,
      },
    };
  }
  if (!build) {
    build = (await loadBuildMetadata({ options, auth, buildId }).catch(
      () => null,
    )) || {
      id: buildId,
      title: `Build ${buildId}`,
    };
  }
  await saveSelectedBuild({ options, auth, build });
  await writeProjectMetadata({
    dir,
    options,
    build,
    manifest: result.projectManifest || null,
    lastSavedAt: new Date().toISOString(),
    filesHash: typeof result.filesHash === "string" ? result.filesHash : null,
  });
  if (!options.quiet) {
    printSaveResult({
      result,
      build,
      dir,
      files,
      publishRequested: Boolean(options.publish),
    });
  }

  if (options.publish) {
    if (build?.canPublish === false) {
      console.log(
        "Saved to your branch. The project owner can merge or replace main from Twinkle.",
      );
      return result;
    }
    const publish = await publishBuild({ options, buildId, auth });
    if (publish.skipped) {
      console.log("Publish skipped: already up to date.");
    } else {
      console.log("Publish complete.");
    }
    console.log(
      `Release status: ${publish.build?.releaseStatus?.state || "unknown"}`,
    );
    console.log(`App: ${options.siteUrl}/app/${buildId}`);
  }
  return result;
}

export async function check(options) {
  const auth = await resolveAuth(options);
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  const canonicalBuild = await loadBuildMetadata({ options, auth, buildId });
  await reportLocalProjectFindings(options, canonicalBuild?.projectLimits);
  const result = await requestJson({
    url: `${options.apiUrl}/cli/build/${buildId}/launch-check`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  printCheck(result);
  if (!result.ok) process.exitCode = 1;
}

// Local half of `lumine check`: validate the workspace against the canonical
// project limits fetched by check(), so a newly approved allowance works
// immediately without requiring another pull just to refresh local metadata.
export async function reportLocalProjectFindings(
  options,
  canonicalProjectLimits,
) {
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
  const { errors, warnings } = collectProjectLimitFindings(
    files,
    canonicalProjectLimits || localProject?.metadata?.build?.projectLimits,
  );
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

export async function resolveBuildForSave({
  options,
  auth,
  buildId,
  localProject,
}) {
  const localBuild = localProject?.metadata?.build;
  const localBuildId =
    Number(localBuild?.id || 0) || Number(localProject?.metadata?.buildId || 0);
  // Save is already an online operation. Refresh the server-owned Build
  // metadata before enforcing permissions and project limits so a newly
  // approved Main allowance (inherited by branches) works without re-pulling.
  const canonicalBuild = await loadBuildMetadata({ options, auth, buildId });
  const build =
    localBuild && localBuildId === Number(buildId)
      ? { ...localBuild, ...canonicalBuild, id: buildId }
      : canonicalBuild;
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

export async function ensureDefaultContributionBranch({
  options,
  auth,
  build,
}) {
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
    projectLimits: branch?.projectLimits || sourceBuild?.projectLimits || null,
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
  // Preserve local work BEFORE server files land: pull is the recommended
  // stale-save recovery step, and the edits that triggered the rejection are
  // usually in files the server snapshot also contains — writing first would
  // destroy them. Extras (paths not in the snapshot) are moved out so the
  // pulled hash's claim that this workspace matches the server stays true;
  // modified tracked files are copied so the pre-pull content stays
  // recoverable after the overwrite.
  const { movedPaths, backedUpPaths } = await stashLocalProjectFilesBeforePull({
    dir,
    files,
  });
  await writeProjectFiles({ dir, files });
  const stashDirLabel = path.join(PROJECT_METADATA_DIR, "removed");
  if (!options.quiet && movedPaths.length > 0) {
    console.log(
      `Moved ${movedPaths.length} local file${movedPaths.length === 1 ? "" : "s"} not in the server project to ${stashDirLabel}/: ${movedPaths.join(", ")}`,
    );
  }
  if (!options.quiet && backedUpPaths.length > 0) {
    console.log(
      `Backed up ${backedUpPaths.length} locally modified file${backedUpPaths.length === 1 ? "" : "s"} to ${stashDirLabel}/ before overwriting with the server version: ${backedUpPaths.join(", ")}`,
    );
  }
  await writeAgentInstructions({ dir });
  await writeSdkReference({ dir });
  await writeProjectMetadata({
    dir,
    options,
    build,
    manifest: result.projectManifest || null,
    pulledAt: new Date().toISOString(),
    filesHash: typeof result.filesHash === "string" ? result.filesHash : null,
  });
  // Best-effort asset manifest so terminal agents know what media already
  // exists (the workspace UI gives Lumine the same context). Never fail the
  // pull over it.
  let assetCount = null;
  if (!options.skipAssetManifest) {
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
  const rootBuild = result.build || {
    id: rootBuildId,
    title: `Build ${rootBuildId}`,
  };
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
          ? path.join(
              path.dirname(enclosing.rootDir),
              defaultMainCheckoutDir(rootBuild),
            )
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
  console.log(
    `Pulled ${files.length} file${files.length === 1 ? "" : "s"} to ${dir}`,
  );
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
  console.log(`Previous saves for ${formatBuildTitle(build)} (newest first):`);
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
    console.log(
      "No project files yet. Create /index.html before your first save.",
    );
  }
  console.log('Codex: codex "Read AGENTS.md, then make the requested change."');
  console.log(
    'Claude Code: claude "Read CLAUDE.md, then make the requested change."',
  );
  console.log('Save after edits: lumine save --summary "Describe the change"');
  if (isContributionBranch(build) && build.canPublish === false) {
    console.log(
      'Notify the owner when ready: lumine suggest branch "Ready for review"',
    );
    console.log("Offer this branch's thumbnail: lumine suggest thumbnail");
  } else {
    console.log("Run `lumine check` or `lumine launch --save` when ready.");
    console.log("Review team nudges: lumine suggestions");
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

export function printSaveResult({
  result,
  build,
  dir,
  files,
  publishRequested = false,
}) {
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
  const willPublish = publishRequested && build?.canPublish !== false;
  if (!willPublish) console.log(`Release status: ${releaseState}`);
  if (isContributionBranch(build) && build.canPublish === false) {
    console.log(
      'Next: notify the project owner with `lumine suggest branch "Ready for review"`.',
    );
    console.log(
      "To offer this branch's thumbnail, run `lumine suggest thumbnail`.",
    );
  } else if (!willPublish) {
    console.log(
      "Next: run `lumine launch` to publish, or `lumine save --publish` next time.",
    );
    console.log("Team suggestions: run `lumine suggestions` to review them.");
  }
}

export function printContributionDiff({ result, build }) {
  const summary = result.diff?.summary || {};
  const files = Array.isArray(result.diff?.changedFiles)
    ? result.diff.changedFiles
    : [];
  const branchNumber = Number(build.contributionBranchNumber || 0) || 0;
  const branchLabel = branchNumber
    ? `branch ${branchNumber}`
    : `branch #${build.id}`;
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

export function printContributionBranches({ result, rootBuild, options }) {
  const contributions = Array.isArray(result?.contributions)
    ? result.contributions
    : [];
  console.log(`Branches for ${formatBuildTitle(rootBuild)}:`);
  if (!contributions.length) {
    console.log("No contribution branches.");
    return;
  }
  for (const [index, contribution] of contributions.entries()) {
    const branchNumber = Number(contribution.contributionBranchNumber || 0);
    const branchLabel = branchNumber
      ? `branch ${branchNumber}`
      : `branch #${contribution.id}`;
    const title = String(contribution.title || "Untitled branch").trim();
    const contributor = String(contribution.username || "unknown").trim();
    const status = String(contribution.contributionStatus || "draft").trim();
    console.log(
      `${index + 1}. ${title} - ${contributor} - ${branchLabel} (${status})`,
    );
    if (branchNumber) {
      console.log(
        `   ${options.siteUrl}/build/${Number(rootBuild.id)}/${branchNumber}`,
      );
    }
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
  console.log(
    `${action} branch #${contributionBuildId} for Build #${rootBuildId}.`,
  );
  if (projectFiles.length > 0) {
    console.log(
      `Main now has ${projectFiles.length} project file${projectFiles.length === 1 ? "" : "s"}.`,
    );
  }
  if (result.mergeConflictsWritten || result.conflicts?.length > 0) {
    console.log(
      "Merge wrote conflict markers. Resolve them in the Build workspace.",
    );
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
    "force",
    "noUpdateCheck",
    "allowWrite",
    "main",
    "yes",
    "json",
    "keepAssets",
    "noBrowser",
    "includeComments",
    "anyoneCanReward",
    "full",
    "unviewed",
    "viewed",
    "all",
    "resume",
    "sinceRun",
    "includeLegacy",
    "includePrivateEvidence",
    "noReviewLoop",
    "acceptAgreement",
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
      const nextValue = rest[i + 1];
      if (
        nextValue === undefined ||
        nextValue === "-h" ||
        nextValue.startsWith("--")
      ) {
        throw new Error(`Missing value for --${key}.`);
      }
      raw[camelKey] = nextValue;
      i += 1;
    }
  }

  const suggestionInboxActions = new Set([
    "list",
    "merge",
    "replace-main",
    "adopt-thumbnail",
  ]);
  const suggestionAction =
    command === "suggest"
      ? String(positional[0] || "")
      : command === "suggestions" &&
          suggestionInboxActions.has(String(positional[0] || ""))
        ? String(positional[0])
        : "list";
  const suggestionListTarget =
    command === "suggestions" && suggestionAction === "list"
      ? String(
          positional[0] === "list" ? positional[1] || "" : positional[0] || "",
        )
      : "";
  const forumAction =
    command === "forum" && ["read", "listen"].includes(positional[0])
      ? String(positional[0])
      : "read";
  const forumTarget =
    command === "forum"
      ? String(
          forumAction === "read" && positional[0] !== "read"
            ? positional[0] || ""
            : positional[1] || "",
        )
      : "";
  const forumCursor = Object.prototype.hasOwnProperty.call(raw, "cursor")
    ? /^\d+$/.test(String(raw.cursor).trim()) &&
      Number.isSafeInteger(Number(raw.cursor))
      ? Number(raw.cursor)
      : null
    : 0;
  const forumPollMs = Object.prototype.hasOwnProperty.call(raw, "pollMs")
    ? /^\d+$/.test(String(raw.pollMs).trim()) &&
      Number.isSafeInteger(Number(raw.pollMs)) &&
      Number(raw.pollMs) >= 1000 &&
      Number(raw.pollMs) <= 60_000
      ? Number(raw.pollMs)
      : null
    : 3000;

  return {
    command,
    positional,
    forumAction,
    forumCursor,
    forumPollMs,
    suggestionAction,
    suggestionId:
      command === "suggestions" && suggestionAction !== "list"
        ? String(positional[1] || "")
        : "",
    note:
      String(
        raw.note ||
          (command === "suggest" && suggestionAction === "branch"
            ? positional.slice(1).join(" ")
            : ""),
      ).trim() || "",
    cursor: Math.max(0, Math.floor(Number(raw.cursor) || 0)),
    adminCursor: raw.cursor ? String(raw.cursor) : "",
    adminAfter: raw.after ? String(raw.after) : "",
    adminSinceRun: Boolean(raw.sinceRun),
    adminIncludeLegacy: Boolean(raw.includeLegacy),
    adminIncludePrivateEvidence: parseBoolean(
      raw.includePrivateEvidence,
      false,
    ),
    adminAll: Boolean(raw.all),
    adminResume: Boolean(raw.resume),
    adminCheckpoint: raw.checkpoint ? String(raw.checkpoint) : "",
    adminOutput: raw.output ? String(raw.output) : "",
    adminOutputDir: raw.outputDir ? String(raw.outputDir) : "",
    adminClaimFile: raw.claim ? String(raw.claim) : "",
    adminScaffoldFile: raw.scaffold ? String(raw.scaffold) : "",
    adminTargetFile: raw.targetFile ? String(raw.targetFile) : "",
    adminReviewReceipt: raw.reviewReceipt ? String(raw.reviewReceipt) : "",
    adminReviewContext: raw.reviewContext ? String(raw.reviewContext) : "",
    adminSeverity: raw.severity ? String(raw.severity) : "",
    adminStatus: raw.status ? String(raw.status) : "",
    adminDecision: raw.decision ? String(raw.decision) : "",
    adminWaitMs: raw.waitMs ? String(raw.waitMs) : "",
    adminBrowserPath: raw.browserPath ? String(raw.browserPath) : "",
    adminEffort: raw.effort ? String(raw.effort) : "",
    agentEffort: command === "agent" && raw.effort ? String(raw.effort) : "",
    sponsorArgs: command === "sponsor" ? positional : [],
    sponsorMotivation: raw.motivation ? String(raw.motivation) : "",
    sponsorAvailability: raw.availability ? String(raw.availability) : "",
    sponsorProviders: raw.providers
      ? String(raw.providers)
      : raw.provider
        ? String(raw.provider)
        : "",
    sponsorCapabilityNotes: raw.capabilityNotes
      ? String(raw.capabilityNotes)
      : "",
    sponsorAcceptAgreement: Boolean(raw.acceptAgreement),
    sponsorPersona: raw.persona ? String(raw.persona) : "",
    sponsorConcurrency: raw.concurrency,
    sponsorHelpers: raw.helpers,
    sponsorDailyLimit: raw.dailyLimit,
    sponsorWeeklyLimit: raw.weeklyLimit,
    sponsorEffort: raw.effort ? String(raw.effort) : "",
    sponsorServiceTier: raw.serviceTier ? String(raw.serviceTier) : "",
    sponsorWaitMs: raw.waitMs ? String(raw.waitMs) : "",
    sponsorAgentOrdinal: raw.ordinal,
    sponsorOutcome: raw.outcome ? String(raw.outcome) : "",
    sponsorFailureReason: raw.reason ? String(raw.reason) : "",
    sponsorUpdateFile: raw.file ? String(raw.file) : "",
    sponsorUpdatePhase: raw.phase ? String(raw.phase) : "",
    sponsorResolvedModel: raw.resolvedModel
      ? String(raw.resolvedModel)
      : "",
    sponsorResolvedEffort: raw.resolvedEffort
      ? String(raw.resolvedEffort)
      : "",
    sponsorResolvedServiceTier: raw.resolvedServiceTier
      ? String(raw.resolvedServiceTier)
      : "",
    sponsorPollMs: raw.pollMs
      ? Math.min(Math.max(Number(raw.pollMs) || 0, 1_000), 60_000)
      : 3_000,
    provider: raw.provider ? String(raw.provider) : "",
    providerPath: raw.providerPath ? String(raw.providerPath) : "",
    agentPrompt:
      command === "agent"
        ? String(raw.prompt || positional.join(" ")).trim()
        : "",
    runtimeFile: raw.runtimeFile ? String(raw.runtimeFile) : "",
    traceFile: raw.traceFile ? String(raw.traceFile) : "",
    baseFilesHash: raw.baseFilesHash ? String(raw.baseFilesHash) : "",
    reviewLoop: parseBoolean(raw.noReviewLoop, false) ? false : true,
    adminLevel: raw.level ? String(raw.level) : "",
    adminIds: raw.subjectIds
      ? String(raw.subjectIds)
      : raw.ids
        ? String(raw.ids)
        : "",
    adminBucketId: raw.bucketId ? String(raw.bucketId) : "",
    adminLabel: raw.label ? String(raw.label) : "",
    adminUserIds: raw.userIds ? String(raw.userIds) : "",
    adminType: raw.type ? String(raw.type) : "",
    adminKind: raw.kind ? String(raw.kind) : "",
    adminContentTypes: raw.contentTypes ? String(raw.contentTypes) : "",
    adminUnviewed: Boolean(raw.unviewed),
    adminViewed: Boolean(raw.viewed),
    adminIdentity: raw.identity ? String(raw.identity) : "",
    commentMode: raw.commentMode ? String(raw.commentMode) : "",
    runKey: raw.runKey ? String(raw.runKey) : "",
    idempotencyKey: raw.idempotencyKey ? String(raw.idempotencyKey) : "",
    draftId: raw.draftId ? String(raw.draftId) : "",
    twinkles: raw.twinkles ? String(raw.twinkles) : "",
    adminReason: raw.reason ? String(raw.reason) : "",
    adminRun: raw.run ? String(raw.run) : "",
    adminTarget: raw.target ? String(raw.target) : "",
    adminActions: raw.actions ? String(raw.actions) : "",
    adminDate: raw.date ? String(raw.date) : "",
    adminDays: raw.days ? String(raw.days) : "",
    adminEditionId: raw.editionId ? String(raw.editionId) : "",
    adminLeaseToken: raw.leaseToken ? String(raw.leaseToken) : "",
    adminFile: raw.file ? String(raw.file) : "",
    adminReviewedBuildVersion: raw.reviewedVersion
      ? String(raw.reviewedVersion)
      : "",
    adminBuildReviewMethod: raw.reviewedVia ? String(raw.reviewedVia) : "",
    adminFull: parseBoolean(raw.full, false),
    rewardTwinkles: raw.rewardTwinkles ? String(raw.rewardTwinkles) : "",
    includeComments: parseBoolean(raw.includeComments, false),
    anyoneCanReward: parseBoolean(raw.anyoneCanReward, false),
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
    target:
      raw.url ||
      raw.target ||
      (command === "rename" || command === "describe" || command === "suggest"
        ? ""
        : command === "suggestions"
          ? suggestionListTarget
          : command === "forum"
            ? forumTarget
            : positional[0] || ""),
    title:
      String(
        raw.title ||
          (command === "new" || command === "rename"
            ? positional.join(" ")
            : ""),
      ).trim() || "",
    description: Object.prototype.hasOwnProperty.call(raw, "description")
      ? String(raw.description || "").trim()
      : command === "describe" && positional.length > 0
        ? positional.join(" ").trim()
        : null,
    descriptionProvided:
      Object.prototype.hasOwnProperty.call(raw, "description") ||
      (command === "describe" && positional.length > 0),
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
    force: parseBoolean(raw.force, false),
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
    throw new Error(
      'Pass a title: `lumine new "My Build"` or `lumine new --title "My Build"`.',
    );
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

export async function resolveBuildDescriptionUpdate(options) {
  if (options.noDescription && options.descriptionProvided) {
    throw new Error(
      "Pass either a description or `--no-description`, not both.",
    );
  }
  if (options.noDescription) return null;
  if (options.descriptionProvided) {
    return String(options.description || "").trim() || null;
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      'Pass a description: `lumine describe "What this app does"`, or clear it with `lumine describe --no-description`.',
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Build description (leave blank to clear): ",
    );
    return String(answer || "").trim() || null;
  } finally {
    rl.close();
  }
}

export async function resolveBuildReferenceBuildId({
  options,
  auth,
  reference,
}) {
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
  lumine agent --provider <codex|claude-code> "<build request>"
  lumine sponsor agreement|apply|status|withdraw
  lumine sponsor capacity [--concurrency <n>] [--helpers <n>] [--daily-limit <n>] [--weekly-limit <n>]
  lumine sponsor duty start [--provider <codex|claude-code>] --model <name> --effort <level> [--service-tier <tier>]
  lumine sponsor duty watch [--wait-ms <ms>] [--json]
  lumine sponsor duty pause|resume|stop
  lumine sponsor job status|pulse|begin <job-id>
  lumine sponsor job update <job-id> --file <path> [--phase <name>]
  lumine sponsor job relay-applied <job-id> <relay-id...>
  lumine sponsor job helper-start|helper-complete <job-id> [options]
  lumine sponsor job complete <job-id> --summary <text>
  lumine sponsor job fail <job-id> --reason <text>
  lumine sponsor jobs
  lumine app-mcp <published-app-url-or-id> [--no-open]
  lumine new [title]
  lumine rename [title] [--target <twinkle-build-url-or-id>]
  lumine describe [description] [--target <twinkle-build-url-or-id>]
  lumine upgrade [twinkle-build-url-or-id]
  lumine projects
  lumine branches [twinkle-build-url-or-id] [--limit <n>]
  lumine forum [read] [twinkle-build-url-or-id] [--cursor <sequence>] [--json]
  lumine forum listen [twinkle-build-url-or-id] [--cursor <sequence>] [--poll-ms <ms>] [--json]
  lumine suggest branch [message] [--target <twinkle-branch-url>]
  lumine suggest thumbnail [--target <twinkle-branch-url>]
  lumine suggestions [twinkle-build-url-or-id]
  lumine suggestions merge <suggestion-id> [--build <id>]
  lumine suggestions replace-main <suggestion-id> [--build <id>]
  lumine suggestions adopt-thumbnail <suggestion-id> [--build <id>] [--yes]
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
  lumine admin identity list|status|use <zero|ciel|auto> [--json]
  lumine admin identity inspect <user-id|username> --reason <management-reason> [--include-private-evidence] [--json]
  lumine admin economy trace <user-id|username> --reason <management-reason> [--days <1..30>] [--json]
  lumine admin rescue wordle-audit --reason <management-reason> [--days <1..30>] [--json]
  lumine admin ai-bucket create --label <name> --note <text> [--json]
  lumine admin ai-bucket get --bucket-id <id> [--json]
  lumine admin ai-bucket accounts add --bucket-id <id> --user-ids <id,id,...> [--note <text>] [--json]
  lumine admin ai-bucket note set --bucket-id <id> --note <text> [--json]
  lumine admin daily-run start [--identity zero|ciel|auto] [--comment-mode off|draft|post] [--run-key <key>] [--json]
  lumine admin daily-run status|report|complete|fail [--reason <text>] [--json]
  lumine admin daily-run escalation add --target <target> --note <summary> [--severity attention|urgent] [--json]
  lumine admin escalation list [--status open|acknowledged|resolved|all] [--limit <number>] [--json]
  lumine admin escalation set <audit-id> --status open|acknowledged|resolved --note <decision> [--json]
  lumine admin todo list [--status pending|open|in_progress|blocked|completed|cancelled|all] [--limit <number>] [--json]
  lumine admin todo add --title <title> --note <handoff-and-acceptance-criteria> [--kind task|experiment] [--status open|in_progress|blocked] [--json]
  lumine admin todo update <todo-id> --status open|in_progress|blocked|completed|cancelled --note <progress-or-evidence> [--json]
  lumine admin sponsor applications list [--status pending|approved|rejected|withdrawn] [--json]
  lumine admin sponsor applications review <application-id> --decision approve|reject [--note <text>] [--json]
  lumine admin sponsor status set <user-id> --status probationary|trusted|suspended|revoked [--note <text>] [--json]
  lumine admin sponsor integrity status|scan [--json]
  lumine admin sponsor integrity cases [--status open|pending|held|flagged|cleared|disqualified] [--json]
  lumine admin sponsor integrity get <case-id> [--json]
  lumine admin sponsor integrity review <case-id> --decision clear|hold|flag|disqualify [--note <evidence>] [--json]
  lumine admin recommendations list [--since-run|--after <date>|--include-legacy] [--all --checkpoint <file> [--resume]] [--content-types comment,dailyReflection] [--unviewed|--viewed] [--cursor <cursor>] [--json]
  lumine admin builds candidates [--all --checkpoint <file> [--resume]] [--cursor <cursor>] [--limit <number>] [--json]
  lumine admin builds review <build-url-or-id> [--output-dir <dir>] [--wait-ms <ms>] [--browser-path <path>] [--json]
  lumine admin subjects candidates [--after <date>] [--effort unassigned] [--unviewed|--viewed] [--all --checkpoint <file> [--resume]] [--cursor <cursor>] [--json]
  lumine admin subject get|reveal <subject-url-or-id> [--json]
  lumine admin subject comments <subject-url-or-id> [--unviewed|--viewed] [--all --checkpoint <file> [--resume]] [--cursor <cursor>] [--json]
  lumine admin subject effort set <subject-id> --level <1|2|3> [--json]
  lumine admin subject creator set-made-by-poster <subject-id> [--json]
  lumine admin subject feature|unfeature <subject-id> [--json]
  lumine admin featured list [--unviewed|--viewed] [--json]
  lumine admin featured reorder --subject-ids <id,id,...> [--json]
  lumine admin post get <target> [--type subject|comment|aiStory|dailyReflection] [--json]
  lumine admin post comments <target> [--type subject|aiStory|dailyReflection] [--unviewed|--viewed] [--all --checkpoint <file> [--resume]] [--cursor <cursor>] [--json]
  lumine admin post recommend <target> [--type subject|comment|aiStory|dailyReflection] [--anyone-can-reward] [--reward-twinkles 3] [--json]
  lumine admin post skip <target> [--type comment|aiStory|dailyReflection] [--reason <text>] [--json]
  lumine admin post skip-batch --target-file <json-or-lines> [--reason <text>] [--checkpoint <file> [--resume]] [--json]
  lumine admin post reward <target> [--type subject|comment|aiStory|dailyReflection] --twinkles 3 [--json]
  lumine admin comment draft <target> [--type subject|comment|build|aiStory|dailyReflection] [--file <comment.md>] [--review-receipt <review.json>|--reviewed-version <id> --reviewed-via runtime|code] [--review-context <context.json>] [--identity zero|ciel|auto] [--json]
  lumine admin comment reply comment:<id> [--file <reply.md>] [--reviewed-version <id> --reviewed-via runtime|code] [--review-context <context.json>] [--identity zero|ciel|auto] [--json]
  lumine admin comment post --draft-id <id> [--json]
  lumine admin comment edit <comment-id> --file <comment.md> [--json]
  lumine admin brief [--days <1..30>] [--json]
  lumine admin ai-costs monthly [--json]
  lumine admin media-costs monthly [--json]
  lumine admin bot-output [--days <1..30>|--cursor <cursor>] [--json]
  lumine admin announcement post --file <announcement.md> [--json]
  lumine admin chat send <user-id|username> --file <message.md> [--json]
  lumine admin news claim [--date YYYY-MM-DD] [--output <claim.json>] [--scaffold <editorial.json>] [--json]
  lumine admin news validate --claim <claim.json> --file <editorial.json> [--json]
  lumine admin news submit --claim <claim.json> --file <editorial.json> [--model <name>] [--json]
  lumine admin notable add <user-id|username> --note <text> [--json]
  lumine admin audit [list] [--run current|last|<run-id>] [--target <target>] [--actions <a,b>] [--full] [--all --checkpoint <file> [--resume]] [--cursor <cursor>] [--json]

Examples:
  npx @stage5/lumine@latest
  npx @stage5/lumine@latest login
  npx @stage5/lumine@latest new "Daily Reflection App"
  npx @stage5/lumine@latest rename "My New Build Title"
  npx @stage5/lumine@latest rename "New Title" --target 123
  npx @stage5/lumine@latest describe "A welcoming place to build together"
  npx @stage5/lumine@latest describe --no-description --target 123
  npx @stage5/lumine@latest upgrade https://www.twin-kle.com/app/123
  npx @stage5/lumine@latest new --title "Daily Reflection App" --description "Private journal with streaks"
  npx @stage5/lumine@latest branches 884
  npx @stage5/lumine@latest forum 884 --json
  npx @stage5/lumine@latest forum listen --json
  npx @stage5/lumine@latest suggest branch "Ready for review"
  npx @stage5/lumine@latest suggest thumbnail
  npx @stage5/lumine@latest suggestions 884
  npx @stage5/lumine@latest suggestions merge 12345 --build 884
  npx @stage5/lumine@latest suggestions adopt-thumbnail 12346 --build 884 --yes
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
  npx @stage5/lumine@latest agent --provider codex "Add keyboard controls"
  npx @stage5/lumine@latest agent --provider claude-code "Fix the mobile layout"
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
  npx @stage5/lumine@latest admin daily-run start --identity auto --comment-mode off --json
  npx @stage5/lumine@latest admin recommendations list --json
  npx @stage5/lumine@latest admin subjects candidates --effort unassigned --json
  npx @stage5/lumine@latest admin subject get 123 --include-comments --json
  npx @stage5/lumine@latest admin post recommend comment:456 --anyone-can-reward --reward-twinkles 3 --json

Options:
  --api-url <url>       Twinkle API origin
  --site-url <url>      Twinkle website origin
  --preview-url <url>   Twinkle Build preview origin
  --auth-file <path>    Saved login path
  --auth-token <token>  Override saved login
  --dir <path>          Directory for pulled project files
  --provider <agent>    Subscription agent for lumine agent: codex or claude-code
  --provider-path <p>   Override the selected agent CLI executable
  --effort <level>      Optional provider reasoning effort
  --no-review-loop      Skip the evidence-based post-run loop retrospective
  --target <build>      Explicit Build URL or ID for rename/describe/upgrade
  --main                With pull/versions/restore: target the team project's main
  --version <n>         With pull: read-only checkout of previous save v<n>
  --title <text>        Build title for new/rename, or private todo title
  --description <text>  Build description for new/describe
  --no-description      Skip New description or clear with describe
  --summary <text>      Save summary
  --note <text>         Suggestion, notable-user, AI-bucket, or todo context
  --cursor <id>         Continue suggestions, Forum activity, or admin listing
  --poll-ms <ms>        Forum listener interval (1000-60000; default 3000)
  --after <date>        Admin listing: inclusive Unix/ISO creation boundary
  --since-run           Recommendations since the previous completed run (default)
  --include-legacy      Explicitly include the full historical recommendation queue
  --all                 Automatically read every page in the canonical snapshot
  --checkpoint <file>   Persist bounded pagination metadata or batch progress
  --resume              Resume the exact request recorded by --checkpoint
  --output <file>       Save an admin result or newspaper claim as JSON
  --output-dir <dir>    Directory for managed Build review evidence
  --claim <file>        Newspaper claim JSON used for validation/submission
  --scaffold <file>     Write an editable newspaper editorial scaffold
  --target-file <file>  JSON array or newline list for audited batch skips
  --review-receipt <f>  Confirmed managed Build runtime review receipt
  --review-context <f>  Private JSON understanding from the reviewed Build
  --severity <level>    Run escalation severity: attention or urgent
  --status <state>      Private escalation or todo lifecycle filter/state
  --wait-ms <ms>        Managed Build observation or sponsor watch duration
  --browser-path <path> Chrome/Chromium executable for managed Build review
  --effort unassigned  Admin subjects: show only unassigned effort
  --unviewed           Admin content lists: retain unviewed and unknown items
  --viewed             Admin content lists: retain viewed and unknown items
  --identity <mode>     Admin identity: zero, ciel, or auto
  --comment-mode <mode> Admin run comments: off, draft, or post
  --run-key <key>       Idempotency key for an admin daily run
  --idempotency-key <k> Stable retry key for one admin mutation
  --level <1|2|3>       Admin subject effort level
  --subject-ids <ids>   Complete ordered Featured subject IDs
  --bucket-id <id>      Unbanned AI identity bucket for account consolidation
  --label <name>        Name for a new unbanned AI identity bucket
  --user-ids <ids>      Explicit user IDs for an AI bucket batch (up to 500)
  --type <type>         Admin target: subject, comment, build, aiStory, or dailyReflection
  --kind <kind>         Admin recommendation kind or todo task/experiment kind
  --anyone-can-reward   Enable canonical reward eligibility
  --reward-twinkles 3   Pair a recommendation with exactly 3 Twinkles
  --twinkles 3          Give exactly 3 Twinkles through the normal economy
  --draft-id <id>       Canonical delegated comment draft ID
  --file <path>         Editorial JSON or composed text file
  --reviewed-version <id> Published Build artifact version actually reviewed
  --reviewed-via <method> Build review method: runtime or code
  --reason <text>       Reason when marking an admin run failed
  --force               Overwrite server files even if this workspace is stale or missing filesHash
  --search <text>       Search public open-source Builds
  --sort <sort>         Sort open-source Builds: forks, popular, recent
  --publish             Publish after saving
  --save                Save local files before launch
  --limit <number>      Number of projects to show
  --no-update-check     Skip the npm latest-version check
  --no-open             Print the approval URL without opening a browser
  --build <id>          Build id for sdk/assets/thumbnail/suggestion calls outside a workspace
  --repeat <n>          Repeat an sdk call (1-20) and print latency stats
  --allow-write         Permit sdk methods that mutate app data
  --path <api/...>      Call an sdk endpoint not in the curated list
  --scopes <a,b>        Override requested build API token scopes
  --json                Print machine-readable output where supported
  --keep-assets         Keep doctor probe assets instead of deleting them
  --no-browser          Skip doctor browser probes
  --model <model>       Image model for generate: gpt-image-2 or nano-banana (required, no default)
  --quality <q>         gpt-image-2 quality: low, medium, high (default high)
  --name <fileName>     File name hint for a generated asset
  --out <path>          With thumbnail capture: also save the capture locally
  --yes                 Skip confirmation prompts (assets prune/generate, thumbnail)
`);
}
