import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertAuthScope } from "./auth.js";
import { callNetwork, loadNetworkConnection, networkCredentialDirectory, printNetwork } from "./network.js";
import { computerScheduler } from "./network-scheduler.js";
import { privateJson, runScheduledCheckin } from "./network-checkin-runner.js";

async function executable(requested) {
  const candidates = requested.includes(path.sep) ? [path.resolve(requested)] : (process.env.PATH || "").split(path.delimiter).map(p => path.join(p, requested));
  for (const candidate of candidates) {
    try { await fs.access(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`${requested} is not installed on this computer. Install and sign in to the agent runtime first.`);
}

export async function scheduleCommand(options, auth, dependencies = {}) {
  const schedulerFor = dependencies.scheduler || computerScheduler;
  const action = options.networkArgs?.[1] || "status";
  if (!["status", "install", "remove", "run"].includes(action)) throw new Error("Use network schedule status | install --runtime codex|claude-code | remove. Select --agent <handle>.");
  const agent = options.networkOptions?.agent;
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(agent || "")) throw new Error("Select the existing identity with --agent <handle>.");
  if (action !== "remove" && action !== "run") {
    const session = await (dependencies.assertAuthScope || assertAuthScope)({ options, auth, scope: action === "status" ? "build:read" : "build:write" });
    auth.userId = session.userId;
  }
  const account = networkCredentialDirectory(options, auth);
  const directory = path.join(account, "schedules", agent), configPath = path.join(directory, "schedule.json");
  const old = await fs.readFile(configPath, "utf8").then(JSON.parse).catch(e => { if (e.code === "ENOENT") return null; throw e; });
  let connection;
  const call = dependencies.call || (async (name, body) => {
    connection ||= await loadNetworkConnection(options, auth);
    return callNetwork({ ...options, timeoutMs: Math.min(options.timeoutMs || 20000, 20000) }, auth,
      { path: name, method: body ? "POST" : "GET", body }, connection);
  });
  if (action === "remove") {
    if (!old) return printNetwork({ removed: true, message: "No local schedule is installed for this agent." }, options.json);
    await schedulerFor(old).remove();
    // Keep the receipt until the server acknowledges removal. Otherwise a
    // lost response leaves no schedule ID to reconcile on the next attempt.
    await privateJson(configPath, { ...old, removed: true });
    let reported = true;
    try { await call("checkin-schedule", { scheduleId: old.scheduleId, removed: true }); } catch { reported = false; }
    if (reported) await fs.rm(configPath, { force: true });
    return printNetwork({ removed: true, reported, message: reported ? "Computer schedule removed. Manual participation is unchanged." : `Computer schedule removed. When reconnected, run network schedule remove --agent ${agent} again to update Network’s scheduling receipt.` }, options.json);
  }
  if (action === "status") {
    const canonical = await call("checkin-status");
    let installed = false;
    if (old) installed = await schedulerFor(old).verify().catch(() => null);
    const lastError = await fs.readFile(path.join(directory, "last-error.json"), "utf8").then(JSON.parse).catch(() => null);
    return printNetwork({ ...canonical, computer: { installed, runtime: old?.runtime || null, lastError },
      requirements: "Keep this computer awake, online and signed in. The agent CLI needs its saved login. Its desktop app does not need to stay open. Runs use your agent plan; not Twinkle AI Energy." }, options.json);
  }
  if (action === "run") {
    if (!old || old.removed) return;
    try {
      const result = await runScheduledCheckin(old, call);
      await fs.rm(path.join(directory, "last-error.json"), { force: true });
      if (options.json || (result.result && !["quiet", "cancelled"].includes(result.result.outcome))) printNetwork(result, options.json);
    } catch (error) {
      await privateJson(path.join(directory, "last-error.json"), { at: new Date().toISOString(), message: error.message.slice(0, 1200) });
      throw error;
    }
    return;
  }
  const runtime = options.networkOptions?.runtime;
  if (!["codex", "claude-code"].includes(runtime)) throw new Error("Choose --runtime codex or --runtime claude-code. Other runtimes continue to work manually.");
  const providerPath = await executable(options.providerPath || (runtime === "codex" ? process.env.LUMINE_CODEX_PATH || "codex" : process.env.LUMINE_CLAUDE_PATH || "claude"));
  let current = await call("checkin-status");
  if (current.checkins.mode !== "enabled") throw new Error("Choose recurring check-ins in Network → Your agents first. Installing a timer never opts an owner in.");
  if (old) {
    await schedulerFor(old).remove();
    await call("checkin-schedule", { scheduleId: old.scheduleId, removed: true });
    current = await call("checkin-status");
  }
  const config = { directory, agent, runtime, providerPath, model: options.model || undefined,
    runtimeEnvironment: Object.fromEntries(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]
      .filter(key => process.env[key]).map(key => [key, process.env[key]])),
    nodePath: process.execPath, path: process.env.PATH || "", authFile: path.resolve(options.authFile), apiUrl: options.apiUrl,
    label: `net.twinkle.lumine.${path.basename(account)}.${current.agent.id}`,
    scheduleId: randomUUID(), intervalMinutes: current.checkins.intervalMinutes };
  const scheduler = schedulerFor(config); // reject unsupported platforms before writes
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // npm's ephemeral npx cache may be cleaned. Keep a self-contained runner
  // under the private connection directory, not a pointer into that cache.
  const source = fileURLToPath(new URL("..", import.meta.url));
  const destination = path.join(directory, "runtime");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  if (source !== destination) for (const item of ["bin", "lib", "sdk", "package.json"]) await fs.cp(path.join(source, item), path.join(destination, item), { recursive: true });
  await privateJson(configPath, config);
  try { await scheduler.install(); }
  catch (error) {
    await scheduler.remove();
    await fs.rm(configPath, { force: true });
    throw error;
  }
  let confirmed;
  try {
    confirmed = await call("checkin-schedule", { scheduleId: config.scheduleId, scheduler: scheduler.kind,
      runtime, intervalMinutes: config.intervalMinutes, revision: current.checkins.revision });
  } catch (error) {
    // A dropped response can follow a successful confirmation. Keep the
    // installed job until canonical status resolves that ambiguity.
    let canonical;
    try { canonical = await call("checkin-status"); }
    catch {
      throw new Error("The computer timer is installed, but Network confirmation could not be verified. Run network schedule status --agent " + agent + " --json when reconnected. A saved preference alone does not start check-ins.");
    }
    if (canonical.checkins.schedule?.id === config.scheduleId) confirmed = canonical;
    else {
      await scheduler.remove();
      await fs.rm(configPath, { force: true });
      throw error;
    }
  }
  let started = true;
  try { await scheduler.start(); } catch { started = false; }
  printNetwork({ ...confirmed, installed: true, message: started
    ? "Schedule confirmed on this computer. The first check-in is starting; actual results appear separately in Your agents."
    : "Schedule confirmed. An immediate check-in could not start; the timer will try at its next interval. Use schedule status to check actual activity." }, options.json);
}
