import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("shared reward runs require a write opt-in and the canonical published grant", async () => {
  const calls = [];
  let grant = "canonical-published-grant";
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    calls.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
    res.setHeader("content-type", "application/json");
    if (req.url === "/cli/session") return res.end(JSON.stringify({ scopes: ["build:sdk"] }));
    if (req.url === "/build/884/runtime?runtimeSource=published")
      return res.end(JSON.stringify({ build: { rewardRuntimeGrant: grant } }));
    if (req.url === "/build/884/api/token")
      return res.end(JSON.stringify({ token: "canonical-token", scopes: ["rewards:claim"] }));
    if (req.url === "/build/884/api/rewards/start-run")
      return res.end(JSON.stringify({ mode: "live", run: { id: "canonical-run" }, challenges: [] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const cli = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));
  const args = [cli, "sdk", "call", "rewards.startRun", JSON.stringify({
    proofGroup: "tetris", requestId: "stable-start-id", userId: 999, seed: "forged",
    runtimeGrant: "forged-grant", sourceHash: "forged", xp: 9000, operation: "claim"
  }), "--build", "884", "--auth-token", "fixture-login", "--api-url",
  `http://127.0.0.1:${server.address().port}`, "--no-update-check", "--json"];
  const invoke = extra => promisify(execFile)(process.execPath, [...args, ...extra], { timeout: 10000 });
  try {
    await assert.rejects(invoke([]), /allow-write/);
    assert.deepEqual(calls, []);
    const { stdout } = await invoke(["--allow-write"]);
    assert.equal(JSON.parse(stdout).run.id, "canonical-run");
    assert.deepEqual(calls.map(call => call.url), ["/cli/session",
      "/build/884/runtime?runtimeSource=published", "/build/884/api/token", "/build/884/api/rewards/start-run"]);
    assert.deepEqual(calls.at(-1).body, { proofGroup: "tetris", requestId: "stable-start-id" });
    assert.equal(calls.at(-1).headers["x-build-reward-runtime"], grant);
    assert.equal(calls.at(-1).headers["x-build-api-token"], "canonical-token");
    calls.length = 0; grant = null;
    await assert.rejects(invoke(["--allow-write"]), /no published-runtime reward grant/);
    assert.deepEqual(calls.map(call => call.url), ["/cli/session", "/build/884/runtime?runtimeSource=published"]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
