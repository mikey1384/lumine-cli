// lumine admin energy reset: a fresh daily AI battery for everyone or for one
// account's Energy pool (the server is twinkle-api
// controllers/cli/admin/energyReset.ts). Mikey's general tool: after an
// outage, as an event gift, or to undo a billing mistake. It refills the base
// battery only and never touches paid, sponsored or rescue recharges. A dry
// run unless --confirm; the reason is stored in the audit log.

const USAGE =
  "Usage: lumine admin energy reset --all | --user <id> --reason <text> [--confirm] [--json]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}
const percent = (units, full) =>
  `${Math.round((Number(units) / (Number(full) || 1)) * 100)}%`;

export function buildEnergyOperation({ action, options }) {
  if (action !== "reset") invalid(USAGE);
  if (options.adminConfirm !== "" && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  const all = options.adminAll === true;
  const user = String(options.adminUser || "").trim();
  if (all === Boolean(user)) invalid(`Pass exactly one of --all or --user <id>. ${USAGE}`);
  let userId = null;
  if (user) {
    userId = Number(user);
    if (!Number.isSafeInteger(userId) || userId <= 0)
      invalid(`--user must be a positive whole number. ${USAGE}`);
  }
  const reason = String(options.adminReason || "").trim();
  if (!reason) invalid(`--reason is required. ${USAGE}`);
  return {
    name: confirm ? "energy.reset" : "energy.reset.preview",
    method: "POST",
    path: "/cli/admin/energy/reset",
    body: { ...(all ? { all: true } : { userId }), reason, dryRun: !confirm },
    mutates: confirm,
    requiresRun: false
  };
}

export function formatEnergyResult({ data }) {
  const who =
    data?.scope === "all"
      ? "everyone"
      : `user ${data?.userId}'s Energy pool${data?.poolKey ? ` (${data.poolKey})` : ""}`;
  const pools = Number(data?.poolsReset) || 0;
  const lines = [
    pools
      ? `${data?.dryRun ? "Dry run: would reset" : "Reset"} today's AI battery for ${who}: ${pools} pool${pools === 1 ? "" : "s"} back to a full base battery (${data?.refilledUnits || 0} units refilled, ${percent(data?.refilledUnits || 0, data?.fullBatteryUnits)} of one battery). Recharges were not touched.`
      : `Nothing to reset for ${who}: no battery has been used today (day ${data?.dayKey || data?.dayIndex}).`
  ];
  if (data?.dryRun && pools) lines.push("Nothing was written. Add --confirm to apply.");
  return lines;
}
