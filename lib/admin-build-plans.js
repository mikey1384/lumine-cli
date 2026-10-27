// `lumine admin build-plans stuck|recheck`: Lumine Build plans whose current
// milestone is not finishing (twinkle-api controllers/cli/admin/buildPlans.ts).
// stuck lists running plans with their current milestone's runs, Energy vs
// estimate, gradings and loop-guard state (flagged ones only unless --all).
// recheck re-grades the current milestone of up to 10 builds with today's
// evaluator, free for the creator; it is a dry run unless --confirm is given.

export const BUILD_PLANS_USAGE =
  "Usage: lumine admin build-plans stuck [--days <1-90>] [--all] | recheck <buildId> [<buildId> ...] [--confirm] [--json]";
const RECHECK_MAX = 10;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function confirmed(options) {
  const confirm = options.adminConfirm;
  // absent is "", a bare --confirm is "true"
  if (confirm !== "" && confirm !== "true") {
    throw validationError("Pass --confirm on its own, without a value.");
  }
  return confirm === "true";
}

export function buildBuildPlansOperation({ action, options }) {
  if (!action || action === "stuck") {
    const query = new URLSearchParams();
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
        throw validationError("--days must be a whole number from 1 to 90.");
      }
      query.set("days", String(days));
    }
    if (options.adminAll) query.set("all", "1");
    const qs = query.toString();
    return {
      name: "build-plans.stuck",
      method: "GET",
      path: `/cli/admin/build-plans/stuck${qs ? `?${qs}` : ""}`,
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "recheck") {
    const ids = (options.positional || [])
      .slice(2)
      .map((value) => String(value).split(","))
      .flat()
      .filter(Boolean)
      .map((value) => Number(value));
    if (
      !ids.length ||
      ids.length > RECHECK_MAX ||
      ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) {
      throw validationError(`Give 1 to ${RECHECK_MAX} build ids. ${BUILD_PLANS_USAGE}`);
    }
    const confirm = confirmed(options);
    return {
      name: confirm ? "build-plans.recheck" : "build-plans.recheck.preview",
      method: "POST",
      path: "/cli/admin/build-plans/recheck",
      body: { buildIds: [...new Set(ids)], dryRun: !confirm },
      mutates: confirm,
      requiresRun: false,
      // One grading per build, one at a time, each up to a few minutes.
      timeoutMs: 15 * 60 * 1000,
    };
  }
  throw validationError(BUILD_PLANS_USAGE);
}

function formatStepCoverage(row) {
  if (!Number.isFinite(row.steps)) return ""; // Older API response.
  if (row.stepsPassed == null) return `; steps ?/${row.steps} verified (no step grading yet)`;
  return `; steps ${row.stepsPassed}/${row.steps} verified, ${row.stepsUnverified ?? 0} unverified, ${row.stepsNeedWork ?? 0} need work`;
}

function formatRow(row) {
  const ratio = row.energyRatio == null ? "?" : `${row.energyRatio}x`;
  const milestone =
    row.milestoneIndex == null ? "-" : `${row.milestoneIndex + 1}/${row.milestones}`;
  const coverage = row.coverage
    ? ` files ${row.coverage.shown}/${row.coverage.total}${row.coverage.toolRounds ? ` +${row.coverage.toolFilesRead} read in ${row.coverage.toolRounds} rounds` : ""}${row.coverage.omittedReferenced ? `, ${row.coverage.omittedReferenced} referenced omitted` : ""}`
    : "";
  const state = row.stalled
    ? ` STALLED(${row.stallReason})`
    : row.wouldStall
      ? ` would stall (${row.wouldStall})`
      : "";
  return `Build ${row.buildId}: milestone ${milestone} (${row.milestonesDone} done), ${row.runs} runs, Energy ${ratio} of estimate, ${row.evaluations ?? "?"} gradings, non-pass streak ${row.consecutiveNonPass ?? "?"}, ${row.passed}/${row.criteria} passing, ${row.unverified} unverified${formatStepCoverage(row)}${state};${coverage}${row.flags?.length ? ` [${row.flags.join(", ")}]` : ""}`;
}

export function formatBuildPlansResult({ operation, data }) {
  if (operation.name === "build-plans.stuck") {
    const rows = data?.rows || [];
    return [
      `${data?.running ?? 0} running build plan(s); ${data?.inWindow ?? rows.length} updated in the last ${data?.days} days or stalled (${data?.stalled ?? 0} stalled); ${rows.length} shown.`,
      ...rows.map(formatRow),
    ];
  }
  const lines = [];
  for (const error of data?.errors || []) {
    lines.push(`Skipped "${error.value}": ${error.reason === "duplicate" ? "listed twice" : "not a build id"}`);
  }
  if (data?.dryRun) {
    lines.push(`Dry run: would recheck ${data?.buildIds?.length || 0} build(s).`);
    for (const row of data?.rows || []) lines.push(formatRow(row));
    lines.push("Nothing was graded. Add --confirm to recheck them (free for the creators).");
    return lines;
  }
  for (const result of data?.results || []) {
    lines.push(
      result?.ok
        ? `${result.replayed ? "(already rechecked by this request) " : ""}Build ${result.buildId}: milestone ${result.milestoneIndex + 1} ${result.verdict}, ${result.passed}/${result.criteria} passing, ${result.unverified} unverified${formatStepCoverage(result)}${result.milestoneCompleted ? ", milestone completed" : ""}${result.stalled ? `, stalled (${result.stalled.reason})` : ""}${result.fileCoverage ? `; files ${result.fileCoverage.shownFiles}/${result.fileCoverage.totalFiles} + ${result.fileCoverage.toolFilesRead || 0} read in ${result.fileCoverage.toolRounds || 0} rounds` : ""}${result.usage ? `; cost ${result.usage.energyUnits} Energy units (${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens), not charged to the creator` : ""}`
        : `Build ${result?.buildId}: not rechecked (${result?.reason === "run_in_progress" ? "a Lumine run is in progress; try again later" : result?.reason || "unknown"})`,
    );
  }
  return lines;
}
