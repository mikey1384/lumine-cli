import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../lib/commands.js";
import { PROJECT_METADATA_DIR, PROJECT_METADATA_FILE } from "../lib/constants.js";
import {
  BOT_BRANCH_FILE,
  botBranchCommand,
  botBranchCreateRequestKey,
  botBranchRequestKey,
  buildSuggestBody,
  parseBotIdentity,
} from "../lib/admin-bot-branch.js";

// Fixture workspaces live beside the tests (never /tmp) and are removed afterward.
const fixtures = fs.mkdtempSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), ".bot-branch-fixtures-"),
);
test.after(() => fs.rmSync(fixtures, { recursive: true, force: true }));

const opts = (...args) =>
  parseArgs([
    "admin",
    "bot-branch",
    ...args,
    "--api-url",
    "http://api.test",
    "--auth-token",
    "test-token",
  ]);

const sha = (value) => createHash("sha256").update(String(value)).digest("hex");

function writeFixtureFile(name, text) {
  const filePath = path.join(fixtures, name);
  fs.writeFileSync(filePath, text, "utf8");
  return filePath;
}

test("identity, request-key and suggest-body helpers enforce explicit bot and paired follow-up flags", () => {
  assert.equal(parseBotIdentity(" Ciel "), "ciel");
  assert.equal(parseBotIdentity("zero"), "zero");
  for (const bad of ["auto", "", "mikey", undefined]) {
    assert.throws(() => parseBotIdentity(bad), /--identity zero or --identity ciel/);
  }

  const keyA = botBranchCreateRequestKey("");
  const keyB = botBranchCreateRequestKey("");
  assert.match(keyA, /^cli:bb:create:[0-9a-f-]+$/);
  assert.notEqual(keyA, keyB, "each create gets a fresh request key by default");
  assert.equal(botBranchCreateRequestKey("cli:bb:create:retry-01"), "cli:bb:create:retry-01");
  assert.throws(() => botBranchCreateRequestKey("short"), /8-80 characters/);
  assert.throws(() => botBranchCreateRequestKey("bad space key"), /8-80 characters/);

  assert.deepEqual(
    buildSuggestBody({ identity: "ciel", note: "Added endless mode.", confirm: false }),
    { identity: "ciel", note: "Added endless mode.", dryRun: true },
  );
  assert.deepEqual(
    buildSuggestBody({
      identity: "zero",
      note: "Fixed score bug.",
      confirm: true,
      followupRevision: "4",
      followupNote: "Delivered branch.",
      followupStatus: "completed",
    }),
    {
      identity: "zero",
      note: "Fixed score bug.",
      dryRun: false,
      followup: { revision: 4, note: "Delivered branch.", status: "completed" },
    },
  );
  assert.throws(
    () =>
      buildSuggestBody({
        identity: "ciel",
        note: "hi",
        confirm: false,
        followupRevision: "2",
        followupNote: "",
      }),
    /Pass both --followup-revision and --followup-note-file/,
  );
  assert.throws(
    () =>
      buildSuggestBody({
        identity: "ciel",
        note: "hi",
        confirm: false,
        followupRevision: "",
        followupNote: "note",
      }),
    /Pass both --followup-revision and --followup-note-file/,
  );
});

test("parseArgs parses all bot-branch flags for create, suggest, status and list", () => {
  const create = parseArgs([
    "admin",
    "bot-branch",
    "create",
    "--build",
    "2721",
    "--identity",
    "ciel",
    "--followup",
    "9",
    "--title",
    "Endless campaign",
    "--dir",
    "./bb-3110",
    "--request-key",
    "cli:bb:create:retry-01",
  ]);
  assert.equal(create.command, "admin");
  assert.deepEqual(create.positional, ["bot-branch", "create"]);
  assert.equal(create.adminBuild, "2721");
  assert.equal(create.adminIdentity, "ciel");
  assert.equal(create.adminFollowup, "9");
  assert.equal(create.title, "Endless campaign");
  assert.equal(create.dir, "./bb-3110");
  assert.equal(create.adminRequestKey, "cli:bb:create:retry-01");

  const suggest = parseArgs([
    "admin",
    "bot-branch",
    "suggest",
    "--branch",
    "3110",
    "--identity",
    "ciel",
    "--note-file",
    "note.txt",
    "--followup-revision",
    "2",
    "--followup-note-file",
    "followup.txt",
    "--followup-status",
    "completed",
    "--confirm",
  ]);
  assert.equal(suggest.adminBranch, "3110");
  assert.equal(suggest.adminNoteFile, "note.txt");
  assert.equal(suggest.adminFollowupRevision, "2");
  assert.equal(suggest.adminFollowupNoteFile, "followup.txt");
  assert.equal(suggest.adminFollowupStatus, "completed");
  assert.equal(suggest.adminConfirm, "true");
});

test("create, save and pull manage read-only project metadata, bot-branch markers, and guard unsaved edits", async () => {
  const workspaceDir = path.join(fixtures, "ws-3110");
  const initialHtml = "<!doctype html><html><body><h1>Tidewatch</h1></body></html>";
  const updatedHtml = "<!doctype html><html><body><h1>Tidewatch Endless</h1></body></html>";
  const calls = [];
  const scopes = [];
  const lines = [];

  const botBranch = {
    branchBuildId: 3110,
    branchNumber: 4,
    branchTitle: "Endless campaign",
    branchStatus: "draft",
    rootBuildId: 2721,
    rootTitle: "Tidewatch",
    ownerUserId: 77,
    ownerUsername: "kai",
    identity: "ciel",
    botUserId: 154,
    followupId: 9,
  };

  const request = async (call) => {
    calls.push(call);
    if (call.method === "POST" && call.url.endsWith("/cli/admin/bot-branches")) {
      return { ok: true, status: "success", data: { botBranch } };
    }
    if (
      call.method === "GET" &&
      call.url.endsWith("/cli/admin/bot-branches/3110/project-files?identity=ciel")
    ) {
      return {
        ok: true,
        status: "success",
        data: {
          botBranch,
          projectFiles: [{ path: "/index.html", content: initialHtml }],
          filesHash: "hash-v1",
          projectManifest: { entryPath: "/index.html", storageMode: "project-files", fileCount: 1 },
          projectLimits: { maxProjectBytes: 1048576, maxFilesPerProject: 100, maxFileLines: 500 },
        },
      };
    }
    if (
      call.method === "PUT" &&
      call.url.endsWith("/cli/admin/bot-branches/3110/project-files")
    ) {
      return {
        ok: true,
        status: "success",
        data: {
          botBranch,
          save: {
            artifactVersion: { versionNumber: 2 },
            filesHash: "hash-v2",
            fileCount: 1,
          },
        },
      };
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  };

  const checkScope = async ({ scope }) => {
    scopes.push(scope);
  };

  await botBranchCommand(
    opts(
      "create",
      "--build",
      "2721",
      "--identity",
      "ciel",
      "--followup",
      "9",
      "--title",
      "Endless campaign",
      "--dir",
      workspaceDir,
    ),
    { request, log: (l) => lines.push(l), checkScope },
  );

  assert.deepEqual(scopes, ["build:write"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    identity: "ciel",
    buildId: 2721,
    followupId: 9,
    title: "Endless campaign",
  });
  assert.match(calls[0].headers["x-lumine-idempotency-key"], /^cli:bb:create:/);
  assert.equal(calls[1].method, "GET");

  const projectMeta = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, PROJECT_METADATA_DIR, PROJECT_METADATA_FILE), "utf8"),
  );
  assert.equal(projectMeta.build.role, "bot-branch");
  assert.equal(projectMeta.build.canWrite, false);
  assert.equal(projectMeta.build.canPublish, false);
  assert.equal(projectMeta.filesHash, "hash-v1");

  const marker = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, PROJECT_METADATA_DIR, BOT_BRANCH_FILE), "utf8"),
  );
  assert.equal(marker.branchBuildId, 3110);
  assert.equal(marker.rootBuildId, 2721);
  assert.equal(marker.identity, "ciel");
  assert.equal(marker.createRequestKey, calls[0].headers["x-lumine-idempotency-key"]);

  // Running create again into the same directory without the original --request-key is refused.
  await assert.rejects(
    botBranchCommand(
      opts("create", "--build", "2721", "--identity", "ciel", "--dir", workspaceDir),
      { request, log: () => {}, checkScope },
    ),
    /already holds ciel's branch build 3110/,
  );

  // Save guards mismatched identity/branch before hitting the network.
  await assert.rejects(
    botBranchCommand(opts("save", "--dir", workspaceDir, "--identity", "zero"), {
      request,
      log: () => {},
      checkScope,
    }),
    /--identity zero does not match/,
  );
  await assert.rejects(
    botBranchCommand(opts("save", "--dir", workspaceDir, "--branch", "9999"), {
      request,
      log: () => {},
      checkScope,
    }),
    /This workspace is branch build 3110, not 9999/,
  );

  // Edit local file: pull must refuse to overwrite unsaved edits.
  fs.writeFileSync(path.join(workspaceDir, "index.html"), updatedHtml, "utf8");
  await assert.rejects(
    botBranchCommand(
      opts("pull", "--branch", "3110", "--identity", "ciel", "--dir", workspaceDir),
      { request, log: () => {}, checkScope },
    ),
    /has edits that were never saved/,
  );

  // Save sends baseFilesHash + deterministic idempotency key and updates local hashes.
  calls.length = 0;
  lines.length = 0;
  await botBranchCommand(
    opts("save", "--dir", workspaceDir, "--summary", "Add endless campaign"),
    { request, log: (l) => lines.push(l), checkScope },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body.identity, "ciel");
  assert.equal(calls[0].body.baseFilesHash, "hash-v1");
  assert.equal(calls[0].body.summary, "Add endless campaign");
  assert.deepEqual(calls[0].body.files, [{ path: "/index.html", content: updatedHtml }]);
  assert.match(calls[0].headers["x-lumine-idempotency-key"], /^cli:bb:save:[0-9a-f]{40}$/);
  assert.match(lines[0], /Saved 1 files to ciel's branch build 3110 as v2/);

  const updatedMarker = JSON.parse(
    fs.readFileSync(path.join(workspaceDir, PROJECT_METADATA_DIR, BOT_BRANCH_FILE), "utf8"),
  );
  assert.equal(updatedMarker.filesHash, "hash-v2");
});

test("create prints --request-key on transport/server failure, but not on daily-run or closed-replay refusals", async () => {
  const checkScope = async () => {};
  const failWith = (message, code) => async () => {
    const err = new Error(message);
    err.data = { error: { code } };
    throw err;
  };

  await assert.rejects(
    botBranchCommand(opts("create", "--build", "2721", "--identity", "ciel"), {
      request: failWith("Gateway timeout", "TIMEOUT"),
      log: () => {},
      checkScope,
    }),
    /To retry this same create, run it again with --request-key cli:bb:create:/,
  );

  for (const code of [
    "CLI_ADMIN_BOT_BRANCH_DAILY_RUN_FORBIDDEN",
    "CLI_ADMIN_BOT_BRANCH_CREATE_REPLAY_CLOSED",
  ]) {
    await assert.rejects(
      botBranchCommand(opts("create", "--build", "2721", "--identity", "ciel"), {
        request: failWith("Refused", code),
        log: () => {},
        checkScope,
      }),
      (err) => {
        assert.doesNotMatch(err.message, /--request-key/);
        return true;
      },
    );
  }
});

test("suggest defaults to dry-run (build:read, no key) and --confirm binds revisionHash into the idempotency key", async () => {
  const noteFile = writeFixtureFile("suggest-note.txt", "Added the endless campaign you asked for!\n");
  const followupFile = writeFixtureFile("followup-note.txt", "Sent Ciel's branch suggestion.");
  const calls = [];
  const scopes = [];
  const lines = [];

  const botBranch = {
    branchBuildId: 3110,
    branchTitle: "Endless campaign",
    rootBuildId: 2721,
    rootTitle: "Tidewatch",
    ownerUserId: 77,
    ownerUsername: "kai",
    identity: "ciel",
  };

  const request = async (call) => {
    calls.push(call);
    if (call.method === "GET" && call.url.endsWith("/cli/admin/bot-branches/3110?identity=ciel")) {
      return { ok: true, status: "success", data: { revisionHash: "rev-abc123" } };
    }
    if (call.method === "POST" && call.url.endsWith("/cli/admin/bot-branches/3110/suggest")) {
      if (call.body.dryRun) {
        return {
          ok: true,
          status: "success",
          data: {
            dryRun: true,
            action: "would_send",
            botBranch,
            dmChannelId: 500,
            changedFiles: [{ path: "/main.js", status: "added" }],
            note: call.body.note,
            noteChars: call.body.note.length,
            followup: { id: 9, status: "open" },
            followupUpdate: null,
          },
        };
      }
      return {
        ok: true,
        status: "success",
        data: {
          dryRun: false,
          sent: true,
          botBranch,
          suggestion: { messageId: 3891730, channelId: 500 },
          followup: { id: 9 },
          followupResult: {
            updated: true,
            personalFollowup: { status: "completed", revision: 3 },
          },
        },
      };
    }
    throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  };
  const checkScope = async ({ scope }) => {
    scopes.push(scope);
  };

  // Dry run
  await botBranchCommand(
    opts("suggest", "--branch", "3110", "--identity", "ciel", "--note-file", noteFile),
    { request, log: (l) => lines.push(l), checkScope },
  );
  assert.deepEqual(scopes, ["build:read"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.dryRun, true);
  assert.deepEqual(calls[0].headers, {});
  assert.match(lines.join("\n"), /Dry run: Ciel would suggest branch build 3110/);
  assert.match(lines.join("\n"), /Nothing was sent\. Add --confirm to send\./);

  // Reject conflicting flags and valued --confirm
  await assert.rejects(
    botBranchCommand(
      opts("suggest", "--branch", "3110", "--identity", "ciel", "--note-file", noteFile, "--confirm", "--dry-run"),
      { request, log: () => {}, checkScope },
    ),
    /not both/,
  );
  await assert.rejects(
    botBranchCommand(
      opts("suggest", "--branch", "3110", "--identity", "ciel", "--note-file", noteFile, "--confirm=yes"),
      { request, log: () => {}, checkScope },
    ),
    /--confirm on its own/,
  );

  // Confirmed send with follow-up update
  calls.length = 0;
  scopes.length = 0;
  lines.length = 0;
  await botBranchCommand(
    opts(
      "suggest",
      "--branch",
      "3110",
      "--identity",
      "ciel",
      "--note-file",
      noteFile,
      "--followup-revision",
      "2",
      "--followup-note-file",
      followupFile,
      "--confirm",
    ),
    { request, log: (l) => lines.push(l), checkScope },
  );
  assert.deepEqual(scopes, ["build:write"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body.dryRun, false);
  const expectedNote = "Added the endless campaign you asked for!";
  const expectedFollowup = { revision: 2, note: "Sent Ciel's branch suggestion." };
  assert.deepEqual(calls[1].body.followup, expectedFollowup);
  assert.equal(
    calls[1].headers["x-lumine-idempotency-key"],
    botBranchRequestKey(
      "suggest",
      3110,
      "ciel",
      "rev-abc123",
      sha(expectedNote),
      JSON.stringify(expectedFollowup),
    ),
  );
  assert.match(lines[0], /Ciel sent branch build 3110 to kai: chat message 3891730 in channel 500/);
  assert.match(lines[1], /Follow-up 9 is now completed \(revision 3\)/);

  // Partial status (card delivered, follow-up update failed) sets exitCode = 1
  const prevExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    lines.length = 0;
    await botBranchCommand(
      opts("suggest", "--branch", "3110", "--identity", "ciel", "--note-file", noteFile, "--confirm"),
      {
        request: async (call) =>
          call.method === "GET"
            ? { ok: true, data: { revisionHash: "rev-abc123" } }
            : {
                ok: true,
                status: "partial",
                data: {
                  botBranch,
                  suggestion: { messageId: 3891731, channelId: 500 },
                  followup: { id: 9 },
                  followupResult: { updated: false, error: "CLI_ADMIN_FOLLOWUP_REVISION_CONFLICT" },
                },
              },
        log: (l) => lines.push(l),
        checkScope,
      },
    );
    assert.equal(process.exitCode, 1);
    assert.match(lines.join("\n"), /The follow-up was NOT updated/);
  } finally {
    process.exitCode = prevExitCode;
  }
});

test("list and status are build:read calls with query filters and readable output", async () => {
  const calls = [];
  const scopes = [];
  const lines = [];
  const checkScope = async ({ scope }) => scopes.push(scope);
  const request = async (call) => {
    calls.push(call);
    if (call.url.includes("/bot-branches?")) {
      return {
        ok: true,
        data: {
          botBranches: [
            {
              branchBuildId: 3110,
              branchNumber: 4,
              branchTitle: "Endless campaign",
              branchStatus: "draft",
              rootBuildId: 2721,
              rootTitle: "Tidewatch",
              ownerUsername: "kai",
              identity: "ciel",
              followupId: 9,
              lastSuggestion: { messageId: 3891730 },
            },
          ],
        },
      };
    }
    return {
      ok: true,
      data: {
        botBranch: {
          branchBuildId: 3110,
          branchNumber: 4,
          branchTitle: "Endless campaign",
          branchStatus: "draft",
          rootBuildId: 2721,
          rootTitle: "Tidewatch",
          ownerUsername: "kai",
          identity: "ciel",
          lastSuggestion: null,
        },
        diffSummary: { total: 2 },
        rootDrifted: false,
        suggestBlockedBy: null,
        dmChannelId: 500,
        followup: { id: 9, status: "open", revision: 2 },
      },
    };
  };

  await botBranchCommand(opts("list", "--build", "2721", "--identity", "ciel"), {
    request,
    log: (l) => lines.push(l),
    checkScope,
  });
  assert.equal(calls[0].url, "http://api.test/cli/admin/bot-branches?buildId=2721&identity=ciel");
  assert.match(lines.join("\n"), /1 bot branch\./);
  assert.match(lines.join("\n"), /suggested as chat message 3891730/);

  lines.length = 0;
  await botBranchCommand(opts("status", "--branch", "3110"), {
    request,
    log: (l) => lines.push(l),
    checkScope,
  });
  assert.equal(calls[1].url, "http://api.test/cli/admin/bot-branches/3110");
  assert.deepEqual(scopes, ["build:read", "build:read"]);
  assert.match(lines.join("\n"), /Ready to suggest\./);
  assert.match(lines.join("\n"), /ciel has a chat with the owner \(channel 500\)\./);
});
