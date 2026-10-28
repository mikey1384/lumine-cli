import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation, assertAdminOperationAllowedForRunScope } from "../lib/admin.js";

test("website articles preview without mutation; publishing requires an explicit confirmation and editorial scope", () => {
  const dir = fs.mkdtempSync(path.resolve("../work/daily-cli-followup-20261028/article-test-"));
  const file = path.join(dir, "article.json");
  const article = { title: "A clearer app", description: "You can now keep your place.", coverageStart: 100, coverageEnd: 200,
    releaseEvidence: [{ repository: "twinkle-vite", commit: "a".repeat(40), deployedAt: 150, summary: "Resume your place" }] };
  try {
    fs.writeFileSync(file, JSON.stringify(article));
    const parse = (...flags) => parseAdminOperation(parseArgs(["admin", "subject", "post-update", "--file", file, ...flags]));
    const preview = parse();
    assert.equal(preview.mutates, false);
    assert.equal(preview.body.confirm, false);
    assert.deepEqual(preview.body.article, article);
    const publish = parse("--confirm");
    assert.equal(publish.mutates, true);
    assert.equal(publish.body.confirm, true);
    assert.equal(publish.path, "/cli/admin/subjects/website-update");
    for (const operation of [preview, publish]) {
      for (const runScope of ["full", "newspaper"]) assert.doesNotThrow(() => assertAdminOperationAllowedForRunScope({ operation, runScope }));
      for (const runScope of ["featured", "approvals"]) assert.throws(() => assertAdminOperationAllowedForRunScope({ operation, runScope }), /does not/);
    }
    assert.throws(() => parse("--confirm=false"), /confirm/);
    assert.throws(() => parse("--confirm", "--dry-run"), /not both/);
    assert.throws(() => parseAdminOperation(parseArgs(["admin", "subject", "post-update"])), /Usage/);
    fs.writeFileSync(file, "[]");
    assert.throws(() => parse(), /one composed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
