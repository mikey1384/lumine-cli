// Rules only a timer checks (10-20): the server's warning is printed by
// `lumine rewards check` and `lumine admin review show`, never as a failure.
import test from "node:test";
import assert from "node:assert/strict";
import { printDeclaration } from "../lib/rewards.js";
import { printRewardReviewResult } from "../lib/admin.js";

function captured(fn) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = log;
  }
  return lines;
}
const warning = "Nothing checks “Clear Level 1”: it pays when the app says it is finished.";

test("rewards check prints the timer warning after an ok declaration", () => {
  const lines = captured(() =>
    printDeclaration({
      ok: true,
      rules: [{ id: "clear-level-01", title: "Clear Level 1", xp: 5000, coins: 500, verifier: "completion", minSeconds: 1 }],
      warnings: [warning],
    }),
  );
  assert.match(lines[0], /Rewards declaration: ok \(1 rule\)/);
  assert.ok(lines.includes(`WARNING: ${warning}`));
});

test("admin review show prints the timer warning", () => {
  const lines = captured(() =>
    printRewardReviewResult({
      operation: { name: "reward-review.get" },
      data: { review: { id: 284, status: "pending", rules: [], timerOnlyWarnings: [warning] } },
    }),
  );
  assert.ok(lines.includes(`WARNING: ${warning}`));
});
