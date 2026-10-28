import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../lib/commands.js";
import { adminCommand } from "../lib/admin.js";

test("retained game diagnostics summarize through the real CLI without login or network", async (t) => {
  const dir = fs.mkdtempSync(path.resolve("../work/daily-cli-followup-20261028/game-reader-test-"));
  const file = path.join(dir, "receipts.json");
  const output = path.join(dir, "summary.json");
  t.mock.method(console, "log", () => {});
  t.mock.method(globalThis, "fetch", () => { throw new Error("Local summary attempted network access"); });
  try {
    const row = id => ({ id, topicId: 335, userId: 77, data: {
      artifactVersionId: 16292, kind: "save-failed", eventId: "session:1", privateText: "never print this" } });
    const source = JSON.stringify({ buildId: 2610, topic: "ashen-net-telemetry", entries: [row(1), row(2)],
      coverage: { complete: false, since: 10, until: 20 } });
    fs.writeFileSync(file, source);
    const options = parseArgs(["admin", "game-diagnostics", "summarize", "--file", file, "--output", output, "--json"]);
    const result = await adminCommand(options);
    assert.equal(result.changed, false);
    assert.equal(result.data.deduplication.retryDuplicateReceipts, 1);
    assert.equal(result.data.counts.byKind["save-failed"], 1);
    assert.equal(result.data.collection.complete, false);
    assert.doesNotMatch(fs.readFileSync(output, "utf8"), /never print this|privateText/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8"), source);
    fs.chmodSync(output, 0o644);
    await adminCommand(options);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600, 'An existing summary is private too');
    const hardlink = path.join(dir, "hardlink.json"), symlink = path.join(dir, "symlink.json");
    fs.linkSync(file, hardlink);
    fs.symlinkSync(file, symlink);
    for (const alias of [file, hardlink, symlink, ` ${file} `, ` ${hardlink} `, ` ${symlink} `]) {
      await assert.rejects(adminCommand({ ...options, adminOutput: alias }), /Keep the raw evidence/);
      assert.equal(fs.readFileSync(file, "utf8"), source);
    }
    await assert.rejects(adminCommand(parseArgs(["admin", "game-diagnostics", "summarize"])), /Usage/);
    fs.writeFileSync(file, "not json");
    await assert.rejects(adminCommand(options), /valid JSON/);
    fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    await assert.rejects(adminCommand(options), /16 MB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
