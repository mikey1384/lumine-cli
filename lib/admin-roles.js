// `lumine admin roles`: every user type with its management level and who
// holds it. Read-only; no daily run needed. A member's level is the higher of
// their user type's level and what their achievement points earn; points stop
// below admin, so the admin holders listed here are everyone at that level.

export const ROLES_USAGE =
  "Usage: lumine admin roles [--min-level 1] [--limit 50] [--json].";

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function optionalInteger(value, flag, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).trim());
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw validationError(`${flag} must be an integer ${min}-${max}.`);
  }
  return number;
}

export function buildRolesOperation(options) {
  const query = new URLSearchParams();
  const minLevel = optionalInteger(options.adminMinLevel, "--min-level", 0, 10);
  const limit = optionalInteger(options.adminLimit, "--limit", 1, 500);
  if (minLevel !== null) query.set("minLevel", String(minLevel));
  if (limit !== null) query.set("limit", String(limit));
  const qs = query.toString();
  return {
    name: "roles.read",
    method: "GET",
    path: `/cli/admin/roles${qs ? `?${qs}` : ""}`,
    body: undefined,
    mutates: false,
    requiresRun: false,
  };
}

function day(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "never";
}

export function formatRoles(data) {
  const lines = [];
  const points = (data.fromAchievementPoints || [])
    .map((p) => `level ${p.managementLevel} from ${p.minAchievementPoints} AP`)
    .join(", ");
  lines.push(
    `Admin pages and lumine admin need management level ${data.adminLevel}+. A member's level is the higher of their user type's and their achievement points' (${points || "none"}; points never pass level ${data.maxLevelFromAchievementPoints}).`,
  );
  for (const type of data.types || []) {
    lines.push("");
    lines.push(`${type.label}: level ${type.managementLevel}, ${type.holders} holder${type.holders === 1 ? "" : "s"}`);
    if (!type.members) continue;
    for (const m of type.members) {
      lines.push(
        `  #${m.userId} ${m.username}${m.realName ? ` (${m.realName})` : ""}${m.isOwner ? " [owner]" : ""} · last active ${day(m.lastActive)}`,
      );
    }
    if (type.members.length < type.holders) {
      lines.push(`  … ${type.holders - type.members.length} more (raise --limit)`);
    }
  }
  if (data.minLevel > 0) {
    lines.push("");
    lines.push(`Members listed for level ${data.minLevel}+ types; --min-level 0 lists every type's holders.`);
  }
  return lines.join("\n");
}

export function printRoles(data) {
  console.log(formatRoles(data));
}
