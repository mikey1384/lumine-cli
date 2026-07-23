import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../lib/commands.js";

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

test("CLI exposes open-source explore, reference, and fork commands", () => {
  assert.match(cliSource, /"explore"/);
  assert.match(cliSource, /"reference"/);
  assert.match(cliSource, /"fork"/);
  assert.match(cliSource, /async function explore\(options\)/);
  assert.match(cliSource, /async function reference\(options\)/);
  assert.match(cliSource, /async function fork\(options\)/);
  assert.match(cliSource, /\/cli\/open-source-builds/);
  assert.match(cliSource, /\/cli\/build\/\$\{buildId\}\/open-source-files/);
  assert.match(cliSource, /\/build\/\$\{buildId\}\/fork/);
});

test("CLI resolves Build branch URLs and exposes owner review commands", () => {
  assert.match(cliSource, /"branches"/);
  assert.match(cliSource, /"diff"/);
  assert.match(cliSource, /"merge"/);
  assert.match(cliSource, /"replace-main"/);
  assert.match(cliSource, /async function diff\(options\)/);
  assert.match(cliSource, /async function mergeBranch\(options\)/);
  assert.match(cliSource, /async function replaceMainWithBranch\(options\)/);
  assert.match(cliSource, /function resolveBuildReference\(value\)/);
  assert.match(
    cliSource,
    /branchNumber: Number\(parts\[buildIndex \+ 2\]\) \|\| 0/,
  );
  assert.match(
    cliSource,
    /\/cli\/build\/\$\{rootBuildId\}\/branches\/\$\{branchNumber\}/,
  );
  assert.match(
    cliSource,
    /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}/,
  );
  assert.match(
    cliSource,
    /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}\/merge/,
  );
  assert.match(
    cliSource,
    /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}\/replace-main/,
  );
});

test("CLI lists contribution branches for review", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-branches-test-"));
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "project-owner",
          scopes: ["build:read"],
        }),
      );
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/build/884/files?includeContent=0"
    ) {
      res.end(
        JSON.stringify({
          build: {
            id: 884,
            title: "Twinkle Book Maker",
            role: "owner",
            canWrite: true,
            canPublish: true,
          },
        }),
      );
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/build/884/contributions?limit=10"
    ) {
      res.end(
        JSON.stringify({
          contributions: [
            {
              id: 901,
              title: "Edit branch",
              username: "Cloudstar",
              contributionBranchNumber: 4,
              contributionStatus: "draft",
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );

  const result = await runCli([
    "branches",
    "884",
    "--limit",
    "10",
    "--api-url",
    apiUrl,
    "--site-url",
    "https://www.twin-kle.com",
    "--auth-file",
    authFile,
    "--no-update-check",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Branches for Twinkle Book Maker \(#884\):/);
  assert.match(
    result.stdout,
    /Edit branch - Cloudstar - branch 4 \(draft\)/,
  );
  assert.match(result.stdout, /https:\/\/www\.twin-kle\.com\/build\/884\/4/);
  assert.equal(
    requests.some(
      (request) =>
        request.method === "GET" &&
        request.url === "/build/884/contributions?limit=10",
    ),
    true,
  );
});

test("CLI can create a new Build without starting an AI run", () => {
  assert.match(cliSource, /"new"/);
  assert.match(cliSource, /async function newBuild\(options\)/);
  assert.match(
    cliSource,
    /async function newBuild\(options\) \{[\s\S]*const title = await resolveNewBuildTitle\(options\);[\s\S]*const auth = await ensureAuth\(options\)/,
  );
  assert.match(
    cliSource,
    /async function createBuild\(\{ options, auth, title, description \}\)/,
  );
  assert.match(cliSource, /url: `\$\{options\.apiUrl\}\/build\/create`/);
  assert.match(cliSource, /resolveNewBuildTitle\(options\)/);
  assert.match(cliSource, /resolveNewBuildDescription\(options\)/);
  assert.match(cliSource, /raw\.title/);
  assert.match(cliSource, /raw\.description/);
  assert.match(cliSource, /noDescription/);
  assert.match(cliSource, /!input\.isTTY \|\| !output\.isTTY/);
  assert.match(
    cliSource,
    /await pullBuildFiles\(\{ options, auth, buildId \}\)/,
  );
  assert.doesNotMatch(cliSource, /build_generate_greeting/);
  assert.doesNotMatch(cliSource, /build_generate[^_]/);
});

test("CLI rename keeps positionals title-only and requires an explicit target flag", () => {
  const numericLeadingTitle = parseArgs(["rename", "2026 Roadmap"]);
  assert.equal(numericLeadingTitle.target, "");
  assert.equal(numericLeadingTitle.title, "2026 Roadmap");

  const numericTitle = parseArgs(["rename", "2026"]);
  assert.equal(numericTitle.target, "");
  assert.equal(numericTitle.title, "2026");

  const positionalTitle = parseArgs(["rename", "1835", "New Title"]);
  assert.equal(positionalTitle.target, "");
  assert.equal(positionalTitle.title, "1835 New Title");

  const explicitTarget = parseArgs([
    "rename",
    "New Title",
    "--target",
    "1835",
  ]);
  assert.equal(explicitTarget.target, "1835");
  assert.equal(explicitTarget.title, "New Title");

  const explicitUrl = parseArgs([
    "rename",
    "--title",
    "URL Target",
    "--url",
    "https://www.twin-kle.com/app/1835",
  ]);
  assert.equal(explicitUrl.target, "https://www.twin-kle.com/app/1835");
  assert.equal(explicitUrl.title, "URL Target");
});

test("CLI new posts title and optional description then pulls the created workspace", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-new-test-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "cli-user",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/build/create") {
      const payload = JSON.parse(body || "{}");
      res.end(
        JSON.stringify({
          build: {
            id: 123,
            title: payload.title,
            description: payload.description || null,
            role: "owner",
            canWrite: true,
            canPublish: true,
          },
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/cli/build/123/files") {
      res.end(
        JSON.stringify({
          build: {
            id: 123,
            title: "CLI Build",
            role: "owner",
            canWrite: true,
            canPublish: true,
          },
          projectFiles: [],
          projectManifest: {
            entryPath: "/index.html",
            storageMode: "legacy-single-file",
            fileCount: 0,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );

  const result = await runCli([
    "new",
    "CLI",
    "Build",
    "--description",
    "From CLI",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--dir",
    workspaceDir,
    "--no-update-check",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Created CLI Build \(#123\)\./);
  assert.match(
    result.stdout,
    /No project files yet\. Create \/index\.html before your first save\./,
  );
  const createRequest = requests.find(
    (request) => request.method === "POST" && request.url === "/build/create",
  );
  assert.ok(createRequest);
  assert.deepEqual(JSON.parse(createRequest.body), {
    title: "CLI Build",
    description: "From CLI",
  });
  assert.equal(
    requests.some((request) => String(request.url).includes("build_generate")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(workspaceDir, ".twinkle", "lumine-project.json")),
    true,
  );
});

test("CLI blocks saves from read-only branch checkouts", () => {
  assert.match(cliSource, /metadata\.build\?\.canWrite === false/);
  assert.match(cliSource, /This Lumine checkout is read-only/);
  assert.match(cliSource, /build\?\.canWrite === false/);
  assert.match(cliSource, /Review changes: lumine diff/);
  assert.match(
    cliSource,
    /Owner actions: lumine merge, or lumine replace-main/,
  );
});

test("CLI references are marked read-only and blocked from save", () => {
  assert.match(cliSource, /LUMINE_REFERENCE_INSTRUCTIONS_MARKER/);
  assert.match(cliSource, /async function writeReferenceMetadata/);
  assert.match(
    cliSource,
    /readOnly: true[\s\S]*role: "reference"[\s\S]*canWrite: false[\s\S]*canPublish: false/,
  );
  assert.match(cliSource, /assertLocalProjectCanBeSaved\(localProject\)/);
  assert.match(cliSource, /metadata\?\.reference\?\.readOnly === true/);
  assert.match(cliSource, /lumine fork/);
});

test("CLI explore supports search and fork-oriented sorting", () => {
  assert.match(cliSource, /searchQuery:[\s\S]*command === "explore"/);
  assert.match(cliSource, /function normalizeOpenSourceSort\(value\)/);
  assert.match(cliSource, /return "forks"/);
  assert.match(cliSource, /url\.searchParams\.set\("sort", options\.sort\)/);
  assert.match(
    cliSource,
    /url\.searchParams\.set\("search", options\.searchQuery\)/,
  );
});

test("CLI records npm version update state for agents", () => {
  assert.match(cliSource, /PACKAGE_METADATA_URL/);
  assert.match(cliSource, /maybeCheckForLumineCliUpdate/);
  assert.match(cliSource, /loadLatestPackageVersion/);
  assert.match(cliSource, /isNewerVersion/);
  assert.match(cliSource, /lumineCli: serializeLumineCliMetadata\(options\)/);
  assert.match(cliSource, /updateAvailable: Boolean\(info\.updateAvailable\)/);
  assert.match(cliSource, /--no-update-check/);
  assert.match(cliSource, /npx \$\{packageName\}@latest/);
});

test("stale CLI saves recover through canonical pull, not update-from-main", () => {
  const staleSaveMessageStart = cliSource.indexOf(
    '"Save rejected: the project changed on the server',
  );
  const staleSaveMessageEnd = cliSource.indexOf(
    'throw error;',
    staleSaveMessageStart,
  );
  const staleSaveMessage = cliSource.slice(
    staleSaveMessageStart,
    staleSaveMessageEnd,
  );

  assert.ok(staleSaveMessageStart > 0);
  assert.match(staleSaveMessage, /Run `lumine pull`/);
  assert.doesNotMatch(staleSaveMessage, /update-from-main/);
});

test("CLI refuses saves without filesHash unless --force", () => {
  assert.match(
    cliSource,
    /Save refused: this workspace has no filesHash \(server snapshot token\)\./,
  );
  assert.match(cliSource, /force: Boolean\(options\.force\)/);
  assert.match(
    cliSource,
    /\.\.\.\(force \? \{ force: true \} : \{\}\)/,
  );
  assert.match(cliSource, /build_project_files_base_required/);
});

test("update-from-main persists the returned file hash when metadata refresh fails", async (t) => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-update-main-test-"),
  );
  const workspaceDir = path.join(tmpDir, "workspace");
  const metadataDir = path.join(workspaceDir, ".twinkle");
  const metadataPath = path.join(metadataDir, "lumine-project.json");
  const authFile = path.join(tmpDir, "auth.json");
  let buildLoadCount = 0;
  let updateFromMainRequestBody = null;
  const server = http.createServer(async (req, res) => {
    const requestBody = await readRequestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "cli-user",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/build/22/files?includeContent=0"
    ) {
      buildLoadCount += 1;
      if (buildLoadCount > 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporary metadata failure" }));
        return;
      }
      res.end(
        JSON.stringify({
          build: {
            id: 22,
            title: "Branch before sync",
            role: "owner",
            canWrite: true,
            canPublish: false,
            contributionStatus: "draft",
            contributionRootBuildId: 11,
            contributionBranchNumber: 1,
          },
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/build/11/contributions/22/update-from-main"
    ) {
      updateFromMainRequestBody = JSON.parse(requestBody);
      res.end(
        JSON.stringify({
          success: true,
          contribution: {
            id: 22,
            title: "Branch after sync",
            contributionStatus: "draft",
            contributionRootBuildId: 11,
            contributionBranchNumber: 1,
          },
          projectFiles: [
            { path: "/index.html", content: "<main>merged</main>" },
          ],
          filesHash: "post-sync-hash",
          autoMergedPaths: ["/index.html"],
          conflicts: [],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "index.html"), "<main>local</main>");
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      schemaVersion: 1,
      buildId: 22,
      build: {
        id: 22,
        title: "Branch before sync",
        role: "owner",
        canWrite: true,
        canPublish: false,
        contributionStatus: "draft",
        contributionRootBuildId: 11,
        contributionBranchNumber: 1,
      },
      apiUrl,
      filesHash: "pre-sync-hash",
    }),
    "utf8",
  );
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );

  const result = await runCli([
    "update-from-main",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--dir",
    workspaceDir,
    "--no-update-check",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(buildLoadCount, 2);
  assert.deepEqual(updateFromMainRequestBody, {
    projectFiles: [{ path: "/index.html", content: "<main>local</main>" }],
    baseFilesHash: "pre-sync-hash",
  });
  assert.equal(
    fs.readFileSync(path.join(workspaceDir, "index.html"), "utf8"),
    "<main>merged</main>",
  );
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.filesHash, "post-sync-hash");
  assert.equal(metadata.build.title, "Branch after sync");
  assert.equal(metadata.build.canWrite, true);
  assert.equal(metadata.build.canPublish, false);
});

test("CLI rename handles workspace, explicit-target, and missing-title modes", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-rename-test-"));
  const workspaceDir = path.join(tmpDir, "workspace");
  const metadataDir = path.join(workspaceDir, ".twinkle");
  const metadataPath = path.join(metadataDir, "lumine-project.json");
  const authFile = path.join(tmpDir, "auth.json");
  const renameBodies = [];
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    const body = await readRequestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "cli-user",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/build/1835/files?includeContent=0"
    ) {
      res.end(
        JSON.stringify({
          build: {
            id: 1835,
            title: "Old title",
            role: "owner",
            canWrite: true,
            canPublish: true,
          },
        }),
      );
      return;
    }
    if (req.method === "PUT" && req.url === "/build/1835") {
      const renameBody = JSON.parse(body || "{}");
      renameBodies.push(renameBody);
      res.end(
        JSON.stringify({
          success: true,
          build: {
            id: 1835,
            title: renameBody.title,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      schemaVersion: 1,
      buildId: 1835,
      build: {
        id: 1835,
        title: "Old title",
        role: "owner",
        canWrite: true,
        canPublish: true,
      },
      apiUrl,
      manifest: { entryPath: "/index.html" },
      filesHash: "canonical-files-hash",
    }),
    "utf8",
  );
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );

  const result = await runCli([
    "rename",
    "2026",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--dir",
    workspaceDir,
    "--no-update-check",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(renameBodies, [{ title: "2026" }]);
  assert.match(result.stdout, /Renamed Build #1835 to "2026"\./);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.build.title, "2026");
  assert.equal(metadata.build.role, "owner");
  assert.equal(metadata.build.canWrite, true);
  assert.equal(metadata.build.canPublish, true);
  assert.equal(metadata.filesHash, "canonical-files-hash");

  const explicitTargetResult = await runCli([
    "rename",
    "New Title",
    "--target",
    "1835",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--dir",
    tmpDir,
    "--no-update-check",
  ]);
  assert.equal(explicitTargetResult.code, 0, explicitTargetResult.stderr);
  assert.deepEqual(renameBodies, [
    { title: "2026" },
    { title: "New Title" },
  ]);
  assert.match(
    explicitTargetResult.stdout,
    /Renamed Build #1835 to "New Title"\./,
  );

  const requestCountBeforeMissingTitle = requestCount;
  const missingTitleResult = await runCli([
    "rename",
    "--target",
    "1835",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--dir",
    tmpDir,
    "--no-update-check",
  ]);
  assert.equal(missingTitleResult.code, 1);
  assert.match(missingTitleResult.stderr, /Pass a title:/);
  assert.equal(requestCount, requestCountBeforeMissingTitle);
});

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
