import { createRequire } from "module";

import { buildApiJson, mintBuildApiToken } from "./api.js";
import { ensureAuth, assertAuthScope } from "./auth.js";
import { uploadRuntimeAsset } from "./assets.js";
import { BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX } from "./constants.js";
import { requestJson } from "./http.js";
import { resolveSdkBuildId } from "./sdk.js";
import { formatBytes, trimTrailingSlash } from "./util.js";

const DEFAULT_PREVIEW_URL = "https://preview.lumine.app";
const DOCTOR_SOURCE = "lumine-runtime-assets-doctor";
const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-downloads allow-pointer-lock";

export async function doctorCommand(options) {
  const topic = String(options.positional[0] || "runtime-assets").trim();
  if (topic !== "runtime-assets") {
    throw new Error("Usage: lumine doctor runtime-assets [--build <id>] [--json] [--keep-assets] [--no-browser]");
  }
  await runtimeAssetsDoctor(options);
}

export async function runtimeAssetsDoctor(options) {
  const buildId = await resolveSdkBuildId(options);
  const auth = await ensureAuth(options);
  await assertAuthScope({ options, auth, scope: "build:sdk" });
  await assertAuthScope({ options, auth, scope: "build:check" });

  const { token: buildApiToken } = await mintBuildApiToken({
    options,
    auth,
    buildId,
    scopes: ["files:read", "files:write", "preview:read"],
  });

  const result = {
    ok: false,
    buildId,
    checkedAt: new Date().toISOString(),
    uploadedAssets: [],
    cloudfront: [],
    previewSession: null,
    browser: null,
    cleanup: [],
  };
  const uploadedAssets = [];

  try {
    const candidates = makeRuntimeAssetProbeCandidates();
    for (const candidate of candidates) {
      const asset = await uploadRuntimeAsset({
        options,
        auth,
        buildId,
        buildApiToken,
        candidate,
      });
      uploadedAssets.push(asset);
      result.uploadedAssets.push(formatAssetForReport(asset));
    }

    for (const asset of uploadedAssets) {
      result.cloudfront.push(await probeCloudFrontAsset(asset, options));
    }

    if (options.noBrowser) {
      result.previewSession = {
        ok: false,
        skipped: true,
        reason: "browser_probe_disabled",
      };
      result.browser = {
        ok: false,
        skipped: true,
        reason: "browser_probe_disabled",
      };
    } else {
      result.previewSession = await createRuntimeAssetsPreviewSession({
        options,
        auth,
        buildId,
        hdrAsset: findAssetByExtension(uploadedAssets, ".hdr"),
        glbAsset: findAssetByExtension(uploadedAssets, ".glb"),
      });
      result.browser = await runBrowserLoaderProbe({
        siteUrl: options.siteUrl,
        previewUrl: options.previewUrl,
        previewEntryUrl: result.previewSession.previewEntryUrl,
        timeoutMs: options.timeoutMs,
      });
    }

    result.headersOk = cloudFrontRequiredProbesPass(result.cloudfront);
    result.complete = Boolean(result.browser?.ok);
    result.ok = result.headersOk && (options.noBrowser || result.complete);
  } catch (error) {
    result.ok = false;
    result.headersOk = cloudFrontRequiredProbesPass(result.cloudfront);
    result.complete = false;
    result.error = {
      message: error?.message || String(error),
      status: error?.status || null,
      data: error?.data || null,
    };
    if (!result.previewSession) {
      result.previewSession = {
        ok: false,
        error: result.error.message,
        status: result.error.status,
      };
    }
  } finally {
    if (!options.keepAssets) {
      for (const asset of uploadedAssets) {
        result.cleanup.push(
          await deleteRuntimeAssetQuietly({
            options,
            auth,
            buildId,
            buildApiToken,
            asset,
          }),
        );
      }
    } else {
      result.cleanup.push({
        skipped: true,
        reason: "keep_assets",
        assetIds: uploadedAssets.map((asset) => Number(asset.id || 0)).filter(Boolean),
      });
    }
  }

  printRuntimeAssetsDoctorResult(result, options);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function makeRuntimeAssetProbeCandidates() {
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-");
  return [
    {
      absolutePath: null,
      fileName: `lumine-doctor-env-${stamp}.hdr`,
      mimeType: "image/vnd.radiance",
      buffer: makeMinimalHdr(),
    },
    {
      absolutePath: null,
      fileName: `lumine-doctor-scene-${stamp}.glb`,
      mimeType: "model/gltf-binary",
      buffer: makeMinimalGlb(),
    },
  ];
}

function makeMinimalHdr() {
  const header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n";
  return Buffer.concat([
    Buffer.from(header, "ascii"),
    Buffer.from([255, 255, 255, 128]),
  ]);
}

function makeMinimalGlb() {
  const json = JSON.stringify({
    asset: { version: "2.0", generator: "lumine-runtime-assets-doctor" },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
  });
  const jsonPadding = (4 - (Buffer.byteLength(json) % 4)) % 4;
  const jsonChunk = Buffer.concat([
    Buffer.from(json, "utf8"),
    Buffer.alloc(jsonPadding, 0x20),
  ]);
  const totalLength = 12 + 8 + jsonChunk.length;
  const buffer = Buffer.alloc(totalLength);
  buffer.writeUInt32LE(0x46546c67, 0);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(totalLength, 8);
  buffer.writeUInt32LE(jsonChunk.length, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(buffer, 20);
  return buffer;
}

function formatAssetForReport(asset) {
  return {
    id: Number(asset?.id || 0),
    fileName: asset?.fileName || "",
    originalFileName: asset?.originalFileName || asset?.fileName || "",
    mimeType: asset?.mimeType || null,
    sizeBytes: Number(asset?.sizeBytes || 0),
    url: asset?.url || "",
  };
}

function findAssetByExtension(assets, extension) {
  return assets.find((asset) =>
    String(asset?.fileName || asset?.originalFileName || "")
      .toLowerCase()
      .endsWith(extension),
  );
}

async function probeCloudFrontAsset(asset, options) {
  const probes = buildCloudFrontProbeSpecs(options);
  const requests = [];
  for (const probe of probes) {
    requests.push(await probeCloudFrontGet(asset.url, probe, options.timeoutMs));
  }
  return {
    asset: formatAssetForReport(asset),
    requests,
  };
}

function buildCloudFrontProbeSpecs(options) {
  const probes = [
    {
      label: "opaque sandbox",
      origin: "null",
      required: true,
    },
    {
      label: "preview origin",
      origin: normalizeOrigin(options.previewUrl),
      required: false,
    },
    {
      label: "site origin",
      origin: normalizeOrigin(options.siteUrl),
      required: false,
    },
    {
      label: "no Origin",
      origin: null,
      required: false,
    },
  ];
  const merged = new Map();
  for (const probe of probes) {
    if (probe.origin === "") continue;
    const key = probe.origin === null ? "no-origin" : probe.origin;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, probe);
      continue;
    }
    existing.required = existing.required || probe.required;
    existing.label = existing.required ? existing.label : probe.label;
  }
  return Array.from(merged.values());
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function cloudFrontRequiredProbesPass(cloudfront) {
  if (!cloudfront.length) return false;
  return cloudfront.every((entry) =>
    entry.requests.filter((request) => request.required).length > 0 &&
    entry.requests
      .filter((request) => request.required)
      .every((request) => request.ok && request.corsAllowed),
  );
}

async function probeCloudFrontGet(url, probe, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: probe.origin ? { origin: probe.origin } : {},
      signal: controller.signal,
    });
    const body = await response.arrayBuffer();
    const headers = pickHeaders(response.headers);
    const corsAllowed = accessControlAllowOriginMatches({
      headers,
      origin: probe.origin,
    });
    return {
      label: probe.label,
      origin: probe.origin,
      required: probe.required,
      ok: response.ok,
      status: response.status,
      ms: Date.now() - startedAt,
      bytes: body.byteLength,
      hasAccessControlAllowOrigin: Boolean(headers["access-control-allow-origin"]),
      corsAllowed,
      headers,
    };
  } catch (error) {
    return {
      label: probe.label,
      origin: probe.origin,
      required: probe.required,
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      bytes: 0,
      hasAccessControlAllowOrigin: false,
      corsAllowed: false,
      error: error?.message || String(error),
      headers: {},
    };
  } finally {
    clearTimeout(timeout);
  }
}

function accessControlAllowOriginMatches({ headers, origin }) {
  const acao = String(headers["access-control-allow-origin"] || "").trim();
  if (!acao) return false;
  // No-Origin requests are telemetry only. They are not browser CORS checks, so
  // report ACAO presence but never let this path affect required pass/fail.
  if (origin === null) return true;
  return acao === "*" || acao === origin;
}

function pickHeaders(headers) {
  const keys = [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "x-cache",
    "via",
    "x-amz-cf-pop",
  ];
  const picked = {};
  for (const key of keys) {
    const value = headers.get(key);
    if (value !== null) picked[key] = value;
  }
  return picked;
}

async function createRuntimeAssetsPreviewSession({
  options,
  auth,
  buildId,
  hdrAsset,
  glbAsset,
}) {
  if (!hdrAsset?.url || !glbAsset?.url) {
    throw new Error("Runtime asset probe did not produce both .hdr and .glb URLs.");
  }
  const session = await requestJson({
    method: "POST",
    url: `${options.apiUrl}/build/${buildId}/preview-session`,
    authToken: auth.token,
    body: {
      entryPath: "/index.html",
      files: [
        {
          path: "/index.html",
          content: buildRuntimeAssetsProbeHtml({
            hdrUrl: hdrAsset.url,
            glbUrl: glbAsset.url,
          }),
        },
      ],
    },
    timeoutMs: options.timeoutMs,
  });
  const entryUrl = String(session?.entryUrl || "");
  if (!entryUrl) {
    throw new Error("Twinkle did not return a preview-session entry URL.");
  }
  return {
    ok: true,
    sessionId: session.sessionId || null,
    entryUrl,
    previewEntryUrl: `${options.previewUrl}${entryUrl}`,
  };
}

export function buildRuntimeAssetsProbeHtml({ hdrUrl, glbUrl }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lumine Runtime Assets Doctor</title>
</head>
<body>
  <script type="module">
    const source = ${JSON.stringify(DOCTOR_SOURCE)};
    const hdrUrl = ${JSON.stringify(hdrUrl)};
    const glbUrl = ${JSON.stringify(glbUrl)};

    function headersToObject(headers) {
      const result = {};
      for (const [key, value] of headers.entries()) {
        result[key.toLowerCase()] = value;
      }
      return result;
    }

    async function fetchAsset(url) {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit'
      });
      const body = await response.arrayBuffer();
      return {
        ok: response.ok,
        status: response.status,
        type: response.type,
        url: response.url,
        bytes: body.byteLength,
        headers: headersToObject(response.headers)
      };
    }

    async function loadHdr(url) {
      const { RGBELoader } = await import('${BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX}loaders/RGBELoader.js');
      const texture = await new Promise((resolve, reject) => {
        new RGBELoader().load(url, resolve, undefined, reject);
      });
      return {
        ok: true,
        width: texture && texture.image ? texture.image.width || null : null,
        height: texture && texture.image ? texture.image.height || null : null,
        type: texture ? texture.type || null : null
      };
    }

    async function loadGlb(url) {
      const { GLTFLoader } = await import('${BUILD_VENDOR_THREE_ADDONS_IMPORT_PREFIX}loaders/GLTFLoader.js');
      const gltf = await new Promise((resolve, reject) => {
        new GLTFLoader().load(url, resolve, undefined, reject);
      });
      return {
        ok: true,
        sceneType: gltf && gltf.scene ? gltf.scene.type || null : null,
        sceneChildren: gltf && gltf.scene && gltf.scene.children ? gltf.scene.children.length : null,
        scenes: gltf && gltf.scenes ? gltf.scenes.length : null
      };
    }

    async function run() {
      const result = {
        source,
        ok: false,
        href: location.href,
        origin: location.origin,
        crossOriginIsolated: window.crossOriginIsolated === true,
        hdrFetch: null,
        glbFetch: null,
        hdrLoader: null,
        glbLoader: null
      };
      try {
        result.hdrFetch = await fetchAsset(hdrUrl);
        result.glbFetch = await fetchAsset(glbUrl);
        result.hdrLoader = await loadHdr(hdrUrl).catch((error) => ({
          ok: false,
          name: error && error.name ? error.name : null,
          error: error && error.message ? error.message : String(error)
        }));
        result.glbLoader = await loadGlb(glbUrl).catch((error) => ({
          ok: false,
          name: error && error.name ? error.name : null,
          error: error && error.message ? error.message : String(error)
        }));
        result.ok = Boolean(
          result.hdrFetch && result.hdrFetch.ok &&
          result.glbFetch && result.glbFetch.ok &&
          result.hdrLoader && result.hdrLoader.ok &&
          result.glbLoader && result.glbLoader.ok
        );
      } catch (error) {
        result.error = error && error.message ? error.message : String(error);
      }
      window.parent.postMessage(result, '*');
    }

    run();
  </script>
</body>
</html>`;
}

async function runBrowserLoaderProbe({
  siteUrl,
  previewUrl,
  previewEntryUrl,
  timeoutMs,
}) {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    return {
      ok: false,
      skipped: true,
      reason: "playwright_not_available",
      message:
        "Install Playwright or set LUMINE_PLAYWRIGHT_MODULE to enable the sandboxed loader probe.",
      previewEntryUrl,
    };
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const consoleMessages = [];
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text().slice(0, 500),
    });
  });

  try {
    const harnessUrl = buildBrowserHarnessUrl(siteUrl);
    await page.route(harnessUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "no-store" },
        body: buildOuterSandboxHarness(previewEntryUrl),
      });
    });
    await page.goto(harnessUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    const loaderResult = await waitForBrowserProbeResult(page, timeoutMs);
    return {
      ok: Boolean(loaderResult?.ok),
      harnessUrl,
      previewOrigin: previewUrl,
      previewEntryUrl,
      sandbox: PREVIEW_IFRAME_SANDBOX,
      result: loaderResult,
      consoleMessages,
    };
  } finally {
    await browser.close();
  }
}

function buildBrowserHarnessUrl(siteUrl) {
  const url = new URL("/__lumine-doctor/runtime-assets-harness", siteUrl);
  url.searchParams.set("t", String(Date.now()));
  return url.toString();
}

async function waitForBrowserProbeResult(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => Boolean(window.__lumineRuntimeAssetsDoctorResult),
      null,
      { timeout: timeoutMs },
    );
    return await page.evaluate(() => window.__lumineRuntimeAssetsDoctorResult);
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "Timed out waiting for runtime asset probe message.",
    };
  }
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.LUMINE_PLAYWRIGHT_MODULE,
    "playwright",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function buildOuterSandboxHarness(previewEntryUrl) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lumine Runtime Assets Doctor Harness</title>
</head>
<body>
  <script>
    window.__lumineRuntimeAssetsDoctorResult = null;
    window.addEventListener('message', (event) => {
      if (!event || !event.data || event.data.source !== ${JSON.stringify(DOCTOR_SOURCE)}) return;
      window.__lumineRuntimeAssetsDoctorResult = event.data;
    });
  </script>
  <iframe
    title="Lumine runtime assets doctor"
    sandbox="${PREVIEW_IFRAME_SANDBOX}"
    src="${escapeHtmlAttribute(previewEntryUrl)}"
    style="width: 800px; height: 600px; border: 0;"
  ></iframe>
</body>
</html>`;
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function deleteRuntimeAssetQuietly({
  options,
  auth,
  buildId,
  buildApiToken,
  asset,
}) {
  const assetId = Number(asset?.id || 0);
  if (!assetId) {
    return { ok: false, assetId, error: "missing_asset_id" };
  }
  try {
    await buildApiJson({
      options,
      auth,
      buildId,
      buildApiToken,
      endpointPath: "api/files/delete",
      body: { assetId },
    });
    return { ok: true, assetId };
  } catch (error) {
    return {
      ok: false,
      assetId,
      status: error?.status || null,
      error: error?.message || String(error),
    };
  }
}

function printRuntimeAssetsDoctorResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Runtime asset doctor for Build #${result.buildId}`);
  for (const asset of result.uploadedAssets) {
    console.log(
      `- uploaded #${asset.id} ${asset.originalFileName} ${formatBytes(asset.sizeBytes)}`,
    );
    console.log(`  ${asset.url}`);
  }

  for (const entry of result.cloudfront) {
    console.log(`- CloudFront ${entry.asset.originalFileName}`);
    for (const request of entry.requests) {
      const origin = request.origin === null ? "(no Origin)" : request.origin;
      const acao = request.headers["access-control-allow-origin"] || "(missing)";
      const contentType = request.headers["content-type"] || "(missing)";
      const required = request.required ? "required" : "info";
      const cors = request.corsAllowed ? "allowed" : "blocked";
      console.log(
        `  GET ${request.label} [${required}] Origin ${origin}: ` +
          `${request.ok ? "ok" : "fail"} ${request.status} ` +
          `ACAO=${acao} CORS=${cors} Content-Type=${contentType} bytes=${request.bytes}`,
      );
    }
  }

  if (result.previewSession?.previewEntryUrl) {
    console.log(`- preview session: ${result.previewSession.previewEntryUrl}`);
  }
  if (result.error?.message) {
    const status = result.error.status ? ` (${result.error.status})` : "";
    console.log(`- error: ${result.error.message}${status}`);
  }
  if (result.browser?.skipped) {
    console.log(`- browser loader probe: skipped (${result.browser.reason})`);
    if (result.browser.message) console.log(`  ${result.browser.message}`);
  } else if (result.browser) {
    console.log(`- browser loader probe: ${result.browser.ok ? "ok" : "fail"}`);
    const loader = result.browser.result || {};
    console.log(`  HDRLoader: ${loader.hdrLoader?.ok ? "ok" : "fail"}`);
    console.log(`  GLTFLoader: ${loader.glbLoader?.ok ? "ok" : "fail"}`);
  }
  for (const cleanup of result.cleanup) {
    if (cleanup.skipped) {
      console.log(`- cleanup: skipped (${cleanup.reason})`);
    } else {
      console.log(`- cleanup asset #${cleanup.assetId}: ${cleanup.ok ? "ok" : "fail"}`);
    }
  }
  const suffix = result.ok && !result.complete ? " (browser skipped)" : "";
  console.log(`Result: ${result.ok ? "ok" : "fail"}${suffix}`);
}

export function normalizePreviewUrl(value) {
  return trimTrailingSlash(String(value || DEFAULT_PREVIEW_URL));
}
