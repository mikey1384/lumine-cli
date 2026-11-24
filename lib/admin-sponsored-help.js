// `lumine admin sponsored-help status|switch` (twinkle-api
// controllers/cli/admin/sponsoredHelp.ts): the owner's kill switch for
// sponsored Zero/Ciel help buttons in DMs, and the daily run's read of how
// they are used.
//   status [--days 1-14]      the switch, per-day events (sent, pressed,
//                             planned, confirmed, completed, declined,
//                             cancelled, expired, failed, refused) with
//                             refunded units, refusal reasons, top senders
//   switch --mode on|off      owner only; takes effect within 30 s, no deploy
export const SPONSORED_HELP_USAGE =
  "Usage: lumine admin sponsored-help status [--days 1-14] | switch --mode on|off";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export function buildSponsoredHelpOperation({ action, options = {} }) {
  if (!action || action === "status") {
    const days = Number(options.adminDays || 1);
    if (!Number.isInteger(days) || days < 1 || days > 14) {
      throw invalid("--days is a whole number from 1 to 14.");
    }
    return {
      name: "sponsored-help.status",
      method: "GET",
      path: `/cli/admin/sponsored-help/status?days=${days}`,
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "switch") {
    const mode = String(options.adminMode || "");
    if (mode !== "on" && mode !== "off") throw invalid("--mode is on or off.");
    return {
      name: "sponsored-help.switch",
      method: "POST",
      path: "/cli/admin/sponsored-help/switch",
      body: { mode },
      mutates: true,
      requiresRun: false,
    };
  }
  throw invalid(SPONSORED_HELP_USAGE);
}

export function formatSponsoredHelpResult({ operation, data = {} }) {
  if (operation.name === "sponsored-help.switch") {
    return [
      `Sponsored help buttons: ${data.mode} (confirmed by reading it back; every API process follows within ${data.effectiveWithinSeconds ?? 30} s).`,
      data.mode === "off"
        ? "No new button can be sent, pressed or confirmed. Open requests close on decline or expiry."
        : "Members can send, press and confirm sponsored help buttons.",
    ];
  }
  const lines = [`Sponsored help buttons: ${data.switch || "unknown"} · since site day ${data.fromDay ?? "?"}.`];
  const byDay = new Map();
  for (const row of data.events || []) {
    if (!byDay.has(row.dayIndex)) byDay.set(row.dayIndex, []);
    byDay.get(row.dayIndex).push(
      row.event === "refunded" || row.event === "completed"
        ? `${row.event} ${row.count} (${row.units} units)`
        : `${row.event} ${row.count}`
    );
  }
  if (!byDay.size) lines.push("  No activity.");
  for (const [day, parts] of byDay) lines.push(`  day ${day}: ${parts.join(", ")}`);
  if ((data.refusals || []).length) {
    lines.push(`  refused: ${data.refusals.map((r) => `${r.reason} ${r.count}`).join(", ")}`);
  }
  for (const sender of (data.senders || []).slice(0, 10)) {
    lines.push(
      `  sender ${sender.senderId}: sent ${sender.sent} to ${sender.recipients}, spent ${sender.spentUnits} units, declined ${sender.declined}`
    );
  }
  return lines;
}
