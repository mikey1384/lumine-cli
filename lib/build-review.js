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
import { writeAdminJsonFile } from "./admin-news.js";

const DEFAULT_REVIEW_WAIT_MS = 10_000;
const MAX_REVIEW_WAIT_MS = 45_000;
const MAX_CAPTURED_LOG_LINES = 500;
const CDP_COMMAND_TIMEOUT_MS = 10_000;

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
    screenshotBytes !== Number(receipt?.screenshot?.bytes || 0)
  ) {
    throw validationError(
      "The Build review receipt is not a confirmed managed-runtime review.",
    );
  }
  return receipt;
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

async function runChromeReview({ executable, url, screenshotPath, profileDir, waitMs }) {
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
  const timer = setTimeout(() => child.kill("SIGTERM"), Math.min(waitMs + 30_000, 58_000));
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
          Promise.all([
            cdp.send("Runtime.enable", {}, childSessionId),
            cdp.send("Log.enable", {}, childSessionId),
          ]).catch(() => {});
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
    });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
  const afterVersion = await loadPublishedVersion({
    apiUrl: options.apiUrl,
    buildId,
    timeoutMs: options.timeoutMs,
    authToken,
  });
  const screenshotBytes = existsSync(screenshotPath)
    ? Number(statSync(screenshotPath).size || 0)
    : 0;
  const confirmed =
    browser.code === 0 &&
    screenshotBytes > 0 &&
    browser.runtimeReadiness?.ready === true &&
    beforeVersion === afterVersion;
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
    console: captureConsoleEvidence(browser.stderr, browser.consoleLines),
  };
  writeAdminJsonFile(receiptPath, receipt);
  if (!confirmed) {
    const error = validationError(
      beforeVersion !== afterVersion
        ? "The Build was republished during review; review the new artifact before commenting."
        : browser.runtimeReadiness?.runtimeErrorVisible
          ? "The isolated Build runtime exposed a runtime error instead of a reviewable app."
          : "The isolated Build runtime did not become visibly reviewable before the observation window ended.",
      "CLI_ADMIN_BUILD_REVIEW_FAILED",
    );
    error.data = {
      ok: false,
      status: "validation_error",
      error: {
        code: error.code,
        message: error.message,
        details: { receiptPath, screenshotPath },
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
