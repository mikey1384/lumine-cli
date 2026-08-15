import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../lib/commands.js";
import { LUMINE_AGENT_INSTRUCTIONS } from "../lib/constants.js";
import {
  buildForumScopeKey,
  isRetryableForumListenerError,
  readCompleteBuildForumSnapshot,
} from "../lib/forum.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../bin/lumine.js");

test("Forum commands parse read, listen, targets, and strict cursor options", () => {
  const read = parseArgs(["forum", "884", "--json"]);
  assert.equal(read.forumAction, "read");
  assert.equal(read.target, "884");
  assert.equal(read.forumCursor, 0);

  const explicitRead = parseArgs(["forum", "read", "884", "--cursor", "9"]);
  assert.equal(explicitRead.forumAction, "read");
  assert.equal(explicitRead.target, "884");
  assert.equal(explicitRead.forumCursor, 9);

  const listen = parseArgs([
    "forum",
    "listen",
    "https://www.twin-kle.com/build/884/4",
    "--poll-ms",
    "1500",
  ]);
  assert.equal(listen.forumAction, "listen");
  assert.equal(listen.target, "https://www.twin-kle.com/build/884/4");
  assert.equal(listen.forumPollMs, 1500);

  assert.equal(parseArgs(["forum", "--cursor", "oops"]).forumCursor, null);
  assert.equal(parseArgs(["forum", "--poll-ms", "999"]).forumPollMs, null);
});

test("pulled project guides tell agents to read and listen to the Team Forum", () => {
  assert.match(LUMINE_AGENT_INSTRUCTIONS, /lumine forum --json/);
  assert.match(LUMINE_AGENT_INSTRUCTIONS, /lumine forum listen --json/);
  assert.match(
    LUMINE_AGENT_INSTRUCTIONS,
    /branch contributors receive their branch plus[\s\S]*project-owner post and reply on Main/,
  );
});

test("complete Forum reads keep one snapshot cursor across every page", async () => {
  const requests = [];
  const snapshot = await readCompleteBuildForumSnapshot({
    options: { limit: 2 },
    auth: { token: "test" },
    buildId: 884,
    loadPage: async (request) => {
      requests.push(request);
      if (request.afterActivitySeq === 0) {
        return forumPage({
          events: [forumEvent(1, "thread"), forumEvent(2, "reply")],
          hasMore: true,
          nextActivitySeq: 2,
          snapshotActivitySeq: 5,
        });
      }
      return forumPage({
        events: [forumEvent(4, "thread")],
        hasMore: false,
        nextActivitySeq: 5,
        snapshotActivitySeq: 5,
      });
    },
  });

  assert.deepEqual(
    requests.map((request) => [
      request.afterActivitySeq,
      request.snapshotActivitySeq,
    ]),
    [
      [0, 0],
      [2, 5],
    ],
  );
  assert.deepEqual(
    snapshot.events.map((event) => event.activitySeq),
    [1, 2, 4],
  );
  assert.equal(snapshot.pagination.nextActivitySeq, 5);
  assert.equal(snapshot.scopeKey, "all:884:884:0");
});

test("Forum snapshot failures never manufacture progress and scope changes are fatal", async () => {
  let calls = 0;
  await assert.rejects(
    readCompleteBuildForumSnapshot({
      options: { limit: 1 },
      auth: { token: "test" },
      buildId: 884,
      loadPage: async () => {
        calls += 1;
        if (calls === 1) {
          return forumPage({
            events: [forumEvent(1, "thread")],
            hasMore: true,
            nextActivitySeq: 1,
            snapshotActivitySeq: 2,
          });
        }
        throw new Error("temporary network failure");
      },
    }),
    /temporary network failure/,
  );
  assert.equal(calls, 2);

  await assert.rejects(
    readCompleteBuildForumSnapshot({
      options: { limit: 10 },
      auth: { token: "test" },
      buildId: 884,
      expectedScopeKey: "branch:884:901:901",
      loadPage: async () => forumPage({ scope: mainScope() }),
    }),
    /workspace changed; restart the listener/,
  );
  assert.equal(isRetryableForumListenerError({ status: 503 }), true);
  assert.equal(isRetryableForumListenerError({ status: 403 }), false);
  assert.equal(isRetryableForumListenerError({ retryable: false }), false);
});

test("CLI Forum JSON output contains the full server-confirmed history", async (t) => {
  const fixture = await createFixtureServer(t);
  const result = await runCli([
    "forum",
    "884",
    "--limit",
    "2",
    "--json",
    ...fixture.cliArgs,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.type, "forum.snapshot");
  assert.deepEqual(
    output.events.map((event) => event.activitySeq),
    [1, 2, 4],
  );
  assert.deepEqual(output.cursor, {
    fromActivitySeq: 0,
    throughActivitySeq: 5,
  });
  assert.deepEqual(fixture.forumRequests, [
    { afterActivitySeq: "0", snapshotActivitySeq: null, limit: "2" },
    { afterActivitySeq: "2", snapshotActivitySeq: "5", limit: "2" },
  ]);
});

function mainScope() {
  return {
    mode: "all",
    rootBuildId: 884,
    workspaceBuildId: 884,
    contributionBuildId: null,
  };
}

function forumEvent(activitySeq, type) {
  return {
    type,
    activitySeq,
    id: 100 + activitySeq,
    threadId: type === "thread" ? 100 + activitySeq : 100,
    threadTitle: "Canonical plan",
    body: `Forum body ${activitySeq}`,
    author: { userId: 7, username: "owner", role: "user" },
    branch: null,
    replyTo: null,
    eventType: null,
    subjectBuildId: null,
    createdAt: 1000 + activitySeq,
  };
}

function forumPage({
  events = [],
  hasMore = false,
  nextActivitySeq = 0,
  snapshotActivitySeq = 0,
  scope = mainScope(),
} = {}) {
  return {
    project: {
      id: 884,
      title: "Team project",
      ownerUserId: 7,
      ownerUsername: "owner",
    },
    requestedBuildId: 884,
    scope,
    events,
    pagination: {
      limit: 100,
      snapshotActivitySeq,
      nextActivitySeq,
      hasMore,
    },
  };
}

async function createFixtureServer(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-forum-"));
  const authFile = path.join(tmpDir, "auth.json");
  const forumRequests = [];
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/cli/session") {
      res.end(
        JSON.stringify({
          userId: 7,
          username: "owner",
          scopes: ["build:read"],
        }),
      );
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/cli/build/884/forum?")) {
      const url = new URL(req.url, "http://127.0.0.1");
      const request = {
        afterActivitySeq: url.searchParams.get("afterActivitySeq"),
        snapshotActivitySeq: url.searchParams.get("snapshotActivitySeq"),
        limit: url.searchParams.get("limit"),
      };
      forumRequests.push(request);
      if (request.afterActivitySeq === "0") {
        res.end(
          JSON.stringify(
            forumPage({
              events: [forumEvent(1, "thread"), forumEvent(2, "reply")],
              hasMore: true,
              nextActivitySeq: 2,
              snapshotActivitySeq: 5,
            }),
          ),
        );
        return;
      }
      res.end(
        JSON.stringify(
          forumPage({
            events: [forumEvent(4, "thread")],
            hasMore: false,
            nextActivitySeq: 5,
            snapshotActivitySeq: 5,
          }),
        ),
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
    forumRequests,
    cliArgs: [
      "--api-url",
      apiUrl,
      "--auth-file",
      authFile,
      "--no-update-check",
    ],
  };
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

test("Forum scope keys reject malformed branch identities", () => {
  assert.throws(
    () =>
      buildForumScopeKey({
        mode: "branch",
        rootBuildId: 884,
        workspaceBuildId: 901,
        contributionBuildId: 902,
      }),
    /does not match its contribution workspace/,
  );
});
