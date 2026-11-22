// lumine admin energy: Mikey's AI Energy owner tools (the server is twinkle-api
// controllers/cli/admin/energyReset.ts and battery.ts).
//
// reset: a fresh daily AI battery for everyone or for one account's Energy
//   pool, after an outage, as an event gift, or to undo a billing mistake. It
//   refills the base battery only and never touches paid, sponsored or rescue
//   recharges. Works before the ledger cutover (daily counters) and after it.
// status: where the cutover stands and the daily sanity report (ledger totals
//   next to the old counters; measurement only).
// cutover: the Energy ledger becomes authoritative from a site day's reset.
// inspect | hold | unhold | reverse | trading: the battery trading tools, the
//   same commands as `lumine admin battery ...`.
// Writes are dry runs unless --confirm; reasons are stored in the audit log.
import { buildBatteryOperation, formatBatteryResult } from "./admin-battery.js";

const USAGE =
  "Usage: lumine admin energy reset --all | --user <id> --reason <text> [--confirm] | status [--days <1-14>] | cutover --day <dayIndex> | --off --reason <text> [--confirm] | inspect --user <id> | hold <userId> --reason <text> [--confirm] | unhold <userId> --reason <text> [--confirm] | reverse --transfer <id>[,<id>...] --reason <text> [--confirm] | trading on|off --reason <text> [--confirm] [--json]";
const BATTERY_ACTIONS = new Set(["inspect", "hold", "unhold", "reverse", "trading"]);

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}
const percent = (units, full) =>
  `${Math.round((Number(units) / (Number(full) || 1)) * 100)}%`;

export function buildEnergyOperation({ action, target, options }) {
  if (BATTERY_ACTIONS.has(action)) return buildBatteryOperation({ action, target, options });
  if (options.adminConfirm !== "" && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (action === "status") {
    const query = new URLSearchParams();
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 14) invalid("--days is 1 to 14.");
      query.set("days", String(days));
    }
    const suffix = query.toString();
    return {
      name: "energy.status", method: "GET",
      path: `/cli/admin/energy/status${suffix ? `?${suffix}` : ""}`,
      mutates: false, requiresRun: false
    };
  }
  const reason = String(options.adminReason || "").trim();
  if (action === "cutover") {
    const off = options.adminEnergyOff === true;
    const hasDay = options.adminEnergyDay !== "" && options.adminEnergyDay !== undefined;
    if (off === hasDay) invalid(`Pass exactly one of --day <dayIndex> or --off. ${USAGE}`);
    let day = null;
    if (hasDay) {
      day = Number(options.adminEnergyDay);
      if (!Number.isSafeInteger(day) || day <= 0) invalid(`--day must be a site day index. ${USAGE}`);
    }
    if (!reason) invalid(`--reason is required. ${USAGE}`);
    return {
      name: confirm ? "energy.cutover" : "energy.cutover.preview",
      method: "POST", path: "/cli/admin/energy/cutover",
      body: { ...(off ? { off: true } : { day }), reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false
    };
  }
  if (action !== "reset") invalid(USAGE);
  const all = options.adminAll === true;
  const user = String(options.adminUser || "").trim();
  if (all === Boolean(user)) invalid(`Pass exactly one of --all or --user <id>. ${USAGE}`);
  let userId = null;
  if (user) {
    userId = Number(user);
    if (!Number.isSafeInteger(userId) || userId <= 0)
      invalid(`--user must be a positive whole number. ${USAGE}`);
  }
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

// The switch's state, who set it and when (newer APIs send batteryTrading;
// older ones only the boolean).
const describeTradingSwitch = (data) => {
  const sw = data?.batteryTrading;
  if (!sw) return data?.batteryTradingSwitch ? "on" : "off";
  if (sw.source === "store_unavailable") return `${sw.mode} (switch table unreadable, default applies)`;
  if (sw.source !== "row") return `${sw.mode} (default)`;
  return `${sw.mode} (set by ${sw.updatedBy ?? "?"}${sw.updatedAt ? ` at ${new Date(sw.updatedAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}; lumine admin battery trading on|off)`;
};

const describeCutover = (cutover) =>
  cutover?.mode === "active" && cutover?.authoritativeFromDay !== null && cutover?.authoritativeFromDay !== undefined
    ? `ledger authoritative from site day ${cutover.authoritativeFromDay}`
    : "daily counters (ledger not authoritative)";

export function formatEnergyResult({ operation, data }) {
  const name = operation?.name || "energy.reset";
  if (name.startsWith("battery.")) return formatBatteryResult({ operation, data });
  if (name === "energy.status") {
    const lines = [
      `Today is site day ${data?.today}. Accounting: ${describeCutover(data?.cutover)}${data?.cutover?.authoritativeToday ? " (in effect today)" : ""}. Battery trading switch: ${describeTradingSwitch(data)}.`
    ];
    for (const day of data?.days || []) {
      const fallbacks = Object.entries(day.fallbacks || {}).map(([step, count]) => `${step} ${count}`).join(", ");
      lines.push(
        `  ${day.dayKey || day.dayIndex}: counters ${day.counters.chargedUnits} charged in ${day.counters.pools} pools, ${day.counters.recharges} recharges · ledger ${day.ledger.chargedUnits} charged in ${day.ledger.pools} pools, ${day.ledger.recharges} recharges, ${day.ledger.batteryMovedUnits} battery moved, ${day.ledger.voidedUnits} voided · pools differing ${day.poolsDiffering}${fallbacks ? ` · fallbacks: ${fallbacks}` : ""}`
      );
    }
    return lines;
  }
  if (name.startsWith("energy.cutover")) {
    return [
      `${data?.dryRun ? "Dry run: would change" : "Changed"} AI Energy accounting from ${describeCutover(data?.before)} to ${describeCutover(data?.after)} (today is site day ${data?.today}).`,
      ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : ["Servers pick the change up within about 30 seconds."])
    ];
  }
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
