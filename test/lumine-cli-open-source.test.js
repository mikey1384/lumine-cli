import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliSource = fs.readFileSync(
  path.resolve(__dirname, "../bin/lumine.js"),
  "utf8",
);

test("CLI exposes open-source explore, reference, and fork commands", () => {
  assert.match(cliSource, /"explore"/);
  assert.match(cliSource, /"reference"/);
  assert.match(cliSource, /"fork"/);
  assert.match(cliSource, /async function explore\(options\)/);
  assert.match(cliSource, /async function reference\(options\)/);
  assert.match(cliSource, /async function fork\(options\)/);
  assert.match(cliSource, /\/cli\/open-source-builds/);
  assert.match(cliSource, /\/cli\/build\/\$\{buildId\}\/open-source-files/);
  assert.match(cliSource, /\/build\/\$\{buildId\}\/fork/);
});

test("CLI resolves Build branch URLs and exposes owner review commands", () => {
  assert.match(cliSource, /"diff"/);
  assert.match(cliSource, /"merge"/);
  assert.match(cliSource, /"replace-main"/);
  assert.match(cliSource, /async function diff\(options\)/);
  assert.match(cliSource, /async function mergeBranch\(options\)/);
  assert.match(cliSource, /async function replaceMainWithBranch\(options\)/);
  assert.match(cliSource, /function resolveBuildReference\(value\)/);
  assert.match(cliSource, /branchNumber: Number\(parts\[buildIndex \+ 2\]\) \|\| 0/);
  assert.match(cliSource, /\/cli\/build\/\$\{rootBuildId\}\/branches\/\$\{branchNumber\}/);
  assert.match(cliSource, /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}/);
  assert.match(cliSource, /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}\/merge/);
  assert.match(cliSource, /\/build\/\$\{rootBuildId\}\/contributions\/\$\{contributionBuildId\}\/replace-main/);
});

test("CLI blocks saves from read-only branch checkouts", () => {
  assert.match(cliSource, /metadata\.build\?\.canWrite === false/);
  assert.match(cliSource, /This Lumine checkout is read-only/);
  assert.match(cliSource, /build\?\.canWrite === false/);
  assert.match(cliSource, /Review changes: lumine diff/);
  assert.match(cliSource, /Owner actions: lumine merge, or lumine replace-main/);
});

test("CLI references are marked read-only and blocked from save", () => {
  assert.match(cliSource, /LUMINE_REFERENCE_INSTRUCTIONS_MARKER/);
  assert.match(cliSource, /async function writeReferenceMetadata/);
  assert.match(cliSource, /readOnly: true[\s\S]*role: "reference"[\s\S]*canWrite: false[\s\S]*canPublish: false/);
  assert.match(cliSource, /assertLocalProjectCanBeSaved\(localProject\)/);
  assert.match(cliSource, /metadata\?\.reference\?\.readOnly === true/);
  assert.match(cliSource, /lumine fork/);
});

test("CLI explore supports search and fork-oriented sorting", () => {
  assert.match(cliSource, /searchQuery:[\s\S]*command === "explore"/);
  assert.match(cliSource, /function normalizeOpenSourceSort\(value\)/);
  assert.match(cliSource, /return "forks"/);
  assert.match(cliSource, /url\.searchParams\.set\("sort", options\.sort\)/);
  assert.match(cliSource, /url\.searchParams\.set\("search", options\.searchQuery\)/);
});

test("CLI records npm version update state for agents", () => {
  assert.match(cliSource, /PACKAGE_METADATA_URL/);
  assert.match(cliSource, /maybeCheckForLumineCliUpdate/);
  assert.match(cliSource, /loadLatestPackageVersion/);
  assert.match(cliSource, /isNewerVersion/);
  assert.match(cliSource, /lumineCli: serializeLumineCliMetadata\(options\)/);
  assert.match(cliSource, /updateAvailable: Boolean\(info\.updateAvailable\)/);
  assert.match(cliSource, /--no-update-check/);
  assert.match(cliSource, /npx \$\{packageName\}@latest/);
});
