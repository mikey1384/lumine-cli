import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testWorkRoot } from "./helpers/work-directory.js";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { buildCraftOperation, formatCraftResult } from "../lib/admin-craft.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", "craft", ...args]));
const STEAM = { name: "Steam", emoji: "♨️", category: "science", why: "Fire heats water into vapour." };

function pairsFile(pairs) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "craft-"));
  const file = path.join(dir, "pairs.json");
  fs.writeFileSync(file, JSON.stringify(pairs));
  return file;
}

test("craft seed is a dry run unless --confirm; the file goes as is", () => {
  const file = pairsFile([{ a: "Water", b: "Fire", result: STEAM }]);
  const dry = op("seed", "--build", "1499", "--file", file);
  assert.equal(dry.name, "craft.seed.preview");
  assert.equal(dry.method, "POST");
  assert.equal(dry.path, "/cli/admin/builds/1499/craft/seed");
  assert.equal(dry.mutates, false);
  assert.equal(dry.requiresRun, false);
  assert.deepEqual(dry.body, { pairs: [{ a: "Water", b: "Fire", result: STEAM }], dryRun: true });
  const real = op("seed", "--build", "1499", "--file", pairsFile({ pairs: [{ a: "Water", b: "Fire", result: STEAM }] }), "--confirm");
  assert.equal(real.name, "craft.seed");
  assert.equal(real.mutates, true);
  assert.equal(real.body.dryRun, false);
  assert.throws(() => op("seed", "--build", "1499", "--file", pairsFile([])), /1 to 500 pairs/);
  assert.throws(() => op("seed", "--build", "1499", "--file", pairsFile(Array.from({ length: 501 }, () => ({})))), /1 to 500 pairs/);
  assert.throws(() => op("seed", "--file", file), /--build/);
  assert.throws(() => op("seed", "--build", "1499", "--file", file, "--confirm=yes"), /--confirm on its own/);
});

test("craft stats reads; craft revise never sends a name and is a dry run by default", () => {
  const stats = op("stats", "--build", "1499", "--limit", "50");
  assert.deepEqual([stats.name, stats.method, stats.path, stats.mutates], ["craft.stats", "GET", "/cli/admin/builds/1499/craft/stats?recent=50", false]);
  assert.throws(() => op("stats", "--build", "1499", "--limit", "500"), /1-100/);
  const revise = op("revise", "--build", "1499", "--item", "Obsidian", "--why", "Lava cools fast into glassy rock.");
  assert.deepEqual(revise.body, { item: "Obsidian", why: "Lava cools fast into glassy rock.", dryRun: true });
  assert.equal(revise.mutates, false);
  const real = op("revise", "--build", "1499", "--item", "42", "--emoji", "🪨", "--category", "earth", "--confirm");
  assert.deepEqual(real.body, { item: "42", emoji: "🪨", category: "earth", dryRun: false });
  assert.equal(real.name, "craft.revise");
  assert.throws(() => op("revise", "--build", "1499", "--item", "42"), /at least one of --why/);
  assert.throws(() => op("unknown", "--build", "1499"), /Usage: lumine admin craft/);
});

test("craft results print plainly for agents", () => {
  const seed = formatCraftResult({
    operation: { name: "craft.seed.preview" },
    data: { dryRun: true, added: 2, newItems: 2, skipped: [], rejected: [{ pair: "Earth + Lava", reason: "not in the universe yet: Lava" }] }
  });
  assert.deepEqual(seed, [
    "DRY RUN: would add 2 pair(s), 2 new item(s); 0 skipped, 1 rejected.",
    "  rejected Earth + Lava: not in the universe yet: Lava",
    "Nothing was written. Add --confirm to seed."
  ]);
  const stats = formatCraftResult({
    operation: { name: "craft.stats" },
    data: {
      buildId: 1499,
      items: { total: 9, starters: 6, seededUnclaimed: 2, worldFirsts: 1, missingWordLevel: 0 },
      pairs: { seed: { ok: 3 }, ai: { ok: 1, fizzle: 1 } },
      frontier: { unusedItems: 4, untriedPairs: 40 },
      today: { day: "2026-10-12", targetId: 9, target: "Rain", par: 3 },
      recentAi: [
        { pairId: 7, a: "Lava", b: "Water", result: { id: 9, name: "Stone", emoji: "🪨", category: "earth", wordLevel: "basic" }, why: "Lava cools into rock." },
        { pairId: 8, a: "Fire", b: "Fire", result: null, why: null }
      ]
    }
  });
  assert.ok(stats.includes("Pairs: seed: 3 ok · ai: 1 ok, 1 fizzle."));
  assert.ok(stats.includes("Today's Star (2026-10-12): Rain (#9), par 3."));
  assert.ok(stats.includes("  #7 Lava + Water = 🪨 Stone (#9, earth, basic): Lava cools into rock."));
  assert.ok(stats.includes("  #8 Fire + Fire = fizzle"));
});

test("craft retire and unfizzle are dry runs unless --confirm", () => {
  const retire = op("retire", "--build", "1499", "--item", "Bad Name", "--reason", "Not suitable for children");
  assert.deepEqual([retire.name, retire.path, retire.mutates], ["craft.retire.preview", "/cli/admin/builds/1499/craft/retire", false]);
  assert.deepEqual(retire.body, { item: "Bad Name", reason: "Not suitable for children", dryRun: true });
  const real = op("retire", "--build", "1499", "--item", "42", "--reason", "Bad", "--confirm");
  assert.deepEqual([real.name, real.mutates, real.body.dryRun], ["craft.retire", true, false]);
  assert.throws(() => op("retire", "--build", "1499", "--item", "42"), /--reason/);
  const unfizzle = op("unfizzle", "--build", "1499", "--since", "2026-10-13T00:00:00Z", "--pair", "Water+Fire");
  assert.deepEqual(unfizzle.body, { since: "2026-10-13T00:00:00Z", pair: "Water+Fire", dryRun: true });
  assert.equal(unfizzle.path, "/cli/admin/builds/1499/craft/unfizzle");
  assert.deepEqual(op("unfizzle", "--build", "1499", "--confirm").body, { dryRun: false });
  assert.throws(() => op("unfizzle", "--build", "1499", "--since", "last week"), /ISO date/);
  assert.throws(() => op("unfizzle", "--build", "1499", "--pair", "Water"), /two item names/);
  const lines = formatCraftResult({
    operation: { name: "craft.unfizzle.preview" },
    data: { dryRun: true, scanned: 3, reset: 1, pairs: [{ pairId: 7, pair: "Water + Fire" }], more: false },
  });
  assert.deepEqual(lines, [
    "DRY RUN: would reset 1 of 3 fizzled pair(s) whose safety check errored.",
    "  #7 Water + Fire",
    "Nothing was written. Add --confirm to reset.",
  ]);
});

test("a text flag without a value is refused, never sent as \"true\"", () => {
  for (const flag of ["--why", "--emoji", "--category"]) {
    assert.throws(() => op("revise", "--build", "1499", "--item", "42", `${flag}=`), new RegExp(`${flag} needs a value`));
    // whatever parseArgs hands over for a bare flag, the command refuses it
    assert.throws(
      () => buildCraftOperation({
        action: "revise",
        options: { adminBuild: "1499", adminCraftItem: "42", adminConfirm: "", [{ "--why": "adminCraftWhy", "--emoji": "adminCraftEmoji", "--category": "adminCraftCategory" }[flag]]: true },
      }),
      new RegExp(`${flag} needs a value`),
    );
  }
  assert.throws(() => op("revise", "--build", "1499", "--why", "x", "--item="), /--item needs a value/);
});

test("seed warnings and kept flagged names print in plain output", () => {
  const seed = formatCraftResult({
    operation: { name: "craft.seed.preview" },
    data: {
      dryRun: true, added: 1, newItems: 1, skipped: [], rejected: [],
      warnings: [{ pair: "Glass + Fortune = Crystal Ball", reason: "\"ball\" is on Word Master's censored list; make sure the name reads innocently" }],
    },
  });
  assert.ok(seed.includes("  warning Glass + Fortune = Crystal Ball: \"ball\" is on Word Master's censored list; make sure the name reads innocently"));
  const stats = formatCraftResult({
    operation: { name: "craft.stats" },
    data: {
      buildId: 1499,
      items: { total: 9, starters: 6, seededUnclaimed: 0, worldFirsts: 1, missingWordLevel: 0, retired: 0 },
      pairs: { ai: { ok: 1 } },
      frontier: { unusedItems: 1, untriedPairs: 2 },
      today: { day: "2026-10-13", targetId: null, target: null, par: null },
      recentAi: [],
      keptFlagged: [{ pairId: 7, item: { id: 9, name: "Crystal Ball", emoji: "🔮" }, words: ["ball"], fine: 0.97, keptAt: 1760313600 }],
    },
  });
  assert.ok(stats.includes("Kept flagged names (a word matched the censored list; JEV kept them; check each):"));
  assert.ok(stats.includes("  #7 🔮 Crystal Ball (#9): \"ball\" · JEV 0.97 · 2025-10-13 00:00 UTC"));
});
