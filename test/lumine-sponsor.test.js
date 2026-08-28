import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../lib/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

test("sponsor application and duty flags remain distinct from admin controls", () => {
  const application = parseArgs([
    "sponsor",
    "apply",
    "--providers",
    "codex,claude-code",
    "--motivation",
    "Contribute subscription time",
    "--availability",
    "Three evenings each week",
    "--accept-agreement",
  ]);
  assert.deepEqual(application.sponsorArgs, ["apply"]);
  assert.equal(application.sponsorProviders, "codex,claude-code");
  assert.equal(application.sponsorMotivation, "Contribute subscription time");
  assert.equal(application.sponsorAvailability, "Three evenings each week");
  assert.equal(application.sponsorAcceptAgreement, true);
  assert.equal(application.command, "sponsor");

  const duty = parseArgs([
    "sponsor",
    "duty",
    "start",
    "ciel",
    "--provider",
    "codex",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "max",
    "--service-tier",
    "priority",
  ]);
  assert.deepEqual(duty.sponsorArgs, ["duty", "start", "ciel"]);
  assert.equal(duty.provider, "codex");
  assert.equal(duty.model, "gpt-5.6-sol");
  assert.equal(duty.sponsorEffort, "max");
  assert.equal(duty.sponsorServiceTier, "priority");
});

test("every user-facing sponsor command can bootstrap browser login", async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, "../lib/sponsor.js"),
    "utf8",
  );

  assert.match(
    source,
    /import \{ ensureAuth, resolveAuth, writeAuthFile \} from "\.\/auth\.js";/,
  );
  assert.match(
    source,
    /if \(area === "agreement"\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /if \(area === "jobs"\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /async function applyToSponsor\(options\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /async function withdrawSponsorApplication\(options\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /async function updateSponsorCapacity\(options\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /if \(\["pause", "resume", "stop"\]\.includes\(action\)\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /if \(action !== "start"\) throw new Error\(sponsorUsage\(\)\);[\s\S]*?if \(options\.json\)[\s\S]*?const provider = normalizeProvider\(options\.provider\);[\s\S]*?const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /async function printSponsorStatus\(options\) \{\s*const auth = await ensureAuth\(options\);/,
  );
  assert.match(
    source,
    /const jobAuth = await resolveAuth\(jobOptions\);/,
    "an already-leased worker workspace must keep using its exact scoped token",
  );
});

test("duty start can authenticate any account without granting it sponsor authority", async (t) => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-sponsor-login-test-"),
  );
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/cli/device/start") {
      res.end(
        JSON.stringify({
          deviceCode: "device-code",
          userCode: "USER-CODE",
          verificationUri: "https://example.test/cli/approve",
          verificationUriComplete: "https://example.test/cli/approve?code=USER-CODE",
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
    if (req.method === "GET" && req.url === "/cli/sponsor/status") {
      res.end(
        JSON.stringify({
          agreementVersion: "2026-08-28",
          application: null,
          sponsor: null,
          usage: {
            dailyStarted: 0,
            weeklyStarted: 0,
            activeTasks: 0,
          },
          duties: [],
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

  const invalidResult = await runCli([
    "sponsor",
    "duty",
    "start",
    "ciel",
    "--json",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-open",
  ]);
  assert.equal(invalidResult.code, 1);
  assert.match(
    invalidResult.stderr,
    /A foreground sponsor duty cannot run with --json\./,
  );
  assert.equal(requests.length, 0);

  const result = await runCli([
    "sponsor",
    "duty",
    "start",
    "ciel",
    "--provider",
    "claude-code",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-open",
  ]);

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
  const savedAuth = JSON.parse(await fs.readFile(authFile, "utf8"));
  assert.equal(savedAuth.username, "ordinary-user");
  assert.equal(savedAuth.userId, 99);

  await fs.unlink(authFile);
  const jsonResult = await runCli([
    "sponsor",
    "status",
    "--json",
    "--api-url",
    apiUrl,
    "--auth-file",
    authFile,
    "--no-open",
  ]);
  assert.equal(jsonResult.code, 0);
  assert.equal(JSON.parse(jsonResult.stdout).sponsor, null);
  assert.doesNotMatch(jsonResult.stdout, /Connect Lumine CLI/);
  assert.match(jsonResult.stderr, /Connect Lumine CLI to Twinkle\./);
  assert.match(jsonResult.stderr, /Logged in as ordinary-user\./);
});

test("graceful duty shutdown keeps leases alive and applies only relays in each pass", async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, "../lib/sponsor.js"),
    "utf8",
  );

  assert.match(
    source,
    /const heartbeatDuty = async \(\) => \{\s*if \(dutyHeartbeatRunning\) return;/,
  );
  assert.doesNotMatch(
    source,
    /const heartbeatDuty = async \(\) => \{\s*if \(stopRequested \|\| dutyHeartbeatRunning\)/,
  );
  assert.match(
    source,
    /const confirmedDuty = \(status\?\.duties \|\| \[\]\)\.find[\s\S]*?confirmedDuty\?\.state === "stopped"/,
  );
  assert.match(
    source,
    /const initialRelays = Array\.from\(relayById\.values\(\)\);[\s\S]*?acknowledgeRelaysApplied\(\{[\s\S]*?relays: initialRelays,[\s\S]*?appliedRelayIds,/,
  );
  assert.match(
    source,
    /const pendingRelays = Array\.from\(relayById\.values\(\)\)\.filter\([\s\S]*?acknowledgeRelaysApplied\(\{[\s\S]*?relays: pendingRelays,[\s\S]*?path: "\/relays\/close"/,
  );
  assert.match(
    source,
    /retrySponsorTransport\(\(\) =>[\s\S]*?path: "\/relays\/applied"/,
  );
  assert.match(source, /relayIds\.slice\(index, index \+ 50\)/);
  assert.match(
    source,
    /retrySponsorTransport\(\(\) =>[\s\S]*?path: "\/relays\/close"/,
  );
  assert.match(
    source,
    /retrySponsorTransport\(\(\) =>[\s\S]*?path: "\/complete"/,
  );
  assert.match(
    source,
    /async function startLogicalAgent[\s\S]*?retrySponsorTransport\(\(\) =>[\s\S]*?path: "\/agents"/,
  );
  assert.match(
    source,
    /async function completeLogicalAgent[\s\S]*?retrySponsorTransport\(\(\) =>[\s\S]*?path: `\/agents\/\$\{agent\.agentId\}\/complete`/,
  );
  assert.match(source, /retrySponsorTransport\(\(\) =>[\s\S]*?path: "\/fail"/);
  assert.match(
    source,
    /const runtime = \{[\s\S]*?claim\.runtime\?\.requestedModel[\s\S]*?model: runtime\.requestedModel/,
  );
  assert.match(
    source,
    /const jobAbortController = new AbortController\(\)[\s\S]*?serverRejectedLease[\s\S]*?jobAbortController\.abort/,
  );
  assert.match(source, /agentAbortSignal: jobAbortController\.signal/);
  assert(
    source.indexOf("const tempDir = await fs.mkdtemp") <
      source.indexOf("const heartbeatTimer = setInterval"),
    "the owned workspace must exist before its long-lived heartbeat starts",
  );
  assert.match(
    source,
    /finally \{\s*clearInterval\(heartbeatTimer\);\s*try \{\s*await fs\.rm\(tempDir, \{ recursive: true, force: true \}\);/,
  );
  assert.match(source, /changedPathCount: allChangedPaths\.length/);
  assert.match(source, /\.slice\(0, 50\)/);
  assert.match(
    source,
    /function summarizeWorkshopOutcome[\s\S]*?\.slice\(0, 1000\)/,
  );
});

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
