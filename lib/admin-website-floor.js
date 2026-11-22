// lumine admin website-floor (twinkle-api controllers/cli/admin/websiteFloor.ts):
// the minimum website version, raised without a release. The effective floor
// is the higher of the code floor and this runtime floor. Below it a tab's
// version check shows "Update required" and chat, Grammar Quest and the Daily
// Question ask it to reload, within 30 s on every API server.
//   status                                     code, runtime and effective floor
//   set <version> --reason <text> [--confirm]  owner only, audited
//   clear --reason <text> [--confirm]          back to the code floor
// The website must already serve that version: a floor above the live website
// locks every member out until it is cleared. Writes are dry runs unless
// --confirm.
const USAGE =
  "Usage: lumine admin website-floor status | set <version> --reason <text> [--confirm] | clear --reason <text> [--confirm]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

export function buildWebsiteFloorOperation({ action, target, options = {} }) {
  if (!action || action === "status") {
    return { name: "website-floor.status", method: "GET", path: "/cli/admin/website-floor/status", mutates: false, requiresRun: false };
  }
  if (action !== "set" && action !== "clear") invalid(USAGE);
  if (options.adminConfirm !== "" && options.adminConfirm !== "true" && options.adminConfirm !== undefined)
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  const reason = String(options.adminReason || "").trim();
  if (!reason) invalid(`--reason is required. ${USAGE}`);
  let version = null;
  if (action === "set") {
    version = String(target || "").trim();
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) || version.length > 8)
      invalid(`Pass a website version like 2.6.16. ${USAGE}`);
  }
  return {
    name: confirm ? "website-floor.set" : "website-floor.set.preview",
    method: "POST",
    path: "/cli/admin/website-floor/set",
    body: { ...(version ? { version } : { clear: true }), reason, dryRun: !confirm },
    mutates: confirm,
    requiresRun: false
  };
}

const describe = (floor) =>
  `effective floor ${floor?.effectiveFloor} (code floor ${floor?.codeFloor}, runtime floor ${floor?.runtimeFloor ?? "none"}${floor?.source === "store_unavailable" ? ", switch table unreadable" : floor?.source === "invalid" ? ", runtime value unreadable" : ""})`;

export function formatWebsiteFloorResult({ operation, data }) {
  if (operation.name === "website-floor.status") {
    return [
      `Website floor: ${describe(data)}.`,
      ...(data?.source === "row" && data?.updatedAt
        ? [`  Runtime floor set by ${data.updatedBy ?? "?"} at ${new Date(data.updatedAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`]
        : [])
    ];
  }
  const target = data?.after?.runtimeFloor ?? null;
  const verb = target ? `set the runtime floor to ${target}` : "clear the runtime floor";
  const lines = [
    data?.changed
      ? `${data?.dryRun ? `Dry run: would ${verb}` : target ? `Runtime floor set to ${target}` : "Runtime floor cleared"}. Before: ${describe(data?.before)}.`
      : `The runtime floor is already ${target ?? "clear"}. Nothing to change.`
  ];
  if (!data?.dryRun && data?.changed && data?.after?.effectiveFloor)
    lines.push(`Now: ${describe(data.after)}. Every API server follows within about ${data.after.effectiveWithinSeconds || 30} seconds.`);
  if (data?.dryRun && data?.changed) {
    if (target) lines.push(`  Check the live website already serves ${target} or newer first: a floor above it locks every member out.`);
    lines.push("Nothing was written. Add --confirm to apply.");
  }
  return lines;
}
