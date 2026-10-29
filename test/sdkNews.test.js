import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));

async function withNewsServer(run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ canonical: true, url: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const invoke = (method, args, extra = []) => exec(process.execPath, [cli, "sdk", "call", method, JSON.stringify(args),
    "--build", "1929", "--auth-token", "must-not-be-sent", "--api-url", `http://127.0.0.1:${server.address().port}`,
    "--no-update-check", "--json", ...extra], { timeout: 10000 });
  try { await run({ calls, invoke }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("newspaper SDK reads use exact public GET routes and never send login or mint a token", async () => {
  await withNewsServer(async ({ calls, invoke }) => {
    for (const [method, args, url] of [
      ["news.getCurrentEdition", {}, "/build/1929/news/current"],
      ["news.listEditions", { limit: 12, cursor: "older+edition&day=1" }, "/build/1929/news/editions?limit=12&cursor=older%2Bedition%26day%3D1"],
      ["news.listEditions", { limit: 100 }, "/build/1929/news/editions?limit=30"],
      ["news.getEdition", { dayIndex: 1762 }, "/build/1929/news/editions/1762"],
      ["news.getEdition", { dayIndex: 1762, revisionNumber: 1 }, "/build/1929/news/editions/1762?revision=1"],
      ["news.getEdition", { dayIndex: 0, revisionNumber: null }, "/build/1929/news/editions/0"]
    ]) {
      const { stdout } = await invoke(method, args);
      assert.deepEqual(JSON.parse(stdout), { canonical: true, url });
    }
    assert.equal(calls.length, 6);
    for (const call of calls) {
      assert.equal(call.method, "GET");
      assert.equal(call.body, "");
      assert.equal(call.headers.authorization, undefined);
      assert.equal(call.headers["x-build-api-token"], undefined);
    }
  });
});

test("invalid newspaper selectors fail before any network or authentication request", async () => {
  await withNewsServer(async ({ calls, invoke }) => {
    for (const [method, args, pattern] of [
      ["news.getEdition", {}, /dayIndex is required/],
      ["news.getEdition", { dayIndex: "1762" }, /dayIndex is required/],
      ["news.getEdition", { dayIndex: -1 }, /dayIndex is required/],
      ["news.getEdition", { dayIndex: 1762, revisionNumber: 0 }, /revisionNumber/],
      ["news.getEdition", { dayIndex: 1762, revisionNumber: "1" }, /revisionNumber/],
      ["news.getEdition", { dayIndex: "../generate" }, /dayIndex is required/],
      ["news.getEdition", { dayIndex: 1762, refresh: true }, /Unexpected newspaper selector/],
      ["news.getCurrentEdition", { refresh: true }, /Unexpected newspaper selector/],
      ["news.listEditions", { limit: 0 }, /limit must be/],
      ["news.listEditions", { cursor: {} }, /cursor must be/]
    ]) await assert.rejects(invoke(method, args), pattern);
    await assert.rejects(invoke("news.getCurrentEdition", {}, ["--scopes", "content:read"]), /public read.*does not use --scopes/);
    assert.deepEqual(calls, []);
  });
});
