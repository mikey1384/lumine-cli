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

test("owner-trace --perf asks only for the performance events", () => {
  const perf = parseAdminOperation(
    parseArgs(["admin", "owner-trace", "--since", "1h", "--perf"]),
  );
  assert.equal(
    perf.path,
    "/cli/admin/owner-trace?since=1h&limit=300&type=nav-timing%2Cslow-request%2Cstall%2Cpage-load",
  );
  const merged = parseAdminOperation(
    parseArgs(["admin", "owner-trace", "--type", "route,stall", "--perf"]),
  );
  assert.match(
    merged.path,
    /type=route%2Cstall%2Cnav-timing%2Cslow-request%2Cpage-load$/,
  );
});

test("owner-trace renders performance events one line each", () => {
  const base = new Date(2026, 9, 6, 14, 3, 12, 345).getTime();
  const event = (offset, type, path, data) => ({
    sessionId: "a1b2c3d4-xyz",
    clientTime: base + offset,
    type,
    path,
    data,
  });
  const lines = formatOwnerTrace({
    since: Math.floor(base / 1000) - 600,
    events: [
      event(0, "page-load", "/", {
        type: "navigate",
        ttfb: 213,
        dcl: 801,
        load: 1491,
        route: 1204,
      }),
      event(100, "nav-timing", "/comments/5", {
        to: "/comments/5",
        via: "nav",
        nav: "PUSH",
        url: 90,
        gate: 4180,
        commit: 4210,
        ready: 4600,
        total: 4600,
        probe: "timeout",
        probeMs: 500,
      }),
      event(200, "nav-timing", "/a", {
        to: "/a",
        via: "url",
        nav: "PUSH",
        url: 0,
        total: 3900,
        cut: "next-nav",
      }),
      event(300, "slow-request", "/comments/5", {
        m: "GET",
        api: "/content/comments?contentId",
        status: 200,
        ms: 1834,
        q: 640,
        tries: 2,
      }),
      event(400, "stall", "/comments/5", { ms: 450, n: 2, total: 770, span: 786 }),
      event(500, "stall", "/", { ms: 230, n: 1, total: 230, span: 230 }),
    ],
  });
  assert.deepEqual(lines.slice(2), [
    "  · session a1b2c3d4 (continued)",
    "  14:03:12.345  page-load      /  navigate · ttfb 213 · domcontentloaded 801 · load 1491 · first route 1204 ms",
    "  14:03:12.445  nav-timing     /comments/5  tap→ready 4600ms · PUSH via nav · url +90 · gate +4180 (probe timeout, waited 500ms) · commit +4210 · ready +4600",
    "  14:03:12.545  nav-timing     /a  cut after 3900ms · PUSH via url · url +0 · cut by next-nav",
    "  14:03:12.645  slow-request   /comments/5  GET /content/comments?contentId → 200 in 1834ms (queued 640ms, 2 tries)",
    "  14:03:12.745  stall          /comments/5  main thread blocked 450ms (2 stalls, 770ms blocked over 786ms)",
    "  14:03:12.845  stall          /  main thread blocked 230ms",
  ]);
});
