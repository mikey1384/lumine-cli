import { readAdminJsonFile } from "./admin-news.js";

// `lumine admin craft seed|stats|revise`: our agents curate a Twinkle.craft
// universe (Infinity Craft), Math Lab style. seed writes pairs we wrote (no
// AI call), stats shows sizes, the frontier, today's target and the newest
// AI answers to audit, revise corrects an item's teaching text. No daily run
// needed. seed and revise are dry runs unless --confirm is given.

export const CRAFT_USAGE =
  "Usage: lumine admin craft seed --build <id> --file <pairs.json> [--confirm] | stats --build <id> [--limit <n>] | revise --build <id> --item <id|name> [--why <text>] [--emoji <emoji>] [--category <field>] [--confirm] | retire --build <id> --item <id|name> --reason <text> [--confirm] | unfizzle --build <id> [--since <iso>] [--pair <a+b>] [--confirm] [--json].";
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

// A text flag: absent is undefined; present must carry a non-empty value
// (`--why` alone, or `--why=`, is refused instead of sending "true" or "").
function textFlag(value, flag) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw validationError(`${flag} needs a value.`);
  }
  return value;
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
    const item = textFlag(options.adminCraftItem, "--item");
    if (!item) throw validationError(`Pass --item <id|name>. ${CRAFT_USAGE}`);
    const body = { item: item.trim() };
    const why = textFlag(options.adminCraftWhy, "--why");
    const emoji = textFlag(options.adminCraftEmoji, "--emoji");
    const category = textFlag(options.adminCraftCategory, "--category");
    if (why !== undefined) body.why = why;
    if (emoji !== undefined) body.emoji = emoji;
    if (category !== undefined) body.category = category;
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
  if (action === "retire") {
    const item = textFlag(options.adminCraftItem, "--item");
    const reason = String(options.adminReason || "").trim();
    if (!item || reason.length < 3 || reason.length > 300) {
      throw validationError(`Pass --item <id|name> and --reason <why, 3-300 characters>. ${CRAFT_USAGE}`);
    }
    const confirm = confirmed(options);
    return {
      name: confirm ? "craft.retire" : "craft.retire.preview",
      method: "POST",
      path: `${base}/retire`,
      body: { item: item.trim(), reason, dryRun: !confirm },
      mutates: confirm,
      requiresRun: false,
    };
  }
  if (action === "unfizzle") {
    const since = String(options.adminSince || "").trim();
    if (since && !Number.isFinite(Date.parse(since))) {
      throw validationError("--since must be an ISO date or time, e.g. 2026-10-13T00:00:00Z.");
    }
    const pair = textFlag(options.adminCraftPair, "--pair");
    if (pair !== undefined && pair.split("+").filter((name) => name.trim()).length !== 2) {
      throw validationError("--pair must be two item names joined by +, e.g. Water+Fire.");
    }
    const confirm = confirmed(options);
    return {
      name: confirm ? "craft.unfizzle" : "craft.unfizzle.preview",
      method: "POST",
      path: `${base}/unfizzle`,
      body: {
        ...(since ? { since } : {}),
        ...(pair !== undefined ? { pair } : {}),
        dryRun: !confirm,
      },
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
    for (const entry of data.warnings || []) lines.push(`  warning ${entry.pair}: ${entry.reason}`);
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
  if (name.startsWith("craft.retire")) {
    lines.push(
      `${data.dryRun ? "DRY RUN: would retire" : "Retired"} ${data.item.name} (#${data.item.id}): ${data.pairsFizzled} pair(s) fizzled, hidden from ${data.collectionsHidden} collection(s)${data.dryRun ? "" : `, ${data.storySubjectsRemoved} story line(s) removed`}.`,
    );
    if (data.worldFirst) {
      lines.push(
        `  World First #${data.worldFirst.userId}: ${data.worldFirst.rewardPaid ? "already paid (stays paid)" : "unpaid reward voided"}.`,
      );
    }
    lines.push(`  Reason: ${data.reason}`);
    if (data.dryRun) lines.push("Nothing was written. Add --confirm to retire.");
    return lines;
  }
  if (name.startsWith("craft.unfizzle")) {
    lines.push(
      `${data.dryRun ? "DRY RUN: would reset" : "Reset"} ${data.reset} of ${data.scanned} fizzled pair(s) whose safety check errored.${data.more ? " More remain: run again." : ""}`,
    );
    for (const entry of data.pairs) lines.push(`  #${entry.pairId} ${entry.pair}`);
    if (data.dryRun) lines.push("Nothing was written. Add --confirm to reset.");
    return lines;
  }
  if (name === "craft.stats") {
    const items = data.items || {};
    lines.push(
      `Build #${data.buildId}: ${items.total} items (${items.starters} starters, ${items.seededUnclaimed} seeded not yet found by a player, ${items.worldFirsts} World Firsts, ${items.missingWordLevel} without a word level, ${items.retired || 0} retired).`,
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
