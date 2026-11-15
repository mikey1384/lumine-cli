import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDraftWriteAs,
  formatFeatureGuide,
  parseAdminOperation,
} from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

function operationFor(argv) {
  const options = parseArgs(["admin", ...argv]);
  return parseAdminOperation(options);
}

test("feature-guide is a read-only lookup that needs no daily run", () => {
  const byQuery = operationFor(["feature-guide", "--query", "AI Story", "--json"]);
  assert.equal(byQuery.name, "feature-guide.read");
  assert.equal(byQuery.method, "GET");
  assert.equal(byQuery.mutates, false);
  assert.equal(byQuery.requiresRun, false);
  assert.equal(byQuery.path, "/cli/admin/feature-guide?query=AI+Story");
  assert.equal(
    operationFor(["feature-guide", "--key", "wordle"]).path,
    "/cli/admin/feature-guide?key=wordle",
  );
  assert.equal(
    operationFor(["feature-guide", "--new"]).path,
    "/cli/admin/feature-guide?new=true",
  );
  assert.equal(operationFor(["feature-guide"]).path, "/cli/admin/feature-guide");
});

test("feature-guide prints entries with where, steps and rules", () => {
  const lines = formatFeatureGuide({
    entries: [
      {
        key: "ai_stories",
        name: "AI Stories",
        since: "2026-10-01",
        where: "Arena > Train > AI Story.",
        what: "Short English stories.",
        howTo: ["Pick a level"],
        rules: ["Clears count for the A task"],
      },
    ],
  }).join("\n");
  assert.match(lines, /## AI Stories \[ai_stories\]/);
  assert.match(lines, /Where: Arena > Train > AI Story\./);
  assert.match(lines, /- Pick a level/);
  assert.match(lines, /- Rule: Clears count/);
  assert.match(formatFeatureGuide({ entries: [] }).join("\n"), /No guide entry matched/);
});

test("a draft shows the bot's voice and this thread's guide entries before posting", () => {
  const text = formatDraftWriteAs({
    identity: "Ciel",
    rule: "You are writing publicly as Ciel.",
    persona: "Ciel, you are an AI chatbot created by Mikey.",
    recentPublicReplies: [{ commentId: 1, content: "yay you did it!!\n🎉", url: "u" }],
    featureKnowledge: {
      matched: [{ key: "ai_stories", name: "AI Stories" }],
      details: "### AI Stories [ai_stories]\nWhere: Arena > Train > AI Story.",
      featureList: "• AI Stories (/arena) [ai_stories]: Short stories.",
      lookup: "lumine admin feature-guide --query <words>",
    },
  }).join("\n");
  assert.match(text, /Write as Ciel: You are writing publicly as Ciel\./);
  assert.match(text, /- yay you did it!! 🎉/);
  assert.match(text, /Ciel's persona:\nCiel, you are an AI chatbot/);
  assert.match(text, /Feature guide for this thread: AI Stories \[ai_stories\]/);
  assert.match(text, /Where: Arena > Train > AI Story\./);
  assert.match(text, /Look up more: lumine admin feature-guide/);
  assert.match(
    formatDraftWriteAs({ unavailable: true, lookup: "lumine admin feature-guide" }).join("\n"),
    /could not be loaded; check lumine admin feature-guide before posting/,
  );
  assert.deepEqual(formatDraftWriteAs(undefined), []);
});

test("AI Prompt posts: their comments list by sharedTopic or link, and drafts show the policies and the prompt", () => {
  for (const target of [
    "sharedTopic:812",
    "https://www.twin-kle.com/shared-prompts/812",
  ]) {
    const operation = operationFor(["post", "comments", target, "--json"]);
    assert.equal(operation.name, "post.comments");
    assert.equal(operation.mutates, false);
    assert.match(operation.path, /^\/cli\/admin\/posts\/sharedTopic\/812\/comments(?:\?|$)/);
  }
  const lines = formatDraftWriteAs({
    identity: "Ciel",
    rule: "Write as Ciel.",
    policies: ["Keep thread roles exact.", "Write in English."],
    sharedPrompt: {
      id: 812,
      title: "Mochi the cat",
      author: "LilyMacaron",
      url: "https://www.twin-kle.com/shared-prompts/812",
      customInstructions: "You are a chatbot about Mochi the cat.",
    },
    persona: "PERSONA",
    featureKnowledge: {},
  }).join("\n");
  assert.match(lines, /- Keep thread roles exact\./);
  assert.match(lines, /- Write in English\./);
  assert.match(lines, /AI Prompt #812 "Mochi the cat" by LilyMacaron/);
  assert.match(lines, /You are a chatbot about Mochi the cat\./);
});
