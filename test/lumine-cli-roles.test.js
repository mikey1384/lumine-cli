import assert from "node:assert/strict";
import test from "node:test";
import { parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";
import { formatRoles } from "../lib/admin-roles.js";

test("roles builds a read-only request that needs no daily run", () => {
  const plain = parseAdminOperation(parseArgs(["admin", "roles"]));
  assert.deepEqual(
    [plain.name, plain.method, plain.path, plain.mutates, plain.requiresRun],
    ["roles.read", "GET", "/cli/admin/roles", false, false],
  );
  const filtered = parseAdminOperation(
    parseArgs(["admin", "roles", "--min-level", "3", "--limit", "10"]),
  );
  assert.equal(filtered.path, "/cli/admin/roles?minLevel=3&limit=10");
  assert.throws(
    () => parseAdminOperation(parseArgs(["admin", "roles", "--min-level", "x"])),
    /--min-level/,
  );
});

test("roles prints each type, its holders and what was left out", () => {
  const text = formatRoles({
    adminLevel: 3,
    maxLevelFromAchievementPoints: 2,
    fromAchievementPoints: [
      { managementLevel: 1, fromAchievementLevel: 5, minAchievementPoints: 1000 },
      { managementLevel: 2, fromAchievementLevel: 6, minAchievementPoints: 1300 },
    ],
    minLevel: 3,
    types: [
      { label: "admin", managementLevel: 3, holders: 3, members: [
        { userId: 5, username: "mikey", realName: "Mikey", lastActive: 1791600000, isOwner: true },
      ] },
      { label: "headteacher", managementLevel: 1, holders: 12 },
    ],
  });
  assert.match(text, /level 3\+/);
  assert.match(text, /points never pass level 2/);
  assert.match(text, /admin: level 3, 3 holders/);
  assert.match(text, /#5 mikey \(Mikey\) \[owner\]/);
  assert.match(text, /2 more \(raise --limit\)/);
  assert.match(text, /headteacher: level 1, 12 holders/);
});
