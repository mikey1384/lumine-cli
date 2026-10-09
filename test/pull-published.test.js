import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseArgs, pull, pullVersionBuildFiles } from "../lib/commands.js";
import {
  PROJECT_METADATA_DIR,
  PROJECT_METADATA_FILE,
} from "../lib/constants.js";
import { testWorkRoot } from "./helpers/work-directory.js";

test("published is an explicit boolean and unsupported review selectors fail", async () => {
  assert.equal(parseArgs(["pull", "2610", "--published"]).pullPublished, true);
  for (const flag of ["--mode", "--review-mode", "--source"]) {
    assert.throws(
      () => parseArgs(["admin", "builds", "review", "2610", flag, "published"]),
      /Unsupported Build review option/,
    );
  }
  await assert.rejects(
    pull(parseArgs(["pull", "2610", "--published", "--version", "272"])),
    /Choose/,
  );
});

test("published checkout reads the named Build, keeps the artifact ID and is read-only", async (t) => {
  const dir = await fs.mkdtemp(path.join(testWorkRoot(), "published-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const build = {
    id: 2610,
    role: "collaborator",
    title: "Game",
    isPublic: true,
    publishedArtifactVersionId: 14357,
    contributionBuildId: 9999,
  };
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    return new Response(
      JSON.stringify(
        String(url).includes("/versions/")
          ? {
              build,
              version: { versionId: 14357, version: 272 },
              projectFiles: [
                { path: "/index.html", content: "<p>Published game</p>" },
              ],
            }
          : { build },
      ),
      { status: 200 },
    );
  });
  await pullVersionBuildFiles({
    options: {
      ...parseArgs(["pull", "2610", "--published"]),
      apiUrl: "https://test.invalid",
      dir,
    },
    auth: { token: "fixture" },
    build,
  });
  assert.match(requested[0], /\/build\/2610\/versions\/published\/files$/);
  assert.equal(requested.length, 2);
  assert.match(
    await fs.readFile(path.join(dir, "index.html"), "utf8"),
    /Published game/,
  );
  const metadata = JSON.parse(
    await fs.readFile(
      path.join(dir, PROJECT_METADATA_DIR, PROJECT_METADATA_FILE),
      "utf8",
    ),
  );
  assert.equal(metadata.readOnly, true);
  assert.equal(metadata.checkoutArtifactVersionId, 14357);
  assert.equal(metadata.publishedCheckout, true);
});

test("a concurrent publication refuses before overwriting local files", async (t) => {
  const dir = await fs.mkdtemp(path.join(testWorkRoot(), "published-race-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "index.html"), "local work");
  const build = { id: 12, isPublic: true, publishedArtifactVersionId: 100 };
  t.mock.method(
    globalThis,
    "fetch",
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("/versions/")
            ? {
                build,
                version: { versionId: 100, version: 2 },
                projectFiles: [
                  { path: "/index.html", content: "old published" },
                ],
              }
            : { build: { ...build, publishedArtifactVersionId: 101 } },
        ),
        { status: 200 },
      ),
  );
  await assert.rejects(
    pullVersionBuildFiles({
      options: {
        ...parseArgs(["pull", "12", "--published"]),
        apiUrl: "https://test.invalid",
        dir,
      },
      auth: { token: "fixture" },
      build,
    }),
    /changed during checkout/,
  );
  assert.equal(
    await fs.readFile(path.join(dir, "index.html"), "utf8"),
    "local work",
  );
});
