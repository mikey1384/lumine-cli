// `lumine preview` / `lumine test`: Lumine's own preview tools for agents
// working through the CLI. Synthetic fixtures and a stand-in API only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { COMMANDS, MAIN_CHECKOUT_READONLY_COMMANDS } from "../lib/constants.js";
import { parseArgs } from "../lib/commands.js";
import {
  formatTestReport,
  previewCommand,
  resolveTestArguments,
  testCommand,
} from "../lib/preview.js";
import { testWorkRoot } from "./helpers/work-directory.js";

function fixture(t, prefix) {
  const dir = mkdtempSync(path.join(testWorkRoot(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function stubApi(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader("content-type", "application/json");
    const { status = 200, payload } = respond(requests.at(-1));
    res.statusCode = status;
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, apiUrl: `http://127.0.0.1:${server.address().port}` };
}

async function workspace(dir, buildId = 55) {
  await fs.mkdir(path.join(dir, ".twinkle"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), "<main>unsaved edit</main>");
  await fs.writeFile(path.join(dir, ".twinkle", "lumine-project.json"), JSON.stringify({ schemaVersion: 1, buildId }));
}

function quiet(t) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  t.after(() => { console.log = original; process.exitCode = 0; });
  return lines;
}

test("preview and test are commands, read-only from a main checkout, and keep the test file out of the build target", () => {
  assert.ok(COMMANDS.has("preview") && COMMANDS.has("test"));
  assert.ok(MAIN_CHECKOUT_READONLY_COMMANDS.has("preview") && MAIN_CHECKOUT_READONLY_COMMANDS.has("test"));
  const options = parseArgs(["test", "map.test.json", "--viewport", "desktop", "--saved", "--build", "55", "--name", "map"]);
  assert.equal(options.command, "test");
  assert.equal(options.target, "");
  assert.deepEqual(options.positional, ["map.test.json"]);
  assert.equal(options.previewViewport, "desktop");
  assert.equal(options.previewSaved, true);
  assert.equal(options.previewName, "map");
  assert.equal(options.buildIdFlag, "55");
});

test("a test file or --steps becomes the run_preview_test arguments", async (t) => {
  const dir = fixture(t, "preview-args-");
  const file = path.join(dir, "t.json");
  await fs.writeFile(file, JSON.stringify({ name: "title", viewport: "desktop", steps: [{ type: "expect", text: "Play", state: "visible" }] }));
  assert.deepEqual(await resolveTestArguments({ positional: [file] }), {
    name: "title", viewport: "desktop", steps: [{ type: "expect", text: "Play", state: "visible" }],
  });
  const inline = await resolveTestArguments({ positional: [], previewSteps: '[{"type":"wait","durationMs":100}]', previewViewport: "phone" });
  assert.deepEqual(inline, { name: "test", viewport: "phone", steps: [{ type: "wait", durationMs: 100 }] });
  await assert.rejects(resolveTestArguments({ positional: [] }), /Give a test file or --steps/);
  await assert.rejects(resolveTestArguments({ positional: [], previewSteps: "[]" }), /non-empty steps/);
  await assert.rejects(resolveTestArguments({ positional: [], previewSteps: "[1]", previewViewport: "tablet" }), /phone or desktop/);
});

test("lumine test sends this workspace's files and reports each step; a failure saves the screenshot and exits 1", async (t) => {
  const dir = fixture(t, "preview-test-");
  await workspace(dir);
  const lines = quiet(t);
  const { requests, apiUrl } = await stubApi(t, () => ({ payload: {
    output: { ok: true, test: { name: "map scrolls", status: "failed", failedStep: 2, checked: [], meaning: "Failed at step 2.",
      steps: [{ step: 1, does: "touch (500,800) to (500,200)", result: "done" }, { step: 2, does: "selector #status in view", result: "failed", observed: "1 match(es), 0 fully in view" }] } },
    image: { mimeType: "image/jpeg", width: 390, height: 844, base64: Buffer.from("jpeg-bytes").toString("base64") },
    looks: 1, looksLeft: 7,
  } }));
  // Kept under .twinkle/tests/ so the test never becomes a project file.
  await fs.mkdir(path.join(dir, ".twinkle", "tests"), { recursive: true });
  const steps = path.join(dir, ".twinkle", "tests", "map.test.json");
  await fs.writeFile(steps, JSON.stringify({ name: "map scrolls", steps: [{ type: "touch", x: 500, y: 800, endX: 500, endY: 200 }, { type: "expect", selector: "#status", state: "in_view" }] }));
  await testCommand({ apiUrl, authToken: "tok", dir, positional: [steps], timeoutMs: 1000 });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/cli/build/55/preview-tool");
  assert.equal(request.auth, "Bearer tok");
  assert.equal(request.body.tool, "run_preview_test");
  assert.equal(request.body.arguments.viewport, "phone");
  assert.deepEqual(request.body.projectFiles, [{ path: "/index.html", content: "<main>unsaved edit</main>" }]);
  assert.equal(process.exitCode, 1);
  assert.match(lines.join("\n"), /Test "map scrolls": FAILED/);
  assert.match(lines.join("\n"), / 2\. \[FAIL\] selector #status in view \(saw: 1 match\(es\), 0 fully in view\)/);
  const shot = lines.find((line) => line.startsWith("Screenshot at the failed step: "))?.split(": ")[1];
  assert.ok(shot && shot.startsWith(path.join(dir, ".twinkle", "previews")), "kept out of the project files");
  assert.equal(await fs.readFile(shot, "utf8"), "jpeg-bytes");
});

test("lumine preview --saved sends no files and passes actions through", async (t) => {
  const dir = fixture(t, "preview-saved-");
  await workspace(dir);
  const lines = quiet(t);
  const { requests, apiUrl } = await stubApi(t, () => ({ payload: {
    output: { ok: true, interaction: { status: "completed", requested: 1, completed: 1 }, walk: { steps: "click (500,620)" } },
    image: { mimeType: "image/jpeg", width: 390, height: 844, base64: Buffer.from("x").toString("base64") }, looks: 1, looksLeft: 6,
  } }));
  const out = path.join(dir, "shot.jpg");
  await previewCommand({ apiUrl, authToken: "tok", dir, positional: [], previewSaved: true, out, timeoutMs: 1000,
    previewActions: '[{"type":"click","x":500,"y":620}]', previewFocus: "map" });
  assert.equal(requests[0].body.tool, "view_preview");
  assert.equal("projectFiles" in requests[0].body, false);
  assert.deepEqual(requests[0].body.arguments, { viewport: "phone", focus: "map", actions: [{ type: "click", x: 500, y: 620 }] });
  assert.equal(await fs.readFile(out, "utf8"), "x");
  assert.match(lines.join("\n"), /Walk: click \(500,620\)/);
  assert.notEqual(process.exitCode, 1);
});

test("a rate-limited preview surfaces the API's plain message", async (t) => {
  const dir = fixture(t, "preview-limit-");
  await workspace(dir);
  quiet(t);
  const { apiUrl } = await stubApi(t, () => ({ status: 429, payload: { error: "You have used the 8 preview looks allowed in 10 minutes", code: "lumine_cli_preview_rate_limited" } }));
  await assert.rejects(previewCommand({ apiUrl, authToken: "tok", dir, positional: [], timeoutMs: 1000 }), /8 preview looks/);
});

test("the report never claims more than the listed checks", () => {
  const lines = formatTestReport({ test: { name: "t", status: "passed", steps: [{ step: 1, does: 'text "Play" visible', result: "passed" }], meaning: "Passed: these 1 check(s) held." } });
  assert.deepEqual(lines, ['Test "t": PASSED', '   1. [PASS] text "Play" visible', "Passed: these 1 check(s) held."]);
  assert.deepEqual(formatTestReport({ ok: false, error: "A test needs 1 to 24 steps." }), ["A test needs 1 to 24 steps."]);
});
