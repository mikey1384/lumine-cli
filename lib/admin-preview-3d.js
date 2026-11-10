// `lumine admin preview-3d status|switch` (twinkle-api
// controllers/cli/admin/preview3d.ts): the owner's switch for 3D (software
// WebGL) in the capture browser that Lumine's looks and thumbnails use.
//   status                    the switch as the API reads it now
//   switch --mode on|off      owner only; takes effect within 30 s, no deploy
// Off means every look and thumbnail runs the way it did before 3D support.
export const PREVIEW_3D_USAGE =
  "Usage: lumine admin preview-3d status | switch --mode on|off";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export function buildPreview3dOperation({ action, options = {} }) {
  if (!action || action === "status") {
    return {
      name: "preview-3d.status",
      method: "GET",
      path: "/cli/admin/preview-3d/status",
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "switch") {
    const mode = String(options.adminMode || "");
    if (mode !== "on" && mode !== "off") throw invalid("--mode is on or off.");
    return {
      name: "preview-3d.switch",
      method: "POST",
      path: "/cli/admin/preview-3d/switch",
      body: { mode },
      mutates: true,
      requiresRun: false,
    };
  }
  throw invalid(PREVIEW_3D_USAGE);
}

export function formatPreview3dResult({ operation, data = {} }) {
  if (operation.name === "preview-3d.switch") {
    return [
      `3D preview: ${data.mode} (confirmed by reading it back; every API process follows within ${data.effectiveWithinSeconds ?? 30} s).`,
      data.mode === "off"
        ? "Looks and thumbnails now run without 3D, as before 3D support. Nothing needs restarting."
        : "Looks and thumbnails ask for 3D again.",
    ];
  }
  const source =
    data.source === "row"
      ? `set by the owner${data.updatedAt ? ` at ${new Date(Number(data.updatedAt) * 1000).toISOString()}` : ""}`
      : data.source === "default"
        ? "the default (never switched)"
        : "the default, because the switch table could not be read";
  const lines = [`3D preview: ${data.mode || "unknown"} · ${source}.`];
  if (data.notice) lines.push(`  ${data.notice}`);
  return lines;
}
