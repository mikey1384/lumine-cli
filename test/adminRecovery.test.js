import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { requestJson } from "../lib/http.js";
import { testWorkRoot } from "./helpers/work-directory.js";
import {
  runAdmin,
  waitForReportServer,
  reportServe,
} from "../lib/admin-daily.js";
import { prepareAdminMutationIntent } from "../lib/admin-request-intents.js";
import {
  createDailyReviewState,
  summarizeDailyProgress,
} from "../lib/admin-duties.js";
import { assertAuthScope } from "../lib/auth.js";
import {
  acquireCheckpointLock,
  releaseCheckpointLock,
  migrateLegacyCheckpoint,
} from "../lib/admin-workflows.js";

const root = testWorkRoot();
function fixture(t) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(root, "recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function reference(dir, file) {
  const bytes = fs.readFileSync(path.join(dir, file));
  return {
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const receipt = { ok: true, status: "success", data: { value: 1 } };

test("an unfinished command with no handles exits nonzero instead of silent success", (t) => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.copyFileSync(
    fileURLToPath(new URL("../bin/lumine.js", import.meta.url)),
    path.join(dir, "bin/lumine.js"),
  );
  fs.writeFileSync(
    path.join(dir, "lib/commands.js"),
    "export async function main(){await new Promise(()=>{});}",
  );
  fs.writeFileSync(
    path.join(dir, "lib/admin.js"),
    "export const isAdminJsonInvocation=()=>true; export const formatAdminJsonError=e=>({ok:false});",
  );
  const child = spawnSync(process.execPath, [path.join(dir, "bin/lumine.js")], {
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 13);
  assert.equal(child.stdout, "");
});

test("HTTP success without a JSON value remains an unconfirmed outcome", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const text of ["", "null", "broken", "false"]) {
    globalThis.fetch = async () => new Response(text, { status: 200 });
    await assert.rejects(
      requestJson({ url: "https://fixture.invalid", timeoutMs: 1000 }),
      { code: "lumine_http_invalid_response" },
    );
  }
  globalThis.fetch = async () => Response.json(receipt);
  assert.deepEqual(
    await requestJson({ url: "https://fixture.invalid", timeoutMs: 1000 }),
    receipt,
  );
});

test("a fresh stdout receipt and matching output file are both required; stale files cannot mask a failed child", (t) => {
  const dir = fixture(t);
  const outputFile = path.join(dir, "report.json");
  fs.writeFileSync(outputFile, JSON.stringify(receipt));
  let calls = 0;
  const spawnImpl = (_exe, args) => {
    calls++;
    assert.ok(args.includes("--no-update-check"));
    if (calls === 1) return { status: 0, stdout: "", stderr: "" };
    const fresh = args[args.indexOf("--output") + 1];
    assert.notEqual(fresh, outputFile);
    fs.writeFileSync(fresh, JSON.stringify(receipt));
    return { status: 0, stdout: JSON.stringify(receipt) };
  };
  const result = runAdmin(["energy-budget"], {
    outputFile,
    retryRead: true,
    spawnImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.recovered, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile)), receipt);
  const missing = runAdmin(["energy-budget"], {
    outputFile,
    spawnImpl: () => ({ status: 0, stdout: JSON.stringify(receipt) }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.json.error.code, "CLI_ADMIN_OUTPUT_MISSING");
});

test("mutations never auto-retry a missing child receipt", () => {
  let calls = 0;
  const result = runAdmin(["subject", "effort", "123", "--level", "1"], {
    retryRead: true,
    spawnImpl: () => {
      calls++;
      return { status: 0, stdout: "" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("child JSON without a canonical status cannot count as successful collection", () => {
  const result = runAdmin(["energy-budget"], { spawnImpl: () => ({ status: 0, stdout: '{"ok":true}' }) });
  assert.equal(result.ok, false);
  assert.equal(result.json.status, "unconfirmed");
});

test("an interrupted mutation reuses its saved key within its exact authority and body until a canonical receipt is delivered", (t) => {
  const directory = fixture(t);
  const input = {
    operation: {
      name: "subject.effort.set",
      method: "POST",
      path: "/subject/12/effort",
      body: { level: 1 },
    },
    apiUrl: "https://fixture.invalid",
    authority: { account: 5, runId: 107 },
    directory,
  };
  const first = prepareAdminMutationIntent(input);
  const replay = prepareAdminMutationIntent(input);
  assert.equal(first.requestId, replay.requestId);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assert.notEqual(
    prepareAdminMutationIntent({
      ...input,
      authority: { account: 5, runId: 108 },
    }).requestId,
    first.requestId,
  );
  assert.notEqual(
    prepareAdminMutationIntent({
      ...input,
      operation: { ...input.operation, body: { level: 2 } },
    }).requestId,
    first.requestId,
  );
  assert.throws(() => first.confirm({ ok: true }), {
    code: "CLI_ADMIN_RECEIPT_INVALID",
  });
  assert.equal(prepareAdminMutationIntent(input).requestId, first.requestId);
  first.confirm(receipt);
  first.delivered();
  replay.delivered(); // concurrent confirmations cannot turn success into ENOENT
  assert.ok(fs.existsSync(first.receiptPath));
  assert.notEqual(prepareAdminMutationIntent(input).requestId, first.requestId);
});

test("refreshing a login retains the canonical account used by mutation recovery", async (t) => {
  const directory = fixture(t);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({ userId: 5, scopes: ["build:write"] });
  const keys = [];
  for (const token of ["old-login", "refreshed-login"]) {
    const session = await assertAuthScope({
      options: { apiUrl: "https://fixture.invalid", timeoutMs: 1000 },
      auth: { token },
      scope: "build:write",
    });
    keys.push(
      prepareAdminMutationIntent({
        operation: {
          name: "todo.update",
          method: "PATCH",
          path: "/todos/1",
          body: { status: "in_progress" },
        },
        apiUrl: "https://fixture.invalid",
        authority: { account: session.userId, runId: 107 },
        directory,
      }).requestId,
    );
  }
  assert.equal(keys[0], keys[1]);
});

test("legacy migration uses a durable destination lock and preserves the original checkpoint and spool", (t) => {
  const directory = fixture(t);
  const old = path.join(directory, "legacy.json");
  const oldSpool = `${old}.candidates-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.ndjson`;
  const keyedPath = path.join(directory, "durable", "current.json");
  fs.writeFileSync(oldSpool, '{"id":1}\n');
  fs.writeFileSync(old, JSON.stringify({ spoolPath: oldSpool, pages: 1 }));
  const lock = acquireCheckpointLock(keyedPath, "fingerprint");
  assert.throws(
    () =>
      migrateLegacyCheckpoint({
        old,
        keyedPath,
        operationFingerprint: "fingerprint",
      }),
    /owns checkpoint/,
  );
  assert.equal(fs.existsSync(keyedPath), false);
  releaseCheckpointLock(lock);
  migrateLegacyCheckpoint({
    old,
    keyedPath,
    operationFingerprint: "fingerprint",
  });
  const saved = JSON.parse(fs.readFileSync(keyedPath));
  assert.ok(saved.spoolPath.startsWith(`${keyedPath}.candidates-`));
  assert.equal(
    fs.readFileSync(saved.spoolPath, "utf8"),
    fs.readFileSync(oldSpool, "utf8"),
  );
  assert.equal(fs.statSync(saved.spoolPath).mode & 0o777, 0o600);
  migrateLegacyCheckpoint({
    old,
    keyedPath,
    operationFingerprint: "fingerprint",
  });
  assert.equal(
    JSON.parse(fs.readFileSync(keyedPath)).spoolPath,
    saved.spoolPath,
  );
  assert.equal(JSON.parse(fs.readFileSync(old)).spoolPath, oldSpool);
});

test("fetched data, read acknowledgments, effort mutations and browser duties remain independent of a completed run lease", (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, "input.json"), '{"rows":[1]}');
  const state = createDailyReviewState(dir, {
    steps: [{ ok: true, file: "input.json" }],
    botOutput: { complete: false },
  });
  assert.equal(summarizeDailyProgress(dir, state).reading.read, 0);
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({
      ok: true,
      status: "success",
      data: {
        report: {
          run: { id: 107, status: "completed" },
          mutations: {
            byAction: [
              {
                action: "subject.effort.set",
                attempts: 9,
                completed: 7,
                changed: 7,
                failed: 2,
                pending: 0,
              },
            ],
          },
        },
      },
    }),
  );
  const reading = {
    ...reference(dir, "input.json"),
    complete: true,
    readAt: new Date().toISOString(),
  };
  const evidence = {
    protocol: 1,
    runId: 107,
    runReport: reference(dir, "run.json"),
    reading: [reading],
    duties: [
      {
        id: "effort-levels",
        status: "completed",
        evidence: [reference(dir, "run.json")],
      },
    ],
  };
  const progress = summarizeDailyProgress(dir, state, evidence);
  assert.equal(progress.effortAssignments.changed, 7);
  assert.equal(progress.effortAssignments.failed, 2);
  assert.equal(progress.canonicalRun.status, "completed");
  assert.equal(progress.reading.read, 1);
  assert.equal(progress.complete, false);
  assert.equal(progress.scope, "collection");
  assert.equal(progress.coverageBasis, "declared sources and duties only");
  assert.deepEqual(progress.incompleteDuties, ["report-browser"]);
  fs.writeFileSync(path.join(dir, "input.json"), '{"rows":[2]}');
  assert.equal(summarizeDailyProgress(dir, state, evidence).reading.read, 0);
  const regathered = createDailyReviewState(dir, { steps: [{ ok: true, file: "input.json" }], botOutput: { complete: false } },
    { ...state, scope: "full", requiredDuties: [...state.requiredDuties, "carryover-70"] });
  assert.equal(regathered.scope, "full");
  assert.ok(regathered.requiredDuties.includes("carryover-70"));
  assert.equal(summarizeDailyProgress(dir, regathered, evidence).complete, false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.pid = 123;
  child.kills = 0;
  child.kill = () => {
    child.kills++;
  };
  child.unref = () => {};
  return child;
}
test("report startup failures stop their own child and valid readiness still leaves browser verification pending", async (t) => {
  const child = fakeChild();
  await assert.rejects(waitForReportServer(child, 10), /deadline/);
  assert.equal(child.kills, 1);
  const invalid = fakeChild();
  const started = waitForReportServer(invalid);
  invalid.stdout.write(
    '{"ok":true,"status":"success","data":{"url":"https://external.invalid"}}\n',
  );
  await assert.rejects(started, /invalid startup/);
  assert.equal(invalid.kills, 1);
  const dir = fixture(t);
  const file = path.join(dir, "report.md");
  fs.writeFileSync(file, "# Report\n\n## Complete section\n\nEvidence.");
  const valid = fakeChild();
  const output = reportServe(
    { adminFile: file, adminOpen: true },
    {
      spawnImpl: (_exe, args) => {
        assert.ok(args.includes("--no-update-check"));
        setImmediate(() =>
          valid.stdout.write(
            '{"ok":true,"status":"success","data":{"url":"http://127.0.0.1:1234/"}}\n',
          ),
        );
        return valid;
      },
      openImpl: () => ({ status: 1 }),
    },
  );
  const result = await output;
  assert.equal(result.ok, true);
  assert.equal(result.data.opened, false);
  assert.equal(result.data.browserVerification.navigation, "pending");
});
