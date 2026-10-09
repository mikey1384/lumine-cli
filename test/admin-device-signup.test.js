import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";

const args = [
  "admin",
  "ai-bucket",
  "device",
  "block-signup",
  "--bucket-id",
  "4",
  "--user",
  "18559",
  "--device-key",
  "173c398372daba62",
  "--user-ids",
  "18559",
  "--note",
  "Mikey approved this exact device",
];

test("signup device action sends the exact reviewed fingerprint and accounts", () => {
  const op = parseAdminOperation(parseArgs(args));
  assert.equal(op.method, "POST");
  assert.equal(op.path, "/cli/admin/ai-buckets/4/signup-devices");
  assert.deepEqual(op.body, {
    sourceUserId: 18559,
    deviceKey: "173c398372daba62",
    expectedUserIds: [18559],
    note: "Mikey approved this exact device",
  });
  assert.equal(op.name, "ai-bucket.device.signup.block");
});

for (const flag of [
  "--bucket-id",
  "--user",
  "--device-key",
  "--user-ids",
  "--note",
]) {
  test(`signup block refuses missing ${flag}`, () => {
    const trimmed = [...args];
    trimmed.splice(trimmed.indexOf(flag), 2);
    assert.throws(() => parseAdminOperation(parseArgs(trimmed)));
  });
}
