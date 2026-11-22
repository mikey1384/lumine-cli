import assert from "node:assert/strict";
import test from "node:test";
import { formatAdminNewspaperLines } from "../lib/admin.js";

// Shapes copied from run-223 evidence (work/daily-management-2026-11-17/private).
test("news edition projection for a printed edition reads printed, never 'not printed'", () => {
  const lines = formatAdminNewspaperLines({
    dayIndex: 1781,
    dateKey: "2026-11-17",
    printed: true,
    edition: {
      id: 110,
      revisionId: 142,
      revisionNumber: 1,
      revisionCount: 1,
      status: "ready",
      sourceEventCount: 26,
    },
  });
  assert.deepEqual(lines, [
    "Newspaper 2026-11-17: printed, edition #110 (revision 1, 26 sources).",
  ]);
});

test("news edition projection with no edition says so without a status placeholder", () => {
  const lines = formatAdminNewspaperLines({
    dayIndex: 1782,
    dateKey: "2026-11-18",
    printed: false,
    edition: null,
  });
  assert.deepEqual(lines, ["Newspaper 2026-11-18: no printed edition for this date."]);
});

test("status snapshot keeps its printed and in-progress wording", () => {
  assert.deepEqual(
    formatAdminNewspaperLines({
      dateKey: "2026-11-17",
      printedToday: true,
      generationStatus: "ready",
      latestPrinted: { revisionNumber: 1, sourceEventCount: 26 },
      printDecision: "already_printed",
    }),
    ["Newspaper 2026-11-17: printed (revision 1, 26 sources)."],
  );
  assert.deepEqual(
    formatAdminNewspaperLines({
      dateKey: "2026-11-18",
      printedToday: false,
      generationStatus: "generating",
      latestPrinted: { revisionNumber: 1, sourceEventCount: 26 },
      printDecision: "in_progress",
    }),
    [
      "Newspaper 2026-11-18: not printed (generating).",
      "An edition is being typeset now. Re-check with: lumine admin news",
    ],
  );
});
