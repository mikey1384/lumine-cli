// lumine admin coins: Twinkle.coins purchases and the builder tally's one-time
// fill (the server is controllers/cli/admin/coinCharges.ts). Writes are dry
// runs unless --confirm.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requestJson } from "./http.js";

const USAGE =
  "Usage: lumine admin coins list --build <id> [--user <id>] [--price <priceId>] [--key <itemKey>] [--before <receiptId>] | refund <receiptId> --reason <text> [--keep-recipient (purchases only, not sales/takeovers)] [--confirm] | release --build <id> --price <priceId> --key <itemKey> --reason <text> [--confirm] | tally-import <buildId> --file <cells.json> --reason <text> [--replace-region <region>] [--confirm] | tally-clear <buildId> --user <id> [--region <region>] [--area <x0:z0:x1:z1>] --reason <text> [--confirm] [--json]";
// Cells per tally-import request (COIN_TALLY_LIMITS.importBatchCells on the API).
export const TALLY_IMPORT_BATCH_CELLS = 5000;
// One spelling per world (review-r2 M3): COIN_TALLY_REGION_PATTERN on the API.
const TALLY_REGION = /^[a-z0-9-]{1,64}$/;
const TALLY_NUMBER = /^(0|-?[1-9][0-9]{0,6})$/;
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
export function buildCoinsOperation({ action, target, options }) {
  if (options.adminConfirm !== "" && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (!action || action === "list") {
    const query = new URLSearchParams({ buildId: String(positiveInteger(options.adminBuild, "--build")) });
    if (options.adminUser) query.set("userId", String(positiveInteger(options.adminUser, "--user")));
    if (options.adminCoinPrice) query.set("priceId", options.adminCoinPrice);
    if (options.adminCoinKey) query.set("key", options.adminCoinKey);
    // Older pages: the server returns nextBefore (the oldest id shown) when more exist.
    if (options.adminCoinBefore) query.set("before", String(positiveInteger(options.adminCoinBefore, "--before")));
    return {
      name: "coins.list", method: "GET", path: `/cli/admin/coins/purchases?${query}`,
      mutates: false, requiresRun: false
    };
  }
  const reason = String(options.adminReason || "").trim();
  if (!reason) invalid(`--reason is required. ${USAGE}`);
  if (action === "tally-import") {
    const buildId = positiveInteger(target, "<buildId>");
    if (!options.adminFile) invalid(`--file is required. ${USAGE}`);
    const file = readTallyFile(options.adminFile);
    if (file.buildId !== undefined && Number(file.buildId) !== buildId)
      invalid(`${options.adminFile} was made for app ${file.buildId}, not ${buildId}.`);
    const replaceRegion = String(options.adminCoinReplaceRegion || "").trim();
    // Clearing a region is spelled out: the flag must name the file's region.
    if (replaceRegion && replaceRegion !== file.region)
      invalid(`--replace-region must name the file's region (${file.region}).`);
    return {
      name: confirm ? "coins.tally-import" : "coins.tally-import.preview",
      method: "POST", path: "/cli/admin/coins/tally-import",
      coinsWorkflow: "tally-import", buildId, reason, replace: Boolean(replaceRegion), file,
      batches: tallyImportBatches(file, { buildId, replace: Boolean(replaceRegion), reason, dryRun: !confirm }),
      mutates: confirm, requiresRun: false
    };
  }
  // The admin's fix for fake builder records (review-r2 M2): one player's
  // recorded blocks in one app, optionally one region and one area.
  if (action === "tally-clear") {
    const buildId = positiveInteger(target, "<buildId>");
    const userId = positiveInteger(options.adminUser, "--user");
    const region = String(options.adminCoinRegion || "").trim();
    const area = String(options.adminCoinArea || "").trim();
    if (region && !TALLY_REGION.test(region)) invalid("--region is the world name: 1 to 64 lowercase letters, digits or dashes.");
    if (area) {
      if (!region) invalid("--area needs --region.");
      const parts = area.split(":");
      if (parts.length !== 4 || !parts.every((part) => TALLY_NUMBER.test(part)))
        invalid("--area is x0:z0:x1:z1 (whole numbers, both corners included).");
      const [x0, z0, x1, z1] = parts.map(Number);
      if (x1 < x0 || z1 < z0) invalid("--area is x0:z0:x1:z1 with x0 <= x1 and z0 <= z1.");
    }
    return {
      name: confirm ? "coins.tally-clear" : "coins.tally-clear.preview",
      method: "POST", path: "/cli/admin/coins/tally-clear",
      body: { buildId, userId, ...(region ? { region } : {}), ...(area ? { area } : {}), reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false
    };
  }
  if (action === "refund")
    return {
      name: confirm ? "coins.refund" : "coins.refund.preview", method: "POST", path: "/cli/admin/coins/refund",
      body: {
        receiptId: positiveInteger(target, "<receiptId>"), reason,
        fromRecipient: !options.adminCoinKeepRecipient, dryRun: !confirm
      },
      mutates: confirm, requiresRun: false
    };
  if (action === "release") {
    if (!options.adminCoinPrice || !options.adminCoinKey) invalid(`--price and --key are required. ${USAGE}`);
    return {
      name: confirm ? "coins.release" : "coins.release.preview", method: "POST", path: "/cli/admin/coins/release",
      body: {
        buildId: positiveInteger(options.adminBuild, "--build"), priceId: options.adminCoinPrice,
        key: options.adminCoinKey, reason, dryRun: !confirm
      },
      mutates: confirm, requiresRun: false
    };
  }
  invalid(USAGE);
}
// cells.json from firestar-land/probes/build-tally-import.mjs:
// { format: "twinkle-coin-tally-v1", buildId?, region, at, placed: [[x, y, z, userId]], removed?: [[x, y, z]] }
export function readTallyFile(filePath) {
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
  if (file?.format !== "twinkle-coin-tally-v1") invalid(`${filePath} is not a tally file (format twinkle-coin-tally-v1).`);
  if (!TALLY_REGION.test(String(file.region || ""))) invalid(`${filePath}: region must be 1 to 64 lowercase letters, digits or dashes (a-z 0-9 -).`);
  if (!Number.isSafeInteger(file.at) || file.at <= 0) invalid(`${filePath}: at must be the server time (seconds) of the newest history row.`);
  const placed = Array.isArray(file.placed) ? file.placed : invalid(`${filePath}: placed must be a list.`);
  const removed = file.removed === undefined ? [] : Array.isArray(file.removed) ? file.removed : invalid(`${filePath}: removed must be a list.`);
  return {
    buildId: file.buildId, region: file.region, at: file.at, placed, removed,
    sha256: createHash("sha256").update(buffer).digest("hex")
  };
}
// The requests one file becomes: placed cells, then removed cells, at most
// TALLY_IMPORT_BATCH_CELLS a request. Only the first may clear the region.
export function tallyImportBatches(file, { buildId, replace, reason, dryRun }) {
  const cells = [...file.placed.map((cell) => ["placed", cell]), ...file.removed.map((cell) => ["removed", cell])];
  const count = Math.max(1, Math.ceil(cells.length / TALLY_IMPORT_BATCH_CELLS));
  return Array.from({ length: count }, (_, index) => {
    const slice = cells.slice(index * TALLY_IMPORT_BATCH_CELLS, (index + 1) * TALLY_IMPORT_BATCH_CELLS);
    return {
      buildId, region: file.region, at: file.at,
      placed: slice.filter(([kind]) => kind === "placed").map(([, cell]) => cell),
      removed: slice.filter(([kind]) => kind === "removed").map(([, cell]) => cell),
      replace: Boolean(replace) && index === 0,
      ...(replace && index === 0 ? { replaceRegion: file.region } : {}),
      fileSha256: file.sha256, batchIndex: index, batchCount: count, reason, dryRun
    };
  });
}
// The same file, region, mode and batch always use the same idempotency key:
// a re-run after a crash replays finished batches from their audit records
// and applies only the rest.
export function tallyImportRequestKey(batch) {
  return `cli:tally:${batch.buildId}:${batch.fileSha256.slice(0, 16)}:${batch.replace ? "r" : "m"}:${batch.batchIndex}`;
}
export async function runCoinsTallyImport({ options, operation, authToken, request = requestJson, log = () => {} }) {
  const results = [];
  for (const batch of operation.batches) {
    const receipt = await request({
      method: "POST",
      url: `${options.apiUrl}${operation.path}`,
      authToken,
      body: batch,
      headers: batch.dryRun ? {} : { "x-lumine-idempotency-key": tallyImportRequestKey(batch) },
      timeoutMs: Math.max(120000, Number(options.timeoutMs) || 0),
    });
    if (!receipt || receipt.ok !== true) {
      const error = new Error(receipt?.error?.message || `Tally import batch ${batch.batchIndex + 1} failed; earlier batches stay applied. Re-run the same command to finish.`);
      error.code = receipt?.error?.code || "CLI_ADMIN_COINS_TALLY_FAILED";
      throw error;
    }
    results.push(receipt.data || {});
    log(`batch ${batch.batchIndex + 1}/${batch.batchCount}: ${batch.placed.length} placed, ${batch.removed.length} removed`);
  }
  const sum = (key) => results.reduce((total, row) => total + (Number(row?.[key]) || 0), 0);
  const last = results[results.length - 1] || {};
  return {
    ok: true,
    status: "success",
    data: {
      dryRun: operation.batches[0]?.dryRun !== false,
      buildId: operation.buildId,
      region: operation.file.region,
      at: operation.file.at,
      fileSha256: operation.file.sha256,
      batches: results.length,
      regionCellsBefore: Number(results[0]?.regionCellsBefore || 0),
      cleared: sum("cleared") || sum("wouldClear"),
      // What --replace-region keeps (review-r2 M4): live, newer and used-up blocks.
      replaceKeeps: results[0]?.replaceKeeps || null,
      placed: sum("placed"),
      removed: sum("removed"),
      keptNewer: sum("keptNewer"),
      keptNewerPlaced: sum("keptNewerPlaced"),
      keptNewerRemoved: sum("keptNewerRemoved"),
      regionCellsAfter: last.regionCellsAfter ?? null,
      importIds: results.map((row) => row?.importId).filter(Boolean)
    }
  };
}

export function formatCoinsResult({ operation, data }) {
  if (operation.name.startsWith("coins.tally-clear")) {
    const regions = (data?.regions || []).map((row) => `${row.region} ${row.cells} (x ${row.bounds?.x0}..${row.bounds?.x1}, z ${row.bounds?.z0}..${row.bounds?.z1})`);
    return [
      `${data?.dryRun ? "Dry run: would clear" : "Cleared"} ${data?.dryRun ? data?.cells : data?.cleared} recorded blocks of ${data?.username || "player"} (${data?.userId}) in app ${data?.buildId}${data?.region ? `, region ${data.region}` : ", every region"}${data?.area ? `, area ${data.area.x0}:${data.area.z0}:${data.area.x1}:${data.area.z1}` : ""}.`,
      ...(regions.length ? [`  by region: ${regions.join("; ")}`] : []),
      `  ${data?.consumed || 0} were already used up by a sale (that sale paid them; only a refund moves Coins) · ${data?.touchedByOthers || 0} were broken or built over by another player since (a hint the block was real) · ${data?.imported || 0} came from the one-time fill.`,
      ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [`  receipt ${data?.receiptId}`]),
    ];
  }
  if (operation.name.startsWith("coins.tally-import")) {
    const keeps = data?.replaceKeeps;
    return [
      `${data?.dryRun ? "Dry run: would import" : "Imported"} the builder tally of app ${data?.buildId}, region ${data?.region} (history up to ${data?.at ? new Date(data.at * 1000).toISOString() : "?"}), in ${data?.batches} batch${data?.batches === 1 ? "" : "es"}:`,
      `  region had ${data?.regionCellsBefore} recorded blocks${data?.cleared || keeps ? `; ${data?.dryRun ? "would clear" : "cleared"} ${data?.cleared || 0} older imported blocks (--replace-region)` : ""}`,
      ...(keeps ? [`  --replace-region keeps ${keeps.total} blocks: ${keeps.live} recorded live (never touched by an import), ${keeps.newer} imported from newer history, ${keeps.consumed} used up by a sale`] : []),
      `  ${data?.placed} placed blocks, ${data?.removed} removals${data?.keptNewer ? `; ${data.keptNewer} file cells left alone because a live, newer or used-up block holds them (${data.keptNewerPlaced || 0} placements, ${data.keptNewerRemoved || 0} removals)` : ""}`,
      ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [`  region now has ${data?.regionCellsAfter} recorded blocks · receipts ${(data?.importIds || []).join(", ")}`]),
    ];
  }
  if (operation.name === "coins.list") {
    const receipts = data?.receipts || [];
    if (!receipts.length) return ["No purchases."];
    return [
      ...receipts.map((r) =>
        `#${r.id} ${new Date(r.createdAt * 1000).toISOString()} ${r.buyer?.username || r.buyer?.id} ${r.kind} ${r.priceId}${r.key ? ` [${r.key}]` : ""} ${r.coins} Coins → ${r.destination}${r.recipient ? ` ${r.recipient.username || r.recipient.id}` : ""}${r.builders ? ` + builders ${r.builders.map((b) => `${b.userId}:${b.coins}`).join(",")}` : ""} · ${r.status}${r.holds ? " (holds)" : ""}`),
      ...(data?.nextBefore ? [`More: re-run with --before ${data.nextBefore} for older purchases.`] : [])
    ];
  }
  if (operation.name.startsWith("coins.refund")) {
    const takeBack = (data?.takeBackFrom || []).map((entry) => `${entry.username || entry.id} ${entry.coins}`).join(", ");
    return [
      `${data?.dryRun ? "Dry run: would refund" : "Refunded"} receipt #${data?.receiptId}: ${data?.refundCoins} Coins back to ${data?.buyer?.username || data?.buyer?.id}${takeBack ? `, taking back ${takeBack}` : ", taking nothing back"}${data?.platformCovers ? ` (the platform covers ${data.platformCovers} Coins)` : ""}${data?.restoresReceiptId ? `; the item returns to receipt #${data.restoresReceiptId}` : ""}.`,
      ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [])
    ];
  }
  return [
    `${data?.dryRun ? "Dry run: would release" : "Released"} receipt #${data?.receiptId} (holder ${data?.holderId}). No Coins move.`,
    ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [])
  ];
}
