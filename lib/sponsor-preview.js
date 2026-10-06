import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createCdpPipe, findChromeExecutable } from "./build-review.js";

// `lumine sponsor job preview` renders a Workshop job's saved draft from the
// Twinkle preview origin: the same version URL (with SDK injection and asset
// rewrites) that the requester's workspace "App preview" frame loads. It runs
// top-level in headless Chrome, without the Twinkle host page around it, so
// host-bridged SDK calls (sign-in identity, saves, rewards) are not exercised.

export const DEFAULT_PREVIEW_RENDER_MS = 8_000;
export const MAX_PREVIEW_RENDER_MS = 30_000;
const MAX_PREVIEW_LOG_LINES = 200;

export function normalizePreviewRenderMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_PREVIEW_RENDER_MS;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1_000 ||
    parsed > MAX_PREVIEW_RENDER_MS
  ) {
    throw new Error(
      `--wait-ms for a job preview must be an integer between 1000 and ${MAX_PREVIEW_RENDER_MS}.`,
    );
  }
  return parsed;
}

// The preview URL carries a short-lived preview credential for the
// requester's workspace; nothing the CLI prints or stores keeps it.
export function redactPreviewCredential(value) {
  // Plain (?buildApiToken=…), percent-encoded (buildApiToken%3D…, as in a
  // nested URL) and double-encoded (%253D) forms all lose their value.
  return String(value ?? "").replace(
    /(buildApiToken(?:=|%3D|%253D))(?:[A-Za-z0-9._~+\/-]|%(?!26|2526|23|2523)[0-9A-Fa-f]{2})+/gi,
    "$1<redacted>",
  );
}

const PAGE_STATE_EXPRESSION = `(() => {
  const body = document.body;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 1 && rect.height > 1 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const media = body
    ? [...body.querySelectorAll('canvas, img, svg, video')].filter(visible).length
    : 0;
  const text = body ? String(body.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  return {
    readyState: document.readyState,
    title: document.title || '',
    textLength: text.length,
    textSample: text.slice(0, 160),
    visibleMediaCount: media,
    elementCount: body ? body.querySelectorAll('*').length : 0
  };
})()`;

function remoteArgumentText(argument) {
  if (Object.hasOwn(argument || {}, "value")) {
    const value = argument.value;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return String(argument?.description || argument?.type || "");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPageTarget(cdp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await cdp.send("Target.getTargets");
    const page = (result.targetInfos || []).find(
      (target) => target.type === "page",
    );
    if (page) return page;
    await delay(100);
  }
  throw new Error("Chrome did not open a page for the job preview.");
}

export async function renderDraftPreview({
  url,
  outputDir,
  waitMs = DEFAULT_PREVIEW_RENDER_MS,
  browserPath = "",
}) {
  let executable;
  try {
    executable = findChromeExecutable(browserPath);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: "browser_not_found",
      message: String(error?.message || error),
    };
  }
  const profileDir = mkdtempSync(path.join(outputDir, "browser-profile-"));
  const screenshotPath = path.join(outputDir, "preview.png");
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--hide-scrollbars",
      "--mute-audio",
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const closed = new Promise((resolve) => {
    child.once("error", () => resolve({ code: -1 }));
    child.once("close", (code) => resolve({ code: Number(code ?? -1) }));
  });
  const hardKill = setTimeout(() => child.kill("SIGTERM"), waitMs + 30_000);
  const consoleLines = [];
  const exceptions = [];
  const failedRequests = [];
  let documentStatus = null;
  const requestUrls = new Map();
  const push = (list, line) => {
    if (list.length < MAX_PREVIEW_LOG_LINES) {
      list.push(redactPreviewCredential(line).slice(0, 500));
    }
  };
  try {
    const cdp = createCdpPipe(child);
    const enableDomains = (sessionId) =>
      Promise.all([
        cdp.send("Runtime.enable", {}, sessionId),
        cdp.send("Log.enable", {}, sessionId),
        cdp.send("Network.enable", {}, sessionId),
      ]).catch(() => undefined);
    cdp.onEvent((message) => {
      const params = message.params || {};
      if (message.method === "Runtime.consoleAPICalled") {
        const values = (params.args || []).map(remoteArgumentText);
        push(consoleLines, `[console.${params.type || "log"}] ${values.join(" ")}`);
      } else if (message.method === "Runtime.exceptionThrown") {
        const details = params.exceptionDetails || {};
        push(
          exceptions,
          details.exception?.description || details.text || "Uncaught exception",
        );
      } else if (message.method === "Log.entryAdded") {
        const entry = params.entry || {};
        if (entry.level === "error" || entry.level === "warning") {
          push(
            consoleLines,
            `[${entry.level}] ${entry.text || ""}${entry.url ? ` (${entry.url})` : ""}`,
          );
        }
      } else if (message.method === "Network.requestWillBeSent") {
        if (params.requestId && requestUrls.size < 2_000) {
          requestUrls.set(params.requestId, String(params.request?.url || ""));
        }
      } else if (message.method === "Network.responseReceived") {
        const response = params.response || {};
        const status = Number(response.status || 0);
        if (params.type === "Document" && documentStatus === null) {
          documentStatus = status;
        }
        if (status >= 400) push(failedRequests, `${status} ${response.url || ""}`);
      } else if (message.method === "Network.loadingFailed") {
        if (!params.canceled) {
          push(
            failedRequests,
            `${params.errorText || "failed"} (${params.type || "request"}) ${requestUrls.get(params.requestId) || ""}`.trim(),
          );
        }
      } else if (message.method === "Target.attachedToTarget") {
        const sessionId = String(params.sessionId || "");
        if (sessionId) void enableDomains(sessionId);
      }
    });
    const target = await waitForPageTarget(cdp);
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = String(attached.sessionId || "");
    if (!sessionId) throw new Error("Chrome did not attach to the preview page.");
    await cdp.send("Page.enable", {}, sessionId);
    await enableDomains(sessionId);
    await cdp.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    );
    await cdp.send("Page.navigate", { url }, sessionId);
    await delay(waitMs);
    const evaluated = await cdp.send(
      "Runtime.evaluate",
      { expression: PAGE_STATE_EXPRESSION, returnByValue: true },
      sessionId,
    );
    const page = evaluated.result?.value || null;
    const screenshot = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      sessionId,
    );
    let screenshotBytes = 0;
    if (screenshot.data) {
      const buffer = Buffer.from(screenshot.data, "base64");
      writeFileSync(screenshotPath, buffer);
      screenshotBytes = buffer.length;
    }
    await cdp.send("Browser.close").catch(() => undefined);
    await Promise.race([closed, delay(5_000)]);
    const blank =
      !page || (Number(page.textLength || 0) === 0 &&
        Number(page.visibleMediaCount || 0) === 0);
    const problems = [
      ...(documentStatus !== null && documentStatus >= 400
        ? [`The preview document answered HTTP ${documentStatus}.`]
        : []),
      ...(exceptions.length > 0
        ? [`${exceptions.length} uncaught exception(s) while the draft started.`]
        : []),
      ...(blank ? ["The page shows no text, canvas, image, svg or video after the wait."] : []),
    ];
    return {
      ok: problems.length === 0,
      skipped: false,
      waitMs,
      documentStatus,
      page,
      problems,
      exceptions,
      console: consoleLines,
      failedRequests,
      screenshot: screenshotBytes > 0
        ? { path: screenshotPath, bytes: screenshotBytes }
        : null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: redactPreviewCredential(String(error?.message || error)),
      exceptions,
      console: consoleLines,
      failedRequests,
      screenshot: null,
    };
  } finally {
    clearTimeout(hardKill);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([closed, delay(5_000)]);
    rmSync(profileDir, { recursive: true, force: true });
  }
}
