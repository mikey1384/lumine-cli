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

test("upgrade accepts a project URL or the current selected project", () => {
  const target = parseArgs(["upgrade", "https://www.twin-kle.com/build/884/4"]);
  assert.equal(target.command, "upgrade");
  assert.equal(target.target, "https://www.twin-kle.com/build/884/4");

  const selected = parseArgs(["upgrade"]);
  assert.equal(selected.command, "upgrade");
  assert.equal(selected.target, "");
});

test("upgrade prints only the canonical project limits returned by Twinkle", async (t) => {
  const fixture = await createFixtureServer(t);
  const upgraded = await runCli([
    "upgrade",
    "https://www.twin-kle.com/build/884/4",
    ...fixture.cliArgs,
  ]);
  assert.equal(upgraded.code, 0, upgraded.stderr);
  assert.equal(upgraded.stderr, "");
  assert.match(
    upgraded.stdout,
    /Upgraded Nexus \(#884\) to 500 project files and 5\.0 MB\./,
  );

  const alreadyUpgraded = await runCli(["upgrade", ...fixture.cliArgs]);
  assert.equal(alreadyUpgraded.code, 0, alreadyUpgraded.stderr);
  assert.match(
    alreadyUpgraded.stdout,
    /Nexus \(#884\) already has 500 project files and 5\.0 MB\./,
  );

  const invalidTarget = await runCli([
    "upgrade",
    "not-a-project",
    ...fixture.cliArgs,
  ]);
  assert.equal(invalidTarget.code, 1);
  assert.match(invalidTarget.stderr, /Pass a Twinkle build URL/);

  const fractionalTarget = await runCli([
    "upgrade",
    "884.5",
    ...fixture.cliArgs,
  ]);
  assert.equal(fractionalTarget.code, 1);
  assert.match(fractionalTarget.stderr, /positive integer build id/);

  assert.deepEqual(
    fixture.requests
      .filter((request) => request.url === "/build/884/project-limit-upgrade")
      .map((request) => ({ method: request.method, body: request.body })),
    [
      { method: "PUT", body: {} },
      { method: "PUT", body: {} },
    ],
  );
  assert.equal(
    fixture.requests.some((request) =>
      request.url.startsWith("/cli/build/884/files"),
    ),
    false,
  );
});

async function createFixtureServer(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-upgrade-"));
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  let upgradeCount = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "mikey",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (
      req.method === "PUT" &&
      req.url === "/build/884/project-limit-upgrade"
    ) {
      upgradeCount += 1;
      res.end(
        JSON.stringify({
          success: true,
          changed: upgradeCount === 1,
          build: {
            id: 884,
            title: "Nexus",
            projectLimits: {
              maxFilesPerProject: 500,
              maxProjectBytes: 5 * 1024 * 1024,
              maxFileLines: 500,
            },
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
    JSON.stringify({ token: "test-token", apiUrl, selectedBuildId: 884 }),
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
