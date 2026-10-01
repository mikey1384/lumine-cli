import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { adminWorkDirectory } from "./admin-work-directory.js";
import { readAdminJsonFile, writeAdminJsonFile } from "./admin-news.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

// Persist before sending. A killed process or missing HTTP receipt reuses the
// same request key in the same API/account/run/session and exact operation.
// Only a canonical receipt closes it; there is no automatic write retry.
export function prepareAdminMutationIntent({
  operation,
  apiUrl,
  authority,
  idempotencyKey,
  directory = path.join(adminWorkDirectory(), "requests"),
}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const fingerprint = digest(
    JSON.stringify({
      apiUrl: String(apiUrl).replace(/\/$/, ""),
      authority,
      method: operation.method,
      path: operation.path,
      body: operation.body,
    }),
  );
  const suffix = idempotencyKey ? `-${digest(idempotencyKey)}` : "";
  const file = path.join(directory, `${fingerprint}${suffix}.pending.json`);
  let intent;
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      intent = {
        kind: "lumine-admin-mutation-intent",
        fingerprint,
        operation: operation.name,
        requestId: idempotencyKey || `cli:${randomUUID()}`,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(fd, JSON.stringify(intent));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    intent = readAdminJsonFile(file, "the pending mutation intent");
    if (
      intent.kind !== "lumine-admin-mutation-intent" ||
      intent.fingerprint !== fingerprint ||
      !/^[A-Za-z0-9._:-]{8,80}$/.test(intent.requestId || "")
    ) {
      throw new Error(
        `The pending mutation intent is unconfirmed: ${file}. Inspect its original request key before retrying.`,
      );
    }
  }
  const receiptPath = path.join(
    directory,
    `${digest(intent.requestId)}.receipt.json`,
  );
  return {
    requestId: intent.requestId,
    confirm(receipt) {
      if (receipt?.ok !== true || typeof receipt.status !== "string") {
        const error = new Error(
          "The API did not return a canonical admin receipt. The mutation outcome is unconfirmed.",
        );
        error.code = "CLI_ADMIN_RECEIPT_INVALID";
        throw error;
      }
      writeAdminJsonFile(receiptPath, receipt, { privateFile: true });
    },
    delivered() {
      fs.rmSync(file, { force: true });
    },
    file,
    receiptPath,
  };
}
