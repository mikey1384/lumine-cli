// `lumine admin link-block list | add <host> --note <why> | remove <host>
// --note <why> [--confirm] [--json]` (twinkle-api
// controllers/cli/admin/linkBlocklist.ts): sites Twinkle will not open, from
// apps (Twinkle.app.openLink) or from posted links (posts, comments, chat,
// profiles; their link previews are hidden). A host covers its subdomains.
// Changes are dry runs without --confirm; every confirmed change is audited
// with its note.
export const LINK_BLOCK_USAGE =
  "Usage: lumine admin link-block list | add <host> --note <why> | remove <host> --note <why> [--confirm] [--json]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  throw error;
}

export function buildLinkBlockOperation({ action, target, options = {} }) {
  if (!action || action === "list") {
    if (target) invalid(LINK_BLOCK_USAGE);
    return { name: "link-block.list", method: "GET", path: "/cli/admin/link-blocklist", mutates: false, requiresRun: false };
  }
  if (!["add", "remove"].includes(action)) invalid(LINK_BLOCK_USAGE);
  const host = String(target || "").trim();
  if (!host || /\s/.test(host)) invalid("Supply one site name, like example.com.");
  const note = String(options.note || "").trim();
  if (!note) invalid("Pass --note with the reason.");
  if (options.adminConfirm !== "" && options.adminConfirm !== undefined && options.adminConfirm !== "true")
    invalid("Pass --confirm on its own, without a value.");
  const confirm = options.adminConfirm === "true";
  return {
    name: `link-block.${action}${confirm ? "" : ".preview"}`,
    method: "POST",
    path: `/cli/admin/link-blocklist/${action}`,
    body: { host, note, dryRun: !confirm },
    mutates: confirm,
    requiresRun: false,
  };
}

function when(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "?";
}

export function formatLinkBlockResult({ operation, data = {} }) {
  if (operation.name === "link-block.list") {
    if (!data.hosts?.length) return ["No blocked sites."];
    return [
      `${data.count} blocked site(s) (each covers its subdomains; app links and posted links):`,
      ...data.hosts.map((row) => `  ${row.host}  (added ${when(row.addedAt)} by #${row.addedByUserId}): ${row.note}`),
    ];
  }
  const adding = operation.name.startsWith("link-block.add");
  const lines = [];
  if (data.reason === "already_blocked") lines.push(`${data.host} is already blocked: ${data.entry?.note || ""}`.trim());
  else if (data.reason === "not_blocked") lines.push(`${data.host} is not on the list.`);
  else if (data.reason === "list_full") lines.push("The list is full; remove a site first.");
  else if (data.dryRun) lines.push(`Dry run: would ${adding ? "block" : "unblock"} ${data.host} (and its subdomains). Nothing was written. Add --confirm to apply.`);
  else lines.push(`${adding ? "Blocked" : "Unblocked"} ${data.host} (and its subdomains) for app links and posted links. Note: ${data.note}. Open Twinkle pages see the change within about 15 minutes (server cache 1 min, browser cache 5 min, page copy 10 min).`);
  return lines;
}
