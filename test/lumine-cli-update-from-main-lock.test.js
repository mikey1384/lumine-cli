import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { updateBranchFromMain } from "../lib/commands.js";
import { testWorkRoot } from "./helpers/work-directory.js";

// Mikey 11-07: no Update from Main while Lumine works on the branch. The CLI
// uses the same server endpoint as the website, which refuses before writing
// anything; the CLI says so in plain words.
test("update-from-main stops with a plain message while a Lumine run is active", async (t) => {
  const dir = mkdtempSync(path.join(testWorkRoot(), "update-from-main-lock-"));
  const original = globalThis.fetch;
  const requests = [];
  const bodies = [];
  t.after(() => {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    requests.push(`${init.method || "GET"} ${new URL(href).pathname}`);
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    if (href.endsWith("/cli/session")) {
      return Response.json({ scopes: ["build:write"] });
    }
    if (href.includes("/cli/build/2794/files")) {
      return Response.json({ build: { id: 2794, contributionRootBuildId: 2 }, projectFiles: [] });
    }
    if (href.endsWith("/build/2/contributions/2794/update-from-main")) {
      return Response.json(
        { error: "Wait for Lumine to finish first. Then update this branch from Main.", code: "build_lumine_run_active" },
        { status: 409 },
      );
    }
    throw new Error(`unexpected request ${href}`);
  };
  await assert.rejects(
    updateBranchFromMain({
      apiUrl: "https://fixture.invalid",
      authToken: "token",
      target: "2794",
      dir,
      timeoutMs: 1000,
    }),
    /^Error: Wait for Lumine to finish first\. .*rerun with --stop-lumine.*Nothing was changed\./,
  );
  assert.deepEqual(requests.at(-1), "POST /build/2/contributions/2794/update-from-main");
  assert.equal(bodies.at(-1).stopActiveRun, undefined, "no stop without the flag");
});

test("update-from-main --stop-lumine asks the server to stop the run first", async (t) => {
  const dir = mkdtempSync(path.join(testWorkRoot(), "update-from-main-stop-"));
  const original = globalThis.fetch;
  let body = null;
  t.after(() => {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.endsWith("/cli/session")) return Response.json({ scopes: ["build:write"] });
    if (href.includes("/cli/build/2794/files")) {
      return Response.json({ build: { id: 2794, contributionRootBuildId: 2 }, projectFiles: [] });
    }
    if (href.endsWith("/build/2/contributions/2794/update-from-main")) {
      body = JSON.parse(String(init.body || "{}"));
      return Response.json({ success: true, projectFiles: [], filesHash: "h" });
    }
    throw new Error(`unexpected request ${href}`);
  };
  const { parseArgs, updateBranchFromMain: run } = await import("../lib/commands.js");
  const parsed = parseArgs(["update-from-main", "2794", "--stop-lumine"]);
  assert.equal(parsed.stopLumine, true);
  await run({ apiUrl: "https://fixture.invalid", authToken: "token", target: "2794", dir, timeoutMs: 1000, stopLumine: true });
  assert.equal(body.stopActiveRun, true);
});
