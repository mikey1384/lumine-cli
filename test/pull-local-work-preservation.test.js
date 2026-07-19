import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  stashLocalProjectFilesBeforePull,
  writeProjectFiles,
} from "../lib/workspace.js";

test("pull preserves modified tracked files before overwriting and moves local-only files", async (t) => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-pull-preservation-"),
  );
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));

  await fs.writeFile(
    path.join(workspaceDir, "index.html"),
    "<main>local edit</main>",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "local-only.js"),
    "const unsaved = true;",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "unchanged.css"),
    "body { color: black; }",
    "utf8",
  );
  const trackedUtf16Bytes = Buffer.from([
    0xff, 0xfe, 0x63, 0x00, 0x6f, 0x00, 0x64, 0x00, 0x65, 0x00,
  ]);
  const localOnlyBinaryBytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
  await fs.writeFile(path.join(workspaceDir, "legacy.js"), trackedUtf16Bytes);
  await fs.writeFile(
    path.join(workspaceDir, "local-only.bin"),
    localOnlyBinaryBytes,
  );

  const serverFiles = [
    { path: "/index.html", content: "<main>server version</main>" },
    { path: "/legacy.js", content: "const encoding = 'utf8';" },
    { path: "/unchanged.css", content: "body { color: black; }" },
  ];
  const stashed = await stashLocalProjectFilesBeforePull({
    dir: workspaceDir,
    files: serverFiles,
  });

  assert.deepEqual(stashed.movedPaths.sort(), [
    "/local-only.bin",
    "/local-only.js",
  ]);
  assert.deepEqual(stashed.backedUpPaths.sort(), ["/index.html", "/legacy.js"]);
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "index.html"), "utf8"),
    "<main>local edit</main>",
  );
  await assert.rejects(
    fs.access(path.join(workspaceDir, "local-only.js")),
    /ENOENT/,
  );
  assert.deepEqual(
    await fs.readFile(path.join(workspaceDir, "legacy.js")),
    trackedUtf16Bytes,
  );
  await assert.rejects(
    fs.access(path.join(workspaceDir, "local-only.bin")),
    /ENOENT/,
  );

  await writeProjectFiles({ dir: workspaceDir, files: serverFiles });
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "index.html"), "utf8"),
    "<main>server version</main>",
  );
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "legacy.js"), "utf8"),
    "const encoding = 'utf8';",
  );

  const removedRoot = path.join(workspaceDir, ".twinkle", "removed");
  const [stashDirName] = await fs.readdir(removedRoot);
  const stashDir = path.join(removedRoot, stashDirName);
  assert.equal(
    await fs.readFile(path.join(stashDir, "index.html"), "utf8"),
    "<main>local edit</main>",
  );
  assert.equal(
    await fs.readFile(path.join(stashDir, "local-only.js"), "utf8"),
    "const unsaved = true;",
  );
  assert.deepEqual(
    await fs.readFile(path.join(stashDir, "legacy.js")),
    trackedUtf16Bytes,
  );
  assert.deepEqual(
    await fs.readFile(path.join(stashDir, "local-only.bin")),
    localOnlyBinaryBytes,
  );
  await assert.rejects(
    fs.access(path.join(stashDir, "unchanged.css")),
    /ENOENT/,
  );
});

test("pull preserves a local directory when the server replaces it with a file", async (t) => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-pull-directory-to-file-"),
  );
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));

  await fs.mkdir(path.join(workspaceDir, "assets", "node_modules"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspaceDir, "index.html"),
    "<main>unchanged</main>",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "assets", "logo.png"),
    "local logo",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "assets", "node_modules", "local-cache.txt"),
    "preserve excluded content",
    "utf8",
  );

  const serverFiles = [
    { path: "/index.html", content: "<main>unchanged</main>" },
    { path: "/assets", content: "server file" },
  ];
  const stashed = await stashLocalProjectFilesBeforePull({
    dir: workspaceDir,
    files: serverFiles,
  });

  assert.deepEqual(stashed.movedPaths, ["/assets/logo.png"]);
  await assert.rejects(fs.access(path.join(workspaceDir, "assets")), /ENOENT/);

  await writeProjectFiles({ dir: workspaceDir, files: serverFiles });
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "assets"), "utf8"),
    "server file",
  );

  const removedRoot = path.join(workspaceDir, ".twinkle", "removed");
  const [stashDirName] = await fs.readdir(removedRoot);
  const stashDir = path.join(removedRoot, stashDirName);
  assert.equal(
    await fs.readFile(path.join(stashDir, "assets", "logo.png"), "utf8"),
    "local logo",
  );
  assert.equal(
    await fs.readFile(
      path.join(stashDir, "assets", "node_modules", "local-cache.txt"),
      "utf8",
    ),
    "preserve excluded content",
  );
});

test("pull handles a local file when the server replaces it with a directory", async (t) => {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lumine-pull-file-to-directory-"),
  );
  t.after(() => fs.rm(workspaceDir, { recursive: true, force: true }));

  await fs.writeFile(
    path.join(workspaceDir, "index.html"),
    "<main>unchanged</main>",
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceDir, "scripts"),
    "local file",
    "utf8",
  );

  const serverFiles = [
    { path: "/index.html", content: "<main>unchanged</main>" },
    { path: "/scripts/main.js", content: "export const ready = true;" },
  ];
  const stashed = await stashLocalProjectFilesBeforePull({
    dir: workspaceDir,
    files: serverFiles,
  });

  assert.deepEqual(stashed.movedPaths, ["/scripts"]);
  await writeProjectFiles({ dir: workspaceDir, files: serverFiles });
  assert.equal(
    await fs.readFile(path.join(workspaceDir, "scripts", "main.js"), "utf8"),
    "export const ready = true;",
  );

  const removedRoot = path.join(workspaceDir, ".twinkle", "removed");
  const [stashDirName] = await fs.readdir(removedRoot);
  assert.equal(
    await fs.readFile(path.join(removedRoot, stashDirName, "scripts"), "utf8"),
    "local file",
  );
});
