import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../lib/commands.js";
import { requestJson } from "../lib/http.js";
import {
  detectSponsorAgentSession,
  sponsorDutyStatePath,
} from "../lib/sponsor-duty.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

test("sponsor duty and same-session job flags remain distinct", () => {
  const duty = parseArgs([
    "sponsor",
    "duty",
    "start",
    "--provider",
    "codex",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "max",
    "--service-tier",
    "priority",
  ]);
  assert.deepEqual(duty.sponsorArgs, ["duty", "start"]);
  assert.equal(duty.provider, "codex");
  assert.equal(duty.model, "gpt-5.6-sol");
  assert.equal(duty.sponsorEffort, "max");
  assert.equal(duty.sponsorServiceTier, "priority");

  const job = parseArgs([
    "sponsor",
    "job",
    "helper-complete",
    "41",
    "--ordinal",
    "2",
    "--outcome",
    "Reviewed the interaction and fixed the concrete gap",
    "--resolved-model",
    "gpt-5.6-sol",
  ]);
  assert.deepEqual(job.sponsorArgs, ["job", "helper-complete", "41"]);
  assert.equal(job.sponsorAgentOrdinal, "2");
  assert.equal(
    job.sponsorOutcome,
    "Reviewed the interaction and fixed the concrete gap",
  );
  assert.equal(job.sponsorResolvedModel, "gpt-5.6-sol");

  const update = parseArgs([
    "sponsor",
    "job",
    "update",
    "41",
    "--file",
    "/tmp/lumine-update.txt",
    "--phase",
    "checking",
  ]);
  assert.deepEqual(update.sponsorArgs, ["job", "update", "41"]);
  assert.equal(update.sponsorUpdateFile, "/tmp/lumine-update.txt");
  assert.equal(update.sponsorUpdatePhase, "checking");
});

test("agent-session detection is stable and provider-specific", () => {
  const first = detectSponsorAgentSession({
    environment: { CODEX_SESSION_ID: "codex-session-one" },
    ancestry: { codex: null, claude: null },
  });
  const repeated = detectSponsorAgentSession({
    environment: { CODEX_SESSION_ID: "codex-session-one" },
    ancestry: { codex: null, claude: null },
  });
  const other = detectSponsorAgentSession({
    environment: { CODEX_SESSION_ID: "codex-session-two" },
    ancestry: { codex: null, claude: null },
  });
  const claude = detectSponsorAgentSession({
    environment: { CLAUDE_CODE_SESSION_ID: "claude-session-one" },
    ancestry: { codex: null, claude: null },
  });

  assert.equal(first.mode, "agent_session_v2");
  assert.equal(first.provider, "codex");
  assert.equal(first.bindingEvidence, "runtime_session_id");
  assert.match(first.runtimeVersion, /codex/i);
  assert.equal(first.fingerprintHash.length, 64);
  assert.equal(first.fingerprintHash, repeated.fingerprintHash);
  assert.notEqual(first.fingerprintHash, other.fingerprintHash);
  assert.equal(claude.provider, "claude-code");
  assert.throws(
    () =>
      detectSponsorAgentSession({
        environment: {},
        ancestry: { codex: null, claude: null },
      }),
    /active Codex or Claude Code agent session/,
  );
  assert.notEqual(
    sponsorDutyStatePath({
      apiUrl: "https://api.example.test",
      authFile: "/tmp/lumine-auth-one.json",
    }),
    sponsorDutyStatePath({
      apiUrl: "https://api.example.test",
      authFile: "/tmp/lumine-auth-two.json",
    }),
  );
});

test("a switched login cannot discard another account's local duty lease", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-account-switch-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      assert.equal(req.headers.authorization, "Bearer different-account-token");
      res.end(JSON.stringify({ userId: 99, username: "different-user" }));
      return;
    }
    if (req.method === "GET" && req.url === "/cli/sponsor/status") {
      res.end(JSON.stringify({ duties: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(
    authFile,
    JSON.stringify({
      token: "different-account-token",
      userId: 99,
      username: "different-user",
      apiUrl,
    }),
    { mode: 0o600 },
  );
  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      apiUrl,
      sponsorUserId: 5,
      operatorSession: detectSponsorAgentSession({
        environment: codexEnvironment("original-owner-session"),
        ancestry: { codex: null, claude: null },
      }),
      duty: { ...canonicalDuty(), leaseToken: "original-duty-lease" },
      jobs: {},
      preservedWorkspaces: [],
    }),
    { mode: 0o600 },
  );

  const stopped = await runCli(
    [
      "sponsor",
      "duty",
      "stop",
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--auth-token",
      "different-account-token",
      "--no-update-check",
    ],
    { environment: codexEnvironment("different-session") },
  );

  assert.equal(stopped.code, 1);
  assert.match(stopped.stderr, /belongs to account user 5/);
  assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).sponsorUserId, 5);
});

test("ordinary accounts can browser-login but cannot acquire sponsor authority", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-login-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/cli/device/start") {
      res.end(
        JSON.stringify({
          deviceCode: "device-code",
          userCode: "USER-CODE",
          verificationUri: "https://example.test/cli/approve",
          verificationUriComplete:
            "https://example.test/cli/approve?code=USER-CODE",
          interval: 1,
          expiresIn: 10,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/cli/device/token") {
      res.end(
        JSON.stringify({
          accessToken: "ordinary-account-token",
          expiresIn: 3600,
          user: { id: 99, username: "ordinary-user" },
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/duty/start") {
      res.statusCode = 403;
      res.end(
        JSON.stringify({
          error: "An approved sponsor account is required before starting duty.",
          code: "build_sponsor_approval_required",
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await runCli(
    [
      "sponsor",
      "duty",
      "start",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "max",
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
      "--no-open",
    ],
    { environment: codexEnvironment("login-test-session") },
  );

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Approval link: https:\/\/example\.test\/cli\/approve/);
  assert.match(result.stdout, /Logged in as ordinary-user\./);
  assert.match(
    result.stderr,
    /An approved sponsor account is required before starting duty\./,
  );
  const dutyRequest = requests.find(
    (request) => request.url === "/cli/sponsor/duty/start",
  );
  assert.equal(dutyRequest?.auth, "Bearer ordinary-account-token");
  assert.equal(dutyRequest?.body?.operatorSession?.mode, "agent_session_v2");
  assert.equal(dutyRequest?.body?.operatorSession?.provider, "codex");
  assert.equal(dutyRequest?.body?.operatorSession?.fingerprintHash.length, 64);
  const savedAuth = JSON.parse(await fs.readFile(authFile, "utf8"));
  assert.equal(savedAuth.username, "ordinary-user");
  assert.equal(savedAuth.userId, 99);
});

test("duty start exits, bounded watches recover transport, and another session cannot inherit it", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-session-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  let claimCount = 0;
  let heartbeatCount = 0;
  const duty = canonicalDuty();
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/cli/sponsor/duty/start") {
      assert.equal(body.operatorSession.mode, "agent_session_v2");
      assert.equal(body.operatorSession.provider, "codex");
      res.end(
        JSON.stringify({
          duty,
          leaseToken: "duty-lease",
          heartbeatEverySeconds: 20,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/duty/4/heartbeat"
    ) {
      heartbeatCount += 1;
      assert.equal(body.operatorSession.provider, "codex");
      if (heartbeatCount === 1) {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify({ ...duty, heartbeatAt: 100, expiresAt: 145 }));
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/claim") {
      claimCount += 1;
      if (claimCount === 1) {
        req.socket.destroy();
        return;
      }
      res.end(JSON.stringify({ job: null }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  await fs.chmod(tmpDir, 0o755);
  const sharedArgs = [
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
    "--no-open",
  ];

  const start = await runCli(
    [
      "sponsor",
      "duty",
      "start",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "max",
      "--json",
      ...sharedArgs,
    ],
    { environment: codexEnvironment("owner-session") },
  );
  assert.equal(start.code, 0);
  assert.equal(JSON.parse(start.stdout).executionMode, "agent_session_v2");
  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  const stateStat = await fs.stat(statePath);
  assert.equal(stateStat.mode & 0o777, 0o600);
  assert.equal((await fs.stat(tmpDir)).mode & 0o777, 0o755);

  const watch = await runCli(
    [
      "sponsor",
      "duty",
      "watch",
      "--wait-ms",
      "3500",
      "--poll-ms",
      "1000",
      "--json",
      ...sharedArgs,
    ],
    { environment: codexEnvironment("owner-session") },
  );
  assert.equal(watch.code, 0);
  assert.equal(JSON.parse(watch.stdout).assignment, null);
  assert.match(
    watch.stderr,
    /Workshop check-in failed; retrying while this watch is active: fetch failed/,
  );
  assert(heartbeatCount >= 1);
  assert(claimCount >= 2);

  const claimsBeforeMismatch = claimCount;
  const mismatch = await runCli(
    ["sponsor", "duty", "watch", "--wait-ms", "1000", ...sharedArgs],
    { environment: codexEnvironment("different-session") },
  );
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /belongs to a different live agent session/);
  assert.equal(claimCount, claimsBeforeMismatch);

  const sponsorSource = await fs.readFile(
    path.resolve(__dirname, "../lib/sponsor-duty.js"),
    "utf8",
  );
  assert.doesNotMatch(sponsorSource, /agentCommand|runWorkshopAgentPass/);
  assert.match(sponsorSource, /same live .* agent session/);
});

test("HTTP timeouts cover a response body that stalls after headers", async (t) => {
  const sockets = new Set();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const startedAt = Date.now();
  await assert.rejects(
    requestJson({
      url: `http://127.0.0.1:${server.address().port}/stalled-json`,
      timeoutMs: 100,
    }),
    (error) => error?.code === "lumine_http_timeout",
  );
  assert(Date.now() - startedAt < 1_000);
});

test("a stalled duty watch hits its hard deadline, releases its lock, and recovers", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-watch-deadline-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const sockets = new Set();
  const duty = canonicalDuty();
  let heartbeatCount = 0;
  const server = http.createServer(async (req, res) => {
    await readRequestBody(req);
    if (req.method === "POST" && req.url === "/cli/sponsor/duty/start") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          duty,
          leaseToken: "duty-lease",
          heartbeatEverySeconds: 20,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/duty/4/heartbeat"
    ) {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"id":4');
        return;
      }
      const now = Math.floor(Date.now() / 1_000);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ...duty, heartbeatAt: now, expiresAt: now + 90 }));
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/claim") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ job: null }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  const sharedArgs = [
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
    "--no-open",
  ];
  const environment = codexEnvironment("watch-deadline-session");

  const start = await runCli(
    [
      "sponsor",
      "duty",
      "start",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "max",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(start.code, 0, start.stderr);

  const watchStartedAt = Date.now();
  const stalledWatch = await runCli(
    [
      "sponsor",
      "duty",
      "watch",
      "--wait-ms",
      "1000",
      "--timeout-ms",
      "30000",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(stalledWatch.code, 1);
  assert.match(stalledWatch.stderr, /hard deadline.*state lock was released/i);
  assert(Date.now() - watchStartedAt < 5_000);
  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  await assert.rejects(fs.stat(`${statePath}.lock`), { code: "ENOENT" });

  const recoveredWatch = await runCli(
    [
      "sponsor",
      "duty",
      "watch",
      "--wait-ms",
      "1000",
      "--timeout-ms",
      "1000",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(recoveredWatch.code, 0, recoveredWatch.stderr);
  assert.equal(JSON.parse(recoveredWatch.stdout).assignment, null);
  assert(heartbeatCount >= 2);
});

test("duty watch surfaces a team invitation without claiming Workshop work", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-team-invite-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const duty = canonicalDuty();
  const teamAccessRequest = {
    id: 17,
    buildId: 91,
    buildTitle: "Adopt Me\u001b[31m\nFAKE",
    requesterUserId: 263,
    requesterUsername: "programmer",
    ownerUserId: 554,
    ownerUsername: "turtle",
    sponsorUserId: 5,
    sponsorUsername: "mikey",
    personaUserId: 2,
    status: "pending_sponsor",
  };
  const server = http.createServer(async (req, res) => {
    await readRequestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/cli/sponsor/duty/start") {
      res.end(
        JSON.stringify({
          duty,
          leaseToken: "duty-lease",
          heartbeatEverySeconds: 20,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/duty/4/heartbeat"
    ) {
      const now = Math.floor(Date.now() / 1000);
      res.end(JSON.stringify({ ...duty, heartbeatAt: now, expiresAt: now + 90 }));
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/claim") {
      res.end(JSON.stringify({ job: null, teamAccessRequest }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  const sharedArgs = [
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
    "--no-open",
  ];
  const environment = codexEnvironment("team-invite-session");

  const start = await runCli(
    [
      "sponsor",
      "duty",
      "start",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "max",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(start.code, 0, start.stderr);

  const watch = await runCli(
    ["sponsor", "duty", "watch", "--json", "--wait-ms", "1000", ...sharedArgs],
    { environment },
  );
  assert.equal(watch.code, 0, watch.stderr);
  const output = JSON.parse(watch.stdout);
  assert.equal(output.assignment, null);
  assert.deepEqual(output.teamAccessRequest, teamAccessRequest);
  assert.equal(output.nextCommand, "lumine sponsor duty watch --json");
  const terminalWatch = await runCli(
    ["sponsor", "duty", "watch", "--wait-ms", "1000", ...sharedArgs],
    { environment },
  );
  assert.equal(terminalWatch.code, 0, terminalWatch.stderr);
  assert.doesNotMatch(terminalWatch.stdout, /\u001b|\nFAKE/);
  assert.match(terminalWatch.stdout, /Adopt Me/);
  const state = JSON.parse(
    await fs.readFile(sponsorDutyStatePath({ apiUrl, authFile }), "utf8"),
  );
  assert.deepEqual(state.jobs, {});
});

test("an approved claim becomes a scoped assignment for the owning session without launching a provider", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-assignment-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  let claimed = false;
  let jobStatus = "leased";
  let saveBody = null;
  let saveCount = 0;
  let canonicalSavedArtifact = null;
  let sponsorForumAccess = true;
  let agentCompletionBody = null;
  const dialogueBodies = [];
  const requests = [];
  const duty = canonicalDuty();
  const relay = {
    id: 101,
    kind: "initial_request",
    summary: "Add a visible start button and a score counter.",
    projectTitleHint: "Adopt Me",
    requestedOutcome: "A playable first round",
    constraints: ["Keep the existing character art"],
    acceptanceCriteria: ["The start button begins a round"],
    dialogueText:
      "Add a visible start button and a score counter.\n\nProject: Adopt Me\n\nWhat to build: A playable first round\n\nKeeping in mind:\n• Keep the existing character art\n\nDone means:\n• The start button begins a round",
    createdAt: 100,
  };
  const finalProjectSource =
    '<!doctype html><button id="start">Start</button><output>0</output>';
  const finalFilesHash = createHash("sha256")
    .update("/index.html")
    .update("\0")
    .update(finalProjectSource)
    .update("\0")
    .digest("hex");
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/sponsor/agreement") {
      res.end(
        JSON.stringify({
          version: "2026-08-31",
          disclosure: ["Same live agent session performs the work."],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/agreement/accept"
    ) {
      assert.equal(body.agreementVersion, "2026-08-31");
      assert.equal(body.agreementAccepted, true);
      res.end(
        JSON.stringify({
          changed: true,
          agreementVersion: "2026-08-31",
          acceptedAt: 100,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/duty/start") {
      res.end(
        JSON.stringify({
          duty,
          leaseToken: "duty-lease",
          heartbeatEverySeconds: 20,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/duty/4/heartbeat"
    ) {
      res.end(JSON.stringify({ ...duty, heartbeatAt: 100, expiresAt: 145 }));
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/claim") {
      if (claimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      claimed = true;
      res.end(JSON.stringify(workshopClaim(relay)));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/cli/build/73/files")) {
      assert.equal(req.headers.authorization, "Bearer workspace-access");
      res.end(
        JSON.stringify({
          build: {
            id: 73,
            title: "mikey's Adopt Me branch",
            contributionRootBuildId: 41,
            contributionBranchNumber: 2,
            canWrite: true,
          },
          projectFiles: [
            {
              path: "index.html",
              content: "<!doctype html><title>Adopt Me</title>",
            },
          ],
          filesHash: "base-files-hash",
          projectManifest: null,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/cli/session") {
      assert.equal(req.headers.authorization, "Bearer workspace-access");
      res.end(
        JSON.stringify({
          userId: 5,
          username: "mikey",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/cli/build/41/forum")) {
      assert.equal(req.headers.authorization, "Bearer sponsor-token");
      res.end(
        JSON.stringify({
          project: { id: 41, title: "Adopt Me" },
          requestedBuildId: 41,
          scope: {
            mode: "all",
            rootBuildId: 41,
            workspaceBuildId: 41,
            contributionBuildId: null,
          },
          events: [
            {
              type: "thread",
              id: 701,
              threadId: 701,
              activitySeq: 1,
              content: "The jump timing still feels too slow.",
            },
          ],
          pagination: {
            limit: 100,
            snapshotActivitySeq: 1,
            nextActivitySeq: 1,
            hasMore: false,
          },
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/heartbeat"
    ) {
      res.end(
        JSON.stringify({
          job: {
            ...workshopClaim(relay).job,
            forumAccess: sponsorForumAccess,
            ...(canonicalSavedArtifact
              ? {
                  workspaceFilesHash: finalFilesHash,
                  savedArtifact: canonicalSavedArtifact,
                }
              : {}),
            status: jobStatus,
          },
          relays: [relay],
          leaseExpiresAt: 220,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/9/agents") {
      jobStatus = "working";
      res.end(
        JSON.stringify({
          agentId: 77,
          role: "coordinator",
          ordinal: 0,
          startedAt: 101,
          changed: true,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/dialogue"
    ) {
      dialogueBodies.push(body);
      if (dialogueBodies.length === 1) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: "The canonical update committed but its response was lost",
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          changed: false,
          update: {
            id: 202,
            direction: "lumine_to_persona",
            speaker: "Lumine",
            message:
              "I found the round setup. I’m wiring the start control now.",
            kind: "progress",
            phase: "building",
            createdAt: 102,
          },
          dialogue: {
            requesterUserId: 5,
            jobId: 9,
            channelId: 88,
            topicId: null,
            persona: "zero",
            personaName: "Zero",
            jobStatus: "working",
            canProgress: true,
            dialogue: [],
          },
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/relays/close"
    ) {
      res.end(JSON.stringify({ closed: true, closedAt: 103, relays: [] }));
      return;
    }
    if (req.method === "PUT" && req.url === "/build/73/project-files") {
      assert.equal(req.headers.authorization, "Bearer workspace-access");
      saveCount += 1;
      saveBody = body;
      canonicalSavedArtifact = {
        artifactVersionId: 501,
        filesHash: finalFilesHash,
      };
      res.destroy();
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/agents/77/complete"
    ) {
      agentCompletionBody = body;
      res.end(JSON.stringify({ changed: true, status: "completed" }));
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/complete"
    ) {
      jobStatus = "completed";
      res.end(
        JSON.stringify({
          job: { ...workshopClaim(relay).job, status: "completed" },
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/relays/applied"
    ) {
      res.end(JSON.stringify({ changed: true, appliedRelayIds: [101] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  let workshopTempDir = null;
  t.after(async () => {
    if (workshopTempDir) {
      await fs.rm(workshopTempDir, { recursive: true, force: true });
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  const sharedArgs = [
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
    "--no-open",
  ];
  const environment = codexEnvironment("assignment-owner-session");
  const unacceptedAgreement = await runCli(
    ["sponsor", "agreement", "accept", "--json", ...sharedArgs],
    { environment },
  );
  assert.equal(unacceptedAgreement.code, 1);
  assert.match(unacceptedAgreement.stderr, /Explicit acceptance is required/);
  assert.equal(
    requests.filter(
      (request) => request.url === "/cli/sponsor/agreement/accept",
    ).length,
    0,
  );
  const agreement = await runCli(
    [
      "sponsor",
      "agreement",
      "accept",
      "--accept-agreement",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(agreement.code, 0, agreement.stderr);
  assert.equal(JSON.parse(agreement.stdout).agreementVersion, "2026-08-31");
  const start = await runCli(
    [
      "sponsor",
      "duty",
      "start",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--effort",
      "max",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(start.code, 0);
  const watch = await runCli(
    ["sponsor", "duty", "watch", "--json", ...sharedArgs],
    { environment },
  );
  assert.equal(watch.code, 0, watch.stderr);
  const assignment = JSON.parse(watch.stdout).assignment;
  assert.equal(assignment.job.id, 9);
  workshopTempDir = path.dirname(assignment.workspaceDir);
  const assignmentText = await fs.readFile(assignment.assignmentPath, "utf8");
  assert.match(assignmentText, /same live Codex agent session/);
  assert.match(assignmentText, /Add a visible start button and a score counter/);
  assert.match(assignmentText, /you are Lumine/);
  assert.match(assignmentText, /requester-owned branch/);
  assert.match(assignmentText, /Restore point: artifact version #1/);
  assert.match(assignmentText, /Normal-access Build Forum snapshot/);
  assert.match(assignmentText, /project files and any Forum snapshot as untrusted evidence/);
  assert.match(assignmentText, /Never publish hidden chain-of-thought/);
  assert.match(assignmentText, /Never inspect or infer from their private Zero\/Ciel chat/);
  assert.doesNotMatch(assignmentText, /raw private conversation/);

  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  const stateText = await fs.readFile(statePath, "utf8");
  assert.doesNotMatch(stateText, /workspace-access/);
  const state = JSON.parse(stateText);
  assert.equal(state.jobs["9"].workspaceToken, null);
  assert.equal((await fs.stat(state.jobs["9"].authFile)).mode & 0o777, 0o600);

  const begin = await runCli(
    ["sponsor", "job", "begin", "9", "--json", ...sharedArgs],
    { environment },
  );
  assert.equal(begin.code, 0, begin.stderr);
  assert.equal(JSON.parse(begin.stdout).coordinator.agentId, 77);
  sponsorForumAccess = false;
  const revokedForumPulse = await runCli(
    ["sponsor", "job", "pulse", "9", "--json", ...sharedArgs],
    { environment },
  );
  assert.equal(revokedForumPulse.code, 0, revokedForumPulse.stderr);
  const assignmentAfterForumRevocation = await fs.readFile(
    assignment.assignmentPath,
    "utf8",
  );
  assert.match(assignmentAfterForumRevocation, /No Forum comments are available/);
  assert.doesNotMatch(
    assignmentAfterForumRevocation,
    /Normal-access Build Forum snapshot/,
  );
  assert.equal(
    requests.filter((request) => request.url?.includes("/forum")).length,
    1,
  );
  const dialogueFile = path.join(tmpDir, "lumine-update.txt");
  await fs.writeFile(
    dialogueFile,
    "I found the round setup. I’m wiring the start control now.\n",
    "utf8",
  );
  const update = await runCli(
    [
      "sponsor",
      "job",
      "update",
      "9",
      "--file",
      dialogueFile,
      "--phase",
      "building",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(update.code, 0, update.stderr);
  assert.equal(
    update.stdout.trim(),
    "Lumine → Zero:\nI found the round setup. I’m wiring the start control now.",
  );
  assert.equal(
    dialogueBodies[1].message,
    "I found the round setup. I’m wiring the start control now.",
  );
  assert.equal(dialogueBodies[1].phase, "building");
  assert.equal(dialogueBodies.length, 2);
  assert.equal(
    dialogueBodies[0].clientUpdateKey,
    dialogueBodies[1].clientUpdateKey,
  );
  assert.match(dialogueBodies[1].clientUpdateKey, /^[A-Za-z0-9_-]{24}$/);
  const applied = await runCli(
    [
      "sponsor",
      "job",
      "relay-applied",
      "9",
      "101",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).appliedRelayIds, [101]);
  await fs.writeFile(
    path.join(assignment.workspaceDir, "index.html"),
    finalProjectSource,
    "utf8",
  );
  const interruptedCompletion = await runCli(
    [
      "sponsor",
      "job",
      "complete",
      "9",
      "--summary",
      "Added the approved start control and score display",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(interruptedCompletion.code, 1);
  assert.match(interruptedCompletion.stderr, /fetch failed|terminated|socket/i);
  const completed = await runCli(
    [
      "sponsor",
      "job",
      "complete",
      "9",
      "--summary",
      "Added the approved start control and score display",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).job.status, "completed");
  assert.equal(saveCount, 1);
  assert.equal(saveBody.baseFilesHash, "base-files-hash");
  assert.equal(saveBody.createVersion, true);
  assert.equal(saveBody.force, undefined);
  assert.equal(agentCompletionBody.evidenceTier, "provider_reported");
  assert.equal(agentCompletionBody.resolvedModel, "gpt-5.6-sol");
  assert.equal(agentCompletionBody.resolvedEffort, "max");
  assert.deepEqual(agentCompletionBody.outcome.changedPaths, ["/index.html"]);
  const sponsorJobRequests = requests.filter(
    (request) =>
      request.method === "POST" &&
      request.url?.startsWith("/cli/sponsor/jobs/"),
  );
  assert(sponsorJobRequests.length > 0);
  for (const request of sponsorJobRequests) {
    assert.equal(
      request.url === "/cli/sponsor/jobs/claim"
        ? request.body.leaseToken
        : request.body.dutyLeaseToken,
      "duty-lease",
    );
    assert.equal(request.body.operatorSession.mode, "agent_session_v2");
    assert.equal(request.body.operatorSession.provider, "codex");
  }
  const finalState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(finalState.jobs, {});
  await assert.rejects(fs.stat(workshopTempDir), { code: "ENOENT" });
  workshopTempDir = null;
  assert.equal(
    requests.some((request) => request.url?.includes("/agent/runtime")),
    false,
  );
  const forumRequests = requests.filter((request) =>
    request.url?.includes("/forum"),
  );
  assert.equal(forumRequests.length, 1);
  assert.equal(forumRequests[0].auth, "Bearer sponsor-token");
});

test("a consultation is inspected read-only and completes without an artifact or project change", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-consultation-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const environment = codexEnvironment("consultation-owner-session");
  const operatorSession = detectSponsorAgentSession({
    environment,
    ancestry: { codex: null, claude: null },
  });
  const duty = canonicalDuty();
  const relay = {
    id: 101,
    kind: "initial_request",
    jobKind: "consultation",
    summary: "Tell me about MID's Adopt Me project.",
    projectTitleHint: "Adopt Me",
    requestedOutcome:
      "Explain what it is, its current state, what is good, and what needs work.",
    constraints: ["Use simple language"],
    acceptanceCriteria: ["The answer is grounded in the actual project"],
    dialogueText:
      "Tell me about MID's Adopt Me project.\n\nProject: Adopt Me\n\nQuestion to answer: Explain what it is, its current state, what is good, and what needs work.",
    createdAt: 100,
  };
  const consultationProjectSource =
    "<!doctype html><title>Adopt Me</title><p>Choose a pet.</p>";
  const consultationFilesHash = createHash("sha256")
    .update("/index.html")
    .update("\0")
    .update(consultationProjectSource)
    .update("\0")
    .digest("hex");
  const claim = workshopClaim(relay, {
    jobKind: "consultation",
    targetBuild: {
      id: 41,
      title: "Main",
      kind: "main",
      rootBuildId: 41,
    },
    restorePoint: null,
    forumAccess: false,
    workspaceFilesHash: consultationFilesHash,
  });
  let claimed = false;
  let jobStatus = "leased";
  let agentCompletionBody = null;
  let completionBody = null;
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/duty/4/heartbeat"
    ) {
      res.end(JSON.stringify({ ...duty, heartbeatAt: 100, expiresAt: 145 }));
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/claim") {
      if (claimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      claimed = true;
      res.end(JSON.stringify(claim));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/cli/build/41/files")) {
      assert.equal(req.headers.authorization, "Bearer workspace-access");
      res.end(
        JSON.stringify({
          build: {
            id: 41,
            title: "Adopt Me",
            contributionRootBuildId: null,
            contributionBranchNumber: null,
            canWrite: false,
          },
          projectFiles: [
            {
              path: "index.html",
              content: consultationProjectSource,
            },
          ],
          filesHash: "persisted-token-is-not-consultation-content",
          projectManifest: null,
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url === "/cli/session") {
      assert.equal(req.headers.authorization, "Bearer workspace-access");
      res.end(
        JSON.stringify({
          userId: 5,
          username: "mikey",
          scopes: ["build:read"],
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/heartbeat"
    ) {
      res.end(
        JSON.stringify({
          job: { ...claim.job, status: jobStatus },
          relays: [relay],
          leaseExpiresAt: 220,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/9/agents") {
      jobStatus = "working";
      res.end(
        JSON.stringify({
          agentId: 77,
          role: "coordinator",
          ordinal: 0,
          startedAt: 101,
          changed: true,
        }),
      );
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/relays/applied"
    ) {
      res.end(JSON.stringify({ changed: true, appliedRelayIds: [101] }));
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/relays/close"
    ) {
      res.end(JSON.stringify({ closed: true, closedAt: 103, relays: [] }));
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/agents/77/complete"
    ) {
      agentCompletionBody = body;
      res.end(JSON.stringify({ changed: true, status: "completed" }));
      return;
    }
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/complete"
    ) {
      completionBody = body;
      jobStatus = "completed";
      res.end(
        JSON.stringify({
          job: { ...claim.job, status: "completed" },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  let workshopTempDir = null;
  t.after(async () => {
    if (workshopTempDir) {
      await fs.rm(workshopTempDir, { recursive: true, force: true });
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      apiUrl,
      sponsorUserId: 5,
      operatorSession,
      duty: { ...duty, leaseToken: "duty-lease", heartbeatEverySeconds: 20 },
      jobs: {},
      preservedWorkspaces: [],
    }),
    { mode: 0o600 },
  );
  const sharedArgs = [
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-update-check",
    "--no-open",
  ];
  const watch = await runCli(
    ["sponsor", "duty", "watch", "--json", ...sharedArgs],
    { environment },
  );
  assert.equal(watch.code, 0, watch.stderr);
  const assignment = JSON.parse(watch.stdout).assignment;
  workshopTempDir = path.dirname(assignment.workspaceDir);
  const assignmentText = await fs.readFile(assignment.assignmentPath, "utf8");
  assert.match(assignmentText, /read-only consultation/);
  assert.match(assignmentText, /what the project is, its current state/);
  assert.match(assignmentText, /no artifact or project change is created/);

  const begin = await runCli(
    ["sponsor", "job", "begin", "9", "--json", ...sharedArgs],
    { environment },
  );
  assert.equal(begin.code, 0, begin.stderr);
  const applied = await runCli(
    [
      "sponsor",
      "job",
      "relay-applied",
      "9",
      "101",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(applied.code, 0, applied.stderr);

  const projectPath = path.join(assignment.workspaceDir, "index.html");
  const originalProject = await fs.readFile(projectPath, "utf8");
  await fs.writeFile(projectPath, `${originalProject}\n<!-- accidental edit -->\n`);
  const rejected = await runCli(
    [
      "sponsor",
      "job",
      "complete",
      "9",
      "--summary",
      "It is a pet-choice game with a clear start, but it still needs more gameplay feedback.",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /read-only consultation/);
  assert.equal(agentCompletionBody, null);
  await fs.writeFile(projectPath, originalProject);

  const completed = await runCli(
    [
      "sponsor",
      "job",
      "complete",
      "9",
      "--summary",
      "It is a pet-choice game with a clear start, but it still needs more gameplay feedback.",
      "--json",
      ...sharedArgs,
    ],
    { environment },
  );
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).job.status, "completed");
  assert.equal(agentCompletionBody.outcome.readOnlyConsultation, true);
  assert.deepEqual(agentCompletionBody.outcome.changedPaths, []);
  assert.equal(completionBody.artifactVersionId, undefined);
  assert.equal(completionBody.branchNoticeMessageId, undefined);
  assert.match(completionBody.reportedFilesHash, /^[a-f0-9]{64}$/);
  assert.equal(
    requests.some(
      (request) =>
        request.method === "PUT" ||
        request.url?.includes("/forum") ||
        request.url?.includes("branch-notice") ||
        request.url?.includes("notify-owner"),
    ),
    false,
  );
  workshopTempDir = null;
});

test("ending a failed job preserves work but removes its credential", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-failed-job-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const jobAuthFile = path.join(tmpDir, "job-auth.json");
  const workspaceDir = path.join(tmpDir, "unfinished-workspace");
  await fs.mkdir(workspaceDir);
  await fs.writeFile(
    jobAuthFile,
    JSON.stringify({ token: "failed-workspace-access" }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(workspaceDir, "index.html"),
    "<!doctype html><title>Unfinished work</title>",
    "utf8",
  );
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (
      req.method === "POST" &&
      req.url === "/cli/sponsor/jobs/9/heartbeat"
    ) {
      assert.equal(body.dutyLeaseToken, "duty-lease");
      res.end(
        JSON.stringify({
          job: { id: 9, status: "working" },
          relays: [],
          leaseExpiresAt: 220,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/jobs/9/fail") {
      assert.equal(body.failureCode, "agent_session_failed");
      assert.equal(body.failureReason, "The implementation could not be completed");
      res.end(JSON.stringify({ job: { id: 9, status: "failed" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  const environment = codexEnvironment("failed-job-owner-session");
  const operatorSession = detectSponsorAgentSession({
    environment,
    ancestry: { codex: null, claude: null },
  });
  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      apiUrl,
      sponsorUserId: 5,
      operatorSession,
      duty: {
        ...canonicalDuty(),
        leaseToken: "duty-lease",
        heartbeatEverySeconds: 20,
      },
      jobs: {
        9: {
          job: { id: 9, status: "working" },
          attempt: { id: 11, number: 1, token: "attempt-token" },
          relays: [],
          appliedRelayIds: [],
          heartbeatEverySeconds: 40,
          leaseExpiresAt: 220,
          workspaceDir,
          tempDir: tmpDir,
          authFile: jobAuthFile,
          workspaceToken: null,
        },
      },
      preservedWorkspaces: [],
    }),
    { mode: 0o600 },
  );

  const failed = await runCli(
    [
      "sponsor",
      "job",
      "fail",
      "9",
      "--reason",
      "The implementation could not be completed",
      "--json",
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
    ],
    { environment },
  );

  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).preservedWorkspace, workspaceDir);
  const finalState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.deepEqual(finalState.jobs, {});
  assert.equal(finalState.preservedWorkspaces.length, 1);
  assert.equal(finalState.preservedWorkspaces[0].workspaceDir, workspaceDir);
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "index.html"), "utf8"),
    "<!doctype html><title>Unfinished work</title>",
  );
  await assert.rejects(fs.stat(jobAuthFile), { code: "ENOENT" });
});

test("stopping duty archives recoverable work without credentials", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-stop-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const jobTempDir = path.join(tmpDir, "lumine-zero-job-9-stopped");
  const workspaceDir = path.join(jobTempDir, "workspace");
  const jobAuthFile = path.join(jobTempDir, "job-auth.json");
  const legacyJobTempDir = path.join(tmpDir, "lumine-ciel-job-8-preserved");
  const legacyWorkspaceDir = path.join(legacyJobTempDir, "workspace");
  const legacyJobAuthFile = path.join(legacyJobTempDir, "job-auth.json");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(legacyWorkspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "index.html"),
    "<!doctype html><title>Recoverable work</title>",
    "utf8",
  );
  await fs.writeFile(
    jobAuthFile,
    JSON.stringify({ token: "archived-job-auth-token" }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(legacyWorkspaceDir, "index.html"),
    "<!doctype html><title>Previously preserved work</title>",
    "utf8",
  );
  await fs.writeFile(
    legacyJobAuthFile,
    JSON.stringify({ token: "legacy-preserved-job-auth-token" }),
    { mode: 0o600 },
  );
  const duty = canonicalDuty();
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/sponsor/status") {
      res.end(JSON.stringify({ duties: [duty] }));
      return;
    }
    if (req.method === "POST" && req.url === "/cli/sponsor/duty/state") {
      assert.equal(body.dutySessionId, duty.id);
      assert.equal(body.state, "stopped");
      res.end(JSON.stringify({ duty: { ...duty, state: "stopped" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `No mock for ${req.method} ${req.url}` }));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  await writeTestAuth(authFile, apiUrl);
  const environment = codexEnvironment("stopped-job-owner-session");
  const statePath = sponsorDutyStatePath({ apiUrl, authFile });
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      apiUrl,
      sponsorUserId: 5,
      operatorSession: detectSponsorAgentSession({
        environment,
        ancestry: { codex: null, claude: null },
      }),
      duty: { ...duty, leaseToken: "archived-duty-lease" },
      jobs: {
        9: {
          job: { id: 9, status: "working" },
          attempt: {
            id: 11,
            number: 1,
            token: "archived-attempt-token",
          },
          workspaceToken: {
            accessToken: "archived-workspace-token",
            expiresAt: 7200,
          },
          workspaceDir,
          tempDir: jobTempDir,
          authFile: jobAuthFile,
        },
      },
      preservedWorkspaces: [
        {
          jobId: 8,
          workspaceDir: legacyWorkspaceDir,
          reason: "Previously preserved by Lumine 0.2.58",
          preservedAt: new Date().toISOString(),
        },
      ],
    }),
    { mode: 0o600 },
  );

  const stopped = await runCli(
    [
      "sponsor",
      "duty",
      "stop",
      "--json",
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
    ],
    { environment },
  );

  assert.equal(stopped.code, 0, stopped.stderr);
  const archivePath = JSON.parse(stopped.stdout).localArchive;
  const archiveText = await fs.readFile(archivePath, "utf8");
  const archived = JSON.parse(archiveText);
  assert.equal(archived.duty.leaseToken, null);
  assert.equal(archived.jobs["9"].attempt.token, null);
  assert.equal(archived.jobs["9"].workspaceToken, null);
  assert.equal(archived.jobs["9"].authFile, null);
  assert(archived.jobs["9"].credentialsRemovedAt);
  assert(archived.preservedWorkspaces[0].credentialsRemovedAt);
  assert.doesNotMatch(
    archiveText,
    /archived-duty-lease|archived-attempt-token|archived-workspace-token|archived-job-auth-token|legacy-preserved-job-auth-token/,
  );
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "index.html"), "utf8"),
    "<!doctype html><title>Recoverable work</title>",
  );
  await assert.rejects(fs.stat(jobAuthFile), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(legacyWorkspaceDir, "index.html"), "utf8"),
    "<!doctype html><title>Previously preserved work</title>",
  );
  await assert.rejects(fs.stat(legacyJobAuthFile), { code: "ENOENT" });
  await assert.rejects(fs.stat(statePath), { code: "ENOENT" });
});

function canonicalDuty() {
  return {
    id: 4,
    sponsorUserId: 5,
    scope: "shared",
    state: "active",
    provider: "codex",
    requestedModel: "gpt-5.6-sol",
    requestedEffort: "max",
    requestedServiceTier: "priority",
    capacity: {
      maxConcurrentTasks: 1,
      maxSubagentsPerTask: 1,
      dailyTaskLimit: 3,
      weeklyTaskLimit: 10,
    },
  };
}

function workshopClaim(relay, jobOverrides = {}) {
  return {
    job: {
      id: 9,
      jobKind: "build",
      requester: { userId: 5, username: "mikey" },
      persona: "zero",
      personaUserId: 2,
      rootBuild: { id: 41, title: "Adopt Me", isPublic: false },
      targetBuild: {
        id: 73,
        title: "mikey's Adopt Me branch",
        kind: "branch",
        rootBuildId: 41,
      },
      workspaceFilesHash: "base-files-hash",
      restorePoint: {
        artifactVersionId: 500,
        versionNumber: 1,
      },
      forumAccess: true,
      status: "leased",
      requestedSubagents: 1,
      leaseExpiresAt: 220,
      ...jobOverrides,
    },
    relays: [relay],
    attempt: { id: 11, number: 1, token: "attempt-token" },
    workspaceToken: {
      accessToken: "workspace-access",
      expiresAt: 7200,
      user: { id: 5, username: "mikey" },
    },
    runtime: {
      provider: "codex",
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "max",
      requestedServiceTier: "priority",
    },
    heartbeatEverySeconds: 40,
  };
}

async function writeTestAuth(authFile, apiUrl) {
  await fs.writeFile(
    authFile,
    JSON.stringify({
      token: "sponsor-token",
      userId: 5,
      username: "mikey",
      apiUrl,
    }),
    { mode: 0o600 },
  );
}

function codexEnvironment(sessionId) {
  const environment = { ...process.env, CODEX_SESSION_ID: sessionId };
  delete environment.CODEX_THREAD_ID;
  delete environment.CLAUDECODE;
  delete environment.CLAUDE_CODE_SESSION_ID;
  delete environment.CLAUDE_SESSION_ID;
  delete environment.CLAUDE_RUNNER_SESSION_ID;
  delete environment.CLAUDE_CODE_REMOTE_SESSION_ID;
  return environment;
}

function runCli(args, { environment = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.dirname(cliPath),
      env: environment,
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
