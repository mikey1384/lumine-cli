// Fixes for the 2026-11-02 daily-run process frictions:
// news claim before the edition opens, gather surviving a closed parent shell,
// and secret Subjects in effort candidates.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeNewsClaimArtifacts } from "../lib/admin-news.js";
import { markSubjectsNeedingReveal } from "../lib/admin.js";
import { dailyRunGather } from "../lib/admin-daily.js";
import { testWorkRoot } from "./helpers/work-directory.js";

function fixture(t, prefix) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("news claim with nothing to claim leaves an existing claim file untouched and says when the next edition opens", (t) => {
  const dir = fixture(t, "news-claim-early-");
  const claimFile = path.join(dir, "claim.json");
  const scaffoldFile = path.join(dir, "editorial-scaffold.json");
  const previous = JSON.stringify({ schemaVersion: 1, claim: { editionId: 95, leaseToken: "keep-me", events: [] } });
  fs.writeFileSync(claimFile, previous);
  const artifacts = writeNewsClaimArtifacts({
    result: {
      ok: true,
      status: "already_done",
      data: { newspaper: { dateKey: "2026-11-01", printDecision: "already_printed", nextEditionAt: 1793577600 } },
    },
    outputPath: claimFile,
    scaffoldPath: scaffoldFile,
  });
  assert.equal(fs.readFileSync(claimFile, "utf8"), previous);
  assert.equal(fs.existsSync(scaffoldFile), false);
  assert.equal(artifacts.claimFile, null);
  assert.equal(artifacts.scaffoldFile, null);
  assert.deepEqual(artifacts.notClaimed, {
    status: "already_done",
    printDecision: "already_printed",
    nextEditionAt: 1793577600,
    nextEditionAtIso: "2026-11-02T00:00:00.000Z",
    outputLeftUnchanged: claimFile,
  });
});

test("news claim with a claim still writes the claim and the scaffold", (t) => {
  const dir = fixture(t, "news-claim-ok-");
  const claimFile = path.join(dir, "claim.json");
  const scaffoldFile = path.join(dir, "editorial-scaffold.json");
  const claim = {
    editionId: 96,
    dayIndex: 1767,
    dateKey: "2026-11-03",
    leaseToken: "t",
    leaseExpiresAt: 1793664600,
    maxSourceQuoteLength: 360,
    announcementCount: 0,
    events: [{ eventKey: "subject:1", kind: "subject", section: "front", title: "A", summary: "B", payload: { description: "B" } }],
  };
  const artifacts = writeNewsClaimArtifacts({ result: { ok: true, status: "success", data: { claim } }, outputPath: claimFile, scaffoldPath: scaffoldFile });
  assert.equal(JSON.parse(fs.readFileSync(claimFile, "utf8")).claim.editionId, 96);
  assert.equal(fs.existsSync(scaffoldFile), true);
  assert.equal(artifacts.notClaimed, undefined);
});

test("effort candidates mark unrevealed secret Subjects with the exact reveal command", () => {
  const result = markSubjectsNeedingReveal({
    ok: true,
    status: "success",
    data: {
      subjects: [
        { id: 37294, hasSecretAnswer: true, secret: { hasSecret: true, revealed: false } },
        { id: 37296, hasSecretAnswer: false, secret: { hasSecret: false, revealed: true } },
        { id: 37292, hasSecretAnswer: true, secret: { hasSecret: true, revealed: true } },
        { id: 1, hasSecretAnswer: false, hasSecretAttachment: true },
      ],
      pagination: { exhausted: true },
    },
  });
  const [secret, plain, revealed, attachmentOnly] = result.data.subjects;
  assert.equal(secret.needsReveal, true);
  assert.equal(secret.revealCommand, "lumine admin subject reveal 37294");
  assert.equal(plain.needsReveal, undefined);
  assert.equal(revealed.needsReveal, undefined);
  assert.equal(attachmentOnly.needsReveal, true);
  assert.deepEqual(result.data.pagination, { exhausted: true });
});

function quietRunner(onCall) {
  return {
    run(args, { outputFile }) {
      onCall?.(args);
      const data = args[0] === "review" ? { filter: "pending", items: [], nextCursor: null }
        : args[0] === "bot-output" ? { chatMessages: [], comments: [], pagination: { exhausted: true } }
        : args[0] === "arena" && args[1] === "paper-queue" ? { demandBasis: "waiting-published-papers-v1", entries: [], nextCursor: null }
        : args[0] === "arena" && args[1] === "today-queue" ? { members: [], nextCursor: null }
        : args[0] === "reward-diagnostics" ? { coverage: "best_effort", since: Number(args[args.indexOf("--until") + 1]) - 86400, until: Number(args[args.indexOf("--until") + 1]), events: [], nextCursor: null }
        : args[0] === "owner-trace" ? { since: Number(args[args.indexOf("--since") + 1]), until: Number(args[args.indexOf("--until") + 1]), events: [], nextCursor: null, truncated: false }
        : args[0] === "jev-routing" ? { collectionWindow: { since: Number(args[args.indexOf("--since") + 1]), until: Number(args[args.indexOf("--until") + 1]), includeSynthetic: false }, items: [], nextCursor: null, after: null, hasMore: false, coverage: { scope: "page", status: "exhausted" } }
        : { events: [], truncated: false };
      const json = { ok: true, status: "ok", data };
      fs.writeFileSync(outputFile, JSON.stringify(json));
      return { ok: true, attempts: 1, durationMs: 1, json };
    },
  };
}

test("gather keeps gather.json current while it runs and ignores a hang-up from its parent shell", async (t) => {
  const dir = fixture(t, "gather-progress-");
  const gatherFile = path.join(dir, "gather.json");
  const seen = [];
  let hangupListenersDuringRun = 0;
  const stub = quietRunner((args) => {
    if (args[0] === "brief") {
      // By the third step, earlier steps are already on disk, marked in progress.
      const progress = JSON.parse(fs.readFileSync(gatherFile, "utf8"));
      seen.push(progress);
      hangupListenersDuringRun = process.listenerCount("SIGHUP");
    }
    // A real hang-up mid-collection (what a closing parent shell sends) must
    // not stop the run.
    if (args[0] === "todo") process.kill(process.pid, "SIGHUP");
  });
  const before = process.listenerCount("SIGHUP");
  const result = await dailyRunGather({ adminOutputDir: dir }, stub);
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].inProgress, true);
  assert.deepEqual(seen[0].steps.map((step) => step.name), ["energy-budget", "news"]);
  assert.match(seen[0].note, /--resume/);
  assert.equal(hangupListenersDuringRun, before + 1);
  assert.equal(process.listenerCount("SIGHUP"), before);
  const final = JSON.parse(fs.readFileSync(gatherFile, "utf8"));
  assert.equal(final.inProgress, false);
  assert.ok(final.steps.length > 2);
  assert.ok(final.collectedAt);
});
