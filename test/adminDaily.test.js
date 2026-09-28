import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bangkokCutoff, renderBotOutput } from "../lib/admin-daily.js";

test("featured cutoff is Bangkok midnight N days back, as UTC", () => {
  // 2026-09-28 00:53Z is 07:53 in Bangkok; 7 days back is 09-21 00:00 +07.
  assert.equal(
    bangkokCutoff(7, Date.parse("2026-09-28T00:53:00Z")),
    "2026-09-20T17:00:00.000Z",
  );
  // 18:00Z is already the next Bangkok day.
  assert.equal(
    bangkokCutoff(1, Date.parse("2026-09-28T18:00:00Z")),
    "2026-09-27T17:00:00.000Z",
  );
});

test("bot output renders every chat row and comment, grouped by channel", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-")), "out.txt");
  renderBotOutput(
    {
      chatMessages: [
        { messageId: 3, channelId: 9, occurredAt: 1790000000, bot: "Zero", recipient: { username: "b", userId: 2 }, surface: "chat", messageKind: "text", source: "typed", generation: { storedOutcome: "success" }, content: "second channel" },
        { messageId: 1, channelId: 4, occurredAt: 1790000000, bot: "Ciel", recipient: { username: "a", userId: 1 }, surface: "chat", messageKind: "text", source: "typed", generation: { storedOutcome: "failure", errorType: "general" }, content: "first" },
      ],
      comments: [{ commentId: 7, occurredAt: 1790000000, bot: "Zero", rootType: "subject", rootId: 5, url: "u", content: "hi" }],
    },
    file,
  );
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.indexOf("#1 ") < text.indexOf("#3 "));
  assert.match(text, /gen=failure err=general/);
  assert.match(text, /===== COMMENTS =====\n--- comment 7/);
});
