import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const round = (value) => {
  if (!Number.isFinite(value))
    throw new Error("Invalid computed spending amount.");
  return Number(value.toFixed(8));
};
const USAGE =
  "lumine admin spending [--month YYYY-MM | --from YYYY-MM --to YYYY-MM] [--aws-profile <profile>] [--json]";

function invalid(message) {
  return Object.assign(new Error(message), {
    code: "CLI_ADMIN_CLI_VALIDATION",
  });
}

export function buildSpendingOperation(options) {
  if (
    (options.positional || []).length !== 1 ||
    options.adminDays ||
    options.adminDate ||
    options.adminAll ||
    options.adminResume
  ) {
    throw invalid(`Usage: ${USAGE}.`);
  }
  const query = new URLSearchParams();
  const values = {
    month: options.adminSpendingMonth,
    from: options.adminSpendingFrom,
    to: options.adminSpendingTo,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))
      throw invalid(`--${key} must use YYYY-MM format.`);
    query.set(key, value);
  }
  if (query.has("month") && (query.has("from") || query.has("to")))
    throw invalid("Use --month or --from/--to, not both.");
  if (query.has("from") !== query.has("to"))
    throw invalid("Provide both --from and --to.");
  if (query.has("from") && query.get("from") > query.get("to"))
    throw invalid("--from must not follow --to.");
  const qs = query.toString();
  return {
    name: "spending.report",
    method: "GET",
    path: `/cli/admin/spending${qs ? `?${qs}` : ""}`,
    mutates: false,
    requiresRun: false,
    timeoutMs: 60000,
  };
}

async function runAws(args, { profile, region, timeoutMs }) {
  try {
    const { stdout } = await execFileAsync(
      "aws",
      [
        ...args,
        "--profile",
        profile,
        "--region",
        region,
        "--output",
        "json",
        "--no-cli-pager",
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // Do not expose subprocess stdout, credentials or arbitrary provider error
    // payloads in a saved financial report.
    throw new Error(
      error.code === "ENOENT"
        ? "AWS CLI is not installed. Install it and configure the requested profile."
        : `AWS billing could not be read with profile ${profile}; check its authentication and Cost Explorer access.`,
    );
  }
}

function amount(metric) {
  if (
    metric?.Unit !== "USD" ||
    metric.Amount === "" ||
    metric.Amount == null ||
    !Number.isFinite(Number(metric.Amount))
  ) {
    throw new Error(
      "AWS returned an invalid amount or a currency other than USD.",
    );
  }
  return Number(metric.Amount);
}

export function normalizeAwsSpending(pages, months) {
  const expected = new Map(
    months
      .filter((m) => m.startDayKey < m.endDayKeyExclusive)
      .map((m) => [m.startDayKey, m]),
  );
  const found = new Map();
  for (const page of pages) {
    if (!Array.isArray(page?.ResultsByTime))
      throw new Error("AWS returned no billing periods.");
    for (const period of page.ResultsByTime) {
      const start = period.TimePeriod?.Start;
      const requested = expected.get(start);
      if (
        !requested ||
        period.TimePeriod?.End !== requested.endDayKeyExclusive ||
        typeof period.Estimated !== "boolean"
      ) {
        throw new Error(
          "AWS billing periods do not match the requested UTC months.",
        );
      }
      let target = found.get(start);
      if (!target) {
        target = {
          status: "available",
          costUsd: 0,
          estimated: period.Estimated,
          services: [],
          startDayKey: start,
          endDayKeyExclusive: period.TimePeriod.End,
        };
        found.set(start, target);
      }
      if (
        target.estimated !== period.Estimated ||
        !Array.isArray(period.Groups)
      )
        throw new Error("Inconsistent AWS billing page.");
      if (
        period.Groups.length === 0 &&
        period.Total?.UnblendedCost &&
        amount(period.Total.UnblendedCost) !== 0
      ) {
        throw new Error("AWS omitted the requested service breakdown.");
      }
      for (const group of period.Groups) {
        if (
          !Array.isArray(group.Keys) ||
          group.Keys.length !== 1 ||
          typeof group.Keys[0] !== "string" ||
          target.services.some((s) => s.service === group.Keys[0])
        )
          throw new Error("Duplicate or invalid AWS service row.");
        const costUsd = amount(group.Metrics?.UnblendedCost);
        target.services.push({ service: group.Keys[0], costUsd });
        target.costUsd += costUsd;
      }
    }
  }
  if (found.size !== expected.size)
    throw new Error("AWS billing is missing a requested month.");
  return months.map((month) => {
    if (month.startDayKey === month.endDayKeyExclusive)
      return {
        status: "no_completed_days",
        costUsd: 0,
        estimated: true,
        services: [],
        startDayKey: month.startDayKey,
        endDayKeyExclusive: month.endDayKeyExclusive,
      };
    const value = found.get(month.startDayKey);
    return {
      ...value,
      costUsd: round(value.costUsd),
      services: value.services.sort((a, b) => b.costUsd - a.costUsd),
    };
  });
}

function validateReport(report) {
  if (
    report?.schemaVersion !== 1 ||
    report.currency !== "USD" ||
    report.timezone !== "UTC" ||
    !Array.isArray(report.months) ||
    !report.months.length ||
    report.months.length > 12 ||
    !report.sources?.aws ||
    report.range?.includesInProgressDay !== false
  ) {
    throw new Error(
      "The API did not return a supported spending report; deploy the matching API release.",
    );
  }
  let expectedStart = report.range.startDayKey;
  for (const month of report.months) {
    const nextMonth = new Date(
      Date.UTC(
        Number(month.monthKey?.slice(0, 4)),
        Number(month.monthKey?.slice(5, 7)),
        1,
      ),
    )
      .toISOString()
      .slice(0, 10);
    if (
      !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month.monthKey) ||
      month.startDayKey !== `${month.monthKey}-01` ||
      month.startDayKey !== expectedStart ||
      !/^20\d{2}-\d{2}-\d{2}$/.test(month.endDayKeyExclusive) ||
      month.endDayKeyExclusive < month.startDayKey ||
      month.endDayKeyExclusive > nextMonth ||
      (month.status === "closed" && month.endDayKeyExclusive !== nextMonth) ||
      (month !== report.months.at(-1) &&
        month.endDayKeyExclusive !== nextMonth) ||
      new Date(`${month.endDayKeyExclusive}T00:00:00Z`)
        .toISOString()
        .slice(0, 10) !== month.endDayKeyExclusive
    ) {
      throw new Error("The API spending report has invalid month boundaries.");
    }
    expectedStart = nextMonth;
    // An available source must supply its amounts. In particular, null paid
    // totals must never be coerced to zero when combined with operating costs.
    const required = [
      ...(month.ai ? [month.ai.grossUsd] : []),
      ...(month.reimbursements
        ? [
            month.reimbursements.aiServiceUsd,
            month.reimbursements.infrastructureUsd,
            month.reimbursements.totalUsd,
          ]
        : []),
    ];
    if (
      required.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      )
    )
      throw new Error("The API spending report has incomplete source amounts.");
    for (const value of [
      month.ai?.grossUsd,
      month.ai?.creditUsd,
      month.ai?.estimatedCashUsd,
      month.reimbursements?.aiServiceUsd,
      month.reimbursements?.infrastructureUsd,
      month.reimbursements?.totalUsd,
    ]) {
      if (
        value != null &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      )
        throw new Error("Invalid spending source amount.");
    }
  }
  if (
    report.months.at(-1).endDayKeyExclusive !== report.range.endDayKeyExclusive
  )
    throw new Error("The API spending report has incomplete month coverage.");
}

export async function completeSpendingReport(receipt, options, aws = runAws) {
  if (receipt?.ok !== true) return receipt;
  const report = receipt.data?.spending;
  validateReport(report);
  const warnings = [...(report.warnings || [])];
  const source = report.sources.aws;
  const profile = options.adminAwsProfile || source.defaultProfile;
  if (typeof profile !== "string" || !profile.trim())
    throw invalid("--aws-profile must name an AWS CLI profile.");
  let awsMonths = null;
  let awsError = null;
  try {
    const settings = {
      profile,
      region: source.region,
      timeoutMs: Math.max(
        1000,
        Math.min(60000, Number(options.timeoutMs) || 30000),
      ),
    };
    const hasCompletedDays =
      report.range.startDayKey < report.range.endDayKeyExclusive;
    const pages = [];
    if (hasCompletedDays) {
      const identity = await aws(["sts", "get-caller-identity"], settings);
      if (
        identity?.Account !== source.accountId ||
        identity?.Arn !== source.principalArn
      ) {
        throw new Error(
          "AWS identity does not match the Twinkle billing principal. No Cost Explorer query was sent.",
        );
      }
      let token;
      const seen = new Set();
      do {
        if (pages.length >= 100)
          throw new Error("AWS billing exceeded the pagination limit.");
        const page = await aws(
          [
            "ce",
            "get-cost-and-usage",
            "--time-period",
            `Start=${report.range.startDayKey},End=${report.range.endDayKeyExclusive}`,
            "--granularity",
            "MONTHLY",
            "--metrics",
            "UnblendedCost",
            "--group-by",
            "Type=DIMENSION,Key=SERVICE",
            "--no-paginate",
            ...(token ? ["--next-page-token", token] : []),
          ],
          settings,
        );
        pages.push(page);
        token = page.NextPageToken;
        if (token && (typeof token !== "string" || seen.has(token)))
          throw new Error("AWS billing pagination did not advance.");
        if (token) seen.add(token);
      } while (token);
    }
    awsMonths = normalizeAwsSpending(pages, report.months);
  } catch (error) {
    awsError = error.message;
    warnings.push(awsError);
  }
  const months = report.months.map((month, i) => {
    const billing = awsMonths?.[i] ?? null;
    const overlap = month.ai?.awsOverlapDetected === true;
    if (overlap)
      warnings.push(
        `${month.monthKey}: AWS-billed AI detected; combined totals require overlap reconciliation.`,
      );
    const operating =
      month.ai?.estimatedCashUsd != null && billing && !overlap
        ? round(month.ai.estimatedCashUsd + billing.costUsd)
        : null;
    return {
      ...month,
      aws: billing,
      providerOperatingCostUsd: operating,
      totalIncludingReimbursementsUsd:
        operating !== null && month.reimbursements
          ? round(operating + month.reimbursements.totalUsd)
          : null,
    };
  });
  const complete = months.every(
    (m) => m.totalIncludingReimbursementsUsd !== null,
  );
  const sum = (select) =>
    months.every((m) => select(m) != null)
      ? round(months.reduce((n, m) => n + select(m), 0))
      : null;
  return {
    ...receipt,
    status: complete ? "success" : "partial",
    data: {
      ...receipt.data,
      spending: {
        ...report,
        complete,
        months,
        warnings,
        sources: {
          ...report.sources,
          aws: {
            ...source,
            profile,
            status: awsMonths ? "available" : "unavailable",
            error: awsError,
          },
        },
        totals: {
          aiEstimatedCashUsd: sum((m) => m.ai?.estimatedCashUsd),
          awsUsd: sum((m) => m.aws?.costUsd),
          reimbursementsUsd: sum((m) => m.reimbursements?.totalUsd),
          totalIncludingReimbursementsUsd: sum(
            (m) => m.totalIncludingReimbursementsUsd,
          ),
        },
      },
    },
  };
}

export function formatSpending(report) {
  const money = (value) =>
    value == null
      ? "Unavailable"
      : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = [
    `Twinkle spending · USD · UTC · ${report.complete ? "complete sources" : "INCOMPLETE SOURCES"}`,
  ];
  const rows = [
    ["Category", ...report.months.map((m) => m.monthKey)],
    [
      "AI after credits",
      ...report.months.map((m) => money(m.ai?.estimatedCashUsd)),
    ],
    ["AWS (including tax)", ...report.months.map((m) => money(m.aws?.costUsd))],
    [
      "Reimbursements",
      ...report.months.map((m) => money(m.reimbursements?.totalUsd)),
    ],
    [
      "TOTAL incl. reimbursements",
      ...report.months.map((m) => money(m.totalIncludingReimbursementsUsd)),
    ],
    ["", ...report.months.map(() => "")],
    ["AI before credits", ...report.months.map((m) => money(m.ai?.grossUsd))],
    ["Promotional credit", ...report.months.map((m) => money(m.ai?.creditUsd))],
    [
      "Reimbursement: AI service",
      ...report.months.map((m) => money(m.reimbursements?.aiServiceUsd)),
    ],
    [
      "Reimbursement: infrastructure",
      ...report.months.map((m) => money(m.reimbursements?.infrastructureUsd)),
    ],
  ];
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((row) => row[i].length)),
  );
  lines.push(
    ...rows.map((row) =>
      row
        .map((cell, i) =>
          i ? cell.padStart(widths[i]) : cell.padEnd(widths[i]),
        )
        .join(" | "),
    ),
  );
  for (const month of report.months) {
    if (month.status === "in_progress")
      lines.push(
        `${month.monthKey} AI/AWS: ${month.throughDayKey ? `through ${month.throughDayKey} UTC` : "no completed UTC days"}; current usage day excluded.`,
      );
    if (month.aws?.estimated)
      lines.push(
        `${month.monthKey} AWS is provisional and may change with billing updates.`,
      );
  }
  lines.push(
    `Selected-period total: ${money(report.totals.totalIncludingReimbursementsUsd)}`,
  );
  lines.push(
    "AI is a usage-based estimate after credits. AWS estimated flags and service details are in JSON.",
  );
  lines.push(
    "Reimbursements are gross paid amounts by payment date, before refunds/fees; included once in the total above.",
  );
  if (report.sources.reimbursements?.includesCurrentDay)
    lines.push(
      `Reimbursements include today's settled payments through ${new Date((report.sources.reimbursements.endAtExclusive - 1) * 1000).toISOString()}.`,
    );
  if (report.inProgressDay)
    lines.push(
      `${report.inProgressDay.dayKey} partial AI usage: ${money(report.inProgressDay.ai?.grossUsd)} before credits, excluded.`,
    );
  for (const warning of report.warnings || [])
    lines.push(`Unavailable: ${warning}`);
  return lines.join("\n");
}
