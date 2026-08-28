import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ensureAuth } from "./auth.js";
import {
  sponsorDutyCommand,
  sponsorJobCommand,
} from "./sponsor-duty.js";
import { requestJson } from "./http.js";

const SPONSOR_PATH = "/cli/sponsor";
const PROVIDERS = new Set(["codex", "claude-code"]);

export async function sponsorCommand(options, commandServices) {
  const args = options.sponsorArgs || [];
  const area = String(args[0] || "status")
    .trim()
    .toLowerCase();
  if (area === "agreement") {
    if (String(args[1] || "").trim().toLowerCase() === "accept") {
      if (args.length > 2) throw new Error(sponsorUsage());
      await acceptSponsorAgreement(options);
      return;
    }
    if (args.length > 1) throw new Error(sponsorUsage());
    const auth = await ensureAuth(options);
    const agreement = await sponsorRequest({
      options,
      auth,
      path: "/agreement",
    });
    printSponsorAgreement(agreement, options);
    return;
  }
  if (area === "apply") {
    await applyToSponsor(options);
    return;
  }
  if (area === "withdraw") {
    await withdrawSponsorApplication(options);
    return;
  }
  if (area === "capacity") {
    await updateSponsorCapacity(options);
    return;
  }
  if (area === "duty") {
    await sponsorDutyCommand(options, args.slice(1), commandServices);
    return;
  }
  if (area === "job") {
    await sponsorJobCommand(options, args.slice(1), commandServices);
    return;
  }
  if (area === "jobs") {
    const auth = await ensureAuth(options);
    const result = await sponsorRequest({
      options,
      auth,
      path: `/jobs?limit=${encodeURIComponent(String(options.limit || 20))}`,
    });
    printSponsorJobs(result, options);
    return;
  }
  if (area === "status") {
    await printSponsorStatus(options);
    return;
  }
  throw new Error(sponsorUsage());
}

async function acceptSponsorAgreement(options) {
  const auth = await ensureAuth(options);
  const agreement = await sponsorRequest({ options, auth, path: "/agreement" });
  if (!options.json) {
    printSponsorAgreement(agreement, { ...options, json: false });
  }
  const interactive = Boolean(input.isTTY && output.isTTY);
  let accepted = options.sponsorAcceptAgreement;
  if (!accepted && interactive) {
    const rl = readline.createInterface({ input, output });
    try {
      accepted = await confirmExactAgreement(rl);
    } finally {
      rl.close();
    }
  }
  if (!accepted) {
    throw new Error(
      "Explicit acceptance is required. Re-run with --accept-agreement after reading the current agreement.",
    );
  }
  const result = await sponsorRequest({
    options,
    auth,
    method: "POST",
    path: "/agreement/accept",
    body: {
      agreementVersion: agreement.version,
      agreementAccepted: true,
    },
  });
  printJsonOrLines(options, result, [
    `Sponsor agreement ${result.agreementVersion} accepted.`,
  ]);
}

async function applyToSponsor(options) {
  const auth = await ensureAuth(options);
  const agreement = await sponsorRequest({ options, auth, path: "/agreement" });
  if (!options.json) {
    printSponsorAgreement(agreement, { ...options, json: false });
  }

  const interactive = Boolean(input.isTTY && output.isTTY);
  const rl = interactive ? readline.createInterface({ input, output }) : null;
  try {
    const motivation = await requiredApplicationText({
      supplied: options.sponsorMotivation,
      label: "Why do you want to sponsor Lumine Build work? ",
      interactive,
      rl,
    });
    const availability = await requiredApplicationText({
      supplied: options.sponsorAvailability,
      label: "Describe your typical availability and limits: ",
      interactive,
      rl,
    });
    const providers = normalizeProviderList(options.sponsorProviders);
    if (providers.length === 0) {
      throw new Error(
        "Choose at least one provider with --providers codex,claude-code.",
      );
    }
    const accepted = options.sponsorAcceptAgreement
      ? true
      : interactive
        ? await confirmExactAgreement(rl)
        : false;
    if (!accepted) {
      throw new Error(
        "The sponsor agreement must be explicitly accepted. Re-run with --accept-agreement after reading it.",
      );
    }
    const application = await sponsorRequest({
      options,
      auth,
      method: "POST",
      path: "/applications",
      body: {
        motivation,
        availability,
        agreementVersion: agreement.version,
        agreementAccepted: true,
        capabilities: {
          providers,
          notes: options.sponsorCapabilityNotes || null,
          usesOwnSubscription: true,
          willReportActualModel: true,
          willProtectUserData: true,
          acceptsIntegrityReview: true,
        },
      },
    });
    printJsonOrLines(options, application, [
      `Sponsor application #${application.id} submitted.`,
      "Status: pending administrator review",
      "Sponsorship remains unavailable until the application is approved.",
    ]);
  } finally {
    rl?.close();
  }
}

async function withdrawSponsorApplication(options) {
  const auth = await ensureAuth(options);
  if (!options.assumeYes && input.isTTY && output.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(
        "Withdraw your current sponsor application? Type yes to continue: ",
      );
      if (answer.trim().toLowerCase() !== "yes") {
        console.log("Sponsor application unchanged.");
        return;
      }
    } finally {
      rl.close();
    }
  } else if (!options.assumeYes) {
    throw new Error("Pass --yes to withdraw non-interactively.");
  }
  const result = await sponsorRequest({
    options,
    auth,
    method: "DELETE",
    path: "/applications",
  });
  printJsonOrLines(options, result, ["Sponsor application withdrawn."]);
}

async function updateSponsorCapacity(options) {
  const auth = await ensureAuth(options);
  const status = await sponsorRequest({ options, auth, path: "/status" });
  if (!status.sponsor) {
    throw new Error("An approved sponsor account is required first.");
  }
  const current = status.sponsor.capacity || {};
  const body = {
    maxConcurrentTasks: integerOption(
      options.sponsorConcurrency,
      current.maxConcurrentTasks,
      "--concurrency",
    ),
    maxSubagentsPerTask: integerOption(
      options.sponsorHelpers,
      current.maxSubagentsPerTask,
      "--helpers",
      { allowZero: true },
    ),
    dailyTaskLimit: integerOption(
      options.sponsorDailyLimit,
      current.dailyTaskLimit,
      "--daily-limit",
    ),
    weeklyTaskLimit: integerOption(
      options.sponsorWeeklyLimit,
      current.weeklyTaskLimit,
      "--weekly-limit",
    ),
  };
  const capacity = await sponsorRequest({
    options,
    auth,
    method: "PUT",
    path: "/duty/capacity",
    body,
  });
  printJsonOrLines(options, capacity, [
    "Sponsor capacity updated from canonical server state.",
    `Concurrent tasks: ${capacity.maxConcurrentTasks}`,
    `Helpers per task: ${capacity.maxSubagentsPerTask}`,
    `Daily limit: ${capacity.dailyTaskLimit}`,
    `Weekly limit: ${capacity.weeklyTaskLimit}`,
  ]);
}

async function sponsorRequest({
  options,
  auth,
  method = "GET",
  path: suffix,
  body,
}) {
  return await requestJson({
    method,
    url: `${options.apiUrl}${SPONSOR_PATH}${suffix}`,
    authToken: auth.token,
    body,
    timeoutMs: options.timeoutMs,
  });
}

async function printSponsorStatus(options) {
  const auth = await ensureAuth(options);
  const status = await sponsorRequest({ options, auth, path: "/status" });
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`Application: ${status.application?.status || "not submitted"}`);
  console.log(`Sponsor access: ${status.sponsor?.status || "not approved"}`);
  if (
    status.sponsor &&
    status.application?.agreementVersion !== status.agreementVersion
  ) {
    console.log(
      `Agreement update required: read version ${status.agreementVersion} with \`lumine sponsor agreement\`, then accept it before starting duty.`,
    );
  }
  if (status.sponsor?.capacity) {
    const capacity = status.sponsor.capacity;
    console.log(
      `Capacity: ${capacity.maxConcurrentTasks} concurrent, ${capacity.maxSubagentsPerTask} helpers, ${capacity.dailyTaskLimit}/day, ${capacity.weeklyTaskLimit}/week`,
    );
    console.log(
      `Usage: ${status.usage?.dailyStarted || 0} today, ${status.usage?.weeklyStarted || 0} this week, ${status.usage?.activeTasks || 0} active`,
    );
  }
  for (const duty of status.duties || []) {
    const scope =
      duty.scope === "shared"
        ? "shared Zero/Ciel"
        : `legacy assistant user ${duty.personaUserId}`;
    console.log(
      `Duty #${duty.id}: ${scope} · ${duty.state} · ${duty.provider} · model=${duty.requestedModel || "missing"} · effort=${duty.requestedEffort || "missing"}`,
    );
  }
}

function printSponsorAgreement(agreement, options) {
  if (options.json) {
    console.log(JSON.stringify(agreement, null, 2));
    return;
  }
  console.log(`Lumine sponsor agreement ${agreement.version}`);
  for (const line of agreement.disclosure || []) console.log(`- ${line}`);
}

function printSponsorJobs(jobs, options) {
  if (options.json) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log("No sponsored Workshop jobs yet.");
    return;
  }
  for (const job of jobs) {
    console.log(
      `#${job.id} ${job.status} · ${displayPersona(job.persona)} · ${job.requester?.username || `user ${job.requester?.userId}`} · ${job.contributionBuild?.title || `Build ${job.contributionBuild?.id}`}`,
    );
  }
}

function printJsonOrLines(options, value, lines) {
  if (options.json) console.log(JSON.stringify(value, null, 2));
  else for (const line of lines) console.log(line);
}

async function requiredApplicationText({ supplied, label, interactive, rl }) {
  const value = String(supplied || "").trim();
  if (value) return value;
  if (!interactive) {
    throw new Error(
      "Non-interactive applications require --motivation and --availability.",
    );
  }
  const answer = String(await rl.question(label)).trim();
  if (!answer) throw new Error("Sponsor application answers cannot be empty.");
  return answer;
}

async function confirmExactAgreement(rl) {
  const answer = await rl.question(
    "Type I ACCEPT to confirm this sponsor agreement: ",
  );
  return answer.trim() === "I ACCEPT";
}

function integerOption(value, fallback, label, { allowZero = false } = {}) {
  const selected =
    value === undefined || value === null || value === ""
      ? Number(fallback)
      : Number(value);
  if (!Number.isSafeInteger(selected) || selected < (allowZero ? 0 : 1)) {
    throw new Error(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`,
    );
  }
  return selected;
}

function normalizeProviderList(value) {
  const submitted = String(value || "")
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
  const unsupported = submitted.find((provider) => !PROVIDERS.has(provider));
  if (unsupported) {
    throw new Error(`Unsupported provider: ${unsupported}.`);
  }
  return Array.from(new Set(submitted));
}

function displayPersona(persona) {
  return String(persona || "").toLowerCase() === "ciel" ? "Ciel" : "Zero";
}

function sponsorUsage() {
  return [
    "Usage:",
    "  lumine sponsor agreement",
    "  lumine sponsor agreement accept [--accept-agreement]",
    "  lumine sponsor apply --providers codex[,claude-code] [--motivation <text>] [--availability <text>] [--accept-agreement]",
    "  lumine sponsor status",
    "  lumine sponsor withdraw [--yes]",
    "  lumine sponsor capacity [--concurrency <n>] [--helpers <n>] [--daily-limit <n>] [--weekly-limit <n>]",
    "  lumine sponsor duty start [--provider <codex|claude-code>] --model <name> --effort <level> [--service-tier <tier>]",
    "  lumine sponsor duty watch [--wait-ms <ms>] [--json]",
    "  lumine sponsor duty status|pause|resume|stop",
    "  lumine sponsor job status|pulse|begin <job-id>",
    "  lumine sponsor job update <job-id> --file <path> [--phase <name>]",
    "  lumine sponsor job relay-applied <job-id> <relay-id...>",
    "  lumine sponsor job helper-start|helper-complete <job-id> [options]",
    "  lumine sponsor job complete <job-id> --summary <text>",
    "  lumine sponsor job fail <job-id> --reason <text>",
    "  lumine sponsor jobs [--limit <n>]",
  ].join("\n");
}
