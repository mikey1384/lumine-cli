// lumine chatlog: what players said in a Build app's realtime world, for the
// app's owner (or an admin). Logging is off until switched on per app:
//
//   lumine chatlog [build] [--since 2h] [--limit 100] [--instance <id>] [--json]
//   lumine chatlog enable [build]     (players see a notice while it is on)
//   lumine chatlog disable [build]
import { requestJson } from "./http.js";
import { ensureAuth, assertAuthScope } from "./auth.js";
import { resolveRequiredBuildId } from "./util.js";
import { resolveRequiredBuildIdOrSelected } from "./commands.js";

const ACTIONS = new Set(["enable", "disable", "show"]);

async function resolveTarget(options, auth, rawTarget) {
  if (rawTarget) {
    const buildId = resolveRequiredBuildId(rawTarget);
    if (!Number.isSafeInteger(buildId) || buildId <= 0) {
      throw new Error("Pass a Twinkle build URL or positive integer build id.");
    }
    return buildId;
  }
  return await resolveRequiredBuildIdOrSelected(options, auth);
}

function formatTime(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function chatlogCommand(options) {
  const positional = options.positional || [];
  const action = ACTIONS.has(String(positional[0] || ""))
    ? String(positional[0])
    : "show";
  const rawTarget = String(
    options.target && !ACTIONS.has(options.target)
      ? options.target
      : action === "show"
        ? positional[0] || ""
        : positional[1] || "",
  ).trim();
  const auth = await ensureAuth(options);
  await assertAuthScope({
    options,
    auth,
    scope: action === "show" ? "build:read" : "build:write",
  });
  const buildId = await resolveTarget(options, auth, rawTarget);

  if (action !== "show") {
    const enabled = action === "enable";
    const result = await requestJson({
      method: "PUT",
      url: `${options.apiUrl}/build/${buildId}/chat-log-setting`,
      authToken: auth.token,
      body: { enabled },
      timeoutMs: options.timeoutMs,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      enabled
        ? `Chat logging is ON for ${result.title} (#${result.buildId}). Lines are kept ${result.retentionDays} days, and players see a notice while it is on.`
        : `Chat logging is OFF for ${result.title} (#${result.buildId}). Nothing new is stored; saved lines expire after ${result.retentionDays} days.`,
    );
    return;
  }

  const query = new URLSearchParams();
  query.set("since", String(options.chatlogSince || "24h"));
  const limit = Math.floor(Number(options.chatlogLimit || 100));
  query.set("limit", String(Number.isFinite(limit) && limit > 0 ? limit : 100));
  if (options.chatlogInstance) query.set("instance", options.chatlogInstance);
  if (options.cursor) query.set("cursor", String(options.cursor));
  const result = await requestJson({
    method: "GET",
    url: `${options.apiUrl}/build/${buildId}/chat-log?${query.toString()}`,
    authToken: auth.token,
    timeoutMs: options.timeoutMs,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const messages = Array.isArray(result.messages) ? result.messages : [];
  console.log(
    `Chat log for ${result.title} (#${result.buildId}): logging ${result.enabled ? "ON" : "OFF"}, kept ${result.retentionDays} days.`,
  );
  if (!messages.length) {
    console.log(
      result.enabled
        ? `No chat since ${query.get("since")}.`
        : "Nothing logged. Turn it on with: lumine chatlog enable",
    );
    return;
  }
  // oldest first, like reading a conversation
  for (const m of [...messages].reverse()) {
    const who = m.username || (m.guest ? "Guest" : `user ${m.userId}`);
    console.log(`${formatTime(m.createdAt)}  [${m.instanceId || "-"}]  ${who}: ${m.text}`);
  }
  if (result.nextCursor) {
    console.log(`Older lines: lumine chatlog ${result.buildId} --since ${query.get("since")} --cursor ${result.nextCursor}`);
  }
}
