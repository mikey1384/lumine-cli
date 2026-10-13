// The builder stance (how agents that build through Lumine CLI serve the
// creator) is canonical in CORE_VALUES.md, section "For building agents", at
// the Twinkle workspace root. This package ships a generated copy in
// lib/builderStance.generated.js; never edit that by hand. Run:
//   node scripts/generate-builder-stance.mjs [path/to/CORE_VALUES.md]
// test/builderStanceSync.test.js fails when the copy is stale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECTION = "For building agents";
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function findCoreValuesFile(start = path.join(HERE, "..")) {
  const fromEnv = process.env.TWINKLE_CORE_VALUES_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "CORE_VALUES.md");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function extractBuilderStance(markdown) {
  const section = markdown
    .split(/\n(?=## )/)
    .find((part) => part.startsWith(`## ${SECTION}\n`));
  if (!section) throw new Error(`CORE_VALUES.md is missing "## ${SECTION}"`);
  const text = section
    .slice(`## ${SECTION}\n`.length)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error(`"## ${SECTION}" has no text for the agents`);
  return text;
}

export function buildBuilderStanceModule(markdown) {
  return `// GENERATED from CORE_VALUES.md ("For building agents") by
// scripts/generate-builder-stance.mjs. Do not edit by hand.
export const LUMINE_BUILDER_STANCE = ${JSON.stringify(extractBuilderStance(markdown))};
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] || findCoreValuesFile();
  if (!source) {
    console.error("CORE_VALUES.md not found (pass its path)");
    process.exit(1);
  }
  const out = path.join(HERE, "..", "lib", "builderStance.generated.js");
  fs.writeFileSync(out, buildBuilderStanceModule(fs.readFileSync(source, "utf8")));
  console.log(`Wrote lib/builderStance.generated.js from ${source}`);
}
