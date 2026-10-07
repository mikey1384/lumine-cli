import assert from "node:assert/strict";
import test from "node:test";

import { parseAdminOperation } from "../lib/admin.js";
import { formatProfileReview } from "../lib/admin-profile.js";
import { parseArgs } from "../lib/commands.js";

test("profile show is a daily-run read by user ID or username", () => {
  assert.deepEqual(parseAdminOperation(parseArgs(["admin", "profile", "show", "12647"])), {
    name: "profile.show",
    method: "GET",
    path: "/cli/admin/profile?userId=12647",
    body: undefined,
    mutates: false,
  });
  assert.equal(
    parseAdminOperation(parseArgs(["admin", "profile", "show", "@Gyuri"])).path,
    "/cli/admin/profile?username=Gyuri",
  );
  assert.throws(() => parseAdminOperation(parseArgs(["admin", "profile", "show"])), /Usage/);
  assert.throws(() => parseAdminOperation(parseArgs(["admin", "profile", "edit", "5"])), /Usage/);
});

test("profile show prints identity, standing, counts and recent public items", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const lines = formatProfileReview(
    {
      profile: {
        id: 5,
        username: "sonic",
        realName: "Sonic Shin",
        url: "https://www.twin-kle.com/users/sonic",
        joinedAt: 1550845281,
        lastActive: Math.floor(now / 1000) - 3600,
        rank: 42,
        twinkleXP: 46000,
        xpThisMonth: 1200,
        achievementPoints: 300,
        title: "Explorer",
        achievements: ["Mission Master"],
        statusMsg: "Learning Python",
        bio: ["Grade 6", "Likes chess"],
        isNotable: false,
      },
      counts: { subjects: 2, comments: 5, aiStories: 1, builds: 1, sharedReflections: 0 },
      recent: {
        subjects: [
          { id: 9, title: "My robot", excerpt: "It walks.", createdAt: 1791200000, url: "https://www.twin-kle.com/subjects/9" },
        ],
        comments: [
          { id: 77, excerpt: "Nice work!", createdAt: 1791200000, rootType: "subject", rootId: 9, subjectTitle: "My robot", url: "https://www.twin-kle.com/comments/77" },
          { id: 78, excerpt: "Hi", createdAt: 1791200000, rootType: "user", rootId: 3, subjectTitle: null, url: "https://www.twin-kle.com/comments/78" },
        ],
        builds: [],
        aiStories: [{ id: 4, title: "Volcanoes", createdAt: 1791200000, url: "https://www.twin-kle.com/ai-stories/4" }],
        reflections: [],
      },
    },
    { now },
  );
  const text = lines.join("\n");
  assert.equal(lines[0], "sonic (#5) · Sonic Shin");
  assert.equal(lines[1], "https://www.twin-kle.com/users/sonic");
  assert.match(text, /Joined 2019-02-22 \(\d+ days ago\) · last active 2026-10-07 \(under a day ago\)/);
  assert.match(text, /rank #42 · 46,000 XP · 1,200 XP this month · 300 AP · title "Explorer"/);
  assert.match(text, /Bio: Grade 6 \/ Likes chess/);
  assert.match(text, /Counts: 2 subjects · 5 comments · 1 AI stories · 1 public builds · 0 shared reflections/);
  assert.match(text, /Recent subjects \(1\):\n {2}2026-10-0\d {2}My robot {2}https:\/\/www\.twin-kle\.com\/subjects\/9\n {4}It walks\./);
  assert.match(text, /on "My robot" {2}https:\/\/www\.twin-kle\.com\/comments\/77\n {4}Nice work!/);
  assert.match(text, /on user #3's profile {2}https:\/\/www\.twin-kle\.com\/comments\/78/);
  assert.match(text, /Recent public builds \(0\):\n {2}\(none\)/);
  assert.doesNotMatch(text, /@|email/i);
});
