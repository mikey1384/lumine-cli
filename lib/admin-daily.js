import fs from "fs";
import path from "path";
import http from "http";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

// Multi-step conveniences for the full daily management run. Each one runs
// the ordinary `lumine admin` commands as child processes, so pagination,
// audit, scope checks and --output handling stay exactly as documented; these
// only remove the hand-typed glue that every run used to repeat.

const LUMINE_BIN = fileURLToPath(new URL("../bin/lumine.js", import.meta.url));
const MARKED_ASSET = fileURLToPath(
  new URL("./report-assets/marked.min.js", import.meta.url),
);

function runAdmin(args, { outputFile, extraEnv } = {}) {
  const full = ["admin", ...args, "--json"];
  if (outputFile) full.push("--output", outputFile);
  const result = spawnSync(process.execPath, [LUMINE_BIN, ...full], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(extraEnv || {}) },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "null");
  } catch {
    parsed = null;
  }
  return {
    ok: result.status === 0 && parsed?.ok !== false,
    status: result.status,
    json: parsed,
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

export async function dailyRunGather(options) {
  const dir = ensureDir(
    path.resolve(options.adminOutputDir || options.adminDir || "."),
  );
  const yesterday = options.adminDate || utcDayKey(-1);
  const steps = [];
  const step = (name, args, file) => {
    const outputFile = path.join(dir, file);
    const res = runAdmin(args, { outputFile });
    steps.push({
      name,
      file,
      ok: res.ok,
      ...(res.ok ? {} : { error: res.json?.error || res.stderr }),
    });
    return res;
  };
  step("energy-budget", ["energy-budget"], "energy-budget.json");
  step("news", ["news"], "news.json");
  step("brief", ["brief"], "brief.json");
  step("ai-costs-monthly", ["ai-costs", "monthly"], "ai-monthly.json");
  step("ai-costs-day", ["ai-costs", "day", yesterday], "ai-day.json");
  step("media-costs", ["media-costs", "monthly"], "media.json");
  step(
    "reward-activity",
    ["reward-activity", "--date", yesterday, "--days", "7"],
    "reward-activity.json",
  );
  step("reward-review-pending", ["reward-review", "list"], "rr-pending.json");
  step("todos", ["todo", "list"], "todos.json");
  step("escalations", ["escalation", "list"], "escalations.json");
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
    chatMessages.push(...(data.chatMessages || []));
    comments.push(...(data.comments || []));
    const p = data.pagination || {};
    if (p.exhausted && !data.chatTruncated && !data.commentsTruncated) break;
    cursor = p.nextCursor || "";
    if (!cursor || pages > 50) {
      botOk = false;
      steps.push({
        name: "bot-output",
        ok: false,
        error: "pagination did not exhaust",
      });
      break;
    }
  }
  if (botOk) renderBotOutput({ chatMessages, comments }, path.join(dir, "bot-chats.txt"));

  const summary = {
    dir,
    yesterdayUtc: yesterday,
    botOutput: {
      complete: botOk,
      pages,
      chatRows: chatMessages.length,
      comments: comments.length,
      readFile: botOk ? path.join(dir, "bot-chats.txt") : null,
    },
    steps,
    failed: steps.filter((s) => !s.ok).map((s) => s.name),
  };
  fs.writeFileSync(
    path.join(dir, "gather.json"),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  return {
    ok: summary.failed.length === 0,
    status: summary.failed.length ? "partial_failure" : "success",
    data: summary,
  };
}

// Recent, provably never-Featured Subjects with the context the editorial
// ranking needs (comment count, operator view state), newest first.
export async function featuredCandidates(options) {
  const days = Math.max(1, Math.min(30, Number(options.adminDays || 7)));
  const after = options.adminAfter || bangkokCutoff(days);
  const scratch = ensureDir(
    path.resolve(options.adminOutputDir || fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "lumine-featured-"))),
  );
  const subjects = runAdmin(
    ["subjects", "candidates", "--after", after, "--all"],
    { outputFile: path.join(scratch, "subjects.json") },
  );
  if (!subjects.ok) throw new Error(`subjects candidates failed: ${JSON.stringify(subjects.json?.error || subjects.stderr)}`);
  const board = runAdmin(["featured", "list"]);
  if (!board.ok) throw new Error("featured list failed");
  const onBoard = new Set((board.json.data.subjects || []).map((s) => s.id));
  const recent = (subjects.json.data.subjects || []).filter((s) => !onBoard.has(s.id));
  const ids = recent.map((s) => s.id);
  const history = ids.length
    ? runAdmin(["featured", "history", "--subject-ids", ids.join(","), "--all"])
    : { ok: true, json: { data: { subjects: [], coverage: {} } } };
  if (!history.ok) throw new Error("featured history failed");
  const never = new Map(
    (history.json.data.subjects || []).map((s) => [s.id, s.neverFeatured]),
  );
  const candidates = [];
  for (const s of recent) {
    const detail = runAdmin(["subject", "get", String(s.id), "--include-comments"]);
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
@media (max-width:760px){nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{margin-left:0;padding:16px}}
</style></head><body><nav><h4>Sections</h4><div id="toc"></div><h4 style="margin-top:18px">Source</h4><a href="daily-management-report.md">Markdown</a></nav><main id="content">Loading…</main>
<script src="marked.min.js"></script><script>
fetch('daily-management-report.md',{cache:'no-store'}).then(r=>r.text()).then(md=>{const el=document.getElementById('content');el.innerHTML=marked.parse(md);const toc=document.getElementById('toc');let i=0;el.querySelectorAll('h1,h2').forEach(h=>{h.id='s'+(i++);if(h.tagName==='H2'){const a=document.createElement('a');a.href='#'+h.id;a.textContent=h.textContent;toc.appendChild(a)}})});
</script></body></html>`;
}

// Serves the report Markdown as a browsable page on loopback. Only the page,
// its script and the Markdown are reachable; the evidence folder is not.
export async function reportServe(options) {
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
      const { type, body } = route();
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(JSON.stringify({ ok: true, status: "success", data: { url, file } }));
    return new Promise(() => {});
  }
  // Detach a foreground copy of this command so the page outlives the CLI.
  const child = spawn(
    process.execPath,
    [LUMINE_BIN, "admin", "report", "serve", "--file", file, "--port", String(port), "--foreground"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("report server did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const line = buf.split("\n")[0];
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        resolve(parsed.data.url);
      } catch {
        /* wait for the full line */
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`report server exited (${code})`));
    });
  });
  child.stdout.destroy();
  child.unref();
  if (options.adminOpen) {
    spawnSync("open", ["-a", "Google Chrome", url]);
  }
  return {
    ok: true,
    status: "success",
    data: { url, file, pid: child.pid, opened: Boolean(options.adminOpen) },
  };
}
