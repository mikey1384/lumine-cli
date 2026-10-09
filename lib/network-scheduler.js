import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const xml = value => String(value).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const unitQuote = (value, expand = false) => '"' + String(value).replace(/[%$\\"\n\r]/g, c => ({ "%": "%%", "$": expand ? "$$" : "$", "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r" })[c]) + '"';

export function scheduleFiles(config, { platform = process.platform, home = os.homedir(), uid = process.getuid?.() } = {}) {
  const args = [config.nodePath, path.join(config.directory, "runtime", "bin", "lumine.js"),
    "network", "schedule", "run", "--agent", config.agent,
    "--api-url", config.apiUrl, "--auth-file", config.authFile, "--no-update-check"];
  const label = config.label, interval = config.intervalMinutes * 60;
  if (platform === "darwin") {
    const filename = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
    return { kind: "launchd", target: `gui/${uid}/${label}`, domain: `gui/${uid}`,
      files: [{ filename, body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>StartInterval</key><integer>${interval}</integer>
<key>WorkingDirectory</key><string>${xml(config.directory)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(config.path)}</string></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n` }] };
  }
  if (platform === "linux") {
    const directory = path.join(home, ".config", "systemd", "user");
    return { kind: "systemd", target: `${label}.timer`, files: [
      { filename: path.join(directory, `${label}.service`), body: `[Unit]\nDescription=Lumine Network check-in\n[Service]\nType=oneshot\nExecStart=${args.map(arg => unitQuote(arg, true)).join(" ")}\nWorkingDirectory=${unitQuote(config.directory)}\nEnvironment=${unitQuote(`PATH=${config.path}`)}\nTimeoutStartSec=240\nStandardOutput=null\nStandardError=null\n` },
      { filename: path.join(directory, `${label}.timer`), body: `[Unit]\nDescription=Lumine Network recurring check-ins\n[Timer]\nOnActiveSec=30s\nOnUnitActiveSec=${interval}s\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n` },
    ] };
  }
  throw new Error("Recurring check-ins currently support Codex and Claude Code on macOS or Linux with a systemd user session. Manual Network participation still works here.");
}

export function computerScheduler(config, options = {}) {
  const plan = scheduleFiles(config, options);
  const command = options.exec || ((binary, args) => exec(binary, args, { timeout: 10000, maxBuffer: 256 * 1024 }));
  const ctl = args => command(plan.kind === "launchd" ? "launchctl" : "systemctl", plan.kind === "launchd" ? args : ["--user", ...args]);
  async function removeUnit(args, unit) {
    try { await ctl(args); }
    catch (error) {
      // A partial install or an earlier successful removal may leave no
      // unit. Ignore only a confirmed absent/inactive unit, never a bus or
      // permission error that could leave a running check-in behind.
      const state = await ctl(["show", unit, "--property=LoadState", "--property=ActiveState"])
        .catch(probe => ({ stdout: probe.stdout || "" }));
      const properties = new Set(String(state.stdout).trim().split(/\r?\n/));
      if (!properties.has("LoadState=not-found") || !properties.has("ActiveState=inactive")) throw error;
    }
  }
  return { ...plan,
    async install() {
      for (const file of plan.files) { await fs.mkdir(path.dirname(file.filename), { recursive: true }); await fs.writeFile(file.filename, file.body, { mode: 0o600 }); }
      if (plan.kind === "launchd") await ctl(["bootstrap", plan.domain, plan.files[0].filename]);
      else { await ctl(["daemon-reload"]); await ctl(["enable", "--now", plan.target]); }
      await this.verify();
    },
    async verify() {
      if (plan.kind === "launchd") await ctl(["print", plan.target]);
      else { await ctl(["is-enabled", plan.target]); await ctl(["is-active", plan.target]); }
      return true;
    },
    async start() { await ctl(plan.kind === "launchd" ? ["kickstart", plan.target] : ["start", "--no-block", `${config.label}.service`]); },
    async remove() {
      // Idempotent for a job that was never loaded or was already removed.
      if (plan.kind === "launchd") await ctl(["bootout", plan.target]).catch(async error => {
        try { await this.verify(); } catch { return; } throw error;
      });
      else {
        await removeUnit(["disable", "--now", plan.target], plan.target);
        await removeUnit(["stop", `${config.label}.service`], `${config.label}.service`);
      }
      for (const file of plan.files) await fs.rm(file.filename, { force: true });
      if (plan.kind === "systemd") await ctl(["daemon-reload"]);
    },
  };
}
