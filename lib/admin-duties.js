import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";

function fingerprint(dir, file) {
  const absolute = path.resolve(dir, file);
  const relative = path.relative(dir, absolute);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Duty evidence must name a file inside the run directory.");
  }
  const bytes = fs.readFileSync(absolute);
  return {
    file: relative,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function createDailyReviewState(dir, gather, previous = {}) {
  if (previous.protocol != null && previous.protocol !== 1) throw new Error("Unsupported previous duty evidence protocol.");
  const sources = gather.steps
    .filter((step) => step.file)
    .map((step) => ({
      ...(step.ok ? fingerprint(dir, step.file) : { file: step.file }),
      fetched: step.ok,
      read: false,
    }));
  if (gather.botOutput.complete)
    sources.push({
      ...fingerprint(dir, "bot-chats.txt"),
      fetched: true,
      read: false,
    });
  for (const source of previous.sources || []) {
    if (!sources.some((current) => current.file === source.file)) sources.push({ ...source, retained: true, read: false });
  }
  return {
    protocol: 1,
    scope: previous.scope || "collection",
    sources,
    requiredDuties: [...new Set(["effort-levels", "report-browser", ...(previous.requiredDuties || [])])],
    note: "Collection is not a full review. Add every duty required by the run scope and its carryovers. Reading and browser checks require explicit evidence acknowledgments.",
  };
}

// Local operator acknowledgments are separate from canonical server mutations.
// Hashes bind an acknowledgment to the bytes read; they cannot prove reading.
export function summarizeDailyProgress(dir, state, evidence = {}) {
  if (
    state.protocol !== 1 ||
    (evidence.protocol != null && evidence.protocol !== 1)
  )
    throw new Error("Unsupported duty evidence protocol.");
  const acknowledgments = evidence.reading || [];
  const sources = (state.sources || []).map((source) => {
    if (!source.fetched)
      return { ...source, read: false, status: "unavailable" };
    let current;
    try {
      current = fingerprint(dir, source.file);
    } catch {
      return { ...source, read: false, status: "unavailable" };
    }
    const acknowledgment = acknowledgments.find(
      (item) =>
        item.file === source.file &&
        item.sha256 === current.sha256 &&
        item.bytes === current.bytes &&
        Number.isFinite(Date.parse(item.readAt)) &&
        item.complete === true,
    );
    return {
      ...source,
      ...current,
      read: Boolean(acknowledgment),
      status: acknowledgment ? "read" : "fetched",
      readAt: acknowledgment?.readAt || null,
    };
  });
  const verifyReference = (reference) => {
    if (!reference?.file || !reference.sha256) return false;
    try {
      const current = fingerprint(dir, reference.file);
      return (
        current.sha256 === reference.sha256 && current.bytes === reference.bytes
      );
    } catch {
      return false;
    }
  };
  let canonicalRun = null;
  let effortAssignments = null;
  if (verifyReference(evidence.runReport)) {
    const receipt = readAdminJsonFile(
      path.resolve(dir, evidence.runReport.file),
      "the run report",
    );
    const report =
      receipt.ok === true && receipt.status === "success"
        ? receipt.data?.report
        : null;
    if (
      report &&
      Number(report.run?.id) === Number(evidence.runId) &&
      Array.isArray(report.mutations?.byAction)
    ) {
      canonicalRun = { id: report.run.id, status: report.run.status };
      // Absence is zero only in a confirmed complete report, never in a failed fetch.
      const row = report.mutations.byAction.find(
        (item) => item.action === "subject.effort.set",
      );
      effortAssignments = row || {
        action: "subject.effort.set",
        attempts: 0,
        completed: 0,
        changed: 0,
        failed: 0,
        pending: 0,
      };
    }
  }
  const required = [
    ...new Set([
      ...(state.requiredDuties || []),
      ...(evidence.requiredDuties || []),
    ]),
  ];
  const duties = required.map((id) => {
    const duty = (evidence.duties || []).find((item) => item.id === id);
    const confirmed =
      duty?.status === "completed" &&
      duty.evidence?.length &&
      duty.evidence.every(verifyReference) &&
      (id !== "effort-levels" || effortAssignments !== null);
    return {
      id,
      status: confirmed
        ? "completed"
        : duty?.status === "unavailable"
          ? "unavailable"
          : "pending",
      note: duty?.note || null,
    };
  });
  const incomplete = duties
    .filter((item) => item.status !== "completed")
    .map((item) => item.id);
  const complete =
    sources.every((item) => item.read) && incomplete.length === 0;
  return {
    scope: state.scope || "declared-duties",
    coverageBasis: "declared sources and duties only",
    canonicalRun,
    effortAssignments,
    sources,
    duties,
    complete,
    reading: {
      fetched: sources.filter((item) => item.fetched).length,
      read: sources.filter((item) => item.read).length,
      pending: sources.filter((item) => !item.read).map((item) => item.file),
    },
    incompleteDuties: incomplete,
    note: "Run lease completion, reading acknowledgments, effort mutations, and browser verification are independent. A completed lease does not close pending review duties.",
  };
}

export async function dailyRunProgress(options) {
  const dir = path.resolve(options.adminDir || options.adminOutputDir || ".");
  const state = readAdminJsonFile(
    path.join(dir, "review-state.json"),
    "the review state",
  );
  const evidence = options.adminFile
    ? readAdminJsonFile(path.resolve(options.adminFile), "the duty evidence")
    : {};
  const progress = summarizeDailyProgress(dir, state, evidence);
  writeAdminJsonFile(path.join(dir, "progress.json"), progress, {
    privateFile: true,
  });
  return {
    ok: true,
    status: progress.complete ? "success" : "pending",
    data: progress,
  };
}
