// `lumine admin apprentice ...` (twinkle-api controllers/cli/admin/apprentice.ts):
// Mikey's Apprentice applicants, for the owner and the daily run. Read-only
// except `note`, which records an observation. Nothing here decides, ranks,
// notifies or contacts anyone; Mikey decides.
//   applicants                      every sent application, newest update first,
//                                   with what changed and 14-day page counts
//   show <user>                     one applicant: latest version, what changed in
//                                   each update, activity summary (the Notables
//                                   signals + recent comments), observations
//   note <user> --polarity positive|negative|neutral --trait <quality>
//        --note <what you saw> [--evidence <twin-kle.com link>]
// No daily run is needed; a note made during one is tied to it.
export const APPRENTICE_USAGE =
  "Usage: lumine admin apprentice applicants | show <userId|username> | note <userId|username> --polarity positive|negative|neutral --trait <quality> --note <what you saw> [--evidence <link>]";

export const APPRENTICE_TRAITS = [
  "agency",
  "self-improvement",
  "self-awareness",
  "independent-thinking",
  "builds-for-others",
  "adaptability",
  "curiosity",
  "ai-proficiency",
  "communication",
  "maturity",
];
const POLARITIES = ["positive", "negative", "neutral"];

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function requireTarget(target) {
  const text = String(target || "").trim();
  if (!text) throw invalid(APPRENTICE_USAGE);
  return text;
}

const read = (name, path) => ({ name, method: "GET", path, body: undefined, mutates: false, requiresRun: false });

export function buildApprenticeOperation({ action, target, options = {} }) {
  if (!action || action === "applicants" || action === "list") {
    return read("apprentice.applicants", "/cli/admin/apprentice/applicants");
  }
  if (action === "show") {
    return read("apprentice.show", `/cli/admin/apprentice/applicants/${encodeURIComponent(requireTarget(target))}`);
  }
  if (action === "note") {
    const who = requireTarget(target);
    const polarity = String(options.notablePolarity || "").trim();
    if (!POLARITIES.includes(polarity)) throw invalid(`--polarity is one of: ${POLARITIES.join(", ")}.`);
    const trait = String(options.notableTrait || "").trim();
    if (!APPRENTICE_TRAITS.includes(trait)) {
      throw invalid(`--trait is one of the posted qualities: ${APPRENTICE_TRAITS.join(", ")}.`);
    }
    const note = String(options.note || "").trim();
    if (!note) throw invalid("Say what you saw with --note <text> (and link it with --evidence).");
    return {
      name: "apprentice.note",
      method: "POST",
      path: "/cli/admin/apprentice/notes",
      body: { target: who, polarity, trait, note, evidenceUrl: String(options.notableEvidence || "").trim() },
      mutates: true,
      requiresRun: false,
    };
  }
  throw invalid(APPRENTICE_USAGE);
}

const day = (seconds) => (seconds ? new Date(Number(seconds) * 1000).toISOString().slice(0, 10) : "-");
const via = (sentVia) => (sentVia ? ` (sent via ${sentVia === "assistant" ? "Zero or Ciel" : sentVia[0].toUpperCase() + sentVia.slice(1)})` : "");
const sign = (polarity) => (polarity === "positive" ? "+" : polarity === "negative" ? "-" : "·");

export function formatApprenticeResult({ operation, data = {} }) {
  if (operation.name === "apprentice.applicants") {
    const lines = [];
    const rows = data.applicants || [];
    if (!rows.length) lines.push("No applications sent yet.");
    for (const row of rows) {
      lines.push(
        `${row.username} (#${row.userId}) · v${row.revision} · last sent ${day(row.lastSubmittedAt)}${via(row.lastSentVia)} (first ${day(row.firstSubmittedAt)}) · changed: ${(row.lastChanged || []).join(", ") || "-"} · ${row.observations || 0} observation(s)${row.lastObservedAt ? `, last ${day(row.lastObservedAt)}` : ""}`,
      );
    }
    if (data.unsentDrafts) lines.push(`${data.unsentDrafts} unsent draft(s) (private until sent).`);
    const t = data.counts?.totals;
    if (t) {
      lines.push(
        "",
        `Last ${data.counts.days} days: page views ${t.page_view} · forms opened ${t.form_opened} · started ${t.application_started} · sent ${t.application_submitted} · updated ${t.application_updated} · Zero/Ciel advisor reads ${t.advisor_read}`,
      );
    }
    if (data.reminder) lines.push("", data.reminder);
    return lines;
  }
  if (operation.name === "apprentice.show") {
    const u = data.user || {};
    const latest = data.latest || {};
    const answers = latest.answers || {};
    const activity = data.activity || {};
    const lines = [
      `${u.username} (#${u.userId}) · joined ${day(u.joinedAt)} · last active ${day(u.lastActive)}`,
      `Version ${data.revision} sent ${day(data.lastSubmittedAt)} (first ${day(data.firstSubmittedAt)})`,
      "",
      "Picks",
    ];
    for (const pick of latest.picks || []) lines.push(`  ${pick.type} ${pick.title} https://www.twin-kle.com${pick.path}`);
    if (!(latest.picks || []).length) lines.push("  none");
    const labels = {
      built: "What they have built",
      justDid: "A time they just did something",
      aiUse: "How they use AI",
      improve: "What they would improve",
      more: "Anything else",
    };
    for (const [field, label] of Object.entries(labels)) {
      if (!String(answers[field] || "").trim()) continue;
      lines.push("", label);
      for (const line of String(answers[field]).split("\n")) lines.push(`  ${line}`);
    }
    lines.push("", "Versions (newest first)");
    for (const item of data.timeline || []) {
      lines.push(`  v${item.revision} ${day(item.submittedAt)}${via(item.sentVia)}: ${(item.changed || []).join(", ")}`);
    }
    lines.push(
      "",
      "Activity",
      `  ${activity.publicBuildCount ?? 0} public build(s) · ${activity.postsLast90Days ?? 0} post(s) in 90 days · ${activity.commentsLast30Days ?? 0} comment(s) in 30 days`,
    );
    for (const build of activity.publicBuilds || []) lines.push(`  build ${build.title} https://www.twin-kle.com${build.path}`);
    for (const fact of activity.facts || []) lines.push(`  ${fact}`);
    const n = activity.notable;
    if (n) {
      lines.push(`  Notables: ${n.isNotable ? "on the list" : "not on the list"}${n.bestArchetype ? ` · strongest ${n.bestArchetype}` : ""}${n.scored ? "" : " · not scored yet"}`);
      for (const note of n.characterNotes || []) lines.push(`  character ${sign(note.polarity)} ${note.trait}: ${note.note}`);
    }
    if ((activity.recentComments || []).length) lines.push("", "Recent comments (how they communicate)");
    for (const comment of activity.recentComments || []) lines.push(`  ${day(comment.at)} ${comment.excerpt} ${comment.url}`);
    lines.push("", `Observations (${(data.observations || []).length})`);
    for (const item of data.observations || []) {
      lines.push(`  ${day(item.at)} ${sign(item.polarity)} ${item.trait}: ${item.note}${item.evidenceUrl ? ` ${item.evidenceUrl}` : ""}${item.by ? ` (${item.by})` : ""}`);
    }
    return lines;
  }
  if (operation.name === "apprentice.note") {
    return [
      data.duplicate
        ? `Already recorded today for ${data.username} (#${data.id}).`
        : `Recorded ${sign(data.polarity)} ${data.trait} for ${data.username} (#${data.id}).`,
    ];
  }
  return [JSON.stringify(data, null, 2)];
}
