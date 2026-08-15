import {
  reviewClaudeCodeAgentLoop,
  runClaudeCodeAgentPass,
} from "./claude-code.js";
import { reviewCodexAgentLoop, runCodexAgentPass } from "./codex.js";

const PROVIDERS = {
  codex: {
    id: "codex",
    label: "Codex",
    runPass: runCodexAgentPass,
    reviewLoop: reviewCodexAgentLoop,
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    runPass: runClaudeCodeAgentPass,
    reviewLoop: reviewClaudeCodeAgentLoop,
  },
};

export function resolveExternalAgentProvider(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  const providerId = normalized === "claude" ? "claude-code" : normalized;
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(
      "Choose an external agent with --provider codex or --provider claude-code.",
    );
  }
  return provider;
}

export function listExternalAgentProviderIds() {
  return Object.keys(PROVIDERS);
}
