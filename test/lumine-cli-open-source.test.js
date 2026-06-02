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
const cliSource = fs.readFileSync(
  path.resolve(__dirname, "../bin/lumine.js"),
  "utf8",
);
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

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
  assert.match(cliSource, /"diff"/);
  assert.match(cliSource, /"merge"/);
  assert.match(cliSource, /"replace-main"/);
  assert.match(cliSource, /async function diff\(options\)/);
  assert.match(cliSource, /async function mergeBranch\(options\)/);
  assert.match(cliSource, /async function replaceMainWithBranch\(options\)/);
  assert.match(cliSource, /function resolveBuildReference\(value\)/);
  assert.match(cliSource, /branchNumber: Number\(parts\[buildIndex \+ 2\]\) \|\| 0/);
  assert.match(cliSource, /\/cli\/build\/\$\{rootBuildId\}\/branches\/\$\{branchNumber\}/);
  assert.match(cliSource, /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}/);
  assert.match(cliSource, /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}\/merge/);
  assert.match(cliSource, /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}\/replace-main/);
});

test("CLI can create a new Build without starting an AI run", () => {
  assert.match(cliSource, /"new"/);
  assert.match(cliSource, /async function newBuild\(options\)/);
  assert.match(
    cliSource,
    /async function newBuild\(options\) \{[\s\S]*const title = await resolveNewBuildTitle\(options\);[\s\S]*const auth = await ensureAuth\(options\)/,
  );
  assert.match(cliSource, /async function createBuild\(\{ options, auth, title, description \}\)/);
  assert.match(cliSource, /url: `\$\{options\.apiUrl\}\/build\/create`/);
  assert.match(cliSource, /resolveNewBuildTitle\(options\)/);
  assert.match(cliSource, /resolveNewBuildDescription\(options\)/);
  assert.match(cliSource, /raw\.title/);
  assert.match(cliSource, /raw\.description/);
  assert.match(cliSource, /noDescription/);
  assert.match(cliSource, /!input\.isTTY \|\| !output\.isTTY/);
  assert.match(cliSource, /await pullBuildFiles\(\{ options, auth, buildId \}\)/);
  assert.doesNotMatch(cliSource, /build_generate_greeting/);
  assert.doesNotMatch(cliSource, /build_generate[^_]/);
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
      res.end(JSON.stringify({ userId: 7, username: "cli-user", scopes: ["build:read", "build:write"] }));
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
  fs.writeFileSync(authFile, JSON.stringify({ token: "test-token", apiUrl }), "utf8");

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
  assert.match(result.stdout, /No project files yet\. Create \/index\.html before your first save\./);
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
  assert.equal(fs.existsSync(path.join(workspaceDir, ".twinkle", "lumine-project.json")), true);
});

test("CLI blocks saves from read-only branch checkouts", () => {
  assert.match(cliSource, /metadata\.build\?\.canWrite === false/);
  assert.match(cliSource, /This Lumine checkout is read-only/);
  assert.match(cliSource, /build\?\.canWrite === false/);
  assert.match(cliSource, /Review changes: lumine diff/);
  assert.match(cliSource, /Owner actions: lumine merge, or lumine replace-main/);
});

test("CLI references are marked read-only and blocked from save", () => {
  assert.match(cliSource, /LUMINE_REFERENCE_INSTRUCTIONS_MARKER/);
  assert.match(cliSource, /async function writeReferenceMetadata/);
  assert.match(cliSource, /readOnly: true[\s\S]*role: "reference"[\s\S]*canWrite: false[\s\S]*canPublish: false/);
  assert.match(cliSource, /assertLocalProjectCanBeSaved\(localProject\)/);
  assert.match(cliSource, /metadata\?\.reference\?\.readOnly === true/);
  assert.match(cliSource, /lumine fork/);
});

test("CLI explore supports search and fork-oriented sorting", () => {
  assert.match(cliSource, /searchQuery:[\s\S]*command === "explore"/);
  assert.match(cliSource, /function normalizeOpenSourceSort\(value\)/);
  assert.match(cliSource, /return "forks"/);
  assert.match(cliSource, /url\.searchParams\.set\("sort", options\.sort\)/);
  assert.match(cliSource, /url\.searchParams\.set\("search", options\.searchQuery\)/);
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
