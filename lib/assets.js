import fs from "fs/promises";
import path from "path";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

import {
  ASSET_MIME_BY_EXTENSION,
  ASSET_UPLOAD_CHUNK_BYTES,
  ASSETS_METADATA_FILE,
  PROJECT_METADATA_DIR,
  RUNTIME_ASSET_REFERENCE_PATTERN,
} from "./constants.js";
import {
  buildApiJson,
  fetchAllRuntimeAssets,
  loadBuildFiles,
  mintBuildApiToken,
} from "./api.js";
import { assertAuthScope, ensureAuth } from "./auth.js";
import { resolveSdkBuildId } from "./sdk.js";
import { formatBytes, sleep } from "./util.js";
import {
  collectWorkspaceTextFilesLenient,
  findLocalProjectMetadata,
} from "./workspace.js";

// ---------------------------------------------------------------------------
// Build assets (runtime files): binary media referenced from project files by
// absolute URL. Uploads go straight to S3 via presigned multipart URLs — the
// same prepare -> PUT parts -> complete flow the web workspace uses.
// ---------------------------------------------------------------------------

export async function assetsCommand(options) {
  const subcommand = String(options.positional[0] || "list");
  if (subcommand === "list") {
    await assetsList(options);
    return;
  }
  if (subcommand === "upload") {
    await assetsUpload(options);
    return;
  }
  if (subcommand === "delete") {
    await assetsDelete(options);
    return;
  }
  if (subcommand === "prune") {
    await assetsPrune(options);
    return;
  }
  throw new Error(
    "Usage: lumine assets [list] | lumine assets upload <file...> | lumine assets delete <assetId> | lumine assets prune [--yes]",
  );
}

export async function assetsList(options) {
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  const { token } = await mintBuildApiToken({
    options,
    auth,
    buildId,
    scopes: ["files:read"],
  });
  const { assets, usage, projectAssets } = await fetchAllRuntimeAssets({
    options,
    auth,
    buildId,
    buildApiToken: token,
  });
  if (!assets.length) {
    console.log(
      `No uploaded assets for Build #${buildId} (your uploads). Add one with \`lumine assets upload <file>\`.`,
    );
  } else {
    console.log(`Assets for Build #${buildId} (your uploads):`);
    for (const asset of assets) {
      console.log(
        `  #${asset.id}  ${asset.fileType || "file"}  ${formatBytes(asset.sizeBytes)}  ${asset.originalFileName || asset.fileName}`,
      );
      console.log(`      ${asset.url}`);
    }
  }
  if (projectAssets?.length) {
    console.log(
      `Project assets (the project owner's uploads — reuse, do not re-upload):`,
    );
    for (const asset of projectAssets) {
      console.log(
        `  #${asset.id}  ${asset.fileType || "file"}  ${formatBytes(asset.sizeBytes)}  ${asset.originalFileName || asset.fileName}`,
      );
      console.log(`      ${asset.url}`);
    }
  }
  printAssetUsage(usage);
  const manifest = await maybeWriteWorkspaceAssetsManifest({
    options,
    buildId,
    assets,
    usage,
    projectAssets,
  });
  if (manifest) {
    console.log(
      `Manifest refreshed: ${path.join(manifest.dir, PROJECT_METADATA_DIR, ASSETS_METADATA_FILE)}`,
    );
  }
}

export async function assetsUpload(options) {
  const filePaths = options.positional.slice(1);
  if (!filePaths.length) {
    throw new Error(
      "Usage: lumine assets upload <file...> (images and audio only)",
    );
  }
  const buildId = await resolveSdkBuildId(options);
  // Validate local input fully before any auth/remote side effects.
  const candidates = [];
  for (const filePath of filePaths) {
    candidates.push(await readAssetUploadCandidate(filePath));
  }
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  const { token } = await mintBuildApiToken({
    options,
    auth,
    buildId,
    scopes: ["files:read", "files:write"],
  });
  // Duplicate-name heads-up: uploading never replaces — same name creates a
  // second asset with a new URL, and the old one keeps eating quota. Project-
  // owner assets are checked too: re-uploading media the project already has
  // defeats the reuse flow.
  try {
    const { assets: existingAssets, projectAssets: existingProjectAssets } =
      await fetchAllRuntimeAssets({
        options,
        auth,
        buildId,
        buildApiToken: token,
      });
    const nameMatches = (asset, fileName) =>
      asset.originalFileName === fileName || asset.fileName === fileName;
    for (const candidate of candidates) {
      const existing = existingAssets.find((asset) =>
        nameMatches(asset, candidate.fileName),
      );
      if (existing) {
        console.error(
          `lumine: note — an asset named "${candidate.fileName}" already exists (#${existing.id}). ` +
            `Uploading creates a NEW asset with a new URL; if this replaces #${existing.id}, update the code and run \`lumine assets delete ${existing.id}\` (or \`lumine assets prune\`).`,
        );
        continue;
      }
      const projectExisting = (existingProjectAssets || []).find((asset) =>
        nameMatches(asset, candidate.fileName),
      );
      if (projectExisting) {
        console.error(
          `lumine: note — the project owner already has an asset named "${candidate.fileName}" (#${projectExisting.id}). ` +
            `Consider reusing its URL instead of uploading a duplicate:\n  ${projectExisting.url}`,
        );
      }
    }
  } catch {
    // Advisory only — never block an upload on the pre-listing.
  }
  const uploaded = [];
  for (const candidate of candidates) {
    const asset = await uploadRuntimeAsset({
      options,
      auth,
      buildId,
      buildApiToken: token,
      candidate,
    });
    uploaded.push(asset);
    console.log(
      `Uploaded ${candidate.fileName} (${formatBytes(candidate.buffer.length)}) as asset #${asset.id}`,
    );
    console.log(`  ${asset.url}`);
  }
  console.log(
    `Reference ${uploaded.length === 1 ? "this URL" : "these URLs"} from your project files (e.g. a src/assets.js module).`,
  );
  await refreshWorkspaceAssetsManifest({
    options,
    auth,
    buildId,
    buildApiToken: token,
  });
}

export async function assetsDelete(options) {
  const assetId = Number(options.positional[1] || 0);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    throw new Error(
      "Usage: lumine assets delete <assetId> (ids come from `lumine assets list`)",
    );
  }
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  const { token } = await mintBuildApiToken({
    options,
    auth,
    buildId,
    scopes: ["files:read", "files:write"],
  });
  const result = await buildApiJson({
    options,
    auth,
    buildId,
    buildApiToken: token,
    endpointPath: "api/files/delete",
    body: { assetId },
  });
  console.log(
    `Deleted asset #${assetId}. Remove any references to it from your project files.`,
  );
  printAssetUsage(result?.usage);
  await refreshWorkspaceAssetsManifest({
    options,
    auth,
    buildId,
    buildApiToken: token,
  });
}

// Delete uploaded assets that nothing the platform can see references.
// Reference truth is threefold: (1) the server's persisted-content scan
// (`referencedByProject`: draft files, every artifact version snapshot
// including the published one, and derived builds), (2) the build's saved
// files scanned locally, and (3) unsaved local edits when run inside the
// matching workspace. An asset must be unreferenced by ALL THREE to be a
// candidate. If the server does not provide `referencedByProject` (older API
// deployment), prune shows the plan but refuses to delete — the published-
// snapshot check cannot be done client-side. Structural blind spot, always
// disclosed: references stored in app data (privateDb/sharedDb/viewer DB by
// Twinkle.files-using apps) are invisible to every scan.
export async function assetsPrune(options) {
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  const { token } = await mintBuildApiToken({
    options,
    auth,
    buildId,
    scopes: ["files:read", "files:write"],
  });
  const { assets, usage } = await fetchAllRuntimeAssets({
    options,
    auth,
    buildId,
    buildApiToken: token,
    includeReferences: true,
  });
  if (!assets.length) {
    console.log(`No uploaded assets for Build #${buildId}. Nothing to prune.`);
    return;
  }
  const serverVerified = assets.every(
    (asset) => typeof asset.referencedByProject === "boolean",
  );
  const remote = await loadBuildFiles({
    options,
    auth,
    buildId,
    includeContent: true,
  });
  const referenceFiles = Array.isArray(remote.projectFiles)
    ? [...remote.projectFiles]
    : [];
  const localProject = await findLocalProjectMetadata(
    options.dir ? path.resolve(options.dir) : process.cwd(),
  );
  if (Number(localProject?.metadata?.buildId || 0) === buildId) {
    referenceFiles.push(
      ...(await collectWorkspaceTextFilesLenient(localProject.rootDir)),
    );
  }
  // Content-level matching (not URL extraction): unsaved local edits may
  // reference an asset by any backend-supported variant, including bare
  // filePath ("123/7/5") or uploadKey forms that no URL regex would find.
  const contentBlob = referenceFiles
    .map((file) => String(file?.content || ""))
    .join("\n");
  const unreferenced = assets.filter(
    (asset) =>
      asset.referencedByProject !== true &&
      !contentReferencesRuntimeAsset(asset, contentBlob),
  );
  if (!unreferenced.length) {
    console.log(
      `All ${assets.length} uploaded asset${assets.length === 1 ? " is" : "s are"} referenced by the build's project files. Nothing to prune.`,
    );
    return;
  }
  console.log(
    `Unreferenced assets for Build #${buildId} (${unreferenced.length} of ${assets.length}):`,
  );
  for (const asset of unreferenced) {
    console.log(
      `  #${asset.id}  ${formatBytes(asset.sizeBytes)}  ${asset.originalFileName || asset.fileName}`,
    );
  }
  console.log(
    "Caution: asset URLs stored in app data (privateDb/sharedDb/user DBs by apps using Twinkle.files) cannot be detected. If this app stores uploaded-file URLs at runtime, do not prune its assets.",
  );
  if (!serverVerified) {
    console.log(
      "The server did not report published/version reference info for these assets, so deletion is disabled — an asset may still be referenced by the published app. Update the Twinkle API (files/list includeReferences) to enable pruning.",
    );
    return;
  }
  if (!options.assumeYes) {
    const confirmed = await confirmPrompt(
      `Delete ${unreferenced.length} unreferenced asset${unreferenced.length === 1 ? "" : "s"}? [y/N] `,
    );
    if (confirmed === null) {
      console.log("Not a TTY — re-run with --yes to delete these assets.");
      return;
    }
    if (!confirmed) {
      console.log("Aborted. Nothing deleted.");
      return;
    }
  }
  let lastUsage = usage;
  for (const asset of unreferenced) {
    const result = await buildApiJson({
      options,
      auth,
      buildId,
      buildApiToken: token,
      endpointPath: "api/files/delete",
      body: { assetId: asset.id },
    });
    lastUsage = result?.usage || lastUsage;
    console.log(`Deleted #${asset.id} ${asset.originalFileName || asset.fileName}`);
  }
  printAssetUsage(lastUsage);
  await refreshWorkspaceAssetsManifest({
    options,
    auth,
    buildId,
    buildApiToken: token,
  });
}

export async function confirmPrompt(question) {
  if (!input.isTTY || !output.isTTY) return null;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Presigned URL: no Authorization header, no request timeout (parts can be
// 5MB on slow links) — mirrors the web workspace uploader, plus bounded
// retries for transient network/5xx failures. 4xx means the presigned URL
// itself is bad; retrying cannot help.
export async function putAssetPartWithRetry({ url, chunk, mimeType, partLabel }) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": mimeType },
        body: chunk,
      });
      if (response.ok) return response;
      lastError = new Error(`Upload ${partLabel} failed (${response.status}).`);
      if (response.status >= 400 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      console.error(`lumine: retrying ${partLabel} (attempt ${attempt + 1}/3)`);
      await sleep(attempt * 1000);
    }
  }
  throw lastError || new Error(`Upload ${partLabel} failed.`);
}

export async function readAssetUploadCandidate(filePath) {
  const absolutePath = path.resolve(filePath);
  const fileName = path.basename(absolutePath);
  const extension = path.extname(fileName).toLowerCase();
  const mimeType = ASSET_MIME_BY_EXTENSION[extension];
  if (!mimeType) {
    throw new Error(
      `Unsupported asset type for ${fileName}. Build assets support image and audio files (${Object.keys(ASSET_MIME_BY_EXTENSION).join(", ")}).`,
    );
  }
  let buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Asset file does not exist: ${filePath}`);
    }
    throw error;
  }
  if (!buffer.length) {
    throw new Error(`Asset file is empty: ${filePath}`);
  }
  return { absolutePath, fileName, mimeType, buffer };
}

export async function uploadRuntimeAsset({
  options,
  auth,
  buildId,
  buildApiToken,
  candidate,
}) {
  const prepared = await buildApiJson({
    options,
    auth,
    buildId,
    buildApiToken,
    endpointPath: "api/files/prepare-upload",
    body: {
      fileName: candidate.fileName,
      fileSize: candidate.buffer.length,
      mimeType: candidate.mimeType,
    },
  });
  const uploadId = String(prepared?.uploadId || "");
  const key = String(prepared?.key || "");
  const urls = Array.isArray(prepared?.urls) ? prepared.urls : [];
  const assetId = Number(prepared?.asset?.id);
  if (!uploadId || !key || urls.length === 0 || !assetId) {
    throw new Error(`Failed to prepare upload for ${candidate.fileName}.`);
  }

  try {
    const parts = [];
    for (let partNumber = 0; partNumber < urls.length; partNumber += 1) {
      const start = partNumber * ASSET_UPLOAD_CHUNK_BYTES;
      const end = Math.min(start + ASSET_UPLOAD_CHUNK_BYTES, candidate.buffer.length);
      const response = await putAssetPartWithRetry({
        url: urls[partNumber],
        chunk: candidate.buffer.subarray(start, end),
        mimeType: candidate.mimeType,
        partLabel: `part ${partNumber + 1}/${urls.length} of ${candidate.fileName}`,
      });
      const etag = response.headers.get("etag");
      if (!etag) {
        throw new Error(
          `Missing ETag in upload response for part ${partNumber + 1} of ${candidate.fileName}.`,
        );
      }
      parts.push({
        ETag: etag.replace(/['"]/g, ""),
        PartNumber: partNumber + 1,
      });
    }

    const completed = await buildApiJson({
      options,
      auth,
      buildId,
      buildApiToken,
      endpointPath: "api/files/complete-upload",
      body: { assetId, uploadId, key, parts },
    });
    const asset = completed?.asset || prepared?.asset;
    if (!asset?.url) {
      throw new Error(`Upload of ${candidate.fileName} completed without an asset URL.`);
    }
    return asset;
  } catch (error) {
    await buildApiJson({
      options,
      auth,
      buildId,
      buildApiToken,
      endpointPath: "api/files/abort-upload",
      body: { assetId, reason: "upload_failed" },
    }).catch(() => {});
    throw error;
  }
}

// Re-fetch the asset list and rewrite .twinkle/assets.json when running inside
// the matching workspace. Best-effort: a manifest failure must not fail the
// command that already did its real work.
export async function refreshWorkspaceAssetsManifest({
  options,
  auth,
  buildId,
  buildApiToken,
}) {
  try {
    const localProject = await findLocalProjectMetadata(
      options.dir ? path.resolve(options.dir) : process.cwd(),
    );
    if (Number(localProject?.metadata?.buildId || 0) !== buildId) return;
    const { assets, usage, projectAssets } = await fetchAllRuntimeAssets({
      options,
      auth,
      buildId,
      buildApiToken,
    });
    await writeAssetsManifest({
      dir: localProject.rootDir,
      buildId,
      assets,
      usage,
      projectAssets,
      codeFiles: await collectWorkspaceTextFilesLenient(localProject.rootDir),
    });
    console.log(
      `Manifest refreshed: ${path.join(localProject.rootDir, PROJECT_METADATA_DIR, ASSETS_METADATA_FILE)}`,
    );
  } catch (error) {
    console.error(
      `lumine: could not refresh ${ASSETS_METADATA_FILE} (${error?.message || error})`,
    );
  }
}

export async function maybeWriteWorkspaceAssetsManifest({
  options,
  buildId,
  assets,
  usage,
  projectAssets,
}) {
  const localProject = await findLocalProjectMetadata(
    options.dir ? path.resolve(options.dir) : process.cwd(),
  );
  if (Number(localProject?.metadata?.buildId || 0) !== buildId) return null;
  await writeAssetsManifest({
    dir: localProject.rootDir,
    buildId,
    assets,
    usage,
    projectAssets,
    codeFiles: await collectWorkspaceTextFilesLenient(localProject.rootDir),
  });
  return { dir: localProject.rootDir };
}

export async function writeAssetsManifest({
  dir,
  buildId,
  assets,
  usage,
  codeFiles,
  projectAssets,
}) {
  // Annotation is content-level (covers bare filePath/uploadKey variants);
  // the URL regex is only used below to DISCOVER references that match no
  // known asset.
  const contentBlob = codeFiles
    ? codeFiles.map((file) => String(file?.content || "")).join("\n")
    : null;
  const refs = codeFiles
    ? Array.from(collectRuntimeAssetReferences(codeFiles))
    : null;
  const annotate = (list) =>
    contentBlob !== null
      ? list.map((asset) => ({
          ...asset,
          referencedInCode: contentReferencesRuntimeAsset(asset, contentBlob),
        }))
      : list;
  const annotatedAssets = annotate(assets);
  const annotatedProjectAssets = projectAssets ? annotate(projectAssets) : null;
  // Asset references in code that match neither the current user's uploads
  // nor the project owner's assets: stale references to deleted assets, or
  // assets of a collaborator the server did not include.
  const knownAssets = [...assets, ...(projectAssets || [])];
  const unmatchedReferences = refs
    ? refs.filter(
        (ref) =>
          !knownAssets.some((asset) => runtimeAssetMatchesReference(asset, ref)),
      )
    : null;
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  await fs.writeFile(
    path.join(metadataDir, ASSETS_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 2,
        buildId,
        note: "Runtime assets for this build. `assets` are the current CLI user's uploads; `projectAssets` are the project owner's uploads (team projects) — reference either from project files by its absolute `url`, and reuse `projectAssets` instead of re-uploading media the project already has. `unmatchedReferences` are asset URLs found in the code that match no known asset (stale, or another collaborator's). Refresh with `lumine assets list`; add with `lumine assets upload <file>`; remove your unreferenced uploads with `lumine assets prune`.",
        fetchedAt: new Date().toISOString(),
        usage: usage || null,
        assets: annotatedAssets,
        ...(annotatedProjectAssets ? { projectAssets: annotatedProjectAssets } : {}),
        ...(unmatchedReferences ? { unmatchedReferences } : {}),
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function collectRuntimeAssetReferences(files) {
  const refs = new Set();
  for (const file of files || []) {
    const content = String(file?.content || "");
    for (const match of content.matchAll(RUNTIME_ASSET_REFERENCE_PATTERN)) {
      refs.add(match[0]);
    }
  }
  return refs;
}

// Content-level reference test mirroring the backend's variant support: the
// filePath ("buildId/userId/assetId") is a substring of every non-thumb
// variant it recognizes (absolute URL, URL pathname, uploadKey, bare
// filePath), so one substring check covers them all. Likewise for thumbs: the
// bare object key ("attachments/optimized/...", no leading slash) is a
// substring of every thumb form the backend recognizes (full thumbUrl,
// pathname, and /key), so matching the bare key covers them all. Plain
// substring matching errs toward "referenced" — the safe direction.
export function contentReferencesRuntimeAsset(asset, contentBlob) {
  if (!contentBlob) return false;
  if (asset?.filePath && contentBlob.includes(asset.filePath)) return true;
  if (asset?.thumbUrl) {
    if (contentBlob.includes(asset.thumbUrl)) return true;
    const thumbPathname = urlPathname(asset.thumbUrl);
    const bareThumbKey = thumbPathname
      ? thumbPathname.replace(/^\//, "")
      : null;
    if (bareThumbKey && contentBlob.includes(bareThumbKey)) return true;
  }
  return false;
}

function urlPathname(value) {
  try {
    return new URL(String(value)).pathname;
  } catch {
    return null;
  }
}

// Errs toward "referenced": filePath ("buildId/userId/assetId") is a substring
// of every server-recognized reference variant (full URL, pathname, uploadKey),
// and thumb URLs are matched separately since they live under a different path.
export function runtimeAssetMatchesReference(asset, ref) {
  if (asset?.filePath && ref.includes(asset.filePath)) return true;
  if (asset?.thumbUrl) {
    if (ref === asset.thumbUrl || asset.thumbUrl.endsWith(ref)) return true;
  }
  return false;
}

export function printAssetUsage(usage) {
  if (!usage) return;
  const total = Number(usage.totalBytes || 0);
  const max = Number(usage.maxRuntimeFileStorageBytes || 0);
  const remaining = Number(usage.remainingBytes || 0);
  console.log(
    `Storage: ${formatBytes(total)} of ${formatBytes(max)} used · ${formatBytes(remaining)} free (across all your builds)`,
  );
}
