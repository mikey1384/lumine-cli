import { isDeepStrictEqual } from "node:util";

export const LEVELS = [
  "e1",
  "e2",
  "e3",
  "e4",
  "e5",
  "e6",
  "m1",
  "m2",
  "m3",
  "h1",
  "h2",
  "h3",
];

export function verifyRewardEconomy(config, response) {
  const withoutRefillSets = (value) => ({
    ...value,
    rules: value.rules.map((rule) => {
      if (!LEVELS.some((level) => rule.id === `${level}-daily`)) return rule;
      const { sets: _sets, ...economy } = rule;
      return economy;
    }),
  });
  if (
    !isDeepStrictEqual(
      withoutRefillSets(config),
      withoutRefillSets(response.data.review.config),
    )
  ) {
    throw new Error(
      "A refill must preserve the approved reward rules and budgets. Review any economy change separately.",
    );
  }
}

// Refill-only: edits/removals to existing questions need a separate content review.
export function verifyApprovedPrefix(sheet, response) {
  const review = response?.data?.review;
  const artifact = Number(review?.publishedArtifactVersionId);
  if (
    response?.ok !== true ||
    Number(review?.buildId) !== 2460 ||
    review?.status !== "approved" ||
    review?.isLive !== true ||
    !Number.isSafeInteger(artifact) ||
    artifact <= 0 ||
    Number(review?.publishedVersionId) !== artifact
  ) {
    throw new Error(
      "A fresh, live, approved Math Lab review is required. Re-read the current reward review.",
    );
  }
  const rules = review.config?.rules;
  if (!Array.isArray(rules))
    throw new Error("The approved review has no question rules.");
  const result = [];
  for (const level of LEVELS) {
    const id = `${level}-daily`;
    const matches = rules.filter((rule) => rule.id === id);
    const before = matches[0]?.sets;
    const after = sheet?.rules?.[id]?.sets;
    if (
      matches.length !== 1 ||
      !Array.isArray(before) ||
      !before.length ||
      !Array.isArray(after)
    ) {
      throw new Error(
        `${id}: missing or ambiguous approved questions or candidate grade.`,
      );
    }
    if (after.length < before.length)
      throw new Error(
        `${id}: candidate loses ${before.length - after.length} approved questions.`,
      );
    for (let i = 0; i < before.length; i++) {
      if (!isDeepStrictEqual(after[i], before[i])) {
        throw new Error(
          `${id}: approved question ${before[i].key || i + 1} changed or moved. Sync the canonical sheet before refilling.`,
        );
      }
    }
    const keys = after.map((set) => set.key);
    if (
      keys.some((key) => typeof key !== "string" || !key.trim()) ||
      new Set(keys).size !== keys.length
    ) {
      throw new Error(`${id}: question keys must be present and unique.`);
    }
    result.push({
      rule: id,
      preserved: before.length,
      added: after.length - before.length,
    });
  }
  return {
    liveReview: Number(review.id),
    artifactVersionId: artifact,
    preservedExact: true,
    rules: result,
  };
}
