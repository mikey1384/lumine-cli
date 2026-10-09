import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSubscriptionAgentEnvironment } from "./agent/providers/environment.js";

export async function privateJson(filename, value) {
  const temp = `${filename}.${randomUUID()}`;
  try {
    await fs.writeFile(temp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(temp, filename);
  } finally { await fs.rm(temp, { force: true }); }
}
const quiet = () => ({ outcome: "quiet", summary: "", action: { kind: "none" } });

// The only child with model access has no Lumine credential or write tools.
// The parent submits its proposal to the permission-checked server transaction.
export async function runCheckinRuntime(config, context, { timeoutMs = 120000, worker = fileURLToPath(new URL("./network-checkin-worker.js", import.meta.url)) } = {}) {
  const cwd = path.join(config.directory, "session");
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { cwd, detached: true,
      env: createSubscriptionAgentEnvironment({ ...process.env, ...config.runtimeEnvironment }), stdio: ["pipe", "pipe", "pipe"] });
    let output = "", failed = false;
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
    const stop = () => { failed = true; kill(); };
    const timer = setTimeout(stop, timeoutMs);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 1024 * 1024) stop(); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); kill();
      if (failed || code !== 0) return reject(new Error("Your agent did not finish. Check its saved login and runtime, then use Check schedule on its computer."));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Your agent returned an unreadable check-in result.")); }
    });
    child.stdin.end(JSON.stringify({ runtime: config.runtime, providerPath: config.providerPath, model: config.model, context }));
  });
}

export async function runScheduledCheckin(config, call, run = runCheckinRuntime) {
  const lockPath = path.join(config.directory, "runner.lock"), pendingPath = path.join(config.directory, "pending.json");
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const saved = await fs.readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
    const stat = await fs.stat(lockPath).catch(() => null);
    // Runs are bounded below five minutes. An older lock can belong to a
    // crashed runner whose PID was later reused by an unrelated process.
    if (stat && Date.now() - stat.mtimeMs < 300000) {
      if (!saved?.pid) return { skipped: "busy" };
      try { process.kill(saved.pid, 0); return { skipped: "busy" }; }
      catch (e) { if (e.code !== "ESRCH") return { skipped: "busy" }; }
    }
    await fs.rm(lockPath, { force: true });
    return runScheduledCheckin(config, call, run);
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const status = await call("checkin-status");
    if (status.checkins.mode === "off") return { skipped: "off" };
    if (status.checkins.mode === "paused" || status.agent.status !== "active") return { skipped: "paused" };
    if (status.checkins.schedule?.id !== config.scheduleId) return { skipped: "setup_pending" };
    let pending = await fs.readFile(pendingPath, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!pending || pending.scheduleId !== config.scheduleId) {
      pending = { scheduleId: config.scheduleId, runId: randomUUID() };
      await privateJson(pendingPath, pending);
    }
    if (!pending.result) {
      const started = await call("checkin-begin", pending);
      if (!started.allowed) {
        await fs.rm(pendingPath, { force: true });
        return { skipped: started.reason || "completed", result: started.completed };
      }
      try {
        pending.result = started.context.posts.length || started.context.inbox.length ? await run(config, started.context) : quiet();
      } catch (error) { pending.result = { outcome: "failed", summary: error.message.slice(0, 1000), action: { kind: "none" } }; }
      // Persist BEFORE submission so a lost acknowledgement never runs the
      // model again or creates a second publication with a new operation ID.
      await privateJson(pendingPath, pending);
    }
    let completed;
    try { completed = await call("checkin-complete", pending); }
    catch (error) {
      if (error.data?.code === "network_checkin_cancelled") {
        await fs.rm(pendingPath, { force: true }); return { skipped: "cancelled" };
      }
      if (["network_checkin_result", "network_checkin_permission", "network_invalid_input", "network_invalid_community"].includes(error.data?.code)) {
        pending.result = { outcome: "failed", summary: "This check-in proposed an action outside its permissions or returned invalid content. No action was published.", action: { kind: "none" } };
        await privateJson(pendingPath, pending);
        completed = await call("checkin-complete", pending);
      } else throw error;
    }
    await fs.rm(pendingPath, { force: true });
    return completed;
  } finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
}
