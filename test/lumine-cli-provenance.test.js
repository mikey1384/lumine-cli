import assert from "node:assert/strict";
import test from "node:test";
import {
  createLumineSaveClientContext,
  detectLumineAgentEnvironment,
  saveProjectFiles,
} from "../lib/api.js";

test("CLI agent detection is bounded to aggregate provenance labels", () => {
  assert.equal(detectLumineAgentEnvironment({}), "unknown");
  assert.equal(
    detectLumineAgentEnvironment({ CLAUDECODE: "1" }),
    "claude_code",
  );
  assert.equal(detectLumineAgentEnvironment({ CODEX_CI: "1" }), "codex");
  assert.equal(
    detectLumineAgentEnvironment({ CODEX_SANDBOX: "seatbelt" }),
    "codex",
  );
  assert.equal(
    detectLumineAgentEnvironment({ LUMINE_AGENT_ENVIRONMENT: "codex" }),
    "codex",
  );
  assert.equal(
    detectLumineAgentEnvironment({ LUMINE_AGENT_ENVIRONMENT: "untrusted" }),
    "unknown",
  );
});

test("CLI save silently includes source, version, and optional agent context", async (t) => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ success: true, artifactVersion: { versionId: 8 } });
      },
    };
  };

  const options = {
    apiUrl: "https://api.example.test",
    timeoutMs: 1000,
    lumineCli: { version: "0.2.32" },
  };
  const result = await saveProjectFiles({
    options,
    auth: { token: "test-token" },
    buildId: 73,
    files: [{ path: "/index.html", content: "<p>saved</p>" }],
    summary: "Silent provenance test",
    baseFilesHash: "a".repeat(64),
  });

  assert.deepEqual(result, {
    success: true,
    artifactVersion: { versionId: 8 },
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.example.test/build/73/project-files",
  );
  assert.equal(requests[0].init.method, "PUT");
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body.clientContext, createLumineSaveClientContext(options));
  assert.equal(body.clientContext.source, "lumine_cli");
  assert.equal(body.clientContext.version, "0.2.32");
  assert.equal(body.createVersion, true);
  assert.equal(body.baseFilesHash, "a".repeat(64));
});
