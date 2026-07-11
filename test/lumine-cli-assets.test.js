import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");
const libDir = path.resolve(__dirname, "../lib");
const cliSource = [
  cliPath,
  ...fs
    .readdirSync(libDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(libDir, name)),
]
  .map((filePath) => fs.readFileSync(filePath, "utf8"))
  .join("\n");

test("CLI exposes asset commands wired to the runtime-files endpoints", () => {
  assert.match(cliSource, /"assets"/);
  assert.match(cliSource, /async function assetsCommand\(options\)/);
  assert.match(cliSource, /async function assetsList\(options\)/);
  assert.match(cliSource, /async function assetsUpload\(options\)/);
  assert.match(cliSource, /async function assetsDelete\(options\)/);
  assert.match(cliSource, /async function assetsPrune\(options\)/);
  assert.match(cliSource, /api\/files\/prepare-upload/);
  assert.match(cliSource, /api\/files\/complete-upload/);
  assert.match(cliSource, /api\/files\/abort-upload/);
  assert.match(cliSource, /api\/files\/list/);
  assert.match(cliSource, /api\/files\/delete/);
  // S3 part PUTs must never carry the Twinkle auth header and must retry.
  assert.match(cliSource, /putAssetPartWithRetry/);
  assert.match(cliSource, /response\.status >= 400 && response\.status < 500/);
});

test("CLI validates encodings and mirrors project limits locally", () => {
  assert.match(cliSource, /function detectProjectFileEncodingIssue\(buffer\)/);
  assert.match(cliSource, /it is UTF-16 encoded/);
  assert.match(cliSource, /function countEffectiveLines\(value\)/);
  assert.match(cliSource, /function collectProjectLimitFindings\(files\)/);
  assert.match(cliSource, /const PROJECT_MAX_FILES = 100;/);
  assert.match(cliSource, /const PROJECT_MAX_EFFECTIVE_FILE_LINES = 500;/);
  assert.match(cliSource, /const PROJECT_EFFECTIVE_LINE_MAX_COLUMNS = 160;/);
  assert.match(cliSource, /assertProjectFilesWithinLimits\(files\);/);
  // Binary rejection must point at the asset workflow, not dead-end.
  assert.match(cliSource, /lumine assets upload <path-to-file>/);
});

test("assets upload runs prepare -> S3 PUT -> complete and writes the manifest", async (t) => {
  const { server, apiUrl, requests, tmpDir, authFile, workspaceDir } =
    await startMockApi(t, {
      assets: [
        {
          id: 5,
          buildId: 123,
          fileName: "existing.png",
          originalFileName: "existing.png",
          mimeType: "image/png",
          sizeBytes: 10,
          filePath: "123/7/5",
          url: "https://cdn.example/attachments/build-runtime/123/7/5/existing.png",
          thumbUrl: null,
          fileType: "image",
        },
      ],
    });
  const assetFile = path.join(tmpDir, "sprite.png");
  fs.writeFileSync(
    assetFile,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  );

  const result = await runCli([
    "assets",
    "upload",
    assetFile,
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Uploaded sprite\.png .* as asset #9/);
  assert.match(
    result.stdout,
    /https:\/\/cdn\.example\/attachments\/build-runtime\/123\/7\/9\/sprite\.png/,
  );
  const prepare = requests.find((r) =>
    r.url.endsWith("/api/files/prepare-upload"),
  );
  assert.ok(prepare, "prepare-upload was called");
  assert.deepEqual(JSON.parse(prepare.body), {
    fileName: "sprite.png",
    fileSize: 6,
    mimeType: "image/png",
  });
  const s3Put = requests.find(
    (r) => r.method === "PUT" && r.url === "/s3/part/1",
  );
  assert.ok(s3Put, "S3 part URL received a PUT");
  assert.equal(
    s3Put.headers.authorization,
    undefined,
    "no auth header sent to S3",
  );
  const complete = requests.find((r) =>
    r.url.endsWith("/api/files/complete-upload"),
  );
  assert.ok(complete, "complete-upload was called");
  const completeBody = JSON.parse(complete.body);
  assert.equal(completeBody.assetId, 9);
  assert.deepEqual(completeBody.parts, [{ ETag: "mock-etag", PartNumber: 1 }]);
  const manifestPath = path.join(workspaceDir, ".twinkle", "assets.json");
  assert.ok(fs.existsSync(manifestPath), "assets.json manifest written");
});

test("assets list surfaces project-owner assets and annotates the manifest", async (t) => {
  const ownerAsset = {
    id: 71,
    buildId: 900,
    fileName: "owner-hero.png",
    originalFileName: "owner-hero.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    filePath: "900/3/71",
    url: "https://cdn.example/attachments/build-runtime/900/3/71/owner-hero.png",
    thumbUrl: null,
    fileType: "image",
  };
  const { apiUrl, authFile, workspaceDir } = await startMockApi(t, {
    assets: [],
    projectAssets: [ownerAsset],
    projectFiles: [
      {
        path: "/index.html",
        content:
          '<img src="https://cdn.example/attachments/build-runtime/900/3/71/owner-hero.png"><img src="/attachments/build-runtime/900/3/99/gone.png">',
      },
    ],
  });
  const result = await runCli([
    "assets",
    "list",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.equal(result.code, 0, result.stderr);
  // The CLI must explicitly opt in to project-owner context.
  assert.match(result.stdout, /Project assets \(the project owner's uploads/);
  assert.match(result.stdout, /#71 {2}image {2}2\.0 KB {2}owner-hero\.png/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, ".twinkle", "assets.json"), "utf8"),
  );
  assert.equal(manifest.projectAssets.length, 1);
  assert.equal(manifest.projectAssets[0].referencedInCode, true);
  assert.deepEqual(manifest.unmatchedReferences, [
    "/attachments/build-runtime/900/3/99/gone.png",
  ]);
});

test("assets upload warns when the project owner already has a same-named asset", async (t) => {
  const ownerAsset = {
    id: 71,
    buildId: 900,
    fileName: "owner-hero.png",
    originalFileName: "owner-hero.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    filePath: "900/3/71",
    url: "https://cdn.example/attachments/build-runtime/900/3/71/owner-hero.png",
    thumbUrl: null,
    fileType: "image",
  };
  const { apiUrl, authFile, workspaceDir, tmpDir } = await startMockApi(t, {
    assets: [],
    projectAssets: [ownerAsset],
  });
  const assetFile = path.join(tmpDir, "owner-hero.png");
  fs.writeFileSync(assetFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const result = await runCli([
    "assets",
    "upload",
    assetFile,
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stderr,
    /project owner already has an asset named "owner-hero\.png" \(#71\)/,
  );
  assert.match(result.stderr, /build-runtime\/900\/3\/71\/owner-hero\.png/);
});

test("assets upload rejects unsupported types before any network call", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-assets-type-"));
  const badFile = path.join(tmpDir, "movie.mp4");
  fs.writeFileSync(badFile, "not really a video");
  const result = await runCli([
    "assets",
    "upload",
    badFile,
    "--build",
    "123",
    "--api-url",
    "http://127.0.0.1:9", // unroutable: proves no network needed to fail
    "--auth-file",
    path.join(tmpDir, "missing-auth.json"),
    "--no-update-check",
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Unsupported asset type for movie\.mp4/);
});

test("assets upload rejects root-relative glTF companion URIs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-assets-gltf-"));
  const gltfFile = path.join(tmpDir, "scene.gltf");
  fs.writeFileSync(
    gltfFile,
    JSON.stringify({
      asset: { version: "2.0" },
      images: [{ uri: "/textures/albedo.png" }],
    }),
  );
  const result = await runCli([
    "assets",
    "upload",
    gltfFile,
    "--build",
    "123",
    "--api-url",
    "http://127.0.0.1:9",
    "--auth-file",
    path.join(tmpDir, "missing-auth.json"),
    "--no-update-check",
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unsupported glTF URI/);
  assert.match(result.stderr, /\/textures\/albedo\.png/);
});

test("assets upload rejects external HTTP glTF companion URIs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-assets-gltf-"));
  const gltfFile = path.join(tmpDir, "scene.gltf");
  fs.writeFileSync(
    gltfFile,
    JSON.stringify({
      asset: { version: "2.0" },
      images: [{ uri: "https://example.com/textures/albedo.png" }],
    }),
  );
  const result = await runCli([
    "assets",
    "upload",
    gltfFile,
    "--build",
    "123",
    "--api-url",
    "http://127.0.0.1:9",
    "--auth-file",
    path.join(tmpDir, "missing-auth.json"),
    "--no-update-check",
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unsupported glTF URI/);
  assert.match(result.stderr, /https:\/\/example\.com/);
});

test("assets upload accepts verified Twinkle asset URLs in glTF manifests", async (t) => {
  const referencedAssetUrl =
    "https://d3jvoamd2k4p0s.cloudfront.net/attachments/build-runtime/123/7/5/albedo.png";
  const referencedThumbUrl =
    "https://d3jvoamd2k4p0s.cloudfront.net/attachments/optimized/build-runtime/5/albedo.webp";
  const { apiUrl, requests, tmpDir, authFile, workspaceDir } =
    await startMockApi(t, {
      assets: [
        {
          id: 5,
          buildId: 123,
          userId: 7,
          fileName: "albedo.png",
          originalFileName: "albedo.png",
          filePath: "123/7/5",
          url: referencedAssetUrl,
          thumbUrl: referencedThumbUrl,
        },
      ],
    });
  const gltfFile = path.join(tmpDir, "scene.gltf");
  fs.writeFileSync(
    gltfFile,
    JSON.stringify({
      asset: { version: "2.0" },
      images: [
        {
          uri: referencedAssetUrl,
        },
        { uri: referencedThumbUrl },
      ],
    }),
  );

  const result = await runCli([
    "assets",
    "upload",
    gltfFile,
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const prepare = requests.find((request) =>
    request.url.endsWith("/api/files/prepare-upload"),
  );
  assert.ok(prepare, "prepare-upload was called");
  assert.equal(JSON.parse(prepare.body).mimeType, "model/gltf+json");
});

test("assets upload rejects unverified Twinkle asset URLs", async (t) => {
  const { apiUrl, requests, tmpDir, authFile, workspaceDir } =
    await startMockApi(t);
  const gltfFile = path.join(tmpDir, "scene.gltf");
  fs.writeFileSync(
    gltfFile,
    JSON.stringify({
      asset: { version: "2.0" },
      images: [
        {
          uri: "https://d3jvoamd2k4p0s.cloudfront.net/attachments/build-runtime/999/8/5/albedo.png",
        },
      ],
    }),
  );

  const result = await runCli([
    "assets",
    "upload",
    gltfFile,
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /do not belong to this Build/);
  assert.equal(
    requests.some((request) =>
      request.url.endsWith("/api/files/prepare-upload"),
    ),
    false,
  );
});

test("save fails fast on UTF-16 files and on effective-line violations", async (t) => {
  const { apiUrl, requests, authFile, workspaceDir } = await startMockApi(
    t,
    {},
  );
  fs.writeFileSync(
    path.join(workspaceDir, "notes.js"),
    Buffer.from("﻿let a = 1;", "utf16le"),
  );
  const utf16Result = await runCli([
    "save",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.notEqual(utf16Result.code, 0);
  assert.match(utf16Result.stderr, /notes\.js: it is UTF-16 encoded/);
  fs.rmSync(path.join(workspaceDir, "notes.js"));

  const longFile = Array.from({ length: 501 }, (_, i) => `// line ${i}`).join(
    "\n",
  );
  fs.writeFileSync(path.join(workspaceDir, "big.js"), longFile);
  const limitResult = await runCli([
    "save",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.notEqual(limitResult.code, 0);
  assert.match(
    limitResult.stderr,
    /big\.js" exceeds the per-file limit of 500 effective lines/,
  );
  assert.equal(
    requests.some((r) => r.method === "PUT" && r.url.includes("project-files")),
    false,
    "no save request reached the server",
  );
});

const PRUNE_FIXTURE_REFERENCED = {
  id: 1,
  buildId: 123,
  fileName: "used.png",
  originalFileName: "used.png",
  mimeType: "image/png",
  sizeBytes: 10,
  filePath: "123/7/1",
  url: "https://cdn.example/attachments/build-runtime/123/7/1/used.png",
  thumbUrl: null,
  fileType: "image",
};
const PRUNE_FIXTURE_ORPHAN = {
  ...PRUNE_FIXTURE_REFERENCED,
  id: 2,
  fileName: "orphan.png",
  originalFileName: "orphan.png",
  filePath: "123/7/2",
  url: "https://cdn.example/attachments/build-runtime/123/7/2/orphan.png",
};
// Referenced by nothing in the current files, but still referenced by the
// published snapshot (server-side knowledge) — must never be pruned.
const PRUNE_FIXTURE_PUBLISHED_ONLY = {
  ...PRUNE_FIXTURE_REFERENCED,
  id: 3,
  fileName: "published-only.png",
  originalFileName: "published-only.png",
  filePath: "123/7/3",
  url: "https://cdn.example/attachments/build-runtime/123/7/3/published-only.png",
};
const PRUNE_FIXTURE_FILES = [
  { path: "/index.html", content: "<canvas></canvas>" },
  {
    path: "/src/assets.js",
    content:
      "export const USED = 'https://cdn.example/attachments/build-runtime/123/7/1/used.png';",
  },
];

test("assets prune spares published-referenced assets, plans without --yes, deletes with --yes", async (t) => {
  const { apiUrl, requests, authFile, workspaceDir } = await startMockApi(t, {
    assets: [
      PRUNE_FIXTURE_REFERENCED,
      PRUNE_FIXTURE_ORPHAN,
      PRUNE_FIXTURE_PUBLISHED_ONLY,
    ],
    serverReferencedIds: [1, 3],
    projectFiles: PRUNE_FIXTURE_FILES,
  });

  const planResult = await runCli([
    "assets",
    "prune",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.equal(planResult.code, 0, planResult.stderr);
  assert.match(planResult.stdout, /#2 {2}.*orphan\.png/);
  assert.doesNotMatch(planResult.stdout, /#1 {2}.*used\.png/);
  assert.doesNotMatch(planResult.stdout, /published-only\.png/);
  assert.match(planResult.stdout, /privateDb\/sharedDb\/user DBs/);
  assert.match(planResult.stdout, /re-run with --yes/);
  const listRequest = requests.find((r) => r.url.endsWith("/api/files/list"));
  assert.equal(JSON.parse(listRequest.body).includeReferences, true);
  assert.equal(
    requests.some((r) => r.url.endsWith("/api/files/delete")),
    false,
    "plan mode deleted nothing",
  );

  const deleteResult = await runCli([
    "assets",
    "prune",
    "--yes",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.equal(deleteResult.code, 0, deleteResult.stderr);
  assert.match(deleteResult.stdout, /Deleted #2 orphan\.png/);
  const deletes = requests.filter((r) => r.url.endsWith("/api/files/delete"));
  assert.equal(deletes.length, 1);
  assert.equal(JSON.parse(deletes[0].body).assetId, 2);
});

test("assets prune spares assets referenced by bare-variant unsaved local edits", async (t) => {
  // Referenced ONLY by an unsaved local file, and only via the bare filePath
  // form ("123/7/5") the backend recognizes — no URL for a regex to find.
  const bareReferenced = {
    ...PRUNE_FIXTURE_REFERENCED,
    id: 5,
    fileName: "bare.png",
    originalFileName: "bare.png",
    filePath: "123/7/5",
    url: "https://cdn.example/attachments/build-runtime/123/7/5/bare.png",
  };
  // Referenced only via the bare thumbnail object key (no leading slash).
  const bareThumbReferenced = {
    ...PRUNE_FIXTURE_REFERENCED,
    id: 6,
    fileName: "thumbed.png",
    originalFileName: "thumbed.png",
    filePath: "123/7/6",
    url: "https://cdn.example/attachments/build-runtime/123/7/6/thumbed.png",
    thumbUrl: "https://cdn.example/attachments/optimized/123/7/6/thumbed.webp",
  };
  const { apiUrl, requests, authFile, workspaceDir } = await startMockApi(t, {
    assets: [bareReferenced, bareThumbReferenced, PRUNE_FIXTURE_ORPHAN],
    serverReferencedIds: [],
    projectFiles: PRUNE_FIXTURE_FILES,
  });
  fs.writeFileSync(
    path.join(workspaceDir, "unsaved.js"),
    "const SPRITE_PATH = '123/7/5'; // unsaved edit using bare filePath\n" +
      "const THUMB_KEY = 'attachments/optimized/123/7/6/thumbed.webp';",
  );
  const result = await runCli([
    "assets",
    "prune",
    "--yes",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /bare\.png/);
  assert.doesNotMatch(result.stdout, /thumbed\.png/);
  assert.match(result.stdout, /Deleted #2 orphan\.png/);
  const deletes = requests.filter((r) => r.url.endsWith("/api/files/delete"));
  assert.equal(deletes.length, 1);
  assert.equal(JSON.parse(deletes[0].body).assetId, 2);
});

test("assets prune refuses to delete when the server lacks reference info", async (t) => {
  const { apiUrl, requests, authFile, workspaceDir } = await startMockApi(t, {
    assets: [PRUNE_FIXTURE_REFERENCED, PRUNE_FIXTURE_ORPHAN],
    // serverReferencedIds omitted: mock behaves like an older API deployment
    // that ignores includeReferences.
    projectFiles: PRUNE_FIXTURE_FILES,
  });
  const result = await runCli([
    "assets",
    "prune",
    "--yes",
    "--dir",
    workspaceDir,
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /#2 {2}.*orphan\.png/);
  assert.match(result.stdout, /deletion is disabled/);
  assert.equal(
    requests.some((r) => r.url.endsWith("/api/files/delete")),
    false,
    "nothing deleted without server reference info",
  );
});

// --- harness -----------------------------------------------------------------

async function startMockApi(
  t,
  { assets = [], projectFiles, projectAssets, serverReferencedIds } = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-assets-test-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const build = {
    id: 123,
    title: "Asset Build",
    role: "owner",
    canWrite: true,
    canPublish: true,
  };
  const files = projectFiles || [
    { path: "/index.html", content: "<h1>hello</h1>" },
  ];
  let apiUrl = "";
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      body,
      headers: req.headers,
    });
    if (req.method === "PUT" && req.url.startsWith("/s3/part/")) {
      res.setHeader("ETag", '"mock-etag"');
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "cli-user",
          scopes: ["build:read", "build:write", "build:sdk"],
        }),
      );
      return;
    }
    if (req.url.startsWith("/cli/build/123/files")) {
      res.end(
        JSON.stringify({
          build,
          projectFiles: files,
          projectManifest: {
            entryPath: "/index.html",
            storageMode: "project-files",
            fileCount: files.length,
          },
        }),
      );
      return;
    }
    if (req.url === "/build/123/api/token") {
      res.end(
        JSON.stringify({
          token: "build-api-token",
          scopes: JSON.parse(body).scopes,
        }),
      );
      return;
    }
    if (req.url === "/build/123/api/files/list") {
      const listBody = JSON.parse(body || "{}");
      const annotated =
        listBody.includeReferences && Array.isArray(serverReferencedIds)
          ? assets.map((asset) => ({
              ...asset,
              referencedByProject: serverReferencedIds.includes(asset.id),
            }))
          : assets;
      res.end(
        JSON.stringify({
          assets: annotated,
          nextCursor: null,
          usage: {
            totalBytes: 20,
            fileCount: assets.length,
            maxRuntimeFileStorageBytes: 104857600,
            remainingBytes: 104857580,
          },
          // Opt-in, like the real server: only returned when requested.
          ...(projectAssets && listBody.includeProjectAssets
            ? { projectAssets }
            : {}),
        }),
      );
      return;
    }
    if (req.url === "/build/123/api/files/prepare-upload") {
      const payload = JSON.parse(body);
      res.end(
        JSON.stringify({
          asset: {
            id: 9,
            buildId: 123,
            fileName: payload.fileName,
            originalFileName: payload.fileName,
            mimeType: payload.mimeType,
            sizeBytes: payload.fileSize,
            filePath: "123/7/9",
            url: `https://cdn.example/attachments/build-runtime/123/7/9/${payload.fileName}`,
            thumbUrl: null,
            fileType: "image",
          },
          uploadId: "upload-1",
          key: "attachments/build-runtime/123/7/9/sprite.png",
          urls: [`${apiUrl}/s3/part/1`],
        }),
      );
      return;
    }
    if (req.url === "/build/123/api/files/complete-upload") {
      const payload = JSON.parse(body);
      res.end(
        JSON.stringify({
          asset: {
            id: payload.assetId,
            buildId: 123,
            fileName: "sprite.png",
            originalFileName: "sprite.png",
            mimeType: "image/png",
            sizeBytes: 6,
            filePath: "123/7/9",
            url: "https://cdn.example/attachments/build-runtime/123/7/9/sprite.png",
            thumbUrl: null,
            fileType: "image",
          },
        }),
      );
      return;
    }
    if (req.url === "/build/123/api/files/delete") {
      res.end(
        JSON.stringify({
          success: true,
          usage: {
            totalBytes: 10,
            fileCount: 1,
            maxRuntimeFileStorageBytes: 104857600,
            remainingBytes: 104857590,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `no mock for ${req.method} ${req.url}` }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  apiUrl = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );
  fs.mkdirSync(path.join(workspaceDir, ".twinkle"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, ".twinkle", "lumine-project.json"),
    JSON.stringify({ schemaVersion: 1, buildId: 123, build, apiUrl }, null, 2),
  );
  for (const file of files) {
    const target = path.join(workspaceDir, file.path.replace(/^\//, ""));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, "utf8");
  }
  return { server, apiUrl, requests, tmpDir, authFile, workspaceDir };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.dirname(cliPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
