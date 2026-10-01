import fs from "node:fs";
import { fileURLToPath } from "node:url";

export function testWorkRoot() {
  const root = fileURLToPath(
    new URL("../../../work/lumine-cli-test-fixtures/", import.meta.url),
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
