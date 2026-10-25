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
  "Usage: lumine admin arena queue | import --dir <paper folder> [--audio audio/<exam>/<paper>] [--live] [--confirm] | status --item <id> --to live|retired|checked [--confirm] [--json]";
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

export function buildArenaOperation({ action, options }) {
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
    const items = readPaper(options.adminDir);
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
        // the folder name is the paper; re-importing it retires its earlier copy
        paper: path.basename(path.resolve(options.adminDir)),
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
