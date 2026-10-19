import assert from "node:assert/strict";
import fs from "node:fs";
import { testWorkRoot } from "./helpers/work-directory.js";
import path from "node:path";
import test from "node:test";

import {
  KEY_DEFINITIONS,
  MAX_INTERACTION_STEPS,
  MAX_INTERACTION_TOTAL_MS,
  MAX_INTERACTION_WAIT_MS,
  keyDefinition,
  parseBuildReviewReceipt,
  parseInteractionScript,
  classifyReviewBrowserExit,
  resolveAppFrame,
  runInteractionSteps,
  runManagedBuildReview,
} from "../lib/build-review.js";
import http from "node:http";
import { parseArgs } from "../lib/commands.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(testWorkRoot(), "lumine-build-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeScript(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const PNG = Buffer.from("png-bytes").toString("base64");
const FRAME_SRC = "https://preview.example.test/build/884/runtime";

// A fake Chrome DevTools pipe: records every command and answers the few the
// interaction runner needs. Elements live in a tiny in-memory "frame".
function fakeCdp({ elements = {}, frameRect = { left: 100, top: 50, width: 800, height: 600 } } = {}) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}, sessionId = "") {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        const expression = String(params.expression);
        if (expression.includes("frame.getBoundingClientRect()")) {
          return {
            result: {
              value: { ...frameRect, src: FRAME_SRC, sameOriginDocument: false },
            },
          };
        }
        if (expression.includes("frame.focus()")) {
          return { result: { value: true } };
        }
        const selectorMatch = expression.match(/const selector = (".*?");\n/);
        const selector = selectorMatch ? JSON.parse(selectorMatch[1]) : "";
        const element = elements[selector];
        return {
          result: {
            value: element
              ? { found: true, ...element }
              : { found: false, reason: "not-found" },
          },
        };
      }
      if (method === "Page.captureScreenshot") return { data: PNG };
      return {};
    },
  };
}

const frame = {
  sessionId: "frame-session",
  documentExpression: "document",
  via: "child-target",
  url: FRAME_SRC,
};

test("--interact scripts are bounded, typed, and validated before any browser work", (t) => {
  const dir = fixture(t);
  const parsed = parseInteractionScript(
    writeScript(dir, "ok.json", {
      steps: [
        { click: "text=Start" },
        { wait: 500 },
        { screenshot: "after-start" },
        { type: { selector: "input[name=name]", text: "Zero" } },
        { press: "Enter" },
        { press: " " },
        { press: "a" },
        { press: "7" },
        { screenshot: "end" },
      ],
    }),
  );
  assert.equal(parsed.path, path.join(dir, "ok.json"));
  assert.deepEqual(parsed.steps, [
    { kind: "click", selector: "text=Start" },
    { kind: "wait", ms: 500 },
    { kind: "screenshot", label: "after-start" },
    { kind: "type", selector: "input[name=name]", text: "Zero" },
    { kind: "press", key: "Enter" },
    { kind: "press", key: "Space" },
    { kind: "press", key: "a" },
    { kind: "press", key: "7" },
    { kind: "screenshot", label: "end" },
  ]);
  // A bare array is accepted too.
  assert.equal(
    parseInteractionScript(writeScript(dir, "array.json", [{ wait: 1 }])).steps
      .length,
    1,
  );

  const rejects = (name, value, pattern) =>
    assert.throws(
      () => parseInteractionScript(writeScript(dir, name, value)),
      (error) => {
        assert.equal(error.code, "CLI_ADMIN_BUILD_REVIEW_INTERACT_INVALID");
        assert.match(error.message, pattern);
        return true;
      },
    );
  rejects("empty.json", [], /non-empty/);
  rejects(
    "too-many.json",
    Array.from({ length: MAX_INTERACTION_STEPS + 1 }, () => ({ wait: 1 })),
    new RegExp(`at most ${MAX_INTERACTION_STEPS} steps`),
  );
  rejects("two-actions.json", [{ click: "a", wait: 1 }], /exactly one of/);
  rejects("unknown.json", [{ hover: "a" }], /exactly one of/);
  rejects(
    "long-wait.json",
    [{ wait: MAX_INTERACTION_WAIT_MS + 1 }],
    new RegExp(`between 1 and ${MAX_INTERACTION_WAIT_MS}`),
  );
  rejects("float-wait.json", [{ wait: 10.5 }], /wait/);
  rejects("bad-key.json", [{ press: "F5" }], /press/);
  rejects("empty-click.json", [{ click: "" }], /CSS selector or text=/);
  rejects("empty-text.json", [{ click: "text=   " }], /empty text=/);
  rejects("type-shape.json", [{ type: "hello" }], /needs \{ selector, text \}/);
  rejects(
    "multiline.json",
    [{ type: { selector: "input", text: "a\nb" } }],
    /single-line/,
  );
  rejects("reserved-label.json", [{ screenshot: "runtime" }], /unique label/);
  rejects("bad-label.json", [{ screenshot: "../x" }], /unique label/);
  rejects(
    "dup-label.json",
    [{ screenshot: "same" }, { screenshot: "SAME" }],
    /unique label/,
  );
  assert.equal(MAX_INTERACTION_TOTAL_MS, 60_000);
  assert.equal(keyDefinition("enter"), KEY_DEFINITIONS.Enter);
  assert.deepEqual(keyDefinition("Q"), {
    key: "q",
    code: "KeyQ",
    windowsVirtualKeyCode: 81,
    text: "q",
  });
  assert.equal(keyDefinition("F5"), null);

  // The option reaches the review path under its own name.
  assert.equal(
    parseArgs(["admin", "builds", "review", "build:884", "--interact", "steps.json"])
      .adminInteract,
    "steps.json",
  );
  assert.equal(parseArgs(["admin", "builds", "review", "build:884"]).adminInteract, "");
});

test("interaction steps run inside the app frame with trusted input, save labelled screenshots, and stop honestly at the first failure", async (t) => {
  const dir = fixture(t);
  const cdp = fakeCdp({
    elements: {
      "text=Start": { x: 40, y: 20, width: 80, height: 40, tag: "button", text: "start" },
      "input[name=name]": { x: 200, y: 300, width: 100, height: 20, tag: "input", text: "" },
    },
  });
  let clock = 1_000;
  const waited = [];
  const result = await runInteractionSteps({
    cdp,
    pageSessionId: "page-session",
    frame,
    steps: [
      { kind: "click", selector: "text=Start" },
      { kind: "wait", ms: 250 },
      { kind: "screenshot", label: "after-start" },
      { kind: "type", selector: "input[name=name]", text: "Zero" },
      { kind: "press", key: "Enter" },
      { kind: "screenshot", label: "submitted" },
    ],
    outputDir: dir,
    now: () => clock,
    wait: async (ms) => {
      waited.push(ms);
      clock += ms;
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.stepsPlanned, 6);
  assert.equal(result.stepsCompleted, 6);
  assert.equal(result.failedStep, null);
  assert.deepEqual(result.frame, { via: "child-target", url: FRAME_SRC });
  assert.deepEqual(waited, [250]);
  // Element lookups happen in the frame session; input is dispatched on the
  // page session at frame-offset coordinates (100+40, 50+20).
  const locate = cdp.calls.filter(
    (call) => call.method === "Runtime.evaluate" && call.sessionId === "frame-session",
  );
  assert.equal(locate.length, 2);
  const mouse = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.deepEqual(
    mouse.slice(0, 3).map((call) => [call.params.type, call.params.x, call.params.y, call.sessionId]),
    [
      ["mouseMoved", 140, 70, "page-session"],
      ["mousePressed", 140, 70, "page-session"],
      ["mouseReleased", 140, 70, "page-session"],
    ],
  );
  assert.deepEqual(
    mouse.slice(3).map((call) => [call.params.x, call.params.y]),
    [[300, 350], [300, 350], [300, 350]],
  );
  assert.deepEqual(
    cdp.calls.filter((call) => call.method === "Input.insertText").map((call) => call.params),
    [{ text: "Zero" }],
  );
  const keys = cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
  assert.deepEqual(
    keys.map((call) => [call.params.type, call.params.key, call.params.windowsVirtualKeyCode]),
    [
      ["keyDown", "Enter", 13],
      ["keyUp", "Enter", 13],
    ],
  );
  // The frame was already focused by the click, so no explicit focus call.
  assert.equal(
    cdp.calls.some((call) => String(call.params.expression || "").includes("frame.focus()")),
    false,
  );
  assert.deepEqual(
    result.screenshots.map((shot) => [shot.label, path.basename(shot.path), shot.bytes]),
    [
      ["after-start", "after-start.png", 9],
      ["submitted", "submitted.png", 9],
    ],
  );
  for (const shot of result.screenshots) {
    assert.equal(fs.readFileSync(shot.path, "utf8"), "png-bytes");
  }
  assert.deepEqual(
    result.steps.map((step) => [step.index, step.kind, step.status]),
    [
      [1, "click", "completed"],
      [2, "wait", "completed"],
      [3, "screenshot", "completed"],
      [4, "type", "completed"],
      [5, "press", "completed"],
      [6, "screenshot", "completed"],
    ],
  );
  assert.deepEqual(
    [result.steps[0].x, result.steps[0].y, result.steps[0].tag],
    [140, 70, "button"],
  );

  // A press with no prior click focuses the frame first.
  const focusCdp = fakeCdp();
  await runInteractionSteps({
    cdp: focusCdp,
    pageSessionId: "page-session",
    frame,
    steps: [{ kind: "press", key: "ArrowLeft" }],
    outputDir: dir,
  });
  assert.equal(
    focusCdp.calls.some(
      (call) =>
        call.sessionId === "page-session" &&
        String(call.params.expression || "").includes("frame.focus()"),
    ),
    true,
  );
  assert.equal(
    focusCdp.calls.find((call) => call.method === "Input.dispatchKeyEvent").params.type,
    "rawKeyDown",
  );

  // A missing element stops the script; earlier evidence is kept and the
  // failure names the step so the receipt cannot claim the later steps.
  const failing = fakeCdp({
    elements: { "#play": { x: 10, y: 10, width: 20, height: 20, tag: "button", text: "play" } },
  });
  const failed = await runInteractionSteps({
    cdp: failing,
    pageSessionId: "page-session",
    frame,
    steps: [
      { kind: "click", selector: "#play" },
      { kind: "screenshot", label: "before" },
      { kind: "click", selector: "#missing" },
      { kind: "screenshot", label: "never" },
    ],
    outputDir: dir,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.stepsCompleted, 2);
  assert.deepEqual(failed.failedStep, {
    index: 3,
    kind: "click",
    error: '"#missing" not-found in the app frame.',
  });
  assert.equal(failed.steps.length, 3);
  assert.deepEqual(failed.screenshots.map((shot) => shot.label), ["before"]);
  assert.equal(fs.existsSync(path.join(dir, "never.png")), false);

  // The total budget is enforced before a step runs and before a wait.
  let budgetClock = 0;
  const budget = await runInteractionSteps({
    cdp: fakeCdp(),
    pageSessionId: "page-session",
    frame,
    steps: [
      { kind: "wait", ms: 4_000 },
      { kind: "wait", ms: 4_000 },
    ],
    outputDir: dir,
    budgetMs: 5_000,
    now: () => budgetClock,
    wait: async (ms) => {
      budgetClock += ms;
    },
  });
  assert.equal(budget.status, "failed");
  assert.equal(budget.stepsCompleted, 1);
  assert.match(budget.failedStep.error, /would exceed the 5000ms interaction budget/);
});

test("the app frame resolves to its attached cross-origin target, or the same-origin document, and never to an unrelated frame", async () => {
  const cdp = fakeCdp();
  const childTargets = new Map([
    ["ad-session", { type: "iframe", url: "https://ads.example.test/x", targetId: "t1" }],
    ["app-session", { type: "iframe", url: FRAME_SRC, targetId: "t2" }],
  ]);
  const resolved = await resolveAppFrame({ cdp, pageSessionId: "page-session", childTargets });
  assert.equal(resolved.sessionId, "app-session");
  assert.equal(resolved.documentExpression, "document");
  assert.equal(resolved.via, "child-target");

  // Same origin but different path still counts as the app frame.
  const sameOrigin = new Map([
    ["app-session", { type: "iframe", url: "https://preview.example.test/other", targetId: "t2" }],
  ]);
  assert.equal(
    (await resolveAppFrame({ cdp, pageSessionId: "page-session", childTargets: sameOrigin })).sessionId,
    "app-session",
  );

  // No attached target and no same-origin document: fail rather than guess.
  await assert.rejects(
    resolveAppFrame({ cdp, pageSessionId: "page-session", childTargets: new Map() }),
    /not reachable/,
  );
  const sameOriginDocument = {
    async send(method, params) {
      if (method === "Runtime.evaluate" && String(params.expression).includes("frame.getBoundingClientRect()")) {
        return {
          result: {
            value: { left: 0, top: 0, width: 10, height: 10, src: FRAME_SRC, sameOriginDocument: true },
          },
        };
      }
      return {};
    },
  };
  const inline = await resolveAppFrame({
    cdp: sameOriginDocument,
    pageSessionId: "page-session",
    childTargets: new Map(),
  });
  assert.equal(inline.sessionId, "page-session");
  assert.equal(inline.via, "same-origin-document");
  assert.match(inline.documentExpression, /contentDocument$/);
});

test("review receipts stay confirmed only when every listed screenshot exists and the script completed", (t) => {
  const dir = fixture(t);
  const runtime = path.join(dir, "runtime.png");
  fs.writeFileSync(runtime, "start");
  const after = path.join(dir, "after-start.png");
  fs.writeFileSync(after, "after");
  const base = {
    schemaVersion: 2,
    status: "confirmed",
    reviewMethod: "runtime",
    buildId: 884,
    publishedArtifactVersionId: 42,
    versionAfterReview: 42,
    versionStable: true,
    browser: { runtimeReadiness: { ready: true } },
    screenshot: { path: runtime, bytes: 5 },
  };
  const write = (name, receipt) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(receipt));
    return file;
  };
  // Default receipts (no --interact) are unchanged.
  assert.equal(parseBuildReviewReceipt(write("plain.json", base)).buildId, 884);
  assert.equal(
    parseBuildReviewReceipt(
      write("null-interaction.json", { ...base, screenshots: [], interaction: null }),
    ).buildId,
    884,
  );
  const interacted = {
    ...base,
    screenshots: [{ label: "after-start", path: after, bytes: 5 }],
    interaction: { status: "completed", stepsPlanned: 3, stepsCompleted: 3 },
  };
  assert.equal(parseBuildReviewReceipt(write("ok.json", interacted)).interaction.status, "completed");
  assert.throws(() =>
    parseBuildReviewReceipt(
      write("failed.json", {
        ...interacted,
        interaction: { status: "failed", stepsPlanned: 3, stepsCompleted: 1 },
      }),
    ),
  );
  assert.throws(() =>
    parseBuildReviewReceipt(
      write("short.json", {
        ...interacted,
        interaction: { status: "completed", stepsPlanned: 3, stepsCompleted: 2 },
      }),
    ),
  );
  assert.throws(() =>
    parseBuildReviewReceipt(
      write("missing-shot.json", {
        ...interacted,
        screenshots: [{ label: "gone", path: path.join(dir, "gone.png"), bytes: 5 }],
      }),
    ),
  );
  fs.writeFileSync(after, "after-changed");
  assert.throws(() => parseBuildReviewReceipt(write("changed-shot.json", interacted)));
});

test("a nonzero exit is a teardown warning only after complete evidence and our own close", () => {
  const closed = {
    closeRequested: true,
    exitedBeforeClose: false,
    evidenceCompleteBeforeClose: true,
    forcedTermination: false,
    signal: null,
    closeDurationMs: 10_300,
    stderrAfterClose: "",
  };
  const watchdog =
    "[w:1019/091614.9:WARNING:x] Init observer found at shutdown.\nTeardown watchdog expired; recording dump and terminating.\n";
  assert.deepEqual(classifyReviewBrowserExit({ ...closed, code: 0 }), {
    accepted: true,
    teardownWarning: null,
  });
  // Exit 2 after our own close, on its own, stays accepted (with a warning).
  const killed = classifyReviewBrowserExit({ ...closed, code: 2 });
  assert.equal(killed.accepted, true);
  assert.equal(killed.teardownWarning.signature, "exit_2_after_close");
  // The 10-19 Newspaper case: close took longer than 5 s, the CLI stopped
  // Chrome, it exited 2 and printed the teardown watchdog line.
  const newspaper = classifyReviewBrowserExit({
    ...closed,
    code: 2,
    forcedTermination: true,
    stderrAfterClose: watchdog,
  });
  assert.equal(newspaper.accepted, true);
  assert.deepEqual(newspaper.teardownWarning, {
    exitCode: 2,
    signal: null,
    forcedTermination: true,
    closeDurationMs: 10_300,
    signature: "teardown_watchdog_expired",
    stderrLine: "Teardown watchdog expired; recording dump and terminating.",
  });
  // Without a teardown signature, other exits and our forced stop still fail.
  assert.equal(classifyReviewBrowserExit({ ...closed, code: 1 }).accepted, false);
  assert.equal(
    classifyReviewBrowserExit({ ...closed, code: 2, forcedTermination: true }).accepted,
    false,
  );
  assert.equal(
    classifyReviewBrowserExit({ ...closed, code: 2, signal: "SIGTERM" }).accepted,
    false,
  );
  // The signature must come from after the close, never from earlier stderr.
  assert.equal(
    classifyReviewBrowserExit({ ...closed, code: 1, stderrAfterClose: "", stderr: watchdog })
      .accepted,
    false,
  );
  // Nothing is accepted before the evidence was complete or before our close.
  for (const notYet of [
    { evidenceCompleteBeforeClose: false },
    { exitedBeforeClose: true },
    { closeRequested: false },
    { evidenceCompleteBeforeClose: undefined },
  ]) {
    assert.equal(
      classifyReviewBrowserExit({ ...closed, code: 2, stderrAfterClose: watchdog, ...notYet })
        .accepted,
      false,
    );
  }
  assert.equal(classifyReviewBrowserExit({ code: 2, signal: null }).accepted, false);
  // A page console line quoting the words is not Chrome's own teardown.
  const consoleLine =
    '[1:2:1019/091605.8:INFO:CONSOLE:42] "Teardown watchdog expired", source: x\n';
  assert.equal(
    classifyReviewBrowserExit({
      closeRequested: true,
      exitedBeforeClose: false,
      evidenceCompleteBeforeClose: true,
      forcedTermination: true,
      code: 2,
      signal: null,
      stderrAfterClose: consoleLine,
    }).accepted,
    false,
  );
});

// A stand-in Chrome that speaks the CDP pipe protocol (fd 3 in, fd 4 out).
const FAKE_CHROME = String.raw`#!/usr/bin/env node
const net = require("node:net");
const mode = process.env.LUMINE_FAKE_CHROME_MODE || "clean";
const url = process.argv[process.argv.length - 1];
const out = new net.Socket({ fd: 4, readable: false, writable: true });
const input = new net.Socket({ fd: 3, readable: true, writable: false });
const send = (message) => out.write(JSON.stringify(message) + "\0");
const ready = mode !== "never-ready";
// "ignore-term" stands for a Chrome wedged in teardown that ignores SIGTERM.
process.on("SIGTERM", () => { if (mode !== "ignore-term") process.exit(2); });
let buffer = "";
input.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let at;
  while ((at = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    const reply = (result) => send({ id: message.id, result, sessionId: message.sessionId });
    switch (message.method) {
      case "Target.getTargets":
        reply({ targetInfos: [{ type: "page", url, targetId: "page-1" }] });
        break;
      case "Target.attachToTarget":
        reply({ sessionId: "session-1" });
        break;
      case "Runtime.evaluate":
        reply({ result: { value: { documentReady: true, previewPresent: ready, previewVisible: ready, progressVisible: false, runtimeErrorVisible: false } } });
        break;
      case "Page.captureScreenshot":
        reply({ data: Buffer.from("fake-png").toString("base64") });
        break;
      case "Browser.close":
        reply({});
        if (mode === "clean") setTimeout(() => process.exit(0), 20);
        else if (mode === "watchdog-hang" || mode === "ignore-term") {
          // Hang past the CLI's close window, as on 10-19, until SIGTERM.
          process.stderr.write("Teardown watchdog expired; recording dump and terminating.\n");
          setInterval(() => {}, 1000);
        } else {
          process.stderr.write("Teardown watchdog expired; recording dump and terminating.\n");
          setTimeout(() => process.exit(2), 20);
        }
        break;
      default:
        reply({});
    }
  }
});
`;

async function managedReviewWithFakeChrome(t, mode) {
  const root = fs.mkdtempSync(path.join(testWorkRoot(), "fake-chrome-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chrome = path.join(root, "fake-chrome.cjs");
  fs.writeFileSync(chrome, FAKE_CHROME, { mode: 0o755 });
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ publishedArtifactVersionId: 15132 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const previousMode = process.env.LUMINE_FAKE_CHROME_MODE;
  process.env.LUMINE_FAKE_CHROME_MODE = mode;
  t.after(() => {
    if (previousMode === undefined) delete process.env.LUMINE_FAKE_CHROME_MODE;
    else process.env.LUMINE_FAKE_CHROME_MODE = previousMode;
  });
  return runManagedBuildReview({
    buildId: 1929,
    authToken: "",
    options: {
      adminWaitMs: 1000,
      adminBrowserPath: chrome,
      adminOutputDir: path.join(root, "out"),
      siteUrl: "http://127.0.0.1:9",
      apiUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutMs: 5000,
    },
  });
}

test("a managed review whose Chrome hangs in teardown and exits 2 is confirmed with a teardownWarning", { timeout: 30_000 }, async (t) => {
  const result = await managedReviewWithFakeChrome(t, "watchdog-hang");
  assert.equal(result.ok, true);
  const review = result.data.review;
  assert.equal(review.status, "confirmed");
  assert.equal(review.browser.exitCode, 2);
  assert.equal(review.browser.exitedCleanly, false);
  assert.equal(review.browser.evidenceCompleteBeforeClose, true);
  assert.equal(review.browser.exitedBeforeClose, false);
  assert.equal(review.browser.teardownWarning.signature, "teardown_watchdog_expired");
  assert.equal(review.browser.teardownWarning.forcedTermination, true);
  assert.ok(review.browser.teardownWarning.closeDurationMs >= 4_900);
  // The receipt is still one a comment or proposal can rely on.
  assert.equal(parseBuildReviewReceipt(result.data.receiptPath).status, "confirmed");
});

test("a Chrome that ignores SIGTERM in teardown is killed, so the review never hangs", { timeout: 30_000 }, async (t) => {
  const started = Date.now();
  const result = await managedReviewWithFakeChrome(t, "ignore-term");
  // 5 s close window + 3 s SIGTERM grace, then SIGKILL; never unbounded.
  assert.ok(Date.now() - started < 20_000);
  const browser = result.data.review.browser;
  assert.equal(browser.signal, "SIGKILL");
  assert.equal(browser.teardownWarning.signature, "teardown_watchdog_expired");
  assert.equal(result.data.review.status, "confirmed");
});

test("a managed review exits cleanly without a warning, and still fails when the page never became reviewable", { timeout: 30_000 }, async (t) => {
  const clean = await managedReviewWithFakeChrome(t, "clean");
  assert.equal(clean.data.review.status, "confirmed");
  assert.equal(clean.data.review.browser.teardownWarning, null);
  assert.equal(clean.data.review.browser.exitedCleanly, true);
  await assert.rejects(managedReviewWithFakeChrome(t, "never-ready"), (error) => {
    assert.equal(error.code, "CLI_ADMIN_BUILD_REVIEW_FAILED");
    const receipt = JSON.parse(fs.readFileSync(error.data.error.details.receiptPath, "utf8"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.browser.evidenceCompleteBeforeClose, false);
    assert.equal(receipt.browser.teardownWarning, null);
    return true;
  });
});
