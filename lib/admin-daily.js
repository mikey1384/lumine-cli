import fs from "fs";
import path from "path";
import http from "http";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { randomUUID } from "node:crypto";
import { adminWorkDirectory } from "./admin-work-directory.js";
import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";
import { createDailyReviewState, dailyRunProgress } from "./admin-duties.js";
import { summarizeOwnerViewport, formatOwnerViewportReport } from "./admin-owner-viewport.js";
import { createDailyCollection } from "./admin-daily-collection.js";
export { dailyRunProgress };

// Multi-step conveniences for the full daily management run. Each one runs
// the ordinary `lumine admin` commands as child processes, so pagination,
// audit, scope checks and --output handling stay exactly as documented; these
// only remove the hand-typed glue that every run used to repeat.

const LUMINE_BIN = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));
const MARKED_ASSET = fileURLToPath(
  new URL("./report-assets/marked.min.js", import.meta.url),
);

export function runAdmin(
  args,
  { outputFile, extraEnv, retryRead = false, spawnImpl = spawnSync, timeoutMs } = {},
) {
  const startedAt = performance.now();
  const attemptFile = outputFile
    ? `${outputFile}.attempt-${randomUUID()}.json`
    : null;
  const full = ["admin", ...args, "--json", "--no-update-check"];
  if (attemptFile) full.push("--output", attemptFile);
  const result = spawnImpl(process.execPath, [LUMINE_BIN, ...full], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
    env: { ...process.env, ...(extraEnv || {}) },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "null");
  } catch {
    parsed = null;
  }
  let error = null;
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean" || typeof parsed.status !== "string") {
    error = {
      code: "CLI_ADMIN_OUTPUT_INVALID",
      message: "The child did not return a valid admin JSON receipt.",
    };
  } else if (attemptFile && result.status === 0 && parsed.ok === true) {
    try {
      const saved = JSON.parse(fs.readFileSync(attemptFile, "utf8"));
      if (JSON.stringify(saved) !== JSON.stringify(parsed))
        throw new Error("mismatch");
      if (parsed.data?.scan?.outputPath === attemptFile)
        parsed.data.scan.outputPath = outputFile;
      writeAdminJsonFile(outputFile, parsed, { privateFile: true });
      fs.unlinkSync(attemptFile);
    } catch {
      error = {
        code: "CLI_ADMIN_OUTPUT_MISSING",
        message: "The child did not save the matching JSON receipt.",
      };
    }
  }
  const ok =
    result.status === 0 && parsed?.ok === true && !error && !result.error;
  const reads = {
    "energy-budget": [null],
    "owner-trace": [null],
    news: [null],
    brief: [null],
    "ai-costs": ["monthly", "day"],
    "media-costs": ["monthly"],
    "reward-activity": [null],
    "reward-diagnostics": [null],
    "reward-review": ["list"],
    review: ["list"],
    approvals: ["list"],
    todo: ["list"],
    followup: ["list"],
    escalation: ["list"],
    featured: ["list", "history"],
    sponsor: ["applications"],
    "bot-output": [null],
    "math-lab": ["queue"],
    arena: ["queue", "today-queue"],
    "word-games": ["status"],
    nonogram: ["status"],
    subjects: ["candidates"],
    subject: ["get"],
  };
  const subcommand = args[1]?.startsWith("--") ? null : (args[1] ?? null);
  const readOnly =
    reads[args[0]]?.includes(subcommand) &&
    (args[0] !== "sponsor" || args[2] === "list");
  // Only explicitly opted-in read collections retry an unconfirmed result.
  // Mutation recovery keeps its original idempotency key and lease instead.
  const transient =
    error ||
    result.error ||
    result.signal ||
    parsed?.error?.code === "lumine_http_invalid_response";
  const remainingMs = timeoutMs == null ? undefined : Math.floor(timeoutMs - (performance.now() - startedAt));
  if (!ok && retryRead && readOnly && transient && (remainingMs == null || remainingMs > 0)) {
    const retried = runAdmin(args, { outputFile, extraEnv, spawnImpl, timeoutMs: remainingMs });
    return {
      ...retried,
      durationMs: Math.round(performance.now() - startedAt),
      attempts: 2,
      recovered: retried.ok,
      firstError:
        error || parsed?.error || String(result.error || result.signal),
    };
  }
  return {
    ok,
    durationMs: Math.round(performance.now() - startedAt),
    attempts: 1,
    status: result.status,
    json: error ? { ok: false, status: "unconfirmed", error } : parsed,
    stderr: String(result.stderr || "").slice(-2000),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function utcDayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

// Bangkok midnight `days` calendar days before today, as an ISO timestamp.
export function bangkokCutoff(days, now = Date.now()) {
  const nowBkk = new Date(now + 7 * 3600000);
  const midnight = Date.UTC(
    nowBkk.getUTCFullYear(),
    nowBkk.getUTCMonth(),
    nowBkk.getUTCDate(),
  );
  return new Date(midnight - days * 86400000 - 7 * 3600000).toISOString();
}

// Renders every Zero/Ciel row as readable text grouped by conversation, the
// file the conduct review reads end to end.
export function renderBotOutput({ chatMessages, comments }, file) {
  const t = (ts) => new Date(ts * 1000).toISOString().slice(5, 16);
  const lines = [];
  const sorted = [...chatMessages].sort(
    (a, b) => a.channelId - b.channelId || a.messageId - b.messageId,
  );
  for (const m of sorted) {
    const r = m.recipient || {};
    const g = m.generation || {};
    lines.push(
      `--- #${m.messageId} ${t(m.occurredAt)} ${m.bot} -> ${r.username}(${r.userId}) ch${m.channelId} ${m.surface} kind=${m.messageKind} src=${m.source} gen=${g.storedOutcome} err=${g.errorType}`,
      String(m.content ?? ""),
    );
  }
  lines.push("", "", "===== COMMENTS =====");
  for (const c of comments) {
    lines.push(
      `--- comment ${c.commentId} ${t(c.occurredAt)} ${c.bot} root=${c.rootType}:${c.rootId} ${c.url}`,
      String(c.content ?? ""),
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}

export async function dailyRunGather(options, { run = runAdmin, now, clock } = {}) {
  const startedAt = performance.now();
  const dir = ensureDir(
    path.resolve(options.adminOutputDir || options.adminDir || "."),
  );
  const collection = createDailyCollection(dir, options, { now, clock });
  const yesterday = collection.costDate;
  const steps = [];
  const failLast = (error) => {
    collection.invalidate(steps.at(-1).name);
    Object.assign(steps.at(-1), { ok: false, error });
  };
  const evidenceNames = /^(ai-costs|media-costs|reward-activity|reward-diagnostics|owner-wake|bot-output)/;
  const step = (name, args, file) => {
    const res = collection.collect(name, args, file, evidenceNames.test(name) ? "evidence" : "priority", run);
    steps.push({
      name,
      file,
      ok: res.ok,
      attempts: res.attempts,
      durationMs: res.durationMs,
      recovered: Boolean(res.recovered),
      capturedAt: res.capturedAt || null,
      reused: Boolean(res.reused),
      ...(res.deferred ? { deferred: true, reason: res.reason } : res.ok ? {} : { error: res.json?.error || res.stderr }),
    });
    return res;
  };
  step("energy-budget", ["energy-budget"], "energy-budget.json");
  step("news", ["news"], "news.json");
  step("brief", ["brief"], "brief.json");
  step("todos", ["todo", "list"], "todos.json");
  step("escalations", ["escalation", "list"], "escalations.json");
  step("math-lab-queue", ["math-lab", "queue"], "math-lab-queue.json");
  step("arena-queue", ["arena", "queue"], "arena-queue.json");
  step("word-games-status", ["word-games", "status"], "word-games-status.json");
  step("nonogram-status", ["nonogram", "status"], "nonogram-status.json");
  const personalQueue = { complete: false, pages: 0, members: 0 };
  let personalCursor = 0;
  const personalCursors = new Set();
  for (;;) {
    personalQueue.pages++;
    const res = step(`arena-today-page-${personalQueue.pages}`,
      ["arena", "today-queue", "--cursor", String(personalCursor), "--limit", "100"],
      `arena-today-queue-${personalQueue.pages}.json`);
    if (!res.ok) break;
    const data = res.json?.data;
    const rawNext = data?.nextCursor;
    const next = Number(rawNext || 0);
    if (!Array.isArray(data?.members) || !Object.hasOwn(data, "nextCursor") ||
        !(rawNext === null || (typeof rawNext === "number" && Number.isSafeInteger(rawNext)) || (typeof rawNext === "string" && /^\d+$/.test(rawNext))) ||
        !Number.isSafeInteger(next) || next < 0) {
      failLast("Invalid Arena personal queue page.");
      break;
    }
    personalQueue.members += data.members.length;
    if (!next) { personalQueue.complete = true; break; }
    if (personalCursors.has(next) || personalQueue.pages >= 100) {
      collection.invalidate(steps.at(-1).name);
      steps.push({ name: "arena-today-pagination", ok: false, error: "Arena personal queue repeated a cursor or reached its 100-page bound." });
      break;
    }
    personalCursors.add(next);
    personalCursor = next;
  }
  step("ai-costs-monthly", ["ai-costs", "monthly"], "ai-monthly.json");
  step("ai-costs-day", ["ai-costs", "day", yesterday], "ai-day.json");
  step("media-costs", ["media-costs", "monthly"], "media.json");
  step(
    "reward-activity",
    ["reward-activity", "--date", yesterday, "--days", "7"],
    "reward-activity.json",
  );
  step("reward-diagnostics", ["reward-diagnostics", "--days", "1"], "reward-diagnostics.json");
  // One pending queue covers every Build approval type. Exhaust its cursor;
  // an empty/malformed receipt must not look like an empty queue.
  const buildReviews = { complete: false, pages: 0, items: 0 };
  let reviewCursor = null;
  const reviewCursors = new Set();
  for (;;) {
    buildReviews.pages += 1;
    const args = ["review", "list", "--status", "pending"];
    if (reviewCursor) args.push("--cursor", reviewCursor);
    const res = step(
      `build-reviews-page-${buildReviews.pages}`,
      args,
      `build-reviews-${buildReviews.pages}.json`,
    );
    if (!res.ok) break;
    const data = res.json?.data;
    if (
      data?.filter !== "pending" ||
      !Array.isArray(data?.items) ||
      !(data.nextCursor === null ||
        (typeof data.nextCursor === "string" && /^\d+(\.\d\.\d+)?$/.test(data.nextCursor)))
    ) {
      failLast("Invalid pending Build review page: expected filter, items and nextCursor.");
      break;
    }
    buildReviews.items += data.items.length;
    if (data.nextCursor === null) {
      buildReviews.complete = true;
      break;
    }
    if (reviewCursors.has(data.nextCursor) || buildReviews.pages >= 100) {
      collection.invalidate(steps.at(-1).name);
      steps.push({
        name: "build-reviews-pagination",
        ok: false,
        error: reviewCursors.has(data.nextCursor)
          ? "Build review cursor repeated before exhaustion."
          : "Build review pagination reached the 100-page limit before exhaustion.",
      });
      break;
    }
    reviewCursors.add(data.nextCursor);
    reviewCursor = data.nextCursor;
  }
  // management approvals (birthdates, teacher signups, meetups) with their
  // flags: a required report section (agent-guides/lumine-admin.md)
  step("approvals-pending", ["approvals", "list", "--status", "pending"], "approvals-pending.json");
  step("personal-followups", ["followup", "list"], "personal-followups.json");
  const wake = step("owner-wake", ["owner-trace", "--since", "24h", "--wake", "--limit", "2000"], "owner-wake.json");
  // A phone tab can live longer than the daily window. Retain its version,
  // browser and device context instead of silently calling it unknown.
  const wakeSessions = step("owner-wake-sessions", ["owner-trace", "--since", "30d", "--type", "session", "--limit", "2000"], "owner-wake-sessions.json");
  const ownerWake = summarizeOwnerViewport(
    wake.ok ? wake.json.data : null,
    wakeSessions.ok ? wakeSessions.json.data : null,
  );
  ownerWake.collectionFailures = [
    ...(!wake.ok ? ["owner-wake"] : []),
    ...(!wakeSessions.ok ? ["owner-wake-sessions"] : []),
  ];
  if (ownerWake.collectionFailures.length) {
    ownerWake.coverage = ownerWake.usableSamples ? "partial" : "unavailable";
    ownerWake.detail.coverage = ownerWake.detail.samples ? "partial" : "unavailable";
  }
  writeAdminJsonFile(path.join(dir, "owner-wake-summary.json"), ownerWake, { privateFile: true });
  fs.writeFileSync(path.join(dir, "owner-wake-summary.md"), formatOwnerViewportReport(ownerWake), { mode: 0o600 });
  steps.push({ name: "owner-wake-summary", file: "owner-wake-summary.json", ok: true });
  step("featured-list", ["featured", "list"], "featured-start.json");
  step(
    "sponsor-applications",
    ["sponsor", "applications", "list", "--status", "pending"],
    "sponsor-applications.json",
  );

  // Bot output: follow the cursor until both sources are exhausted.
  const chatMessages = [];
  const comments = [];
  let cursor = "";
  let pages = 0;
  let botOk = true;
  const botCursors = new Set();
  for (;;) {
    pages += 1;
    const file = `bot-output-${pages}.json`;
    const res = step(
      `bot-output-page-${pages}`,
      cursor ? ["bot-output", "--cursor", cursor] : ["bot-output"],
      file,
    );
    if (!res.ok) {
      botOk = false;
      break;
    }
    const data = res.json?.data || {};
    if (!Array.isArray(data.chatMessages) || !Array.isArray(data.comments) || typeof data.pagination?.exhausted !== "boolean") {
      botOk = false;
      failLast("Invalid bot-output page: rows and explicit exhaustion are required.");
      break;
    }
    chatMessages.push(...(data.chatMessages || []));
    comments.push(...(data.comments || []));
    const p = data.pagination || {};
    if (p.exhausted && !data.chatTruncated && !data.commentsTruncated) break;
    cursor = p.nextCursor || "";
    if (!cursor || botCursors.has(cursor) || pages >= 50) {
      collection.invalidate(steps.at(-1).name);
      botOk = false;
      steps.push({
        name: "bot-output",
        ok: false,
        error: "pagination did not exhaust",
      });
      break;
    }
    botCursors.add(cursor);
  }
  if (botOk) renderBotOutput({ chatMessages, comments }, path.join(dir, "bot-chats.txt"));

  const summary = {
    collectedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
    dir,
    yesterdayUtc: yesterday,
    costDateUtc: yesterday,
    collection: { id: collection.collectionId, startedAt: collection.startedAt, phase: collection.phase, warnings: collection.warnings },
    personalQueue,
    buildReviews,
    ownerWake: {
      coverage: ownerWake.coverage,
      truncated: ownerWake.truncated,
      largeGapCycles: ownerWake.largeGapCycles,
      reportFile: path.join(dir, "owner-wake-summary.md"),
    },
    botOutput: {
      complete: botOk,
      pages,
      chatRows: chatMessages.length,
      comments: comments.length,
      readFile: botOk ? path.join(dir, "bot-chats.txt") : null,
    },
    steps,
    failed: steps.filter((s) => !s.ok && !s.deferred).map((s) => s.name),
    deferred: steps.filter((s) => s.deferred).map((s) => ({ name: s.name, reason: s.reason })),
  };
  fs.writeFileSync(
    path.join(dir, "gather.json"),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  // Collection never acknowledges reading or completes an editorial duty.
  const reviewStateFile = path.join(dir, "review-state.json");
  const previousReviewState = fs.existsSync(reviewStateFile)
    ? readAdminJsonFile(reviewStateFile, "the previous review state") : {};
  writeAdminJsonFile(
    reviewStateFile,
    createDailyReviewState(dir, summary, previousReviewState),
    { privateFile: true },
  );
  return {
    ok: summary.failed.length === 0 && summary.deferred.length === 0,
    status: summary.failed.length ? "partial_failure" : summary.deferred.length ? "deferred" : "success",
    data: summary,
  };
}

// Recent, provably never-Featured Subjects with the context the editorial
// ranking needs (comment count, operator view state), newest first.
export async function featuredCandidates(options) {
  const days = Math.max(1, Math.min(30, Number(options.adminDays || 7)));
  const after = options.adminAfter || bangkokCutoff(days);
  const scratch = ensureDir(
    path.resolve(
      options.adminOutputDir ||
        fs.mkdtempSync(path.join(adminWorkDirectory(), "featured-")),
    ),
  );
  const subjects = runAdmin(
    ["subjects", "candidates", "--after", after, "--all"],
    { outputFile: path.join(scratch, "subjects.json"), retryRead: true },
  );
  if (!subjects.ok) throw new Error(`subjects candidates failed: ${JSON.stringify(subjects.json?.error || subjects.stderr)}`);
  const board = runAdmin(["featured", "list"], { retryRead: true });
  if (!board.ok) throw new Error("featured list failed");
  const onBoard = new Set((board.json.data.subjects || []).map((s) => s.id));
  const recent = (subjects.json.data.subjects || []).filter((s) => !onBoard.has(s.id));
  const ids = recent.map((s) => s.id);
  const history = ids.length
    ? runAdmin(
        ["featured", "history", "--subject-ids", ids.join(","), "--all"],
        { retryRead: true },
      )
    : { ok: true, json: { data: { subjects: [], coverage: {} } } };
  if (!history.ok) throw new Error("featured history failed");
  const never = new Map(
    (history.json.data.subjects || []).map((s) => [s.id, s.neverFeatured]),
  );
  const candidates = [];
  for (const s of recent) {
    const detail = runAdmin(
      ["subject", "get", String(s.id), "--include-comments"],
      { retryRead: true },
    );
    if (!detail.ok)
      throw new Error(
        `Subject ${s.id} context is unavailable; candidate review is incomplete.`,
      );
    const subject = detail.json?.data?.subject || {};
    const humanComments = (subject.comments || []).filter(
      (c) => !c.isNotification && ![7587, 8411].includes(Number(c.author?.id)),
    );
    candidates.push({
      id: s.id,
      url: s.url,
      title: s.title,
      author: s.author?.username || null,
      createdAt: s.createdAt,
      neverFeatured: never.get(s.id) ?? null,
      effortLevel: s.effortLevel,
      hasSecret: Boolean(s.secret?.hasSecret),
      hasAttachment: Boolean(s.attachment),
      description: String(s.description || "").slice(0, 300),
      commentsIncluded: Boolean(subject.commentsIncluded),
      commentsTruncated: Boolean(subject.commentsTruncated),
      commentCountsComplete:
        Boolean(subject.commentsIncluded) && !subject.commentsTruncated,
      humanComments: humanComments.length,
      botComments: (subject.comments || []).filter((c) =>
        [7587, 8411].includes(Number(c.author?.id)),
      ).length,
      operatorViewed: Boolean(s.operatorViewed?.viewed),
    });
  }
  return {
    ok: true,
    status: "success",
    data: {
      postedAfter: after,
      coverage: history.json.data.coverage || null,
      boardCount: onBoard.size,
      eligible: candidates.filter((c) => c.neverFeatured === true),
      excluded: candidates
        .filter((c) => c.neverFeatured !== true)
        .map((c) => ({ id: c.id, title: c.title, neverFeatured: c.neverFeatured })),
      note: "Eligibility only: posted after the cutoff and provably never Featured. Ranking by likely member engagement is the editor's judgment.",
    },
  };
}

function reportHtml(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title.replace(/</g, "&lt;")}</title>
<style>
:root{--bg:#fff;--fg:#1d2433;--muted:#5b6475;--line:#dde2ea;--nav:#f6f8fb;--code:#f1f3f7;--link:#2757c9}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e4e8ef;--muted:#9aa3b2;--line:#2b313b;--nav:#1a1e25;--code:#222833;--link:#8fb0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
nav{position:fixed;top:0;left:0;bottom:0;width:250px;overflow:auto;background:var(--nav);border-right:1px solid var(--line);padding:18px 14px}
nav h4{margin:0 0 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}nav a{display:block;padding:4px 6px;border-radius:6px;color:var(--fg);text-decoration:none;font-size:13px}nav a:hover{background:var(--line)}
main{margin-left:250px;padding:28px 40px;max-width:1100px}a{color:var(--link)}table{border-collapse:collapse;margin:10px 0;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.9em}pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto}h2{border-bottom:1px solid var(--line);padding-bottom:4px;margin-top:34px}
.relay-actions{border:1px solid var(--line);border-radius:12px;padding:16px;margin:20px 0;background:var(--nav)}
.relay-actions h3{margin:0 0 8px}.relay-actions p{margin:8px 0}.relay-buttons{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:8px}
.relay-actions button{font:inherit;font-size:1rem;text-align:left;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);cursor:pointer;overflow-wrap:anywhere}
.relay-actions button:hover{border-color:var(--link)}.relay-actions button:focus-visible{outline:2px solid var(--link);outline-offset:2px}.relay-actions button:disabled{cursor:wait;opacity:.65}
.relay-actions .relay-master{grid-column:1/-1;font-weight:650;border-color:var(--link);color:var(--link)}.relay-actions [role=status]{min-height:1.55em;color:var(--muted);font-size:1rem}
.relay-prompt-source{width:100%;min-height:180px;padding:12px;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px}
@media (max-width:760px){nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{margin-left:0;padding:16px}}
</style></head><body><nav><h4>Sections</h4><div id="toc"></div><h4 style="margin-top:18px">Source</h4><a href="source.html">Markdown</a></nav><main id="content">Loading…</main>
<script src="marked.min.js"></script><script>
fetch('daily-management-report.md',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Report source unavailable');return r.text()}).then(md=>{const el=document.getElementById('content');el.innerHTML=marked.parse(md);const toc=document.getElementById('toc');let i=0;el.querySelectorAll('h1,h2').forEach(h=>{h.id='s'+(i++);if(h.tagName==='H2'){const a=document.createElement('a');a.href='#'+h.id;a.textContent=h.textContent;toc.appendChild(a)}})}).catch(()=>{document.getElementById('content').textContent='The report could not load. Open Markdown under Source, or reload this page.'});
document.getElementById('content').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-copy-prompt]');
  if(!button||button.disabled)return;
  const group=button.closest('.relay-actions');
  const source=document.getElementById(button.dataset.copyPrompt);
  const status=group?.querySelector('[role=status]');
  if(!group||!status||!source?.matches('textarea.relay-prompt-source')||!group.contains(source))return;
  const buttons=Array.from(group.querySelectorAll('button[data-copy-prompt]'));
  buttons.forEach(b=>{b.disabled=true});
  try{
    await navigator.clipboard.writeText(source.value);
    status.textContent=button.textContent.replace(/^Copy: /,'')+' copied. Paste it into the agent chat you choose.';
  }catch{
    source.hidden=false;
    source.focus();
    source.select();
    status.textContent='Automatic copy is unavailable. The prompt is selected below; copy it with your keyboard.';
  }finally{
    buttons.forEach(b=>{b.disabled=false});
  }
});
</script></body></html>`;
}

// Serves the report Markdown as a browsable page on loopback. Only the page,
// its script and the Markdown are reachable; the evidence folder is not.
export function waitForReportServer(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let stderr = "";
    let settled = false;
    const clean = value => String(value || "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(-2048);
    const diagnostic = message => new Error(`${message}${clean(stderr) ? ` ${clean(stderr)}` : ""}`);
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(url);
    };
    const onData = (chunk) => {
      buf += chunk;
      if (buf.length > 65536)
        return finish(
          new Error("Report server returned an invalid startup receipt."),
        );
      if (!buf.includes("\n")) return;
      try {
        const parsed = JSON.parse(buf.split("\n")[0]);
        if (parsed.ok === false) {
          const reason = clean(parsed.error?.message || parsed.message || parsed.error);
          return finish(diagnostic(`Report server failed to start${reason ? `: ${reason}` : "."}`));
        }
        const url = new URL(parsed.data?.url);
        if (
          parsed.ok !== true ||
          parsed.status !== "success" ||
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" || url.username || url.password
        )
          throw new Error("invalid receipt");
        finish(null, url.href);
      } catch {
        finish(diagnostic("Report server returned an invalid startup receipt."));
      }
    };
    const onStderr = chunk => { stderr = (stderr + chunk).slice(-8192); };
    // close follows drained stdio; exit can arrive before the error text.
    const onClose = (code, signal) =>
      finish(diagnostic(`Report server exited (${signal || code}) before it was ready.`));
    const onError = (error) => finish(error);
    const timer = setTimeout(
      () =>
        finish(diagnostic("Report server did not start before its deadline.")),
      timeoutMs,
    );
    child.stdout.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

export async function reportServe(
  options,
  { spawnImpl = spawn, openImpl = spawnSync } = {},
) {
  const file = path.resolve(options.adminFile || "daily-management-report.md");
  if (!fs.existsSync(file)) throw new Error(`Report not found: ${file}`);
  const title =
    (fs.readFileSync(file, "utf8").match(/^#\s+(.+)$/m) || [])[1] ||
    "Daily management report";
  const port = Number(options.adminPort || 0);
  const routes = {
    "/": () => ({ type: "text/html; charset=utf-8", body: reportHtml(title) }),
    "/index.html": () => ({ type: "text/html; charset=utf-8", body: reportHtml(title) }),
    "/marked.min.js": () => ({ type: "text/javascript", body: fs.readFileSync(MARKED_ASSET) }),
    "/source.html": () => ({
      type: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Original Markdown</title><style>body{margin:24px;font:15px/1.5 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><a href="/">Back to report</a> · <a href="daily-management-report.md" download>Download Markdown</a><h1>Original Markdown</h1><pre>${fs.readFileSync(file, "utf8").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre></html>`,
    }),
    "/daily-management-report.md": () => ({
      type: "text/markdown; charset=utf-8",
      body: fs.readFileSync(file),
    }),
  };
  if (options.adminForeground) {
    const server = http.createServer((req, res) => {
      const route = routes[(req.url || "/").split("?")[0]];
      if (!route) {
        res.writeHead(404).end("not found");
        return;
      }
      try {
        const { type, body } = route();
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(503).end("report source unavailable");
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(JSON.stringify({ ok: true, status: "success", data: { url, file } }));
    return new Promise(() => {});
  }
  // Detach a foreground copy of this command so the page outlives the CLI.
  const child = spawnImpl(
    process.execPath,
    [
      LUMINE_BIN,
      "admin",
      "report",
      "serve",
      "--file",
      file,
      "--port",
      String(port),
      "--foreground",
      "--json",
      "--no-update-check",
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const url = await waitForReportServer(child);
  child.stdout.destroy();
  // Keep draining diagnostics without retaining them or keeping the CLI up.
  child.stderr?.resume();
  child.stderr?.unref?.();
  child.unref();
  const opened = options.adminOpen
    ? openImpl("open", ["-a", "Google Chrome", url])
    : null;
  return {
    ok: true,
    status: "success",
    data: {
      url,
      file,
      pid: child.pid,
      opened: opened?.status === 0,
      ...(opened && opened.status !== 0
        ? {
            openError:
              "Chrome did not accept the open request; the report server is available.",
          }
        : {}),
      browserVerification: {
        render: "pending",
        navigation: "pending",
        source: "pending",
      },
    },
  };
}
