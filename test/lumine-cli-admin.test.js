import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  filterListResultByOperatorView,
  filterRecommendationQueueResult,
  formatAdminJsonError,
  parseAdminOperation,
  parseOperatorViewFilter,
  parseRecommendationContentTypes,
  parseRecommendationTarget,
  resolveOperatorViewFilter,
} from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

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
        parseArgs([
          "admin",
          "comment",
          "draft",
          "42",
          "--file",
          tooLongPath,
        ]),
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

test("existing public command parsing is unaffected", () => {
  const workspace = parseArgs(["884"]);
  assert.equal(workspace.command, "workspace");
  assert.equal(workspace.target, "884");
  const save = parseArgs(["save", "--publish"]);
  assert.equal(save.command, "save");
  assert.equal(save.publish, true);
});

async function createFixtureServer(
  t,
  { adminError = null, runStatusResponse = null } = {},
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
