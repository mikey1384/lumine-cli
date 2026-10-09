import test from "node:test";
import assert from "node:assert/strict";
import {
  LEVELS,
  verifyApprovedPrefix,
  verifyRewardEconomy,
} from "../lib/math-lab-preservation.js";

function fixture() {
  const sets = (level) => [
    {
      key: `${level}-01`,
      questions: [
        {
          prompt: "A puzzle",
          answer: -1,
          hint: "Try it",
          guide: { title: "Why", steps: [1, 2] },
        },
      ],
    },
  ];
  return {
    sheet: {
      rules: Object.fromEntries(
        LEVELS.map((level) => [`${level}-daily`, { sets: sets(level) }]),
      ),
    },
    response: {
      ok: true,
      data: {
        review: {
          id: 1,
          buildId: 2460,
          status: "approved",
          isLive: true,
          publishedArtifactVersionId: 100,
          publishedVersionId: 100,
          config: {
            rules: LEVELS.map((level) => ({
              id: `${level}-daily`,
              sets: sets(level),
            })),
          },
        },
      },
    },
  };
}
test("refills preserve all grades and accept only new trailing questions", () => {
  const { sheet, response } = fixture();
  sheet.rules["e3-daily"].sets.push({
    key: "e3-02",
    questions: [{ prompt: "New", answer: 2 }],
  });
  assert.equal(
    verifyApprovedPrefix(sheet, response).rules.find(
      (r) => r.rule === "e3-daily",
    ).added,
    1,
  );
});
test("stale grades, reordered questions, answer and guide changes all fail", () => {
  for (const edit of [
    (s) => s.rules["e1-daily"].sets.pop(),
    (s) => (s.rules["h2-daily"].sets[0].questions[0].answer = 3),
    (s) => s.rules["e6-daily"].sets[0].questions[0].guide.steps.reverse(),
    (s) => delete s.rules["m2-daily"],
  ]) {
    const { sheet, response } = fixture();
    edit(sheet);
    assert.throws(() => verifyApprovedPrefix(sheet, response));
  }
});
test("foreign, superseded and incomplete approvals cannot be a baseline", () => {
  for (const edit of [
    (r) => (r.buildId = 2),
    (r) => (r.status = "pending"),
    (r) => (r.isLive = false),
    (r) => (r.publishedVersionId = 101),
    (r) => r.config.rules.pop(),
  ]) {
    const { sheet, response } = fixture();
    edit(response.data.review);
    assert.throws(() => verifyApprovedPrefix(sheet, response));
  }
});
test("object key order is immaterial, duplicate appended keys fail", () => {
  const { sheet, response } = fixture();
  const set = sheet.rules["e1-daily"].sets[0];
  sheet.rules["e1-daily"].sets[0] = { questions: set.questions, key: set.key };
  assert.equal(verifyApprovedPrefix(sheet, response).preservedExact, true);
  sheet.rules["e1-daily"].sets.push(set);
  assert.throws(() => verifyApprovedPrefix(sheet, response), /unique/);
});
test("refilling questions cannot silently change budgets, rewards or other rules", () => {
  const { response } = fixture();
  const before = response.data.review.config;
  before.budgets = { userDailyCoins: 100 };
  before.rules.push({ id: "rematch", kind: "event", coins: 2 });
  const config = structuredClone(before);
  config.rules[0].sets.push({ key: "new", questions: [] });
  verifyRewardEconomy(config, response);
  for (const edit of [
    (c) => c.budgets.userDailyCoins++,
    (c) => c.rules.at(-1).coins++,
    (c) => c.rules.pop(),
    (c) => (c.rules[0].xp = 1),
  ]) {
    const changed = structuredClone(config);
    edit(changed);
    assert.throws(
      () => verifyRewardEconomy(changed, response),
      /preserve the approved reward/,
    );
  }
});
