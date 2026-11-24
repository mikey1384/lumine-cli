import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testWorkRoot } from "./helpers/work-directory.js";
import { parseArgs } from "../lib/commands.js";
import { botBranchCommand, botBranchCreateRequestKey, botBranchRequestKey, buildSuggestBody, parseBotIdentity } from "../lib/admin-bot-branch.js";

const API = "https://api.example.test";
const options = (...args) => ({
  ...parseArgs(["admin", "bot-branch", ...args]),
  apiUrl: API,
  siteUrl: "https://site.example.test",
  authToken: "operator-token",
});

const branch = {
  branchBuildId: 3001, branchNumber: 4, branchTitle: "Ciel's branch", branchStatus: "draft",
  rootBuildId: 2685, rootTitle: "Abyssal - Tidewatch", ownerUserId: 14940, ownerUsername: "OverClassified",
  identity: "ciel", botUserId: 154, followupId: 9, lastSuggestion: null, createdAt: 1,
};

function fakeServer() {
  const calls = [];
  let files = [{ path: "/index.html", content: "<!doctype html><p>main</p>" }];
  let filesHash = "hash-main";
  const request = async ({ method, url, body, headers }) => {
    const route = url.replace(`${API}/cli/admin`, "");
    calls.push({ method, route, body, headers });
    if (method === "POST" && route === "/bot-branches")
      return { ok: true, status: "success", data: { botBranch: { ...branch, filesHash } } };
    if (method === "GET" && route.startsWith("/bot-branches/3001/project-files"))
      return { ok: true, status: "success", data: { botBranch: branch, projectFiles: files, filesHash, projectManifest: { entryPath: "/index.html" }, projectLimits: { maxProjectBytes: 5_000_000, maxFilesPerProject: 500, maxFileLines: 500 } } };
    if (method === "PUT" && route === "/bot-branches/3001/project-files") {
      if (body.baseFilesHash !== filesHash) {
        const error = new Error("The project changed.");
        error.status = 409;
        error.data = { ok: false, error: { code: "CLI_ADMIN_BOT_BRANCH_STALE", message: "The project changed." } };
        throw error;
      }
      files = body.files;
      filesHash = "hash-v2";
      return { ok: true, status: "success", data: { botBranch: branch, save: { filesHash, fileCount: files.length, artifactVersion: { versionNumber: 2 } } } };
    }
    if (method === "GET" && route.startsWith("/bot-branches/3001?"))
      return { ok: true, status: "success", data: { botBranch: branch, revisionHash: "rev-1" } };
    if (method === "POST" && route === "/bot-branches/3001/suggest")
      return body.dryRun
        ? { ok: true, status: "success", data: { dryRun: true, botBranch: branch, note: body.note, noteChars: body.note.length, dmChannelId: 53363, changedFiles: [{ path: "/endless.js", status: "added" }], followup: { id: 9, status: "completed" }, followupUpdate: body.followup || null } }
        : { ok: true, status: "success", data: { sent: true, botBranch: branch, followup: { id: 9 }, suggestion: { messageId: 777, channelId: 53363 }, followupResult: body.followup ? { updated: true, personalFollowup: { status: "completed", revision: 4 } } : null } };
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { request, calls };
}

const deps = (server, lines = []) => ({ request: server.request, log: (line) => lines.push(line), checkScope: async () => ({}) });

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "bot-branch-"));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("the bot is always named; flags parse into the admin options", () => {
  assert.equal(parseBotIdentity(" Ciel "), "ciel");
  for (const bad of ["", "auto", "mikey"]) assert.throws(() => parseBotIdentity(bad), /--identity zero or --identity ciel/);
  const parsed = options("suggest", "--branch", "3001", "--identity", "ciel", "--note-file", "n.txt", "--followup-revision", "3", "--followup-note-file", "f.txt", "--confirm");
  assert.equal(parsed.adminNoteFile, "n.txt");
  assert.equal(parsed.adminFollowupRevision, "3");
  assert.equal(parsed.adminFollowupNoteFile, "f.txt");
  assert.equal(parsed.adminConfirm, "true");
  assert.equal(options("create", "--build", "2685", "--followup", "9").adminFollowup, "9");
  assert.throws(() => buildSuggestBody({ identity: "ciel", note: "n", confirm: true, followupRevision: "3", followupNote: "" }), /both --followup-revision/);
  assert.deepEqual(buildSuggestBody({ identity: "ciel", note: "n", confirm: false }), { identity: "ciel", note: "n", dryRun: true });
  assert.notEqual(botBranchRequestKey("suggest", 1, "rev-1"), botBranchRequestKey("suggest", 1, "rev-2"));
});

test("create, edit, save and suggest: the whole promise flow as Ciel", () =>
  withDir(async (root) => {
    const server = fakeServer();
    const dir = path.join(root, "ciel-tidewatch");
    const lines = [];
    await botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--followup", "9", "--dir", dir), deps(server, lines));
    const create = server.calls.find((c) => c.method === "POST");
    assert.deepEqual(create.body, { identity: "ciel", buildId: 2685, followupId: 9 });
    assert.match(create.headers["x-lumine-idempotency-key"], /^cli:bb:create:/);
    assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "<!doctype html><p>main</p>");
    const marker = JSON.parse(fs.readFileSync(path.join(dir, ".twinkle", "bot-branch.json"), "utf8"));
    assert.equal(marker.branchBuildId, 3001);
    assert.equal(marker.identity, "ciel");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, ".twinkle", "lumine-project.json"), "utf8"));
    assert.equal(meta.filesHash, "hash-main");
    assert.equal(meta.build.canWrite, false, "plain `lumine save` (as the operator) must not treat it as writable");

    // A new create of the same build and bot into this workspace would be a
    // second branch: refused before anything is sent. Retrying the create
    // that made it (its key) is fine.
    const createCalls = () => server.calls.filter((c) => c.method === "POST" && c.route === "/bot-branches").length;
    await assert.rejects(
      botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--followup", "9", "--dir", dir), deps(server)),
      /already holds ciel's branch build 3001.*pull --branch 3001/,
    );
    assert.equal(createCalls(), 1);
    assert.equal(marker.createRequestKey, create.headers["x-lumine-idempotency-key"]);
    await botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--followup", "9", "--dir", dir, "--request-key", marker.createRequestKey), deps(server, lines));
    assert.equal(server.calls.filter((c) => c.method === "POST" && c.route === "/bot-branches").at(-1).headers["x-lumine-idempotency-key"], marker.createRequestKey);
    fs.writeFileSync(path.join(dir, "endless.js"), "export const depth = 8;\n");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "agent notes are never uploaded");
    await assert.rejects(
      botBranchCommand(options("pull", "--branch", "3001", "--identity", "ciel", "--dir", dir), deps(server)),
      /never saved/,
      "a pull never overwrites unsaved edits",
    );
    await assert.rejects(
      botBranchCommand(options("save", "--dir", dir, "--identity", "zero"), deps(server)),
      /ciel's branch/,
    );
    await botBranchCommand(options("save", "--dir", dir, "--summary", "Endless campaign"), deps(server, lines));
    const save = server.calls.find((c) => c.method === "PUT");
    assert.equal(save.body.identity, "ciel");
    assert.equal(save.body.baseFilesHash, "hash-main");
    assert.equal(save.body.summary, "Endless campaign");
    assert.deepEqual(save.body.files.map((f) => f.path), ["/endless.js", "/index.html"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".twinkle", "lumine-project.json"), "utf8")).filesHash, "hash-v2");

    const noteFile = path.join(root, "note.txt");
    fs.writeFileSync(noteFile, "The endless campaign you asked me about!\r\n");
    const followupNote = path.join(root, "followup.txt");
    fs.writeFileSync(followupNote, "Sent the endless campaign from my branch.");
    await botBranchCommand(options("suggest", "--branch", "3001", "--identity", "ciel", "--note-file", noteFile), deps(server, lines));
    const dry = server.calls.filter((c) => c.route === "/bot-branches/3001/suggest").at(-1);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.note, "The endless campaign you asked me about!");
    assert.equal(dry.headers["x-lumine-idempotency-key"], undefined);
    assert.ok(lines.some((l) => /Nothing was sent/.test(l)));

    await botBranchCommand(
      options("suggest", "--branch", "3001", "--identity", "ciel", "--note-file", noteFile, "--followup-revision", "3", "--followup-note-file", followupNote, "--confirm"),
      deps(server, lines),
    );
    const sent = server.calls.filter((c) => c.route === "/bot-branches/3001/suggest").at(-1);
    assert.equal(sent.body.dryRun, false);
    assert.deepEqual(sent.body.followup, { revision: 3, note: "Sent the endless campaign from my branch." });
    assert.match(sent.headers["x-lumine-idempotency-key"], /^cli:bb:suggest:/);
    assert.ok(lines.some((l) => /Ciel sent branch build 3001 to OverClassified: chat message 777/.test(l)));
    assert.ok(lines.some((l) => /Follow-up 9 is now completed \(revision 4\)/.test(l)));
  }));

test("a stale save says how to recover and changes nothing locally", () =>
  withDir(async (root) => {
    const server = fakeServer();
    const dir = path.join(root, "ws");
    await botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--dir", dir), deps(server));
    const metaPath = path.join(dir, ".twinkle", "lumine-project.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, filesHash: "old-hash" }));
    await assert.rejects(botBranchCommand(options("save", "--dir", dir), deps(server)), /Pull into a new folder/);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, "utf8")).filesHash, "old-hash");
  }));

test("a folder that is someone else's workspace is never overwritten", () =>
  withDir(async (root) => {
    const dir = path.join(root, "busy");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "mine");
    await assert.rejects(
      botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--dir", dir), deps(fakeServer())),
      /not empty/,
    );
    assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), "mine");
  }));

test("every create sends its own key; --request-key retries exactly one, and a failed create prints it", () =>
  withDir(async (root) => {
    const first = botBranchCreateRequestKey("");
    const second = botBranchCreateRequestKey("");
    assert.match(first, /^cli:bb:create:[0-9a-f-]{36}$/);
    assert.notEqual(first, second, "the same build, bot and title later is a new branch, not a replay");
    assert.equal(botBranchCreateRequestKey(" cli:bb:create:retry-1 "), "cli:bb:create:retry-1");
    assert.throws(() => botBranchCreateRequestKey("short"), /--request-key must be 8-80/);
    assert.throws(() => botBranchCreateRequestKey("has spaces in it"), /--request-key must be 8-80/);

    const server = fakeServer();
    await botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--dir", path.join(root, "a")), deps(server));
    await botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--dir", path.join(root, "b")), deps(server));
    const keys = server.calls.filter((c) => c.method === "POST").map((c) => c.headers["x-lumine-idempotency-key"]);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);

    const lost = async () => {
      const error = new Error("socket hang up");
      error.status = 502;
      throw error;
    };
    let sentKey = "";
    await assert.rejects(
      botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--dir", path.join(root, "c")), {
        ...deps(server),
        request: async (req) => {
          sentKey = req.headers["x-lumine-idempotency-key"];
          return lost();
        },
      }),
      (error) => error.message.includes(`--request-key ${sentKey}`) && sentKey.startsWith("cli:bb:create:"),
    );
    const closed = async () => {
      const error = new Error("This request key already created branch build 3001 of Build #2685, and that branch was already merged.");
      error.status = 409;
      error.data = { ok: false, error: { code: "CLI_ADMIN_BOT_BRANCH_CREATE_REPLAY_CLOSED" } };
      throw error;
    };
    await assert.rejects(
      botBranchCommand(options("create", "--build", "2685", "--identity", "ciel", "--request-key", "cli:bb:create:retry-1", "--dir", path.join(root, "d")), { ...deps(server), request: closed }),
      (error) => /already merged/.test(error.message) && !/--request-key/.test(error.message),
      "a closed replay is not offered as a retry",
    );
    assert.equal(options("create", "--request-key", "cli:bb:create:retry-1").adminRequestKey, "cli:bb:create:retry-1");
  }));
