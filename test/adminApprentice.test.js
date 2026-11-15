import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import { formatApprenticeResult } from "../lib/admin-apprentice.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", ...args]));

test("apprentice applicants and show are run-free reads", () => {
  for (const list of [op("apprentice"), op("apprentice", "applicants")]) {
    assert.equal(list.name, "apprentice.applicants");
    assert.equal(list.method, "GET");
    assert.equal(list.path, "/cli/admin/apprentice/applicants");
    assert.equal(list.mutates, false);
    assert.equal(list.requiresRun, false);
  }
  const show = op("apprentice", "show", "Chu Ki");
  assert.equal(show.path, "/cli/admin/apprentice/applicants/Chu%20Ki");
  assert.equal(show.mutates, false);
  assert.throws(() => op("apprentice", "show"), /Usage: lumine admin apprentice/);
  assert.throws(() => op("apprentice", "rank"), /Usage: lumine admin apprentice/);
});

test("apprentice note records an observation against a posted quality, with evidence", () => {
  const note = op(
    "apprentice",
    "note",
    "Chu",
    "--polarity",
    "positive",
    "--trait",
    "agency",
    "--note",
    "Fixed a reported bug the same day.",
    "--evidence",
    "https://www.twin-kle.com/comments/1",
  );
  assert.equal(note.name, "apprentice.note");
  assert.equal(note.method, "POST");
  assert.equal(note.path, "/cli/admin/apprentice/notes");
  assert.equal(note.mutates, true);
  assert.equal(note.requiresRun, false);
  assert.deepEqual(note.body, {
    target: "Chu",
    polarity: "positive",
    trait: "agency",
    note: "Fixed a reported bug the same day.",
    evidenceUrl: "https://www.twin-kle.com/comments/1",
  });
  assert.throws(() => op("apprentice", "note", "Chu", "--polarity", "great", "--trait", "agency", "--note", "x"), /--polarity/);
  assert.throws(() => op("apprentice", "note", "Chu", "--polarity", "positive", "--trait", "nice", "--note", "x"), /posted qualities/);
  assert.throws(() => op("apprentice", "note", "Chu", "--polarity", "positive", "--trait", "agency"), /--note/);
});

test("the applicants list prints what changed and the counts, and never a ranking", () => {
  const lines = formatApprenticeResult({
    operation: { name: "apprentice.applicants" },
    data: {
      applicants: [
        { userId: 7, username: "kai", revision: 2, lastSubmittedAt: 1763200000, firstSubmittedAt: 1763000000, lastChanged: ["How you use AI"], observations: 1, lastObservedAt: 1763200000, lastSentVia: "ciel" },
      ],
      unsentDrafts: 3,
      counts: { days: 14, totals: { page_view: 40, form_opened: 9, application_started: 5, application_submitted: 2, application_updated: 1, advisor_read: 4 } },
      reminder: "Mikey decides.",
    },
  });
  const text = lines.join("\n");
  assert.match(text, /kai \(#7\) · v2/);
  assert.match(text, /changed: How you use AI/);
  assert.match(text, /\(sent via Ciel\)/);
  assert.match(text, /3 unsent draft/);
  assert.match(text, /advisor reads 4/);
  assert.doesNotMatch(text, /rank|score/i);
});
