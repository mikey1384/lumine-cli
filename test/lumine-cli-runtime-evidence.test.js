import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { adminCommand, parseAdminOperation } from "../lib/admin.js";
import { parseArgs } from "../lib/commands.js";

test("runtime evidence validates the host and bounded days without requiring a management run", async (t) => {
  for (const host of ["primary", "target"]) {
    const operation = parseAdminOperation(
      parseArgs(["admin", "runtime", "evidence", host]),
    );
    assert.equal(
      operation.path,
      `/cli/admin/runtime-logs/hosts/${host}/evidence?days=7`,
    );
    assert.equal(operation.mutates, false);
    assert.equal(operation.requiresRun, false);
  }
  for (const suffix of [
    [],
    ["wrong"],
    ["primary", "extra"],
    ["primary", "--days", "8"],
    ["primary", "--days", "0"],
  ]) {
    assert.throws(() =>
      parseAdminOperation(
        parseArgs(["admin", "runtime", "evidence", ...suffix]),
      ),
    );
  }
  const requests = [];
  let unavailable = false;
  let missingRoute = false;
  const canonical = {
    ok: true,
    status: "success",
    data: {
      host: { requested: "target" },
      evidence: { status: "stale", coverage: { samples: 3 } },
    },
  };
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      path: req.url,
      runId: req.headers["x-lumine-admin-run-id"],
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cli/session")
      res.end(JSON.stringify({ scopes: ["build:read"] }));
    else if (
      req.url === "/cli/admin/runtime-logs/hosts/target/evidence?days=2"
    ) {
      if (missingRoute) {
        res.statusCode = 404;
        res.end("Cannot GET evidence");
      } else if (unavailable) {
        res.statusCode = 503;
        res.end(
          JSON.stringify({
            error: {
              code: "CLI_ADMIN_RUNTIME_EVIDENCE_HOST_UNAVAILABLE",
              message: "No target binding",
            },
          }),
        );
      } else res.end(JSON.stringify(canonical));
    } else {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const options = {
    ...parseArgs([
      "admin",
      "runtime",
      "evidence",
      "target",
      "--days",
      "2",
      "--json",
    ]),
    authToken: "fixture-token",
    apiUrl: `http://127.0.0.1:${server.address().port}`,
  };
  const originalLog = console.log;
  try {
    console.log = () => {};
    assert.deepEqual(await adminCommand(options), canonical);
    unavailable = true;
    await assert.rejects(adminCommand(options), /No target binding/);
    missingRoute = true;
    await assert.rejects(adminCommand(options), (error) => {
      assert.equal(error.code, "CLI_ADMIN_RUNTIME_EVIDENCE_NOT_DEPLOYED");
      assert.equal(error.data.status, "unavailable");
      assert.match(error.message, /Evidence is unknown/);
      return true;
    });
  } finally {
    console.log = originalLog;
  }
  assert.ok(requests.every((req) => req.method === "GET" && !req.runId));
  assert.ok(
    requests.every(
      (req) =>
        req.path === "/cli/session" ||
        req.path.includes("/hosts/target/evidence"),
    ),
  );
});
