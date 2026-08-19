import assert from "node:assert/strict";
import test from "node:test";
import {
  SDK_CLI_METHOD_NAMES_BY_PATH,
  SDK_CLI_METHODS,
} from "../lib/sdk.js";

test("CLI exposes protected sharedDb batch methods with fail-closed scopes", () => {
  assert.deepEqual(SDK_CLI_METHODS["sharedDb.getEntriesByIds"], {
    path: "api/shared-db/entries/by-ids",
    scopes: ["sharedDb:read"],
  });
  assert.deepEqual(SDK_CLI_METHODS["sharedDb.addEntries"], {
    path: "api/shared-db/entries/batch",
    scopes: ["sharedDb:write"],
    write: true,
  });
  assert.deepEqual(SDK_CLI_METHODS["sharedDb.deleteEntries"], {
    path: "api/shared-db/entries/delete",
    scopes: ["sharedDb:write"],
    write: true,
  });

  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/shared-db/entries/by-ids"),
    ["sharedDb.getEntriesByIds"],
  );
  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/shared-db/entries/batch"),
    ["sharedDb.addEntries"],
  );
  assert.deepEqual(
    SDK_CLI_METHOD_NAMES_BY_PATH.get("api/shared-db/entries/delete"),
    ["sharedDb.deleteEntries"],
  );
});
