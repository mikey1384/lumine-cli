import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AGENT_INSTRUCTION_FILES,
  LUMINE_AGENT_INSTRUCTIONS,
  LUMINE_AGENT_INSTRUCTIONS_MARKER,
  LUMINE_MAIN_CHECKOUT_INSTRUCTIONS,
  LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER,
  LUMINE_REFERENCE_INSTRUCTIONS,
  LUMINE_REFERENCE_INSTRUCTIONS_MARKER,
  LUMINE_VERSION_CHECKOUT_INSTRUCTIONS,
  LUMINE_VERSION_CHECKOUT_INSTRUCTIONS_MARKER,
  PROJECT_METADATA_DIR,
  PROJECT_METADATA_FILE,
} from "../lib/constants.js";
import {
  parseArgs,
  pullBuildFiles,
  pullMainBuildFiles,
  pullReferenceFiles,
  pullVersionBuildFiles,
} from "../lib/commands.js";
import {
  assertLocalProjectCanBeSaved,
  findLocalProjectMetadata,
  writeAgentInstructions,
  writeInstructionFiles,
} from "../lib/workspace.js";
import { testWorkRoot } from "./helpers/work-directory.js";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(testWorkRoot(), "checkout-guides-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const modes = [
  ["editable", LUMINE_AGENT_INSTRUCTIONS_MARKER, LUMINE_AGENT_INSTRUCTIONS],
  [
    "main",
    LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER,
    LUMINE_MAIN_CHECKOUT_INSTRUCTIONS,
  ],
  [
    "reference",
    LUMINE_REFERENCE_INSTRUCTIONS_MARKER,
    LUMINE_REFERENCE_INSTRUCTIONS,
  ],
  [
    "version",
    LUMINE_VERSION_CHECKOUT_INSTRUCTIONS_MARKER,
    LUMINE_VERSION_CHECKOUT_INSTRUCTIONS,
  ],
];

async function assertGuides(dir, expected) {
  for (const name of AGENT_INSTRUCTION_FILES) {
    assert.equal(
      await fs.readFile(path.join(dir, name), "utf8"),
      expected,
      name,
    );
  }
}

test("every checkout-mode transition refreshes both generated guides", async (t) => {
  const dir = await fixture(t);
  for (const [from, , original] of modes) {
    for (const [to, marker, content] of modes) {
      for (const name of AGENT_INSTRUCTION_FILES)
        await fs.writeFile(path.join(dir, name), original);
      await writeInstructionFiles({ dir, marker, content });
      for (const name of AGENT_INSTRUCTION_FILES)
        assert.equal(
          await fs.readFile(path.join(dir, name), "utf8"),
          content,
          `${name}: ${from} -> ${to}`,
        );
    }
  }
});

test("custom guides and quoted generated markers survive a checkout-mode change", async (t) => {
  const dir = await fixture(t);
  const custom = new Map([
    [
      "AGENTS.md",
      "# Project-specific instructions\nKeep our custom workflow.\n",
    ],
    [
      "CLAUDE.md",
      `# Custom guide\nThese are quoted examples, not a generated header:\n${modes.map(([, marker]) => marker).join("\n")}\nKeep this guide.\n`,
    ],
  ]);
  for (const [name, content] of custom)
    await fs.writeFile(path.join(dir, name), content);
  for (const [, marker, content] of modes) {
    await writeInstructionFiles({ dir, marker, content });
    for (const [name, expected] of custom)
      assert.equal(await fs.readFile(path.join(dir, name), "utf8"), expected);
  }
  await fs.rm(path.join(dir, "CLAUDE.md"));
  await writeAgentInstructions({ dir });
  assert.equal(
    await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8"),
    LUMINE_AGENT_INSTRUCTIONS,
  );
  assert.equal(
    await fs.readFile(path.join(dir, "AGENTS.md"), "utf8"),
    custom.get("AGENTS.md"),
  );
});

test("older generated guides update across modes, including BOM and CRLF headers", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(
    path.join(dir, "AGENTS.md"),
    `${LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER}\nAn older CLI-generated main guide.\n`,
  );
  await fs.writeFile(
    path.join(dir, "CLAUDE.md"),
    `\uFEFF${LUMINE_VERSION_CHECKOUT_INSTRUCTIONS_MARKER}\r\nAn older generated version guide.\r\n`,
  );
  await writeAgentInstructions({ dir });
  await assertGuides(dir, LUMINE_AGENT_INSTRUCTIONS);
});

test("real pull paths keep metadata and generated guides aligned in a reused directory", async (t) => {
  const dir = await fixture(t);
  const build = {
    id: 2460,
    role: "owner",
    ownerUsername: "mikey",
    title: "Fixture",
    canWrite: true,
    canPublish: true,
  };
  const projectFiles = [{ path: "/index.html", content: "<p>Fixture</p>" }];
  const options = {
    ...parseArgs(["pull", "2460"]),
    apiUrl: "https://test.invalid",
    siteUrl: "https://test.invalid",
    dir,
    quiet: true,
    skipAssetManifest: true,
  };
  const auth = { token: "fixture" };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(
      !init?.method || init.method === "GET",
      "checkout must remain read-only remotely",
    );
    requests.push(String(url));
    return new Response(
      JSON.stringify({
        build,
        projectFiles,
        filesHash: "fixture-hash",
        version: { version: 3, versionId: 30 },
      }),
      { status: 200 },
    );
  });
  t.mock.method(console, "log", () => {});
  const readMetadata = async () =>
    JSON.parse(
      await fs.readFile(
        path.join(dir, PROJECT_METADATA_DIR, PROJECT_METADATA_FILE),
        "utf8",
      ),
    );
  const editable = async () => {
    await pullBuildFiles({ options, auth, buildId: build.id });
    const metadata = await readMetadata();
    assert.equal(metadata.readOnly, undefined);
    assert.equal(metadata.mainCheckout, undefined);
    assert.equal(metadata.versionCheckout, undefined);
    assert.equal(metadata.reference, undefined);
    assert.equal(metadata.build.canWrite, true);
    assert.doesNotThrow(() => assertLocalProjectCanBeSaved({ metadata }));
    await assertGuides(dir, LUMINE_AGENT_INSTRUCTIONS);
    assert.equal(
      await fs.readFile(path.join(dir, "index.html"), "utf8"),
      projectFiles[0].content,
    );
  };
  for (const [pullReadOnly, expected] of [
    [
      () => pullMainBuildFiles({ options, auth, build }),
      LUMINE_MAIN_CHECKOUT_INSTRUCTIONS,
    ],
    [
      () =>
        pullVersionBuildFiles({
          options: { ...options, pullVersion: 3 },
          auth,
          build,
        }),
      LUMINE_VERSION_CHECKOUT_INSTRUCTIONS,
    ],
    [
      () => pullReferenceFiles({ options, auth, buildId: build.id }),
      LUMINE_REFERENCE_INSTRUCTIONS,
    ],
  ]) {
    await pullReadOnly();
    const local = await findLocalProjectMetadata(dir);
    assert.equal(local.metadata.readOnly, true);
    assert.equal(local.metadata.build.canWrite, false);
    assert.throws(
      () => assertLocalProjectCanBeSaved(local),
      /read-only|reference/,
    );
    await assertGuides(dir, expected);
    await editable();
  }
  assert.equal(requests.length, 6);
});
