import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  SDK_CLI_READ_SCOPES,
  SDK_CLI_METHOD_NAMES_BY_PATH,
  SDK_CLI_METHODS,
} from "../lib/sdk.js";

test("CLI arena and private compare-and-set mappings preserve exact scopes and mutation gates", () => {
  for (const [name, route, scope, writing] of [
    [
      "privateDb.compareAndSet",
      "private-db/compare-and-set",
      "privateDb:write",
      true,
    ],
    ["arena.board", "arena/board", "sharedDb:read", false],
    ["arena.publish", "arena/publish", "sharedDb:write", true],
    ["arena.challenge", "arena/challenge", "sharedDb:write", true],
    ["arena.bouts", "arena/bouts", "sharedDb:read", false],
    ["arena.getBout", "arena/get-bout", "sharedDb:read", false],
  ]) {
    assert.deepEqual(SDK_CLI_METHODS[name], {
      path: `api/${route}`,
      scopes: [scope],
      ...(writing ? { write: true } : {}),
    });
    assert.deepEqual(SDK_CLI_METHOD_NAMES_BY_PATH.get(`api/${route}`), [name]);
  }
});

test("CLI receipt recovery is read-only and requires the current published runtime grant", async () => {
  const calls = [];
  let grant = "published-grant";
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({
      url: req.url,
      body: text ? JSON.parse(text) : null,
      headers: req.headers,
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/cli/session")
      return res.end(JSON.stringify({ scopes: ["build:sdk"] }));
    if (req.url === "/build/884/runtime?runtimeSource=published")
      return res.end(
        JSON.stringify({ build: { id: 884, rewardRuntimeGrant: grant } }),
      );
    if (req.url === "/build/884/api/token")
      return res.end(
        JSON.stringify({ token: "build-token", scopes: ["rewards:claim"] }),
      );
    if (req.url === "/build/884/api/rewards/receipt")
      return res.end(
        JSON.stringify({
          mode: "live",
          status: "awarded",
          receipt: { id: 7, challengeId: "previous-day-challenge" },
          balances: { xp: 100, coins: 10 },
        }),
      );
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cli = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));
    const args = [
      cli,
      "sdk",
      "call",
      "rewards.getReceipt",
      JSON.stringify({
        challengeId: "previous-day-challenge",
        answers: [1],
        operation: "claim",
      }),
      "--build",
      "884",
      "--auth-token",
      "fixture-login",
      "--api-url",
      `http://127.0.0.1:${server.address().port}`,
      "--no-update-check",
      "--json",
    ];
    const { stdout } = await promisify(execFile)(process.execPath, args, {
      timeout: 10000,
    });
    assert.match(stdout, /previous-day-challenge/);
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "/cli/session",
        "/build/884/runtime?runtimeSource=published",
        "/build/884/api/token",
        "/build/884/api/rewards/receipt",
      ],
    );
    assert.deepEqual(calls.at(-1).body, {
      challengeId: "previous-day-challenge",
    });
    assert.equal(
      calls.at(-1).headers["x-build-reward-runtime"],
      "published-grant",
    );
    assert.equal(calls.at(-1).headers["x-build-api-token"], "build-token");
    calls.length = 0;
    grant = null;
    await assert.rejects(
      promisify(execFile)(process.execPath, args, { timeout: 10000 }),
      /no published-runtime reward grant/,
    );
    assert.deepEqual(
      calls.map((call) => call.url),
      ["/cli/session", "/build/884/runtime?runtimeSource=published"],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CLI exposes protected sharedDb batch methods with fail-closed scopes", () => {
  assert.deepEqual(SDK_CLI_METHODS["sharedDb.getEntriesByIds"], {
    path: "api/shared-db/entries/by-ids",
    scopes: ["sharedDb:read"],
  });
  assert.deepEqual(SDK_CLI_METHODS["sharedDb.addEntries"], {
    path: "api/shared-db/entries/batch",
    scopes: ["sharedDb:write"],
    write: true,
  });
  assert.deepEqual(SDK_CLI_METHODS["sharedDb.deleteEntries"], {
    path: "api/shared-db/entries/delete",
    scopes: ["sharedDb:write"],
    write: true,
  });

  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/shared-db/entries/by-ids"),
    ["sharedDb.getEntriesByIds"],
  );
  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/shared-db/entries/batch"),
    ["sharedDb.addEntries"],
  );
  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/shared-db/entries/delete"),
    ["sharedDb.deleteEntries"],
  );
});

test("CLI exposes canonical Lumine media and live diagnostics", () => {
  assert.deepEqual(SDK_CLI_METHODS["media.getUsage"], {
    path: "api/media/usage",
    scopes: ["media:read"],
    sdkReshape: "the SDK returns the mediaEnergy object directly",
  });
  assert.deepEqual(SDK_CLI_METHODS["live.list"], {
    path: "api/live/list",
    scopes: ["live:read"],
    sdkReshape: "the SDK returns the sessions array directly",
  });
  assert.deepEqual(SDK_CLI_METHODS["live.stop"], {
    path: "api/live/stop",
    scopes: ["live:write"],
    write: true,
  });
  assert.deepEqual(SDK_CLI_METHODS["live.listReplays"], {
    path: "api/live/replays/list",
    scopes: ["live:read"],
    sdkReshape: "the SDK returns the replays array directly",
  });
  assert.deepEqual(SDK_CLI_METHODS["live.getReplay"], {
    path: "api/live/replays/status",
    scopes: ["live:read"],
    sdkReshape: "the SDK returns the replay object directly",
  });
  assert.deepEqual(SDK_CLI_METHODS["live.deleteReplay"], {
    path: "api/live/replays/delete",
    scopes: ["live:write"],
    write: true,
  });
  assert.equal(SDK_CLI_READ_SCOPES.includes("media:read"), true);
  assert.equal(SDK_CLI_READ_SCOPES.includes("live:read"), true);
  assert.deepEqual(SDK_CLI_METHOD_NAMES_BY_PATH.get("api/live/list"), [
    "live.list",
  ]);
  assert.deepEqual(SDK_CLI_METHOD_NAMES_BY_PATH.get("api/live/replays/list"), [
    "live.listReplays",
  ]);
  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/live/replays/status"),
    ["live.getReplay"],
  );
  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/live/replays/delete"),
    ["live.deleteReplay"],
  );
});

test("CLI exposes Twinkle.rewards through the server-verified reward endpoints only", async () => {
  const { isWriteCapableScope, loadRewardRuntimeGrant } =
    await import("../lib/sdk.js");
  // getStatus is read-only for the build owner: the endpoint accepts only
  // rewards:claim, so that scope is minted, but the method is not write-gated.
  assert.equal(SDK_CLI_METHODS["rewards.getStatus"].path, "api/rewards/status");
  assert.equal(SDK_CLI_METHODS["rewards.getStatus"].special, "rewards");
  assert.equal(SDK_CLI_METHODS["rewards.getStatus"].operation, "status");
  assert.deepEqual(SDK_CLI_METHODS["rewards.getStatus"].scopes, [
    "rewards:claim",
  ]);
  assert.equal(SDK_CLI_METHODS["rewards.getStatus"].readOnly, true);
  assert.equal(SDK_CLI_METHODS["rewards.getStatus"].write, undefined);
  assert.deepEqual(
    SDK_CLI_METHODS["rewards.getStatus"].mapArgs({ junk: 1 }),
    {},
  );
  // start/claim mutate real XP/Coins state and stay behind --allow-write.
  for (const [name, operation, args, body] of [
    [
      "rewards.start",
      "start",
      { ruleId: "daily", extra: true },
      { ruleId: "daily" },
    ],
    [
      "rewards.claim",
      "claim",
      { challengeId: "c1", answers: [1, 2], extra: true },
      { challengeId: "c1", answers: [1, 2] },
    ],
  ]) {
    const entry = SDK_CLI_METHODS[name];
    assert.equal(entry.path, `api/rewards/${operation}`);
    assert.equal(entry.special, "rewards");
    assert.equal(entry.operation, operation);
    assert.deepEqual(entry.scopes, ["rewards:claim"]);
    assert.equal(entry.write, true);
    assert.deepEqual(entry.mapArgs(args), body);
  }
  // Raw --path cannot bypass the curated handling.
  for (const operation of ["status", "receipt", "start", "claim"]) {
    assert.equal(
      SDK_CLI_METHOD_NAMES_BY_PATH.get(`api/rewards/${operation}`).length,
      1,
    );
  }
  // rewards:claim is never part of the default read scope set, and an
  // explicit --scopes override naming it counts as write-capable.
  assert.equal(SDK_CLI_READ_SCOPES.includes("rewards:claim"), false);
  assert.equal(isWriteCapableScope("rewards:claim"), true);
  assert.equal(isWriteCapableScope("content:read"), false);

  // The published-runtime grant comes from the canonical runtime payload and
  // is never fabricated locally; without it nothing is called.
  const options = { apiUrl: "https://api.example.test", timeoutMs: 1000 };
  const auth = { token: "login" };
  const calls = [];
  const grant = await loadRewardRuntimeGrant({
    options,
    auth,
    buildId: 884,
    methodName: "rewards.getStatus",
    request: async (args) => {
      calls.push(args);
      return { build: { id: 884, rewardRuntimeGrant: "grant.jwt" } };
    },
  });
  assert.equal(grant, "grant.jwt");
  assert.deepEqual(calls, [
    {
      url: "https://api.example.test/build/884/runtime?runtimeSource=published",
      authToken: "login",
      timeoutMs: 1000,
    },
  ]);
  await assert.rejects(
    loadRewardRuntimeGrant({
      options,
      auth,
      buildId: 884,
      methodName: "rewards.getStatus",
      request: async () => ({ build: { id: 884, rewardRuntimeGrant: null } }),
    }),
    /no published-runtime reward grant for build 884/,
  );
});
