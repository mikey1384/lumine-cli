import fs from "fs/promises";
import path from "path";

import {
  ASSET_GENERATE_TIMEOUT_MS,
  THUMBNAIL_CAPTURE_TIMEOUT_MS,
  THUMBNAIL_CONTENT_TYPE_BY_EXTENSION,
  THUMBNAIL_MAX_FILE_SIZE_BYTES,
} from "./constants.js";
import {
  captureBuildThumbnailPreview,
  generateBuildThumbnailRequest,
  loadBuildFiles,
  mintBuildApiToken,
  requestThumbnailSignedUpload,
  updateBuildThumbnailUrl,
} from "./api.js";
import { assertAuthScope, ensureAuth } from "./auth.js";
import { resolveSdkBuildId } from "./sdk.js";
import {
  confirmPrompt,
  describeGenerateHttpError,
  formatBatteryPercent,
  putAssetPartWithRetry,
  resolveGenerateModel,
} from "./assets.js";
import { formatBytes } from "./util.js";
import { findLocalProjectMetadata } from "./workspace.js";

export async function thumbnailCommand(options) {
  const subcommand = String(options.positional[0] || "");
  if (subcommand === "set") {
    await thumbnailSet(options);
    return;
  }
  if (subcommand === "capture") {
    await thumbnailCapture(options);
    return;
  }
  if (subcommand === "generate") {
    await thumbnailGenerate(options);
    return;
  }
  throw new Error(
    'Usage: lumine thumbnail set <file> | lumine thumbnail capture [--out <file>] | lumine thumbnail generate "<prompt>" --model <gpt-image-2|nano-banana>',
  );
}

async function refuseMainCheckout(options) {
  const local = await findLocalProjectMetadata(
    options.dir ? path.resolve(options.dir) : process.cwd(),
  );
  if (local?.metadata?.mainCheckout === true && !options.buildIdFlag) {
    throw new Error(
      "This is a read-only main checkout. Set the thumbnail from your contribution-branch workspace (or pass --build for a build you own).",
    );
  }
}

async function resolveThumbnailContext(options) {
  await refuseMainCheckout(options);
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:write" });
  const metadata = await loadBuildFiles({
    options,
    auth,
    buildId,
    includeContent: false,
  });
  const build = metadata?.build || {};
  if (build.canWrite === false) {
    throw new Error(
      `You cannot write to Build #${buildId}. Thumbnails can only be set on builds/branches you can save.`,
    );
  }
  return { buildId, auth, build };
}

async function confirmThumbnailOverwrite({ options, build, buildId }) {
  if (options.assumeYes) return true;
  if (!String(build?.thumbnailUrl || "").trim()) return true;
  const confirmed = await confirmPrompt(
    `Build #${buildId} already has a thumbnail. Replace it? [y/N] `,
  );
  if (confirmed === null) {
    console.log("Not a TTY — re-run with --yes to replace the thumbnail.");
    return false;
  }
  if (!confirmed) {
    console.log("Aborted. Thumbnail unchanged.");
    return false;
  }
  return true;
}

export async function commitThumbnailImage({
  options,
  auth,
  buildId,
  buffer,
  contentType,
}) {
  const { signedRequest, thumbnailUrl } = await requestThumbnailSignedUpload({
    options,
    auth,
    buildId,
    fileSize: buffer.length,
    contentType,
  });
  if (!signedRequest || !thumbnailUrl) {
    throw new Error("The server did not return a thumbnail upload URL.");
  }
  await putAssetPartWithRetry({
    url: signedRequest,
    chunk: buffer,
    mimeType: contentType,
    partLabel: "thumbnail",
  });
  const result = await updateBuildThumbnailUrl({
    options,
    auth,
    buildId,
    thumbnailUrl,
  });
  if (result?.success !== true) {
    throw new Error(result?.error || "Failed to save the thumbnail.");
  }
  return { thumbnailUrl, build: result.build || null };
}

export async function thumbnailSet(options) {
  const filePath = String(options.positional[1] || "").trim();
  if (!filePath) {
    throw new Error("Usage: lumine thumbnail set <file> (jpg, png, or webp)");
  }
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const contentType = THUMBNAIL_CONTENT_TYPE_BY_EXTENSION[extension];
  if (!contentType) {
    throw new Error(
      `Unsupported thumbnail type for ${path.basename(absolutePath)}. Thumbnails support ${Object.keys(THUMBNAIL_CONTENT_TYPE_BY_EXTENSION).join(", ")}.`,
    );
  }
  let buffer;
  try {
    buffer = await fs.readFile(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Thumbnail file does not exist: ${filePath}`);
    }
    throw error;
  }
  if (!buffer.length) {
    throw new Error(`Thumbnail file is empty: ${filePath}`);
  }
  if (buffer.length > THUMBNAIL_MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Thumbnail file is too big (${formatBytes(buffer.length)}; max ${formatBytes(THUMBNAIL_MAX_FILE_SIZE_BYTES)}).`,
    );
  }

  const { buildId, auth, build } = await resolveThumbnailContext(options);
  const proceed = await confirmThumbnailOverwrite({ options, build, buildId });
  if (!proceed) return;

  const { thumbnailUrl } = await commitThumbnailImage({
    options,
    auth,
    buildId,
    buffer,
    contentType,
  });
  console.log(`Thumbnail set for Build #${buildId}:`);
  console.log(`  ${thumbnailUrl}`);
  console.log("Tip: thumbnails display ~16:9; the image was uploaded uncropped.");
}

function decodeImageDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:(image\/[a-z+.-]+);base64,(.+)$/i,
  );
  if (!match) return null;
  return {
    contentType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], "base64"),
  };
}

export async function thumbnailCapture(options) {
  const { buildId, auth, build } = await resolveThumbnailContext(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  const proceed = await confirmThumbnailOverwrite({ options, build, buildId });
  if (!proceed) return;

  const { token: previewToken } = await mintBuildApiToken({
    options,
    auth,
    buildId,
    scopes: ["preview:read"],
  });
  const previewPath = `/build/preview/build/${buildId}/current?rev=${Number(build.updatedAt || 0)}&buildApiToken=${encodeURIComponent(previewToken)}`;

  console.log("Capturing the app preview server-side... this can take ~30s.");
  const captureResult = await captureBuildThumbnailPreview({
    options,
    auth,
    buildId,
    previewPath,
    timeoutMs: THUMBNAIL_CAPTURE_TIMEOUT_MS,
  });
  const decoded = decodeImageDataUrl(captureResult?.imageUrl);
  if (!decoded) {
    throw new Error(
      captureResult?.error || "Preview capture returned no image.",
    );
  }
  if (decoded.buffer.length > THUMBNAIL_MAX_FILE_SIZE_BYTES) {
    throw new Error("Captured image exceeds the 8MB thumbnail limit.");
  }
  if (options.out) {
    const outPath = path.resolve(String(options.out));
    await fs.writeFile(outPath, decoded.buffer);
    console.log(`Saved capture to ${outPath}`);
  }
  const normalizedContentType = THUMBNAIL_CONTENT_TYPE_BY_EXTENSION[
    `.${decoded.contentType.split("/")[1] || "png"}`
  ]
    ? decoded.contentType
    : "image/png";
  const { thumbnailUrl } = await commitThumbnailImage({
    options,
    auth,
    buildId,
    buffer: decoded.buffer,
    contentType: normalizedContentType,
  });
  console.log(`Thumbnail captured and set for Build #${buildId}:`);
  console.log(`  ${thumbnailUrl}`);
}

export async function thumbnailGenerate(options) {
  const prompt = String(options.positional[1] || "").trim();
  const { model, quality } = resolveGenerateModel(options);
  const { buildId, auth, build } = await resolveThumbnailContext(options);

  const requestBody = {
    model,
    ...(quality ? { quality } : {}),
    ...(prompt ? { prompt } : {}),
  };

  if (!options.assumeYes) {
    let estimate = null;
    try {
      const estimateResult = await generateBuildThumbnailRequest({
        options,
        auth,
        buildId,
        body: { ...requestBody, estimateOnly: true },
      });
      estimate = estimateResult?.estimate || null;
    } catch (error) {
      const friendly = describeGenerateHttpError(error);
      if (friendly) throw new Error(friendly);
      throw error;
    }
    const selectedOption = (estimate?.options || []).find(
      (option) => option.model === model,
    );
    console.log(
      `Generate a thumbnail with ${model}${quality ? ` (quality ${quality})` : ""}${prompt ? "" : " (prompt auto-composed from the build title/description)"}?`,
    );
    if (String(build?.thumbnailUrl || "").trim()) {
      console.log("  This will REPLACE the existing thumbnail.");
    }
    if (selectedOption) {
      console.log(
        `  Estimated battery cost: ${formatBatteryPercent(selectedOption.energyUnits, estimate?.fullBatteryUnits)} of a full AI battery (~$${Number(selectedOption.estimatedUsd || 0).toFixed(2)})`,
      );
    }
    if (estimate) {
      console.log(
        `  Battery remaining now:  ${formatBatteryPercent(estimate.energyRemaining, estimate.fullBatteryUnits)}`,
      );
    }
    const confirmed = await confirmPrompt("Proceed? [y/N] ");
    if (confirmed === null) {
      console.log("Not a TTY — re-run with --yes to generate.");
      return;
    }
    if (!confirmed) {
      console.log("Aborted. Nothing generated.");
      return;
    }
  }

  console.log("Generating the thumbnail... this can take a minute.");
  let result;
  try {
    result = await generateBuildThumbnailRequest({
      options,
      auth,
      buildId,
      body: requestBody,
      timeoutMs: ASSET_GENERATE_TIMEOUT_MS,
    });
  } catch (error) {
    const friendly = describeGenerateHttpError(error);
    if (friendly) throw new Error(friendly);
    throw error;
  }
  if (result?.success !== true || !result?.thumbnailUrl) {
    throw new Error(result?.error || "Thumbnail generation failed.");
  }
  console.log(`Thumbnail generated and set for Build #${buildId}:`);
  console.log(`  ${result.thumbnailUrl}`);
  if (result?.asset?.url) {
    console.log(
      `The generated image is also stored as reusable asset #${result.asset.id}:`,
    );
    console.log(`  ${result.asset.url}`);
  }
  const remaining = result?.aiUsagePolicy?.energyRemaining;
  if (Number.isFinite(Number(remaining))) {
    console.log(
      `Battery remaining: ${formatBatteryPercent(Number(remaining), result?.aiUsagePolicy?.fullBatteryUnits)}`,
    );
  }
}
