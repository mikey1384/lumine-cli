import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reportLocalProjectFindings } from "../lib/commands.js";
import { collectProjectLimitFindings } from "../lib/workspace.js";

function files(count, bytesPerFile = 1) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/file-${index}.js`,
    content: Array.from(
      { length: Math.ceil(bytesPerFile / 159) },
      () => "x".repeat(159),
    )
      .join("\n")
      .slice(0, bytesPerFile),
  }));
}

function byteSizedProject(totalBytes) {
  const fileCount = Math.ceil(totalBytes / (499 * 160));
  const bytesPerFile = Math.ceil(totalBytes / fileCount);
  return files(fileCount, bytesPerFile);
}

test("approved project metadata raises CLI file and byte gates", () => {
  const approved = {
    maxFilesPerProject: 500,
    maxProjectBytes: 5 * 1024 * 1024,
  };
  assert.equal(
    collectProjectLimitFindings(files(101), approved).errors.length,
    0,
  );
  assert.equal(
    collectProjectLimitFindings(byteSizedProject(1024 * 1024 + 1), approved)
      .errors.length,
    0,
  );
  assert.match(
    collectProjectLimitFindings(files(501), approved).errors[0],
    /500-file limit/,
  );
});

test("unapproved workspaces retain the 100-file and 1 MB defaults", () => {
  assert.match(
    collectProjectLimitFindings(files(101)).errors[0],
    /100-file limit/,
  );
  assert.match(
    collectProjectLimitFindings(byteSizedProject(1024 * 1024 + 1)).errors[0],
    /1\.0 MB limit/,
  );
});

test("canonical server metadata is not weakened by local defaults", () => {
  const canonical = {
    maxFilesPerProject: 50,
    maxProjectBytes: 512 * 1024,
  };
  assert.match(
    collectProjectLimitFindings(files(51), canonical).errors[0],
    /50-file limit/,
  );
  assert.match(
    collectProjectLimitFindings(byteSizedProject(512 * 1024 + 1), canonical)
      .errors[0],
    /512\.0 KB limit/,
  );
});

test("local check uses freshly loaded canonical limits over stale checkout metadata", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lumine-limit-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".twinkle"));
  await fs.writeFile(
    path.join(workspace, ".twinkle", "lumine-project.json"),
    JSON.stringify({
      buildId: 42,
      build: {
        id: 42,
        projectLimits: {
          maxFilesPerProject: 100,
          maxProjectBytes: 1024 * 1024,
        },
      },
    }),
  );
  await Promise.all(
    Array.from({ length: 101 }, (_, index) =>
      fs.writeFile(
        path.join(workspace, index === 0 ? "index.html" : `file-${index}.js`),
        "x",
      ),
    ),
  );

  const logs = [];
  const errors = [];
  t.mock.method(console, "log", (message) => logs.push(String(message)));
  t.mock.method(console, "error", (message) => errors.push(String(message)));
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  t.after(() => {
    process.exitCode = previousExitCode;
  });

  await reportLocalProjectFindings(
    { dir: workspace },
    {
      maxFilesPerProject: 500,
      maxProjectBytes: 5 * 1024 * 1024,
    },
  );

  assert.equal(process.exitCode, undefined);
  assert.deepEqual(errors, []);
  assert.equal(
    logs.some((line) => /101 project files within limits/.test(line)),
    true,
  );
});

test("an over-limit file is kept while unchanged from the saved version, refused once changed", async () => {
  const { computeProjectFileHashes } = await import("../lib/workspace.js");
  const legacy = { path: "/old.js", content: Array.from({ length: 501 }, () => "x").join("\n") };
  const saved = computeProjectFileHashes([legacy, { path: "/index.html", content: "<p>a</p>" }]);
  const unchanged = collectProjectLimitFindings([legacy, { path: "/index.html", content: "<p>b</p>" }], {}, { savedFileHashes: saved });
  assert.deepEqual(unchanged.errors, []);
  const grown = collectProjectLimitFindings([{ ...legacy, content: `${legacy.content}\nmore` }], {}, { savedFileHashes: saved });
  assert.match(grown.errors[0], /\/old\.js" exceeds the per-file limit of 500 effective lines \(502/);
  // An older checkout without per-file hashes refuses as before, and says how to fix it.
  const unknown = collectProjectLimitFindings([legacy], {});
  assert.match(unknown.errors[0], /no record of the saved files/);
});
