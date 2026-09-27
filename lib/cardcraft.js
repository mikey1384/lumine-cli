import fs from "fs/promises";
import path from "path";

import { requestJson } from "./http.js";
import { findLocalProjectMetadata } from "./workspace.js";
import { ensureAuth, assertAuthScope } from "./auth.js";
import { resolveRequiredBuildIdOrSelected } from "./commands.js";

// Creator-side AI Card crafting tooling (Twinkle.cardCraft).
//
// An app declares what AI Cards can become in it in `cardcraft.json` at the
// project root: kinds (pet, snack, furniture …) with their parameters, and
// which kinds each card colour (1 blue … 6 black) can become. A reviewer
// approves the recipe; the approved copy is what crafting uses, so editing
// the file changes nothing live until the next approval.

const CARDCRAFT_FILE = "cardcraft.json";

async function readWorkspaceCardCraftJson(options) {
  const localProject = await findLocalProjectMetadata(
    path.resolve(options.dir || process.cwd()),
  );
  if (!localProject?.rootDir) return { present: false, value: undefined };
  let raw;
  try {
    raw = await fs.readFile(path.join(localProject.rootDir, CARDCRAFT_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, value: undefined };
    throw error;
  }
  try {
    return { present: true, value: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`${CARDCRAFT_FILE} is not valid JSON: ${error?.message || error}`);
  }
}

function printCheck(result) {
  if (!result?.ok) {
    console.log("Card crafting recipe: NOT ready.");
    for (const error of result?.errors || []) console.log(`  - ${error}`);
    return;
  }
  const summary = result.summary || {};
  console.log(
    `Card crafting recipe: ok (${(summary.kinds || []).length} kind(s); card colours ${(summary.acceptedLevels || []).join(", ") || "none"}).`,
  );
  for (const kind of summary.kinds || [])
    console.log(`  ${kind.id}: ${kind.label} · params ${kind.params.join(", ") || "none"}`);
  if (result.nextStep) console.log(result.nextStep);
}

export async function cardcraftCommand(options) {
  const action = String(options.positional?.[0] || "check");
  if (options.help) {
    printCardCraftHelp();
    return;
  }
  const auth = await ensureAuth(options);
  const buildId = await resolveRequiredBuildIdOrSelected(options, auth);
  if (action === "check") {
    const local = await readWorkspaceCardCraftJson(options);
    const result = await requestJson({
      url: `${options.apiUrl}/build/${buildId}/cardcraft/check`,
      method: "POST",
      authToken: auth.token,
      timeoutMs: options.timeoutMs,
      body: local.present ? { cardcraftJson: local.value } : {},
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        local.present
          ? `Checked ${CARDCRAFT_FILE} from this workspace.`
          : `No ${CARDCRAFT_FILE} in this workspace; checked the saved version instead.`,
      );
      printCheck(result);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === "status") {
    const result = await requestJson({
      url: `${options.apiUrl}/build/${buildId}/cardcraft`,
      authToken: auth.token,
      timeoutMs: options.timeoutMs,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Card crafting: ${result.state}. ${result.message || ""}`.trim());
      if (result.latestReview)
        console.log(
          `Latest review #${result.latestReview.id}: ${result.latestReview.status}${result.latestReview.reason ? ` · ${result.latestReview.reason}` : ""}`,
        );
      for (const problem of result.problems || []) console.log(`  - ${problem}`);
    }
    return;
  }
  if (action === "review") {
    await assertAuthScope({ options, auth, scope: "build:write" });
    const result = await requestJson({
      url: `${options.apiUrl}/build/${buildId}/cardcraft/reviews`,
      method: "POST",
      authToken: auth.token,
      timeoutMs: options.timeoutMs,
      body: {},
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.state === "approved")
      console.log(`The saved ${CARDCRAFT_FILE} is already the approved recipe (#${result.reviewId}).`);
    else
      console.log(
        `Sent the saved ${CARDCRAFT_FILE} of Build ${buildId} for review (request #${result.reviewId}${result.duplicate ? ", already waiting" : ""}). Any approved recipe keeps working until this one is approved.`,
      );
    return;
  }
  printCardCraftHelp();
  throw new Error(`Unknown cardcraft action: ${action}`);
}

function printCardCraftHelp() {
  console.log(`Usage:
  lumine cardcraft check    Validate cardcraft.json (workspace, else the saved version)
  lumine cardcraft status   Approved / waiting for review / needs review
  lumine cardcraft review   Send the saved cardcraft.json for review

cardcraft.json (project root) says what AI Cards can become in this app:
  { "guidance"?: "short creative brief",
    "kinds": [{ "id", "label", "description"?,
                "params": { "<name>": { "type": "enum", "values": [...] }
                                     | { "type": "integer" | "number", "min", "max", "scaleWithTier"? }
                                     | { "type": "boolean" } | { "type": "string", "maxLength" } } }],
    "tiers": { "1": ["<kind>"], … "6": ["<kind>"] } }
Card colours: 1 blue, 2 pink, 3 orange, 4 magenta, 5 gold, 6 black (grander as they go up);
quality (common … legendary) sets the finish effects. A card can be crafted once, ever;
the asset stays with the card when it is sold. Use Twinkle.cardCraft in the app.`);
}
