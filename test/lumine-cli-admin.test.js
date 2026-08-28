import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  adminCommand,
  assertComposedCommentDraftResult,
  assertAdminTodoHandoffResult,
  assertRecommendationWindowResult,
  filterListResultByOperatorView,
  filterRecommendationQueueResult,
  formatAdminJsonError,
  normalizeAdminBuildCandidatesResult,
  parseAdminOperation,
  parseOperatorViewFilter,
  parseRecommendationContentTypes,
  parseRecommendationWindow,
  parseRecommendationTarget,
  resolveOperatorViewFilter,
} from "../lib/admin.js";
import {
  createNewsEditorialScaffold,
  readAdminJsonFile,
  validateNewsEditorial,
  writeAdminJsonFile,
} from "../lib/admin-news.js";
import {
  getPaginatedResultStorage,
  readBatchSkipTargets,
  runAutomaticPagination,
  writePaginatedResultJson,
} from "../lib/admin-workflows.js";
import { parseBuildReviewReceipt } from "../lib/build-review.js";
import { parseArgs } from "../lib/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

async function materializePaginatedResult(result) {
  let json = "";
  await writePaginatedResultJson({
    result,
    write: async (chunk) => {
      json += chunk;
    },
  });
  return JSON.parse(json);
}

function legacyPaginationFingerprint({ runId, operation, apiUrl = "" }) {
  const requestUrl = new URL(operation.path, "https://lumine.invalid");
  requestUrl.searchParams.delete("cursor");
  return createHash("sha256")
    .update(
      JSON.stringify({
        workflowSchemaVersion: 2,
        runId,
        apiUrl: String(apiUrl).replace(/\/$/, ""),
        name: operation.name,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        pagination: {
          collectionKey: operation.pagination.collectionKey,
          coverageQueue: operation.pagination.coverageQueue || null,
          coverageMode: operation.pagination.coverageMode || null,
          after: operation.pagination.after ?? null,
          filters: operation.pagination.filters || {},
        },
      }),
    )
    .digest("hex");
}

test("admin parsing preserves opaque cursors and explicit noninteractive flags", () => {
  const options = parseArgs([
    "admin",
    "subjects",
    "list",
    "--cursor",
    "eyJ2ZXJzaW9uIjoxfQ",
    "--after",
    "2026-08-01T00:00:00Z",
    "--effort",
    "unassigned",
    "--json",
  ]);
  assert.equal(options.command, "admin");
  assert.equal(options.adminCursor, "eyJ2ZXJzaW9uIjoxfQ");
  assert.equal(options.adminAfter, "2026-08-01T00:00:00Z");
  assert.equal(options.adminEffort, "unassigned");
  assert.equal(options.json, true);
  assert.match(parseAdminOperation(options).path, /cursor=eyJ2ZXJzaW9uIjoxfQ/);
});

test("recommendation content filters exclude AI Stories without changing pagination", () => {
  const options = parseArgs([
    "admin",
    "recommendations",
    "list",
    "--content-types",
    "comment,dailyReflection",
  ]);
  assert.deepEqual(parseRecommendationContentTypes(options.adminContentTypes), [
    "comment",
    "dailyReflection",
  ]);
  assert.match(
    parseAdminOperation(options).path,
    /contentTypes=comment%2CdailyReflection/,
  );
  assert.throws(
    () => parseRecommendationContentTypes("comment,subject"),
    /accepts comment, aiStory, and dailyReflection/,
  );
  const result = filterRecommendationQueueResult({
    result: {
      ok: true,
      status: "success",
      data: {
        items: [
          { contentType: "comment", contentId: 1 },
          { contentType: "aiStory", contentId: 2 },
          { contentType: "dailyReflection", contentId: 3 },
        ],
        pagination: { nextCursor: "opaque", exhausted: false },
      },
    },
    contentTypes: ["comment", "dailyReflection"],
  });
  assert.deepEqual(
    result.data.items.map((item) => item.contentId),
    [1, 3],
  );
  assert.equal(result.data.pagination.nextCursor, "opaque");
  assert.deepEqual(result.data.clientFilter, {
    contentTypes: ["comment", "dailyReflection"],
    excludedItems: 1,
  });
});

test("recommendation scans default to the run window and require explicit legacy scope", () => {
  const current = parseArgs(["admin", "recommendations", "list", "--all"]);
  assert.equal(parseRecommendationWindow(current).mode, "since-run");
  assert.match(parseAdminOperation(current).path, /sinceRun=true/);
  assert.equal(current.adminAll, true);

  const bounded = parseArgs([
    "admin",
    "recommendations",
    "list",
    "--after",
    "2026-08-14T00:00:00Z",
    "--checkpoint",
    "/tmp/recommendations.json",
    "--resume",
  ]);
  assert.equal(parseRecommendationWindow(bounded).mode, "after");
  assert.match(
    parseAdminOperation(bounded).path,
    /after=2026-08-14T00%3A00%3A00Z/,
  );
  assert.equal(bounded.adminResume, true);

  const legacy = parseArgs([
    "admin",
    "recommendations",
    "list",
    "--include-legacy",
  ]);
  assert.equal(parseRecommendationWindow(legacy).mode, "legacy");
  assert.match(parseAdminOperation(legacy).path, /includeLegacy=true/);
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "recommendations",
          "list",
          "--since-run",
          "--include-legacy",
        ]),
      ),
    /Choose one recommendation window/,
  );

  const operation = parseAdminOperation(current);
  assert.doesNotThrow(() =>
    assertRecommendationWindowResult({
      operation,
      result: {
        data: {
          pagination: {
            after: 1_723_680_000,
            snapshotTimeStamp: 1_723_680_100,
          },
        },
      },
    }),
  );
  assert.throws(
    () =>
      assertRecommendationWindowResult({
        operation,
        result: { data: { pagination: { exhausted: false } } },
      }),
    /did not confirm the bounded recommendation window/,
  );
});

test("delegated identity and daily-run parsing keeps comment permission run-local", () => {
  const start = parseArgs([
    "admin",
    "daily-run",
    "start",
    "--identity",
    "auto",
    "--comment-mode",
    "post",
    "--run-key",
    "daily:2026-08-06:test",
  ]);
  assert.deepEqual(parseAdminOperation(start), {
    name: "daily-run.start",
    method: "POST",
    path: "/cli/admin/daily-runs/start",
    body: {
      identity: "auto",
      commentMode: "post",
      runKey: "daily:2026-08-06:test",
    },
    mutates: true,
  });

  const nextRun = parseArgs(["admin", "daily-run", "start"]);
  assert.equal(parseAdminOperation(nextRun).body.commentMode, "off");
  assert.equal(parseAdminOperation(nextRun).body.identity, undefined);

  assert.equal(
    parseAdminOperation(parseArgs(["admin", "daily-run", "report"])).path,
    "/cli/admin/daily-runs/report",
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "daily-run",
        "escalation",
        "add",
        "--target",
        "https://www.twin-kle.com/comments/44",
        "--note",
        "Public contact details need owner review.",
        "--severity",
        "urgent",
      ]),
    ),
    {
      name: "daily-run.escalation.add",
      method: "POST",
      path: "/cli/admin/daily-runs/escalations",
      body: {
        targetType: "comment",
        targetId: 44,
        url: "https://www.twin-kle.com/comments/44",
        summary: "Public contact details need owner review.",
        severity: "urgent",
      },
      mutates: true,
    },
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "daily-run",
        "escalation",
        "add",
        "--target",
        "chatMessage:3768159",
        "--note",
        "Concrete safety issue in a bot-authored chat message.",
      ]),
    ).body,
    {
      targetType: "chatMessage",
      targetId: 3768159,
      url: undefined,
      summary: "Concrete safety issue in a bot-authored chat message.",
      severity: "attention",
    },
  );
});

test("private identity inspection requires a reason and makes raw evidence explicit", () => {
  const minimized = parseAdminOperation(
    parseArgs([
      "admin",
      "identity",
      "inspect",
      "Jay1216",
      "--reason",
      "Confirm the account family before updating its quota bucket.",
    ]),
  );
  assert.deepEqual(minimized, {
    name: "identity.inspect",
    method: "POST",
    path: "/cli/admin/identity/inspect",
    body: {
      target: "Jay1216",
      reason: "Confirm the account family before updating its quota bucket.",
      includePrivateEvidence: false,
    },
    mutates: true,
  });
  const privateEvidence = parseAdminOperation(
    parseArgs([
      "admin",
      "identity",
      "inspect",
      "42",
      "--reason",
      "DOB and email evidence are required for this owner decision.",
      "--include-private-evidence",
    ]),
  );
  assert.equal(privateEvidence.body.includePrivateEvidence, true);
  assert.equal(
    parseAdminOperation(
      parseArgs([
        "admin",
        "identity",
        "inspect",
        "42",
        "--reason",
        "Minimized evidence is sufficient.",
        "--include-private-evidence=false",
      ]),
    ).body.includePrivateEvidence,
    false,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "identity", "inspect", "Jay1216"]),
      ),
    /--reason/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "identity",
          "inspect",
          "Jay1216",
          "--reason",
          "x".repeat(501),
        ]),
      ),
    /at most 500 characters/,
  );
});

test("private economy and rescue investigations are bounded and reason-required", () => {
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "economy",
        "trace",
        "lock",
        "--days",
        "3",
        "--reason",
        "Investigate the anomalous three-day coin gain.",
      ]),
    ),
    {
      name: "economy.trace",
      method: "POST",
      path: "/cli/admin/economy/trace",
      body: {
        target: "lock",
        reason: "Investigate the anomalous three-day coin gain.",
        days: 3,
      },
      mutates: true,
    },
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "rescue",
        "wordle-audit",
        "--reason",
        "Identify lapsed launch offers and their streak lengths.",
      ]),
    ).body,
    {
      reason: "Identify lapsed launch offers and their streak lengths.",
      days: 30,
    },
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "economy", "trace", "lock"])),
    /--reason/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "rescue",
          "wordle-audit",
          "--reason",
          "Required audit reason.",
          "--days",
          "31",
        ]),
      ),
    /integer 1-30/,
  );
});

test("escalation lifecycle commands map to run-independent private routes", () => {
  assert.deepEqual(
    parseAdminOperation(parseArgs(["admin", "escalation", "list"])),
    {
      name: "escalation.list",
      method: "GET",
      path: "/cli/admin/escalations?status=open&limit=50",
      body: undefined,
      mutates: false,
    },
  );
  assert.match(
    parseAdminOperation(
      parseArgs([
        "admin",
        "escalation",
        "list",
        "--status",
        "resolved",
        "--limit",
        "50",
      ]),
    ).path,
    /status=resolved&limit=50/,
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "escalation",
        "set",
        "123",
        "--status",
        "resolved",
        "--note",
        "No user fault; this audit concerned the bot response.",
      ]),
    ),
    {
      name: "escalation.set",
      method: "PUT",
      path: "/cli/admin/escalations/123",
      body: {
        status: "resolved",
        note: "No user fault; this audit concerned the bot response.",
      },
      mutates: true,
    },
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "escalation",
          "set",
          "123",
          "--status",
          "closed",
          "--note",
          "Done.",
        ]),
      ),
    /--status must be/,
  );
});

test("todo lifecycle carries experiments between runs without requiring a public bot", () => {
  assert.deepEqual(parseAdminOperation(parseArgs(["admin", "todo", "list"])), {
    name: "todo.list",
    method: "GET",
    path: "/cli/admin/todos?status=pending&limit=50",
    body: undefined,
    mutates: false,
  });
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "todo",
        "add",
        "--kind",
        "experiment",
        "--status",
        "in_progress",
        "--title",
        "Validate Zero/Ciel cost optimization",
        "--note",
        "Replay baseline and optimized replies; complete only after response-quality parity.",
      ]),
    ),
    {
      name: "todo.add",
      method: "POST",
      path: "/cli/admin/todos",
      body: {
        kind: "experiment",
        title: "Validate Zero/Ciel cost optimization",
        details:
          "Replay baseline and optimized replies; complete only after response-quality parity.",
        status: "in_progress",
      },
      mutates: true,
    },
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "todo",
        "update",
        "12",
        "--status",
        "blocked",
        "--note",
        "Waiting for a full completed UTC cost bucket and parity replay.",
      ]),
    ),
    {
      name: "todo.update",
      method: "PUT",
      path: "/cli/admin/todos/12",
      body: {
        status: "blocked",
        note: "Waiting for a full completed UTC cost bucket and parity replay.",
      },
      mutates: true,
    },
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "todo", "add", "--title", "Missing handoff"]),
      ),
    /--note/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "todo",
          "update",
          "12",
          "--status",
          "done",
          "--note",
          "Finished.",
        ]),
      ),
    /--status must be/,
  );

  assert.deepEqual(
    assertAdminTodoHandoffResult({
      data: {
        run: { id: 31 },
        carryoverTodos: {
          items: [{ id: 12, status: "in_progress" }],
          count: 1,
          surfacedForRunId: 31,
          newlySurfacedCount: 1,
        },
      },
    }).items,
    [{ id: 12, status: "in_progress" }],
  );
  assert.throws(
    () => assertAdminTodoHandoffResult({ data: { run: { id: 31 } } }),
    /did not confirm the canonical carry-over todo handoff/,
  );
});

test("AI bucket account batches are explicit, bounded, and run-independent", async (t) => {
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "ai-bucket",
        "create",
        "--label",
        "Lemon",
        "--note",
        "Quota accounting only; not moderation.",
      ]),
    ),
    {
      name: "ai-bucket.create",
      method: "POST",
      path: "/cli/admin/ai-buckets",
      body: {
        label: "Lemon",
        note: "Quota accounting only; not moderation.",
      },
      mutates: true,
    },
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "ai-bucket", "create"])),
    /--label/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "ai-bucket", "create", "--label", "Lemon"]),
      ),
    /--note/,
  );

  const operation = parseAdminOperation(
    parseArgs([
      "admin",
      "ai-bucket",
      "accounts",
      "add",
      "--bucket-id",
      "10",
      "--user-ids",
      "3127,13037,15410",
      "--note",
      "operator-confirmed account family",
    ]),
  );
  assert.deepEqual(operation, {
    name: "ai-bucket.accounts.add",
    method: "POST",
    path: "/cli/admin/ai-buckets/10/accounts",
    body: {
      userIds: [3127, 13037, 15410],
      note: "operator-confirmed account family",
    },
    mutates: true,
  });
  assert.equal(
    parseAdminOperation(
      parseArgs(["admin", "ai-bucket", "get", "--bucket-id", "10"]),
    ).path,
    "/cli/admin/ai-buckets/10",
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "ai-bucket",
        "note",
        "set",
        "--bucket-id",
        "10",
        "--note",
        "Quota accounting only; not moderation.",
      ]),
    ),
    {
      name: "ai-bucket.note.set",
      method: "PUT",
      path: "/cli/admin/ai-buckets/10/note",
      body: { note: "Quota accounting only; not moderation." },
      mutates: true,
    },
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "ai-bucket",
          "accounts",
          "add",
          "--bucket-id",
          "10",
          "--user-ids",
          "3127,3127",
        ]),
      ),
    /must be unique/,
  );

  const fixture = await createFixtureServer(t);
  const createResult = await runCli([
    "admin",
    "ai-bucket",
    "create",
    "--label",
    "Lemon",
    "--note",
    "Quota accounting only; not moderation.",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(createResult.code, 0, createResult.stderr);
  assert.equal(
    fixture.requests.some(
      (request) => request.url === "/cli/admin/daily-runs/status",
    ),
    false,
  );
  const createRequest = fixture.requests.find(
    (entry) => entry.url === "/cli/admin/ai-buckets",
  );
  assert.deepEqual(createRequest?.body, {
    label: "Lemon",
    note: "Quota accounting only; not moderation.",
  });
  assert.equal(createRequest?.runId, null);
  assert.match(createRequest?.requestId, /^cli:[0-9a-f-]{36}$/);

  const result = await runCli([
    "admin",
    "ai-bucket",
    "accounts",
    "add",
    "--bucket-id",
    "10",
    "--user-ids",
    "3127,13037,15410",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    fixture.requests.some(
      (request) => request.url === "/cli/admin/daily-runs/status",
    ),
    false,
  );
  const request = fixture.requests.find(
    (entry) => entry.url === "/cli/admin/ai-buckets/10/accounts",
  );
  assert.deepEqual(request?.body, {
    userIds: [3127, 13037, 15410],
  });
  assert.equal(request?.runId, null);
  assert.match(request?.requestId, /^cli:[0-9a-f-]{36}$/);

  const noteResult = await runCli([
    "admin",
    "ai-bucket",
    "note",
    "set",
    "--bucket-id",
    "10",
    "--note",
    "Quota accounting only; not moderation.",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(noteResult.code, 0, noteResult.stderr);
  const noteRequest = fixture.requests.find(
    (entry) => entry.url === "/cli/admin/ai-buckets/10/note",
  );
  assert.deepEqual(noteRequest?.body, {
    note: "Quota accounting only; not moderation.",
  });
  assert.equal(noteRequest?.runId, null);
  assert.match(noteRequest?.requestId, /^cli:[0-9a-f-]{36}$/);
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "ai-bucket", "note", "set", "--bucket-id", "10"]),
      ),
    /--note/,
  );
});

test("identity, escalation, notable, and todo bookkeeping do not open a daily run", async (t) => {
  const fixture = await createFixtureServer(t);
  const commands = [
    [
      "admin",
      "identity",
      "inspect",
      "Jay1216",
      "--reason",
      "Confirm the account family before updating its quota bucket.",
      "--include-private-evidence",
      "--json",
    ],
    [
      "admin",
      "notable",
      "add",
      "Duck61004",
      "--note",
      "Approved after the daily report closed.",
      "--json",
    ],
    ["admin", "escalation", "list", "--status", "all", "--json"],
    [
      "admin",
      "escalation",
      "set",
      "123",
      "--status",
      "resolved",
      "--note",
      "No user fault; this audit concerned the bot response.",
      "--json",
    ],
    ["admin", "todo", "list", "--json"],
    [
      "admin",
      "todo",
      "add",
      "--kind",
      "experiment",
      "--status",
      "in_progress",
      "--title",
      "Validate Zero/Ciel cost optimization",
      "--note",
      "Complete only after response-quality parity is demonstrated.",
      "--json",
    ],
    [
      "admin",
      "todo",
      "update",
      "12",
      "--status",
      "blocked",
      "--note",
      "Waiting for tomorrow's complete cost bucket.",
      "--json",
    ],
  ];
  for (const command of commands) {
    const result = await runCli([...command, ...fixture.cliArgs]);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(
    fixture.requests.some(
      (request) => request.url === "/cli/admin/daily-runs/status",
    ),
    false,
  );
  const inspection = fixture.requests.find(
    (request) => request.url === "/cli/admin/identity/inspect",
  );
  assert.deepEqual(inspection?.body, {
    target: "Jay1216",
    reason: "Confirm the account family before updating its quota bucket.",
    includePrivateEvidence: true,
  });
  assert.equal(inspection?.runId, null);
  assert.match(inspection?.requestId, /^cli:[0-9a-f-]{36}$/);
  const notable = fixture.requests.find(
    (request) => request.url === "/cli/admin/notable-users",
  );
  assert.equal(notable?.runId, null);
  const escalationList = fixture.requests.find(
    (request) => request.url === "/cli/admin/escalations?status=all&limit=50",
  );
  assert.equal(escalationList?.runId, null);
  assert.equal(escalationList?.requestId, null);
  const disposition = fixture.requests.find(
    (request) => request.url === "/cli/admin/escalations/123",
  );
  assert.deepEqual(disposition?.body, {
    status: "resolved",
    note: "No user fault; this audit concerned the bot response.",
  });
  assert.equal(disposition?.runId, null);
  assert.match(disposition?.requestId, /^cli:[0-9a-f-]{36}$/);
  const todoList = fixture.requests.find(
    (request) => request.url === "/cli/admin/todos?status=pending&limit=50",
  );
  assert.equal(todoList?.runId, null);
  assert.equal(todoList?.requestId, null);
  const todoCreate = fixture.requests.find(
    (request) => request.url === "/cli/admin/todos",
  );
  assert.equal(todoCreate?.runId, null);
  assert.match(todoCreate?.requestId, /^cli:[0-9a-f-]{36}$/);
  const todoUpdate = fixture.requests.find(
    (request) => request.url === "/cli/admin/todos/12",
  );
  assert.equal(todoUpdate?.runId, null);
  assert.match(todoUpdate?.requestId, /^cli:[0-9a-f-]{36}$/);
});

test("skip and audit commands map to stable API contracts", () => {
  const skip = parseAdminOperation(
    parseArgs([
      "admin",
      "post",
      "skip",
      "dailyReflection:99",
      "--reason",
      "one-line answer",
      "--json",
    ]),
  );
  assert.equal(skip.name, "post.skip");
  assert.equal(skip.method, "POST");
  assert.equal(skip.path, "/cli/admin/skips/dailyReflection/99");
  assert.deepEqual(skip.body, { reason: "one-line answer" });
  assert.equal(skip.mutates, true);
  assert.equal(
    parseAdminOperation(parseArgs(["admin", "post", "skip", "comment:456"]))
      .body.reason,
    undefined,
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "post", "skip", "123"])),
    /effort assignment/,
  );

  const audit = parseAdminOperation(
    parseArgs([
      "admin",
      "audit",
      "list",
      "--run",
      "current",
      "--target",
      "dailyReflection:99",
      "--actions",
      "recommendation.skip",
      "--limit",
      "50",
      "--full",
      "--json",
    ]),
  );
  assert.equal(audit.name, "audit.list");
  assert.equal(audit.mutates, false);
  assert.match(audit.path, /^\/cli\/admin\/audit\?/);
  assert.match(audit.path, /run=current/);
  assert.match(audit.path, /target=dailyReflection%3A99/);
  assert.match(audit.path, /actions=recommendation\.skip/);
  assert.match(audit.path, /full=true/);
  assert.match(
    parseAdminOperation(parseArgs(["admin", "audit"])).path,
    /^\/cli\/admin\/audit\?limit=\d+$/,
  );
  assert.match(
    parseAdminOperation(parseArgs(["admin", "audit", "list", "--run", "12"]))
      .path,
    /run=12/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "audit", "list", "--run", "yesterday"]),
      ),
    /--run must be an integer/,
  );
});

test("new subject, featured, reward, and comment commands map to stable API contracts", () => {
  assert.equal(
    parseAdminOperation(
      parseArgs(["admin", "subject", "comments", "42", "--cursor", "opaque"]),
    ).path,
    "/cli/admin/subjects/42/comments?cursor=opaque&limit=50",
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs(["admin", "featured", "reorder", "--subject-ids", "3,2,1"]),
    ).body,
    { ids: [3, 2, 1] },
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs(["admin", "post", "reward", "comment:9", "--twinkles", "3"]),
    ),
    {
      name: "post.reward",
      method: "POST",
      path: "/cli/admin/rewards/comment/9",
      body: { twinkles: 3 },
      mutates: true,
    },
  );
  // A bare numeric draft target still means the subject, exactly as before
  // the target model existed.
  assert.deepEqual(
    parseAdminOperation(
      parseArgs(["admin", "comment", "draft", "42", "--identity", "ciel"]),
    ).body,
    { targetType: "subject", targetId: 42, identity: "ciel" },
  );
  assert.equal(
    parseAdminOperation(
      parseArgs(["admin", "comment", "post", "--draft-id", "77"]),
    ).path,
    "/cli/admin/comment-drafts/77/publish",
  );
});

test("comment edit sends composed replacement content for a bot comment", () => {
  const composedPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine-edit-")),
    "edited.md",
  );
  fs.writeFileSync(composedPath, "Honest update from Ciel.\n");
  const edit = parseAdminOperation(
    parseArgs(["admin", "comment", "edit", "342752", "--file", composedPath]),
  );
  assert.equal(edit.name, "comment.edit");
  assert.equal(edit.method, "PUT");
  assert.equal(edit.path, "/cli/admin/comments/342752");
  assert.equal(edit.body.content, "Honest update from Ciel.");
  assert.equal(edit.mutates, true);

  assert.equal(
    parseAdminOperation(
      parseArgs([
        "admin",
        "comment",
        "edit",
        "comment:342752",
        "--file",
        composedPath,
      ]),
    ).path,
    "/cli/admin/comments/342752",
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "comment",
          "edit",
          "subject:42",
          "--file",
          composedPath,
        ]),
      ),
    /comment edit targets a comment/,
  );
  assert.throws(
    () =>
      parseAdminOperation(parseArgs(["admin", "comment", "edit", "342752"])),
    /Pass composed text with --file/,
  );
});

test("notable add resolves numeric and username targets", () => {
  const byId = parseAdminOperation(
    parseArgs([
      "admin",
      "notable",
      "add",
      "12445",
      "--note",
      "  Eleven subjects and sixty-one helpful comments.  ",
    ]),
  );
  assert.equal(byId.name, "notable.add");
  assert.equal(byId.method, "POST");
  assert.equal(byId.path, "/cli/admin/notable-users");
  assert.deepEqual(byId.body, {
    userId: 12445,
    note: "Eleven subjects and sixty-one helpful comments.",
  });
  assert.equal(byId.mutates, true);
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "notable",
        "add",
        "Minecrarft_guy",
        "--note",
        "Thoughtful peer support.",
      ]),
    ).body,
    { username: "Minecrarft_guy", note: "Thoughtful peer support." },
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "notable", "add"])),
    /notable add <userId\|username>/,
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "notable", "add", "12445"])),
    /--note <text>/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "notable", "add", "12445", "--note", "   "]),
      ),
    /--note <text>/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "notable",
          "add",
          "12445",
          "--note",
          "x".repeat(2_001),
        ]),
      ),
    /at most 2000 characters/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "notable",
          "add",
          "999999999999999999999",
          "--note",
          "Specific rationale.",
        ]),
      ),
    /user ID must be an integer/,
  );
});

test("insights brief maps to the read-only route with an optional window", () => {
  const brief = parseAdminOperation(parseArgs(["admin", "brief"]));
  assert.equal(brief.name, "insights.brief");
  assert.equal(brief.mutates, false);
  assert.equal(brief.path, "/cli/admin/insights/brief");
  assert.match(
    parseAdminOperation(parseArgs(["admin", "brief", "--days", "3"])).path,
    /days=3/,
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "brief", "--days", "0"])),
    /between 1 and 30/,
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "brief", "--days", "31"])),
    /between 1 and 30/,
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "brief", "--days", "1.5"])),
    /between 1 and 30/,
  );
});

test("monthly AI costs map to the calendar-month read route", () => {
  const monthly = parseAdminOperation(
    parseArgs(["admin", "ai-costs", "monthly"]),
  );
  assert.equal(monthly.name, "ai-costs.monthly");
  assert.equal(monthly.method, "GET");
  assert.equal(monthly.mutates, false);
  assert.equal(monthly.path, "/cli/admin/ai-costs/monthly");
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "ai-costs"])),
    /ai-costs monthly/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "ai-costs", "monthly", "unexpected"]),
      ),
    /ai-costs monthly/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "ai-costs", "monthly", "--days", "30"]),
      ),
    /does not accept --days/,
  );
});

test("monthly media costs map to the canonical feature-cost route", () => {
  const monthly = parseAdminOperation(
    parseArgs(["admin", "media-costs", "monthly"]),
  );
  assert.equal(monthly.name, "media-costs.monthly");
  assert.equal(monthly.method, "GET");
  assert.equal(monthly.mutates, false);
  assert.equal(monthly.path, "/cli/admin/media-costs/monthly");
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "media-costs"])),
    /media-costs monthly/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "media-costs", "monthly", "unexpected"]),
      ),
    /media-costs monthly/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "media-costs", "monthly", "--days", "30"]),
      ),
    /does not accept --days/,
  );
});

test("comment draft --file sends operator-composed persona content", () => {
  const composedPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine-comment-")),
    "comment.md",
  );
  fs.writeFileSync(composedPath, "Hello from Ciel! \u{1F49B}\n");
  const composed = parseAdminOperation(
    parseArgs(["admin", "comment", "draft", "42", "--file", composedPath]),
  );
  assert.equal(composed.name, "comment.draft");
  assert.equal(composed.path, "/cli/admin/comment-drafts");
  assert.equal(composed.body.targetType, "subject");
  assert.equal(composed.body.targetId, 42);
  assert.equal(composed.body.content, "Hello from Ciel! \u{1F49B}");

  const composedReply = parseAdminOperation(
    parseArgs([
      "admin",
      "comment",
      "reply",
      "comment:456",
      "--file",
      composedPath,
    ]),
  );
  assert.equal(composedReply.body.targetType, "comment");
  assert.equal(composedReply.body.content, "Hello from Ciel! \u{1F49B}");

  // Without --file the body carries no content key: the server generates.
  assert.equal(
    "content" in
      parseAdminOperation(parseArgs(["admin", "comment", "draft", "42"])).body,
    false,
  );

  const emptyPath = path.join(path.dirname(composedPath), "empty.md");
  fs.writeFileSync(emptyPath, "   \n");
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "comment", "draft", "42", "--file", emptyPath]),
      ),
    /empty/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "comment",
          "draft",
          "42",
          "--file",
          path.join(path.dirname(composedPath), "missing.md"),
        ]),
      ),
    /Could not read/,
  );

  const tooLongPath = path.join(path.dirname(composedPath), "too-long.md");
  fs.writeFileSync(tooLongPath, "x".repeat(10_001));
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "comment", "draft", "42", "--file", tooLongPath]),
      ),
    /at most 10000/,
  );

  assert.doesNotThrow(() =>
    assertComposedCommentDraftResult({
      expectedContent: "Hello from Ciel! \u{1F49B}",
      result: {
        data: {
          draft: {
            decision: "draft",
            reason: "operator-composed",
            content: "Hello from Ciel! \u{1F49B}",
            status: "ready",
          },
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    assertComposedCommentDraftResult({
      expectedContent: "Reviewed Build feedback",
      requiresBuildReviewContext: true,
      result: {
        data: {
          draft: {
            decision: "draft",
            reason: "operator-composed",
            content: "Reviewed Build feedback",
            status: "ready",
            buildReviewContextStored: true,
          },
        },
      },
    }),
  );
  assert.throws(
    () =>
      assertComposedCommentDraftResult({
        expectedContent: "Reviewed Build feedback",
        requiresBuildReviewContext: true,
        result: {
          data: {
            draft: {
              decision: "draft",
              reason: "operator-composed",
              content: "Reviewed Build feedback",
              status: "ready",
            },
          },
        },
      }),
    (error) =>
      error.code === "LUMINE_ADMIN_BUILD_REVIEW_CONTEXT_UNSUPPORTED" &&
      /Stop without publishing/.test(error.message),
  );
  assert.throws(
    () =>
      assertComposedCommentDraftResult({
        expectedContent: "Hello from Ciel! \u{1F49B}",
        result: {
          data: {
            draft: {
              decision: "draft",
              reason: "model-generated",
              content: "Different text",
              status: "ready",
            },
          },
        },
      }),
    (error) =>
      error.code === "LUMINE_ADMIN_COMPOSED_COMMENT_UNSUPPORTED" &&
      /Stop without publishing/.test(error.message),
  );
});

test("management Build comments require an actual version-bound review", () => {
  const reviewDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-build-review-"),
  );
  const composedPath = path.join(reviewDir, "comment.md");
  const contextPath = path.join(reviewDir, "context.json");
  fs.writeFileSync(
    composedPath,
    "I played the published version and liked the pacing.",
  );
  fs.writeFileSync(
    contextPath,
    JSON.stringify({
      understanding:
        "The published start screen explains the railgun mechanic after the player taps to begin.",
    }),
  );

  const candidateOperation = parseAdminOperation(
    parseArgs([
      "admin",
      "builds",
      "candidates",
      "--cursor",
      "opaque",
      "--limit",
      "25",
    ]),
  );
  assert.equal(candidateOperation.name, "builds.candidates");
  assert.equal(candidateOperation.mutates, false);
  assert.match(candidateOperation.path, /^\/build\/public\/list\?/);
  assert.match(candidateOperation.path, /sort=recent/);
  assert.match(candidateOperation.path, /cursor=opaque/);
  assert.deepEqual(
    normalizeAdminBuildCandidatesResult({
      siteUrl: "https://www.twin-kle.com",
      result: {
        builds: [
          {
            id: 884,
            title: "Chess Lab",
            collaborationMode: "open_source",
            publishedArtifactVersionId: 4512,
          },
        ],
        cursor: "next-page",
      },
    }),
    {
      ok: true,
      status: "success",
      data: {
        builds: [
          {
            id: 884,
            title: "Chess Lab",
            collaborationMode: "open_source",
            publishedArtifactVersionId: 4512,
            url: "https://www.twin-kle.com/app/884",
            review: {
              publishedArtifactVersionId: 4512,
              codePullAvailable: true,
              requiredBeforeComment: true,
            },
          },
        ],
        pagination: {
          nextCursor: "next-page",
          hasMore: true,
          exhausted: false,
        },
      },
    },
  );

  const draft = parseAdminOperation(
    parseArgs([
      "admin",
      "comment",
      "draft",
      "build:884",
      "--file",
      composedPath,
      "--reviewed-version",
      "4512",
      "--reviewed-via",
      "runtime",
      "--review-context",
      contextPath,
    ]),
  );
  assert.deepEqual(draft.body, {
    targetType: "build",
    targetId: 884,
    identity: undefined,
    content: "I played the published version and liked the pacing.",
    reviewedBuildVersionId: 4512,
    buildReviewMethod: "runtime",
    buildReviewUnderstanding:
      "The published start screen explains the railgun mechanic after the player taps to begin.",
  });

  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "comment", "draft", "build:884"]),
      ),
    /composed only/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "comment",
          "draft",
          "build:884",
          "--file",
          composedPath,
        ]),
      ),
    /review evidence and --review-context/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "comment",
          "draft",
          "build:884",
          "--file",
          composedPath,
          "--reviewed-version",
          "4512",
          "--reviewed-via",
          "api",
        ]),
      ),
    /runtime or code/,
  );

  const buildReply = parseAdminOperation(
    parseArgs([
      "admin",
      "comment",
      "reply",
      "comment:456",
      "--file",
      composedPath,
      "--reviewed-version",
      "4512",
      "--reviewed-via",
      "code",
      "--review-context",
      contextPath,
    ]),
  );
  assert.equal(buildReply.body.targetType, "comment");
  assert.equal(buildReply.body.reviewedBuildVersionId, 4512);
  assert.equal(buildReply.body.buildReviewMethod, "code");
  assert.equal(
    buildReply.body.buildReviewUnderstanding,
    "The published start screen explains the railgun mechanic after the player taps to begin.",
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "comment",
          "reply",
          "comment:456",
          "--file",
          composedPath,
          "--reviewed-version",
          "4512",
          "--reviewed-via",
          "code",
        ]),
      ),
    /review evidence requires --review-context/,
  );

  const invalidContextPath = path.join(reviewDir, "invalid-context.json");
  fs.writeFileSync(
    invalidContextPath,
    JSON.stringify({
      understanding: "Useful context",
      reviewedBuildVersionId: 4512,
    }),
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "comment",
          "draft",
          "build:884",
          "--file",
          composedPath,
          "--reviewed-version",
          "4512",
          "--reviewed-via",
          "runtime",
          "--review-context",
          invalidContextPath,
        ]),
      ),
    /only the understanding field/,
  );
  fs.rmSync(reviewDir, { recursive: true, force: true });
});

test("comment drafts target replies and standalone posts through one operation", () => {
  const reply = parseAdminOperation(
    parseArgs(["admin", "comment", "reply", "comment:456"]),
  );
  assert.equal(reply.name, "comment.draft");
  assert.equal(reply.path, "/cli/admin/comment-drafts");
  assert.deepEqual(reply.body, {
    targetType: "comment",
    targetId: 456,
    identity: undefined,
  });
  assert.deepEqual(
    parseAdminOperation(
      parseArgs(["admin", "comment", "draft", "dailyReflection:99"]),
    ).body.targetType,
    "dailyReflection",
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "comment",
        "draft",
        "https://www.twin-kle.com/comments/456",
      ]),
    ).body,
    { targetType: "comment", targetId: 456, identity: undefined },
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "comment", "reply", "123"])),
    /targets a comment/,
  );
});

test("recommend targets infer subject URLs and require explicit comment identity for IDs", () => {
  assert.deepEqual(
    parseRecommendationTarget({
      target: "https://www.twin-kle.com/subjects/123",
    }),
    { type: "subject", id: 123 },
  );
  assert.deepEqual(parseRecommendationTarget({ target: "comment:456" }), {
    type: "comment",
    id: 456,
  });
  assert.deepEqual(
    parseRecommendationTarget({ target: "456", explicitType: "comment" }),
    { type: "comment", id: 456 },
  );
  assert.deepEqual(
    parseRecommendationTarget({
      target: "https://www.twin-kle.com/ai-stories/88",
    }),
    { type: "aiStory", id: 88 },
  );
  assert.deepEqual(
    parseRecommendationTarget({ target: "dailyReflection:99" }),
    { type: "dailyReflection", id: 99 },
  );
  assert.equal(
    parseAdminOperation(
      parseArgs([
        "admin",
        "post",
        "comments",
        "dailyReflection:99",
        "--cursor",
        "opaque",
      ]),
    ).path,
    "/cli/admin/posts/dailyReflection/99/comments?cursor=opaque&limit=50",
  );
});

test("normal and max recommendations send deterministic server-owned requests", async (t) => {
  const fixture = await createFixtureServer(t);
  const normal = await runCli([
    "admin",
    "recommend",
    "https://www.twin-kle.com/subjects/123",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(normal.code, 0, normal.stderr);
  assert.equal(normal.stderr, "");
  assert.equal(JSON.parse(normal.stdout).status, "success");

  const maximum = await runCli([
    "admin",
    "recommend",
    "comment:456",
    "--anyone-can-reward",
    "--reward-twinkles",
    "3",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(maximum.code, 0, maximum.stderr);
  const requests = fixture.requests.filter((request) =>
    request.url.startsWith("/cli/admin/recommendations/"),
  );
  assert.match(requests[0].requestId, /^cli:[0-9a-f-]{36}$/);
  assert.match(requests[1].requestId, /^cli:[0-9a-f-]{36}$/);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests[0], {
    method: "POST",
    url: "/cli/admin/recommendations/subject/123",
    body: { anyoneCanReward: false, rewardTwinkles: 0 },
    runId: "91",
    requestId: requests[0].requestId,
  });
  assert.deepEqual(requests[1], {
    method: "POST",
    url: "/cli/admin/recommendations/comment/456",
    body: { anyoneCanReward: true, rewardTwinkles: 3 },
    runId: "91",
    requestId: requests[1].requestId,
  });
});

test("admin subject inspection and reorder preserve canonical API JSON", async (t) => {
  const fixture = await createFixtureServer(t);
  const getResult = await runCli([
    "admin",
    "subjects",
    "get",
    "123",
    "--include-comments",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(getResult.code, 0, getResult.stderr);
  assert.equal(getResult.stderr, "");
  assert.deepEqual(JSON.parse(getResult.stdout), fixture.subjectResponse);
  assert.equal(
    fixture.requests.some(
      (request) =>
        request.method === "GET" &&
        request.url === "/cli/admin/subjects/123?includeComments=true",
    ),
    true,
  );

  const reorder = await runCli([
    "admin",
    "subjects",
    "reorder",
    "--ids",
    "3,2,1",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(reorder.code, 0, reorder.stderr);
  const reorderRequest = fixture.requests.find(
    (request) => request.url === "/cli/admin/subjects/featured/order",
  );
  assert.deepEqual(reorderRequest?.body, { ids: [3, 2, 1] });
});

test("forbidden and partial failures are one JSON value with nonzero exit", async (t) => {
  const forbiddenFixture = await createFixtureServer(t, {
    adminError: {
      httpStatus: 403,
      response: {
        ok: false,
        status: "forbidden",
        error: {
          code: "CLI_ADMIN_FORBIDDEN",
          message: "Approved administrator access is required.",
          details: null,
        },
      },
    },
  });
  const forbidden = await runCli([
    "admin",
    "subjects",
    "featured",
    "--json",
    ...forbiddenFixture.cliArgs,
  ]);
  assert.equal(forbidden.code, 1);
  assert.equal(forbidden.stderr, "");
  assert.equal(forbidden.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(forbidden.stdout).status, "forbidden");

  const partialFixture = await createFixtureServer(t, {
    adminError: {
      httpStatus: 409,
      response: {
        ok: false,
        status: "partial_failure",
        error: {
          code: "CLI_ADMIN_REWARD_PARTIAL_FAILURE",
          message: "The recommendation succeeded, but the reward failed.",
          details: { retrySafe: true, recommendationId: 9 },
        },
      },
    },
  });
  const partial = await runCli([
    "admin",
    "recommend",
    "comment:456",
    "--anyone-can-reward",
    "--reward-twinkles",
    "3",
    "--json",
    ...partialFixture.cliArgs,
  ]);
  assert.equal(partial.code, 1);
  const partialError = JSON.parse(partial.stdout);
  assert.equal(partialError.error.details.retrySafe, true);
  assert.match(
    partialError.error.details.retryIdempotencyKey,
    /^cli:[0-9a-f-]{36}$/,
  );
});

test("local validation fails noninteractively with stable JSON", async () => {
  const result = await runCli([
    "admin",
    "recommend",
    "comment:456",
    "--reward-twinkles",
    "3",
    "--json",
    "--no-update-check",
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    JSON.parse(result.stdout),
    formatAdminJsonError({
      code: "CLI_ADMIN_CLI_VALIDATION",
      message: "--reward-twinkles 3 requires --anyone-can-reward.",
    }),
  );
});

test("completed run retries use canonical lastRun while content commands require active", async (t) => {
  const fixture = await createFixtureServer(t, {
    runStatusResponse: {
      run: null,
      lastRun: {
        id: 92,
        status: "completed",
        identity: { key: "ciel", userId: 11 },
        commentMode: "off",
      },
    },
  });
  const complete = await runCli([
    "admin",
    "daily-run",
    "complete",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(complete.code, 0, complete.stderr);
  assert.equal(
    fixture.requests.find(
      (request) => request.url === "/cli/admin/daily-runs/complete",
    )?.runId,
    "92",
  );

  const list = await runCli([
    "admin",
    "subjects",
    "list",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(list.code, 1);
  assert.equal(JSON.parse(list.stdout).error.code, "CLI_ADMIN_NO_ACTIVE_RUN");
});

test("per-command identity assertions cannot override the canonical run actor", async (t) => {
  const fixture = await createFixtureServer(t);
  const mismatch = await runCli([
    "admin",
    "subjects",
    "list",
    "--identity",
    "ciel",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(mismatch.code, 1);
  assert.equal(mismatch.stderr, "");
  const error = JSON.parse(mismatch.stdout);
  assert.equal(error.status, "validation_error");
  assert.match(error.error.message, /does not match active run #91 \(zero\)/);
  assert.equal(
    fixture.requests.some((request) =>
      request.url.startsWith("/cli/admin/subjects"),
    ),
    false,
  );
});

test("monthly AI costs preserve JSON and label both human projections", async (t) => {
  const monthlyAiCostsResponse = {
    ok: true,
    status: "success",
    data: {
      monthlyAiCosts: {
        schemaVersion: 1,
        generatedAt: Date.UTC(2026, 7, 27, 3) / 1000,
        timezone: "UTC",
        currency: "USD",
        source: {
          basis: "canonical_deduplicated_ai_cost_report",
          reportDays: 58,
          reportStartDayIndex: 1642,
          reportEndDayIndex: 1699,
          mtdIncludesInProgressDay: false,
          projectionsIncludeInProgressDayActual: false,
        },
        previousMonth: {
          status: "closed",
          monthKey: "2026-07",
          startDayKey: "2026-07-01",
          endDayKeyExclusive: "2026-08-01",
          calendarDayCount: 31,
          estimatedCostUsd: 1317.21664434,
        },
        currentMonth: {
          status: "in_progress",
          monthKey: "2026-08",
          startDayKey: "2026-08-01",
          endDayKeyExclusive: "2026-09-01",
          calendarDayCount: 31,
          completed: {
            dayCount: 26,
            throughDayKey: "2026-08-26",
            estimatedCostUsd: 907.00778625,
            dailyAverageUsd: 34.88491486,
          },
          inProgressDay: {
            dayIndex: 1699,
            dayKey: "2026-08-27",
            estimatedCostUsd: 0.1177081,
            eventCount: 8,
            requestCount: 8,
          },
          daysToEstimate: 5,
          projections: {
            allCompletedDaysPace: {
              basis: "all_completed_days",
              basisStartDayKey: "2026-08-01",
              basisEndDayKey: "2026-08-26",
              basisDayCount: 26,
              dailyAverageUsd: 34.88491486,
              remainingDayCount: 5,
              estimatedMonthTotalUsd: 1081.43236053,
              comparisonToPreviousMonth: {
                estimatedCostDeltaUsd: -235.78428381,
                percentChange: -17.90019013,
              },
            },
            recentSevenCompletedDaysPace: {
              basis: "recent_7_completed_days",
              basisStartDayKey: "2026-08-20",
              basisEndDayKey: "2026-08-26",
              basisDayCount: 7,
              dailyAverageUsd: 23.72784732,
              remainingDayCount: 5,
              estimatedMonthTotalUsd: 1025.64702286,
              comparisonToPreviousMonth: {
                estimatedCostDeltaUsd: -291.56962148,
                percentChange: -22.13528221,
              },
            },
          },
        },
      },
    },
  };
  const fixture = await createFixtureServer(t, { monthlyAiCostsResponse });

  const jsonResult = await runCli([
    "admin",
    "ai-costs",
    "monthly",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(jsonResult.code, 0, jsonResult.stderr);
  assert.deepEqual(JSON.parse(jsonResult.stdout), monthlyAiCostsResponse);
  assert.equal(
    fixture.requests.find(
      (request) => request.url === "/cli/admin/ai-costs/monthly",
    )?.runId,
    "91",
  );

  const humanResult = await runCli([
    "admin",
    "ai-costs",
    "monthly",
    ...fixture.cliArgs,
  ]);
  assert.equal(humanResult.code, 0, humanResult.stderr);
  assert.match(
    humanResult.stdout,
    /2026-07 closed month: \$1,317\.22 estimated cost/,
  );
  assert.match(
    humanResult.stdout,
    /completed-day MTD through 2026-08-26: \$907\.01 across 26/,
  );
  assert.match(
    humanResult.stdout,
    /2026-08-27 in progress: \$0\.12 so far \(excluded from completed-day MTD and both projections\)/,
  );
  assert.match(
    humanResult.stdout,
    /All-completed-days pace full-month projection: \$1,081\.43.*17\.90% below 2026-07/,
  );
  assert.match(
    humanResult.stdout,
    /Recent-seven-completed-day pace full-month projection: \$1,025\.65.*2026-08-20 through 2026-08-26.*22\.14% below 2026-07/,
  );
});

test("monthly media costs preserve JSON and surface headroom plus operational alerts", async (t) => {
  const kind = ({
    actionCount,
    committedCount,
    activeReservedCount,
    cancelledCount,
    estimatedSpentUsd,
    activeReservedUsd,
  }) => ({
    actionCount,
    committedCount,
    activeReservedCount,
    cancelledCount,
    estimatedSpentUsd,
    activeReservedUsd,
    originalReservedCapacityUsd: estimatedSpentUsd + activeReservedUsd,
  });
  const monthlyMediaCostsResponse = {
    ok: true,
    status: "success",
    data: {
      monthlyMediaCosts: {
        schemaVersion: 3,
        generatedAt: Date.UTC(2026, 7, 27, 6) / 1000,
        timezone: "UTC",
        currency: "USD",
        status: "attention",
        source: {
          basis: "canonical_build_media_energy_ledger",
          costNature: "conservative_provider_cost_estimate_not_aws_invoice",
          photoStorageAttribution:
            "shared_build_runtime_image_storage_not_capture_only",
          streamAttemptBasis: "current_utc_day_created_at_cohort",
          replayStorageCostAttribution: "embedded_in_live_input_reservations",
          awsInvoiceReconciliationRequired: true,
        },
        previousMonth: {
          monthKey: "2026-07",
          limitUsd: 40,
          estimatedSpentUsd: 0,
          activeReservedUsd: 0,
          carryoverUsd: 0,
          guardedTotalUsd: 0,
          remainingUsd: 40,
          percentUsed: 0,
        },
        currentMonth: {
          monthKey: "2026-08",
          limitUsd: 40,
          estimatedSpentUsd: 0.023667,
          activeReservedUsd: 0.003,
          carryoverUsd: 0,
          guardedTotalUsd: 0.026667,
          remainingUsd: 39.973333,
          percentUsed: 0.0667,
          reservationTotals: {
            actionCount: 6,
            distinctUserCount: 3,
            distinctBuildCount: 2,
          },
          byKind: {
            clip: kind({
              actionCount: 3,
              committedCount: 2,
              activeReservedCount: 1,
              cancelledCount: 0,
              estimatedSpentUsd: 0.006,
              activeReservedUsd: 0.003,
            }),
            liveInput: kind({
              actionCount: 1,
              committedCount: 1,
              activeReservedCount: 0,
              cancelledCount: 0,
              estimatedSpentUsd: 0.016667,
              activeReservedUsd: 0,
            }),
            liveViewer: kind({
              actionCount: 2,
              committedCount: 2,
              activeReservedCount: 0,
              cancelledCount: 0,
              estimatedSpentUsd: 0.001,
              activeReservedUsd: 0,
            }),
            replayViewer: kind({
              actionCount: 0,
              committedCount: 0,
              activeReservedCount: 0,
              cancelledCount: 0,
              estimatedSpentUsd: 0,
              activeReservedUsd: 0,
            }),
          },
          reconciliation: {
            consistent: true,
            usageSpentUsd: 0.023667,
            committedReservationUsd: 0.023667,
            spentDeltaUsd: 0,
            usageReservedUsd: 0.003,
            activeReservationUsd: 0.003,
            reservedDeltaUsd: 0,
          },
        },
        currentUtcDay: {
          dayKey: "2026-08-27",
          reservationsCreated: 6,
          commitmentsSettled: 5,
          cancellationsSettled: 0,
          estimatedCostSettledUsd: 0.023667,
          streamAttempts: {
            attemptedCount: 3,
            reachedLiveCount: 2,
            endedCount: 1,
            failedCount: 1,
            cancelledCount: 0,
            inProgressCount: 1,
            failureCodeCounts: [{ code: "ivs_create_unresolved", count: 1 }],
          },
        },
        overdueReservations: { count: 1, reservedUsd: 0.003 },
        operations: {
          clips: {
            completingCount: 0,
            processingCount: 1,
            staleCount: 0,
            staleAfterSeconds: 900,
          },
          live: {
            provisioningCount: 0,
            readyCount: 0,
            liveCount: 1,
            endingCount: 0,
            cleanupFailedCount: 0,
            costBearingChannelCount: 1,
            cleanupOverdueCount: 0,
            stillActiveOrCleanupPendingCount: 1,
            possibleOrphanedCount: 0,
          },
          viewers: { activeGrantCount: 1, expiredActiveGrantCount: 0 },
          replays: {
            pendingCount: 0,
            processingCount: 0,
            readyCount: 1,
            failedCount: 0,
            deletePendingCount: 0,
            deleteFailedCount: 0,
            expiredReadyCount: 0,
            finalizationOverdueCount: 0,
            deletionOverdueCount: 0,
            storedBytes: 262144,
            storedObjectCount: 15,
          },
          replayViewers: {
            activeGrantCount: 1,
            expiredActiveGrantCount: 0,
          },
          runtimeStorage: {
            readyImages: { assetCount: 4, totalBytes: 122880 },
            readyClips: { assetCount: 2, totalBytes: 262144 },
          },
        },
        alerts: [
          {
            severity: "warning",
            code: "media_reservations_overdue",
            message:
              "1 Media Energy reservation(s) are past expiry and still unsettled.",
          },
        ],
      },
    },
  };
  const fixture = await createFixtureServer(t, {
    monthlyMediaCostsResponse,
  });

  const jsonResult = await runCli([
    "admin",
    "media-costs",
    "monthly",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(jsonResult.code, 0, jsonResult.stderr);
  assert.deepEqual(JSON.parse(jsonResult.stdout), monthlyMediaCostsResponse);
  assert.equal(
    fixture.requests.find(
      (request) => request.url === "/cli/admin/media-costs/monthly",
    )?.runId,
    "91",
  );

  const humanResult = await runCli([
    "admin",
    "media-costs",
    "monthly",
    ...fixture.cliArgs,
  ]);
  assert.equal(humanResult.code, 0, humanResult.stderr);
  assert.match(
    humanResult.stdout,
    /2026-08: \$0\.023667 settled estimate \+ \$0\.003 active reservations.*\$39\.973333 remaining/,
  );
  assert.match(
    humanResult.stdout,
    /2026-08-27 so far: 6 action\(s\) reserved, 5 committed.*\$0\.023667 settled estimate/,
  );
  assert.match(
    humanResult.stdout,
    /Stream attempts created 2026-08-27 UTC: 3 attempted \/ 2 reached live \/ 1 ended after live \/ 1 failed \/ 0 cancelled before live \/ 1 still in progress/,
  );
  assert.match(
    humanResult.stdout,
    /Stream failure codes: ivs_create_unresolved=1/,
  );
  assert.match(
    humanResult.stdout,
    /1 active-or-cleanup-pending.*0 possible orphan\(s\)/,
  );
  assert.match(humanResult.stdout, /Ledger reconciliation: consistent/);
  assert.match(humanResult.stdout, /Replay viewers: 0 action\(s\)/);
  assert.match(
    humanResult.stdout,
    /Replays: 0 pending \/ 0 processing \/ 1 ready[\s\S]*256 KB across 15 canonical object\(s\)/,
  );
  assert.match(
    humanResult.stdout,
    /Media-cost alert \[WARNING\] media_reservations_overdue/,
  );
  assert.match(
    humanResult.stdout,
    /conservative provider-cost ledger estimates, not an AWS invoice/,
  );
});

test("existing public command parsing is unaffected", () => {
  const workspace = parseArgs(["884"]);
  assert.equal(workspace.command, "workspace");
  assert.equal(workspace.target, "884");
  const save = parseArgs(["save", "--publish"]);
  assert.equal(save.command, "save");
  assert.equal(save.publish, true);
});

test("management cost guidance prevents mid-month forecast double counting", () => {
  const guide = fs.readFileSync(
    fileURLToPath(new URL("../sdk/LUMINE_ADMIN.md", import.meta.url)),
    "utf8",
  );
  const forecastStart = guide.indexOf("aws ce get-cost-forecast");
  const forecastEnd = guide.indexOf("```", forecastStart);
  const forecastCommand = guide.slice(forecastStart, forecastEnd);
  assert.match(forecastCommand, /--granularity DAILY/);
  assert.doesNotMatch(forecastCommand, /--granularity MONTHLY/);
  assert.match(guide, /returned daily periods cover[\s\S]*?requested `Start`/);
  assert.match(guide, /would double-count/);
  assert.match(guide, /failureCodeCounts[\s\S]*?never usernames/);
});

async function createFixtureServer(
  t,
  {
    adminError = null,
    runStatusResponse = null,
    monthlyAiCostsResponse = null,
    monthlyMediaCostsResponse = null,
  } = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-admin-"));
  const authFile = path.join(tmpDir, "auth.json");
  const requests = [];
  const subjectResponse = {
    ok: true,
    status: "success",
    data: {
      subject: {
        id: 123,
        url: "https://www.twin-kle.com/subjects/123",
        author: { id: 4, username: "author" },
        effortLevel: 2,
        featured: { member: false, order: null },
        createdByAuthor: true,
        commentsIncluded: true,
        comments: [],
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      body,
      runId: req.headers["x-lumine-admin-run-id"] || null,
      requestId: req.headers["x-lumine-idempotency-key"] || null,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "mikey",
          scopes: ["build:read", "build:write"],
        }),
      );
      return;
    }
    if (
      adminError &&
      req.url.startsWith("/cli/admin/") &&
      req.url !== "/cli/admin/daily-runs/status"
    ) {
      res.statusCode = adminError.httpStatus;
      res.end(JSON.stringify(adminError.response));
      return;
    }
    if (req.method === "GET" && req.url === "/cli/admin/daily-runs/status") {
      res.end(
        JSON.stringify({
          ok: true,
          status: "success",
          data: {
            ...(runStatusResponse || {
              run: {
                id: 91,
                status: "active",
                identity: { key: "zero", userId: 10 },
                commentMode: "off",
              },
              lastRun: null,
            }),
          },
        }),
      );
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/admin/subjects/123?includeComments=true"
    ) {
      res.end(JSON.stringify(subjectResponse));
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/admin/ai-costs/monthly" &&
      monthlyAiCostsResponse
    ) {
      res.end(JSON.stringify(monthlyAiCostsResponse));
      return;
    }
    if (
      req.method === "GET" &&
      req.url === "/cli/admin/media-costs/monthly" &&
      monthlyMediaCostsResponse
    ) {
      res.end(JSON.stringify(monthlyMediaCostsResponse));
      return;
    }
    if (req.url.startsWith("/cli/admin/")) {
      res.end(
        JSON.stringify({
          ok: true,
          status: "success",
          changed: true,
          data: {},
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    authFile,
    JSON.stringify({ token: "test-token", apiUrl }),
    "utf8",
  );
  return {
    requests,
    subjectResponse,
    cliArgs: [
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
    ],
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("newspaper verbs map to the delegated news routes", () => {
  const status = parseAdminOperation(parseArgs(["admin", "news"]));
  assert.equal(status.name, "news.status");
  assert.equal(status.method, "GET");
  assert.equal(status.path, "/cli/admin/news");
  assert.equal(status.mutates, false);

  const explicitStatus = parseAdminOperation(
    parseArgs(["admin", "news", "status"]),
  );
  assert.equal(explicitStatus.name, "news.status");
  assert.equal(explicitStatus.path, "/cli/admin/news");

  const print = parseAdminOperation(parseArgs(["admin", "news", "print"]));
  assert.equal(print.name, "news.print");
  assert.equal(print.method, "POST");
  assert.equal(print.path, "/cli/admin/news/print");
  assert.equal(print.mutates, true);

  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "news", "refresh"])),
    /lumine admin news \[status\] \| news print \| news claim/,
  );
});

test("bot-output and composed bot chat map to the review and existing-DM routes", () => {
  assert.equal(
    parseAdminOperation(parseArgs(["admin", "bot-output"])).path,
    "/cli/admin/bot-output",
  );
  const review = parseAdminOperation(
    parseArgs(["admin", "bot-output", "--days", "3"]),
  );
  assert.equal(review.name, "bot.output");
  assert.equal(review.method, "GET");
  assert.equal(review.path, "/cli/admin/bot-output?days=3");
  assert.equal(review.mutates, false);
  const continuedReview = parseAdminOperation(
    parseArgs(["admin", "bot-output", "--cursor", "next-page"]),
  );
  assert.equal(continuedReview.path, "/cli/admin/bot-output?cursor=next-page");
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "bot-output",
          "--days",
          "3",
          "--cursor",
          "next-page",
        ]),
      ),
    /without changing its --days window/,
  );
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "bot-output", "extra"])),
    /Usage: lumine admin/,
  );
  assert.throws(
    () =>
      parseAdminOperation(parseArgs(["admin", "bot-output", "--days", "31"])),
    /--days must be an integer between 1 and 30/,
  );

  const messagePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine-admin-chat-")),
    "message.md",
  );
  fs.writeFileSync(messagePath, "I got that wrong. I'm sorry.");
  const announcementPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine-admin-announcement-")),
    "announcement.md",
  );
  fs.writeFileSync(announcementPath, "Lumine can now use Grok 4.6.");
  const announce = parseAdminOperation(
    parseArgs(["admin", "announcement", "post", "--file", announcementPath]),
  );
  assert.equal(announce.name, "announcement.post");
  assert.equal(announce.method, "POST");
  assert.equal(announce.path, "/cli/admin/announcements");
  assert.equal(announce.body.content, "Lumine can now use Grok 4.6.");
  assert.equal(announce.mutates, true);
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "announcement", "post"])),
    /Pass composed text with --file/,
  );

  const send = parseAdminOperation(
    parseArgs(["admin", "chat", "send", "Hajun", "--file", messagePath]),
  );
  assert.equal(send.name, "chat.send");
  assert.equal(send.method, "POST");
  assert.equal(send.path, "/cli/admin/chat-messages");
  assert.equal(send.body.target, "Hajun");
  assert.equal(send.body.content, "I got that wrong. I'm sorry.");
  assert.equal(send.mutates, true);
});

test("newspaper claim and submit map to the editorial routes", () => {
  const claim = parseAdminOperation(parseArgs(["admin", "news", "claim"]));
  assert.equal(claim.name, "news.claim");
  assert.equal(claim.method, "POST");
  assert.equal(claim.path, "/cli/admin/news/claim");
  assert.equal(claim.mutates, true);

  const editorialPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lumine-news-")),
    "editorial.json",
  );
  fs.writeFileSync(
    editorialPath,
    JSON.stringify({
      mastheadHeadline: "Test Edition",
      lead: null,
      stories: [],
      editorsNote: "",
    }),
  );
  const submit = parseAdminOperation(
    parseArgs([
      "admin",
      "news",
      "submit",
      "--edition-id",
      "42",
      "--lease-token",
      "lease-abc",
      "--file",
      editorialPath,
      "--model",
      "Claude",
    ]),
  );
  assert.equal(submit.name, "news.submit");
  assert.equal(submit.path, "/cli/admin/news/submit");
  assert.equal(submit.body.editionId, 42);
  assert.equal(submit.body.leaseToken, "lease-abc");
  assert.equal(submit.body.model, "Claude");
  assert.equal(submit.body.editorial.mastheadHeadline, "Test Edition");

  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "news", "submit", "--edition-id", "42"]),
      ),
    /--lease-token/,
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs([
          "admin",
          "news",
          "submit",
          "--edition-id",
          "42",
          "--lease-token",
          "lease-abc",
        ]),
      ),
    /--file/,
  );
});

test("newspaper repair claims carry the target date", () => {
  const repair = parseAdminOperation(
    parseArgs(["admin", "news", "claim", "--date", "2026-08-05"]),
  );
  assert.equal(repair.name, "news.claim");
  assert.deepEqual(repair.body, { date: "2026-08-05" });

  const todayClaim = parseAdminOperation(parseArgs(["admin", "news", "claim"]));
  assert.deepEqual(todayClaim.body, {});

  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "news", "claim", "--date", "yesterday"]),
      ),
    /--date must be YYYY-MM-DD/,
  );
});

test("newspaper claim scaffolds preserve exact quote evidence before submit", () => {
  const claim = {
    editionId: 42,
    leaseToken: "lease-abc",
    maxSourceQuoteLength: 360,
    events: [
      {
        eventKey: "subject:1",
        section: "front",
        summary: "An exact passage from the author.",
      },
      {
        eventKey: "build:2",
        section: "notices",
        summary: "A new app was published.",
      },
    ],
  };
  const scaffold = createNewsEditorialScaffold(claim);
  assert.equal(scaffold.lead.eventKey, "subject:1");
  assert.equal(scaffold.lead.sourceQuote, "An exact passage from the author.");
  assert.equal(scaffold.stories[0].sourceQuote, "");
  scaffold.mastheadHeadline = "A Day of Making";
  scaffold.mastheadDeck = "Twinklers share an idea and a new app.";
  scaffold.editorsNote = "Good work becomes stronger when it is shared.";
  scaffold.lead.headline = "An Author Makes the Case";
  scaffold.lead.summary = "A member shared a clear argument.";
  scaffold.stories[0].headline = "A New App Opens";
  scaffold.stories[0].summary = "A builder published a new app.";
  assert.deepEqual(validateNewsEditorial({ claim, editorial: scaffold }), {
    valid: true,
    editionId: 42,
    citedEventCount: 2,
    coveredEventCount: 0,
    availableEventCount: 2,
  });
  scaffold.lead.sourceQuote = "a paraphrase";
  assert.throws(
    () => validateNewsEditorial({ claim, editorial: scaffold }),
    /exact contiguous claim-summary passage/,
  );

  const emptySummaryClaim = {
    ...claim,
    events: [{ ...claim.events[0], summary: "" }],
  };
  const emptySummaryEditorial = {
    ...scaffold,
    lead: { ...scaffold.lead, sourceQuote: "" },
    stories: [],
  };
  assert.equal(
    validateNewsEditorial({
      claim: emptySummaryClaim,
      editorial: emptySummaryEditorial,
    }).valid,
    true,
  );
});

test("newspaper validation and claim-based submission parse locally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-news-claim-"));
  const claimPath = path.join(dir, "claim.json");
  const editorialPath = path.join(dir, "editorial.json");
  const claim = {
    editionId: 77,
    leaseToken: "lease-77",
    maxSourceQuoteLength: 360,
    events: [
      {
        eventKey: "subject:7",
        section: "front",
        summary: "Exact source text",
      },
    ],
  };
  const editorial = {
    mastheadHeadline: "The Test Daily",
    mastheadDeck: "One exact source.",
    lead: {
      eventKey: "subject:7",
      headline: "The Source Speaks",
      summary: "The subject anchors the edition.",
      sourceQuote: "Exact source text",
      coveredEventKeys: [],
    },
    stories: [],
    editorsNote: "Evidence comes first.",
  };
  fs.writeFileSync(claimPath, JSON.stringify({ schemaVersion: 1, claim }));
  fs.writeFileSync(editorialPath, JSON.stringify(editorial));

  const validate = parseAdminOperation(
    parseArgs([
      "admin",
      "news",
      "validate",
      "--claim",
      claimPath,
      "--file",
      editorialPath,
    ]),
  );
  assert.equal(validate.name, "news.validate");
  assert.equal(validate.local, true);

  const submit = parseAdminOperation(
    parseArgs([
      "admin",
      "news",
      "submit",
      "--claim",
      claimPath,
      "--file",
      editorialPath,
    ]),
  );
  assert.equal(submit.body.editionId, 77);
  assert.equal(submit.body.leaseToken, "lease-77");
});

test("batch skip files are canonicalized and deduplicated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-skip-batch-"));
  const targetPath = path.join(dir, "targets.json");
  fs.writeFileSync(
    targetPath,
    JSON.stringify([
      "comment:12",
      { target: "dailyReflection:9", reason: "already covered" },
      "comment:12",
    ]),
  );
  assert.deepEqual(
    readBatchSkipTargets({
      filePath: targetPath,
      parseTarget: parseRecommendationTarget,
      defaultReason: "legacy queue cleanup",
    }),
    [
      {
        key: "comment:12",
        type: "comment",
        id: 12,
        reason: "legacy queue cleanup",
      },
      {
        key: "dailyReflection:9",
        type: "dailyReflection",
        id: 9,
        reason: "already covered",
      },
    ],
  );
});

test("automatic pagination checkpoints each canonical page and records coverage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-pagination-"));
  const checkpoint = path.join(dir, "checkpoint.json");
  const output = path.join(dir, "result.json");
  const calls = [];
  let recordedCoverage = null;
  const result = await runAutomaticPagination({
    options: {
      adminCheckpoint: checkpoint,
      adminResume: false,
      adminOutput: output,
    },
    operation: {
      name: "recommendations.list",
      path: "/cli/admin/recommendations?sinceRun=true",
      pagination: {
        collectionKey: "items",
        coverageQueue: "recommendations",
        coverageMode: "since-run",
        after: null,
        filters: {
          contentTypes: "comment",
          operatorView: "unviewed",
        },
      },
    },
    runId: 26,
    fetchPage: async (requestPath) => {
      calls.push(requestPath);
      return calls.length === 1
        ? {
            ok: true,
            status: "success",
            data: {
              items: [{ contentType: "comment", contentId: 1 }],
              clientFilter: {
                contentTypes: ["comment"],
                excludedItems: 3,
              },
              operatorViewFilter: {
                mode: "unviewed",
                excludedItems: 2,
                unknownStateItems: 1,
              },
              pagination: {
                nextCursor: "second",
                exhausted: false,
                scannedCount: 500,
                snapshotMaxId: 900,
                snapshotTimeStamp: 150,
                after: 100,
              },
            },
          }
        : {
            ok: true,
            status: "success",
            data: {
              items: [{ contentType: "comment", contentId: 2 }],
              clientFilter: {
                contentTypes: ["comment"],
                excludedItems: 4,
              },
              operatorViewFilter: {
                mode: "unviewed",
                excludedItems: 3,
                unknownStateItems: 4,
              },
              pagination: {
                nextCursor: null,
                exhausted: true,
                scannedCount: 25,
                snapshotMaxId: 900,
                snapshotTimeStamp: 150,
                after: 100,
              },
            },
          };
    },
    transformPage: (page) => page,
    recordCoverage: async (coverage) => {
      recordedCoverage = coverage;
    },
  });
  const materialized = await materializePaginatedResult(result);
  assert.deepEqual(
    materialized.data.items.map((item) => item.contentId),
    [1, 2],
  );
  assert.equal(result.data.scan.pages, 2);
  assert.equal(result.data.scan.scannedCount, 525);
  assert.equal(result.data.scan.outputPath, output);
  assert.equal(result.data.scan.filterSummariesComplete, true);
  assert.deepEqual(materialized.data.clientFilter, {
    contentTypes: ["comment"],
    excludedItems: 7,
  });
  assert.deepEqual(materialized.data.operatorViewFilter, {
    mode: "unviewed",
    excludedItems: 5,
    unknownStateItems: 5,
  });
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const savedCheckpoint = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
  assert.equal(savedCheckpoint.exhausted, true);
  assert.equal(savedCheckpoint.candidateCount, 2);
  assert.equal(Object.hasOwn(savedCheckpoint, "items"), false);
  assert.ok(fs.statSync(savedCheckpoint.spoolPath).isFile());
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).data.items.length, 2);
  assert.deepEqual(recordedCoverage, {
    queue: "recommendations",
    mode: "since-run",
    after: 100,
    pages: 2,
    scannedCount: 525,
    candidateCount: 2,
    snapshotMaxId: 900,
    snapshotTimeStamp: 150,
    exhausted: true,
    filters: {
      contentTypes: "comment",
      operatorView: "unviewed",
    },
  });
});

test("automatic pagination keeps checkpoint and result paths distinct", async () => {
  const output = path.join(
    os.tmpdir(),
    `lumine-pagination-collision-${process.pid}-${Date.now()}.json`,
  );
  await assert.rejects(
    () =>
      runAutomaticPagination({
        options: {
          adminCheckpoint: output,
          adminResume: false,
          adminOutput: output,
        },
        operation: {
          name: "subjects.candidates",
          path: "/cli/admin/subjects",
          pagination: {
            collectionKey: "subjects",
            coverageQueue: "subjects",
            coverageMode: "all",
            after: null,
            filters: {},
          },
        },
        runId: 27,
        fetchPage: async () => {
          throw new Error("path collisions must fail before fetching");
        },
        transformPage: (page) => page,
      }),
    /checkpoint and result output must use different files/,
  );
  assert.equal(fs.existsSync(output), false);
});

test("a fresh scan replaces only its checkpoint-owned candidate spool", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-pagination-replace-"),
  );
  const checkpoint = path.join(dir, "checkpoint.json");
  const operation = {
    name: "subjects.candidates",
    path: "/cli/admin/subjects",
    pagination: {
      collectionKey: "subjects",
      coverageQueue: "subjects",
      coverageMode: "all",
      after: null,
      filters: {},
    },
  };
  const scan = (id) =>
    runAutomaticPagination({
      options: {
        adminCheckpoint: checkpoint,
        adminResume: false,
        adminOutput: "",
      },
      operation,
      runId: 28,
      fetchPage: async () => ({
        ok: true,
        status: "success",
        data: {
          subjects: [{ id }],
          pagination: {
            nextCursor: null,
            exhausted: true,
            scannedCount: 1,
            snapshotMaxId: id,
            snapshotTimeStamp: 150,
            after: null,
          },
        },
      }),
      transformPage: (page) => page,
    });

  await scan(1);
  const firstSpool = JSON.parse(
    fs.readFileSync(checkpoint, "utf8"),
  ).spoolPath;
  assert.ok(fs.existsSync(firstSpool));
  const second = await scan(2);
  const secondSpool = getPaginatedResultStorage(second).spoolPath;
  assert.notEqual(secondSpool, firstSpool);
  assert.equal(fs.existsSync(firstSpool), false);
  assert.equal(fs.existsSync(secondSpool), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("JSON automatic scans report bounded progress without touching result output", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-pagination-progress-"),
  );
  const checkpoint = path.join(dir, "checkpoint.json");
  const progress = [];
  let pageNumber = 0;
  const result = await runAutomaticPagination({
    options: {
      adminCheckpoint: checkpoint,
      adminResume: false,
      adminOutput: "",
      json: true,
    },
    operation: {
      name: "subjects.candidates",
      path: "/cli/admin/subjects",
      pagination: {
        collectionKey: "subjects",
        coverageQueue: "subjects",
        coverageMode: "all",
        after: null,
        filters: {},
      },
    },
    runId: 27,
    fetchPage: async () => {
      pageNumber += 1;
      const exhausted = pageNumber === 12;
      return {
        ok: true,
        status: "success",
        data: {
          subjects: [{ id: pageNumber }],
          pagination: {
            nextCursor: exhausted ? null : `page-${pageNumber + 1}`,
            exhausted,
            scannedCount: 25,
            snapshotMaxId: 900,
            snapshotTimeStamp: 150,
            after: null,
          },
        },
      };
    },
    transformPage: (page) => page,
    reportProgress: (message) => progress.push(message),
  });
  const materialized = await materializePaginatedResult(result);
  assert.equal(materialized.data.subjects.length, 12);
  assert.equal(progress.length, 4);
  assert.match(progress[0], /starting canonical scan/);
  assert.match(progress[1], /1 page\(s\).*continuing/);
  assert.match(progress[2], /10 page\(s\).*250 row\(s\) scanned/);
  assert.match(progress[3], /12 page\(s\).*canonical snapshot exhausted/);
  assert.equal(
    progress.some((line) => line.includes('"ok"')),
    false,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("automatic pagination resumes only after the last confirmed page", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-pagination-resume-"),
  );
  const checkpoint = path.join(dir, "checkpoint.json");
  const operation = {
    name: "recommendations.list",
    path: "/cli/admin/recommendations?sinceRun=true",
    pagination: {
      collectionKey: "items",
      coverageQueue: "recommendations",
      coverageMode: "since-run",
      after: null,
      filters: {},
    },
  };
  let initialCalls = 0;
  await assert.rejects(
    () =>
      runAutomaticPagination({
        options: {
          adminCheckpoint: checkpoint,
          adminResume: false,
          adminOutput: "",
        },
        operation,
        runId: 31,
        fetchPage: async () => {
          initialCalls += 1;
          if (initialCalls > 1) throw new Error("temporary transport failure");
          return {
            ok: true,
            status: "success",
            data: {
              items: [{ contentType: "comment", contentId: 1 }],
              pagination: {
                nextCursor: "confirmed-second-page",
                exhausted: false,
                scannedCount: 500,
                snapshotMaxId: 700,
                snapshotTimeStamp: 250,
                after: 200,
              },
            },
          };
        },
        transformPage: (page) => page,
      }),
    /temporary transport failure/,
  );
  assert.equal(initialCalls, 2);

  await assert.rejects(
    () =>
      runAutomaticPagination({
        options: {
          adminCheckpoint: checkpoint,
          adminResume: true,
          adminOutput: "",
        },
        operation: {
          ...operation,
          pagination: {
            ...operation.pagination,
            filters: { operatorView: "viewed" },
          },
        },
        runId: 31,
        fetchPage: async () => {
          throw new Error("a mismatched checkpoint must fail before fetching");
        },
        transformPage: (page) => page,
      }),
    /does not belong to this run and exact listing request/,
  );

  // A process may die after fsyncing a page but before atomically advancing
  // the checkpoint. Resume must discard that unconfirmed tail before fetching
  // from the last confirmed cursor.
  const confirmedCheckpoint = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
  fs.appendFileSync(
    confirmedCheckpoint.spoolPath,
    `${JSON.stringify({ contentType: "comment", contentId: 999 })}\n`,
  );

  const resumedPaths = [];
  const resumed = await runAutomaticPagination({
    options: {
      adminCheckpoint: checkpoint,
      adminResume: true,
      adminOutput: "",
    },
    operation,
    runId: 31,
    fetchPage: async (requestPath) => {
      resumedPaths.push(requestPath);
      return {
        ok: true,
        status: "success",
        data: {
          items: [{ contentType: "comment", contentId: 2 }],
          pagination: {
            nextCursor: null,
            exhausted: true,
            scannedCount: 20,
            snapshotMaxId: 700,
            snapshotTimeStamp: 250,
            after: 200,
          },
        },
      };
    },
    transformPage: (page) => page,
  });
  assert.match(resumedPaths[0], /cursor=confirmed-second-page/);
  const materialized = await materializePaginatedResult(resumed);
  assert.deepEqual(
    materialized.data.items.map((item) => item.contentId),
    [1, 2],
  );
  assert.equal(resumed.data.scan.resumed, true);
});

test("automatic pagination migrates confirmed v2 item checkpoints without rescanning", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-pagination-v2-resume-"),
  );
  const checkpoint = path.join(dir, "checkpoint.json");
  const operation = {
    name: "recommendations.list",
    path: "/cli/admin/recommendations?sinceRun=true",
    pagination: {
      collectionKey: "items",
      coverageQueue: "recommendations",
      coverageMode: "since-run",
      after: null,
      filters: {},
    },
  };
  fs.writeFileSync(
    checkpoint,
    JSON.stringify({
      schemaVersion: 2,
      kind: "admin-pagination",
      operationFingerprint: legacyPaginationFingerprint({
        runId: 32,
        operation,
      }),
      runId: 32,
      operationName: operation.name,
      nextCursor: "legacy-confirmed-page-2",
      exhausted: false,
      pages: 1,
      scannedCount: 500,
      snapshotMaxId: 700,
      snapshotTimeStamp: 250,
      after: 200,
      boundariesConfirmed: true,
      items: [{ contentType: "comment", contentId: 1 }],
    }),
    { mode: 0o600 },
  );

  const fetchedPaths = [];
  const resumed = await runAutomaticPagination({
    options: {
      adminCheckpoint: checkpoint,
      adminResume: true,
      adminOutput: "",
    },
    operation,
    runId: 32,
    fetchPage: async (requestPath) => {
      fetchedPaths.push(requestPath);
      return {
        ok: true,
        status: "success",
        data: {
          items: [{ contentType: "comment", contentId: 2 }],
          pagination: {
            nextCursor: null,
            exhausted: true,
            scannedCount: 20,
            snapshotMaxId: 700,
            snapshotTimeStamp: 250,
            after: 200,
          },
        },
      };
    },
    transformPage: (page) => page,
  });

  assert.match(fetchedPaths[0], /cursor=legacy-confirmed-page-2/);
  const materialized = await materializePaginatedResult(resumed);
  assert.deepEqual(
    materialized.data.items.map((item) => item.contentId),
    [1, 2],
  );
  assert.equal(resumed.data.scan.filterSummariesComplete, false);
  assert.equal(Object.hasOwn(materialized.data, "clientFilter"), false);
  assert.equal(Object.hasOwn(materialized.data, "operatorViewFilter"), false);
  const migrated = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.candidateCount, 2);
  assert.equal(Object.hasOwn(migrated, "items"), false);
  assert.ok(fs.statSync(migrated.spoolPath).isFile());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("automatic pagination requires explicit exhaustion and stable snapshot boundaries", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-pagination-proof-"),
  );
  const baseOperation = {
    name: "recommendations.list",
    path: "/cli/admin/recommendations?sinceRun=true",
    pagination: {
      collectionKey: "items",
      coverageQueue: "recommendations",
      coverageMode: "since-run",
      after: null,
      filters: {},
    },
  };

  await assert.rejects(
    () =>
      runAutomaticPagination({
        options: {
          adminCheckpoint: path.join(dir, "missing-exhaustion.json"),
          adminResume: false,
          adminOutput: "",
        },
        operation: baseOperation,
        runId: 41,
        fetchPage: async () => ({
          ok: true,
          data: { items: [], pagination: { nextCursor: null } },
        }),
        transformPage: (page) => page,
      }),
    /explicitly confirm whether the canonical snapshot is exhausted/,
  );

  let pageNumber = 0;
  await assert.rejects(
    () =>
      runAutomaticPagination({
        options: {
          adminCheckpoint: path.join(dir, "snapshot-drift.json"),
          adminResume: false,
          adminOutput: "",
        },
        operation: baseOperation,
        runId: 42,
        fetchPage: async () => {
          pageNumber += 1;
          return {
            ok: true,
            data: {
              items: [],
              pagination: {
                nextCursor: pageNumber === 1 ? "page-2" : null,
                exhausted: pageNumber > 1,
                scannedCount: 0,
                snapshotMaxId: pageNumber === 1 ? 90 : 91,
                snapshotTimeStamp: 200,
                after: 100,
              },
            },
          };
        },
        transformPage: (page) => page,
      }),
    /changed snapshotMaxId while paging one canonical snapshot/,
  );
});

test("automatic pagination keeps its checkpoint bounded beyond the former 64 MB ceiling", async () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-pagination-bounded-"),
  );
  try {
    const checkpoint = path.join(dir, "checkpoint.json");
    const totalCandidates = 22_851;
    const pageSize = 500;
    const largeField = "x".repeat(3_000);
    let emitted = 0;
    let pageNumber = 0;
    const result = await runAutomaticPagination({
      options: {
        adminCheckpoint: checkpoint,
        adminResume: false,
        adminOutput: "",
      },
      operation: {
        name: "subjects.candidates",
        path: "/cli/admin/subjects?effort=unassigned",
        pagination: {
          collectionKey: "subjects",
          coverageQueue: "subjects",
          coverageMode: "all",
          after: null,
          filters: { effort: "unassigned" },
        },
      },
      runId: 43,
      fetchPage: async () => {
        pageNumber += 1;
        const count = Math.min(pageSize, totalCandidates - emitted);
        const subjects = Array.from({ length: count }, (_value, index) => ({
          id: emitted + index + 1,
          title: largeField,
        }));
        emitted += count;
        const exhausted = emitted === totalCandidates;
        return {
          ok: true,
          status: "success",
          data: {
            subjects,
            pagination: {
              nextCursor: exhausted ? null : `page-${pageNumber + 1}`,
              exhausted,
              scannedCount: count,
              snapshotMaxId: totalCandidates,
              snapshotTimeStamp: 500,
              after: null,
            },
          },
        };
      },
      transformPage: (page) => page,
    });

    const storage = getPaginatedResultStorage(result);
    assert.ok(storage);
    assert.equal(storage.candidateCount, totalCandidates);
    assert.ok(storage.spoolBytes > 64 * 1024 * 1024);
    assert.equal(result.data.scan.candidateCount, totalCandidates);
    assert.equal(Object.hasOwn(result.data, "subjects"), false);
    const saved = JSON.parse(fs.readFileSync(checkpoint, "utf8"));
    assert.equal(saved.candidateCount, totalCandidates);
    assert.equal(Object.hasOwn(saved, "items"), false);
    assert.ok(fs.statSync(checkpoint).size < 16 * 1024);
    assert.equal(fs.statSync(saved.spoolPath).size, saved.spoolBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("admin JSON readers support purpose-specific bounded file caps", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "lumine-large-checkpoint-"),
  );
  const checkpoint = path.join(dir, "checkpoint.json");
  const payload = "x".repeat(2 * 1024 * 1024 + 1);
  fs.writeFileSync(checkpoint, JSON.stringify({ payload }));

  assert.throws(
    () => readAdminJsonFile(checkpoint, "the ordinary JSON input"),
    /under 2 MB/,
  );
  assert.equal(
    readAdminJsonFile(checkpoint, "the pagination checkpoint", {
      maxBytes: 4 * 1024 * 1024,
    }).payload.length,
    payload.length,
  );
});

test("admin JSON writes clean exclusive randomized staging files on failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-json-write-"));
  const output = path.join(dir, "occupied");
  fs.mkdirSync(output);

  assert.throws(() => writeAdminJsonFile(output, { secret: true }));
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.startsWith("occupied.tmp-")),
    [],
  );

  const source = fs.readFileSync(
    path.resolve(__dirname, "../lib/admin-news.js"),
    "utf8",
  );
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /flag: "wx"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("managed Build review receipts bind comments to one confirmed artifact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-build-review-"));
  const receiptPath = path.join(dir, "review.json");
  const screenshotPath = path.join(dir, "runtime.png");
  fs.writeFileSync(screenshotPath, "confirmed screenshot evidence");
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      schemaVersion: 2,
      status: "confirmed",
      reviewMethod: "runtime",
      buildId: 884,
      publishedArtifactVersionId: 4512,
      versionAfterReview: 4512,
      versionStable: true,
      browser: { runtimeReadiness: { ready: true } },
      screenshot: {
        path: screenshotPath,
        bytes: fs.statSync(screenshotPath).size,
      },
    }),
  );
  assert.equal(parseBuildReviewReceipt(receiptPath).buildId, 884);
  const commentPath = path.join(dir, "comment.md");
  const contextPath = path.join(dir, "context.json");
  fs.writeFileSync(commentPath, "The navigation felt clear and deliberate.");
  fs.writeFileSync(
    contextPath,
    JSON.stringify({
      understanding:
        "The published runtime opens on a navigation screen with three clearly labeled destinations.",
    }),
  );
  const operation = parseAdminOperation(
    parseArgs([
      "admin",
      "comment",
      "draft",
      "build:884",
      "--file",
      commentPath,
      "--review-receipt",
      receiptPath,
      "--review-context",
      contextPath,
    ]),
  );
  assert.equal(operation.body.reviewedBuildVersionId, 4512);
  assert.equal(operation.body.buildReviewMethod, "runtime");
  assert.equal(
    operation.body.buildReviewUnderstanding,
    "The published runtime opens on a navigation screen with three clearly labeled destinations.",
  );
  assert.equal(
    parseAdminOperation(parseArgs(["admin", "builds", "review", "884"]))
      .buildId,
    884,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("operator view filter narrows lists without hiding unknown state", () => {
  const result = {
    ok: true,
    status: "success",
    data: {
      items: [
        { contentId: 1, operatorViewed: { viewed: true } },
        { contentId: 2, operatorViewed: { viewed: false } },
        // Older deployed API: no field at all. Must be kept, never silently
        // dropped, so the filter can only ever be too inclusive.
        { contentId: 3 },
      ],
    },
  };

  const unviewed = filterListResultByOperatorView({
    result,
    viewFilter: "unviewed",
  });
  assert.deepEqual(
    unviewed.data.items.map((item) => item.contentId),
    [2, 3],
  );
  assert.equal(unviewed.data.operatorViewFilter.excludedItems, 1);
  assert.equal(unviewed.data.operatorViewFilter.unknownStateItems, 1);

  const viewed = filterListResultByOperatorView({
    result,
    viewFilter: "viewed",
  });
  assert.deepEqual(
    viewed.data.items.map((item) => item.contentId),
    [1, 3],
  );

  // No flag leaves the payload untouched.
  assert.equal(
    filterListResultByOperatorView({ result, viewFilter: null }),
    result,
  );
});

test("operator view filter narrows comment lists too", () => {
  const result = {
    ok: true,
    status: "success",
    data: {
      comments: [
        { id: 1, operatorViewed: { viewed: true } },
        { id: 2, operatorViewed: { viewed: false } },
      ],
    },
  };
  const filtered = filterListResultByOperatorView({
    result,
    viewFilter: "unviewed",
  });
  assert.deepEqual(
    filtered.data.comments.map((comment) => comment.id),
    [2],
  );
});

test("operator view filter flags are mutually exclusive", () => {
  assert.equal(
    parseOperatorViewFilter({ unviewed: true, viewed: false }),
    "unviewed",
  );
  assert.equal(
    parseOperatorViewFilter({ unviewed: false, viewed: true }),
    "viewed",
  );
  assert.equal(
    parseOperatorViewFilter({ unviewed: false, viewed: false }),
    null,
  );
  assert.throws(
    () => parseOperatorViewFilter({ unviewed: true, viewed: true }),
    /either --unviewed or --viewed/,
  );
});

test("operator view filters reject unsupported commands before authentication or requests", () => {
  const supported = parseAdminOperation(
    parseArgs(["admin", "subjects", "candidates", "--unviewed"]),
  );
  assert.equal(
    resolveOperatorViewFilter({
      operation: supported,
      unviewed: true,
      viewed: false,
    }),
    "unviewed",
  );
  const mutation = parseAdminOperation(
    parseArgs(["admin", "post", "reward", "comment:8", "--twinkles", "3"]),
  );
  assert.throws(
    () =>
      resolveOperatorViewFilter({
        operation: mutation,
        unviewed: true,
        viewed: false,
      }),
    /only by admin content-list commands/,
  );
});

test("unsupported operator view filters fail before admin authentication", async () => {
  await assert.rejects(
    () =>
      adminCommand(
        parseArgs([
          "admin",
          "post",
          "reward",
          "comment:8",
          "--twinkles",
          "3",
          "--unviewed",
        ]),
      ),
    /only by admin content-list commands/,
  );
});

test("--unviewed and --viewed parse as boolean flags", () => {
  const parsed = parseArgs([
    "admin",
    "subjects",
    "candidates",
    "--unviewed",
    "--json",
  ]);
  assert.equal(parsed.adminUnviewed, true);
  assert.equal(parsed.adminViewed, false);
  assert.equal(parsed.json, true);
});

test("sponsor administration commands preserve their audited targets and decisions", () => {
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "sponsor",
        "applications",
        "review",
        "12",
        "--decision",
        "approve",
        "--note",
        "Probationary approval",
      ]),
    ),
    {
      name: "sponsor.application.review",
      method: "POST",
      path: "/cli/admin/sponsors/applications/12/review",
      body: { decision: "approve", note: "Probationary approval" },
      mutates: true,
    },
  );

  const integrityReview = parseAdminOperation(
    parseArgs([
      "admin",
      "sponsor",
      "integrity",
      "review",
      "34",
      "--decision",
      "disqualify",
      "--note",
      "Artifact mismatch",
    ]),
  );
  assert.equal(
    integrityReview.path,
    "/cli/admin/daily-runs/sponsor-integrity/cases/34/review",
  );
  assert.deepEqual(integrityReview.body, {
    decision: "disqualify",
    note: "Artifact mismatch",
  });
});
