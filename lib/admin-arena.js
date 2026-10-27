import fs from "node:fs";
import path from "node:path";

// `lumine admin arena queue|import|status`: Arena's mock-exam item bank
// (twinkle-api controllers/cli/admin/arena.ts). Papers are written, blind-
// solved and style-checked by Claude Code agents before they arrive here.
//   queue                      per exam, mode and item type: live items, the
//                              fewest unseen left for an active member, refills due
//   import --dir <paper>       a paper folder of <number>.json items; --audio
//                              audio/<exam>/<paper> attaches its recordings
//                              (uploaded first with twinkle-api
//                              scripts/arena-upload-media.ts); --live serves it
//                              at once; a dry run (validation only) unless --confirm;
//                              re-importing a folder retires that paper's earlier items
//   status --item <id> --to live|retired|checked
export const ARENA_USAGE =
  "Usage: lumine admin arena queue | marking [--cursor <id>] [--limit <1-200>] | import (--dir <paper folder> | --additive --file <reviewed-items.json>) [--audio audio/<exam>/<paper>] [--live] [--confirm] | status --item <id> --to live|retired|checked [--confirm] | today-queue [--cursor <id>] [--limit <1-100>] | today-member --user <id> | today-import --file <reviewed-questions.json> [--confirm] [--json]";
const MAX_ITEMS = 300;

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

function readPaper(dir) {
  if (!dir) throw validationError(ARENA_USAGE);
  const folder = path.resolve(dir);
  let names;
  try {
    names = fs.readdirSync(folder).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    throw validationError(`Cannot read the folder ${folder}.`);
  }
  if (!names.length || names.length > MAX_ITEMS) {
    throw validationError(`A paper folder holds 1 to ${MAX_ITEMS} <number>.json items.`);
  }
  return names
    .map((name) => JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")))
    .sort((a, b) => a.number - b.number);
}

function readAdditiveItems(file) {
  const resolved = path.resolve(file);
  if (fs.statSync(resolved).size > 5_000_000) {
    throw validationError("The additive import file must be under 5 MB.");
  }
  const items = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS ||
      items.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw validationError(`An additive import file must contain an array of 1 to ${MAX_ITEMS} reviewed items.`);
  }
  return items;
}

export function buildArenaOperation({ action, options }) {
  if (action === "today-queue") {
    const cursor = Number(options.adminCursor || 0);
    const limit = Number(options.adminLimit ?? 50);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw validationError("Use a non-negative --cursor and --limit from 1 to 100.");
    return { name: "arena.today.queue", method: "GET", path: `/cli/admin/arena/today/queue?cursor=${cursor}&limit=${limit}`, mutates: false, requiresRun: false };
  }
  if (action === "today-member") {
    const id = Number(options.adminUser);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError("Use today-member --user <member id>.");
    return { name: "arena.today.member", method: "GET", path: `/cli/admin/arena/today/member/${id}`, mutates: false, requiresRun: false };
  }
  if (action === "today-import") {
    if (!options.adminFile) throw validationError("Use today-import --file <reviewed-questions.json> [--confirm].");
    const file = path.resolve(options.adminFile);
    if (fs.statSync(file).size > 1000000) throw validationError("The import file must be under 1 MB.");
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    const confirm = confirmed(options);
    return { name: confirm ? "arena.today.import" : "arena.today.preview", method: "POST", path: "/cli/admin/arena/today/import", body: { ...payload, dryRun: !confirm }, mutates: confirm, requiresRun: false };
  }
  if (action === "marking") {
    const cursor = Number(options.adminCursor || 0);
    const limit = Number(options.adminLimit ?? 100);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw validationError("Use a non-negative --cursor and --limit from 1 to 200.");
    }
    return {
      name: "arena.marking", method: "GET",
      path: `/cli/admin/arena/marking?cursor=${cursor}&limit=${limit}`,
      body: undefined, mutates: false, requiresRun: false,
    };
  }
  if (!action || action === "queue") {
    return {
      name: "arena.queue",
      method: "GET",
      path: "/cli/admin/arena/queue",
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "import") {
    const additive = Boolean(options.adminArenaAdditive);
    if ((options.adminFile && options.adminDir) || (options.adminFile && !additive)) {
      throw validationError("Use --dir for a complete paper, or --additive with exactly one of --file or --dir for a refill.");
    }
    const items = options.adminFile ? readAdditiveItems(options.adminFile) : readPaper(options.adminDir);
    const confirm = confirmed(options);
    return {
      name: confirm ? "arena.import" : "arena.import.preview",
      method: "POST",
      path: "/cli/admin/arena/items/import",
      body: {
        items,
        live: Boolean(options.adminArenaLive),
        dryRun: !confirm,
        ...(options.adminArenaAudio ? { audioPrefix: options.adminArenaAudio } : {}),
        // Full papers retain their replacement semantics. Additive refills
        // preserve the existing bank without retiring another paper's items.
        ...(!additive ? { paper: path.basename(path.resolve(options.adminDir)) } : {}),
      },
      mutates: confirm,
      requiresRun: false,
      timeoutMs: 120000,
    };
  }
  if (action === "status") {
    const id = Number(options.adminArenaItem);
    const to = String(options.adminArenaTo || "");
    if (!Number.isInteger(id) || id <= 0 || !["live", "retired", "checked"].includes(to)) {
      throw validationError(ARENA_USAGE);
    }
    if (!confirmed(options)) {
      throw validationError(`This changes what members are served: add --confirm to set item ${id} ${to}.`);
    }
    return {
      name: "arena.status",
      method: "POST",
      path: `/cli/admin/arena/items/${id}/status`,
      body: { status: to },
      mutates: true,
      requiresRun: false,
    };
  }
  throw validationError(ARENA_USAGE);
}

export function formatArenaResult({ operation, data }) {
  if (operation.name === "arena.today.queue") return [
    ...(data?.members || []).map(m => `#${m.userId} ${m.username}: ${m.ready} questions ready${m.refillDue ? `; refill to ${m.target}` : ""} (preferences v${m.revision})`),
    data?.nextCursor ? `Continue: lumine admin arena today-queue --cursor ${data.nextCursor} --json` : "End of Today’s Q queue.",
  ];
  if (operation.name === "arena.today.member") return [JSON.stringify(data, null, 2)];
  if (operation.name === "arena.today.preview" || operation.name === "arena.today.import") return [
    `${data?.dryRun ? "Dry run" : "Saved"}: ${data?.questions?.length || 0} reviewed personal questions.${data?.dryRun ? " Add --confirm to make new questions available." : ""}`,
  ];
  if (operation.name === "arena.marking") {
    const entries = data?.entries || [];
    return [
      `Checked ${data?.scannedBattles ?? 0} completed battles; ${entries.length} need follow-up on this page.`,
      ...entries.map((row) => `Battle ${row.battleId}, member ${row.userId}, ${row.examKey}: ${row.reasons.join(", ")} (${row.pendingAnswers} answers pending; ${row.xpEarned}/${row.xpExpected} XP and ${row.coinsEarned}/${row.coinsExpected} Coins paid)`),
      ...(data?.nextCursor ? [`Continue: lumine admin arena marking --cursor ${data.nextCursor} --json`] : ["End of marking/reward census."]),
    ];
  }
  if (operation.name === "arena.queue") {
    const types = data?.types || [];
    if (!types.length) return ["No live Arena items yet."];
    const due = types.filter((t) => t.refillDue);
    return [
      ...types.map(
        (t) =>
          `${t.examFamily} ${t.difficulty || "normal"} ${t.itemType}: ${t.live} live, ${t.activeLearners ?? "unknown"} active learner(s), ${t.minFresh} unseen${
            t.stockLow && !t.refillDue ? " (low stock; no active demand)" : ""
          }${
            t.refillDue ? ` -> write ${t.toWrite}` : ""
          }`,
      ),
      due.length ? `${due.length} type(s) due for a refill.` : "No refill due.",
    ];
  }
  if (operation.name === "arena.import.preview") {
    return [`Dry run: ${data?.wouldImport ?? 0} item(s) pass validation. Add --confirm to import.`];
  }
  if (operation.name === "arena.import") {
    return [`Imported ${data?.imported ?? 0} item(s).`];
  }
  return [`Item ${data?.id} is now ${data?.status}.`];
}
