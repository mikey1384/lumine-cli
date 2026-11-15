// `lumine admin classes ...` (twinkle-api controllers/cli/admin/classes.ts):
// classroom sign-up (class codes) for the owner and the daily run.
//   report [--days N]            who uses it and how it's going (read-only)
//   list [--user <teacherId>]    classes with their code state (read-only)
//   flagged                      classes where a joiner was marked "Not my student"
//   show <classId>               one class: roster, removals, reset-code log
//   revoke <classId>             owner only: turn that class's code off
//   separate-mailboxes [--dry-run | --confirm]
//                                owner only: teacher mailboxes that carry several
//                                accounts get separate AI Energy per account
//                                (the `separate_accounts` email policy); with
//                                no flag it is the dry run
// No daily run is needed for any of them.
export const CLASSES_USAGE =
  "Usage: lumine admin classes report [--days 1..90] | list [--user <teacherId>] | flagged | show <classId> | revoke <classId> | separate-mailboxes [--dry-run | --confirm]";

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw invalid(`${name} must be a positive whole number. ${CLASSES_USAGE}`);
  return number;
}

const read = (name, path) => ({ name, method: "GET", path, body: undefined, mutates: false, requiresRun: false });

export function buildClassesOperation({ action, target, options = {} }) {
  if (!action || action === "report") {
    const days = options.adminDays ? positiveInteger(options.adminDays, "--days") : 14;
    if (days > 90) throw invalid("--days is at most 90.");
    return read("classes.report", `/cli/admin/classes/report?days=${days}`);
  }
  if (action === "list") {
    const teacher = options.adminUser ? positiveInteger(options.adminUser, "--user") : 0;
    return read("classes.list", `/cli/admin/classes${teacher ? `?teacher=${teacher}` : ""}`);
  }
  if (action === "flagged") return read("classes.list", "/cli/admin/classes?flagged=1");
  if (action === "show") {
    return read("classes.show", `/cli/admin/classes/${positiveInteger(target, "The class id")}`);
  }
  if (action === "revoke") {
    return {
      name: "classes.revoke",
      method: "POST",
      path: `/cli/admin/classes/${positiveInteger(target, "The class id")}/revoke`,
      body: {},
      mutates: true,
      requiresRun: false,
    };
  }
  if (action === "separate-mailboxes") {
    const confirm = options.adminConfirm === "true" || options.adminConfirm === true;
    if (confirm && options.adminDryRun) throw invalid("Pass --dry-run or --confirm, not both.");
    if (!confirm) return read("classes.mailboxes.preview", "/cli/admin/classes/teacher-mailboxes");
    return {
      name: "classes.mailboxes.separate",
      method: "POST",
      path: "/cli/admin/classes/teacher-mailboxes/separate",
      body: { confirm: true },
      mutates: true,
      requiresRun: false,
      timeoutMs: 180000,
    };
  }
  throw invalid(CLASSES_USAGE);
}

const day = (seconds) => (seconds ? new Date(Number(seconds) * 1000).toISOString().slice(0, 10) : "-");
const percent = (value) => (value === null || value === undefined ? "n/a" : `${value}%`);
const pairs = (object = {}) =>
  Object.entries(object)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ") || "none";

function cohortLine(label, cohort = {}) {
  const d1 = cohort.day1 || {};
  const d7 = cohort.day7 || {};
  return `  ${label}: ${cohort.signups ?? 0} sign-ups · day 1 ${d1.active ?? 0}/${d1.eligible ?? 0} (${percent(d1.percent)}) · day 7 ${d7.active ?? 0}/${d7.eligible ?? 0} (${percent(d7.percent)})`;
}

export function formatClassesReport(data = {}) {
  const a = data.adoption || {};
  const f = data.funnel || {};
  const d = data.discovery || {};
  const r = data.resets || {};
  const k = data.asks || {};
  const lines = [
    `Classroom sign-up, last ${data.windowDays} day(s)${data.live === false ? " · TABLES MISSING" : ""}`,
    "",
    "Who is using it",
    `  ${a.teachersWithClass ?? 0} teacher(s) with a class (${a.teachersNewInWindow ?? 0} new) · ${a.classes ?? 0} class(es) (${a.classesNewInWindow ?? 0} new, ${a.classesWithLiveCode ?? 0} with a live code) · ${a.members ?? 0} student(s) on rosters (${a.joinedInWindow ?? 0} joined in this window)`,
  ];
  for (const branch of data.branches || []) {
    lines.push(`  ${branch.branch}: ${branch.teachers} teacher(s), ${branch.classes} class(es), ${branch.members} student(s), ${branch.joinedInWindow} joined`);
  }
  if ((data.teachers || []).length) lines.push("", "Teachers (most joiners first)");
  for (const teacher of data.teachers || []) {
    lines.push(
      `  ${teacher.username} (#${teacher.teacherId})${teacher.branch ? ` · ${teacher.branch}` : ""}: ${teacher.classes} class(es), ${teacher.members} student(s), ${teacher.joinedInWindow} joined, last join ${day(teacher.lastJoinAt)}${teacher.resetsInWindow ? `, ${teacher.resetsInWindow} reset code(s)` : ""}${teacher.notMyStudentInWindow ? `, ${teacher.notMyStudentInWindow} "Not my student"` : ""}`,
    );
  }
  if (data.teachersOmitted) lines.push(`  … and ${data.teachersOmitted} more teacher(s) (--json has the same top list; use list --user <id>)`);
  if ((data.classes || []).length) lines.push("", "Classes (most joiners first)");
  for (const row of data.classes || []) {
    lines.push(
      `  #${row.classroomId} ${row.className} · ${row.teacher}${row.branch ? ` · ${row.branch}` : ""}: code ${row.code}${row.seats ? ` (${row.seats} seats)` : ""}, ${row.members} on roster, ${row.joinedInWindow} joined, visits ${pairs(row.visits)}`,
    );
  }
  if (data.classesOmitted) lines.push(`  … and ${data.classesOmitted} more class(es)`);
  lines.push(
    "",
    "How teachers found it",
    `  Offer card: shown to ${d.card?.teachersShown ?? 0} teacher(s) (${pairs(d.card?.viewsBySurface)} views) · ${d.card?.used ?? 0} used (${pairs(d.card?.usedBy)}) · ${d.card?.dismissed ?? 0} dismissed · ${d.card?.nowHaveClass ?? 0} of them now have a class`,
    `  Hints: shown ${pairs(d.hints?.shown)} · clicked ${pairs(d.hints?.clicked)}`,
    `  Zero/Ciel guide hits: ${d.guideHits ?? 0} · help page views: ${d.helpPageViews ?? 0} (${pairs(d.helpPageBySource)}) · My classes views: ${d.classesPageViews ?? 0}`,
    `  Codes: shown ${data.codes?.shown ?? 0} (${pairs(data.codes?.shownBy)}) · kept/renewed ${data.codes?.renewed ?? 0} · turned off ${data.codes?.turnedOff ?? 0}`,
    "",
    "How joining is going",
    `  Visits ${f.visits ?? 0} (${pairs(f.visitsByMethod)}) → sign-up started ${f.signupStarted ?? 0} → password ${f.reachedPassword ?? 0} → name ${f.reachedName ?? 0} → joined ${f.completed ?? 0} (${pairs(f.completedByMethod)})`,
    `  Visit → joined ${percent(f.visitToSignupPercent)} · started → joined ${percent(f.startedToSignupPercent)} · stopped at: username ${f.abandonedAt?.username ?? 0}, password ${f.abandonedAt?.password ?? 0}, name ${f.abandonedAt?.name ?? 0}`,
    `  Wrong/ended codes ${f.invalidVisits ?? 0} (${pairs(f.invalidByMethod)}) · already signed in ${f.alreadySignedInVisits ?? 0} · refused: ${pairs(f.refused)}`,
    "",
    'Students asking a teacher ("Ask my teacher" at sign-up)',
    `  Opened ${k.opened ?? 0} · searches ${k.searches ?? 0} (${pairs(k.searchesBy)}) · requests ${k.requests ?? 0} to ${k.teachersAsked ?? 0} teacher(s) (${k.withNote ?? 0} with a note) · repeats not re-sent ${k.repeatsMuted ?? 0} · turned away: ${pairs(k.turnedAway)}`,
    `  Teachers: opened ${k.teacherOpened ?? 0} · sent a pass ${k.answered?.sent ?? 0} · put aside ${k.answered?.putAside ?? 0} · average answer ${k.averageAnswerMinutes == null ? "n/a" : `${k.averageAnswerMinutes} min`} · waiting ${k.waiting ?? 0} · ran out unanswered ${k.unanswered ?? 0} · joined from a pass ${k.joined ?? 0}`,
    `  Today's Progress row: ${data.progressRow?.clicks ?? 0} click(s) (${pairs(data.progressRow?.by)})`,
    "",
    "Roster and resets",
    `  "Not my student": ${data.roster?.notMyStudent ?? 0}`,
    `  Reset codes: ${r.issued ?? 0} issued by ${r.teachers ?? 0} teacher(s) for ${r.students ?? 0} student(s) · ${r.used ?? 0} used · ${r.expiredUnused ?? 0} ran out unused · ${r.waiting ?? 0} waiting · refused tries: ${pairs(r.refused)}`,
    "",
    "Are joiners still around (class codes vs. every other sign-up)",
  );
  if (data.retention) {
    lines.push(cohortLine("Class joiners", data.retention.classJoiners), cohortLine("Other sign-ups", data.retention.otherSignups));
    if (data.retentionNote) lines.push(`  (${data.retentionNote})`);
  } else {
    lines.push("  not available");
  }
  lines.push("", "Look into");
  if ((data.attention || []).length) for (const line of data.attention) lines.push(`  - ${line}`);
  else lines.push("  nothing");
  return lines;
}

export function formatClassesResult({ operation, data = {} }) {
  if (operation.name === "classes.report") return formatClassesReport(data);
  if (operation.name === "classes.list") {
    const rows = data.classes || [];
    if (!rows.length) return ["No classes."];
    const lines = rows.map(
      (row) =>
        `#${row.classroomId} ${row.className} · ${row.teacher} (#${row.teacherId})${row.branch ? ` · ${row.branch}` : ""} · made ${day(row.createdAt)} · code ${row.code}${row.seats ? ` (${row.seats})` : ""} · ${row.members} on roster${row.notMyStudent ? ` · ${row.notMyStudent} "Not my student"` : ""}${row.resets ? ` · ${row.resets} reset code(s)` : ""}`,
    );
    if (data.more) lines.push("… more classes exist: narrow with --user <teacherId>.");
    return lines;
  }
  if (operation.name === "classes.show") {
    const c = data.class || {};
    const lines = [
      `#${c.classroomId} ${c.className} · ${c.teacher} (#${c.teacherId})${c.branch ? ` · ${c.branch}` : ""} · made ${day(c.createdAt)}`,
      `Code: ${c.code}${c.seats ? ` (${c.seats} seats)` : ""}${c.codeExpiresAt ? ` · until ${day(c.codeExpiresAt)}` : ""}${c.codeTurnedOffBy ? ` · turned off by #${c.codeTurnedOffBy}` : ""}`,
      "",
      `Roster (${(data.roster || []).length})`,
    ];
    for (const m of data.roster || []) {
      lines.push(
        `  ${m.username || "(deleted)"} (#${m.userId}) · joined ${day(m.joinedAt)} by ${m.method || "?"}${m.hasEmail ? " · has an email" : ""}${m.notMyStudentAt ? ` · NOT MY STUDENT ${day(m.notMyStudentAt)}` : ""}`,
      );
    }
    lines.push("", `Reset codes (${(data.resets || []).length})`);
    for (const r of data.resets || []) {
      lines.push(
        `  ${day(r.issuedAt)} teacher #${r.teacherId} → ${r.student || "(deleted)"} (#${r.studentId}): ${r.state}${r.wrongTries ? `, ${r.wrongTries} wrong tries` : ""}${r.state === "used" ? (r.samePlace ? " · made and used on the same network" : ` · made at ${r.issuedFrom || "?"}, used at ${r.usedFrom || "?"}`) : ""}`,
      );
    }
    return lines;
  }
  if (operation.name === "classes.revoke") {
    return [data.changed ? `Class #${data.classroomId}: the code is off. Nobody can join with it now.` : `Class #${data.classroomId}: the code was already off.`];
  }
  if (operation.name === "classes.mailboxes.preview") {
    const lines = [
      `DRY RUN, nothing changed. ${data.teacherMailboxesChecked ?? 0} teacher mailbox(es) checked · ${data.alreadySeparate ?? 0} already separate · ${data.toSeparate ?? 0} to separate (${data.accountsAffected ?? 0} account(s)).`,
    ];
    for (const m of data.mailboxes || []) lines.push(`  ${m.teacher} (#${m.teacherId}) · ${m.mailbox} · ${m.accounts} account(s)`);
    if (data.next) lines.push(data.next);
    return lines;
  }
  if (operation.name === "classes.mailboxes.separate") {
    const lines = [`Separated ${data.separated ?? 0} teacher mailbox(es) (${data.accountsAffected ?? 0} account(s) now have their own AI Energy). ${data.remaining ?? 0} left.`];
    for (const m of data.mailboxes || []) lines.push(`  ${m.teacher} (#${m.teacherId}) · ${m.mailbox} · ${m.accounts} account(s)`);
    for (const m of data.failed || []) lines.push(`  FAILED ${m.teacher} (#${m.teacherId}) · ${m.mailbox}: ${m.reason}`);
    if (data.next) lines.push(data.next);
    return lines;
  }
  return [JSON.stringify(data, null, 2)];
}
