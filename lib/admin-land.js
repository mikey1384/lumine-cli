// lumine admin land: server-held land (Twinkle.land; the server is
// twinkle-api controllers/cli/admin/land.ts, wire contract in
// projects/lumine-land-enforcement/CONTRACT.md section 7). Reads: plots, who,
// edits. Writes (dry runs unless --confirm, audited, each batch idempotent):
// set-rules, the one-time imports (plots, cells, history, edits; they run
// before the land review is approved, against the pending review's land or
// --land-review <id>), clear (one author's changes put back, review H1) and
// reset (land zones, 11-10: a declared resettable area back to the generated
// world, for every player at once).
// Release and refund stay `lumine admin coins release|refund`; they change
// the land the same second.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requestJson } from "./http.js";

const USAGE =
  "Usage: lumine admin land plots --build <id> --region <world> [--key <plotKey>] | who --build <id> --region <world> --cell x,y,z [--before <changeId>] | edits --build <id> --user <id> [--region <world>] [--since <seconds>] [--after <changeId>] | set-rules --build <id> --key <plotKey> [--rule-build me|friends|everyone] [--rule-use me|friends|everyone] [--switches <name,...>|none] [--friends <id,...>|none] --reason <text> [--confirm] | import-plots|import-cells|import-history|import-edits <buildId> --file <file.json> [--land-review <reviewId>|--land-file <rewards.json>] --reason <text> [--confirm] | clear --build <id> --user <id>|--guest <guestId> [--region <world>] [--since <seconds>] --reason <text> [--confirm] | reset --build <id> --region <world> --id <area> --reason <text> [--confirm]";
const GUEST = /^g(ip)?[a-z2-7]{18,20}$/;
// Per request (LAND_LIMITS on the API: importPlots 500, importCells 5,000;
// import-edits also at most 2,000 edits a call).
export const LAND_IMPORT_LIMITS = Object.freeze({ plots: 500, cells: 5000, history: 5000, edits: 2000, editCells: 5000 });
const REGION = /^[a-z0-9-]{1,64}$/;
const LEVELS = new Set(["me", "friends", "everyone"]);
// The import files the phase-3 probes write (one world each).
export const LAND_IMPORT_FORMATS = Object.freeze({
  "import-plots": "twinkle-land-plots-v1",
  "import-cells": "twinkle-land-cells-v1",
  "import-history": "twinkle-land-history-v1",
  "import-edits": "twinkle-land-edits-v1",
});

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}
function positiveInteger(value, flag) {
  const number = Number(String(value || "").trim());
  if (!Number.isSafeInteger(number) || number <= 0) invalid(`${flag} must be a positive whole number. ${USAGE}`);
  return number;
}
function regionOf(value, flag = "--region") {
  const region = String(value || "").trim();
  if (!REGION.test(region)) invalid(`${flag} is the world name: 1 to 64 lowercase letters, digits or dashes.`);
  return region;
}
function idList(value, flag) {
  const text = String(value).trim();
  if (text === "none") return [];
  const ids = text.split(",").map((part) => Number(part.trim()));
  if (!ids.length || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) invalid(`${flag} is a comma list of player ids, or none.`);
  return ids;
}

export function buildLandOperation({ action, target, options }) {
  if (options.adminConfirm !== "" && options.adminConfirm !== "true" && options.adminConfirm !== undefined)
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (action === "plots") {
    const query = new URLSearchParams({
      buildId: String(positiveInteger(options.adminBuild, "--build")),
      region: regionOf(options.adminCoinRegion),
    });
    if (options.adminCoinKey) query.set("key", String(options.adminCoinKey));
    return { name: "land.plots", method: "GET", path: `/cli/admin/land/plots?${query}`, mutates: false, requiresRun: false };
  }
  if (action === "who") {
    const cell = String(options.adminLandCell || "").trim();
    const parts = cell.split(",");
    if (parts.length !== 3 || !parts.every((part) => /^-?\d+$/.test(part.trim()))) invalid(`--cell is x,y,z (whole numbers). ${USAGE}`);
    const query = new URLSearchParams({
      buildId: String(positiveInteger(options.adminBuild, "--build")),
      region: regionOf(options.adminCoinRegion),
      cell: parts.map((part) => part.trim()).join(","),
    });
    if (options.adminCoinBefore) query.set("before", String(positiveInteger(options.adminCoinBefore, "--before")));
    return { name: "land.who", method: "GET", path: `/cli/admin/land/who?${query}`, mutates: false, requiresRun: false };
  }
  if (action === "edits") {
    const query = new URLSearchParams({
      buildId: String(positiveInteger(options.adminBuild, "--build")),
      userId: String(positiveInteger(options.adminUser, "--user")),
    });
    if (options.adminCoinRegion) query.set("region", regionOf(options.adminCoinRegion));
    if (options.adminSince) query.set("since", String(positiveInteger(options.adminSince, "--since")));
    if (options.adminAfter) query.set("after", String(positiveInteger(options.adminAfter, "--after")));
    return { name: "land.edits", method: "GET", path: `/cli/admin/land/edits?${query}`, mutates: false, requiresRun: false };
  }
  const reason = String(options.adminReason || "").trim();
  if (!reason) invalid(`--reason is required. ${USAGE}`);
  if (reason.length > 200) invalid("--reason is at most 200 characters.");
  if (action === "set-rules") {
    const buildId = positiveInteger(options.adminBuild, "--build");
    const key = String(options.adminCoinKey || "").trim();
    if (!key) invalid(`--key is required. ${USAGE}`);
    const rules = {};
    if (options.adminLandRuleBuild) {
      if (!LEVELS.has(options.adminLandRuleBuild)) invalid("--rule-build is me, friends or everyone.");
      rules.build = options.adminLandRuleBuild;
    }
    if (options.adminLandRuleUse) {
      if (!LEVELS.has(options.adminLandRuleUse)) invalid("--rule-use is me, friends or everyone.");
      rules.use = options.adminLandRuleUse;
    }
    if (options.adminLandSwitches) {
      const text = String(options.adminLandSwitches).trim();
      rules.switches = text === "none" ? [] : text.split(",").map((name) => name.trim()).filter(Boolean);
    }
    if (options.adminLandFriends) rules.friends = idList(options.adminLandFriends, "--friends");
    if (!Object.keys(rules).length) invalid(`Name at least one rule to change. ${USAGE}`);
    return {
      name: confirm ? "land.set-rules" : "land.set-rules.preview",
      method: "POST", path: "/cli/admin/land/set-rules",
      body: { buildId, key, rules, reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false,
    };
  }
  if (action === "clear") {
    const buildId = positiveInteger(options.adminBuild, "--build");
    const user = options.adminUser ? positiveInteger(options.adminUser, "--user") : null;
    const guest = options.adminLandGuest ? String(options.adminLandGuest).trim() : null;
    if ((user === null) === (guest === null)) invalid(`Name one author: --user <id> or --guest <guestId>. ${USAGE}`);
    if (guest !== null && !GUEST.test(guest)) invalid("--guest is a land guest id (it starts with g; lumine admin land who shows it).");
    const body = {
      buildId,
      ...(user !== null ? { userId: user } : { guestId: guest }),
      ...(options.adminCoinRegion ? { region: regionOf(options.adminCoinRegion) } : {}),
      ...(options.adminSince ? { since: positiveInteger(options.adminSince, "--since") } : {}),
      reason,
      dryRun: !confirm,
    };
    return {
      name: confirm ? "land.clear" : "land.clear.preview",
      method: "POST", path: "/cli/admin/land/clear",
      landWorkflow: "clear", buildId, reason, body,
      mutates: confirm, requiresRun: false,
    };
  }
  if (action === "reset") {
    const buildId = positiveInteger(options.adminBuild, "--build");
    const region = regionOf(options.adminCoinRegion);
    const id = String(options.adminLandArea || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) invalid(`--id is the resettable area's id from rewards.json land.resettable. ${USAGE}`);
    return {
      name: confirm ? "land.reset" : "land.reset.preview",
      method: "POST", path: "/cli/admin/land/reset",
      landWorkflow: "reset", buildId, reason,
      body: { buildId, region, id, reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false,
    };
  }
  if (LAND_IMPORT_FORMATS[action]) {
    const buildId = positiveInteger(target, "<buildId>");
    if (!options.adminFile) invalid(`--file is required. ${USAGE}`);
    const file = readLandImportFile(options.adminFile, action);
    if (file.buildId !== undefined && Number(file.buildId) !== buildId)
      invalid(`${options.adminFile} was made for app ${file.buildId}, not ${buildId}.`);
    const landReviewId = options.adminLandReview ? positiveInteger(options.adminLandReview, "--land-review") : null;
    const landDeclaration = options.adminLandFile ? readLandDeclarationFile(options.adminLandFile) : null;
    if (landReviewId && landDeclaration) invalid("Pass --land-review or --land-file, not both.");
    return {
      name: confirm ? `land.${action}` : `land.${action}.preview`,
      method: "POST", path: `/cli/admin/land/${action}`,
      landWorkflow: action, buildId, reason, file,
      batches: landImportBatches(action, file, { buildId, reason, dryRun: !confirm, landReviewId, landDeclaration }),
      mutates: confirm, requiresRun: false,
    };
  }
  invalid(USAGE);
}

// One world per file:
//   plots:   { format, buildId?, region, priceId, artifactVersionId, plots: [{ plotId, userId, x0, z0, claimedAt, rules? }] }
//   cells:   { format, buildId?, region, at, cells: [[x, y, z, value, userId, cause?, flags?]] }
//   history: { format, buildId?, region, rows: [[x, y, z, value, prevValue|null, userId, createdAt, cause|null, key?]] }
//   edits:   { format, buildId?, region, cutover, rows: [{ userId, at, cells: [[x, y, z, value]], cause? }] }
// cells: cause (derived, fall, fluid, grow) and flags (1 = natural) keep
// revealed ores and put-back terrain out of land.mine (review L4). history:
// key = the source row's own name, so a fresh download re-imports nothing it
// already brought (L9). edits: cutover = the time the world's imported cells
// were read; the server refuses a later one (a gap, review M5).
export function readLandImportFile(filePath, action) {
  let buffer;
  try {
    buffer = readFileSync(path.resolve(filePath));
  } catch (error) {
    invalid(`Could not read ${filePath}: ${error.message}`);
  }
  let file;
  try {
    file = JSON.parse(buffer.toString("utf8"));
  } catch {
    invalid(`${filePath} is not JSON.`);
  }
  const format = LAND_IMPORT_FORMATS[action];
  if (file?.format !== format) invalid(`${filePath} is not a ${action} file (format ${format}).`);
  regionOf(file.region, `${filePath}: region`);
  const listKey = action === "import-plots" ? "plots" : action === "import-cells" ? "cells" : "rows";
  if (!Array.isArray(file[listKey]) || !file[listKey].length) invalid(`${filePath}: ${listKey} must be a non-empty list.`);
  if (action === "import-plots") {
    if (typeof file.priceId !== "string" || !file.priceId) invalid(`${filePath}: priceId is the starter price id.`);
    if (!Number.isSafeInteger(file.artifactVersionId) || file.artifactVersionId <= 0) invalid(`${filePath}: artifactVersionId is the app version the plots were claimed in.`);
  }
  if (action === "import-cells" && (!Number.isSafeInteger(file.at) || file.at <= 0))
    invalid(`${filePath}: at must be the server time (seconds) the cells were read at.`);
  if (action === "import-edits" && (!Number.isSafeInteger(file.cutover) || file.cutover <= 0))
    invalid(`${filePath}: cutover must be the time (seconds) of the world's imported cells file (make it with probes/land-import.mjs --imported <dir>).`);
  if (action === "import-edits")
    for (const row of file.rows)
      if (!Array.isArray(row?.cells) || row.cells.length > LAND_IMPORT_LIMITS.editCells)
        invalid(`${filePath}: every edit row has 1 to ${LAND_IMPORT_LIMITS.editCells} cells.`);
  return { ...file, sha256: createHash("sha256").update(buffer).digest("hex") };
}

// --land-file: the rewards.json the release will send for review (its prices
// and land block). The server checks it like a review; on Mikey's apps the
// review approves and publishes at once, so the imports run against this
// file first (review H2).
export function readLandDeclarationFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    invalid(`Could not read ${filePath} as JSON: ${error.message}`);
  }
  if (!parsed?.land || typeof parsed.land !== "object") invalid(`${filePath} has no "land" block.`);
  return { prices: Array.isArray(parsed.prices) ? parsed.prices : [], land: parsed.land };
}

// The requests one file becomes, in file order.
export function landImportBatches(action, file, { buildId, reason, dryRun, landReviewId = null, landDeclaration = null }) {
  const groups = [];
  if (action === "import-edits") {
    let current = [];
    let cells = 0;
    for (const row of file.rows) {
      if (current.length && (current.length >= LAND_IMPORT_LIMITS.edits || cells + row.cells.length > LAND_IMPORT_LIMITS.editCells)) {
        groups.push(current);
        current = [];
        cells = 0;
      }
      current.push(row);
      cells += row.cells.length;
    }
    if (current.length) groups.push(current);
  } else {
    const listKey = action === "import-plots" ? "plots" : action === "import-cells" ? "cells" : "rows";
    const size = action === "import-plots" ? LAND_IMPORT_LIMITS.plots : action === "import-cells" ? LAND_IMPORT_LIMITS.cells : LAND_IMPORT_LIMITS.history;
    for (let i = 0; i < file[listKey].length; i += size) groups.push(file[listKey].slice(i, i + size));
  }
  return groups.map((group, index) => ({
    buildId,
    region: file.region,
    ...(action === "import-plots" ? { priceId: file.priceId, artifactVersionId: file.artifactVersionId, plots: group } : {}),
    ...(action === "import-cells" ? { at: file.at, cells: group } : {}),
    ...(action === "import-history" || action === "import-edits" ? { rows: group } : {}),
    ...(action === "import-edits" ? { cutover: file.cutover } : {}),
    ...(landReviewId ? { landReviewId } : {}),
    ...(landDeclaration ? { landDeclaration } : {}),
    reason,
    fileSha256: file.sha256,
    batchIndex: index,
    batchCount: groups.length,
    dryRun,
  }));
}
// The same file and batch always use the same idempotency key: a re-run after
// a crash replays finished batches from their audit records.
export function landImportRequestKey(action, batch) {
  return `cli:land:${action}:${batch.buildId}:${batch.fileSha256.slice(0, 16)}:${batch.batchIndex}`;
}

// lumine admin land clear: one bounded batch per call; confirmed, the CLI
// calls again (next batchIndex, its own idempotency key) while the server
// says more, so a crash re-run replays finished batches from their audit
// records. A dry run shows the first batch's plan and every world's count.
export function landClearRequestKey(body, batchIndex) {
  const who = body.userId ? `u${body.userId}` : body.guestId;
  return `cli:land:clear:${body.buildId}:${who}:${body.region || "all"}:${body.since || 0}:${batchIndex}`;
}
export async function runLandClear({ options, operation, authToken, request = requestJson, log = () => {} }) {
  const totals = { reverted: 0, removed: 0, leftForLaterChanges: 0, historyRemoved: 0, batches: 0 };
  const regions = new Set();
  let first = null;
  for (let batchIndex = 0; batchIndex < 10000; batchIndex += 1) {
    const body = { ...operation.body, batchIndex };
    const receipt = await request({
      method: "POST",
      url: `${options.apiUrl}${operation.path}`,
      authToken,
      body,
      headers: body.dryRun ? {} : { "x-lumine-idempotency-key": landClearRequestKey(body, batchIndex) },
      timeoutMs: Math.max(120000, Number(options.timeoutMs) || 0),
    });
    if (!receipt || receipt.ok !== true) {
      const error = new Error(receipt?.error?.message || `Land clear batch ${batchIndex + 1} failed; earlier batches stay applied. Re-run the same command to finish.`);
      error.code = receipt?.error?.code || "CLI_ADMIN_LAND_CLEAR_FAILED";
      throw error;
    }
    const data = receipt.data || {};
    first ??= data;
    if (data.region) regions.add(data.region);
    totals.batches += data.region ? 1 : 0;
    for (const key of ["reverted", "removed", "leftForLaterChanges", "historyRemoved"]) totals[key] += Number(data[key] || 0);
    if (body.dryRun || !data.more) {
      if (!body.dryRun && !operation.body.region && data.region) continue; // the next world with changes in scope
      break;
    }
    log(`batch ${batchIndex + 1} done (${data.region})`);
  }
  return {
    ok: true,
    status: "success",
    data: { action: "clear", dryRun: operation.body.dryRun, buildId: operation.buildId, author: operation.body.userId ? { userId: operation.body.userId } : { guestId: operation.body.guestId }, first, regions: [...regions], ...totals },
  };
}

// lumine admin land reset: the dry run says how many stored cells would go;
// confirmed, one part per call (each its own short transaction and event on
// the server) until the server says done. A reset is a new act each time, so
// each run has its own key prefix (runKey); a crash re-run simply resets again.
export function landResetRequestKey(body, runKey, batchIndex) {
  return `cli:land:reset:${body.buildId}:${body.region}:${body.id}:${runKey}:${batchIndex}`;
}
export async function runLandReset({ options, operation, authToken, request = requestJson, log = () => {}, runKey = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}` }) {
  const totals = { removed: 0, credits: 0, parts: 0 };
  let first = null;
  let last = null;
  for (let batchIndex = 0; batchIndex < 2000; batchIndex += 1) {
    const body = { ...operation.body, batchIndex };
    const receipt = await request({
      method: "POST",
      url: `${options.apiUrl}${operation.path}`,
      authToken,
      body,
      headers: body.dryRun ? {} : { "x-lumine-idempotency-key": landResetRequestKey(body, runKey, batchIndex) },
      timeoutMs: Math.max(120000, Number(options.timeoutMs) || 0),
    });
    if (!receipt || receipt.ok !== true) {
      const error = new Error(receipt?.error?.message || `Land reset part ${batchIndex + 1} failed; earlier parts stay applied. Run the same command again to finish.`);
      error.code = receipt?.error?.code || "CLI_ADMIN_LAND_RESET_FAILED";
      throw error;
    }
    const data = receipt.data || {};
    first ??= data;
    last = data;
    if (body.dryRun) break;
    totals.removed += Number(data.removed || 0);
    totals.credits += Number(data.credits || 0);
    if (data.seq) totals.parts += 1;
    if (!data.more) break;
    log(`part ${batchIndex + 1} done (${data.removed} cells)`);
  }
  return {
    ok: true,
    status: "success",
    data: { action: "reset", dryRun: operation.body.dryRun, buildId: operation.buildId, region: operation.body.region, id: operation.body.id, area: first?.area, why: first?.why, ...(operation.body.dryRun ? { cells: first?.cells, atLeast: first?.atLeast, plannedParts: first?.parts } : { ...totals, seq: last?.seq ?? null }) },
  };
}

const SUM_KEYS = ["plots", "cells", "rows", "edits", "written", "inserted", "keptNewer", "unchanged", "refusedFull", "accepted", "refused", "alreadyImportedRows"];
export async function runLandImport({ options, operation, authToken, request = requestJson, log = () => {} }) {
  const results = [];
  for (const batch of operation.batches) {
    const receipt = await request({
      method: "POST",
      url: `${options.apiUrl}${operation.path}`,
      authToken,
      body: batch,
      headers: batch.dryRun ? {} : { "x-lumine-idempotency-key": landImportRequestKey(operation.landWorkflow, batch) },
      timeoutMs: Math.max(120000, Number(options.timeoutMs) || 0),
    });
    if (!receipt || receipt.ok !== true) {
      const error = new Error(receipt?.error?.message || `Land ${operation.landWorkflow} batch ${batch.batchIndex + 1} failed; earlier batches stay applied. Re-run the same command to finish.`);
      error.code = receipt?.error?.code || "CLI_ADMIN_LAND_IMPORT_FAILED";
      throw error;
    }
    results.push(receipt.data || {});
    log(`batch ${batch.batchIndex + 1}/${batch.batchCount} done`);
  }
  const totals = {};
  for (const key of SUM_KEYS) {
    const values = results.map((row) => row?.[key]).filter((value) => typeof value === "number");
    if (values.length) totals[key] = values.reduce((sum, value) => sum + value, 0);
  }
  const refusedBy = {};
  for (const row of results) for (const [code, count] of Object.entries(row?.refusedBy || {})) refusedBy[code] = (refusedBy[code] || 0) + Number(count || 0);
  return {
    ok: true,
    status: "success",
    data: {
      action: operation.landWorkflow,
      dryRun: operation.batches[0]?.dryRun !== false,
      buildId: operation.buildId,
      region: operation.file.region,
      fileSha256: operation.file.sha256,
      batches: results.length,
      ...totals,
      ...(Object.keys(refusedBy).length ? { refusedBy } : {}),
      granted: results.flatMap((row) => row?.granted || []),
      alreadyGranted: results.flatMap((row) => row?.alreadyGranted || []),
      skipped: results.flatMap((row) => row?.skipped || []),
      alreadyImported: results.map((row) => row?.alreadyImported).filter(Boolean),
      regionCellsBefore: results[0]?.regionCellsBefore ?? null,
      importIds: results.map((row) => row?.importId).filter(Boolean),
    },
  };
}

const when = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().replace(".000Z", "Z") : "?");
const who = (user) => user?.username || user?.id || "?";
const rulesText = (rules) =>
  `build ${rules?.build || "me"} · use ${rules?.use || "me"} · switches ${rules?.switches?.length ? rules.switches.join(",") : "none"} · friends ${rules?.friends?.length ? rules.friends.map(who).join(",") : "none"}`;
export function formatLandResult({ operation, data }) {
  if (operation.name === "land.plots") {
    const plots = data?.plots || [];
    if (data?.land === null) return [`App ${data?.buildId} declares no land.`];
    if (!plots.length) return [`No held plots in ${data?.region}.`];
    return plots.flatMap((plot) => [
      `${plot.key} #${plot.receiptId} ${who(plot.holder)} · ${plot.priceId} (${plot.kind}) ${plot.lastPrice} Coins · since ${when(plot.since)} · ${rulesText(plot.rules)}${plot.rulesAt ? ` (rules ${when(plot.rulesAt)} by ${plot.rulesBy})` : ""}`,
      ...(plot.chain ? plot.chain.map((entry) => `    receipt #${entry.id} ${entry.username || entry.userId} ${entry.kind} ${entry.coins} Coins ${entry.status} ${when(entry.createdAt)}`) : []),
      ...(plot.openOffers ? plot.openOffers.map((offer) => `    open offer #${offer.id} from ${offer.offererId}: ${offer.coins} Coins (${when(offer.createdAt)})`) : []),
    ]);
  }
  if (operation.name === "land.who") {
    const current = data?.current;
    return [
      `${data?.region} ${data?.cell?.join(",")}: ${current ? `${current.value} by ${current.username || current.userId}${current.cause ? ` (${current.cause})` : ""} at ${when(current.at)}, seq ${current.seq}` : "never changed (the app's generated world)"}`,
      ...(data?.reset ? [`  last reset: "${data.reset.id}" by ${who(data.reset.by)} at ${when(data.reset.at)}, seq ${data.reset.seq}${!data.current && (!data.changes?.length || data.reset.seq > data.changes[0].seq) ? " (the cell shows the generated world since then)" : ""}`] : []),
      ...(data?.changes || []).map((change) => `  #${change.id} ${when(change.at)} ${change.username || change.userId}: ${change.prevValue ?? "-"} → ${change.value}${change.cause ? ` (${change.cause})` : ""} · ${change.source}`),
      ...(data?.nextBefore ? [`More: re-run with --before ${data.nextBefore}.`] : []),
    ];
  }
  if (operation.name === "land.edits") {
    const byRegion = Object.entries(data?.byRegion || {}).map(([region, count]) => `${region} ${count}`).join(", ");
    return [
      `${(data?.changes || []).length} changes by player ${data?.userId} in app ${data?.buildId}${byRegion ? ` (${byRegion})` : ""}:`,
      ...(data?.changes || []).map((change) => `  #${change.id} ${when(change.at)} ${change.region} ${change.cell.join(",")}: ${change.prevValue ?? "-"} → ${change.value}${change.cause ? ` (${change.cause})` : ""} · ${change.source}`),
      ...(data?.nextAfter ? [`More: re-run with --after ${data.nextAfter}.`] : []),
      ...(data?.resets?.length ? [`Resets by player ${data.userId} (newest first):`, ...data.resets.map((reset) => `  ${when(reset.at)} ${reset.region} "${reset.id}" x ${reset.area.x0}..${reset.area.x1}, z ${reset.area.z0}..${reset.area.z1}: ${reset.removed} cells · ${reset.source}`)] : []),
    ];
  }
  if (operation.name.startsWith("land.reset")) {
    const place = `"${data?.id}"${data?.why ? ` (${data.why})` : ""} in app ${data?.buildId}, ${data?.region}${data?.area ? ` x ${data.area.x0}..${data.area.x1}, z ${data.area.z0}..${data.area.z1}` : ""}`;
    if (data?.dryRun)
      return [
        `Dry run: reset ${place}: ${data?.atLeast ? "at least " : ""}${Number(data?.cells || 0).toLocaleString("en-US")} stored cells would go back to the generated world${data?.cells ? ` (${data?.plannedParts} part${data?.plannedParts === 1 ? "" : "s"})` : ""}.`,
        "Nothing was written. Add --confirm to apply (players see it at once).",
      ];
    return [
      `Done: reset ${place}: ${Number(data?.removed || 0).toLocaleString("en-US")} cells back to the generated world in ${data?.parts} part${data?.parts === 1 ? "" : "s"}${data?.seq ? ` (seq ${data.seq})` : ""}${data?.credits ? `, ${data.credits} builder credits ended` : ""}.`,
      data?.parts ? "  Open tabs drop those cells at once (cellsReset)." : "  Nothing was stored there: the area was already as generated.",
    ];
  }
  if (operation.name.startsWith("land.set-rules")) {
    const ids = (rules) => ({ ...rules, friends: (rules?.friends || []).map((id) => (typeof id === "object" ? id : { id })) });
    return [
      `${data?.dryRun ? "Dry run: would set" : "Set"} ${data?.key} (#${data?.receiptId}, holder ${data?.holderId}):`,
      `  before: ${rulesText(ids(data?.before))}`,
      `  after:  ${rulesText(ids(data?.after))}`,
      ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [`  landVersion ${data?.landVersion}`]),
    ];
  }
  if (operation.name.startsWith("land.clear")) {
    const author = data?.author?.userId ? `player ${data.author.userId}` : `guest ${data?.author?.guestId}`;
    if (data?.dryRun) {
      const plan = data?.first || {};
      if (!plan.region) return [`Dry run: ${author} has no changes in scope in app ${data?.buildId}. Nothing to clear.`];
      return [
        `Dry run: clear ${author} in app ${data?.buildId}, first world ${plan.region}${plan.since ? ` since ${when(plan.since)}` : ""}:`,
        `  ${plan.changesInScope} changes there; this batch: ${plan.cells} cells, ${plan.reverted} put back, ${plan.removed} back to the generated world, ${plan.leftForLaterChanges} left (changed later by someone else)`,
        "Nothing was written. Add --confirm to apply (every world, batch by batch).",
      ];
    }
    return [
      `Done: cleared ${author} in app ${data?.buildId} (${(data?.regions || []).join(", ") || "no world"}), ${data?.batches} batch${data?.batches === 1 ? "" : "es"}:`,
      `  ${data?.reverted} cells put back, ${data?.removed} back to the generated world, ${data?.leftForLaterChanges} left (changed later by someone else), ${data?.historyRemoved} history rows removed`,
      "  Open tabs see put-back cells at once; cells back to the generated world show after the world reloads.",
    ];
  }
  const action = data?.action || operation.landWorkflow;
  const head = `${data?.dryRun ? "Dry run:" : "Done:"} ${action} for app ${data?.buildId}, ${data?.region}, ${data?.batches} batch${data?.batches === 1 ? "" : "es"} (file ${String(data?.fileSha256 || "").slice(0, 12)})`;
  const lines = [head];
  if (action === "import-plots") {
    lines.push(`  ${data?.plots ?? 0} plots in the file: ${data?.granted?.length || 0} ${data?.dryRun ? "would be granted" : "granted"}, ${data?.alreadyGranted?.length || 0} already granted, ${data?.skipped?.length || 0} skipped`);
    const reasons = {};
    for (const entry of data?.skipped || []) reasons[entry.why || "skipped"] = (reasons[entry.why || "skipped"] || 0) + 1;
    if (Object.keys(reasons).length) lines.push(`  skipped: ${Object.entries(reasons).map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
    const dropped = (data?.granted || []).filter((entry) => entry.droppedFriends?.length);
    if (dropped.length) lines.push(`  unknown friends dropped on ${dropped.length} plots: ${dropped.map((entry) => `${entry.key} (${entry.droppedFriends.join(",")})`).join("; ")}`);
  } else if (action === "import-cells") {
    lines.push(`  ${data?.cells ?? 0} cells: ${data?.written ?? 0} written (${data?.inserted ?? 0} new), ${data?.keptNewer ?? 0} kept (changed live after the file's time), ${data?.unchanged ?? 0} unchanged${data?.refusedFull ? `, ${data.refusedFull} refused (world full)` : ""}`);
  } else if (action === "import-history") {
    lines.push(`  ${data?.rows ?? 0} history rows: ${data?.written ?? 0} written${data?.alreadyImportedRows ? `, ${data.alreadyImportedRows} already imported (same source rows)` : ""}${data?.alreadyImported?.length ? `, ${data.alreadyImported.length} batches imported before (no-op)` : ""}`);
  } else {
    const refused = Object.entries(data?.refusedBy || {}).map(([code, count]) => `${code} ${count}`).join(", ");
    lines.push(`  ${data?.edits ?? 0} edits, ${data?.cells ?? 0} cells: ${data?.accepted ?? 0} accepted, ${data?.written ?? 0} written, ${data?.refused ?? 0} refused${refused ? ` (${refused})` : ""}`);
  }
  lines.push(...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [`  receipts ${(data?.importIds || []).join(", ") || "none"}`]));
  return lines;
}
