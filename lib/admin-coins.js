// lumine admin coins: Twinkle.coins purchases (the server is
// controllers/cli/admin/coinCharges.ts). Writes are dry runs unless --confirm.
const USAGE =
  "Usage: lumine admin coins list --build <id> [--user <id>] [--price <priceId>] [--key <itemKey>] | refund <receiptId> --reason <text> [--keep-recipient (purchases only, not sales/takeovers)] [--confirm] | release --build <id> --price <priceId> --key <itemKey> --reason <text> [--confirm] [--json]";
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
export function buildCoinsOperation({ action, target, options }) {
  if (options.adminConfirm !== "" && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  if (!action || action === "list") {
    const query = new URLSearchParams({ buildId: String(positiveInteger(options.adminBuild, "--build")) });
    if (options.adminUser) query.set("userId", String(positiveInteger(options.adminUser, "--user")));
    if (options.adminCoinPrice) query.set("priceId", options.adminCoinPrice);
    if (options.adminCoinKey) query.set("key", options.adminCoinKey);
    return {
      name: "coins.list", method: "GET", path: `/cli/admin/coins/purchases?${query}`,
      mutates: false, requiresRun: false
    };
  }
  const reason = String(options.adminReason || "").trim();
  if (!reason) invalid(`--reason is required. ${USAGE}`);
  if (action === "refund")
    return {
      name: confirm ? "coins.refund" : "coins.refund.preview", method: "POST", path: "/cli/admin/coins/refund",
      body: {
        receiptId: positiveInteger(target, "<receiptId>"), reason,
        fromRecipient: !options.adminCoinKeepRecipient, dryRun: !confirm
      },
      mutates: confirm, requiresRun: false
    };
  if (action === "release") {
    if (!options.adminCoinPrice || !options.adminCoinKey) invalid(`--price and --key are required. ${USAGE}`);
    return {
      name: confirm ? "coins.release" : "coins.release.preview", method: "POST", path: "/cli/admin/coins/release",
      body: {
        buildId: positiveInteger(options.adminBuild, "--build"), priceId: options.adminCoinPrice,
        key: options.adminCoinKey, reason, dryRun: !confirm
      },
      mutates: confirm, requiresRun: false
    };
  }
  invalid(USAGE);
}
export function formatCoinsResult({ operation, data }) {
  if (operation.name === "coins.list") {
    const receipts = data?.receipts || [];
    if (!receipts.length) return ["No purchases."];
    return [
      ...receipts.map((r) =>
        `#${r.id} ${new Date(r.createdAt * 1000).toISOString()} ${r.buyer?.username || r.buyer?.id} ${r.kind} ${r.priceId}${r.key ? ` [${r.key}]` : ""} ${r.coins} Coins → ${r.destination}${r.recipient ? ` ${r.recipient.username || r.recipient.id}` : ""}${r.builders ? ` + builders ${r.builders.map((b) => `${b.userId}:${b.coins}`).join(",")}` : ""} · ${r.status}${r.holds ? " (holds)" : ""}`),
      ...(data?.nextBefore ? [`More: re-run with the oldest id as a cursor (before ${data.nextBefore}).`] : [])
    ];
  }
  if (operation.name.startsWith("coins.refund")) {
    const takeBack = (data?.takeBackFrom || []).map((entry) => `${entry.username || entry.id} ${entry.coins}`).join(", ");
    return [
      `${data?.dryRun ? "Dry run: would refund" : "Refunded"} receipt #${data?.receiptId}: ${data?.refundCoins} Coins back to ${data?.buyer?.username || data?.buyer?.id}${takeBack ? `, taking back ${takeBack}` : ", taking nothing back"}${data?.platformCovers ? ` (the platform covers ${data.platformCovers} Coins)` : ""}${data?.restoresReceiptId ? `; the item returns to receipt #${data.restoresReceiptId}` : ""}.`,
      ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [])
    ];
  }
  return [
    `${data?.dryRun ? "Dry run: would release" : "Released"} receipt #${data?.receiptId} (holder ${data?.holderId}). No Coins move.`,
    ...(data?.dryRun ? ["Nothing was written. Add --confirm to apply."] : [])
  ];
}
