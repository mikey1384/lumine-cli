// lumine admin battery: the tradable AI battery's admin tools (the server is
// twinkle-api controllers/cli/admin/battery.ts). hold/unhold set or clear
// users.banned.battery; reverse voids what is left of the battery a transfer
// delivered, the same day only, and never refunds the sender; inspect shows
// one account's battery pool today (in-flight holds included) and its recent
// movements. The same commands answer to `lumine admin energy ...`.
// trading on|off: the owner's battery trading switch (runtime_switches.
// battery_trading), effective within 30 s with no release; trading also needs
// the Energy ledger authoritative that day. Writes are dry runs unless
// --confirm; reasons are stored in the audit log.

const USAGE =
  "Usage: lumine admin battery trading on|off --reason <text> [--confirm] | inspect --user <id> [--days <1-14>] | hold <userId> --reason <text> [--confirm] | unhold <userId> --reason <text> [--confirm] | reverse --transfer <id>[,<id>...] --reason <text> [--confirm] [--json]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}
function positiveInteger(value, flag) {
  const number = Number(String(value || "").trim());
  if (!Number.isSafeInteger(number) || number <= 0) invalid(`${flag} must be a positive whole number. ${USAGE}`);
  return number;
}
// The size of a full battery is the API's one setting: every battery response
// carries it (fullBatteryUnits) and the CLI keeps no copy. Without it (an
// older API) amounts are shown in units only.
const percentOf = (full) => (units) =>
  Number(full) > 0 ? `${Math.round((Number(units) / Number(full)) * 100)}%` : "?%";

export function buildBatteryOperation({ action, target, options }) {
  if (options.adminConfirm !== "" && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (!action || action === "inspect") {
    const query = new URLSearchParams({ userId: String(positiveInteger(options.adminUser || target, "--user")) });
    if (options.adminDays) {
      const days = positiveInteger(options.adminDays, "--days");
      if (days > 14) invalid("--days is 1 to 14.");
      query.set("days", String(days));
    }
    return { name: "battery.inspect", method: "GET", path: `/cli/admin/battery/inspect?${query}`, mutates: false, requiresRun: false };
  }
  const reason = String(options.adminReason || "").trim();
  if (action === "trading") {
    if (target !== "on" && target !== "off") invalid(`Pass on or off. ${USAGE}`);
    if (!reason) invalid(`--reason is required. ${USAGE}`);
    return {
      name: confirm ? "battery.trading" : "battery.trading.preview",
      method: "POST", path: "/cli/admin/battery/trading",
      body: { mode: target, reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false
    };
  }
  if (!reason) invalid(`--reason is required. ${USAGE}`);
  if (action === "hold" || action === "unhold") {
    return {
      name: confirm ? `battery.${action}` : `battery.${action}.preview`,
      method: "POST", path: `/cli/admin/battery/${action}`,
      body: { userId: positiveInteger(target || options.adminUser, "<userId>"), reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false
    };
  }
  if (action === "reverse") {
    const transferIds = String(options.adminBatteryTransfer || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => positiveInteger(id, "--transfer"));
    if (!transferIds.length) invalid(`--transfer <id>[,<id>...] is required. ${USAGE}`);
    if (transferIds.length > 50) invalid("Reverse up to 50 transfers at a time.");
    return {
      name: confirm ? "battery.reverse" : "battery.reverse.preview",
      method: "POST", path: "/cli/admin/battery/reverse",
      body: { transferIds, reason, dryRun: !confirm },
      mutates: confirm, requiresRun: false
    };
  }
  invalid(USAGE);
}

export function formatBatteryResult({ operation, data }) {
  if (operation.name.startsWith("battery.trading")) {
    const mode = data?.after?.mode;
    const lines = [
      data?.changed
        ? `${data?.dryRun ? `Dry run: would turn battery trading ${mode}` : `Battery trading switched ${mode}`} (was ${data?.before?.mode}${data?.before?.source === "row" ? "" : ", the default"}).`
        : `Battery trading is already ${mode}. Nothing to change.`
    ];
    if (mode === "on") {
      lines.push(
        data?.ledgerAuthoritativeToday
          ? "  Energy ledger: authoritative today, so members can trade once the switch is on."
          : "  Energy ledger: NOT authoritative today. Battery stays hidden until `lumine admin energy cutover` takes effect."
      );
      lines.push(
        data?.websiteFloorCoversBattery
          ? `  Website floor ${data?.websiteFloor} already requires the battery website (${data?.batteryWebsiteVersion}).`
          : `  Website floor is ${data?.websiteFloor}, below the battery website ${data?.batteryWebsiteVersion}: older tabs cannot accept battery offers. Raise it first: lumine admin website-floor set ${data?.batteryWebsiteVersion} --reason <text> --confirm`
      );
    }
    if (data?.dryRun && data?.changed) lines.push("Nothing was written. Add --confirm to apply.");
    else if (data?.changed) lines.push(`Every API server picks it up within about ${data?.effectiveWithinSeconds || 30} seconds.`);
    return lines;
  }
  const percent = percentOf(data?.fullBatteryUnits);
  if (operation.name === "battery.inspect") {
    const user = data?.user || {};
    const lines = [
      `${user.username || user.id} (${user.id}) · joined ${user.joinedAt ? new Date(user.joinedAt * 1000).toISOString().slice(0, 10) : "?"} · ${user.verified ? "verified email" : "no verified email"}${user.batteryHold ? " · BATTERY HOLD" : ""}`
    ];
    for (const pool of data?.pools || []) {
      lines.push(
        `  pool ${pool.poolKey}${pool.current ? " (this account's pool)" : " (received battery from its transfers)"} today: ${pool.onLedger === false ? "not on the Energy ledger yet" : `battery ${percent(pool.batteryUnits)} (${pool.batteryUnits} units) · held by running AI calls ${pool.heldUnits || 0} · giveable ${pool.giveableUnits ?? 0} · received ${pool.receivedUnits} · can still receive ${pool.receiveRoomUnits} · recharge left ${pool.rechargeUnits}`}`
      );
    }
    const transfers = data?.transfers || [];
    if (!transfers.length) lines.push("  No battery movements in this window.");
    for (const t of transfers) {
      lines.push(
        `  #${t.id} day ${t.dayIndex} ${t.direction} ${percent(t.units)} (${t.units}) ${t.direction === "sent" ? `to ${t.toUserId}` : `from ${t.fromUserId}`} · trade ${t.transactionId}${t.reversedAt ? ` · reversed, voided ${t.voidedUnits} (${t.reverseReason || "no reason"})` : ""}`
      );
    }
    return lines;
  }
  if (operation.name.startsWith("battery.hold") || operation.name.startsWith("battery.unhold")) {
    const verb = data?.held ? "hold" : "release the hold on";
    return [
      data?.changed
        ? `${data?.dryRun ? `Dry run: would ${verb}` : data?.held ? "Held" : "Released the hold on"} battery for ${data?.username || data?.userId} (${data?.userId}).`
        : `${data?.username || data?.userId} (${data?.userId}) already ${data?.held ? "has" : "has no"} battery hold. Nothing to change.`,
      ...(data?.dryRun && data?.changed ? ["Nothing was written. Add --confirm to apply."] : [])
    ];
  }
  const lines = [
    `${data?.dryRun ? "Dry run: would void" : "Voided"} ${data?.voidedUnits || 0} units (${percent(data?.voidedUnits || 0)}) of unspent battery; ${data?.alreadySpentUnits || 0} units were already spent. The sender gets nothing back.`
  ];
  for (const t of data?.transfers || []) {
    lines.push(
      `  #${t.transferId} ${t.fromUserId} -> ${t.toUserId} ${t.units} units: ${t.status === "day_ended" ? "its day has ended; the battery is already gone" : t.status === "already_reversed" ? "already reversed" : `void ${t.voidedUnits}, spent ${t.spentUnits}${t.heldUnits ? `, ${t.heldUnits} reserved by a running AI call (spent or voided when it ends)` : ""}`}`
    );
  }
  if (data?.dryRun) lines.push("Nothing was written. Add --confirm to apply.");
  return lines;
}
