// `lumine admin sponsored-help status|switch` (twinkle-api
// controllers/cli/admin/sponsoredHelp.ts): the owner's kill switch for
// sponsored Zero/Ciel help buttons in DMs, and the daily run's read of how
// they are used.
//   status [--days 1-14]      the switch, per-day events (sent, pressed,
//                             planned, confirmed, completed, declined,
//                             cancelled, expired, failed, refused) with
//                             refunded units, refusal reasons, top senders
//   switch --mode on|owner|off   owner only; owner = only the owner sends and
//                             owner-sent buttons work; effective within 30 s
//   welcome [show]            the new-member welcome per audience: switches,
//                             bot, task, budget, holdout
//   welcome set --audience student|teacher --bot zero|ciel --task "..."
//               [--percent 5|10|15|25|60] [--holdout 0-90]
//                             owner only; Twinkle's budget per new account and
//                             the share that gets the plain greeting to compare
//   welcome switch --mode on|owner|off   owner only; the welcome's sub-switch
//   welcome preview --user <name|id> --audience student|teacher
//                             owner only; the real welcome card as a TEST
export const SPONSORED_HELP_USAGE =
  'Usage: lumine admin sponsored-help status [--days 1-14] | switch --mode on|owner|off | welcome [show] | welcome set --audience student|teacher --bot zero|ciel --task "<request>" [--percent 5|10|15|25|60] [--holdout 0-90] | welcome switch --mode on|owner|off | welcome preview --user <name|id> --audience student|teacher';

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function buildWelcomeOperation({ target, options }) {
  if (!target || target === "show") {
    return {
      name: "sponsored-help.welcome.show",
      method: "GET",
      path: "/cli/admin/sponsored-help/welcome",
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (target === "set") {
    const audience = String(options.adminAudience || "");
    if (audience !== "student" && audience !== "teacher") throw invalid("--audience is student or teacher.");
    const persona = String(options.adminBot || "");
    if (persona !== "zero" && persona !== "ciel") throw invalid("--bot is zero or ciel.");
    const task = String(options.adminTask || "").trim();
    if (task.length < 3) throw invalid('--task is the request in plain words, e.g. --task "Start a word battle with me".');
    const body = { audience, persona, task };
    if (options.adminPercent) body.percent = Number(options.adminPercent);
    if (options.adminHoldout !== "") {
      const holdout = Number(options.adminHoldout);
      if (!Number.isInteger(holdout) || holdout < 0 || holdout > 90) throw invalid("--holdout is a whole percentage from 0 to 90.");
      body.holdoutPercent = holdout;
    }
    return {
      name: "sponsored-help.welcome.set",
      method: "POST",
      path: "/cli/admin/sponsored-help/welcome",
      body,
      mutates: true,
      requiresRun: false,
    };
  }
  if (target === "preview") {
    const user = String(options.adminUser || "").trim();
    if (!user) throw invalid("--user is the account's username or id.");
    const audience = String(options.adminAudience || "");
    if (audience !== "student" && audience !== "teacher") throw invalid("--audience is student or teacher.");
    return {
      name: "sponsored-help.welcome.preview",
      method: "POST",
      path: "/cli/admin/sponsored-help/welcome/preview",
      body: { user, audience },
      mutates: true,
      requiresRun: false,
    };
  }
  if (target === "switch") {
    const mode = String(options.adminMode || "");
    if (mode !== "on" && mode !== "off" && mode !== "owner") throw invalid("--mode is on, owner or off.");
    return {
      name: "sponsored-help.welcome.switch",
      method: "POST",
      path: "/cli/admin/sponsored-help/welcome/switch",
      body: { mode },
      mutates: true,
      requiresRun: false,
    };
  }
  throw invalid(SPONSORED_HELP_USAGE);
}

export function buildSponsoredHelpOperation({ action, target, options = {} }) {
  if (action === "welcome") return buildWelcomeOperation({ target, options });
  if (!action || action === "status") {
    const days = Number(options.adminDays || 1);
    if (!Number.isInteger(days) || days < 1 || days > 14) {
      throw invalid("--days is a whole number from 1 to 14.");
    }
    return {
      name: "sponsored-help.status",
      method: "GET",
      path: `/cli/admin/sponsored-help/status?days=${days}`,
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "switch") {
    const mode = String(options.adminMode || "");
    if (mode !== "on" && mode !== "off" && mode !== "owner") throw invalid("--mode is on, owner or off.");
    return {
      name: "sponsored-help.switch",
      method: "POST",
      path: "/cli/admin/sponsored-help/switch",
      body: { mode },
      mutates: true,
      requiresRun: false,
    };
  }
  throw invalid(SPONSORED_HELP_USAGE);
}

export function formatSponsoredHelpResult({ operation, data = {} }) {
  if (operation.name === "sponsored-help.welcome.preview") {
    return [
      `Sent a TEST ${data.audience} welcome to ${data.username} (#${data.userId}) from ${data.persona === "ciel" ? "Ciel" : "Zero"}: "${data.task}" (request ${data.requestId}).`,
      "  Twinkle pays; it is not that account's one welcome, and telemetry reports it as a test.",
      `  Open it: /chat/${data.pathId}`,
    ];
  }
  if (operation.name === "sponsored-help.welcome.switch") {
    return [
      `New-member welcome button: ${data.mode} (confirmed; every API process follows within ${data.effectiveWithinSeconds ?? 30} s). It also needs sponsored-help on and a task set.`,
    ];
  }
  if (operation.name.startsWith("sponsored-help.welcome.")) {
    const lines = [
      `New-member welcome · sponsored-help ${data.sponsoredHelpSwitch}, welcome ${data.welcomeSwitch} · Twinkle pays a welcome project's first Lumine run up to ${data.lumineFirstRunCapUnits ?? "?"} units.`,
    ];
    for (const a of data.audiences || []) {
      lines.push(
        a.configured
          ? `  ${a.audience}: ${a.active ? "ACTIVE" : "inactive"} · ${a.persona === "ciel" ? "Ciel" : "Zero"} greets with "${a.task}" · budget ${a.energyPercent}% of a battery · holdout ${a.holdoutPercent}%`
          : `  ${a.audience}: no task set, so these new accounts get the plain greeting (welcome set --audience ${a.audience} --bot zero|ciel --task "...")`
      );
    }
    return lines;
  }
  if (operation.name === "sponsored-help.switch") {
    return [
      `Sponsored help buttons: ${data.mode} (confirmed by reading it back; every API process follows within ${data.effectiveWithinSeconds ?? 30} s).`,
      data.mode === "off"
        ? "No new button can be sent, pressed or confirmed. Open requests close on decline or expiry."
        : "Members can send, press and confirm sponsored help buttons.",
    ];
  }
  const lines = [`Sponsored help buttons: ${data.switch || "unknown"} · since site day ${data.fromDay ?? "?"}.`];
  const byDay = new Map();
  for (const row of data.events || []) {
    if (!byDay.has(row.dayIndex)) byDay.set(row.dayIndex, []);
    byDay.get(row.dayIndex).push(
      row.event === "refunded" || row.event === "completed"
        ? `${row.event} ${row.count} (${row.units} units)`
        : `${row.event} ${row.count}`
    );
  }
  if (!byDay.size) lines.push("  No activity.");
  for (const [day, parts] of byDay) lines.push(`  day ${day}: ${parts.join(", ")}`);
  lines.push(`  New-member welcome (switch ${data.welcomeSwitch || "unknown"}):`);
  const welcomeByKey = new Map();
  for (const row of data.welcome || []) {
    const key = `${row.audience || "?"} day ${row.dayIndex}`;
    if (!welcomeByKey.has(key)) welcomeByKey.set(key, []);
    welcomeByKey.get(key).push(`${row.event} ${row.count}`);
  }
  if (!welcomeByKey.size) lines.push("    No activity.");
  for (const [key, parts] of welcomeByKey) lines.push(`    ${key}: ${parts.join(", ")}`);
  if ((data.refusals || []).length) {
    lines.push(`  refused: ${data.refusals.map((r) => `${r.reason} ${r.count}`).join(", ")}`);
  }
  lines.push(...formatWandOutcomes(data.outcomes));
  for (const sender of (data.senders || []).slice(0, 10)) {
    lines.push(
      `  sender ${sender.senderId}: sent ${sender.sent} to ${sender.recipients}, spent ${sender.spentUnits} units, declined ${sender.declined}${sender.openCardsMade ? `, made ${sender.openCardsMade} open card${sender.openCardsMade === 1 ? "" : "s"}` : ""}`
    );
  }
  return lines;
}

// Every wand help's final result (twinkle-api helpers/sponsoredHelp/
// outcomeRules.ts): per task kind, success rate (done out of done + failed),
// who paid (a sponsor, their own Energy, Twinkle), the top failure codes,
// failed steps, and each open wand card's sponsored spots out of its cap
// and its presses on people's own Energy. Missing on an older API.
export function formatWandOutcomes(outcomes) {
  if (!outcomes) return [];
  const lines = ["  Wand outcomes (one record per press):"];
  const tasks = outcomes.tasks || [];
  if (!tasks.length) lines.push("    No finished presses.");
  for (const t of tasks) {
    const rate = t.successRate === null || t.successRate === undefined ? "n/a" : `${Math.round(t.successRate * 100)}%`;
    lines.push(
      `    ${t.task}: ${t.presses} pressed, ${t.done} done, ${t.failed} failed, ${t.abandoned} abandoned, ${t.notAvailable} not available${t.unpressed ? ` (+${t.unpressed} never pressed)` : ""} · success ${rate} · paid by sponsor ${t.sponsored ?? 0}, own Energy ${t.selfPaid ?? 0}${t.twinkle ? `, Twinkle ${t.twinkle}` : ""} · ${t.spentUnits} units`
    );
  }
  if ((outcomes.topFailures || []).length) {
    lines.push(`    top failures: ${outcomes.topFailures.map((f) => `${f.task}:${f.code} ${f.count}`).join(", ")}`);
  }
  if ((outcomes.stepFailures || []).length) {
    lines.push(`    failed steps: ${outcomes.stepFailures.map((s) => `${s.step} ${s.count}`).join(", ")}`);
  }
  for (const card of outcomes.openCards || []) {
    lines.push(
      `    open card ${card.openCardId} (sender ${card.senderId}, ${card.taskKind || "?"}): sponsored ${card.sponsoredUsed}/${card.sponsorCap} started (+${card.sponsoredHeld} waiting), ${card.selfPaid} on their own Energy, ${card.presses} pressed, ${card.done} done · ${card.sponsoredUnits} sponsor units, ${card.selfUnits} own units${card.closed ? ", closed" : ""}`
    );
  }
  return lines;
}
