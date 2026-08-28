import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../lib/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
