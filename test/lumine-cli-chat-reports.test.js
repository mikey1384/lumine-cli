import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

test("chat-reports commands are run-independent and need a note to record an outcome", () => {
  assert.deepEqual(
    parseAdminOperation(parseArgs(["admin", "chat-reports", "list"])),
    {
      name: "chat-reports.list",
      method: "GET",
      path: "/cli/admin/chat-reports?status=pending&limit=50",
      body: undefined,
      mutates: false,
      requiresRun: false,
    },
  );
  assert.equal(
    parseAdminOperation(
      parseArgs(["admin", "chat-reports", "list", "--status", "all", "--cursor", "9"]),
    ).path,
    "/cli/admin/chat-reports?status=all&beforeId=9&limit=50",
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "chat-reports", "list", "--status", "closed"]),
      ),
    /--status/,
  );
  assert.equal(
    parseAdminOperation(parseArgs(["admin", "chat-reports", "show", "3"])).path,
    "/cli/admin/chat-reports/3",
  );
  assert.deepEqual(
    parseAdminOperation(
      parseArgs([
        "admin",
        "chat-reports",
        "set",
        "3",
        "--status",
        "resolved",
        "--note",
        "Talked to both members.",
      ]),
    ),
    {
      name: "chat-reports.set",
      method: "PUT",
      path: "/cli/admin/chat-reports/3",
      body: { status: "resolved", note: "Talked to both members." },
      mutates: true,
      requiresRun: false,
      reportId: 3,
    },
  );
  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "chat-reports", "set", "3", "--status", "resolved"]),
      ),
    /--note/,
  );
});

test("safety hold commands build owner-only, run-independent requests and need a reason", () => {
  const parse = (args) => parseAdminOperation(parseArgs(["admin", "chat-reports", ...args]));
  assert.deepEqual(parse(["hold", "12", "--note", "Sexual messages to a child."]), {
    name: "chat-reports.hold",
    method: "POST",
    path: "/cli/admin/chat-reports/holds",
    body: { note: "Sexual messages to a child.", reportId: 12 },
    mutates: true,
    requiresRun: false,
  });
  assert.deepEqual(
    parse(["hold", "--user", "7,9,7", "--channel", "40", "--note", "Parent called."]).body,
    { note: "Parent called.", userIds: [7, 9], channelId: 40 },
  );
  assert.deepEqual(parse(["hold", "--channel", "40", "--note", "x"]).body, {
    note: "x",
    channelId: 40,
  });
  assert.throws(() => parse(["hold", "12"]), /--note/);
  assert.throws(() => parse(["hold", "--note", "why"]), /Usage/);
  assert.deepEqual(parse(["release", "3", "--note", "Case closed by police."]), {
    name: "chat-reports.release",
    method: "PUT",
    path: "/cli/admin/chat-reports/holds/3/release",
    body: { note: "Case closed by police." },
    mutates: true,
    requiresRun: false,
    holdId: 3,
  });
  assert.throws(() => parse(["release", "3"]), /--note/);
  assert.equal(
    parse(["list-holds"]).path,
    "/cli/admin/chat-reports/holds?status=active",
  );
  assert.equal(
    parse(["list-holds", "--status", "all"]).path,
    "/cli/admin/chat-reports/holds?status=all",
  );
  assert.throws(() => parse(["list-holds", "--status", "open"]), /--status/);
  assert.deepEqual(parse(["suspend", "--user", "7", "--note", "Adult under investigation."]).body, {
    userId: 7,
    note: "Adult under investigation.",
  });
});

test("export needs one target and a new directory, and verifies every file against the manifest", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { writeEvidencePackage } = await import("../lib/admin.js");
  const parse = (args) => parseAdminOperation(parseArgs(["admin", "chat-reports", ...args]));

  const byReport = parse(["export", "12", "--out", "case-12"]);
  assert.equal(byReport.method, "POST");
  assert.equal(byReport.path, "/cli/admin/chat-reports/export");
  assert.deepEqual(byReport.body, { reportId: 12 });
  assert.equal(byReport.evidenceDir, "case-12");
  assert.equal(byReport.requiresRun, false);
  assert.deepEqual(parse(["export", "--hold", "4", "--out", "d"]).body, { holdId: 4 });
  assert.throws(() => parse(["export", "12"]), /--out/);
  assert.throws(() => parse(["export", "--out", "d"]), /Usage/);
  assert.throws(() => parse(["export", "12", "--hold", "4", "--out", "d"]), /not both/);

  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const files = [
    { path: "README.txt", content: "Twinkle evidence\n" },
    { path: "conversation-40.txt", content: "[message 1] 2026-09-26 14:00:00 UTC | 2026-09-26 23:00:00 KST\n" },
  ];
  const manifest = {
    hashAlgorithm: "SHA-256",
    files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha(f.content) })),
  };
  const packageFiles = [...files, { path: "manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` }];

  const root = mkdtempSync(join(tmpdir(), "lumine-evidence-"));
  try {
    const out = join(root, "case");
    const written = writeEvidencePackage({ directory: out, files: packageFiles });
    assert.equal(written.files.length, 3);
    assert.equal(
      written.manifestSha256,
      sha(readFileSync(join(written.directory, "manifest.json"))),
    );
    assert.equal(
      readFileSync(join(written.directory, "conversation-40.txt"), "utf8"),
      files[1].content,
    );
    // A populated directory is refused (never mixes cases), named by --out.
    assert.throws(
      () => writeEvidencePackage({ directory: out, files: packageFiles }),
      /--out/,
    );
    // A file that does not match its manifest hash fails loudly.
    const tampered = packageFiles.map((f) =>
      f.path === "README.txt" ? { ...f, content: "changed\n" } : f,
    );
    assert.throws(
      () => writeEvidencePackage({ directory: join(root, "tampered"), files: tampered }),
      /does not match its manifest \(README.txt\)/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fixture in the shape GET /cli/admin/chat-reports/:id returns (report 3,
// with invented text). The human printer used to send any `data.report` to
// the daily-run report branch and crash on `report.run.id`.
const REPORT_FIXTURE = {
  id: 3,
  status: "resolved",
  reason: "harassment",
  reasonLabel: "Bullying or harassment",
  note: "Keeps following my posts.",
  createdAt: 1791008350,
  reporter: { id: 18027, username: "reporter_kid" },
  reported: { id: 9046, username: "reported_kid" },
  messageId: 3835674,
  channelId: 71244,
  subchannelId: 0,
  channelKind: "direct",
  reportsOfThisMessage: 1,
  ownerNotifiedAt: 1791008351,
  reviewedAt: 1791297900,
  reviewedByUserId: 5,
  reviewNote: "Talked to both members.",
  message: {
    id: 3835674,
    userId: 9046,
    content: "first line\nsecond line",
    username: "reported_kid",
    timeStamp: 1790994122,
    channelName: null,
    subchannelId: 0,
  },
  context: {
    before: [
      { id: 3835600, userId: 18027, content: "hello", username: "reporter_kid", timeStamp: 1790937856 },
    ],
    after: [],
  },
};

test("chat-reports show prints a readable report instead of crashing", async () => {
  const { formatChatReportResult } = await import("../lib/admin-chat-reports.js");
  const lines = formatChatReportResult({
    operation: { name: "chat-reports.show" },
    data: { report: REPORT_FIXTURE },
  });
  const text = lines.join("\n");
  assert.match(text, /^Chat report #3: RESOLVED · filed 2026-10-03 06:19 UTC/);
  assert.match(text, /Reporter → reported: reporter_kid \(#18027\) → reported_kid \(#9046\)/);
  assert.match(text, /Reason: Bullying or harassment \(harassment\)/);
  assert.match(text, /Reporter's note: Keeps following my posts\./);
  assert.match(text, /Review: 2026-10-\d\d \d\d:\d\d UTC by user #5 — Talked to both members\./);
  assert.match(text, /Reported message #3835674:\n> 2026-10-03 02:22 UTC  reported_kid: first line\n {6}second line/);
  assert.match(text, /Context before \(1\):\n {2}2026-10-02 \d\d:\d\d UTC  reporter_kid: hello/);
  assert.match(text, /Context after \(0\):\n {2}\(none\)/);

  const set = formatChatReportResult({
    operation: { name: "chat-reports.set" },
    data: { report: { ...REPORT_FIXTURE, context: null, message: null } },
  });
  assert.equal(set[0], "Recorded.");
  assert.ok(set.includes("Context: none kept."));
});

test("chat-reports list prints one line per report and the next cursor", async () => {
  const { formatChatReportResult } = await import("../lib/admin-chat-reports.js");
  const lines = formatChatReportResult({
    operation: { name: "chat-reports.list" },
    data: { filter: "pending", reports: [REPORT_FIXTURE], nextCursor: 3 },
  });
  assert.equal(lines[0], "1 pending chat report(s):");
  assert.match(lines[1], /^ {2}#3 RESOLVED · Bullying or harassment · reporter_kid \(#18027\) → reported_kid \(#9046\)/);
  assert.match(lines[1], /\n {4}"first line second line"$/);
  assert.ok(lines.includes("More: lumine admin chat-reports list --cursor 3"));
  assert.ok(
    formatChatReportResult({
      operation: { name: "chat-reports.list" },
      data: { filter: "all", reports: [REPORT_FIXTURE], nextCursor: 3 },
    }).includes("More: lumine admin chat-reports list --status all --cursor 3"),
  );
  assert.deepEqual(
    formatChatReportResult({ operation: { name: "chat-reports.list" }, data: { filter: "all", reports: [] } }),
    ["0 all chat report(s)."],
  );
  assert.equal(formatChatReportResult({ operation: { name: "chat-reports.list-holds" }, data: {} }), null);
});

test("a chat report update's receipt keeps the decision, never the reported chat", async () => {
  const { receiptToKeep } = await import("../lib/admin-receipts.js");
  const receipt = receiptToKeep(
    parseAdminOperation(parseArgs(["admin", "chat-reports", "set", "3", "--status", "resolved", "--note", "handled"])),
    {
      ok: true,
      status: "success",
      data: {
        report: {
          id: 3,
          status: "resolved",
          reviewedAt: 6,
          reviewedByUserId: 1,
          reviewNote: "handled",
          note: "reporter's words",
          message: { content: "private message" },
          context: { before: [{ content: "private context" }], after: [] },
        },
      },
    },
  );
  assert.deepEqual(receipt, {
    ok: true,
    status: "success",
    changed: undefined,
    data: { reportId: 3, status: "resolved", reviewedAt: 6, reviewedByUserId: 1, note: "handled" },
  });
  assert.doesNotMatch(JSON.stringify(receipt), /private|reporter's words/);
});
