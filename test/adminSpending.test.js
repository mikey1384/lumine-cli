import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { testWorkRoot } from "./helpers/work-directory.js";
import { parseArgs } from "../lib/commands.js";
import { parseAdminOperation } from "../lib/admin.js";
import {
  completeSpendingReport,
  formatSpending,
  normalizeAwsSpending,
} from "../lib/admin-spending.js";

function fixture() {
  const months = ["2026-08", "2026-09", "2026-10"].map((key, i) => ({
    monthKey: key,
    status: i === 2 ? "in_progress" : "closed",
    startDayKey: `${key}-01`,
    endDayKeyExclusive: ["2026-09-01", "2026-10-01", "2026-10-22"][i],
    throughDayKey: ["2026-08-31", "2026-09-30", "2026-10-21"][i],
    ai: {
      grossUsd: 100,
      creditUsd: i === 2 ? 20 : 0,
      estimatedCashUsd: i === 2 ? 80 : 100,
    },
    reimbursements: {
      aiServiceUsd: 500,
      infrastructureUsd: i ? 500 : 0,
      totalUsd: i ? 1000 : 500,
      items: [],
    },
  }));
  return {
    ok: true,
    status: "success",
    data: {
      spending: {
        schemaVersion: 1,
        generatedAt: Date.parse("2026-10-22T03:00:00Z") / 1000,
        currency: "USD",
        timezone: "UTC",
        months,
        range: {
          startDayKey: "2026-08-01",
          endDayKeyExclusive: "2026-10-22",
          includesInProgressDay: false,
        },
        sources: {
          aws: {
            accountId: "test-account",
            principalArn: "test-principal",
            defaultProfile: "test-profile",
            region: "us-east-1",
          },
        },
        warnings: [],
        inProgressDay: {
          dayKey: "2026-10-22",
          ai: { grossUsd: 4 },
          excludedFromTotals: true,
        },
      },
    },
  };
}
const metric = (amount) => ({ Amount: String(amount), Unit: "USD" });
function page(months, service = "Database", usd = 50) {
  return {
    ResultsByTime: months
      .filter((m) => m.startDayKey < m.endDayKeyExclusive)
      .map((m) => ({
        TimePeriod: { Start: m.startDayKey, End: m.endDayKeyExclusive },
        Estimated: m.status === "in_progress",
        Groups: [{ Keys: [service], Metrics: { UnblendedCost: metric(usd) } }],
      })),
  };
}

test("spending parses calendar flags as a run-independent read and rejects unsupported or ambiguous options", () => {
  const operation = parseAdminOperation(
    parseArgs([
      "admin",
      "spending",
      "--from",
      "2026-08",
      "--to",
      "2026-10",
      "--aws-profile",
      "billing",
    ]),
  );
  assert.equal(operation.path, "/cli/admin/spending?from=2026-08&to=2026-10");
  assert.equal(operation.mutates, false);
  assert.equal(operation.requiresRun, false);
  for (const flags of [
    ["--from", "2026-08"],
    ["--month", "2026-13"],
    ["--month", ""],
    ["--days", "30"],
    ["--month", "2026-08", "--to", "2026-10"],
    ["--from", "2026-10", "--to", "2026-08"],
    ["--all"],
  ]) {
    assert.throws(() =>
      parseAdminOperation(parseArgs(["admin", "spending", ...flags])),
    );
  }
});

test("one command paginates AWS services, includes tax and credits once, and totals reimbursements separately", async () => {
  const source = fixture();
  const calls = [];
  const result = await completeSpendingReport(
    source,
    {},
    async (args, settings) => {
      calls.push({ args, settings });
      if (args[0] === "sts")
        return { Account: "test-account", Arn: "test-principal" };
      return args.includes("--next-page-token")
        ? page(source.data.spending.months, "Tax", 5)
        : { ...page(source.data.spending.months), NextPageToken: "next" };
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1].args.includes("Start=2026-08-01,End=2026-10-22"), true);
  assert.equal(calls[1].settings.profile, "test-profile");
  assert.equal(calls[2].args.at(-1), "next");
  const report = result.data.spending;
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.months.map((m) => m.totalIncludingReimbursementsUsd),
    [655, 1155, 1135],
  );
  assert.equal(report.totals.totalIncludingReimbursementsUsd, 2945);
  assert.match(formatSpending(report), /Reimbursement: infrastructure/);
  assert.match(formatSpending(report), /through 2026-10-21 UTC/);
  assert.match(formatSpending(report), /\$2,945.00/);
  assert.match(formatSpending(report), /partial AI usage.*excluded/);
});

test("wrong AWS identity stops before billing; unavailable cost never becomes a zero or a combined total", async () => {
  let calls = 0;
  const result = await completeSpendingReport(fixture(), {}, async () => {
    calls++;
    return { Account: "another-account" };
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.data.spending.months[0].aws, null);
  assert.equal(
    result.data.spending.totals.totalIncludingReimbursementsUsd,
    null,
  );
  assert.equal(result.data.spending.totals.aiEstimatedCashUsd, 280);
  assert.match(formatSpending(result.data.spending), /Unavailable/);
});

test("missing payment history preserves AI and AWS but withholds the combined total", async () => {
  const source = fixture();
  source.data.spending.months[1].reimbursements = null;
  const result = await completeSpendingReport(source, {}, async (args) =>
    args[0] === "sts"
      ? { Account: "test-account", Arn: "test-principal" }
      : page(source.data.spending.months),
  );
  assert.equal(result.data.spending.months[1].providerOperatingCostUsd, 150);
  assert.equal(
    result.data.spending.months[1].totalIncludingReimbursementsUsd,
    null,
  );
  assert.equal(result.data.spending.complete, false);
});

test("missing paid amounts and shortened closed months cannot produce a successful understated report", async () => {
  for (const change of [
    (report) => {
      report.months[0].reimbursements.totalUsd = null;
    },
    (report) => {
      delete report.months[0].reimbursements.aiServiceUsd;
    },
    (report) => {
      report.months[0].endDayKeyExclusive = "2026-08-20";
    },
    (report) => {
      report.months = [report.months[0]];
      report.months[0].endDayKeyExclusive = report.range.endDayKeyExclusive =
        "2026-08-20";
    },
  ]) {
    const source = fixture();
    change(source.data.spending);
    let awsCalls = 0;
    await assert.rejects(
      completeSpendingReport(source, {}, async () => {
        awsCalls++;
      }),
      /incomplete source amounts|invalid month boundaries/,
    );
    assert.equal(awsCalls, 0);
  }
});

test("AWS rejects missing months, currency mismatches, duplicate services and expanded date ranges", () => {
  const months = fixture().data.spending.months;
  assert.throws(
    () => normalizeAwsSpending([page(months.slice(1))], months),
    /missing/,
  );
  const foreign = page(months);
  foreign.ResultsByTime[0].Groups[0].Metrics.UnblendedCost.Unit = "EUR";
  assert.throws(() => normalizeAwsSpending([foreign], months), /currency/);
  assert.throws(
    () => normalizeAwsSpending([page(months), page(months)], months),
    /Duplicate/,
  );
  const expanded = page(months);
  expanded.ResultsByTime[2].TimePeriod.End = "2026-11-01";
  assert.throws(() => normalizeAwsSpending([expanded], months), /UTC months/);
});

test("negative AWS credits reduce the account total and first-of-month reports make no empty AWS request", async () => {
  const months = fixture().data.spending.months;
  assert.equal(
    normalizeAwsSpending([page(months), page(months, "Credit", -10)], months)[0]
      .costUsd,
    40,
  );
  const source = fixture();
  source.data.spending.range.startDayKey =
    source.data.spending.range.endDayKeyExclusive = "2026-10-01";
  source.data.spending.months = [
    {
      ...months[2],
      startDayKey: "2026-10-01",
      endDayKeyExclusive: "2026-10-01",
      throughDayKey: null,
      ai: { grossUsd: 0, creditUsd: 0, estimatedCashUsd: 0 },
      reimbursements: { totalUsd: 0, aiServiceUsd: 0, infrastructureUsd: 0 },
    },
  ];
  const result = await completeSpendingReport(source, {}, async () => {
    throw new Error("must not query AWS");
  });
  assert.equal(result.data.spending.complete, true);
  assert.equal(result.data.spending.totals.totalIncludingReimbursementsUsd, 0);
});

test("AWS-billed AI is not counted twice", async () => {
  const source = fixture();
  source.data.spending.months[0].ai.awsOverlapDetected = true;
  const result = await completeSpendingReport(source, {}, async (args) =>
    args[0] === "sts"
      ? { Account: "test-account", Arn: "test-principal" }
      : page(source.data.spending.months),
  );
  assert.equal(
    result.data.spending.months[0].totalIncludingReimbursementsUsd,
    null,
  );
  assert.match(result.data.spending.warnings.join(" "), /overlap/);
});

test("a payment settled today appears immediately, including on the first UTC day before any usage is complete", async () => {
  const source = fixture();
  const report = source.data.spending;
  report.range.startDayKey = report.range.endDayKeyExclusive = "2026-10-01";
  report.months = [
    {
      ...report.months[2],
      startDayKey: "2026-10-01",
      endDayKeyExclusive: "2026-10-01",
      throughDayKey: null,
      ai: { grossUsd: 0, creditUsd: 0, estimatedCashUsd: 0 },
      reimbursements: {
        totalUsd: 500,
        aiServiceUsd: 0,
        infrastructureUsd: 500,
      },
    },
  ];
  report.sources.reimbursements = {
    includesCurrentDay: true,
    endAtExclusive: Date.parse("2026-10-01T05:00:00Z") / 1000 + 1,
  };
  const result = await completeSpendingReport(source, {}, async () => {
    throw new Error("No completed AWS usage to query");
  });
  assert.equal(result.data.spending.complete, true);
  assert.equal(
    result.data.spending.totals.totalIncludingReimbursementsUsd,
    500,
  );
  const table = formatSpending(result.data.spending);
  assert.match(table, /AI\/AWS: no completed UTC days/);
  assert.match(
    table,
    /Reimbursements include today's settled payments through 2026-10-01T05:00:00.000Z/,
  );
  assert.match(table, /Selected-period total: \$500.00/);
});

test("unknown credit amount cannot become a zero AI cost in the combined total", async () => {
  const source = fixture();
  source.data.spending.months[0].ai.estimatedCashUsd = null;
  const result = await completeSpendingReport(source, {}, async (args) =>
    args[0] === "sts"
      ? { Account: "test-account", Arn: "test-principal" }
      : page(source.data.spending.months),
  );
  assert.equal(result.data.spending.months[0].providerOperatingCostUsd, null);
  assert.equal(
    result.data.spending.totals.totalIncludingReimbursementsUsd,
    null,
  );
});

test("the real CLI reads only the session and spending endpoints, prints the table, saves JSON, and signals incomplete AWS", async () => {
  const dir = await fs.mkdtemp(path.join(testWorkRoot(), "spending-"));
  const source = fixture();
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cli/session")
      res.end(JSON.stringify({ userId: 5, scopes: ["build:read"] }));
    else if (req.url === "/cli/admin/spending?from=2026-08&to=2026-10")
      res.end(JSON.stringify(source));
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, status: "error" }));
    }
  });
  try {
    await fs.writeFile(
      path.join(dir, "aws"),
      `#!/usr/bin/env node
const result = process.argv.includes('sts')
  ? {Account: process.env.SPENDING_TEST_WRONG_IDENTITY ? 'wrong' : 'test-account', Arn:'test-principal'}
  : JSON.parse(process.env.SPENDING_TEST_AWS_PAGE);
console.log(JSON.stringify(result));
`,
      { mode: 0o700 },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const output = path.join(dir, "report.json");
    const args = [
      fileURLToPath(new URL("../bin/lumine.js", import.meta.url)),
      "admin",
      "spending",
      "--from",
      "2026-08",
      "--to",
      "2026-10",
      "--api-url",
      `http://127.0.0.1:${server.address().port}`,
      "--auth-token",
      "synthetic-test-token",
      "--no-update-check",
      "--output",
      output,
    ];
    const settings = {
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        SPENDING_TEST_AWS_PAGE: JSON.stringify(
          page(source.data.spending.months),
        ),
      },
    };
    const run = promisify(execFile);
    const printed = await run(process.execPath, args, settings);
    assert.match(printed.stdout, /Category.*2026-08.*2026-09.*2026-10/);
    assert.match(printed.stdout, /AWS \(including tax\)/);
    assert.match(printed.stdout, /Reimbursements/);
    assert.equal(
      JSON.parse(await fs.readFile(output, "utf8")).data.spending.complete,
      true,
    );
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    const json = await run(process.execPath, [...args, "--json"], settings);
    assert.deepEqual(
      JSON.parse(json.stdout),
      JSON.parse(await fs.readFile(output, "utf8")),
    );
    await assert.rejects(
      run(process.execPath, [...args, "--json"], {
        ...settings,
        env: { ...settings.env, SPENDING_TEST_WRONG_IDENTITY: "1" },
      }),
      (error) => {
        assert.equal(error.code, 1);
        const result = JSON.parse(error.stdout);
        assert.equal(result.status, "partial");
        assert.equal(
          result.data.spending.totals.totalIncludingReimbursementsUsd,
          null,
        );
        return true;
      },
    );
    assert.equal(requests.length, 6);
    assert.ok(requests.every((req) => req.method === "GET"));
  } finally {
    // Stop the disposable server before removing its persistent fixture dir.
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
