import fs from "fs/promises";

import { PACKAGE_METADATA_URL, UPDATE_CHECK_TIMEOUT_MS } from "./constants.js";
import { requestJson } from "./http.js";
import { isNewerVersion } from "./util.js";

export async function listBuilds({ options, auth }) {
  const url = new URL(`${options.apiUrl}/cli/builds`);
  url.searchParams.set("limit", String(options.limit));
  const result = await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  return Array.isArray(result.builds) ? result.builds : [];
}

export async function listOpenSourceBuilds({ options, auth }) {
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

export async function listContributionBranches({
  options,
  auth,
  buildId,
  limit,
}) {
  const url = new URL(`${options.apiUrl}/build/${buildId}/contributions`);
  url.searchParams.set("limit", String(limit));
  return await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

export async function loadBuildMetadata({ options, auth, buildId }) {
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

export async function loadOpenSourceBuildFiles({
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

export async function loadBuildFiles({ options, auth, buildId, includeContent }) {
  const url = new URL(`${options.apiUrl}/cli/build/${buildId}/files`);
  if (!includeContent) url.searchParams.set("includeContent", "0");
  return await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

export async function loadBuildVersions({ options, auth, buildId, limit }) {
  const url = new URL(`${options.apiUrl}/cli/build/${buildId}/versions`);
  if (limit) url.searchParams.set("limit", String(limit));
  return await requestJson({
    url: url.toString(),
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

export async function loadBuildVersionFiles({
  options,
  auth,
  buildId,
  versionNumber,
}) {
  return await requestJson({
    url: `${options.apiUrl}/cli/build/${buildId}/versions/${versionNumber}/files`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

export async function resolveBranchBuild({
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

export async function forkBuild({ options, auth, buildId }) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/fork`,
    authToken: auth.token,
    body: {},
    timeoutMs: options.timeoutMs,
  });
}

export async function createBuild({ options, auth, title, description }) {
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

export async function saveProjectFiles({
  options,
  auth,
  buildId,
  files,
  summary,
  baseFilesHash,
  force = false,
}) {
  return await requestJson({
    method: "PUT",
    url: `${options.apiUrl}/build/${buildId}/project-files`,
    authToken: auth.token,
    body: {
      files,
      createVersion: true,
      summary,
      // Proves this save is based on the snapshot we pulled so the server can
      // reject it instead of silently rewinding newer state (e.g. a branch
      // merged into main after our pull).
      ...(baseFilesHash ? { baseFilesHash } : {}),
      // Intentional overwrite of a non-empty project without a base claim.
      // Required when the workspace has no filesHash (old/stale checkout).
      ...(force ? { force: true } : {}),
    },
    timeoutMs: options.timeoutMs,
  });
}

export async function loadContributionDiff({
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

export async function listBuildSuggestions({
  options,
  auth,
  rootBuildId,
  cursor,
  suggestionId,
}) {
  const query = new URLSearchParams();
  if (Number(cursor || 0) > 0) query.set("cursor", String(cursor));
  if (Number(suggestionId || 0) > 0) {
    query.set("suggestionId", String(suggestionId));
  }
  const queryString = query.toString();
  return await requestJson({
    url: `${options.apiUrl}/build/${rootBuildId}/suggestions${queryString ? `?${queryString}` : ""}`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
}

export async function notifyBuildOwnerOfContribution({
  options,
  auth,
  rootBuildId,
  contributionBuildId,
  note,
}) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/notify-owner`,
    authToken: auth.token,
    body: { note },
    timeoutMs: options.timeoutMs,
  });
}

export async function suggestBuildThumbnailToOwner({
  options,
  auth,
  rootBuildId,
  contributionBuildId,
}) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/suggest-thumbnail`,
    authToken: auth.token,
    body: {},
    timeoutMs: options.timeoutMs,
  });
}

export async function adoptBuildThumbnailSuggestion({
  options,
  auth,
  rootBuildId,
  contributionBuildId,
  suggestionMessageId,
  thumbnailUrl,
}) {
  return await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${rootBuildId}/contributions/${contributionBuildId}/adopt-thumbnail`,
    authToken: auth.token,
    body: { suggestionMessageId, thumbnailUrl },
    timeoutMs: options.timeoutMs,
  });
}

export async function mergeContributionIntoMain({
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

export async function replaceMainWithContribution({
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

export async function publishBuild({ options, buildId, auth }) {
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

export async function mintBuildApiToken({ options, auth, buildId, scopes }) {
  const startedAt = Date.now();
  const result = await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/api/token`,
    authToken: auth.token,
    body: { scopes },
    timeoutMs: options.timeoutMs,
  });
  if (!result?.token) {
    throw new Error("Failed to mint a build API token.");
  }
  return {
    token: result.token,
    scopes: Array.isArray(result.scopes) ? result.scopes : [],
    ms: Date.now() - startedAt,
  };
}

export async function buildApiJson({
  options,
  auth,
  buildId,
  buildApiToken,
  endpointPath,
  body,
  timeoutMs,
}) {
  return requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/${endpointPath}`,
    authToken: auth.token,
    body: body || {},
    timeoutMs: timeoutMs || options.timeoutMs,
    headers: { "x-build-api-token": buildApiToken },
  });
}

export async function requestThumbnailSignedUpload({
  options,
  auth,
  buildId,
  fileSize,
  contentType,
}) {
  return requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/thumbnail`,
    authToken: auth.token,
    body: { fileSize, contentType },
    timeoutMs: options.timeoutMs,
  });
}

export async function updateBuildThumbnailUrl({
  options,
  auth,
  buildId,
  thumbnailUrl,
}) {
  return updateBuildMetadata({
    options,
    auth,
    buildId,
    patch: { thumbnailUrl },
  });
}

export async function updateBuildMetadata({
  options,
  auth,
  buildId,
  patch,
}) {
  return requestJson({
    method: "PUT",
    url: `${options.apiUrl}/build/${buildId}`,
    authToken: auth.token,
    body: patch,
    timeoutMs: options.timeoutMs,
  });
}

export async function captureBuildThumbnailPreview({
  options,
  auth,
  buildId,
  previewPath,
  timeoutMs,
}) {
  return requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/thumbnail/capture-preview`,
    authToken: auth.token,
    body: { previewPath },
    timeoutMs: timeoutMs || options.timeoutMs,
  });
}

export async function generateBuildThumbnailRequest({
  options,
  auth,
  buildId,
  body,
  timeoutMs,
}) {
  return requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/thumbnail/generate`,
    authToken: auth.token,
    body: body || {},
    timeoutMs: timeoutMs || options.timeoutMs,
  });
}

export async function fetchAllRuntimeAssets({
  options,
  auth,
  buildId,
  buildApiToken,
  includeReferences = false,
}) {
  const assets = [];
  let usage = null;
  let cursor = null;
  let projectAssets = null;
  do {
    const data = await buildApiJson({
      options,
      auth,
      buildId,
      buildApiToken,
      endpointPath: "api/files/list",
      body: {
        cursor,
        limit: 50,
        // Opt-in: the server annotates each asset with `referencedByProject`
        // (referenced by draft files, any artifact version snapshot incl. the
        // published one, or derived builds). Prune requires it.
        ...(includeReferences ? { includeReferences: true } : {}),
        // Project-owner asset context is opt-in server-side (running apps
        // list frequently and don't need it). First page only — the server
        // pages the full owner set once per request that asks.
        ...(cursor === null ? { includeProjectAssets: true } : {}),
      },
    });
    assets.push(...(Array.isArray(data?.assets) ? data.assets : []));
    usage = data?.usage || usage;
    // Project-owner assets (team projects): server-provided context so branch
    // agents can reuse the project's existing media. Absent on older API
    // deployments and for non-team builds.
    if (projectAssets === null && Array.isArray(data?.projectAssets)) {
      projectAssets = data.projectAssets;
    }
    cursor = data?.nextCursor || null;
  } while (cursor);
  return { assets, usage, projectAssets };
}

export async function loadLumineCliVersionInfo({ options }) {
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

export async function loadLocalPackageMetadata() {
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

export async function maybeCheckForLumineCliUpdate({ options }) {
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

export async function loadLatestPackageVersion({ packageName, registryUrl }) {
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

export function printLumineCliUpdateWarning(info) {
  console.error(
    `lumine: update available for ${info.packageName}: ${info.version} -> ${info.latestVersion}.`,
  );
  console.error(`lumine: run \`${info.updateCommand}\` to use the latest CLI.`);
}

export function serializeLumineCliMetadata(options) {
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
