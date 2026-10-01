import fs from "node:fs";
import path from "node:path";

// Recovery keys, leases and evidence survive OS temp cleanup. Explicit output
// directories, checkpoints and review-session paths still take priority.
export function adminWorkDirectory() {
  const directory = path.resolve(process.cwd(), "work", "lumine-admin");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}
