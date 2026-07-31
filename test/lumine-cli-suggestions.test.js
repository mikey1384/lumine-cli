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

test("suggestion commands parse branch notes, inbox targets, and actions", () => {
  const branch = parseArgs(["suggest", "branch", "Ready for review"]);
  assert.equal(branch.suggestionAction, "branch");
  assert.equal(branch.note, "Ready for review");
  assert.equal(branch.target, "");

  const list = parseArgs(["suggestions", "884"]);
  assert.equal(list.suggestionAction, "list");
  assert.equal(list.target, "884");

  const merge = parseArgs(["suggestions", "merge", "44", "--build", "884"]);
  assert.equal(merge.suggestionAction, "merge");
  assert.equal(merge.suggestionId, "44");
  assert.equal(merge.buildIdFlag, "884");

  const nextPage = parseArgs([
    "suggestions",
    "884",
    "--cursor",
    "40",
  ]);
  assert.equal(nextPage.cursor, 40);
});

test("branch authors send both server-issued nudges from the CLI", async (t) => {
  const fixture = await createFixtureServer(t, {
    build: {
      id: 901,
      title: "Edit branch",
      contributionRootBuildId: 884,
      contributionBranchNumber: 4,
      contributionStatus: "draft",
      canWrite: true,
      canPublish: false,
    },
  });

  const branchResult = await runCli([
    "suggest",
    "branch",
    "Ready for review",
    "--target",
    "901",
    ...fixture.cliArgs,
  ]);
  assert.equal(branchResult.code, 0, branchResult.stderr);
  assert.match(branchResult.stdout, /Sent branch #901/);

  const thumbnailResult = await runCli([
    "suggest",
    "thumbnail",
    "--target",
    "901",
    ...fixture.cliArgs,
  ]);
  assert.equal(thumbnailResult.code, 0, thumbnailResult.stderr);
  assert.match(thumbnailResult.stdout, /Suggested branch #901's thumbnail/);

  const branchRequest = fixture.requests.find(
    (request) =>
      request.method === "POST" &&
      request.url === "/build/884/contributions/901/notify-owner",
  );
  assert.deepEqual(branchRequest?.body, { note: "Ready for review" });
  assert.equal(
    fixture.requests.some(
      (request) =>
        request.method === "POST" &&
        request.url === "/build/884/contributions/901/suggest-thumbnail",
    ),
    true,
  );
});

test("owners list and act on exact open suggestions", async (t) => {
  const suggestedThumbnailUrl = "https://images.example/frozen.png";
  const fixture = await createFixtureServer(t, {
    build: {
      id: 884,
      title: "Twinkle Book Maker",
      contributionStatus: "none",
      canWrite: true,
      canPublish: true,
    },
    suggestions: [
      {
        id: 44,
        type: "branch",
        rootBuildId: 884,
        branchBuildId: 901,
        branchNumber: 4,
        contributorUsername: "Cloudstar",
        note: "Ready for review",
        diffSummary: { total: 2 },
        createdAt: 100,
      },
      {
        id: 45,
        type: "thumbnail",
        rootBuildId: 884,
        branchBuildId: 901,
        branchNumber: 4,
        contributorUsername: "Cloudstar",
        suggestedThumbnailUrl,
        currentThumbnailUrl: "https://images.example/current.png",
        createdAt: 110,
      },
    ],
  });

  const listResult = await runCli(["suggestions", "884", ...fixture.cliArgs]);
  assert.equal(listResult.code, 0, listResult.stderr);
  assert.match(listResult.stdout, /\[#44\] Cloudstar submitted branch 4/);
  assert.match(
    listResult.stdout,
    /lumine suggestions replace-main 44 --build 884/,
  );
  assert.match(listResult.stdout, /\[#45\] Cloudstar suggested a thumbnail/);

  const mergeResult = await runCli([
    "suggestions",
    "merge",
    "44",
    "--build",
    "884",
    ...fixture.cliArgs,
  ]);
  assert.equal(mergeResult.code, 0, mergeResult.stderr);
  assert.match(mergeResult.stdout, /Merged branch #901/);

  const thumbnailResult = await runCli([
    "suggestions",
    "adopt-thumbnail",
    "45",
    "--build",
    "884",
    "--yes",
    ...fixture.cliArgs,
  ]);
  assert.equal(thumbnailResult.code, 0, thumbnailResult.stderr);
  assert.match(thumbnailResult.stdout, /Applied thumbnail suggestion #45/);

  assert.equal(
    fixture.requests.some(
      (request) =>
        request.method === "GET" &&
        request.url === "/build/884/suggestions?suggestionId=44",
    ),
    true,
  );
  assert.equal(
    fixture.requests.some(
      (request) =>
        request.method === "POST" &&
        request.url === "/build/884/contributions/901/merge",
    ),
    true,
  );
  const adoptRequest = fixture.requests.find(
    (request) =>
      request.method === "POST" &&
      request.url === "/build/884/contributions/901/adopt-thumbnail",
  );
  assert.deepEqual(adoptRequest?.body, {
    suggestionMessageId: 45,
    thumbnailUrl: suggestedThumbnailUrl,
  });
});

async function createFixtureServer(t, { build, suggestions = [] }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-suggestions-"));
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
    if (
      req.method === "GET" &&
      req.url === `/cli/build/${build.id}/files?includeContent=0`
    ) {
      res.end(JSON.stringify({ build }));
      return;
    }
    if (
      req.method === "GET" &&
      req.url.startsWith("/build/884/suggestions")
    ) {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      const suggestionId = Number(
        requestUrl.searchParams.get("suggestionId") || 0,
      );
      res.end(
        JSON.stringify({
          buildId: 884,
          suggestions: suggestionId
            ? suggestions.filter(
                (suggestion) => Number(suggestion.id) === suggestionId,
              )
            : suggestions,
          hasMore: false,
          nextCursor: null,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/notify-owner")) {
      res.end(JSON.stringify({ message: { id: 51 } }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/suggest-thumbnail")) {
      res.end(JSON.stringify({ message: { id: 52 } }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/merge")) {
      res.end(JSON.stringify({ success: true, projectFiles: [] }));
      return;
    }
    if (req.method === "POST" && req.url.endsWith("/adopt-thumbnail")) {
      res.end(
        JSON.stringify({
          success: true,
          build: { id: 884, thumbnailUrl: "https://images.example/adopted.png" },
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
  return {
    requests,
    cliArgs: [
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
    ],
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
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
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}
