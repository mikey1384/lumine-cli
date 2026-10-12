import { readAdminJsonFile } from "./admin-news.js";

// `lumine admin craft seed|stats|revise`: our agents curate a Twinkle.craft
// universe (Infinity Craft), Math Lab style. seed writes pairs we wrote (no
// AI call), stats shows sizes, the frontier, today's target and the newest
// AI answers to audit, revise corrects an item's teaching text. No daily run
// needed. seed and revise are dry runs unless --confirm is given.

export const CRAFT_USAGE =
  "Usage: lumine admin craft seed --build <id> --file <pairs.json> [--confirm] | stats --build <id> [--limit <n>] | revise --build <id> --item <id|name> [--why <text>] [--emoji <emoji>] [--category <field>] [--confirm] [--json].";
const CRAFT_SEED_MAX = 500;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function buildIdOf(options) {
  const id = Number(String(options.adminBuild || "").trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw validationError(`Pass --build <id>. ${CRAFT_USAGE}`);
  }
  return id;
}

function confirmed(options) {
  const confirm = options.adminConfirm;
  if (confirm !== "" && confirm !== "true") {
    throw validationError("Pass --confirm on its own, without a value.");
  }
  return confirm === "true";
}

export function buildCraftOperation({ action, options }) {
  const buildId = buildIdOf(options);
  const base = `/cli/admin/builds/${buildId}/craft`;
  if (action === "stats") {
    const limit =
      options.adminLimit == null ? null : Number(String(options.adminLimit).trim());
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw validationError("--limit must be an integer 1-100.");
    }
    return {
      name: "craft.stats",
      method: "GET",
      path: `${base}/stats${limit ? `?recent=${limit}` : ""}`,
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "seed") {
    const raw = readAdminJsonFile(options.adminFile, "--file <pairs.json>", {
      maxBytes: 2 * 1024 * 1024,
    });
    const pairs = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : null;
    if (!pairs || !pairs.length || pairs.length > CRAFT_SEED_MAX) {
      throw validationError(
        `The file must hold 1 to ${CRAFT_SEED_MAX} pairs: [{ a, b, result: { name, emoji, category, why } }] or { pairs: [...] }.`,
      );
    }
    const confirm = confirmed(options);
    return {
      name: confirm ? "craft.seed" : "craft.seed.preview",
      method: "POST",
      path: `${base}/seed`,
      body: { pairs, dryRun: !confirm },
      mutates: confirm,
      requiresRun: false,
      timeoutMs: 300000,
    };
  }
  if (action === "revise") {
    const item = String(options.adminCraftItem || "").trim();
    if (!item) throw validationError(`Pass --item <id|name>. ${CRAFT_USAGE}`);
    const body = { item };
    if (options.adminCraftWhy !== "") body.why = options.adminCraftWhy;
    if (options.adminCraftEmoji !== "") body.emoji = options.adminCraftEmoji;
    if (options.adminCraftCategory !== "") body.category = options.adminCraftCategory;
    if (Object.keys(body).length === 1) {
      throw validationError("Pass at least one of --why, --emoji or --category (the name never changes).");
    }
    const confirm = confirmed(options);
    return {
      name: confirm ? "craft.revise" : "craft.revise.preview",
      method: "POST",
      path: `${base}/revise`,
      body: { ...body, dryRun: !confirm },
      mutates: confirm,
      requiresRun: false,
    };
  }
  throw validationError(CRAFT_USAGE);
}

export function formatCraftResult({ operation, data }) {
  const lines = [];
  const name = operation.name;
  if (name.startsWith("craft.seed")) {
    lines.push(
      `${data.dryRun ? "DRY RUN: would add" : "Added"} ${data.added} pair(s), ${data.newItems} new item(s); ${data.skipped.length} skipped, ${data.rejected.length} rejected.`,
    );
    if (data.wordLevels) {
      lines.push(`Word levels: ${data.wordLevels.set} set, ${data.wordLevels.pending} left for the lazy lookup.`);
    }
    for (const entry of data.skipped) lines.push(`  skipped ${entry.pair}: ${entry.reason}`);
    for (const entry of data.rejected) lines.push(`  rejected ${entry.pair}: ${entry.reason}`);
    if (data.dryRun) lines.push("Nothing was written. Add --confirm to seed.");
    return lines;
  }
  if (name.startsWith("craft.revise")) {
    const show = (value) => `${value.emoji} ${value.category} · ${value.why ?? "(no explanation)"}`;
    lines.push(`${data.dryRun ? "DRY RUN: " : ""}${data.item.name} (#${data.item.id})`);
    lines.push(`  before: ${show(data.before)}`);
    lines.push(`  after:  ${show(data.after)}`);
    if (data.dryRun) lines.push("Nothing was written. Add --confirm to revise.");
    return lines;
  }
  if (name === "craft.stats") {
    const items = data.items || {};
    lines.push(
      `Build #${data.buildId}: ${items.total} items (${items.starters} starters, ${items.seededUnclaimed} seeded not yet found by a player, ${items.worldFirsts} World Firsts, ${items.missingWordLevel} without a word level).`,
    );
    const pairs = Object.entries(data.pairs || {})
      .map(([source, statuses]) =>
        `${source}: ${Object.entries(statuses).map(([status, n]) => `${n} ${status}`).join(", ")}`,
      )
      .join(" · ");
    lines.push(`Pairs: ${pairs || "none"}.`);
    lines.push(
      `Frontier: ${data.frontier.unusedItems} item(s) never used as an input; ${data.frontier.untriedPairs} untried pair(s).`,
    );
    lines.push(
      data.today?.target
        ? `Today's Star (${data.today.day}): ${data.today.target} (#${data.today.targetId}), par ${data.today.par}.`
        : `Today's Star (${data.today?.day}): none yet (the universe is too young).`,
    );
    if ((data.recentAi || []).length) {
      lines.push("Newest AI answers (audit these):");
      for (const pair of data.recentAi) {
        lines.push(
          pair.result
            ? `  #${pair.pairId} ${pair.a} + ${pair.b} = ${pair.result.emoji} ${pair.result.name} (#${pair.result.id}, ${pair.result.category}, ${pair.result.wordLevel || "level pending"}): ${pair.why}`
            : `  #${pair.pairId} ${pair.a} + ${pair.b} = fizzle`,
        );
      }
    }
    return lines;
  }
  return null;
}
