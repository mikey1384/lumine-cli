// Twinkle.land in the CLI (phase 2, 11-08): lumine admin land, the land block
// in rewards check / admin review, and publish --ask-reload.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildLandOperation,
  formatLandResult,
  LAND_IMPORT_LIMITS,
  landImportBatches,
  landClearRequestKey,
  landImportRequestKey,
  readLandImportFile,
  runLandClear,
  runLandImport,
} from "../lib/admin-land.js";
import { formatCoinPrices, formatLand } from "../lib/rewards.js";
import { askReloadAfterPublish, parseArgs, reloadAskLine } from "../lib/commands.js";

const base = { adminConfirm: "" };
// Fixture files live beside the tests (never the system temp folder) and are
// removed when the file's tests end.
const fixtures = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".land-fixtures-"));
test.after(() => fs.rmSync(fixtures, { recursive: true, force: true }));
function tempFile(name, value) {
  const dir = fs.mkdtempSync(path.join(fixtures, "f-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("reads: plots, who and edits are GETs with only the flags given", () => {
  const plots = buildLandOperation({ action: "plots", options: { ...base, adminBuild: "363", adminCoinRegion: "fw3", adminCoinKey: "fw3:0:16" } });
  assert.equal(plots.path, "/cli/admin/land/plots?buildId=363&region=fw3&key=fw3%3A0%3A16");
  assert.equal(plots.mutates, false);
  const who = buildLandOperation({ action: "who", options: { ...base, adminBuild: "363", adminCoinRegion: "fw3", adminLandCell: "12, 64,-48", adminCoinBefore: "900" } });
  assert.equal(who.path, "/cli/admin/land/who?buildId=363&region=fw3&cell=12%2C64%2C-48&before=900");
  const edits = buildLandOperation({ action: "edits", options: { ...base, adminBuild: "363", adminUser: "7", adminSince: "1794000000" } });
  assert.equal(edits.path, "/cli/admin/land/edits?buildId=363&userId=7&since=1794000000");
  assert.throws(() => buildLandOperation({ action: "plots", options: { ...base, adminBuild: "363", adminCoinRegion: "Main" } }), /world name/);
  assert.throws(() => buildLandOperation({ action: "who", options: { ...base, adminBuild: "363", adminCoinRegion: "fw3", adminLandCell: "1,2" } }), /--cell is x,y,z/);
  assert.throws(() => buildLandOperation({ action: "grant", options: base }), /--reason is required|Usage/);
});

test("set-rules is a dry run unless --confirm and sends only the rules named", () => {
  const options = { ...base, adminBuild: "363", adminCoinKey: "fw3:0:16", adminReason: "holder asked", adminLandRuleBuild: "friends", adminLandSwitches: "tnt", adminLandFriends: "4,9" };
  const dry = buildLandOperation({ action: "set-rules", options });
  assert.equal(dry.name, "land.set-rules.preview");
  assert.deepEqual(dry.body, { buildId: 363, key: "fw3:0:16", rules: { build: "friends", switches: ["tnt"], friends: [4, 9] }, reason: "holder asked", dryRun: true });
  const live = buildLandOperation({ action: "set-rules", options: { ...options, adminConfirm: "true", adminLandSwitches: "none", adminLandFriends: "none", adminLandRuleBuild: "" } });
  assert.deepEqual(live.body.rules, { switches: [], friends: [] });
  assert.equal(live.mutates, true);
  assert.throws(() => buildLandOperation({ action: "set-rules", options: { ...options, adminLandRuleBuild: "all" } }), /me, friends or everyone/);
  assert.throws(() => buildLandOperation({ action: "set-rules", options: { ...base, adminBuild: "363", adminCoinKey: "k", adminReason: "x" } }), /at least one rule/);
  assert.throws(() => buildLandOperation({ action: "set-rules", options: { ...options, adminConfirm: "yes" } }), /--confirm on its own/);
});

test("imports: one world per file, batches within the server's limits, stable keys", () => {
  const plotsFile = tempFile("plots.json", {
    format: "twinkle-land-plots-v1", buildId: 363, region: "fw3", priceId: "starter", artifactVersionId: 9001,
    plots: Array.from({ length: 1201 }, (_, i) => ({ plotId: `p${i}`, userId: 5, x0: i * 16, z0: 0, claimedAt: 1794000000 })),
  });
  const op = buildLandOperation({ action: "import-plots", target: "363", options: { ...base, adminFile: plotsFile, adminReason: "stage-1 plots" } });
  assert.equal(op.name, "land.import-plots.preview");
  assert.deepEqual(op.batches.map((batch) => batch.plots.length), [500, 500, 201]);
  assert.ok(op.batches.every((batch) => batch.dryRun && batch.priceId === "starter" && batch.artifactVersionId === 9001 && batch.batchCount === 3));
  assert.equal(landImportRequestKey("import-plots", op.batches[1]), `cli:land:import-plots:363:${op.file.sha256.slice(0, 16)}:1`);
  assert.throws(() => buildLandOperation({ action: "import-plots", target: "364", options: { ...base, adminFile: plotsFile, adminReason: "x" } }), /made for app 363/);
  const wrong = tempFile("cells.json", { format: "twinkle-land-plots-v1", region: "fw3", at: 1, cells: [[0, 0, 0, 1, 5]] });
  assert.throws(() => buildLandOperation({ action: "import-cells", target: "363", options: { ...base, adminFile: wrong, adminReason: "x" } }), /format twinkle-land-cells-v1/);

  const edits = {
    region: "fw3", sha256: "a".repeat(64),
    rows: [
      { userId: 1, at: 10, cells: Array.from({ length: 3000 }, (_, i) => [i, 0, 0, 1]) },
      { userId: 2, at: 11, cells: Array.from({ length: 3000 }, (_, i) => [i, 1, 0, 1]) },
      ...Array.from({ length: 2500 }, (_, i) => ({ userId: 3, at: 12 + i, cells: [[i, 2, 0, 1]] })),
    ],
  };
  const batches = landImportBatches("import-edits", edits, { buildId: 363, reason: "late edits", dryRun: false });
  for (const batch of batches) {
    assert.ok(batch.rows.length <= LAND_IMPORT_LIMITS.edits);
    assert.ok(batch.rows.reduce((sum, row) => sum + row.cells.length, 0) <= LAND_IMPORT_LIMITS.editCells);
  }
  assert.equal(batches.reduce((sum, batch) => sum + batch.rows.length, 0), 2502);
  assert.equal(batches[0].rows.length, 1);
});

test("an import runs batch by batch with idempotency keys only when confirmed, and sums the answers", async () => {
  const cellsFile = tempFile("cells.json", { format: "twinkle-land-cells-v1", region: "fw3", at: 1794000000, cells: Array.from({ length: 7000 }, (_, i) => [i, 0, 0, 1, 5]) });
  const sent = [];
  const request = async (call) => {
    sent.push(call);
    return { ok: true, data: { cells: call.body.cells.length, written: call.body.cells.length - 10, inserted: 5, keptNewer: 10, unchanged: 0, importId: 40 + call.body.batchIndex, regionCellsBefore: 3 } };
  };
  const live = buildLandOperation({ action: "import-cells", target: "363", options: { ...base, adminConfirm: "true", adminFile: cellsFile, adminReason: "cutover" } });
  const result = await runLandImport({ options: { apiUrl: "http://api.test" }, operation: live, authToken: "t", request });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "http://api.test/cli/admin/land/import-cells");
  assert.match(sent[1].headers["x-lumine-idempotency-key"], /^cli:land:import-cells:363:[0-9a-f]{16}:1$/);
  assert.equal(result.data.cells, 7000);
  assert.equal(result.data.keptNewer, 20);
  assert.deepEqual(result.data.importIds, [40, 41]);
  const lines = formatLandResult({ operation: live, data: result.data });
  assert.match(lines[1], /7000 cells: 6980 written \(10 new\), 20 kept \(changed live after the file's time\)/);
  const dry = buildLandOperation({ action: "import-cells", target: "363", options: { ...base, adminFile: cellsFile, adminReason: "cutover" } });
  sent.length = 0;
  const dryResult = await runLandImport({ options: { apiUrl: "http://api.test" }, operation: dry, authToken: "t", request });
  assert.deepEqual(sent[0].headers, {});
  assert.match(formatLandResult({ operation: dry, data: dryResult.data }).at(-1), /Add --confirm to apply/);
  await assert.rejects(
    runLandImport({ options: { apiUrl: "x" }, operation: dry, authToken: "t", request: async () => ({ ok: false, error: { code: "CLI_ADMIN_LAND_INVALID", message: "This app has no approved review that declares land." } }) }),
    /no approved review/,
  );
});

test("result lines: plots, who, set-rules and skipped stage-1 plots", () => {
  const plots = formatLandResult({
    operation: { name: "land.plots" },
    data: { region: "fw3", plots: [{ key: "fw3:0:16", receiptId: 12, holder: { id: 5, username: "kengo" }, priceId: "starter", kind: "grant", lastPrice: 0, since: 1794000000, rules: { build: "friends", use: "me", switches: ["tnt"], friends: [{ id: 9, username: "dew" }] } }] },
  });
  assert.match(plots[0], /^fw3:0:16 #12 kengo · starter \(grant\) 0 Coins · since 2026-.* · build friends · use me · switches tnt · friends dew$/);
  const who = formatLandResult({ operation: { name: "land.who" }, data: { region: "fw3", cell: [1, 2, 3], current: null, changes: [] } });
  assert.match(who[0], /never changed/);
  const rules = formatLandResult({ operation: { name: "land.set-rules.preview" }, data: { dryRun: true, key: "fw3:0:16", receiptId: 12, holderId: 5, before: { build: "me", use: "me", switches: [], friends: [] }, after: { build: "everyone", use: "me", switches: [], friends: [9] } } });
  assert.match(rules[2], /after: {2}build everyone .* friends 9/);
  const grants = formatLandResult({
    operation: { name: "land.import-plots.preview", landWorkflow: "import-plots" },
    data: { action: "import-plots", dryRun: true, buildId: 363, region: "fw3", batches: 1, fileSha256: "b".repeat(64), plots: 3, granted: [{ key: "fw3:0:0", droppedFriends: [77] }], alreadyGranted: [], skipped: [{ why: "one_per_world" }, { why: "overlap" }] },
  });
  assert.match(grants[1], /3 plots in the file: 1 would be granted, 0 already granted, 2 skipped/);
  assert.match(grants[2], /one_per_world 1, overlap 1/);
  assert.match(grants[3], /unknown friends dropped on 1 plots: fw3:0:0 \(77\)/);
});

test("rewards check and admin review show the land block and per-world limits", () => {
  const prices = [{ id: "starter", title: "First plot", coins: 0, destination: "removed", uniqueKey: true, keyGroup: "plots", maxPerRegion: 1 }];
  const declared = { keyGroup: "plots", plotSize: 16, keyFormat: "region:x:z", regions: ["fw3", "mountains1"], reserved: [{ x: 49, z: 57, radius: 24, why: "spawn" }], switches: { tnt: { cause: "tnt", values: [0] } } };
  const lines = formatCoinPrices({ prices, land: declared });
  assert.match(lines.find((line) => line.includes("starter")), /1 per world per player/);
  assert.equal(lines.at(-2), 'Land: 2 worlds (fw3, mountains1) · 16x16 plots named "region:x:z" in key group plots');
  assert.equal(lines.at(-1), "  no plots near: spawn (49, 57) radius 24 · holder switches: tnt (tnt → 0) · empty values: 0");
  // The server's summary shape (switches as a list) prints the same.
  assert.deepEqual(formatLand({ ...declared, switches: [{ name: "tnt", cause: "tnt", values: [0] }], empty: [0] }), lines.slice(-2));
  assert.deepEqual(formatLand(null), []);
});

test("publish --ask-reload asks once after publishing and never undoes the publish", async () => {
  assert.equal(parseArgs(["save", "--publish", "--ask-reload"]).askReload, true);
  assert.equal(parseArgs(["save", "--publish"]).askReload, false);
  const calls = [];
  const ok = await askReloadAfterPublish({ options: {}, buildId: 363, auth: {}, ask: async (args) => { calls.push(args.buildId); return { artifactVersionId: 9002 }; } });
  assert.deepEqual(ok, { asked: true, artifactVersionId: 9002 });
  assert.match(reloadAskLine(ok), /asked to reload \(version 9002\)/);
  const before = process.exitCode;
  const failed = await askReloadAfterPublish({ options: {}, buildId: 363, auth: {}, ask: async () => { const error = new Error("429"); error.data = { error: "Players were just asked to reload. Try again in a minute." }; throw error; } });
  assert.equal(failed.asked, false);
  assert.match(reloadAskLine(failed), /^Published, but asking players to reload failed: Players were just asked/);
  process.exitCode = before;
  assert.deepEqual(calls, [363]);
});

// Review fixes (11-08): imports before approval (--land-review), the edits file's cutover (M5), and
// lumine admin land clear (H1).
test("imports: --land-review goes with every batch; an edits file must name its cutover", () => {
  const cellsFile = tempFile("cells.json", { format: "twinkle-land-cells-v1", region: "fw3", at: 1794000000, cells: [[0, 0, 0, 1, 5, "derived", 0], [1, 0, 0, 2, 5]] });
  const op = buildLandOperation({ action: "import-cells", target: "363", options: { ...base, adminFile: cellsFile, adminReason: "before approval", adminLandReview: "912" } });
  assert.ok(op.batches.every((batch) => batch.landReviewId === 912));
  assert.deepEqual(op.batches[0].cells[0], [0, 0, 0, 1, 5, "derived", 0], "cause and flags travel as they are");
  const rewards = tempFile("rewards.json", { prices: [{ id: "starter", coins: 0 }], land: { keyGroup: "plots", plotSize: 16, keyFormat: "region:x:z", regions: ["fw3"], freeRegions: ["tnt-world-fw3"] }, rules: [] });
  const fromFile = buildLandOperation({ action: "import-plots", target: "363", options: { ...base, adminFile: tempFile("plots.json", { format: "twinkle-land-plots-v1", region: "fw3", priceId: "starter", artifactVersionId: 9, plots: [{ plotId: 1, userId: 5, x0: 0, z0: 0, claimedAt: 1794000000 }] }), adminReason: "before the review", adminLandFile: rewards } });
  assert.deepEqual(fromFile.batches[0].landDeclaration, { prices: [{ id: "starter", coins: 0 }], land: { keyGroup: "plots", plotSize: 16, keyFormat: "region:x:z", regions: ["fw3"], freeRegions: ["tnt-world-fw3"] } });
  assert.throws(() => buildLandOperation({ action: "import-cells", target: "363", options: { ...base, adminFile: cellsFile, adminReason: "x", adminLandFile: rewards, adminLandReview: "9" } }), /not both/);
  const noCutover = tempFile("edits.json", { format: "twinkle-land-edits-v1", region: "fw3", rows: [{ userId: 1, at: 10, cells: [[0, 0, 0, 1]] }] });
  assert.throws(() => readLandImportFile(noCutover, "import-edits"), /cutover must be the time/);
  const withCutover = tempFile("edits.json", { format: "twinkle-land-edits-v1", region: "fw3", cutover: 9, rows: [{ userId: 1, at: 10, cells: [[0, 0, 0, 1]] }] });
  const edits = buildLandOperation({ action: "import-edits", target: "363", options: { ...base, adminFile: withCutover, adminReason: "late pass" } });
  assert.ok(edits.batches.every((batch) => batch.cutover === 9 && batch.landReviewId === undefined));
});

test("clear: one author (--user or --guest), dry run unless --confirm, batch by batch until the server says done", async () => {
  assert.throws(() => buildLandOperation({ action: "clear", target: undefined, options: { ...base, adminBuild: "363", adminReason: "flood" } }), /Name one author/);
  assert.throws(() => buildLandOperation({ action: "clear", target: undefined, options: { ...base, adminBuild: "363", adminUser: "5", adminLandGuest: "gaaaaaaaaaaaaaaaaaaaa", adminReason: "x" } }), /Name one author/);
  assert.throws(() => buildLandOperation({ action: "clear", target: undefined, options: { ...base, adminBuild: "363", adminLandGuest: "guest-1", adminReason: "x" } }), /land guest id/);
  const dry = buildLandOperation({ action: "clear", target: undefined, options: { ...base, adminBuild: "363", adminLandGuest: "gaaaaaaaaaaaaaaaaaaaa", adminCoinRegion: "fw3", adminSince: "1794000000", adminReason: "flood" } });
  assert.equal(dry.name, "land.clear.preview");
  assert.deepEqual(dry.body, { buildId: 363, guestId: "gaaaaaaaaaaaaaaaaaaaa", region: "fw3", since: 1794000000, reason: "flood", dryRun: true });
  const sent = [];
  const plan = { region: "fw3", changesInScope: 30000, cells: 2000, reverted: 1500, removed: 400, leftForLaterChanges: 100, more: true, dryRun: true };
  const dryResult = await runLandClear({ options: { apiUrl: "http://api.test" }, operation: dry, authToken: "t", request: async (call) => { sent.push(call); return { ok: true, data: plan }; } });
  assert.equal(sent.length, 1, "a dry run asks once");
  assert.deepEqual(sent[0].headers, {});
  assert.match(formatLandResult({ operation: dry, data: dryResult.data }).join("\n"), /30000 changes there; this batch: 2000 cells, 1500 put back, 400 back to the generated world, 100 left/);
  // Confirmed, without --region: the server picks the next world each time until nothing is in scope.
  const live = buildLandOperation({ action: "clear", target: undefined, options: { ...base, adminConfirm: "true", adminBuild: "363", adminUser: "7", adminReason: "flood" } });
  sent.length = 0;
  const answers = [
    { region: "fw3", reverted: 10, removed: 5, leftForLaterChanges: 1, historyRemoved: 20000, more: true },
    { region: "fw3", reverted: 2, removed: 0, leftForLaterChanges: 0, historyRemoved: 300, more: false },
    { region: "tnt-world-fw3", reverted: 0, removed: 7, leftForLaterChanges: 0, historyRemoved: 7, more: false },
    { regions: [], more: false },
  ];
  const result = await runLandClear({ options: { apiUrl: "http://api.test" }, operation: live, authToken: "t", request: async (call) => { sent.push(call); return { ok: true, data: answers[sent.length - 1] }; } });
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((call) => call.body.batchIndex), [0, 1, 2, 3]);
  assert.equal(sent[2].headers["x-lumine-idempotency-key"], landClearRequestKey(live.body, 2));
  assert.equal(landClearRequestKey(live.body, 2), "cli:land:clear:363:u7:all:0:2");
  assert.deepEqual({ reverted: result.data.reverted, removed: result.data.removed, historyRemoved: result.data.historyRemoved, regions: result.data.regions }, { reverted: 12, removed: 12, historyRemoved: 20307, regions: ["fw3", "tnt-world-fw3"] });
  assert.match(formatLandResult({ operation: live, data: result.data }).join("\n"), /12 cells put back, 12 back to the generated world, 1 left \(changed later by someone else\), 20307 history rows removed/);
  const parsed = parseArgs(["admin", "land", "clear", "--build", "363", "--guest", "gaaaaaaaaaaaaaaaaaaaa", "--land-review", "9", "--land-file", "r.json", "--reason", "x"]);
  assert.equal(parsed.adminLandGuest, "gaaaaaaaaaaaaaaaaaaaa");
  assert.equal(parsed.adminLandReview, "9");
  assert.equal(parsed.adminLandFile, "r.json");
});
