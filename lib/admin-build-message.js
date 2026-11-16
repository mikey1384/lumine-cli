// lumine admin build-message: post one message from Lumine into one build's
// Lumine chat, outside any run (the server is
// twinkle-api/controllers/cli/admin/buildMessages.ts). One message per build
// and campaign; sends are dry runs unless --confirm; no daily run needed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requestJson } from "./http.js";

const USAGE =
  "Usage: lumine admin build-message send --build <id> --campaign <key> --file <message.md> [--owner <userId>] [--confirm | --dry-run] | send --manifest <messages.json> [--confirm | --dry-run] | list --campaign <key> [--json]";
const CAMPAIGN_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_CHARS = 1000;
const MAX_MESSAGES = 200;
const MAX_FILE_BYTES = 256 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

function readText(filePath, label) {
  const normalized = String(filePath || "").trim();
  if (!normalized) invalid(`Pass ${label}.`);
  let contents;
  try {
    contents = readFileSync(normalized, "utf8");
  } catch {
    invalid(`Could not read ${normalized}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES)
    invalid(`${normalized} must be under 256KB.`);
  return contents;
}

function checkText(text, where) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) invalid(`${where}: the message is empty.`);
  if (normalized.length > MAX_CHARS)
    invalid(`${where}: the message is ${normalized.length} characters; Lumine chat messages are at most ${MAX_CHARS}.`);
  return normalized;
}

function positiveId(value, where) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) invalid(`${where} must be a positive id.`);
  return id;
}

function checkCampaign(value) {
  const campaign = String(value || "").trim();
  if (!CAMPAIGN_PATTERN.test(campaign))
    invalid("Pass --campaign <key>: 3-40 lowercase letters, digits and dashes (for example upload-loop-fix-20261116).");
  return campaign;
}

// messages.json: { "campaign": "<key>", "messages": [ { "buildId": 3011,
// "ownerUserId": 7977, "text": "…" | "file": "3011.md", …notes } ] }.
// Extra fields (title, ownerUsername, notes) are kept for the preview only.
export function readBuildMessageManifest(filePath) {
  const raw = readText(filePath, "--manifest <messages.json>");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    invalid(`${filePath} is not valid JSON.`);
  }
  const campaign = checkCampaign(manifest?.campaign);
  const list = manifest?.messages;
  if (!Array.isArray(list) || !list.length || list.length > MAX_MESSAGES)
    invalid(`The manifest needs 1-${MAX_MESSAGES} messages.`);
  const seen = new Set();
  const dir = path.dirname(path.resolve(filePath));
  const messages = list.map((entry, index) => {
    const where = `messages[${index}]`;
    const buildId = positiveId(entry?.buildId, `${where}.buildId`);
    if (seen.has(buildId)) invalid(`${where}: build ${buildId} appears twice; one message per build and campaign.`);
    seen.add(buildId);
    if ((entry?.text === undefined) === (entry?.file === undefined))
      invalid(`${where}: give exactly one of "text" or "file".`);
    const text = checkText(
      entry.text !== undefined ? entry.text : readText(path.resolve(dir, String(entry.file)), `${where}.file`),
      `${where} (build ${buildId})`,
    );
    return {
      buildId,
      expectedOwnerUserId:
        entry?.ownerUserId === undefined || entry?.ownerUserId === null
          ? null
          : positiveId(entry.ownerUserId, `${where}.ownerUserId`),
      text,
      title: entry?.title ? String(entry.title) : null,
      ownerUsername: entry?.ownerUsername ? String(entry.ownerUsername) : null,
    };
  });
  return { campaign, messages, sha256: createHash("sha256").update(raw).digest("hex") };
}

// The same campaign, build and text always use the same idempotency key, so a
// re-run after a crash replays a finished send from its audit record.
export function buildMessageRequestKey({ campaign, buildId, text }) {
  const textHash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `cli:bm:${campaign}:${buildId}:${textHash}`;
}

export function buildBuildMessageOperation({ action, options }) {
  if (action === "list") {
    const campaign = checkCampaign(options.adminCampaign);
    return {
      name: "build-message.list",
      method: "GET",
      path: `/cli/admin/build-messages?campaign=${encodeURIComponent(campaign)}`,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action !== "send") invalid(USAGE);
  if (options.adminConfirm !== "" && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (confirm && options.adminDryRun) invalid("Pass --confirm or --dry-run, not both.");
  let campaign;
  let messages;
  let manifestSha256 = null;
  if (options.adminManifest) {
    if (options.adminFile || options.adminBuild || options.adminCampaign || options.adminOwner)
      invalid("With --manifest, the campaign, builds, owners and texts come from the manifest; drop --build/--campaign/--file/--owner.");
    const manifest = readBuildMessageManifest(options.adminManifest);
    ({ campaign, messages } = manifest);
    manifestSha256 = manifest.sha256;
  } else {
    if (!options.adminBuild || !options.adminFile) invalid(USAGE);
    campaign = checkCampaign(options.adminCampaign);
    const buildId = positiveId(options.adminBuild, "--build");
    messages = [
      {
        buildId,
        expectedOwnerUserId: options.adminOwner ? positiveId(options.adminOwner, "--owner") : null,
        text: checkText(readText(options.adminFile, "--file <message.md>"), `--file (build ${buildId})`),
        title: null,
        ownerUsername: null,
      },
    ];
  }
  return {
    name: confirm ? "build-message.send" : "build-message.send.preview",
    method: "POST",
    path: "/cli/admin/build-messages",
    // Not sent as-is: it keys the local mutation-intent journal to this batch.
    body: {
      campaign,
      manifestSha256,
      builds: messages.map((m) => m.buildId),
      dryRun: !confirm,
    },
    buildMessageWorkflow: true,
    campaign,
    messages,
    dryRun: !confirm,
    mutates: confirm,
    requiresRun: false,
  };
}

// One request per message. A refusal (run in progress, owner changed, …) is
// recorded and the batch continues; re-running the same command later sends
// only what is still missing.
export async function runBuildMessageWorkflow({
  options,
  operation,
  authToken,
  request = requestJson,
  log = () => {},
}) {
  const results = [];
  for (const [index, message] of operation.messages.entries()) {
    const body = {
      buildId: message.buildId,
      campaign: operation.campaign,
      content: message.text,
      ...(message.expectedOwnerUserId ? { expectedOwnerUserId: message.expectedOwnerUserId } : {}),
      dryRun: operation.dryRun,
    };
    let receipt;
    try {
      receipt = await request({
        method: "POST",
        url: `${options.apiUrl}${operation.path}`,
        authToken,
        body,
        headers: operation.dryRun
          ? {}
          : { "x-lumine-idempotency-key": buildMessageRequestKey({ campaign: operation.campaign, buildId: message.buildId, text: message.text }) },
        timeoutMs: Math.max(30000, Number(options.timeoutMs) || 0),
      });
    } catch (error) {
      receipt = { ok: false, error: { code: error?.code || "CLI_ADMIN_REQUEST_FAILED", message: String(error?.message || error) } };
    }
    const row = {
      buildId: message.buildId,
      title: message.title,
      ownerUsername: message.ownerUsername,
      expectedOwnerUserId: message.expectedOwnerUserId,
      text: message.text,
      ok: receipt?.ok === true,
      ...(receipt?.ok === true
        ? { data: receipt.data }
        : { error: receipt?.error || { code: "CLI_ADMIN_RECEIPT_INVALID", message: "No valid receipt." } }),
    };
    results.push(row);
    log(`${index + 1}/${operation.messages.length} build ${message.buildId}: ${describeRow(row, operation.dryRun)}`);
  }
  const count = (fn) => results.filter(fn).length;
  const summary = operation.dryRun
    ? {
        wouldSend: count((r) => r.ok && r.data?.action === "would_send"),
        alreadySent: count((r) => r.ok && r.data?.action === "already_sent"),
        refused: count((r) => !r.ok || r.data?.action === "refused"),
      }
    : {
        sent: count((r) => r.ok && r.data?.sent === true),
        alreadySent: count((r) => r.ok && r.data?.alreadySent === true),
        refused: count((r) => !r.ok),
      };
  if (summary.refused) process.exitCode = 1;
  return {
    ok: true,
    status: summary.refused ? "partial" : "success",
    data: { dryRun: operation.dryRun, campaign: operation.campaign, summary, results },
  };
}

function describeRow(row, dryRun) {
  if (!row.ok) return `refused: ${row.error?.message || row.error?.code}`;
  const data = row.data || {};
  if (dryRun) {
    if (data.action === "would_send") return "would send";
    if (data.action === "already_sent") return `already sent (chat message ${data.receipt?.messageId})`;
    return `refused: ${(data.refusals || []).map((r) => r.message).join(" ")}`;
  }
  return data.sent
    ? `sent (chat message ${data.receipt?.messageId}, receipt ${data.receipt?.receiptId})`
    : `already sent (chat message ${data.receipt?.messageId})`;
}

export function formatBuildMessageResult({ operation, data }) {
  if (operation.name === "build-message.list") {
    const receipts = data?.receipts || [];
    return [
      `Campaign ${data?.campaign}: ${receipts.length} message${receipts.length === 1 ? "" : "s"} sent.`,
      ...receipts.map(
        (r) =>
          `  build ${r.buildId} "${r.buildTitle ?? "(deleted)"}" → ${r.ownerUsername ?? r.ownerUserId}: chat message ${r.messageId}, ${new Date(r.createdAt * 1000).toISOString()}${r.stillInChat ? "" : " (no longer in the chat)"}${r.ownerWroteSinceAt ? `; they wrote in that project at ${new Date(r.ownerWroteSinceAt * 1000).toISOString()}` : ""}`,
      ),
    ];
  }
  const lines = [];
  for (const row of data?.results || []) {
    const build = row.data?.build;
    const who = build ? `${build.ownerUsername ?? "?"} (user ${build.ownerUserId})` : row.ownerUsername || "?";
    lines.push(`build ${row.buildId} "${build?.title ?? row.title ?? "?"}" → ${who}: ${describeRow(row, data.dryRun)}`);
    // The dry run shows every recipient's full text, refused ones included.
    if (data.dryRun) {
      const extra = row.ok && row.data?.carryOver?.replaces?.length ? ` (replaces the latest ${row.data.carryOver.replaces.join(", ")})` : "";
      lines.push(`  ${row.data?.contentChars ?? row.text.length} chars${extra}:`);
      for (const line of row.text.split("\n")) lines.push(`  | ${line}`);
    }
  }
  const s = data?.summary || {};
  lines.push(
    data?.dryRun
      ? `Dry run, campaign ${data?.campaign}: ${s.wouldSend || 0} would send, ${s.alreadySent || 0} already sent, ${s.refused || 0} refused. Nothing was written. Add --confirm to send.`
      : `Campaign ${data?.campaign}: ${s.sent || 0} sent, ${s.alreadySent || 0} already sent, ${s.refused || 0} refused.${s.refused ? " Re-run the same command to retry the refused ones." : ""}`,
  );
  return lines;
}
