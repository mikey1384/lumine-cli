import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatClassesResult } from "../lib/admin-classes.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("classes report is a run-free read with a bounded window", () => {
  for (const report of [op("classes"), op("classes", "report")]) {
    assert.equal(report.name, "classes.report");
    assert.equal(report.method, "GET");
    assert.equal(report.path, "/cli/admin/classes/report?days=14");
    assert.equal(report.mutates, false);
    assert.equal(report.requiresRun, false);
  }
  assert.equal(op("classes", "report", "--days", "7").path, "/cli/admin/classes/report?days=7");
  assert.throws(() => op("classes", "report", "--days", "91"), /at most 90/);
  assert.throws(() => op("classes", "report", "--days", "0"), /positive whole number/);
});

test("classes list, flagged and show are reads; revoke is the only class write", () => {
  assert.equal(op("classes", "list").path, "/cli/admin/classes");
  assert.equal(op("classes", "list", "--user", "42").path, "/cli/admin/classes?teacher=42");
  assert.equal(op("classes", "flagged").path, "/cli/admin/classes?flagged=1");
  assert.equal(op("classes", "flagged").mutates, false);
  const show = op("classes", "show", "9");
  assert.equal(show.path, "/cli/admin/classes/9");
  assert.equal(show.mutates, false);
  assert.throws(() => op("classes", "show"), /class id must be a positive whole number/);
  const revoke = op("classes", "revoke", "9");
  assert.equal(revoke.method, "POST");
  assert.equal(revoke.path, "/cli/admin/classes/9/revoke");
  assert.equal(revoke.mutates, true);
  assert.equal(revoke.requiresRun, false);
  assert.throws(() => op("classes", "revoke", "abc"), /positive whole number/);
  assert.throws(() => op("classes", "delete", "9"), /Usage: lumine admin classes/);
});

test("separate-mailboxes changes nothing without --confirm", () => {
  for (const preview of [op("classes", "separate-mailboxes"), op("classes", "separate-mailboxes", "--dry-run")]) {
    assert.equal(preview.name, "classes.mailboxes.preview");
    assert.equal(preview.method, "GET");
    assert.equal(preview.path, "/cli/admin/classes/teacher-mailboxes");
    assert.equal(preview.mutates, false);
  }
  const apply = op("classes", "separate-mailboxes", "--confirm");
  assert.equal(apply.name, "classes.mailboxes.separate");
  assert.equal(apply.method, "POST");
  assert.deepEqual(apply.body, { confirm: true });
  assert.equal(apply.mutates, true);
  assert.throws(() => op("classes", "separate-mailboxes", "--dry-run", "--confirm"), /not both/);
});

test("the report prints who uses it and how it's going, and never invents numbers", () => {
  const text = formatClassesResult({
    operation: { name: "classes.report" },
    data: {
      windowDays: 7,
      live: true,
      adoption: { teachersWithClass: 2, teachersNewInWindow: 1, classes: 3, classesNewInWindow: 2, classesWithLiveCode: 2, members: 31, joinedInWindow: 18 },
      branches: [{ branch: "Daechi", teachers: 2, classes: 3, members: 31, joinedInWindow: 18 }],
      teachers: [{ teacherId: 7, username: "kim", branch: "Daechi", classes: 2, members: 20, joinedInWindow: 12, lastJoinAt: 1794700800, resetsInWindow: 3, notMyStudentInWindow: 1 }],
      classes: [{ classroomId: 5, className: "Lions 3", teacher: "kim", branch: "Daechi", code: "live", seats: "12/40", members: 12, joinedInWindow: 12, visits: { qr: 14, code: 3 } }],
      discovery: { card: { teachersShown: 9, used: 2, usedBy: { try: 1, how: 1 }, dismissed: 3, nowHaveClass: 2, viewsBySurface: { home: 5, videos: 11 } }, hints: { shown: { a: 2 }, clicked: { a: 1 } }, guideHits: 4, helpPageViews: 6, helpPageBySource: { card: 1, hint: 1 }, classesPageViews: 12 },
      codes: { shown: 8, shownBy: { screen: 6, print: 2 }, renewed: 1, turnedOff: 0 },
      funnel: { visits: 20, visitsByMethod: { qr: 14, code: 3, link: 3 }, signupStarted: 19, reachedPassword: 18, reachedName: 18, completed: 18, completedByMethod: { qr: 13, code: 3, link: 2 }, visitToSignupPercent: 90, startedToSignupPercent: 94.7, abandonedAt: { username: 1, password: 0, name: 0 }, invalidVisits: 2, invalidByMethod: { code: 2 }, alreadySignedInVisits: 1, refused: { username: 1 } },
      asks: { opened: 9, searches: 12, searchesBy: { found: 10, none: 2 }, requests: 5, withNote: 3, teachersAsked: 2, repeatsMuted: 1, turnedAway: { limit: 1 }, teacherOpened: 4, answered: { sent: 3, putAside: 1 }, averageAnswerMinutes: 12, waiting: 1, unanswered: 0, joined: 2 },
      progressRow: { clicks: 6, by: { open: 4, make: 2 } },
      roster: { notMyStudent: 1 },
      resets: { issued: 3, used: 2, expiredUnused: 1, waiting: 0, teachers: 1, students: 3, refused: { code: 1 } },
      retention: {
        classJoiners: { signups: 18, day1: { eligible: 10, active: 7, percent: 70 }, day7: { eligible: 0, active: 0, percent: null } },
        otherSignups: { signups: 40, day1: { eligible: 30, active: 12, percent: 40 }, day7: { eligible: 12, active: 3, percent: 25 } },
      },
      retentionNote: "day1 = active the day after joining",
      attention: ['1 joiner(s) were marked "Not my student" in this window'],
    },
  }).join("\n");
  assert.match(text, /Classroom sign-up, last 7 day\(s\)/);
  assert.match(text, /2 teacher\(s\) with a class \(1 new\) · 3 class\(es\)/);
  assert.match(text, /Daechi: 2 teacher\(s\), 3 class\(es\), 31 student\(s\), 18 joined/);
  assert.match(text, /kim \(#7\) · Daechi: 2 class\(es\), 20 student\(s\), 12 joined, last join 2026-11-15, 3 reset code\(s\), 1 "Not my student"/);
  assert.match(text, /#5 Lions 3 · kim · Daechi: code live \(12\/40 seats\), 12 on roster, 12 joined, visits qr 14, code 3/);
  assert.match(text, /Offer card: shown to 9 teacher\(s\) \(home 5, videos 11 views\) · 2 used \(try 1, how 1\) · 3 dismissed · 2 of them now have a class/);
  assert.match(text, /Visits 20 \(qr 14, code 3, link 3\) → sign-up started 19 → password 18 → name 18 → joined 18/);
  assert.match(text, /Visit → joined 90% · started → joined 94\.7%/);
  assert.match(text, /Opened 9 · searches 12 \(found 10, none 2\) · requests 5 to 2 teacher\(s\) \(3 with a note\) · repeats not re-sent 1 · turned away: limit 1/);
  assert.match(text, /Teachers: opened 4 · sent a pass 3 · put aside 1 · average answer 12 min · waiting 1 · ran out unanswered 0 · joined from a pass 2/);
  assert.match(text, /Today's Progress row: 6 click\(s\) \(open 4, make 2\)/);
  assert.match(text, /Reset codes: 3 issued by 1 teacher\(s\) for 3 student\(s\) · 2 used · 1 ran out unused/);
  assert.match(text, /Class joiners: 18 sign-ups · day 1 7\/10 \(70%\) · day 7 0\/0 \(n\/a\)/);
  assert.match(text, /Other sign-ups: 40 sign-ups · day 1 12\/30 \(40%\) · day 7 3\/12 \(25%\)/);
  assert.match(text, /- 1 joiner\(s\) were marked "Not my student"/);

  const empty = formatClassesResult({ operation: { name: "classes.report" }, data: { windowDays: 14, live: false, attention: [] } }).join("\n");
  assert.match(empty, /TABLES MISSING/);
  assert.match(empty, /0 teacher\(s\) with a class/);
  assert.match(empty, /Look into\n {2}nothing/);
});

test("list, show, revoke and mailbox results read plainly", () => {
  assert.deepEqual(formatClassesResult({ operation: { name: "classes.list" }, data: { classes: [] } }), ["No classes."]);
  const shown = formatClassesResult({
    operation: { name: "classes.show" },
    data: {
      class: { classroomId: 5, className: "Lions 3", teacherId: 7, teacher: "kim", branch: "Daechi", createdAt: 1794700800, code: "off", seats: "12/40", codeTurnedOffBy: 1 },
      roster: [{ userId: 90, username: "dino_maker", joinedAt: 1794700800, method: "qr", hasEmail: false, notMyStudentAt: 1794787200 }],
      resets: [{ issuedAt: 1794700800, teacherId: 7, studentId: 91, student: "sunny22", state: "used", wrongTries: 1, samePlace: false, issuedFrom: "58.151.x.59", usedFrom: "1.2.x.4" }],
    },
  }).join("\n");
  assert.match(shown, /#5 Lions 3 · kim \(#7\) · Daechi/);
  assert.match(shown, /Code: off \(12\/40 seats\) · turned off by #1/);
  assert.match(shown, /dino_maker \(#90\) · joined 2026-11-15 by qr · NOT MY STUDENT 2026-11-16/);
  assert.match(shown, /teacher #7 → sunny22 \(#91\): used, 1 wrong tries · made at 58\.151\.x\.59, used at 1\.2\.x\.4/);
  assert.match(formatClassesResult({ operation: { name: "classes.revoke" }, data: { classroomId: 5, changed: true } })[0], /the code is off/);
  assert.match(formatClassesResult({ operation: { name: "classes.revoke" }, data: { classroomId: 5, changed: false } })[0], /already off/);
  const preview = formatClassesResult({
    operation: { name: "classes.mailboxes.preview" },
    data: { teacherMailboxesChecked: 20, alreadySeparate: 2, toSeparate: 1, accountsAffected: 44, mailboxes: [{ teacherId: 7, teacher: "kim", mailbox: "ki…@school.test", accounts: 44 }], next: "Nothing was changed." },
  }).join("\n");
  assert.match(preview, /^DRY RUN, nothing changed\. 20 teacher mailbox\(es\) checked · 2 already separate · 1 to separate \(44 account\(s\)\)/);
  assert.match(preview, /kim \(#7\) · ki…@school\.test · 44 account\(s\)/);
  const applied = formatClassesResult({
    operation: { name: "classes.mailboxes.separate" },
    data: { separated: 1, accountsAffected: 44, remaining: 0, mailboxes: [], failed: [{ teacherId: 8, teacher: "lee", mailbox: "le…@school.test", reason: "busy" }] },
  }).join("\n");
  assert.match(applied, /Separated 1 teacher mailbox\(es\) \(44 account\(s\) now have their own AI Energy\)\. 0 left\./);
  assert.match(applied, /FAILED lee \(#8\) · le…@school\.test: busy/);
});
