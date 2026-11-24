// lumine admin bot-branch: Zero or Ciel keeps a promise it made to a member by
// changing the member's Lumine app on a branch the bot owns, and the branch
// suggestion reaches the member from that bot, not from the operator's
// account (Mikey, 11-24). Server: twinkle-api controllers/cli/admin/botBranches.ts.
//
//   create  --build <id> --identity zero|ciel [--followup <id>] [--title <name>] [--dir <path>]
//   pull    --branch <id> --identity zero|ciel [--dir <path>]
//   save    [--dir <path>] [--summary <text>]          (branch and bot come from the workspace)
//   suggest --branch <id> --identity zero|ciel --note-file <path>
//           [--followup-revision <n> --followup-note-file <path> [--followup-status <s>]] [--confirm]
//   status  --branch <id>
//   list    [--build <id>] [--identity zero|ciel]
//
// The operator's own CLI login (the configured administrator) authorizes
// every call; the bot needs no login. Nothing here runs a model or spends AI
// Energy. A suggestion is a dry run unless --confirm.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { requestJson } from "./http.js";
import { assertAuthScope, resolveAuth } from "./auth.js";
import { createLumineSaveClientContext } from "./api.js";
import { PROJECT_METADATA_DIR } from "./constants.js";
import {
  assertProjectFilesWithinLimits,
  collectProjectFiles,
  computeProjectFileHashes,
  removeLocalProjectFilesNotIn,
  writeProjectFiles,
  writeProjectMetadata,
} from "./workspace.js";

export const BOT_BRANCH_FILE = "bot-branch.json";
const USAGE = [
  "Usage: lumine admin bot-branch create --build <id> --identity zero|ciel [--followup <id>] [--title <name>] [--dir <path>]",
  "       lumine admin bot-branch pull --branch <id> --identity zero|ciel [--dir <path>]",
  "       lumine admin bot-branch save [--dir <path>] [--summary <text>]",
  "       lumine admin bot-branch suggest --branch <id> --identity zero|ciel --note-file <path> [--followup-revision <n> --followup-note-file <path>] [--confirm]",
  "       lumine admin bot-branch status --branch <id> | list [--build <id>] [--identity zero|ciel]",
].join("\n");
const MAX_NOTE_FILE_BYTES = 64 * 1024;

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

function positiveId(value, label) {
  const raw = String(value ?? "").split(",")[0].trim();
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id <= 0) invalid(`Pass ${label} as a positive id.`);
  return id;
}

export function parseBotIdentity(value) {
  const identity = String(value || "").trim().toLowerCase();
  if (identity !== "zero" && identity !== "ciel")
    invalid("Pass --identity zero or --identity ciel: the bot that made the promise.");
  return identity;
}

function readTextFile(filePath, label) {
  const normalized = String(filePath || "").trim();
  if (!normalized) invalid(`Pass ${label}.`);
  let text;
  try {
    text = readFileSync(normalized, "utf8");
  } catch {
    invalid(`Could not read ${normalized}.`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_NOTE_FILE_BYTES) invalid(`${normalized} must be under 64KB.`);
  return text.replace(/\r\n?/g, "\n").trim();
}

const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

// One key per logical request: a retry after a crash replays the server's
// stored receipt instead of acting twice.
export function botBranchRequestKey(kind, ...parts) {
  return `cli:bb:${kind}:${sha(parts.join("\u0000")).slice(0, 40)}`;
}

export function buildSuggestBody({ identity, note, confirm, followupRevision, followupNote, followupStatus }) {
  const body = { identity, note, dryRun: !confirm };
  if (followupRevision || followupNote) {
    if (!followupRevision || !followupNote)
      invalid("Pass both --followup-revision and --followup-note-file to record the promise on its follow-up.");
    body.followup = {
      revision: positiveId(followupRevision, "--followup-revision"),
      note: followupNote,
      ...(followupStatus ? { status: followupStatus } : {}),
    };
  }
  return body;
}

async function readBotBranchWorkspace(dir) {
  const file = path.join(dir, PROJECT_METADATA_DIR, BOT_BRANCH_FILE);
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readProjectMetadata(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, PROJECT_METADATA_DIR, "lumine-project.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// The workspace is marked as a bot branch so `lumine save` (which acts as the
// operator) is never the way to save it: its build metadata says read-only,
// and bot-branch.json names the branch and the bot for `bot-branch save`.
async function writeBotBranchWorkspace({ dir, options, botBranch, filesPayload }) {
  const files = filesPayload.projectFiles;
  await writeProjectFiles({ dir, files });
  await removeLocalProjectFilesNotIn({ dir, files }).catch(() => {});
  await writeProjectMetadata({
    dir,
    options,
    build: {
      id: botBranch.branchBuildId,
      title: botBranch.branchTitle,
      role: "bot-branch",
      ownerUsername: botBranch.identity === "zero" ? "Zero" : "Ciel",
      contributionStatus: botBranch.branchStatus || "draft",
      contributionRootBuildId: botBranch.rootBuildId,
      contributionContributorId: botBranch.botUserId,
      contributionBranchNumber: botBranch.branchNumber,
      canWrite: false,
      canPublish: false,
      projectLimits: filesPayload.projectLimits || null,
    },
    manifest: filesPayload.projectManifest || null,
    pulledAt: new Date().toISOString(),
    filesHash: filesPayload.filesHash,
    fileHashes: computeProjectFileHashes(files),
  });
  await fs.writeFile(
    path.join(dir, PROJECT_METADATA_DIR, BOT_BRANCH_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        branchBuildId: botBranch.branchBuildId,
        rootBuildId: botBranch.rootBuildId,
        identity: botBranch.identity,
        botUserId: botBranch.botUserId,
        followupId: botBranch.followupId ?? null,
        apiUrl: options.apiUrl,
        filesHash: filesPayload.filesHash,
        note: "Save with `lumine admin bot-branch save` (acts as the bot). `lumine save` acts as you and cannot save this branch.",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function assertDirUsable(dir, branchBuildId) {
  if (!existsSync(dir)) return;
  const entries = (await fs.readdir(dir)).filter((name) => name !== ".DS_Store");
  if (!entries.length) return;
  const marker = await readBotBranchWorkspace(dir);
  if (Number(marker?.branchBuildId || 0) !== Number(branchBuildId))
    invalid(`${dir} is not empty and is not this bot branch's workspace. Pass --dir with a new folder.`);
}

export async function botBranchCommand(
  options,
  { request = requestJson, log = console.log, checkScope = assertAuthScope } = {},
) {
  const action = String(options.positional?.[1] || "");
  if (!["create", "pull", "save", "suggest", "status", "list"].includes(action)) invalid(USAGE);
  const auth = await resolveAuth(options);
  const mutates = action === "create" || action === "save" || (action === "suggest" && options.adminConfirm === "true");
  await checkScope({ options, auth, scope: mutates ? "build:write" : "build:read" });
  const call = (method, route, body, key) =>
    request({
      method,
      url: `${options.apiUrl}/cli/admin${route}`,
      authToken: auth.token,
      ...(body === undefined ? {} : { body }),
      headers: key ? { "x-lumine-idempotency-key": key } : {},
      timeoutMs: Math.max(60000, Number(options.timeoutMs) || 0),
    });
  const print = (result, lines) => {
    if (options.json) log(JSON.stringify(result));
    else for (const line of lines) log(line);
    return result;
  };

  if (action === "list") {
    const query = new URLSearchParams();
    if (options.adminBuild) query.set("buildId", String(positiveId(options.adminBuild, "--build")));
    if (options.adminIdentity) query.set("identity", parseBotIdentity(options.adminIdentity));
    const result = await call("GET", `/bot-branches${query.size ? `?${query}` : ""}`);
    const rows = result?.data?.botBranches || [];
    return print(result, [
      `${rows.length} bot branch${rows.length === 1 ? "" : "es"}.`,
      ...rows.map(
        (b) =>
          `  branch build ${b.branchBuildId} (#${b.branchNumber} "${b.branchTitle}", ${b.branchStatus}) of Build #${b.rootBuildId} "${b.rootTitle}" by ${b.identity}; owner ${b.ownerUsername ?? b.ownerUserId}${b.followupId ? `; follow-up ${b.followupId}` : ""}${b.lastSuggestion ? `; suggested as chat message ${b.lastSuggestion.messageId}` : ""}`,
      ),
    ]);
  }

  if (action === "status") {
    const branchBuildId = positiveId(options.adminBranch, "--branch");
    const result = await call("GET", `/bot-branches/${branchBuildId}`);
    const d = result?.data || {};
    const b = d.botBranch || {};
    return print(result, [
      `Branch build ${b.branchBuildId} (#${b.branchNumber} "${b.branchTitle}", ${b.branchStatus}), owned by ${b.identity}, of Build #${b.rootBuildId} "${b.rootTitle}" (owner ${b.ownerUsername ?? b.ownerUserId}).`,
      `Changes from Main: ${d.diffSummary?.total ?? 0} file(s)${d.rootDrifted ? "; Main moved since the branch was cut" : ""}.`,
      d.suggestBlockedBy ? `Cannot suggest yet: ${d.suggestBlockedBy}.` : "Ready to suggest.",
      d.dmChannelId ? `${b.identity} has a chat with the owner (channel ${d.dmChannelId}).` : `${b.identity} has no chat with the owner: a suggestion would be refused.`,
      b.lastSuggestion ? `Last suggested: chat message ${b.lastSuggestion.messageId}.` : "Not suggested yet.",
      d.followup ? `Follow-up ${d.followup.id}: ${d.followup.status}, revision ${d.followup.revision}.` : "No linked follow-up.",
    ]);
  }

  if (action === "create" || action === "pull") {
    const identity = parseBotIdentity(options.adminIdentity);
    let botBranch;
    let created = null;
    if (action === "create") {
      const buildId = positiveId(options.adminBuild, "--build");
      const followupId = options.adminFollowup ? positiveId(options.adminFollowup, "--followup") : null;
      const title = String(options.title || "").trim();
      if (options.dir) await assertDirUsable(path.resolve(options.dir), -1);
      created = await call(
        "POST",
        "/bot-branches",
        { identity, buildId, ...(followupId ? { followupId } : {}), ...(title ? { title } : {}) },
        botBranchRequestKey("create", buildId, identity, followupId || "", title),
      );
      botBranch = created?.data?.botBranch;
      if (!botBranch?.branchBuildId) throw new Error("Twinkle did not return the new bot branch.");
    } else {
      botBranch = { branchBuildId: positiveId(options.adminBranch, "--branch") };
    }
    const filesPayload = (
      await call("GET", `/bot-branches/${botBranch.branchBuildId}/project-files?identity=${identity}`)
    )?.data;
    botBranch = { ...filesPayload.botBranch, ...botBranch, identity, botUserId: filesPayload.botBranch.botUserId };
    const dir = path.resolve(options.dir || `bot-branch-${botBranch.branchBuildId}`);
    await assertDirUsable(dir, botBranch.branchBuildId);
    await writeBotBranchWorkspace({ dir, options, botBranch: { ...filesPayload.botBranch, identity }, filesPayload });
    const result = {
      ok: true,
      status: "success",
      data: { botBranch: filesPayload.botBranch, created: Boolean(created), dir, filesHash: filesPayload.filesHash, fileCount: filesPayload.projectFiles.length },
    };
    return print(result, [
      created
        ? `Created ${identity === "zero" ? "Zero" : "Ciel"}'s branch build ${botBranch.branchBuildId} (#${filesPayload.botBranch.branchNumber}) of Build #${filesPayload.botBranch.rootBuildId} "${filesPayload.botBranch.rootTitle}" from current Main${filesPayload.botBranch.followupId ? `, for follow-up ${filesPayload.botBranch.followupId}` : ""}.`
        : `Pulled bot branch build ${botBranch.branchBuildId}.`,
      `Workspace: ${dir} (${filesPayload.projectFiles.length} files). Edit there, then \`lumine admin bot-branch save --dir ${dir}\`.`,
    ]);
  }

  if (action === "save") {
    const dir = path.resolve(options.dir || process.cwd());
    const marker = await readBotBranchWorkspace(dir);
    if (!marker) invalid(`${dir} is not a bot-branch workspace (no ${PROJECT_METADATA_DIR}/${BOT_BRANCH_FILE}). Run \`lumine admin bot-branch create\` or \`pull\` first.`);
    const identity = options.adminIdentity ? parseBotIdentity(options.adminIdentity) : marker.identity;
    if (identity !== marker.identity) invalid(`This workspace is ${marker.identity}'s branch; --identity ${identity} does not match.`);
    if (options.adminBranch && positiveId(options.adminBranch, "--branch") !== Number(marker.branchBuildId))
      invalid(`This workspace is branch build ${marker.branchBuildId}, not ${options.adminBranch}.`);
    if (marker.apiUrl && marker.apiUrl !== options.apiUrl) invalid(`This workspace was pulled from ${marker.apiUrl}.`);
    const metadata = await readProjectMetadata(dir);
    const baseFilesHash = String(metadata?.filesHash || marker.filesHash || "").trim();
    if (!baseFilesHash) invalid("This workspace has no base filesHash. Pull it again with `lumine admin bot-branch pull`.");
    const files = await collectProjectFiles(dir);
    assertProjectFilesWithinLimits(files, metadata?.build?.projectLimits || {}, { savedFileHashes: metadata?.fileHashes || null });
    const summary = String(options.summary || "").trim();
    let result;
    try {
      result = await call(
        "PUT",
        `/bot-branches/${marker.branchBuildId}/project-files`,
        { identity, files, baseFilesHash, summary, clientContext: createLumineSaveClientContext(options) },
        botBranchRequestKey("save", marker.branchBuildId, identity, baseFilesHash, sha(JSON.stringify(files)), summary),
      );
    } catch (error) {
      if (error?.data?.error?.code === "CLI_ADMIN_BOT_BRANCH_STALE")
        error.message = `${error.message} The branch changed on the server since this workspace was pulled. Pull into a new folder (\`lumine admin bot-branch pull --branch ${marker.branchBuildId} --identity ${identity} --dir <new>\`), reapply the edits, and save again.`;
      throw error;
    }
    const saved = result?.data?.save || {};
    const savedFiles = files;
    await writeProjectMetadata({
      dir,
      options,
      build: metadata?.build || { id: marker.branchBuildId, canWrite: false, canPublish: false },
      manifest: metadata?.manifest || null,
      pulledAt: metadata?.pulledAt,
      lastSavedAt: new Date().toISOString(),
      filesHash: saved.filesHash || null,
      fileHashes: computeProjectFileHashes(savedFiles),
    });
    await fs.writeFile(
      path.join(dir, PROJECT_METADATA_DIR, BOT_BRANCH_FILE),
      JSON.stringify({ ...marker, filesHash: saved.filesHash || null }, null, 2),
      "utf8",
    );
    return print(result, [
      `Saved ${saved.fileCount ?? files.length} files to ${identity}'s branch build ${marker.branchBuildId}${saved.artifactVersion?.versionNumber ? ` as v${saved.artifactVersion.versionNumber}` : ""}.`,
      ...(saved.preservationText ? [saved.preservationText] : []),
      `Next: \`lumine admin bot-branch suggest --branch ${marker.branchBuildId} --identity ${identity} --note-file <note.txt>\` (dry run), then add --confirm.`,
    ]);
  }

  // suggest
  const branchBuildId = positiveId(options.adminBranch, "--branch");
  const identity = parseBotIdentity(options.adminIdentity);
  if (options.adminConfirm !== "" && options.adminConfirm !== "true") invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (confirm && options.adminDryRun) invalid("Pass --confirm or --dry-run, not both.");
  const note = readTextFile(options.adminNoteFile, "--note-file <note.txt>");
  const body = buildSuggestBody({
    identity,
    note,
    confirm,
    followupRevision: options.adminFollowupRevision,
    followupNote: options.adminFollowupNoteFile ? readTextFile(options.adminFollowupNoteFile, "--followup-note-file") : "",
    followupStatus: options.adminFollowupStatus,
  });
  let key = "";
  if (confirm) {
    // The branch revision is part of the key: the same note after a new save
    // is a new suggestion, a retry of this one is not.
    const status = await call("GET", `/bot-branches/${branchBuildId}?identity=${identity}`);
    key = botBranchRequestKey("suggest", branchBuildId, identity, status?.data?.revisionHash || "", sha(note), JSON.stringify(body.followup || null));
  }
  const result = await call("POST", `/bot-branches/${branchBuildId}/suggest`, body, key);
  const d = result?.data || {};
  const b = d.botBranch || {};
  const bot = identity === "zero" ? "Zero" : "Ciel";
  if (!confirm) {
    return print(result, [
      `Dry run: ${bot} would suggest branch build ${b.branchBuildId} ("${b.branchTitle}") to ${b.ownerUsername ?? b.ownerUserId}, the owner of Build #${b.rootBuildId} "${b.rootTitle}", in ${bot}'s chat with them (channel ${d.dmChannelId}).`,
      `Changes: ${(d.changedFiles || []).map((f) => `${f.path} (${f.status})`).join(", ") || "none"}.`,
      `Note (${d.noteChars} chars):`,
      ...String(d.note || "").split("\n").map((line) => `  | ${line}`),
      d.followupUpdate ? `Follow-up ${d.followup?.id} would become ${d.followupUpdate.status} with your note plus the card's ids.` : d.followup ? `Linked follow-up ${d.followup.id} (${d.followup.status}) is left as it is.` : "No linked follow-up.",
      "Nothing was sent. Add --confirm to send.",
    ]);
  }
  if (result?.status === "partial") process.exitCode = 1;
  return print(result, [
    `${bot} sent branch build ${b.branchBuildId} to ${b.ownerUsername ?? b.ownerUserId}: chat message ${d.suggestion?.messageId} in channel ${d.suggestion?.channelId}.`,
    d.followupResult
      ? d.followupResult.updated
        ? `Follow-up ${d.followup?.id} is now ${d.followupResult.personalFollowup?.status} (revision ${d.followupResult.personalFollowup?.revision}).`
        : `The follow-up was NOT updated (${d.followupResult.error}); the card was delivered. Record it with \`lumine admin followup update ${d.followup?.id} --direct --identity ${identity} ...\`.`
      : "",
  ].filter(Boolean));
}
