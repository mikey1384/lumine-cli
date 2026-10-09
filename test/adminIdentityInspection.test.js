import assert from "node:assert/strict";
import test from "node:test";
import { formatIdentityDeviceUsage } from "../lib/admin-identity-inspection.js";

const complete = {
  key: "device-fingerprint",
  accountCount: 1,
  usage: {
    status: "complete",
    eventCount: 9,
    firstSeenAt: 100,
    lastSeenAt: 900,
    eventsByType: { login: 2, socket_bind: 7 },
    accounts: [{
      userId: 20,
      username: "Target",
      eventCount: 9,
      firstSeenAt: 100,
      lastSeenAt: 900,
      eventsByType: { login: 2, socket_bind: 7 },
    }],
    accountsTruncated: false,
    truncatedBy: [],
  },
};

const render = (devices, coverage = {}) => formatIdentityDeviceUsage({
  sharedDevices: devices,
  evidenceCoverage: { deviceLookbackDays: 365, ...coverage },
}).join("\n");

test("device usage distinguishes events, accounts and sessions with per-account dates", () => {
  const output = render([complete]);
  assert.match(output, /365 days/);
  assert.match(output, /not visits or unique sessions/);
  assert.match(output, /9 recorded event\(s\), 1 account\(s\); login: 2, socket_bind: 7/);
  assert.match(output, /#20 Target: 9 recorded event\(s\)/);
  assert.match(output, /first 1970-01-01T00:01:40.000Z, last 1970-01-01T00:15:00.000Z/);
  assert.doesNotMatch(output, /at least|incomplete|unavailable/);
});

test("partial counts are lower bounds and capped account details do not hide the total", () => {
  const output = render([{
    ...complete,
    accountCount: 3,
    usage: {
      ...complete.usage,
      status: "partial",
      accountsTruncated: true,
      truncatedBy: ["related_device_rows"],
    },
  }]);
  assert.match(output, /at least 9 recorded event\(s\), at least 3 account\(s\)/);
  assert.match(output, /#20 Target: at least 9 recorded event\(s\)/);
  assert.match(output, /Partial history \(related_device_rows\)/);
  assert.match(output, /totals include omitted accounts/);
});

test("an unread device never appears to have zero uses or zero sharing", () => {
  const output = render([{
    key: "unread",
    accountCount: 0,
    usage: { status: "not_read", eventCount: null, truncatedBy: ["time_limit"] },
  }]);
  assert.match(output, /usage and sharing not read \(time_limit\)/);
  assert.doesNotMatch(output, /0 recorded|0 account|First observed/);
});

test("a complete queried device is distinct from an incomplete device list", () => {
  const output = render([complete], { truncated: true, truncatedBy: ["target_device_rows"] });
  assert.match(output, /9 recorded event\(s\), 1 account\(s\)/);
  assert.match(output, /Device discovery\/evidence is incomplete \(target_device_rows\)/);
  assert.doesNotMatch(output, /at least 9/);
});

test("old API responses state that event counts are unavailable instead of using account counts", () => {
  const output = render([{ key: "legacy", accountCount: 1 }]);
  assert.match(output, /usage counts unavailable from this API; 1 observed account/);
  assert.doesNotMatch(output, /1 recorded event/);
});
