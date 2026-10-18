import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testWorkRoot } from "./helpers/work-directory.js";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { formatSlidingBlockResult } from "../lib/admin-sliding-block.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", "sliding-block", ...args]));
const BOARD = [[2, 0, 2, 1], [1, 3, 3, 0]];

function levelsFile(levels) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "sliding-block-"));
  const file = path.join(dir, "levels.json");
  fs.writeFileSync(file, JSON.stringify(levels));
  return file;
}

test("sliding-block status reads; add is a dry run unless --confirm", () => {
  const status = op("status");
  assert.equal(status.method, "GET");
  assert.equal(status.path, "/cli/admin/sliding-block/status");
  assert.equal(status.mutates, false);
  const file = levelsFile([[1, BOARD]]);
  const dry = op("add", "--file", file);
  assert.equal(dry.name, "sliding-block.add.preview");
  assert.equal(dry.mutates, false);
  assert.equal(dry.requiresRun, false);
  assert.deepEqual(dry.body, { levels: [[1, BOARD]], dryRun: true });
  const real = op("add", "--file", file, "--confirm");
  assert.equal(real.name, "sliding-block.add");
  assert.equal(real.mutates, true);
  assert.equal(real.body.dryRun, false);
  assert.throws(() => op("add", "--file", levelsFile([])), /1 to 100 levels/);
  assert.throws(() => op("add", "--file", levelsFile(Array.from({ length: 101 }, () => [1, BOARD]))), /1 to 100 levels/);
  assert.throws(() => op("add", "--file", file, "--confirm=yes"), /--confirm on its own/);
  assert.throws(() => op("remove"), /Usage/);
});

test("sliding-block results read plainly", () => {
  assert.deepEqual(
    formatSlidingBlockResult({
      operation: { name: "sliding-block.add" },
      data: { dryRun: false, added: [{ index: 857, minMoves: 14 }, { index: 858, minMoves: 15 }], skipped: [{ position: 2, reason: "already in the campaign" }], levels: 859 },
    }),
    ["Added 2 level(s) (858-859); campaign now has 859 levels.", "Skipped 1: #2 already in the campaign"],
  );
  assert.deepEqual(
    formatSlidingBlockResult({ operation: { name: "sliding-block.status" }, data: { levels: 859, baseLevels: 857, addedLevels: 2, byMoves: { 2: 80, 14: 13 } } }),
    ["Campaign: 859 levels (857 base + 2 added)", "Levels by minimum moves: 2:80 14:13"],
  );
});
