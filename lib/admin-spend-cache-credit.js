// `lumine admin spend-cache-credit status|switch` (twinkle-api
// controllers/cli/admin/spendCacheCredit.ts): the owner's switch for the
// cache credit in Lumine's spend admission.
//   status                    the switch as the API reads it now
//   switch --mode on|off      owner only; takes effect within 30 s, no deploy
// On (default): a continued turn's cached prompt is reserved at the cached
// rate. Off: every reservation is a cold quote again.
export const SPEND_CACHE_CREDIT_USAGE =
  "Usage: lumine admin spend-cache-credit status | switch --mode on|off";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export function buildSpendCacheCreditOperation({ action, options = {} }) {
  if (!action || action === "status") {
    return {
      name: "spend-cache-credit.status",
      method: "GET",
      path: "/cli/admin/spend-cache-credit/status",
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "switch") {
    const mode = String(options.adminMode || "");
    if (mode !== "on" && mode !== "off") throw invalid("--mode is on or off.");
    return {
      name: "spend-cache-credit.switch",
      method: "POST",
      path: "/cli/admin/spend-cache-credit/switch",
      body: { mode },
      mutates: true,
      requiresRun: false,
    };
  }
  throw invalid(SPEND_CACHE_CREDIT_USAGE);
}

export function formatSpendCacheCreditResult({ operation, data = {} }) {
  if (operation.name === "spend-cache-credit.switch") {
    return [
      `Lumine spend cache credit: ${data.mode} (confirmed by reading it back; every API process follows within ${data.effectiveWithinSeconds ?? 30} s).`,
      data.mode === "off"
        ? "Every Lumine reservation is a cold quote again. Runs in progress follow on their next turn."
        : "Continued turns are reserved from the provider's cache receipt again.",
    ];
  }
  const source =
    data.source === "row"
      ? `set by the owner${data.updatedAt ? ` at ${new Date(Number(data.updatedAt) * 1000).toISOString()}` : ""}`
      : data.source === "default"
        ? "the default (never switched)"
        : "the default, because the switch table could not be read";
  const lines = [`Lumine spend cache credit: ${data.mode || "unknown"} · ${source}.`];
  if (data.notice) lines.push(`  ${data.notice}`);
  return lines;
}
