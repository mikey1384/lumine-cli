import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

const sha = (value) => createHash("sha256").update(value).digest("hex");

// Resuming reuses explicitly dated, byte-verified receipts. It does not assert
// that old observations are fresh, read, or an editorial duty is complete.
export function createDailyCollection(dir, options, { now = Date.now, clock = () => performance.now() } = {}) {
  const started = clock();
  const today = new Date(now()).toISOString().slice(0, 10);
  const costDate = options.adminCostDate || options.adminDate || new Date(now() - 86400000).toISOString().slice(0, 10);
  if (options.adminCostDate && options.adminDate && options.adminCostDate !== options.adminDate)
    invalid("--cost-date and legacy --date must identify the same closed UTC cost day.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(costDate) || !Number.isFinite(Date.parse(`${costDate}T00:00:00Z`)) ||
      new Date(`${costDate}T00:00:00Z`).toISOString().slice(0, 10) !== costDate || costDate >= today)
    invalid("Use --cost-date YYYY-MM-DD for a completed UTC day, not today's run date.");
  const phase = options.adminPhase || "all";
  if (!["all", "priority", "evidence"].includes(phase)) invalid("--phase must be priority, evidence, or all.");
  const maxSteps = Number(options.adminMaxSteps === "" || options.adminMaxSteps == null ? 200 : options.adminMaxSteps);
  const maxSeconds = Number(options.adminMaxSeconds === "" || options.adminMaxSeconds == null ? 900 : options.adminMaxSeconds);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000 ||
      !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 14400)
    invalid("Use --max-steps 1–1000 and --max-seconds 1–14400.");
  const file = path.join(dir, "gather-checkpoint.json");
  let checkpoint = { protocol: 1, collectionId: randomUUID(), startedAt: new Date(now()).toISOString(), costDate, entries: {} };
  if (options.adminResume) {
    if (!fs.existsSync(file)) invalid("No gather checkpoint exists in this directory; run without --resume first.");
    checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));
    if (checkpoint.protocol !== 1 || checkpoint.costDate !== costDate || !checkpoint.entries || typeof checkpoint.entries !== "object")
      invalid("The checkpoint belongs to a different cost day or format. Use its --cost-date or start a new directory.");
  }
  const save = () => {
    const temporary = `${file}.${process.pid}.next`;
    fs.writeFileSync(temporary, JSON.stringify(checkpoint, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  save();
  let executed = 0;
  return {
    costDate, phase, collectionId: checkpoint.collectionId, startedAt: checkpoint.startedAt,
    warnings: options.adminDate ? ["--date is a legacy alias for --cost-date (a completed UTC day), not the management run date."] : [],
    invalidate(name) {
      if (checkpoint.entries[name]) { checkpoint.entries[name].ok = false; save(); }
    },
    collect(name, args, outputName, stage, run) {
      const outputFile = path.join(dir, outputName);
      const key = sha(JSON.stringify(args));
      const cached = checkpoint.entries[name];
      if (options.adminResume && cached?.ok && cached.requestHash === key && cached.file === outputName) {
        try {
          const bytes = fs.readFileSync(outputFile);
          const json = JSON.parse(bytes);
          if (sha(bytes) === cached.sha256 && json.ok === true && typeof json.status === "string")
            return { ok: true, json, attempts: 0, durationMs: 0, capturedAt: cached.capturedAt, reused: true };
        } catch { /* Missing/changed bytes require a fresh read, never a cached success. */ }
      }
      const remainingMs = maxSeconds * 1000 - (clock() - started);
      const reason = phase !== "all" && phase !== stage ? `outside-${phase}-phase`
        : executed >= maxSteps ? "step-budget" : remainingMs <= 0 ? "time-budget" : null;
      if (reason) return { ok: false, deferred: true, reason, attempts: 0, durationMs: 0 };
      executed++;
      let result;
      try { result = run(args, { outputFile, retryRead: true, timeoutMs: Math.max(1, Math.min(120000, Math.floor(remainingMs))) }); }
      catch (error) { result = { ok: false, attempts: 1, json: { error: { message: String(error.message || error) } } }; }
      const capturedAt = new Date(now()).toISOString();
      let digest;
      if (result.ok) {
        try {
          const bytes = fs.readFileSync(outputFile);
          if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(result.json)) throw new Error("receipt mismatch");
          digest = sha(bytes);
        } catch {
          result = { ...result, ok: false, json: { error: { code: "CLI_DAILY_RECEIPT_INVALID", message: "Successful collection did not save its matching receipt." } } };
        }
      }
      checkpoint.entries[name] = { ok: result.ok, requestHash: key, file: outputName, capturedAt, ...(digest ? { sha256: digest } : {}) };
      save();
      return { ...result, capturedAt, reused: false };
    },
  };
}
