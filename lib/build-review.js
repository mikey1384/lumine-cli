import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { requestJson } from "./http.js";
import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";

const DEFAULT_REVIEW_WAIT_MS = 10_000;
const MAX_REVIEW_WAIT_MS = 45_000;
const MAX_CAPTURED_LOG_LINES = 500;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
// --interact bounds: a short, ordered script inside the app's runtime frame.
export const MAX_INTERACTION_STEPS = 12;
export const MAX_INTERACTION_TOTAL_MS = 60_000;
export const MAX_INTERACTION_WAIT_MS = 5_000;
const MAX_INTERACTION_SELECTOR_LENGTH = 500;
const MAX_INTERACTION_TEXT_LENGTH = 200;
const MAX_INTERACTION_FILE_BYTES = 64 * 1024;
const SCREENSHOT_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const RESERVED_SCREENSHOT_LABELS = new Set(["runtime", "review"]);
const APP_FRAME_SELECTOR = 'iframe[title="App preview"]';

function validationError(message, code = "CLI_ADMIN_CLI_VALIDATION") {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseBuildReviewReceipt(filePath) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(String(filePath || ""), "utf8"));
  } catch {
    throw validationError(`Could not read Build review receipt ${filePath}.`);
  }
  const buildId = Number(receipt?.buildId || 0);
  const publishedArtifactVersionId = Number(
    receipt?.publishedArtifactVersionId || 0,
  );
  const versionAfterReview = Number(receipt?.versionAfterReview || 0);
  const screenshotPath = String(receipt?.screenshot?.path || "");
  const screenshotBytes =
    screenshotPath && existsSync(screenshotPath)
      ? Number(statSync(screenshotPath).size || 0)
      : 0;
  // Interaction screenshots are part of the evidence the receipt claims, so
  // each listed file must still exist unchanged. A receipt whose script did
  // not complete is never "confirmed" (status covers it), but check anyway.
  const interactionScreenshots = Array.isArray(receipt?.screenshots)
    ? receipt.screenshots
    : [];
  const screenshotsIntact = interactionScreenshots.every((shot) => {
    const shotPath = String(shot?.path || "");
    const bytes =
      shotPath && existsSync(shotPath) ? Number(statSync(shotPath).size || 0) : 0;
    return (
      SCREENSHOT_LABEL_PATTERN.test(String(shot?.label || "")) &&
      bytes > 0 &&
      bytes === Number(shot?.bytes || 0)
    );
  });
  const interactionIntact =
    receipt?.interaction == null ||
    (receipt.interaction.status === "completed" &&
      Number(receipt.interaction.stepsCompleted) ===
        Number(receipt.interaction.stepsPlanned));
  if (
    receipt?.schemaVersion !== 2 ||
    receipt?.reviewMethod !== "runtime" ||
    receipt?.status !== "confirmed" ||
    !Number.isSafeInteger(buildId) ||
    buildId <= 0 ||
    !Number.isSafeInteger(publishedArtifactVersionId) ||
    publishedArtifactVersionId <= 0 ||
    versionAfterReview !== publishedArtifactVersionId ||
    receipt?.versionStable !== true ||
    receipt?.browser?.runtimeReadiness?.ready !== true ||
    screenshotBytes <= 0 ||
    screenshotBytes !== Number(receipt?.screenshot?.bytes || 0) ||
    !screenshotsIntact ||
    !interactionIntact
  ) {
    throw validationError(
      "The Build review receipt is not a confirmed managed-runtime review.",
    );
  }
  return receipt;
}

// Keys a script may press. Letters and digits are accepted too (see
// keyDefinition). Everything is dispatched as trusted browser input.
export const KEY_DEFINITIONS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
};

export function keyDefinition(name) {
  if (name === " ") return KEY_DEFINITIONS.Space;
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const named = Object.keys(KEY_DEFINITIONS).find(
    (key) => key.toLowerCase() === raw.toLowerCase(),
  );
  if (named) return KEY_DEFINITIONS[named];
  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase();
    return {
      key: raw.toLowerCase(),
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: raw.toLowerCase(),
    };
  }
  if (/^[0-9]$/.test(raw)) {
    return {
      key: raw,
      code: `Digit${raw}`,
      windowsVirtualKeyCode: 48 + Number(raw),
      text: raw,
    };
  }
  return null;
}

function interactionError(message) {
  return validationError(
    `--interact: ${message}`,
    "CLI_ADMIN_BUILD_REVIEW_INTERACT_INVALID",
  );
}

function normalizeSelector(value, index, kind) {
  const selector = String(value ?? "").trim();
  if (!selector || selector.length > MAX_INTERACTION_SELECTOR_LENGTH) {
    throw interactionError(
      `step ${index + 1} (${kind}) needs a CSS selector or text=... of at most ${MAX_INTERACTION_SELECTOR_LENGTH} characters.`,
    );
  }
  if (selector.startsWith("text=") && !selector.slice(5).trim()) {
    throw interactionError(`step ${index + 1} (${kind}) has an empty text= match.`);
  }
  return selector;
}

// Accepts a JSON array of steps, or { steps: [...] }. Each step names exactly
// one action: {click}, {type: {selector, text}}, {press}, {wait}, {screenshot}.
export function parseInteractionScript(filePath) {
  const raw = readAdminJsonFile(filePath, "the --interact script", {
    maxBytes: MAX_INTERACTION_FILE_BYTES,
  });
  const list = Array.isArray(raw) ? raw : raw?.steps;
  if (!Array.isArray(list) || !list.length) {
    throw interactionError(
      "the script must be a non-empty JSON array of steps (or { steps: [...] }).",
    );
  }
  if (list.length > MAX_INTERACTION_STEPS) {
    throw interactionError(
      `at most ${MAX_INTERACTION_STEPS} steps are allowed (got ${list.length}).`,
    );
  }
  const labels = new Set();
  const steps = list.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw interactionError(`step ${index + 1} must be an object.`);
    }
    const kinds = ["click", "type", "press", "wait", "screenshot"].filter((key) =>
      Object.hasOwn(item, key),
    );
    if (kinds.length !== 1) {
      throw interactionError(
        `step ${index + 1} must contain exactly one of click, type, press, wait, screenshot.`,
      );
    }
    const kind = kinds[0];
    if (kind === "click") {
      return { kind, selector: normalizeSelector(item.click, index, kind) };
    }
    if (kind === "type") {
      const text = item.type?.text;
      if (
        typeof text !== "string" ||
        !text.length ||
        text.length > MAX_INTERACTION_TEXT_LENGTH ||
        /[\r\n\t\0]/.test(text)
      ) {
        throw interactionError(
          `step ${index + 1} (type) needs { selector, text } with single-line text of at most ${MAX_INTERACTION_TEXT_LENGTH} characters.`,
        );
      }
      return {
        kind,
        selector: normalizeSelector(item.type?.selector, index, kind),
        text,
      };
    }
    if (kind === "press") {
      const definition = keyDefinition(item.press);
      if (!definition) {
        throw interactionError(
          `step ${index + 1} (press) must name one of ${Object.keys(KEY_DEFINITIONS).join(", ")}, a letter, or a digit.`,
        );
      }
      // Store the canonical name (Space, Enter, a, 7) so the receipt reads
      // the same however the script spelled it.
      const canonical =
        Object.keys(KEY_DEFINITIONS).find(
          (name) => KEY_DEFINITIONS[name] === definition,
        ) || definition.key;
      return { kind, key: canonical };
    }
    if (kind === "wait") {
      const ms = Number(item.wait);
      if (!Number.isInteger(ms) || ms < 1 || ms > MAX_INTERACTION_WAIT_MS) {
        throw interactionError(
          `step ${index + 1} (wait) must be an integer between 1 and ${MAX_INTERACTION_WAIT_MS} milliseconds.`,
        );
      }
      return { kind, ms };
    }
    const label = String(item.screenshot ?? "").trim();
    if (
      !SCREENSHOT_LABEL_PATTERN.test(label) ||
      RESERVED_SCREENSHOT_LABELS.has(label.toLowerCase()) ||
      labels.has(label.toLowerCase())
    ) {
      throw interactionError(
        `step ${index + 1} (screenshot) needs a unique label of 1-40 letters, digits, - or _ (not runtime/review).`,
      );
    }
    labels.add(label.toLowerCase());
    return { kind, label };
  });
  return { path: path.resolve(String(filePath)), steps };
}

// Locates an element inside the app frame's document and returns its centre
// in that frame's CSS pixels. text= matches the smallest visible element whose
// visible text equals the requested text (case-insensitive), then a bounded
// contains match.
function locateExpression(documentExpression, selector) {
  return `(() => {
  const doc = ${documentExpression};
  if (!doc || !doc.defaultView) return { found: false, reason: 'frame-document-unavailable' };
  const selector = ${JSON.stringify(selector)};
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = doc.defaultView.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  const norm = (el) => String(el.innerText ?? el.textContent ?? el.value ?? '').replace(/\\s+/g, ' ').trim().toLowerCase();
  let element = null;
  if (selector.startsWith('text=')) {
    const wanted = selector.slice(5).replace(/\\s+/g, ' ').trim().toLowerCase();
    const candidates = [...doc.querySelectorAll('button, a, [role="button"], input, label, summary, li, span, div, p, h1, h2, h3, h4, td, th')].filter(visible);
    const exact = candidates.filter((el) => norm(el) === wanted).sort((a, b) => area(a) - area(b));
    element = exact[0] || candidates
      .filter((el) => { const t = norm(el); return t.includes(wanted) && t.length <= wanted.length + 40; })
      .sort((a, b) => area(a) - area(b))[0] || null;
  } else {
    try { element = doc.querySelector(selector); } catch { return { found: false, reason: 'invalid-selector' }; }
  }
  if (!element) return { found: false, reason: 'not-found' };
  if (!visible(element)) return { found: false, reason: 'not-visible' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = element.getBoundingClientRect();
  return {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: element.tagName.toLowerCase(),
    text: norm(element).slice(0, 80)
  };
})()`;
}

const APP_FRAME_RECT_EXPRESSION = `(() => {
  const frame = document.querySelector(${JSON.stringify(APP_FRAME_SELECTOR)});
  if (!frame) return null;
  const rect = frame.getBoundingClientRect();
  return {
    left: rect.left + frame.clientLeft,
    top: rect.top + frame.clientTop,
    width: frame.clientWidth,
    height: frame.clientHeight,
    src: frame.src || '',
    sameOriginDocument: (() => { try { return Boolean(frame.contentDocument); } catch { return false; } })()
  };
})()`;

const APP_FRAME_FOCUS_EXPRESSION = `(() => {
  const frame = document.querySelector(${JSON.stringify(APP_FRAME_SELECTOR)});
  if (frame) frame.focus();
  return Boolean(frame);
})()`;

async function evaluateValue(cdp, sessionId, expression) {
  const evaluated = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
  );
  if (evaluated.exceptionDetails) {
    throw new Error(
      evaluated.exceptionDetails.exception?.description ||
        evaluated.exceptionDetails.text ||
        "Frame evaluation failed.",
    );
  }
  return evaluated.result?.value;
}

// The published app runs directly inside the "App preview" iframe on the
// /app/:id page. Cross-origin (the normal case) it is an out-of-process frame
// with its own attached session; same-origin it is reachable through
// contentDocument from the page session. Either way clicks are dispatched on
// the page session at frame-offset coordinates so they are trusted input.
export async function resolveAppFrame({ cdp, pageSessionId, childTargets }) {
  const rect = await evaluateValue(cdp, pageSessionId, APP_FRAME_RECT_EXPRESSION);
  if (!rect) throw new Error("The app runtime frame is not on the page.");
  const src = String(rect.src || "");
  let origin = "";
  try {
    origin = new URL(src).origin;
  } catch {
    origin = "";
  }
  const targets = [...childTargets.entries()].map(([sessionId, info]) => ({
    sessionId,
    ...info,
  }));
  const exact = targets.find(
    (target) => target.type === "iframe" && target.url === src,
  );
  const sameOrigin = targets.find((target) => {
    if (target.type !== "iframe" || !origin) return false;
    try {
      return new URL(String(target.url || "")).origin === origin;
    } catch {
      return false;
    }
  });
  const child = exact || sameOrigin;
  if (child) {
    return {
      sessionId: child.sessionId,
      documentExpression: "document",
      via: "child-target",
      url: child.url,
    };
  }
  if (rect.sameOriginDocument) {
    return {
      sessionId: pageSessionId,
      documentExpression: `document.querySelector(${JSON.stringify(APP_FRAME_SELECTOR)}).contentDocument`,
      via: "same-origin-document",
      url: src,
    };
  }
  throw new Error(
    "The app runtime frame's document is not reachable (no attached frame target).",
  );
}

async function frameRect(cdp, pageSessionId) {
  const rect = await evaluateValue(cdp, pageSessionId, APP_FRAME_RECT_EXPRESSION);
  if (!rect) throw new Error("The app runtime frame disappeared.");
  return rect;
}

async function locateInFrame({ cdp, pageSessionId, frame, selector }) {
  const located = await evaluateValue(
    cdp,
    frame.sessionId,
    locateExpression(frame.documentExpression, selector),
  );
  if (!located?.found) {
    throw new Error(
      `${JSON.stringify(selector)} ${located?.reason || "not-found"} in the app frame.`,
    );
  }
  const rect = await frameRect(cdp, pageSessionId);
  const x = Math.round(rect.left + located.x);
  const y = Math.round(rect.top + located.y);
  if (
    located.x < 0 ||
    located.y < 0 ||
    located.x > rect.width ||
    located.y > rect.height
  ) {
    throw new Error(
      `${JSON.stringify(selector)} is outside the visible app frame.`,
    );
  }
  return { x, y, tag: located.tag, text: located.text };
}

async function clickAt({ cdp, pageSessionId, x, y }) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, pageSessionId);
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", clickCount: 1 },
    pageSessionId,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
    pageSessionId,
  );
}

async function pressKey({ cdp, pageSessionId, definition }) {
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
  };
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: definition.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
    },
    pageSessionId,
  );
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, pageSessionId);
}

// Executes a parsed script against the running review browser. Stops at the
// first failed step or when the total budget is spent; every screenshot taken
// before that point is kept and listed so the receipt stays honest.
export async function runInteractionSteps({
  cdp,
  pageSessionId,
  frame,
  steps,
  outputDir,
  budgetMs = MAX_INTERACTION_TOTAL_MS,
  now = Date.now,
  wait = delay,
}) {
  const startedAt = now();
  const results = [];
  const screenshots = [];
  let focusedFrame = false;
  let failedStep = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepStartedAt = now();
    const elapsedBefore = stepStartedAt - startedAt;
    const record = { index: index + 1, ...step, status: "failed", error: null };
    try {
      if (elapsedBefore >= budgetMs) {
        throw new Error(
          `the ${budgetMs}ms interaction budget was spent before this step.`,
        );
      }
      if (step.kind === "click") {
        const point = await locateInFrame({ cdp, pageSessionId, frame, selector: step.selector });
        await clickAt({ cdp, pageSessionId, x: point.x, y: point.y });
        focusedFrame = true;
        Object.assign(record, { x: point.x, y: point.y, tag: point.tag, text: point.text });
      } else if (step.kind === "type") {
        const point = await locateInFrame({ cdp, pageSessionId, frame, selector: step.selector });
        await clickAt({ cdp, pageSessionId, x: point.x, y: point.y });
        focusedFrame = true;
        await cdp.send("Input.insertText", { text: step.text }, pageSessionId);
        Object.assign(record, { x: point.x, y: point.y, tag: point.tag });
      } else if (step.kind === "press") {
        if (!focusedFrame) {
          await evaluateValue(cdp, pageSessionId, APP_FRAME_FOCUS_EXPRESSION);
          focusedFrame = true;
        }
        await pressKey({ cdp, pageSessionId, definition: keyDefinition(step.key) });
      } else if (step.kind === "wait") {
        const remaining = budgetMs - (now() - startedAt);
        if (step.ms > remaining) {
          throw new Error(
            `waiting ${step.ms}ms would exceed the ${budgetMs}ms interaction budget.`,
          );
        }
        await wait(step.ms);
      } else if (step.kind === "screenshot") {
        const captured = await cdp.send(
          "Page.captureScreenshot",
          { format: "png", fromSurface: true, captureBeyondViewport: false },
          pageSessionId,
        );
        if (!captured?.data) throw new Error("Chrome returned no screenshot data.");
        const shotPath = path.join(outputDir, `${step.label}.png`);
        const bytes = Buffer.from(captured.data, "base64");
        writeFileSync(shotPath, bytes);
        const shot = { label: step.label, path: shotPath, bytes: bytes.length };
        screenshots.push(shot);
        Object.assign(record, { path: shotPath, bytes: bytes.length });
      }
      record.status = "completed";
    } catch (error) {
      record.error = String(error?.message || error);
      failedStep = { index: index + 1, kind: step.kind, error: record.error };
    }
    record.elapsedMs = now() - stepStartedAt;
    results.push(record);
    if (failedStep) break;
  }
  return {
    status: failedStep ? "failed" : "completed",
    stepsPlanned: steps.length,
    stepsCompleted: results.filter((item) => item.status === "completed").length,
    failedStep,
    frame: { via: frame.via, url: frame.url },
    steps: results,
    screenshots,
    elapsedMs: now() - startedAt,
  };
}

function findChromeExecutable(explicitPath = "") {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw validationError(
      "A Chrome/Chromium executable was not found. Pass --browser-path <path>.",
      "CLI_ADMIN_BUILD_REVIEW_BROWSER_MISSING",
    );
  }
  return match;
}

function boundedWaitMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_REVIEW_WAIT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1000 || parsed > MAX_REVIEW_WAIT_MS) {
    throw validationError(
      `--wait-ms must be an integer between 1000 and ${MAX_REVIEW_WAIT_MS}.`,
    );
  }
  return parsed;
}

async function loadPublishedVersion({ apiUrl, buildId, timeoutMs }) {
  const result = await requestJson({
    url: `${String(apiUrl).replace(/\/$/, "")}/build/${buildId}/published-version`,
    timeoutMs,
  });
  const versionId = Number(result?.publishedArtifactVersionId || 0);
  if (!Number.isSafeInteger(versionId) || versionId <= 0) {
    throw validationError(
      `Build #${buildId} has no canonical published artifact to review.`,
      "CLI_ADMIN_BUILD_REVIEW_NOT_PUBLISHED",
    );
  }
  return versionId;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createCdpPipe(child) {
  const commandPipe = child.stdio[3];
  const eventPipe = child.stdio[4];
  if (!commandPipe || !eventPipe) {
    throw validationError(
      "Chrome did not expose its managed review channel.",
      "CLI_ADMIN_BUILD_REVIEW_BROWSER_CHANNEL_FAILED",
    );
  }
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Set();
  eventPipe.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let delimiter = buffer.indexOf(0); delimiter >= 0; delimiter = buffer.indexOf(0)) {
      const payload = buffer.subarray(0, delimiter).toString("utf8");
      buffer = buffer.subarray(delimiter + 1);
      if (!payload) continue;
      let message;
      try {
        message = JSON.parse(payload);
      } catch {
        continue;
      }
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(message.error.message || "Chrome command failed."));
        } else {
          entry.resolve(message.result || {});
        }
        continue;
      }
      for (const listener of [...listeners]) listener(message);
    }
  });
  const rejectPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chrome closed its managed review channel."));
    }
    pending.clear();
  };
  child.once("close", rejectPending);
  child.once("error", rejectPending);
  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method, params = {}, sessionId = "") {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome timed out while running ${method}.`));
        }, CDP_COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        commandPipe.write(`${JSON.stringify(message)}\0`);
      });
    },
  };
}

async function waitForPageTarget(cdp, expectedUrl) {
  const deadline = Date.now() + CDP_COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await cdp.send("Target.getTargets");
    const targets = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    const exact = targets.find(
      (target) => target.type === "page" && target.url === expectedUrl,
    );
    const fallback = targets.find(
      (target) =>
        target.type === "page" &&
        /^https?:/i.test(String(target.url || "")) &&
        !String(target.url).startsWith("chrome://"),
    );
    if (exact || fallback) return exact || fallback;
    await delay(100);
  }
  throw new Error("Chrome did not open the requested Build page.");
}

const RUNTIME_READINESS_EXPRESSION = `(() => {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0 && rect.width > 1 && rect.height > 1;
  };
  const preview = document.querySelector('iframe[title="App preview"]');
  const progress = document.querySelector('[role="progressbar"]');
  const runtimeError = document.querySelector('[data-agent-status="preview-error"]');
  return {
    documentReady: document.readyState === 'complete',
    previewPresent: Boolean(preview),
    previewVisible: visible(preview),
    progressVisible: visible(progress),
    runtimeErrorVisible: visible(runtimeError),
    title: document.title || ''
  };
})()`;

function isRuntimeReady(state) {
  return Boolean(
    state?.documentReady &&
      state?.previewPresent &&
      state?.previewVisible &&
      !state?.progressVisible &&
      !state?.runtimeErrorVisible,
  );
}

function remoteArgumentText(argument) {
  if (Object.hasOwn(argument || {}, "value")) {
    const value = argument.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return String(argument?.description || argument?.type || "");
}

async function runChromeReview({
  executable,
  url,
  screenshotPath,
  profileDir,
  waitMs,
  interaction = null,
  outputDir = path.dirname(screenshotPath),
}) {
  const args = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--hide-scrollbars",
    "--enable-logging=stderr",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--window-size=1440,1100",
    url,
  ];
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const consoleLines = [];
  const append = (current, chunk) => `${current}${chunk}`.slice(-2_000_000);
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: Number(code ?? -1), signal: signal || null });
    });
  });
  // The hard kill covers the observation window plus, when a script runs,
  // its full interaction budget; the script itself stops at that budget.
  const interactionAllowanceMs = interaction
    ? MAX_INTERACTION_TOTAL_MS + 15_000
    : 0;
  const timer = setTimeout(
    () => child.kill("SIGTERM"),
    Math.min(waitMs + 30_000, 58_000) + interactionAllowanceMs,
  );
  const childTargets = new Map();
  try {
    const cdp = createCdpPipe(child);
    cdp.onEvent((message) => {
      if (message.method === "Runtime.consoleAPICalled") {
        const values = Array.isArray(message.params?.args)
          ? message.params.args.map(remoteArgumentText).filter(Boolean)
          : [];
        consoleLines.push(
          `[console.${message.params?.type || "log"}] ${values.join(" ")}`,
        );
      } else if (message.method === "Runtime.exceptionThrown") {
        consoleLines.push(
          `[exception] ${message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "Uncaught exception"}`,
        );
      } else if (message.method === "Log.entryAdded") {
        const entry = message.params?.entry;
        consoleLines.push(
          `[${entry?.level || "log"}] ${entry?.text || ""}${entry?.url ? ` (${entry.url})` : ""}`,
        );
      } else if (message.method === "Target.attachedToTarget") {
        const childSessionId = String(message.params?.sessionId || "");
        if (childSessionId) {
          childTargets.set(childSessionId, {
            type: String(message.params?.targetInfo?.type || ""),
            url: String(message.params?.targetInfo?.url || ""),
            targetId: String(message.params?.targetInfo?.targetId || ""),
          });
          Promise.all([
            cdp.send("Runtime.enable", {}, childSessionId),
            cdp.send("Log.enable", {}, childSessionId),
          ]).catch(() => {});
        }
      } else if (message.method === "Target.detachedFromTarget") {
        childTargets.delete(String(message.params?.sessionId || ""));
      } else if (message.method === "Target.targetInfoChanged") {
        const info = message.params?.targetInfo;
        for (const [childSessionId, known] of childTargets) {
          if (info?.targetId && known.targetId === info.targetId) {
            childTargets.set(childSessionId, {
              ...known,
              type: String(info.type || known.type),
              url: String(info.url || known.url),
            });
          }
        }
      }
    });
    const target = await waitForPageTarget(cdp, url);
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = String(attached.sessionId || "");
    if (!sessionId) throw new Error("Chrome did not attach to the Build page.");
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Log.enable", {}, sessionId),
    ]);
    await cdp.send(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
      sessionId,
    );
    const deadline = Date.now() + waitMs;
    let firstReadyAt = null;
    let readiness = null;
    do {
      const evaluated = await cdp.send(
        "Runtime.evaluate",
        { expression: RUNTIME_READINESS_EXPRESSION, returnByValue: true },
        sessionId,
      );
      readiness = evaluated.result?.value || null;
      if (!firstReadyAt && isRuntimeReady(readiness)) {
        firstReadyAt = new Date().toISOString();
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(250, remaining));
    } while (Date.now() < deadline);
    const screenshot = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      sessionId,
    );
    if (screenshot.data) {
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    }
    // Interaction runs only after the start-screen evidence exists and only
    // against a runtime that became reviewable; a script cannot rescue a
    // review whose app never loaded.
    let interactionResult = null;
    if (interaction) {
      if (!isRuntimeReady(readiness)) {
        interactionResult = {
          status: "failed",
          stepsPlanned: interaction.steps.length,
          stepsCompleted: 0,
          failedStep: {
            index: 0,
            kind: "start",
            error: "The runtime was not reviewable when the script would have started.",
          },
          frame: null,
          steps: [],
          screenshots: [],
          elapsedMs: 0,
        };
      } else {
        let frame;
        try {
          frame = await resolveAppFrame({ cdp, pageSessionId: sessionId, childTargets });
        } catch (error) {
          interactionResult = {
            status: "failed",
            stepsPlanned: interaction.steps.length,
            stepsCompleted: 0,
            failedStep: { index: 0, kind: "frame", error: String(error?.message || error) },
            frame: null,
            steps: [],
            screenshots: [],
            elapsedMs: 0,
          };
        }
        if (frame) {
          interactionResult = await runInteractionSteps({
            cdp,
            pageSessionId: sessionId,
            frame,
            steps: interaction.steps,
            outputDir,
          });
        }
      }
    }
    await cdp.send("Browser.close").catch(() => {});
    const closeResult = await Promise.race([
      closed,
      delay(5_000).then(() => {
        child.kill("SIGTERM");
        return closed;
      }),
    ]);
    return {
      ...closeResult,
      stdout,
      stderr,
      consoleLines: consoleLines.slice(-MAX_CAPTURED_LOG_LINES),
      runtimeReadiness: {
        ...(readiness || {}),
        ready: isRuntimeReady(readiness),
        firstReadyAt,
      },
      interaction: interactionResult,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

function captureConsoleEvidence(stderr, cdpLines = []) {
  const chromeLines = String(stderr || "")
    .split(/\r?\n/)
    .filter((line) =>
      /(?:INFO:CONSOLE|Uncaught|Failed to load resource)/i.test(line),
    )
    .slice(-MAX_CAPTURED_LOG_LINES);
  return [...new Set([...cdpLines, ...chromeLines])].slice(
    -MAX_CAPTURED_LOG_LINES,
  );
}

export async function runManagedBuildReview({ options, authToken, buildId }) {
  const waitMs = boundedWaitMs(options.adminWaitMs);
  // Validate the script before any browser or network work so a bad file
  // fails immediately.
  const interaction = options.adminInteract
    ? parseInteractionScript(options.adminInteract)
    : null;
  const executable = findChromeExecutable(options.adminBrowserPath);
  let outputDir;
  if (options.adminOutputDir) {
    const outputRoot = path.resolve(options.adminOutputDir);
    mkdirSync(outputRoot, { recursive: true });
    outputDir = mkdtempSync(path.join(outputRoot, `build-${buildId}-review-`));
  } else {
    outputDir = mkdtempSync(
      path.join(os.tmpdir(), `lumine-build-${buildId}-review-`),
    );
  }
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "lumine-chrome-profile-"));
  const screenshotPath = path.join(outputDir, "runtime.png");
  const receiptPath = path.join(outputDir, "review.json");
  const appUrl = `${String(options.siteUrl).replace(/\/$/, "")}/app/${buildId}`;
  const beforeVersion = await loadPublishedVersion({
    apiUrl: options.apiUrl,
    buildId,
    timeoutMs: options.timeoutMs,
    authToken,
  });
  const startedAt = new Date().toISOString();
  let browser;
  try {
    browser = await runChromeReview({
      executable,
      url: appUrl,
      screenshotPath,
      profileDir,
      waitMs,
      interaction,
      outputDir,
    });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
  // The receipt stays bound to one artifact: the version is re-read after the
  // browser (and any script) finished, exactly as without --interact.
  const afterVersion = await loadPublishedVersion({
    apiUrl: options.apiUrl,
    buildId,
    timeoutMs: options.timeoutMs,
    authToken,
  });
  const screenshotBytes = existsSync(screenshotPath)
    ? Number(statSync(screenshotPath).size || 0)
    : 0;
  const interactionOutcome = browser.interaction || null;
  const interactionCompleted =
    !interaction || interactionOutcome?.status === "completed";
  const confirmed =
    browser.code === 0 &&
    screenshotBytes > 0 &&
    browser.runtimeReadiness?.ready === true &&
    beforeVersion === afterVersion &&
    interactionCompleted;
  const receipt = {
    schemaVersion: 2,
    status: confirmed ? "confirmed" : "failed",
    reviewMethod: "runtime",
    buildId,
    appUrl,
    publishedArtifactVersionId: beforeVersion,
    versionAfterReview: afterVersion,
    versionStable: beforeVersion === afterVersion,
    startedAt,
    completedAt: new Date().toISOString(),
    waitMs,
    browser: {
      executable,
      exitCode: browser.code,
      signal: browser.signal,
      runtimeReadiness: browser.runtimeReadiness,
    },
    screenshot: {
      path: screenshotPath,
      bytes: screenshotBytes,
    },
    // Script screenshots live beside runtime.png; the start screen stays in
    // `screenshot` above. Both lists are empty/null without --interact.
    screenshots: interactionOutcome?.screenshots || [],
    interaction: interaction
      ? {
          path: interaction.path,
          stepsPlanned: interactionOutcome?.stepsPlanned ?? interaction.steps.length,
          stepsCompleted: interactionOutcome?.stepsCompleted ?? 0,
          status: interactionOutcome?.status || "failed",
          failedStep: interactionOutcome?.failedStep || null,
          frame: interactionOutcome?.frame || null,
          elapsedMs: interactionOutcome?.elapsedMs ?? 0,
          steps: interactionOutcome?.steps || [],
        }
      : null,
    console: captureConsoleEvidence(browser.stderr, browser.consoleLines),
  };
  writeAdminJsonFile(receiptPath, receipt);
  if (!confirmed) {
    const interactionFailure =
      beforeVersion === afterVersion &&
      browser.runtimeReadiness?.ready === true &&
      !interactionCompleted;
    const error = validationError(
      beforeVersion !== afterVersion
        ? "The Build was republished during review; review the new artifact before commenting."
        : browser.runtimeReadiness?.runtimeErrorVisible
          ? "The isolated Build runtime exposed a runtime error instead of a reviewable app."
          : interactionFailure
            ? `Interaction step ${interactionOutcome?.failedStep?.index ?? "?"} (${interactionOutcome?.failedStep?.kind ?? "?"}) failed: ${interactionOutcome?.failedStep?.error ?? "unknown"} The receipt lists the ${interactionOutcome?.stepsCompleted ?? 0} completed step(s) and their screenshots; fix the script and review again.`
            : "The isolated Build runtime did not become visibly reviewable before the observation window ended.",
      interactionFailure
        ? "CLI_ADMIN_BUILD_REVIEW_INTERACTION_FAILED"
        : "CLI_ADMIN_BUILD_REVIEW_FAILED",
    );
    error.data = {
      ok: false,
      status: "validation_error",
      error: {
        code: error.code,
        message: error.message,
        details: {
          receiptPath,
          screenshotPath,
          ...(interaction
            ? {
                interaction: receipt.interaction,
                screenshots: receipt.screenshots,
              }
            : {}),
        },
      },
    };
    throw error;
  }
  return {
    ok: true,
    status: "success",
    data: { review: receipt, receiptPath, screenshotPath },
  };
}
