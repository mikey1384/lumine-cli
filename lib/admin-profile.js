// `lumine admin profile show <user-id|username>`: a member's public profile as
// a reviewer reads it (identity, rank and titles, bio, counts, and their
// latest public subjects, comments, builds, AI stories and shared
// reflections), for the daily run's Notable Users candidate check without a
// browser. Read-only; a daily-run read like `brief` (content:read). The API
// serves it as a signed-out visitor would see the profile: no emails.

export const PROFILE_USAGE =
  "Usage: lumine admin profile show <user-id|username> [--json].";

const SITE_DAY_MS = 24 * 60 * 60 * 1000;

function validationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export function buildProfileShowOperation({ action, target, extra }) {
  const rawTarget = String(target || "").trim();
  if (action !== "show" || !rawTarget || extra) {
    throw validationError(PROFILE_USAGE);
  }
  const query = new URLSearchParams();
  if (/^\d+$/.test(rawTarget)) {
    const userId = Number(rawTarget);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw validationError("The user ID must be a positive integer.");
    }
    query.set("userId", String(userId));
  } else {
    query.set("username", rawTarget.replace(/^@/, ""));
  }
  return {
    name: "profile.show",
    method: "GET",
    path: `/cli/admin/profile?${query.toString()}`,
    body: undefined,
    mutates: false,
  };
}

function day(seconds) {
  const value = Number(seconds || 0);
  return value ? new Date(value * 1000).toISOString().slice(0, 10) : "unknown";
}

function ago(seconds, now) {
  const value = Number(seconds || 0);
  if (!value) return "";
  const days = Math.floor((now - value * 1000) / SITE_DAY_MS);
  if (days <= 0) return " (under a day ago)";
  return ` (${days} day${days === 1 ? "" : "s"} ago)`;
}

function section(lines, heading, items, describe) {
  lines.push("");
  lines.push(`${heading} (${items.length}):`);
  if (!items.length) {
    lines.push("  (none)");
    return;
  }
  for (const item of items) {
    const [head, ...rest] = describe(item);
    lines.push(`  ${head}`);
    for (const line of rest) if (line) lines.push(`    ${line}`);
  }
}

function describeCommentRoot(item) {
  if (item.subjectTitle) return `"${item.subjectTitle}"`;
  if (item.rootType === "user") {
    return item.rootId ? `user #${item.rootId}'s profile` : "a profile";
  }
  return `${item.rootType || "post"}${item.rootId ? ` ${item.rootId}` : ""}`;
}

export function formatProfileReview(data = {}, { now = Date.now() } = {}) {
  const profile = data.profile || {};
  const counts = data.counts || {};
  const recent = data.recent || {};
  const lines = [];
  lines.push(
    `${profile.username || "(no username)"} (#${profile.id})${profile.realName ? ` · ${profile.realName}` : ""}${profile.isNotable ? " · on Notable Users" : ""}`,
  );
  if (profile.url) lines.push(profile.url);
  lines.push(
    `Joined ${day(profile.joinedAt)}${ago(profile.joinedAt, now)} · last active ${day(profile.lastActive)}${ago(profile.lastActive, now)}`,
  );
  const standing = [
    profile.rank ? `rank #${profile.rank}` : "",
    `${Number(profile.twinkleXP || 0).toLocaleString("en-US")} XP`,
    profile.xpThisMonth
      ? `${Number(profile.xpThisMonth).toLocaleString("en-US")} XP this month`
      : "",
    `${Number(profile.achievementPoints || 0).toLocaleString("en-US")} AP`,
    profile.userType ? `type ${profile.userType}` : "",
    profile.title ? `title "${profile.title}"` : "",
  ].filter(Boolean);
  lines.push(standing.join(" · "));
  if (Array.isArray(profile.achievements) && profile.achievements.length) {
    lines.push(`Achievements: ${profile.achievements.join(", ")}`);
  }
  if (profile.isNotable && profile.notableReason) {
    lines.push(`Notable because: ${profile.notableReason}`);
  }
  if (profile.statusMsg) lines.push(`Status: ${profile.statusMsg}`);
  if (profile.greeting) lines.push(`Greeting: ${profile.greeting}`);
  if (Array.isArray(profile.bio) && profile.bio.length) {
    lines.push(`Bio: ${profile.bio.join(" / ")}`);
  }
  const links = [profile.website, profile.youtubeUrl].filter(Boolean);
  if (links.length) lines.push(`Links: ${links.join(" · ")}`);
  lines.push(
    `Counts: ${counts.subjects ?? 0} subjects · ${counts.comments ?? 0} comments · ${counts.aiStories ?? 0} AI stories · ${counts.builds ?? 0} public builds · ${counts.sharedReflections ?? 0} shared reflections${profile.pictures ? ` · ${profile.pictures} profile pictures` : ""}`,
  );

  section(lines, "Recent subjects", recent.subjects || [], (item) => [
    `${day(item.createdAt)}  ${item.title || "(untitled)"}  ${item.url}`,
    item.excerpt,
  ]);
  section(lines, "Recent comments", recent.comments || [], (item) => [
    `${day(item.createdAt)}  on ${describeCommentRoot(item)}  ${item.url}`,
    item.excerpt,
  ]);
  section(lines, "Recent public builds", recent.builds || [], (item) => [
    `${day(item.publishedAt || item.updatedAt)}  ${item.title || "(untitled)"}  ${item.url}`,
    item.excerpt,
  ]);
  section(lines, "Recent AI stories", recent.aiStories || [], (item) => [
    `${day(item.createdAt)}  ${item.title || "(no topic)"}  ${item.url}`,
  ]);
  section(lines, "Recent shared reflections", recent.reflections || [], (item) => [
    `${day(item.createdAt)}  ${item.url}${item.question ? `  Q: ${item.question}` : ""}`,
    item.excerpt ? `"${item.excerpt}"` : "",
  ]);
  return lines;
}
