import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testWorkRoot } from "./helpers/work-directory.js";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import {
  buildMessageRequestKey,
  formatBuildMessageResult,
  runBuildMessageWorkflow,
} from "../lib/admin-build-message.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", "build-message", ...args]));

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "build-message-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("build-message: sends are dry runs unless --confirm, need no daily run, and validate locally", () =>
  withDir((dir) => {
    const file = path.join(dir, "message.md");
    fs.writeFileSync(file, "  Hi! It's fixed now.\r\n");
    const dry = op("send", "--build", "3011", "--campaign", "upload-loop-fix", "--file", file, "--owner", "7977");
    assert.equal(dry.name, "build-message.send.preview");
    assert.equal(dry.mutates, false);
    assert.equal(dry.requiresRun, false);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.messages, [
      { buildId: 3011, expectedOwnerUserId: 7977, text: "Hi! It's fixed now.", title: null, ownerUsername: null },
    ]);
    const explicitDry = op("send", "--build", "3011", "--campaign", "upload-loop-fix", "--file", file, "--dry-run");
    assert.equal(explicitDry.dryRun, true);
    const real = op("send", "--build", "3011", "--campaign", "upload-loop-fix", "--file", file, "--confirm");
    assert.equal(real.name, "build-message.send");
    assert.equal(real.mutates, true);
    assert.equal(real.dryRun, false);
    assert.throws(() => op("send", "--build", "3011", "--campaign", "upload-loop-fix", "--file", file, "--confirm", "--dry-run"), /not both/);
    assert.throws(() => op("send", "--build", "3011", "--campaign", "Upload Loop", "--file", file), /--campaign/);
    assert.throws(() => op("send", "--campaign", "upload-loop-fix", "--file", file), /Usage/);
    fs.writeFileSync(file, "x".repeat(1001));
    assert.throws(() => op("send", "--build", "3011", "--campaign", "upload-loop-fix", "--file", file), /at most 1000/);
    const list = op("list", "--campaign", "upload-loop-fix");
    assert.equal(list.method, "GET");
    assert.equal(list.path, "/cli/admin/build-messages?campaign=upload-loop-fix");
    assert.throws(() => op("delete"), /Usage/);
  }));

test("build-message --manifest: one message per build, text or file, flags not mixed", () =>
  withDir((dir) => {
    const manifest = path.join(dir, "messages.json");
    fs.writeFileSync(path.join(dir, "2885.md"), "From a file.\n");
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        campaign: "upload-loop-fix",
        messages: [
          { buildId: 3011, ownerUserId: 7977, ownerUsername: "dew", title: "44class-survival", text: "Inline." },
          { buildId: 2885, ownerUserId: 10513, file: "2885.md" },
        ],
      }),
    );
    const batch = op("send", "--manifest", manifest);
    assert.equal(batch.campaign, "upload-loop-fix");
    assert.deepEqual(
      batch.messages.map((m) => [m.buildId, m.expectedOwnerUserId, m.text]),
      [
        [3011, 7977, "Inline."],
        [2885, 10513, "From a file."],
      ],
    );
    assert.throws(() => op("send", "--manifest", manifest, "--build", "1"), /drop --build/);
    fs.writeFileSync(manifest, JSON.stringify({ campaign: "upload-loop-fix", messages: [{ buildId: 1, text: "a" }, { buildId: 1, text: "b" }] }));
    assert.throws(() => op("send", "--manifest", manifest), /appears twice/);
    fs.writeFileSync(manifest, JSON.stringify({ campaign: "upload-loop-fix", messages: [{ buildId: 1, text: "a", file: "x.md" }] }));
    assert.throws(() => op("send", "--manifest", manifest), /exactly one of/);
  }));

test("the batch dry run previews every message and sends no idempotency key; a refusal does not stop the batch", async () => {
  const previous = process.exitCode;
  try {
    const operation = {
      name: "build-message.send.preview",
      path: "/cli/admin/build-messages",
      campaign: "upload-loop-fix",
      dryRun: true,
      messages: [
        { buildId: 1, expectedOwnerUserId: 11, text: "One.", title: "A" },
        { buildId: 2, expectedOwnerUserId: null, text: "Two.", title: "B" },
      ],
    };
    const calls = [];
    const result = await runBuildMessageWorkflow({
      options: { apiUrl: "http://api.test" },
      operation,
      authToken: "t",
      request: async (req) => {
        calls.push(req);
        return req.body.buildId === 1
          ? { ok: true, status: "success", data: { dryRun: true, action: "would_send", build: { id: 1, title: "A", ownerUserId: 11, ownerUsername: "ann" }, contentChars: 4, carryOver: { replaces: [] }, refusals: [] } }
          : { ok: false, status: "validation_error", error: { code: "CLI_ADMIN_BUILD_MESSAGE_RUN_ACTIVE", message: "Lumine is working on build 2 right now." } };
      },
    });
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.body.dryRun, true);
      assert.deepEqual(call.headers, {});
      assert.equal(call.url, "http://api.test/cli/admin/build-messages");
    }
    assert.deepEqual(calls[0].body, { buildId: 1, campaign: "upload-loop-fix", content: "One.", expectedOwnerUserId: 11, dryRun: true });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.data.summary, { wouldSend: 1, alreadySent: 0, refused: 1 });
    const lines = formatBuildMessageResult({ operation, data: result.data }).join("\n");
    assert.match(lines, /build 1 "A" → ann \(user 11\): would send/);
    assert.match(lines, /\| One\./);
    assert.match(lines, /build 2 .*refused: Lumine is working/);
    assert.match(lines, /Nothing was written/);
  } finally {
    process.exitCode = previous;
  }
});

test("a confirmed send keys each request by campaign, build and text, so a re-run replays instead of re-posting", async () => {
  const operation = {
    name: "build-message.send",
    path: "/cli/admin/build-messages",
    campaign: "upload-loop-fix",
    dryRun: false,
    messages: [{ buildId: 3011, expectedOwnerUserId: 7977, text: "Fixed." }],
  };
  const keys = [];
  const send = () =>
    runBuildMessageWorkflow({
      options: { apiUrl: "http://api.test" },
      operation,
      authToken: "t",
      request: async (req) => {
        keys.push(req.headers["x-lumine-idempotency-key"]);
        assert.equal(req.body.dryRun, false);
        return { ok: true, status: "success", data: { sent: true, receipt: { messageId: 9, receiptId: 1 }, build: { ownerUserId: 7977 } } };
      },
    });
  const first = await send();
  await send();
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], buildMessageRequestKey({ campaign: "upload-loop-fix", buildId: 3011, text: "Fixed." }));
  assert.match(keys[0], /^[A-Za-z0-9._:-]{8,80}$/);
  assert.deepEqual(first.data.summary, { sent: 1, alreadySent: 0, refused: 0 });
  assert.notEqual(buildMessageRequestKey({ campaign: "upload-loop-fix", buildId: 3011, text: "Edited." }), keys[0]);
});
