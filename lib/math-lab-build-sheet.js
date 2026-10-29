// Merges parts/<level>.json into the private question sheet the Math Lab
// uploads with `lumine rewards sheet`, then validates the sheet against the
// workspace's rewards.json exactly the way the server will (same code).
// Usage: node --import tsx build-sheet.mjs --approved-review <live review id>
// Reads that review afresh and preserves its questions before writing output.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LEVELS,
  verifyApprovedPrefix,
  verifyRewardEconomy,
} from "./math-lab-preservation.js";

export function serializeMathLabSets(sets) {
  return sets.map((set) => ({
    key: set.key,
    // This also makes a set eligible as a rematch of the named puzzle.
    // It remains an ordinary collection puzzle for other learners.
    // Preserve it for existing and appended sets; let canonical validation
    // reject invalid references instead of silently changing their meaning.
    ...(set.variantOf !== undefined ? { variantOf: set.variantOf } : {}),
    questions: set.questions.map((q) => ({
      prompt: q.prompt,
      answer: q.answer,
      ...(q.hint ? { hint: q.hint } : {}),
      ...(q.guide ? { guide: q.guide } : {}),
    })),
  }));
}

export async function buildMathLabSheet({
  contentDir,
  apiRoot,
  appDir,
  outputFile,
  args = process.argv.slice(2),
}) {
  const here = path.resolve(contentDir);
  // Private review directories need not imitate the historical sibling layout.
  // Defaults preserve existing wrappers; explicit paths retain the same guards.
  const policyRoot = path.resolve(
    apiRoot || path.join(here, "..", "..", "twinkle-api"),
  );
  const declaredApp = path.resolve(appDir || path.join(here, "..", "math-lab"));
  const parts = path.join(here, "parts");
  if (
    args.length !== 2 ||
    args[0] !== "--approved-review" ||
    !/^[1-9]\d*$/.test(args[1])
  ) {
    throw new Error(
      "Usage: node --import tsx build-sheet.mjs --approved-review <current live review id>. No sheet was written.",
    );
  }
  const cli = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));
  const approved = JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        "admin",
        "reward-review",
        "show",
        args[1],
        "--json",
        "--no-update-check",
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  );
  const sheet = { rules: {} };
  const missing = [];
  for (const level of LEVELS) {
    const file = path.join(parts, `${level}.json`);
    if (!fs.existsSync(file)) {
      missing.push(level);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    sheet.rules[`${level}-daily`] = {
      sets: serializeMathLabSets(data.sets),
    };
  }
  const out = path.resolve(
    outputFile || path.join(here, "..", "math-lab-sheet.json"),
  );
  if (missing.length)
    throw new Error(
      `Missing grade parts: ${missing.join(", ")}. No sheet was written.`,
    );
  const preservation = verifyApprovedPrefix(sheet, approved);

  // Server-identical validation: rewards.json + sheet → approved-shape config.
  const policy = await import(
    pathToFileURL(
      path.join(policyRoot, "helpers", "build", "rewardsPolicy.ts"),
    ).href
  );
  const declared = JSON.parse(
    fs.readFileSync(path.join(declaredApp, "rewards.json"), "utf8"),
  );
  const composed = policy.composeRewardConfig({ declared, sheet });
  if (composed.errors.length) {
    for (const error of composed.errors) console.log(`- ${error}`);
    process.exit(1);
  }
  verifyRewardEconomy(composed.config, approved);
  const total = composed.config.rules.reduce(
    (sum, rule) => sum + (rule.sets || []).length,
    0,
  );
  // Nothing replaces the prior usable sheet until every check succeeds.
  const output = JSON.stringify(sheet, null, 1) + "\n";
  fs.writeFileSync(`${out}.next`, output, { mode: 0o600 });
  fs.renameSync(`${out}.next`, out);
  fs.writeFileSync(
    `${out}.preservation.json`,
    JSON.stringify(
      {
        ...preservation,
        checkedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(output).digest("hex"),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    `wrote ${out}; preserved ${preservation.rules.reduce((n, r) => n + r.preserved, 0)} published questions from review ${preservation.liveReview}`,
  );
  console.log(
    `composed OK: ${composed.config.rules.length} rules, ${total} sets, ${Buffer.byteLength(JSON.stringify(sheet))} bytes`,
  );
}
