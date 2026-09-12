import fs from "fs/promises";
import path from "path";

import { requestJson } from "./http.js";
import { findLocalProjectMetadata } from "./workspace.js";
import { ensureAuth, assertAuthScope } from "./auth.js";
import { resolveRequiredBuildIdOrSelected } from "./commands.js";

// Creator-side reward tooling.
//
// An app that pays XP or Coins declares its economy in `rewards.json` at the
// project root: rule ids, titles, amounts, tries, retry share, budgets. The
// reviewer reads that file next to the code. Quiz rules also need questions
// with answer keys, and those must never be project files (published source
// is readable by every player), so they travel separately as the private
// question sheet: `lumine rewards sheet <file.json>` uploads it to Twinkle,
// where it is merged with rewards.json when the version is sent for review.

const REWARDS_FILE = "rewards.json";

async function readWorkspaceRewardsJson(options) {
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  if (!localProject?.rootDir) return { present: false, value: undefined };
  const filePath = path.join(localProject.rootDir, REWARDS_FILE);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, value: undefined };
    throw error;
  }
  try {
    return { present: true, value: JSON.parse(raw), filePath };
  } catch (error) {
    throw new Error(`${REWARDS_FILE} is not valid JSON: ${error?.message || error}`);
  }
}

async function checkDeclaration({ options, auth, buildId, rewardsJson, sheet }) {
  return await requestJson({
    url: `${options.apiUrl}/cli/build/${buildId}/rewards/check`,
    method: "POST",
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
    body: {
      ...(rewardsJson === undefined ? {} : { rewardsJson }),
      ...(sheet === undefined ? {} : { sheet }),
    },
  });
}

function printDeclaration(result, { prefix = "" } = {}) {
  const rules = Array.isArray(result?.rules) ? result.rules : [];
  if (result?.ok) {
    console.log(
      `${prefix}Rewards declaration: ok (${rules.length} rule${rules.length === 1 ? "" : "s"}${result.sheetPresent ? ", question sheet on file" : ""}).`,
    );
    for (const rule of rules) {
      const what =
        rule.verifier === "completion"
          ? `completion · at least ${rule.minSeconds || 0}s`
          : `quiz · ${rule.questionSets} set(s)${rule.progression ? ` · ${rule.progression}` : ""}${rule.standingQuestions ? ` · ${rule.standingQuestions} standing` : ""}`;
      console.log(`${prefix}  ${rule.id}: ${rule.title} · ${rule.xp} XP + ${rule.coins} Coins · ${what}`);
    }
    return;
  }
  console.log(`${prefix}Rewards declaration: NOT ready.`);
  for (const error of result?.errors || []) console.log(`${prefix}  - ${error}`);
}

// Part of `lumine check`: only speaks up when the workspace declares rewards
// or the server says the code uses the rewards SDK.
export async function reportRewardDeclaration({ options, auth, buildId }) {
  let local;
  try {
    local = await readWorkspaceRewardsJson(options);
  } catch (error) {
    console.error(`Local check error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!local.present) return;
  try {
    const result = await checkDeclaration({
      options,
      auth,
      buildId,
      rewardsJson: local.value,
    });
    printDeclaration(result, { prefix: "Local check: " });
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const reason = String(error?.message || error).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
    console.error(`Local check warning: rewards declaration not verified (${reason}).`);
  }
}

export async function rewardsCommand(options) {
  const action = String(options.positional?.[0] || "check");
  if (options.help) {
    printRewardsHelp();
    return;
  }
  const auth = await ensureAuth(options);
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  if (action === "check") {
    const local = await readWorkspaceRewardsJson(options);
    const result = await checkDeclaration({
      options,
      auth,
      buildId,
      rewardsJson: local.present ? local.value : undefined,
    });
    if (options.json) {
      console.log(JSON.stringify({ ...result, source: local.present ? "workspace" : "saved" }, null, 2));
    } else {
      console.log(
        local.present
          ? `Checked ${REWARDS_FILE} from this workspace against the question sheet on file.`
          : `No ${REWARDS_FILE} in this workspace; checked the saved version instead.`,
      );
      printDeclaration(result);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "sheet") {
    if (options.show) {
      const result = await requestJson({
        url: `${options.apiUrl}/cli/build/${buildId}/rewards/sheet`,
        authToken: auth.token,
        timeoutMs: options.timeoutMs,
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else if (!result.sheet) console.log("No question sheet on file for this app.");
      else {
        const rules = Object.entries(result.sheet.rules || {});
        console.log(`Question sheet on file: ${rules.length} rule(s).`);
        for (const [id, entry] of rules) {
          const sets = Array.isArray(entry.sets) ? entry.sets.length : 0;
          const standing = Array.isArray(entry.questions) ? entry.questions.length : 0;
          console.log(`  ${id}: ${sets} set(s), ${standing} standing question(s)`);
        }
      }
      return;
    }
    const file = options.positional?.[1];
    if (!file) throw new Error("Usage: lumine rewards sheet <file.json> | --show");
    await assertAuthScope({ options, auth, scope: "build:write" });
    let sheet;
    try {
      sheet = JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
    } catch (error) {
      throw new Error(`Could not read ${file}: ${error?.message || error}`);
    }
    const result = await requestJson({
      url: `${options.apiUrl}/cli/build/${buildId}/rewards/sheet`,
      method: "PUT",
      authToken: auth.token,
      timeoutMs: options.timeoutMs,
      body: { sheet },
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Question sheet uploaded for Build ${buildId}. It is kept off the project files and merged with ${REWARDS_FILE} when you send the version for review.`);
      printDeclaration(result);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  printRewardsHelp();
  throw new Error(`Unknown rewards action: ${action}`);
}

function printRewardsHelp() {
  console.log(`Usage:
  lumine rewards check              Validate rewards.json (workspace or saved) against the question sheet on file
  lumine rewards sheet <file.json>  Upload the private question sheet ({ rules: { <ruleId>: { questions?, sets? } } })
  lumine rewards sheet --show       Summarize the sheet on file (never prints answer keys)

rewards.json (project root) declares the economy the reviewer approves:
  { "dailyXP", "dailyCoins", "userDailyXP", "userDailyCoins", "lifetimeXP", "lifetimeCoins", "userDailyClaims"?,
    "rules": [{ "id", "title", "xp", "coins", "verifier": "numeric-quiz" | "completion",
                "maxAttempts"?, "retry"?: { "xpPercent", "coinsPercent" }, "minSeconds"? (completion), "progression"?: "dated" | "until-earned" (quiz) }] }
Questions and answer keys never go in project files; they belong in the sheet.`);
}
