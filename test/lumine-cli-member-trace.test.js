import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminOperation } from "../lib/admin.js";
import {
  formatMemberTrace,
  formatMemberTraceList,
  formatMemberTraceSwitch,
} from "../lib/admin-member-trace.js";
import { parseArgs } from "../lib/commands.js";

const op = (...args) => parseAdminOperation(parseArgs(["admin", "member-trace", ...args]));

test("member-trace read: a read-only request with the owner trace's filters and a source", () => {
  const read = op("dew", "--since", "2h", "--source", "server", "--type", "api", "--limit", "50");
  assert.equal(read.name, "member-trace.read");
  assert.equal(read.method, "GET");
  assert.equal(read.mutates, false);
  assert.equal(read.requiresRun, false);
  assert.equal(
    read.path,
    "/cli/admin/member-trace?since=2h&limit=50&type=api&user=dew&source=server",
  );
  assert.equal(op("read", "list").path, "/cli/admin/member-trace?since=2h&limit=300&user=list");
  assert.equal(op("@dew").path, "/cli/admin/member-trace?since=2h&limit=300&user=dew");
  assert.throws(() => op("dew", "--source", "db"), /--source is all/);
  assert.throws(() => op("dew", "--since", "last week"), /--since must/);
  assert.throws(() => op(), /Usage: lumine admin member-trace/);
});

test("member-trace on/off are audited admin writes; on needs a reason", () => {
  const on = op("on", "dew", "--reason", "General chat main keeps reloading");
  assert.deepEqual(
    { name: on.name, method: on.method, path: on.path, body: on.body, mutates: on.mutates, requiresRun: on.requiresRun },
    {
      name: "member-trace.on",
      method: "POST",
      path: "/cli/admin/member-trace/on",
      body: { user: "dew", reason: "General chat main keeps reloading" },
      mutates: true,
      requiresRun: false,
    },
  );
  assert.throws(() => op("on", "dew"), /--reason/);
  assert.throws(() => op("on", "--reason", "x"), /Usage/);
  const off = op("off", "dew");
  assert.equal(off.path, "/cli/admin/member-trace/off");
  assert.deepEqual(off.body, { user: "dew" });
  assert.equal(off.mutates, true);
  const list = op("list");
  assert.equal(list.path, "/cli/admin/member-trace/accounts");
  assert.equal(list.mutates, false);
});

test("member-trace prints a plain summary, the device timeline and the API view", () => {
  const t = new Date(2026, 10, 2, 20, 15, 0, 0).getTime();
  const lines = formatMemberTrace({
    since: Math.floor(t / 1000) - 600,
    truncated: false,
    duplicates: 1,
    source: "all",
    user: { id: 42, username: "dew", traced: true, enabledAt: 1_793_000_000, reason: "main reload loop" },
    events: [
      { id: 1, sessionId: "s-1", seq: 1, clientTime: t, serverTime: t / 1000, type: "session", path: "/chat/general", data: { version: "2.5.20", entry: "index-abc.js", navType: "reload", member: 1, ua: "iPhone" } },
      { id: 2, sessionId: "s-1", seq: 2, clientTime: t + 5, serverTime: t / 1000, type: "boot", path: "/chat/general", data: { navType: "reload", kept: 1, byCode: "client-update-silent", byCodeAgoMs: 900, byCodeAt: "/chat/general/main", v: "2.5.20" } },
      { id: 8, sessionId: "s-1", seq: 6, clientTime: t + 970, serverTime: t / 1000, type: "socket", path: "/chat/general/main", data: { e: "disconnect", reason: "transport close", vis: "visible", visibleForMs: 120000, upMs: 30000, v: "2.5.20" } },
      { id: 9, sessionId: "s-1", seq: 7, clientTime: t + 980, serverTime: t / 1000, type: "chat-loading", path: "/chat/general/main", data: { e: "shown", v: "2.5.20" } },
      { id: 3, sessionId: "s-1", seq: 3, clientTime: t + 900, serverTime: t / 1000, type: "chat-select", path: "/chat/general/main", data: { channelId: 2, subchannel: "main", pathId: "general", v: "2.5.20" } },
      { id: 4, sessionId: "s-1", seq: 4, clientTime: t + 950, serverTime: t / 1000, type: "reload", path: "/chat/general/main", data: { reason: "history-push-blocked", to: "/chat/general/main", v: "2.5.20" } },
      { id: 5, sessionId: "s-1", seq: 5, clientTime: t + 960, serverTime: t / 1000, type: "boundary-error", path: "/chat/general/main", data: { at: "Chat", msg: "boom", v: "2.5.20" } },
      { id: 6, sessionId: "api:1a2b3c4d", seq: 0, clientTime: t + 100, serverTime: t / 1000, type: "api", path: "/user/session", data: { m: "GET", s: 200, ms: 120, v: "2.5.20", h: "primary:api-a", pst: 1793000000, ua: "iPhone" } },
      { id: 7, sessionId: "api:1a2b3c4d", seq: 0, clientTime: t + 200, serverTime: t / 1000, type: "api", path: "/chat/channel/:channelId", data: { m: "GET", s: "aborted", ms: 40, v: "2.5.20", p: { channelId: 2 } } },
    ],
  });
  const text = lines.join("\n");
  assert.match(lines[0], /^Member trace for dew \(#42\), on since .*main reload loop · 1 re-sent duplicate\(s\) hidden$/);
  assert.match(text, /Website: 1 page load\(s\) \(opened by reload ×1\) · version 2\.5\.20 ×1 · bundle index-abc\.js ×1/);
  assert.match(text, /Self-reloads: history-push-blocked ×1/);
  assert.match(text, /Errors: boundary-error: boom ×1/);
  assert.match(text, /API view: 2 request row\(s\) from 1 device\(s\) · reported website version 2\.5\.20 ×2 · session loads 1 · failures aborted ×1/);
  assert.match(text, /Website events \(from the device\) since/);
  assert.match(text, /SELF-RELOAD history-push-blocked · to=\/chat\/general\/main/);
  assert.match(text, /chat-select +\/chat\/general\/main +channel 2\/main · path general/);
  assert.match(text, /page loaded \(reload\) · reloaded by code: client-update-silent 900ms earlier at \/chat\/general\/main · 1 batch\(es\) kept from an earlier page/);
  assert.match(text, /Why pages loaded: code:client-update-silent ×1/);
  assert.match(text, /Socket drops: 1 \(1 while the page was visible\) · full chat loading screens: 1/);
  assert.match(text, /socket disconnect \(transport close\) · visible 2m after the page became visible · was up 30s/);
  assert.match(text, /full "Loading Twinkle Chat\.\.\." screen shown/);
  assert.match(text, /bundle index-abc\.js/);
  assert.match(text, /API view \(requests from this account; session = device tag\)/);
  assert.match(text, /website v2\.5\.20 · host primary:api-a worker since \d\d:\d\d:\d\dZ · ua iPhone/);
  assert.match(text, /\/chat\/channel\/:channelId +GET → aborted in 40ms · website v2\.5\.20 channelId=2/);
});

test("member-trace says when only the API saw the member (an old cached bundle)", () => {
  const text = formatMemberTrace({
    since: 1_793_000_000,
    user: { id: 42, username: "dew", traced: true },
    events: [
      { id: 1, sessionId: "api:x", seq: 0, clientTime: 1_793_000_000_000, serverTime: 1_793_000_000, type: "api", path: "/user/session", data: { m: "GET", s: 200, ms: 90, v: "2.4.99" } },
    ],
  }).join("\n");
  assert.match(text, /reported website version 2\.4\.99 ×1/);
  assert.match(text, /No website events: the device has not run a website build with the member trace yet/);
});

test("member-trace list and switches read plainly", () => {
  assert.deepEqual(formatMemberTraceList({ accounts: [] }), ["No member is traced."]);
  const list = formatMemberTraceList({
    accounts: [
      { userId: 42, username: "dew", reason: "main reload loop", enabledAt: 1_793_000_000, enabledByUsername: "mikey", clientRows24h: 30, serverRows24h: 400, lastClientAt: 1_793_000_100, lastServerAt: null },
    ],
  }).join("\n");
  assert.match(list, /dew \(#42\) · on since .* by mikey · main reload loop/);
  assert.match(list, /30 website event\(s\) .* 400 API request row\(s\) \(last never\)/);
  assert.match(formatMemberTraceSwitch({ userId: 42, username: "dew", enabled: true, alreadyOn: false, effectiveWithinSeconds: 30 })[0], /on for dew \(#42\)/);
  assert.match(formatMemberTraceSwitch({ userId: 42, username: "dew", enabled: false, wasOn: true, keptRowsExpireAfterDays: 30 })[0], /off for dew .* expire after 30 days/);
});
