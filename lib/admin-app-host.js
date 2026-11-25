// `lumine admin app-host status <app> | reports | takedown <app> --reason
// <why> [--confirm] | restore <app> --reason <why> [--confirm] [--json]`
// (twinkle-api controllers/cli/admin/appHosting.ts). <app> is a build id, a
// slug, <slug>.lumine.app or the app's own domain. A takedown shows the clean
// "taken down" page at every address of the app within seconds and ends its
// signed-in sessions there; the app on twin-kle.com is not changed (unpublish
// it separately if needed). Dry runs without --confirm; confirmed changes are
// audited with the reason.
export const APP_HOST_USAGE =
  "Usage: lumine admin app-host status <app> | reports | takedown <app> --reason <why> [--confirm] | restore <app> --reason <why> [--confirm] [--json]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

export function buildAppHostOperation({ action, target, options = {} }) {
  if (action === "reports") {
    return { name: "app-host.reports", method: "GET", path: "/cli/admin/app-host/reports?open=1", mutates: false, requiresRun: false };
  }
  const app = String(target || "").trim();
  if (action === "status") {
    if (!app) invalid("Supply the app: a build id, slug or address.");
    return { name: "app-host.status", method: "GET", path: `/cli/admin/app-host/status?app=${encodeURIComponent(app)}`, mutates: false, requiresRun: false };
  }
  if (!["takedown", "restore"].includes(action)) invalid(APP_HOST_USAGE);
  if (!app || /\s/.test(app)) invalid("Supply the app: a build id, slug or address.");
  const reason = String(options.adminReason || options.reason || "").trim();
  if (!reason) invalid("Pass --reason with why.");
  if (options.adminConfirm !== "" && options.adminConfirm !== undefined && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  return {
    name: `app-host.${action}${confirm ? "" : ".preview"}`,
    method: "POST",
    path: `/cli/admin/app-host/${action}`,
    body: { app, reason, dryRun: !confirm },
    mutates: confirm,
    requiresRun: false,
  };
}

function when(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "?";
}

export function formatAppHostResult({ operation, data = {} }) {
  if (operation.name === "app-host.reports") {
    if (!data.reports?.length) return ["No open app reports."];
    return [
      `${data.count} open report(s):`,
      ...data.reports.map((r) => `  #${r.id} app ${r.buildId} "${r.title || ""}" · ${r.reason}${r.details ? `: ${r.details}` : ""} · ${r.pageHost || ""} · ${when(r.createdAt)}`),
    ];
  }
  if (operation.name === "app-host.status") {
    const addresses = [data.activeSlug, ...(data.domains || [])].filter(Boolean).join(", ") || "none";
    return [`App ${data.buildId}: ${data.status} · version ${data.versionId ?? "-"} · addresses: ${addresses}${data.site?.takedownAt ? ` · taken down ${when(data.site.takedownAt)}` : ""}`];
  }
  const restoring = operation.name.startsWith("app-host.restore");
  if (data.dryRun) {
    return [`Dry run: would ${restoring ? "restore" : "take down"} app ${data.buildId} (now ${data.current}) at ${(data.addresses || []).filter(Boolean).join(", ") || "its addresses"}. Nothing was written. Add --confirm to apply.`];
  }
  return [`${restoring ? "Restored" : "Took down"} app ${data.buildId} at every lumine.app address and its own domains (within seconds).${restoring ? "" : " Its signed-in sessions there ended. twin-kle.com is unchanged."}`];
}
