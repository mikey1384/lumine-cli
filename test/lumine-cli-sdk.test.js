import assert from "node:assert/strict";
import test from "node:test";
import {
  SDK_CLI_READ_SCOPES,
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

test("CLI exposes canonical Lumine media and live diagnostics", () => {
  assert.deepEqual(SDK_CLI_METHODS["media.getUsage"], {
    path: "api/media/usage",
    scopes: ["media:read"],
    sdkReshape: "the SDK returns the mediaEnergy object directly",
  });
  assert.deepEqual(SDK_CLI_METHODS["live.list"], {
    path: "api/live/list",
    scopes: ["live:read"],
    sdkReshape: "the SDK returns the sessions array directly",
  });
  assert.deepEqual(SDK_CLI_METHODS["live.stop"], {
    path: "api/live/stop",
    scopes: ["live:write"],
    write: true,
  });
  assert.equal(SDK_CLI_READ_SCOPES.includes("media:read"), true);
  assert.equal(SDK_CLI_READ_SCOPES.includes("live:read"), true);
  assert.deepEqual(SDK_CLI_METHOD_NAMES_BY_PATH.get("api/live/list"), [
    "live.list",
  ]);
});
