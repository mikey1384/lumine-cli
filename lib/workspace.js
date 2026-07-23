import fs from "fs/promises";
import path from "path";

import {
  AGENT_INSTRUCTION_FILES,
  BUNDLED_SDK_REFERENCE_URL,
  EXCLUDED_UPLOAD_DIRS,
  EXCLUDED_UPLOAD_FILES,
  LUMINE_AGENT_INSTRUCTIONS,
  LUMINE_AGENT_INSTRUCTIONS_MARKER,
  LUMINE_REFERENCE_INSTRUCTIONS,
  LUMINE_REFERENCE_INSTRUCTIONS_MARKER,
  LUMINE_SDK_REFERENCE_MARKER,
  PROJECT_EFFECTIVE_LINE_MAX_COLUMNS,
  PROJECT_MAX_EFFECTIVE_FILE_LINES,
  PROJECT_MAX_FILES,
  PROJECT_MAX_TOTAL_BYTES_DEFAULT,
  PROJECT_WARN_TOTAL_BYTES,
  PROJECT_METADATA_DIR,
  PROJECT_METADATA_FILE,
  SDK_REFERENCE_FALLBACK,
  SDK_REFERENCE_FILE,
} from "./constants.js";
import { serializeLumineCliMetadata } from "./api.js";
import { formatBytes } from "./util.js";

export async function writeAgentInstructions({ dir }) {
  await writeInstructionFiles({
    dir,
    marker: LUMINE_AGENT_INSTRUCTIONS_MARKER,
    content: LUMINE_AGENT_INSTRUCTIONS,
  });
}

export async function writeReferenceInstructions({ dir }) {
  await writeInstructionFiles({
    dir,
    marker: LUMINE_REFERENCE_INSTRUCTIONS_MARKER,
    content: LUMINE_REFERENCE_INSTRUCTIONS,
  });
}

// Write AGENTS.md/CLAUDE.md, but never clobber a file the user customized:
// only (re)write when the file is absent or still carries our marker.
export async function writeInstructionFiles({ dir, marker, content }) {
  for (const fileName of AGENT_INSTRUCTION_FILES) {
    const filePath = path.join(dir, fileName);
    try {
      const existing = await fs.readFile(filePath, "utf8");
      if (!existing.includes(marker)) {
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.writeFile(filePath, content, "utf8");
  }
}

export async function writeSdkReference({ dir }) {
  const filePath = path.join(dir, SDK_REFERENCE_FILE);
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (!existing.includes(LUMINE_SDK_REFERENCE_MARKER)) {
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.writeFile(filePath, await loadSdkReference(), "utf8");
}

export async function loadSdkReference() {
  try {
    const rawReference = await fs.readFile(BUNDLED_SDK_REFERENCE_URL, "utf8");
    const reference = rawReference.trim();
    if (reference) return `${LUMINE_SDK_REFERENCE_MARKER}\n${reference}\n`;
  } catch {
    // Fall through to the compact reference so pulled workspaces still guide agents.
  }
  return SDK_REFERENCE_FALLBACK;
}

export async function collectProjectFiles(dir) {
  const root = path.resolve(dir);
  const files = [];
  await collectProjectFilesFromDir({ root, dir: root, files });
  if (!files.some((file) => isIndexHtmlPath(file.path))) {
    throw new Error("Project files must include /index.html or /index.htm.");
  }
  assertProjectFilesAvoidNativeFormSubmission(files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Tolerant collector for read-only scans (asset-reference detection): skips
// unreadable/binary files instead of throwing and requires no entry file.
export async function collectWorkspaceTextFilesLenient(dir) {
  const root = path.resolve(dir);
  const files = [];
  try {
    await collectProjectFilesFromDir({ root, dir: root, files, lenient: true });
  } catch {
    return [];
  }
  return files;
}

async function walkWorkspaceProjectEntries({
  root,
  dir,
  onEntry,
  onDirectory,
  allowMissingRoot = false,
}) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (
      allowMissingRoot &&
      error.code === "ENOENT" &&
      path.resolve(dir) === path.resolve(root)
    ) {
      return;
    }
    if (error.code === "ENOENT") {
      throw new Error(`Project directory does not exist: ${dir}`);
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await onDirectory?.({ entry, fullPath });
      if (EXCLUDED_UPLOAD_DIRS.has(entry.name)) continue;
      // A nested Lumine checkout (its own .twinkle metadata) is another
      // project that happens to sit here — never upload it as project files.
      if (await isNestedLumineCheckout(fullPath)) {
        console.error(
          `lumine: skipping nested Lumine checkout ${path.relative(root, fullPath)}/ (not part of this project)`,
        );
        continue;
      }
      await walkWorkspaceProjectEntries({
        root,
        dir: fullPath,
        onEntry,
        onDirectory,
      });
      continue;
    }
    if (entry.isFile() && EXCLUDED_UPLOAD_FILES.has(entry.name)) continue;
    await onEntry({ entry, fullPath });
  }
}

export async function collectProjectFilesFromDir({
  root,
  dir,
  files,
  lenient = false,
}) {
  await walkWorkspaceProjectEntries({
    root,
    dir,
    async onEntry({ entry, fullPath }) {
      if (!entry.isFile()) return;
      const buffer = await fs.readFile(fullPath);
      const encodingIssue = detectProjectFileEncodingIssue(buffer);
      if (encodingIssue) {
        if (lenient) return;
        const relativePath = localFilePathToProjectPath({
          root,
          filePath: fullPath,
        });
        if (encodingIssue === "utf16") {
          throw new Error(
            `Cannot save ${relativePath}: it is UTF-16 encoded. Twinkle project files must be UTF-8 text — re-save the file as UTF-8 and retry.`,
          );
        }
        throw new Error(
          `Cannot save binary file ${relativePath}. Twinkle project files must be text files. ` +
            `Upload media as a build asset instead: move the file out of this workspace, run ` +
            "`lumine assets upload <path-to-file>`, and reference the printed URL from your code.",
        );
      }
      files.push({
        path: localFilePathToProjectPath({ root, filePath: fullPath }),
        content: buffer.toString("utf8"),
      });
    },
  });
}

// Pull preservation needs a lossless inventory, not the upload-oriented text
// collector above. Binary/UTF-16 files are still local work, and special
// entries such as symlinks must be relocated before writeProjectFiles can
// follow or replace their server-owned paths. Any scan/read error other than a
// missing fresh-pull root aborts the pull before local state is touched.
async function collectWorkspaceEntriesBeforePull(dir) {
  const root = path.resolve(dir);
  const entries = [];
  const directories = [];
  await walkWorkspaceProjectEntries({
    root,
    dir: root,
    allowMissingRoot: true,
    onDirectory({ fullPath }) {
      directories.push(
        localFilePathToProjectPath({ root, filePath: fullPath }),
      );
    },
    async onEntry({ entry, fullPath }) {
      const isRegularFile = entry.isFile();
      entries.push({
        path: localFilePathToProjectPath({ root, filePath: fullPath }),
        isRegularFile,
        content: isRegularFile ? await fs.readFile(fullPath) : null,
      });
    },
  });
  return { entries, directories };
}

// UTF-16 BOMs get their own error (the file is text, just mis-encoded); NUL
// bytes or content that does not round-trip through UTF-8 is binary. The
// round-trip check matters: the server does no encoding validation, so
// NUL-free binary sent as JSON would be silently corrupted into U+FFFD
// replacement characters — this is the only gate.
export function detectProjectFileEncodingIssue(buffer) {
  if (buffer.length >= 2) {
    const [b0, b1] = buffer;
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      return "utf16";
    }
  }
  if (buffer.includes(0)) return "binary";
  if (!Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer)) {
    return "binary";
  }
  return null;
}

export async function isNestedLumineCheckout(dir) {
  try {
    await fs.access(
      path.join(dir, PROJECT_METADATA_DIR, PROJECT_METADATA_FILE),
    );
    return true;
  } catch {
    return false;
  }
}

export function localFilePathToProjectPath({ root, filePath }) {
  const relative = path.relative(root, filePath).replace(/\\/g, "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe local project file path: ${filePath}`);
  }
  return `/${relative}`;
}

export function isIndexHtmlPath(projectPath) {
  const normalized = String(projectPath || "")
    .trim()
    .toLowerCase();
  return normalized === "/index.html" || normalized === "/index.htm";
}

export function isNativeFormMarkupProjectPath(projectPath) {
  return /\.(?:html?|jsx?|tsx?|mjs|cjs)$/i.test(
    String(projectPath || "").trim(),
  );
}

export function getLineColumnForSourceIndex(content, sourceIndex) {
  const before = String(content || "").slice(0, Math.max(0, sourceIndex));
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

export function formatProjectFileLocation({ filePath, line, column }) {
  return `${filePath}:${line}:${column}`;
}

export function assertProjectFilesAvoidNativeFormSubmission(files) {
  for (const file of files) {
    const content = String(file.content || "");
    if (isNativeFormMarkupProjectPath(file.path)) {
      const formMatch = content.match(/<form\b[^>]*>/i);
      if (formMatch) {
        const { line, column } = getLineColumnForSourceIndex(
          content,
          formMatch.index || 0,
        );
        throw new Error(
          `Cannot save native form markup at ${formatProjectFileLocation({
            filePath: file.path,
            line,
            column,
          })}. Twinkle Build apps run in sandboxed iframes without form-submit permission. Replace <form> with JavaScript-handled inputs and buttons.`,
        );
      }
    }

    const requestSubmitMatch = content.match(/\brequestSubmit\s*\(/);
    if (requestSubmitMatch) {
      const { line, column } = getLineColumnForSourceIndex(
        content,
        requestSubmitMatch.index || 0,
      );
      throw new Error(
        `Cannot save native form submission at ${formatProjectFileLocation({
          filePath: file.path,
          line,
          column,
        })}. requestSubmit() is blocked by the Build iframe sandbox; use a JavaScript click handler instead.`,
      );
    }
  }
}

// Mirrors the server's effective-line counting: long physical lines count as
// one extra line per PROJECT_EFFECTIVE_LINE_MAX_COLUMNS characters.
export function countEffectiveLines(value) {
  const normalized = String(value || "").replace(/\r\n?/g, "\n");
  if (!normalized) return 0;
  return normalized
    .split("\n")
    .reduce(
      (total, line) =>
        total +
        Math.max(
          1,
          Math.ceil(line.length / PROJECT_EFFECTIVE_LINE_MAX_COLUMNS),
        ),
      0,
    );
}

// Local mirror of the server's project limits so violations fail fast with
// the full list (the server stops at the first). File count and per-file
// effective lines are hard server constants -> errors; the total-byte limit
// is env-overridable server-side -> warning only, the server stays the gate.
export function collectProjectLimitFindings(files) {
  const errors = [];
  const warnings = [];
  if (files.length > PROJECT_MAX_FILES) {
    errors.push(
      `Project exceeds the ${PROJECT_MAX_FILES}-file limit (${files.length} files). Split or consolidate files before saving.`,
    );
  }
  for (const file of files) {
    const effectiveLineCount = countEffectiveLines(file.content);
    if (effectiveLineCount > PROJECT_MAX_EFFECTIVE_FILE_LINES) {
      errors.push(
        `File "${file.path}" exceeds the per-file limit of ${PROJECT_MAX_EFFECTIVE_FILE_LINES} effective lines ` +
          `(${effectiveLineCount} effective lines). Split it into multiple files and folders instead. ` +
          `Long physical lines count as additional effective lines every ${PROJECT_EFFECTIVE_LINE_MAX_COLUMNS} characters.`,
      );
    }
  }
  const totalBytes = files.reduce(
    (total, file) =>
      total + Buffer.byteLength(String(file.content || ""), "utf8"),
    0,
  );
  if (totalBytes > PROJECT_MAX_TOTAL_BYTES_DEFAULT) {
    warnings.push(
      `Project files total ${formatBytes(totalBytes)}, above the default ${Math.floor(
        PROJECT_MAX_TOTAL_BYTES_DEFAULT / 1024,
      )} KB project limit — the server may reject this save.`,
    );
  } else if (totalBytes > PROJECT_WARN_TOTAL_BYTES) {
    warnings.push(
      `Project files total ${formatBytes(totalBytes)} — approaching the ${Math.floor(
        PROJECT_MAX_TOTAL_BYTES_DEFAULT / 1024,
      )} KB project cap (soft warning from ${Math.floor(
        PROJECT_WARN_TOTAL_BYTES / 1024,
      )} KB). Keep files lean where structure allows.`,
    );
  }
  return { errors, warnings };
}

export function assertProjectFilesWithinLimits(files) {
  const { errors, warnings } = collectProjectLimitFindings(files);
  for (const warning of warnings) {
    console.error(`lumine: warning — ${warning}`);
  }
  if (errors.length > 0) {
    throw new Error(
      errors.length === 1
        ? errors[0]
        : `Project limit violations:\n  - ${errors.join("\n  - ")}`,
    );
  }
}

export async function writeProjectFiles({ dir, files }) {
  await fs.mkdir(dir, { recursive: true });
  for (const file of files) {
    const filePath = resolveLocalProjectFilePath({
      rootDir: dir,
      projectPath: file.path,
    });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, String(file.content || ""), "utf8");
  }
}

// After update-from-main, files that main deleted must also leave the local
// workspace — otherwise the next save would resurrect them on the branch.
export async function removeLocalProjectFilesNotIn({ dir, files }) {
  const keep = new Set(files.map((file) => String(file.path)));
  const localFiles = await collectProjectFiles(dir);
  for (const file of localFiles) {
    if (keep.has(file.path)) continue;
    await fs.unlink(
      resolveLocalProjectFilePath({ rootDir: dir, projectPath: file.path }),
    );
  }
}

// Non-destructive local-work preservation for `lumine pull` into an existing
// workspace. Pull is the recommended recovery step after a stale-save
// rejection, so it must never destroy unsaved local work — and that work is
// usually edits to files the server snapshot ALSO contains, which is why this
// must run BEFORE the server files are written over them:
// - local files absent from the server snapshot may be server-side deletions
//   or brand-new unsaved work: MOVE them into .twinkle/removed/<timestamp>/
//   (excluded from uploads) so a leftover file cannot pass the stale guard on
//   the next save and silently resurrect itself
// - local files whose content differs from the incoming server copy are about
//   to be overwritten: COPY them into the same stash so the pre-pull edits
//   remain recoverable
// Returns { movedPaths, backedUpPaths } of stashed project paths.
export async function stashLocalProjectFilesBeforePull({ dir, files }) {
  const serverContentByPath = new Map(
    files.map((file) => [String(file.path), String(file.content || "")]),
  );
  const {
    entries: localFiles,
    directories: localDirectoryPaths,
  } = await collectWorkspaceEntriesBeforePull(dir);
  const movedPaths = new Set();
  const backedUpPaths = new Set();
  let stashRoot = null;
  const ensureStashRoot = () => {
    if (!stashRoot) {
      const stampedDirName = new Date().toISOString().replace(/[:.]/g, "-");
      stashRoot = path.join(
        dir,
        PROJECT_METADATA_DIR,
        "removed",
        stampedDirName,
      );
    }
    return stashRoot;
  };
  const stashPathFor = (projectPath) =>
    path.join(
      ensureStashRoot(),
      ...projectPath.split("/").filter(Boolean),
    );

  // Resolve directory -> file transitions before processing individual local
  // entries. Moving descendants first would leave their empty parent behind,
  // and writeProjectFiles would then fail with EISDIR when the server snapshot
  // writes a regular file at that path. Moving the directory as one unit also
  // preserves excluded or nested-workspace content that the inventory skips.
  const stashedDirectoryPaths = [];
  const localDirectoryPathSet = new Set(localDirectoryPaths);
  const incomingProjectPaths = [...serverContentByPath.keys()].sort(
    (a, b) => a.split("/").length - b.split("/").length,
  );
  for (const projectPath of incomingProjectPaths) {
    if (
      stashedDirectoryPaths.some((directoryPath) =>
        projectPath.startsWith(`${directoryPath}/`),
      )
    ) {
      continue;
    }
    if (!localDirectoryPathSet.has(projectPath)) continue;

    const sourcePath = resolveLocalProjectFilePath({
      rootDir: dir,
      projectPath,
    });
    const stashPath = stashPathFor(projectPath);
    await fs.mkdir(path.dirname(stashPath), { recursive: true });
    await fs.rename(sourcePath, stashPath);
    stashedDirectoryPaths.push(projectPath);
    for (const localFile of localFiles) {
      if (!localFile.path.startsWith(`${projectPath}/`)) continue;
      if (serverContentByPath.has(localFile.path)) {
        backedUpPaths.add(localFile.path);
      } else {
        movedPaths.add(localFile.path);
      }
    }
  }

  for (const file of localFiles) {
    if (
      stashedDirectoryPaths.some((directoryPath) =>
        file.path.startsWith(`${directoryPath}/`),
      )
    ) {
      continue;
    }
    const serverContent = serverContentByPath.get(file.path);
    const isTracked = serverContent !== undefined;
    if (
      isTracked &&
      file.isRegularFile &&
      file.content.equals(Buffer.from(serverContent, "utf8"))
    ) {
      continue;
    }
    const sourcePath = resolveLocalProjectFilePath({
      rootDir: dir,
      projectPath: file.path,
    });
    const stashPath = stashPathFor(file.path);
    await fs.mkdir(path.dirname(stashPath), { recursive: true });
    if (isTracked && file.isRegularFile) {
      await fs.copyFile(sourcePath, stashPath);
      backedUpPaths.add(file.path);
    } else {
      // Non-regular entries must move even when tracked: leaving a symlink at
      // the server path would let writeProjectFiles overwrite its target.
      await fs.rename(sourcePath, stashPath);
      if (isTracked) {
        backedUpPaths.add(file.path);
      } else {
        movedPaths.add(file.path);
      }
    }
  }
  return {
    movedPaths: [...movedPaths],
    backedUpPaths: [...backedUpPaths],
  };
}

export async function writeProjectMetadata({
  dir,
  options,
  build,
  manifest,
  pulledAt,
  lastSavedAt,
  filesHash,
}) {
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  await fs.writeFile(
    path.join(metadataDir, PROJECT_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        buildId: Number(build?.id || 0) || null,
        build: build
          ? {
              id: Number(build.id || 0) || null,
              title: build.title || "",
              role: build.role || "",
              ownerUsername: build.ownerUsername || null,
              contributionStatus: build.contributionStatus || "none",
              contributionRootBuildId:
                Number(build.contributionRootBuildId || 0) || null,
              contributionContributorId:
                Number(build.contributionContributorId || 0) || null,
              contributionBranchNumber:
                Number(build.contributionBranchNumber || 0) || null,
              canWrite:
                build.canWrite !== undefined
                  ? Boolean(build.canWrite)
                  : build.role === "owner",
              canPublish:
                build.canPublish !== undefined
                  ? Boolean(build.canPublish)
                  : build.role === "owner",
            }
          : null,
        apiUrl: options.apiUrl,
        siteUrl: options.siteUrl,
        lumineCli: serializeLumineCliMetadata(options),
        manifest,
        pulledAt,
        lastSavedAt,
        // Server-issued hash of the project files this workspace is based on.
        // `lumine save` sends it back so a stale workspace cannot silently
        // rewind newer server state. Missing/null refuses save unless --force
        // (server also rejects unguarded saves onto non-empty projects).
        filesHash: typeof filesHash === "string" ? filesHash : null,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function writeReferenceMetadata({
  dir,
  options,
  build,
  manifest,
  reference,
  pulledAt,
}) {
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  const sourceBuildId =
    Number(reference?.sourceBuildId || 0) || Number(build?.id || 0) || null;
  await fs.writeFile(
    path.join(metadataDir, PROJECT_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        buildId: sourceBuildId,
        readOnly: true,
        reference: {
          readOnly: true,
          forkable: true,
          sourceBuildId,
          sourceAppUrl: sourceBuildId
            ? `${options.siteUrl}/app/${sourceBuildId}`
            : null,
        },
        build: {
          id: sourceBuildId,
          title:
            build?.title || (sourceBuildId ? `Build ${sourceBuildId}` : ""),
          role: "reference",
          ownerUsername: build?.ownerUsername || null,
          collaborationMode: build?.collaborationMode || "open_source",
          canWrite: false,
          canPublish: false,
        },
        apiUrl: options.apiUrl,
        siteUrl: options.siteUrl,
        lumineCli: serializeLumineCliMetadata(options),
        manifest,
        pulledAt,
      },
      null,
      2,
    ),
    "utf8",
  );
}

// Metadata for a read-only `pull --main` checkout: canWrite is forced false
// (the files endpoint reports token scope, not role) and mainCheckout marks it
// so save can explain where edits belong.
export async function writeMainCheckoutMetadata({
  dir,
  options,
  build,
  manifest,
  pulledAt,
}) {
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  const rootBuildId = Number(build?.id || 0) || null;
  await fs.writeFile(
    path.join(metadataDir, PROJECT_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        buildId: rootBuildId,
        readOnly: true,
        mainCheckout: true,
        build: {
          id: rootBuildId,
          title: build?.title || (rootBuildId ? `Build ${rootBuildId}` : ""),
          role: build?.role || "collaborator",
          ownerUsername: build?.ownerUsername || null,
          contributionStatus: "none",
          contributionRootBuildId: null,
          canWrite: false,
          canPublish: false,
        },
        apiUrl: options.apiUrl,
        siteUrl: options.siteUrl,
        lumineCli: serializeLumineCliMetadata(options),
        manifest,
        pulledAt,
      },
      null,
      2,
    ),
    "utf8",
  );
}

// Metadata for a read-only `pull --version <n>` checkout of one previous save:
// versionCheckout marks it so save can point back at the restore flow.
export async function writeVersionCheckoutMetadata({
  dir,
  options,
  build,
  manifest,
  version,
  pulledAt,
}) {
  const metadataDir = path.join(dir, PROJECT_METADATA_DIR);
  await fs.mkdir(metadataDir, { recursive: true });
  const buildId = Number(build?.id || 0) || null;
  await fs.writeFile(
    path.join(metadataDir, PROJECT_METADATA_FILE),
    JSON.stringify(
      {
        schemaVersion: 1,
        buildId,
        readOnly: true,
        versionCheckout: true,
        checkoutVersion: Number(version?.version || 0) || null,
        checkoutVersionSummary: version?.summary || null,
        checkoutVersionCreatedAt: Number(version?.createdAt || 0) || null,
        build: {
          id: buildId,
          title: build?.title || (buildId ? `Build ${buildId}` : ""),
          role: build?.role || "collaborator",
          ownerUsername: build?.ownerUsername || null,
          contributionStatus: "none",
          contributionRootBuildId:
            Number(build?.contributionRootBuildId || 0) || null,
          canWrite: false,
          canPublish: false,
        },
        apiUrl: options.apiUrl,
        siteUrl: options.siteUrl,
        lumineCli: serializeLumineCliMetadata(options),
        manifest,
        pulledAt,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function findLocalProjectMetadata(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    const metadataPath = path.join(
      current,
      PROJECT_METADATA_DIR,
      PROJECT_METADATA_FILE,
    );
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      return { rootDir: current, metadata, metadataPath };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveProjectDirForSave({ options, localProject }) {
  if (options.dir) return path.resolve(options.dir);
  if (localProject?.rootDir) return localProject.rootDir;
  return process.cwd();
}

export function assertLocalProjectCanBeSaved(localProject) {
  const metadata = localProject?.metadata;
  if (!metadata) return;
  const readOnlyKind = readOnlyProjectMetadataKind(metadata);
  if (readOnlyKind === "main") {
    const rootBuildId =
      Number(metadata.buildId || 0) || Number(metadata.build?.id || 0) || 0;
    throw new Error(
      `This is a read-only checkout of main${rootBuildId ? ` for Build ${rootBuildId}` : ""}. Make edits in your branch workspace (\`lumine pull${rootBuildId ? ` ${rootBuildId}` : ""}\`), and run \`lumine update-from-main\` there to bring main's changes into it.`,
    );
  }
  if (readOnlyKind === "version") {
    const checkoutBuildId =
      Number(metadata.buildId || 0) || Number(metadata.build?.id || 0) || 0;
    const checkoutVersion = Number(metadata.checkoutVersion || 0) || 0;
    throw new Error(
      `This is a read-only checkout of a previous save${checkoutVersion ? ` (v${checkoutVersion})` : ""}${checkoutBuildId ? ` for Build ${checkoutBuildId}` : ""}. To bring this save back, run \`lumine restore${checkoutVersion ? ` ${checkoutVersion}` : " <n>"}\` from the editable workspace, then \`lumine save\`.`,
    );
  }
  if (readOnlyKind === "reference") {
    const sourceBuildId =
      Number(metadata.reference?.sourceBuildId || 0) ||
      Number(metadata.buildId || 0) ||
      Number(metadata.build?.id || 0) ||
      0;
    throw new Error(
      `This is a read-only Lumine reference${sourceBuildId ? ` for Build ${sourceBuildId}` : ""}. Run \`lumine fork${sourceBuildId ? ` ${sourceBuildId}` : ""}\` to create an editable workspace.`,
    );
  }
  if (readOnlyKind === "server") {
    throw new Error(
      "This Lumine checkout is read-only for the current CLI login. Pull or diff it for review; project-owner branch edits must go through merge or replace-main.",
    );
  }
}

export function isReadOnlyReferenceMetadata(metadata) {
  return (
    metadata?.readOnly === true ||
    metadata?.reference?.readOnly === true ||
    metadata?.build?.role === "reference"
  );
}

export function isReadOnlyProjectMetadata(metadata) {
  return readOnlyProjectMetadataKind(metadata) !== null;
}

export function readOnlyProjectMetadataKind(metadata) {
  if (metadata?.mainCheckout === true) return "main";
  if (metadata?.versionCheckout === true) return "version";
  if (isReadOnlyReferenceMetadata(metadata)) return "reference";
  if (metadata?.build?.canWrite === false) return "server";
  return null;
}

export function resolveLocalProjectFilePath({ rootDir, projectPath }) {
  const relativePath = projectPathToRelativePath(projectPath);
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, relativePath);
  if (filePath !== root && filePath.startsWith(`${root}${path.sep}`)) {
    return filePath;
  }
  throw new Error(`Unsafe project file path: ${projectPath}`);
}

export function projectPathToRelativePath(projectPath) {
  const segments = String(projectPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe project file path: ${projectPath}`);
  }
  return path.join(...segments);
}
