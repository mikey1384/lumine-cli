import { readAdminJsonFile } from "./admin-news.js";

// `lumine admin sliding-block status|add`: the sliding-block-v1 campaign
// (RushHour, build 2799), refilled Math Lab style by the daily website run.
// status shows how many levels each difficulty has; add appends boards made
// by twinkle-api/scripts/generate-sliding-block-boards.mjs after the
// campaign. The server solves every board again and skips duplicates; levels
// are never renumbered. add is a dry run unless --confirm is given.

export const SLIDING_BLOCK_USAGE =
  "Usage: lumine admin sliding-block status | add --file <levels.json> [--confirm] [--json]   (levels.json: [[minMoves, board], ...])";
const ADD_MAX = 100;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function confirmed(options) {
  const confirm = options.adminConfirm;
  // absent is "", a bare --confirm is "true"
  if (confirm !== "" && confirm !== "true") {
    throw validationError("Pass --confirm on its own, without a value.");
  }
  return confirm === "true";
}

export function buildSlidingBlockOperation({ action, options }) {
  if (!action || action === "status") {
    return {
      name: "sliding-block.status",
      method: "GET",
      path: "/cli/admin/sliding-block/status",
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "add") {
    const levels = readAdminJsonFile(options.adminFile, "--file <levels.json>", {
      maxBytes: 1024 * 1024,
    });
    if (!Array.isArray(levels) || !levels.length || levels.length > ADD_MAX) {
      throw validationError(
        `The file must hold 1 to ${ADD_MAX} levels as [[minMoves, board], ...]; split a bigger refill.`,
      );
    }
    const confirm = confirmed(options);
    return {
      name: confirm ? "sliding-block.add" : "sliding-block.add.preview",
      method: "POST",
      path: "/cli/admin/sliding-block/add",
      body: { levels, dryRun: !confirm },
      mutates: confirm,
      requiresRun: false,
      timeoutMs: 120000,
    };
  }
  throw validationError(SLIDING_BLOCK_USAGE);
}

export function formatSlidingBlockResult({ operation, data }) {
  if (operation.name === "sliding-block.status") {
    const moves = Object.entries(data?.byMoves || {})
      .map(([m, n]) => `${m}:${n}`)
      .join(" ");
    return [
      `Campaign: ${data?.levels} levels (${data?.baseLevels} base + ${data?.addedLevels} added)`,
      `Levels by minimum moves: ${moves}`,
    ];
  }
  const added = data?.added || [];
  const skipped = data?.skipped || [];
  const lines = [
    `${data?.dryRun ? "Dry run: would add" : "Added"} ${added.length} level(s)${
      added.length ? ` (${added[0].index + 1}-${added[added.length - 1].index + 1})` : ""
    }; campaign ${data?.dryRun ? "would have" : "now has"} ${data?.levels} levels.`,
  ];
  if (skipped.length)
    lines.push(
      `Skipped ${skipped.length}: ${skipped
        .slice(0, 10)
        .map((s) => `#${s.position} ${s.reason}`)
        .join("; ")}${skipped.length > 10 ? "; …" : ""}`,
    );
  if (data?.dryRun) lines.push("Nothing was written. Add --confirm to append them.");
  return lines;
}
