import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminOperation } from "../lib/admin.js";
import { formatOwnerTrace } from "../lib/admin-owner-trace.js";
import { parseArgs } from "../lib/commands.js";

test("owner-trace builds a read-only request with its filters", () => {
  const operation = parseAdminOperation(
    parseArgs([
      "admin",
      "owner-trace",
      "--since",
      "30m",
      "--type",
      "route,feed-open",
      "--path",
      "/comments/5",
      "--limit",
      "50",
    ]),
  );
  assert.equal(operation.method, "GET");
  assert.equal(operation.mutates, false);
  assert.equal(operation.requiresRun, false);
  assert.equal(
    operation.path,
    "/cli/admin/owner-trace?since=30m&limit=50&type=route%2Cfeed-open&path=%2Fcomments%2F5",
  );

  const defaults = parseAdminOperation(parseArgs(["admin", "owner-trace"]));
  assert.equal(defaults.path, "/cli/admin/owner-trace?since=2h&limit=300");

  const iso = parseAdminOperation(
    parseArgs(["admin", "owner-trace", "--since", "2026-10-06T09:00:00Z"]),
  );
  assert.match(iso.path, /since=1791277200&/);

  assert.throws(
    () =>
      parseAdminOperation(
        parseArgs(["admin", "owner-trace", "--since", "last tuesday"]),
      ),
    /--since must/,
  );
  assert.throws(
    () =>
      parseAdminOperation(parseArgs(["admin", "owner-trace", "--limit", "0"])),
    /--limit must/,
  );
});

test("owner-trace prints a readable timeline", () => {
  const base = new Date(2026, 9, 6, 14, 3, 12, 345).getTime();
  const lines = formatOwnerTrace({
    since: Math.floor(base / 1000) - 600,
    truncated: false,
    events: [
      {
        sessionId: "a1b2c3d4-xyz",
        clientTime: base,
        type: "session",
        path: "/",
        data: {
          version: "2.3.56",
          vw: 390,
          vh: 844,
          dpr: 3,
          platform: "iPhone",
          standalone: true,
          ua: "Mozilla/5.0 (iPhone)",
        },
      },
      {
        sessionId: "a1b2c3d4-xyz",
        clientTime: base + 400,
        type: "feed-open",
        path: "/",
        data: {
          ct: "comment",
          id: 5,
          action: "comment",
          via: "action-button",
          el: "span/in-button",
          pos: 3,
          surface: "home",
        },
      },
      {
        sessionId: "a1b2c3d4-xyz",
        clientTime: base + 410,
        type: "route",
        path: "/comments/5",
        data: {
          nav: "PUSH",
          from: "/",
          stateKeys: ["homeFeedNavigation", "homeFeedActionIntent"],
          feedNav: { ct: "comment", id: 5, action: "comment" },
          feedIntent: "comment",
        },
      },
      {
        sessionId: "a1b2c3d4-xyz",
        clientTime: base + 1500,
        type: "content-scroll",
        path: "/comments/5",
        data: { ct: "comment", id: 5, phase: "ready+1000ms", st: 0, sh: 3400, vh: 844 },
      },
      {
        sessionId: "a1b2c3d4-xyz",
        clientTime: base + 2000,
        type: "scroll-anchor",
        path: "/",
        data: { e: "restore", key: "home", st: 1200, try: 2 },
      },
      {
        sessionId: "a1b2c3d4-xyz",
        clientTime: base + 3000,
        type: "error",
        path: "/",
        data: { msg: "TypeError: x is undefined", src: "index-abc.js", line: 12, col: 3 },
      },
    ],
  });
  assert.equal(
    lines.join("\n"),
    [
      "Owner trace since 2026-10-06 13:53 · 6 event(s) · 1 session(s)",
      "── 2026-10-06",
      "  14:03:12.345  ── session a1b2c3d4 · v2.3.56 · 390x844 @3x · iPhone · standalone (PWA) · at /",
      "      ua: Mozilla/5.0 (iPhone)",
      "  14:03:12.745  feed-open      /  comment comment:5 via action-button (span/in-button) · card #3",
      "  14:03:12.755  route          /comments/5  PUSH from / · feedNav comment:5 comment · intent comment",
      "  14:03:13.845  content-scroll /comments/5  ready+1000ms comment:5 scrollTop=0 height=3400 viewport=844",
      "  14:03:14.345  scroll-anchor  /  restore key=home st=1200 try=2",
      "  14:03:15.345  error          /  TypeError: x is undefined (index-abc.js:12:3)",
    ].join("\n"),
  );

  assert.deepEqual(formatOwnerTrace({ since: 0, events: [] }).slice(1), [
    "Nothing recorded in this window.",
  ]);
});
