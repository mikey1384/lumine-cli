import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_AUTH_FILE,
  PROJECT_METADATA_DIR,
  PROJECT_METADATA_FILE,
} from "./constants.js";

// Recovery keys, leases and evidence survive OS temp cleanup. Explicit output
// directories, checkpoints and review-session paths still take priority.
//
// The home is work/lumine-admin in the invocation directory (the Twinkle
// repository root for the daily run), unless that directory is inside an
// app's Lumine project workspace (a folder with .twinkle/lumine-project.json
// here or above). Then it is the CLI's own state folder (~/.twinkle, beside
// the default login file), so admin intents and receipts never sit among the
// app's files: on 11-09 `lumine save` uploaded 33 admin receipts into #363
// v230. `lumine save` also skips a work/lumine-admin folder an older CLI left.
export function adminWorkDirectory({ cwd = process.cwd() } = {}) {
  const directory = findProjectWorkspaceRoot(cwd)
    ? path.join(path.dirname(DEFAULT_AUTH_FILE), "lumine-admin")
    : path.resolve(cwd, "work", "lumine-admin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function findProjectWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(
        path.join(current, PROJECT_METADATA_DIR, PROJECT_METADATA_FILE),
      )
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
