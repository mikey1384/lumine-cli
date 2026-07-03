import os from "os";
import path from "path";

export const DEFAULT_API_URL = "https://api.twinkle.network";
export const DEFAULT_SITE_URL = "https://www.twin-kle.com";
export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const DEFAULT_AUTH_FILE = path.join(
  os.homedir(),
  ".twinkle",
  "lumine-cli-auth.json",
);
export const DEFAULT_TIMEOUT_MS = 20000;
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
export const DEFAULT_PROJECT_LIMIT = 50;
export const PROJECT_METADATA_DIR = ".twinkle";
export const PROJECT_METADATA_FILE = "lumine-project.json";
export const ASSETS_METADATA_FILE = "assets.json";
// Must match the web workspace's 5MB part size: the server presigns one S3
// part URL per 5MB of the declared fileSize.
export const ASSET_UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
// Mirrors the web workspace's asset accept list (images + audio). The server
// only rejects video, but the platform's asset policy is image/audio.
export const ASSET_MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
};
// Mirrors the platform's project-file limits. File count and effective-line
// limits are hardcoded server constants; the total-byte limit is
// env-overridable server-side, so the CLI only warns on it.
export const PROJECT_MAX_FILES = 100;
export const PROJECT_MAX_EFFECTIVE_FILE_LINES = 500;
export const PROJECT_EFFECTIVE_LINE_MAX_COLUMNS = 160;
export const PROJECT_MAX_TOTAL_BYTES_DEFAULT = 300 * 1024;
// Matches asset references in project files: absolute CloudFront URLs and
// relative /attachments/build-runtime|optimized/... paths.
export const RUNTIME_ASSET_REFERENCE_PATTERN =
  /(?:https?:\/\/[^\s"'`)\\]+)?\/attachments\/(?:build-runtime|optimized)\/[^\s"'`)\\]+/g;
export const DEFAULT_SAVE_SUMMARY = "Saved from Lumine CLI.";
export const EXCLUDED_UPLOAD_DIRS = new Set([".git", ".twinkle", "node_modules"]);
export const SDK_REFERENCE_FILE = "TWINKLE_BUILD_SDK.md";
export const EXCLUDED_UPLOAD_FILES = new Set([
  ".DS_Store",
  "AGENTS.md",
  "CLAUDE.md",
  SDK_REFERENCE_FILE,
]);
export const LUMINE_AGENT_INSTRUCTIONS_MARKER =
  "<!-- Lumine CLI Agent Instructions -->";
export const LUMINE_SDK_REFERENCE_MARKER = "<!-- Lumine CLI SDK Reference -->";
export const LUMINE_REFERENCE_INSTRUCTIONS_MARKER =
  "<!-- Lumine CLI Reference Instructions -->";
export const LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER =
  "<!-- Lumine CLI Main Checkout Instructions -->";
export const BUNDLED_SDK_REFERENCE_URL = new URL(
  "../sdk/BUILD_SDK_INDEX.md",
  import.meta.url,
);
export const PACKAGE_METADATA_URL = new URL("../package.json", import.meta.url);
export const SDK_REFERENCE_FALLBACK = `${LUMINE_SDK_REFERENCE_MARKER}
# Twinkle Build SDK Reference

The bundled SDK reference could not be loaded from this Lumine CLI package.

Use these current source-of-truth rules:

- Read .twinkle/lumine-project.json before editing.
- Use Twinkle.capabilities.get() or Twinkle.capabilities.can(actionName) before relying on gated SDK calls.
- Use Twinkle.privateDb for simple private per-user preferences, drafts, settings, and small JSON state.
- Use Twinkle.userDb only for advanced private SQLite tables, indexes, many rows, filtered queries, or aggregates.
- Use Twinkle.sharedDb for shared multi-user JSON data.
- Use Twinkle.aiCards.list/search/get for existing public AI Card words, exampleText sentence material, and word levels.
- Use Twinkle.aiStories.list/search/get for existing AI Story passage text, story media, and questions.
- Use Twinkle.ai.chat with history entries shaped as { role, content }, not { text }.
- Use Twinkle.preview for canvas, WebGL, Three.js, fullscreen, and game layout.
- Prefer existing documented Twinkle.* methods over guessing names from old code.
`;
export const LUMINE_AGENT_INSTRUCTIONS = `${LUMINE_AGENT_INSTRUCTIONS_MARKER}
# Lumine Project Agent Guide

This directory contains Twinkle Build project files pulled by Lumine CLI. Use
Lumine CLI as the source of truth for saving this workspace back to Twinkle.

## Source Of Truth

- Read .twinkle/lumine-project.json before changing files.
- Treat build.canWrite, build.canPublish, and build.contributionRootBuildId as authoritative.
- If lumineCli.updateAvailable is true, ask the user to rerun with npx @stage5/lumine@latest before saving.
- Read ${SDK_REFERENCE_FILE} before adding, removing, or changing any Twinkle.* SDK calls.
- If build.canWrite is false, do not save changes.
- If build.canPublish is false or contributionRootBuildId is set, this checkout is a contribution branch. Save only to this branch and do not run lumine launch or lumine save --publish.
- On a contribution branch, main may have moved since the branch was created. Before starting large edits, run \`lumine update-from-main\` to three-way-merge main into the branch (resolve any <<<<<<< conflict markers it reports, then save). \`lumine pull --main\` gives a read-only checkout of main for comparison (created alongside your workspace, never inside it).
- Do not edit another local checkout to bypass branch rules.

## Workflow

- Edit only project files in this workspace.
- Keep /index.html or /index.htm as the entry file.
- Run lumine save from this folder after edits, with a short summary:

\`\`\`bash
lumine save --summary "Describe the change"
\`\`\`

- Run lumine check before launch when possible.
- Use \`lumine sdk call <namespace.method> '{...}'\` to inspect real endpoint
  data and measure latency (add --repeat <n>); \`lumine sdk list\` shows
  callable methods. It prints the raw HTTP endpoint response, which can differ
  from a method's Twinkle.* SDK return shape (some wrappers unwrap or rename
  fields) — use ${SDK_REFERENCE_FILE} for SDK return shapes. Write methods
  need --allow-write and mutate real app data.
- Owned canonical builds may be published only when the user explicitly asks.

## Assets (Images & Audio)

- Binary files are NOT project files. Never place images or audio in this
  workspace — lumine save rejects binaries. Assets live in Twinkle's asset
  storage and are referenced from code by absolute URL.
- .twinkle/${ASSETS_METADATA_FILE} lists this build's uploaded assets (the current
  CLI user's uploads) with their URLs. Reference an asset by its \`url\` value.
- \`lumine assets upload <file...>\` uploads images/audio from disk and prints
  the URL to use in code. \`lumine assets list\` prints assets and refreshes
  .twinkle/${ASSETS_METADATA_FILE}; \`lumine assets delete <assetId>\` removes one;
  \`lumine assets prune\` deletes your uploads that nothing references (server
  checks draft files, published/version snapshots, and derived builds; local
  unsaved edits are scanned too). The server enforces storage quotas.
- CAUTION: asset URLs an app stores in privateDb/sharedDb/user DBs at runtime
  (Twinkle.files uploads) are invisible to prune. Never run \`assets prune\` on
  a build whose app stores uploaded-file URLs in app data.
- On team projects the manifest also lists \`projectAssets\` (the project
  owner's uploads) and \`unmatchedReferences\` (asset URLs in code matching no
  known asset). Reuse existing asset URLs — do NOT re-upload media the
  project already has.
- Uploading a file with an existing name creates a NEW asset and URL; it never
  replaces. Update code references, then delete or prune the old asset.
- Prefer one small assets module (e.g. src/assets.js) mapping names to asset
  URLs over scattering URLs through the code.

## Project File Limits

- Max ${PROJECT_MAX_FILES} files per project; each file max ${PROJECT_MAX_EFFECTIVE_FILE_LINES} effective lines
  (a physical line counts once per ${PROJECT_EFFECTIVE_LINE_MAX_COLUMNS} characters, so minified one-liners
  blow the limit). Default total project size ~${Math.floor(PROJECT_MAX_TOTAL_BYTES_DEFAULT / 1024)} KB.
- Plan file splits BEFORE writing code; \`lumine check\` validates the local
  workspace against these limits without saving, and \`lumine save\` fails fast
  locally listing every violation.
- Files must be UTF-8 text. UTF-16 files are rejected with a re-encode hint.

## App Constraints

- Use local project files with relative or root-local imports only. Do not add package imports, CDN scripts, external network calls, or app-local /api/* routes.
- Build apps run in sandboxed iframes without allow-forms. Do not use <form> elements, native form submission, requestSubmit(), or browser form navigation. Build input flows with JavaScript-handled inputs and buttons instead.
- CAUTION: the preview runtime AUTO-DETECTS "game apps" — any <canvas> in the body (even a decorative background canvas) or game-y words in visible text switch the app to viewport-app mode: html/body get overflow:hidden !important and body becomes a centering flexbox, so tall document-flow pages clip and stop scrolling. Document-style apps that use a canvas must call Twinkle.preview.subscribe (or getLayout/reserveInsets) early at boot — any of those opts out of auto game mode — then pad by layout.safeInsets and scroll within layout.viewport.height.
- For canvas, WebGL, Three.js, fullscreen, or game builds, use Twinkle.preview for layout. Do not size roots from 100vh, 100vw, 100dvh, 100dvw, window.innerWidth, window.innerHeight, visualViewport, or document viewport dimensions.
- For Three.js, use import * as THREE from '/build/vendor/three/0.184.0/three.module.min.js';. Addons (OrbitControls, GLTFLoader, ...) live under /build/vendor/three/0.184.0/addons/, e.g. import { OrbitControls } from '/build/vendor/three/0.184.0/addons/controls/OrbitControls.js';. Builds saved with the older /build/vendor/three/0.160.0/ path keep working.
- Do not invent or guess Twinkle.* SDK method names. Use ${SDK_REFERENCE_FILE} as the local SDK reference and prefer Twinkle.capabilities checks for gated features.
- Match storage to update frequency. Twinkle.privateDb and Twinkle.sharedDb are for LOW-frequency durable state only — things that change on a user action (settings, inventory checkpoints, completed quests, saved progress; comments, votes, room settings, submitted records). NEVER write high-frequency or per-frame/per-tick state to them (camera or cursor position, animation state, live movement, presence, autosave every frame/tick). Keep live state in client memory, broadcast realtime/presence via Twinkle.world, and for durable per-user state flush an occasional snapshot on an interval or on exit (never per frame) — e.g. the viewer/user DB or a single latest-snapshot key. The server rate-limits these writes per key and returns 429 on excess; never retry-loop a 429.

## Local Testing (Playwright / browser probes)

- Serve the workspace with a tiny local HTTP server and drive it with Playwright. NEVER copy probe/vendor files into the workspace dir — lumine save uploads everything here (and binary files fail validation). Build a sibling probe dir that symlinks the workspace files instead.
- Vendored imports like /build/vendor/three/0.184.0/... are absolute paths: mirror that directory under your probe dir's root and fetch the files from the LIVE SITE (e.g. https://www.twin-kle.com/build/vendor/three/0.184.0/three.webgpu.min.js). three 0.184 splits into three.module.min.js + three.core.min.js — mirror BOTH or imports fail. Do NOT use npm/CDN copies — the platform's vendored builds have rewritten import specifiers (npm three.tsl.min.js still imports bare "three/webgpu" and breaks the module graph).
- The three WebGPU renderer falls back to WebGL2 in headless Chromium automatically. Headless software rendering runs at ~2-5fps, so anything time-based (walking a character, timers) takes ~10-20x longer than real time — loop with generous waits instead of fixed short sleeps, and bump navigation timeouts.
- To inspect module-scope game state, append debug getters when SERVING main.js (e.g. body += "window.__dbg = () => ({...})") rather than editing workspace files.
- SDK calls are absent when serving locally; well-written builds optional-chain window.Twinkle and fall back to localStorage. Seed localStorage in the probe to fake saves.

## Completion Report

Report the changed files, any SDK methods used, the lumine save result, the
build or branch id, and whether the result is published or unpublished changes.
`;
export const LUMINE_REFERENCE_INSTRUCTIONS = `${LUMINE_REFERENCE_INSTRUCTIONS_MARKER}
# Lumine Reference Guide

This directory contains read-only reference files pulled from a public
open-source Twinkle Build. Use it for inspection and borrowing patterns, not as
the workspace to save.

## Source Of Truth

- Read .twinkle/lumine-project.json before using these files.
- If lumineCli.updateAvailable is true, ask the user to rerun with npx @stage5/lumine@latest before borrowing patterns.
- If metadata.readOnly is true or build.role is "reference", do not run lumine save from this directory.
- To start from this Build, run lumine fork with the source build id and edit the forked workspace.
- Do not edit another local checkout to bypass reference read-only semantics.
`;
export const LUMINE_MAIN_CHECKOUT_INSTRUCTIONS = `${LUMINE_MAIN_CHECKOUT_INSTRUCTIONS_MARKER}
# Lumine Main Checkout (Read-Only)

This directory is a read-only snapshot of a team project's MAIN workspace,
pulled with \`lumine pull --main\`. Use it to inspect what main currently looks
like; it is not the workspace to edit or save.

## Source Of Truth

- Read .twinkle/lumine-project.json before using these files.
- metadata.mainCheckout is true here: do not run lumine save from this directory.
- Make changes in your contribution-branch workspace (lumine pull <buildId>).
- Bring main's latest changes into your branch with lumine update-from-main.
- Do not edit another local checkout to bypass read-only semantics.
`;
export const AGENT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
// Commands allowed to resolve a read-only `pull --main` checkout's build id.
// Everything else (launch/save/merge/…) mutates and must not run from one.
export const MAIN_CHECKOUT_READONLY_COMMANDS = new Set([
  "pull",
  "check",
  "diff",
  "sdk",
  "select",
  "workspace",
  // assets never touch main's project files (uploads go to the current
  // user's own asset space), so listing/uploading from a main checkout is safe.
  "assets",
]);
export const COMMANDS = new Set([
  "workspace",
  "login",
  "logout",
  "whoami",
  "new",
  "projects",
  "explore",
  "select",
  "pull",
  "reference",
  "fork",
  "diff",
  "merge",
  "replace-main",
  "update-from-main",
  "save",
  "push",
  "check",
  "launch",
  "sdk",
  "assets",
  "help",
]);
