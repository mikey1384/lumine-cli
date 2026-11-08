// Twinkle.coins in the CLI (review fixes L6 and M6, 11-07): rewards check and
// admin review show every price with where all its Coins go, builder payments
// included, and refund wording never hides who covers a refund.
import test from "node:test";
import assert from "node:assert/strict";
import { formatCoinPrices, coinPriceDestination } from "../lib/rewards.js";
import { printRewardReviewResult } from "../lib/admin.js";
import {
  buildCoinsOperation,
  formatCoinsResult,
  runCoinsTallyImport,
  tallyImportBatches,
  tallyImportRequestKey,
  TALLY_IMPORT_BATCH_CELLS,
} from "../lib/admin-coins.js";

const claim = {
  id: "claim-plot", title: "Claim built land", coins: 0, destination: "removed", uniqueKey: true, keyGroup: "plots",
  builders: { coinsPerUnit: 50, maxUnitsPerRecipient: 4096, maxRecipients: 64, maxCoinsPerPurchase: 100000, unitName: "block", tally: { plotSize: 16, keyFormat: "region:x:z" } },
};
const land = { id: "land-plot", title: "Extra land plot", coins: 500, destination: "removed", uniqueKey: true, keyGroup: "plots", offers: { minCoins: 100, maxCoins: 5000 } };

test("a builders price never prints as only \"Coins removed\"", () => {
  const lines = formatCoinPrices({ prices: [claim, land], spendBudget: { userDailyCoins: 5000 } });
  const claimLine = lines.find((line) => line.includes("claim-plot"));
  // Round-2 N7: a 0-Coin builders price is not "free".
  // r2: paid from Twinkle's own block record inside the plot the key names.
  assert.match(claimLine, /0 Coins of its own \+ 50 Coins per block to other players for the blocks credited to them in Twinkle's record inside the 16x16 plot its key names \("region:x:z"\)/);
  // review-r2 M2/M5: each builder is paid for at most the limit; only the totals refuse.
  assert.match(claimLine, /never the buyer or the owner; each paid for at most 4096; land with more than 64 builders or over 100000 Coins for builders cannot be bought/);
  assert.doesNotMatch(claimLine, /the app names|topic/);
  assert.match(coinPriceDestination({ ...claim, builders: { ...claim.builders, tally: undefined } }), /no tally declared, so nobody can be paid/);
  assert.match(claimLine, /key group plots/);
  assert.match(claimLine, /no offers on items bought with this price/);
  const landLine = lines.find((line) => line.includes("land-plot"));
  assert.match(landLine, /500 Coins removed/);
  assert.match(landLine, /1 open per player/);
  // Round-2 N2/N3: the highest offer price and who a resale pays.
  assert.match(landLine, /offers from 100 to 5000 Coins, each Sell or takeover pays the previous holder \(a person: extra review\)/);
  assert.equal(coinPriceDestination({ ...land, destination: "owner" }), "500 Coins to the app owner (extra review)");
});

test("admin review show prints the prices and the server's coin warnings", () => {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    printRewardReviewResult({
      operation: { name: "reward-review.show" },
      data: { review: { id: 9, status: "pending", config: { rules: [], userDailyXP: 0, userDailyCoins: 0, prices: [claim] },
        coinPriceWarnings: ["“Claim built land” also pays players the app names (builders)."] } },
    });
  } finally {
    console.log = log;
  }
  assert.ok(lines.some((line) => /claim-plot: Claim built land · 0 Coins of its own \+ 50 Coins per block to other players for the blocks credited to them in Twinkle's record/.test(line)));
  assert.ok(lines.includes("WARNING: “Claim built land” also pays players the app names (builders)."));
});

test("a refund dry run says when the platform covers the Coins", () => {
  const [line] = formatCoinsResult({
    operation: { name: "coins.refund.preview" },
    data: { dryRun: true, receiptId: 4, refundCoins: 100, buyer: { username: "kid" }, takeBackFrom: [], platformCovers: 100 },
  });
  assert.match(line, /taking nothing back \(the platform covers 100 Coins\)/);
});

// r2: lumine admin coins tally-import (the builder tally's one-time fill).
const fixture = new URL("./fixtures/coin-tally-cells.json", import.meta.url).pathname;
const tallyOptions = (extra = {}) => ({ adminConfirm: "", adminReason: "one-time fill", adminFile: fixture, ...extra });

test("tally-import reads the file, refuses a mismatched app or region, and is a dry run without --confirm", () => {
  const dry = buildCoinsOperation({ action: "tally-import", target: "363", options: tallyOptions() });
  assert.equal(dry.name, "coins.tally-import.preview");
  assert.equal(dry.mutates, false);
  assert.equal(dry.batches.length, 1);
  assert.deepEqual(dry.batches[0].placed, [[10, 64, -3, 15402], [11, 64, -3, 15402], [12, 65, -3, 6434]]);
  assert.deepEqual(dry.batches[0].removed, [[0, 0, 0]]);
  assert.equal(dry.batches[0].dryRun, true);
  assert.equal(dry.batches[0].replace, false);
  assert.match(dry.batches[0].fileSha256, /^[0-9a-f]{64}$/);
  const region = "minecraft-terrain-block-view-mountains1";
  const real = buildCoinsOperation({ action: "tally-import", target: "363", options: tallyOptions({ adminConfirm: "true", adminCoinReplaceRegion: region }) });
  assert.equal(real.name, "coins.tally-import");
  assert.equal(real.mutates, true);
  assert.equal(real.batches[0].replace, true);
  assert.equal(real.batches[0].replaceRegion, region);
  assert.throws(() => buildCoinsOperation({ action: "tally-import", target: "364", options: tallyOptions() }), /made for app 363, not 364/);
  assert.throws(() => buildCoinsOperation({ action: "tally-import", target: "363", options: tallyOptions({ adminCoinReplaceRegion: "cave" }) }), /must name the file's region/);
  assert.throws(() => buildCoinsOperation({ action: "tally-import", target: "363", options: tallyOptions({ adminFile: "" }) }), /--file is required/);
  assert.throws(() => buildCoinsOperation({ action: "tally-import", target: "363", options: tallyOptions({ adminReason: "" }) }), /--reason is required/);
  assert.throws(() => buildCoinsOperation({ action: "tally-import", target: "363", options: tallyOptions({ adminFile: new URL("./coinPrices.test.js", import.meta.url).pathname }) }), /is not JSON/);
});

test("tally-import batches: at most 5,000 cells a request, only the first clears, keys repeat for the same file", async () => {
  const placed = Array.from({ length: 11000 }, (_, i) => [i, 0, 0, 7]);
  const file = { region: "main", at: 1793980053, placed, removed: [[1, 1, 1]], sha256: "a".repeat(64) };
  const batches = tallyImportBatches(file, { buildId: 363, replace: true, reason: "r", dryRun: false });
  assert.equal(TALLY_IMPORT_BATCH_CELLS, 5000);
  assert.deepEqual(batches.map((b) => [b.placed.length, b.removed.length, b.replace, b.batchIndex, b.batchCount]),
    [[5000, 0, true, 0, 3], [5000, 0, false, 1, 3], [1000, 1, false, 2, 3]]);
  assert.equal(tallyImportRequestKey(batches[0]), `cli:tally:363:${"a".repeat(16)}:r:0`);
  assert.ok(batches.every((b) => tallyImportRequestKey(b).length <= 80));
  // An empty file with --replace-region still sends one request (it clears the region).
  assert.equal(tallyImportBatches({ ...file, placed: [], removed: [] }, { buildId: 363, replace: true, reason: "r", dryRun: false }).length, 1);
  const sent = [];
  const request = async ({ body, headers }) => {
    sent.push({ body, headers });
    return { ok: true, status: "ok", data: { regionCellsBefore: 4, cleared: body.replace ? 4 : 0, placed: body.placed.length, removed: body.removed.length, keptNewer: 0, regionCellsAfter: 99, importId: sent.length } };
  };
  const result = await runCoinsTallyImport({ options: { apiUrl: "https://example.invalid" }, operation: { path: "/cli/admin/coins/tally-import", buildId: 363, file, batches }, authToken: "t", request });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((s) => s.headers["x-lumine-idempotency-key"]), batches.map(tallyImportRequestKey));
  assert.equal(result.data.placed, 11000);
  assert.equal(result.data.cleared, 4);
  assert.deepEqual(result.data.importIds, [1, 2, 3]);
  const lines = formatCoinsResult({ operation: { name: "coins.tally-import" }, data: result.data });
  assert.match(lines[0], /^Imported the builder tally of app 363, region main/);
  assert.match(lines.join(" "), /cleared 4 older imported blocks \(--replace-region\)/);
  // A dry run sends no idempotency key; a refused batch stops the run with the server's words.
  const dryBatches = tallyImportBatches(file, { buildId: 363, replace: false, reason: "r", dryRun: true });
  const drySent = [];
  await runCoinsTallyImport({ options: { apiUrl: "x" }, operation: { path: "/p", buildId: 363, file, batches: dryBatches }, authToken: "t",
    request: async ({ headers }) => { drySent.push(headers); return { ok: true, data: {} }; } });
  assert.ok(drySent.every((h) => !("x-lumine-idempotency-key" in h)));
  await assert.rejects(
    runCoinsTallyImport({ options: { apiUrl: "x" }, operation: { path: "/p", buildId: 363, file, batches }, authToken: "t",
      request: async () => ({ ok: false, error: { code: "CLI_ADMIN_COINS_INVALID", message: "These player ids do not exist: 7." } }) }),
    /do not exist/
  );
});

// review-r2 M4: the replace dry run says what it keeps and why; L8: removals kept are counted.
test("tally-import output names the blocks --replace-region keeps and the file cells left alone", () => {
  const lines = formatCoinsResult({
    operation: { name: "coins.tally-import.preview" },
    data: { dryRun: true, buildId: 363, region: "mountains1", at: 1793980053, batches: 1, regionCellsBefore: 10, cleared: 6,
      replaceKeeps: { live: 3, newer: 0, consumed: 1, total: 4 }, placed: 5, removed: 2, keptNewer: 3, keptNewerPlaced: 2, keptNewerRemoved: 1 },
  });
  const text = lines.join("\n");
  assert.match(text, /would clear 6 older imported blocks \(--replace-region\)/);
  assert.match(text, /--replace-region keeps 4 blocks: 3 recorded live \(never touched by an import\), 0 imported from newer history, 1 used up by a sale/);
  assert.match(text, /3 file cells left alone because a live, newer or used-up block holds them \(2 placements, 1 removals\)/);
  assert.match(text, /Nothing was written/);
});

// review-r2 M2: the admin's fix for fake builder records.
test("tally-clear: one player's records, optional region and area, a dry run without --confirm", () => {
  const base = { adminConfirm: "", adminReason: "fake blocks over plot", adminUser: "77" };
  const dry = buildCoinsOperation({ action: "tally-clear", target: "363", options: base });
  assert.equal(dry.name, "coins.tally-clear.preview");
  assert.equal(dry.path, "/cli/admin/coins/tally-clear");
  assert.equal(dry.mutates, false);
  assert.deepEqual(dry.body, { buildId: 363, userId: 77, reason: "fake blocks over plot", dryRun: true });
  const real = buildCoinsOperation({ action: "tally-clear", target: "363", options: { ...base, adminConfirm: "true", adminCoinRegion: "mountains1", adminCoinArea: "112:-48:127:-33" } });
  assert.equal(real.name, "coins.tally-clear");
  assert.equal(real.mutates, true);
  assert.deepEqual(real.body, { buildId: 363, userId: 77, region: "mountains1", area: "112:-48:127:-33", reason: "fake blocks over plot", dryRun: false });
  assert.throws(() => buildCoinsOperation({ action: "tally-clear", target: "363", options: { ...base, adminUser: "" } }), /--user must be a positive whole number/);
  assert.throws(() => buildCoinsOperation({ action: "tally-clear", target: "363", options: { ...base, adminReason: "" } }), /--reason is required/);
  assert.throws(() => buildCoinsOperation({ action: "tally-clear", target: "363", options: { ...base, adminCoinRegion: "Mountains1" } }), /lowercase/);
  assert.throws(() => buildCoinsOperation({ action: "tally-clear", target: "363", options: { ...base, adminCoinArea: "0:0:15:15" } }), /--area needs --region/);
  for (const area of ["0:0:15", "00:0:15:15", "0:0:-1:15", "0:0:1e3:15"])
    assert.throws(() => buildCoinsOperation({ action: "tally-clear", target: "363", options: { ...base, adminCoinRegion: "main", adminCoinArea: area } }), /--area is x0:z0:x1:z1/);
  const lines = formatCoinsResult({
    operation: { name: "coins.tally-clear.preview" },
    data: { dryRun: true, buildId: 363, userId: 77, username: "rival", region: "mountains1", area: { x0: 112, z0: -48, x1: 127, z1: -33 },
      cells: 64, consumed: 0, touchedByOthers: 2, imported: 0, regions: [{ region: "mountains1", cells: 64, bounds: { x0: 112, x1: 127, z0: -48, z1: -33 } }] },
  });
  assert.match(lines[0], /^Dry run: would clear 64 recorded blocks of rival \(77\) in app 363, region mountains1, area 112:-48:127:-33\./);
  assert.match(lines.join(" "), /2 were broken or built over by another player since \(a hint the block was real\)/);
  assert.match(lines.at(-1), /Add --confirm to apply/);
});


test("coins list pages older purchases with --before (the server's nextBefore)", () => {
  const first = buildCoinsOperation({ action: "list", options: { adminConfirm: "", adminBuild: "363", adminCoinPrice: "plot" } });
  assert.equal(first.path, "/cli/admin/coins/purchases?buildId=363&priceId=plot");
  const older = buildCoinsOperation({ action: "list", options: { adminConfirm: "", adminBuild: "363", adminCoinPrice: "plot", adminCoinBefore: "4120" } });
  assert.equal(older.path, "/cli/admin/coins/purchases?buildId=363&priceId=plot&before=4120");
  assert.equal(older.mutates, false);
  assert.throws(() => buildCoinsOperation({ action: "list", options: { adminConfirm: "", adminBuild: "363", adminCoinBefore: "abc" } }), /--before must be a positive whole number/);
  const lines = formatCoinsResult({ operation: first, data: { receipts: [{ id: 4121, createdAt: 1794000000, buyer: { id: 7, username: "kid" }, kind: "purchase", priceId: "plot", key: "fw3:0:0", coins: 10000, destination: "removed", status: "active", holds: true }], nextBefore: 4121 } });
  assert.match(lines.at(-1), /re-run with --before 4121/);
});
