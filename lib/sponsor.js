import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { agentCommand } from "./agent.js";
import { notifyBuildOwnerOfContribution } from "./api.js";
import { ensureAuth, resolveAuth, writeAuthFile } from "./auth.js";
import { readCompleteBuildForumSnapshot } from "./forum.js";
import { requestJson } from "./http.js";
import { sleep } from "./util.js";

const SPONSOR_PATH = "/cli/sponsor";
const PROVIDERS = new Set(["codex", "claude-code"]);
const PERSONAS = new Set(["zero", "ciel"]);
const DEFAULT_DUTY_POLL_MS = 3_000;
const MAX_FORUM_CONTEXT_CHARS = 8_000;
const MAX_FOLLOW_UP_PASSES = 4;

export async function sponsorCommand(options, commandServices) {
  const args = options.sponsorArgs || [];
  const area = String(args[0] || "status")
    .trim()
    .toLowerCase();
  if (area === "agreement") {
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

async function sponsorDutyCommand(options, args, commandServices) {
  const action = String(args[0] || "status")
    .trim()
    .toLowerCase();
  if (action === "status") {
    await printSponsorStatus(options);
    return;
  }
  const persona = normalizePersona(args[1] || options.sponsorPersona);
  const auth = await ensureAuth(options);
  if (["pause", "resume", "stop"].includes(action)) {
    const state =
      action === "resume" ? "active" : action === "stop" ? "stopped" : "paused";
    const result = await sponsorRequest({
      options,
      auth,
      method: "POST",
      path: `/duty/${persona}/state`,
      body: { state },
    });
    printJsonOrLines(options, result, [
      `${displayPersona(persona)} duty is now ${state}.`,
    ]);
    return;
  }
  if (action !== "start") throw new Error(sponsorUsage());
  if (options.json) {
    throw new Error("A foreground sponsor duty cannot run with --json.");
  }
  const provider = normalizeProvider(options.provider);
  if (provider !== "codex" && options.sponsorServiceTier) {
    throw new Error(
      "--service-tier is currently supported only by the Codex duty adapter.",
    );
  }
  const started = await sponsorRequest({
    options,
    auth,
    method: "POST",
    path: "/duty/start",
    body: {
      persona,
      provider,
      requestedModel: options.model || null,
      requestedEffort: options.sponsorEffort || null,
      requestedServiceTier: options.sponsorServiceTier || null,
      cliVersion: options.lumineCli?.version || null,
    },
  });
  await runSponsorDuty({
    options,
    auth,
    persona,
    provider,
    started,
    commandServices,
  });
}

async function runSponsorDuty({
  options,
  auth,
  persona,
  provider,
  started,
  commandServices,
}) {
  const dutyId = Number(started.duty?.id || 0);
  const leaseToken = String(started.leaseToken || "");
  if (!dutyId || !leaseToken) {
    throw new Error("Twinkle did not return a valid sponsor duty lease.");
  }
  let canonicalDuty = started.duty;
  let stopRequested = false;
  let dutyLeaseError = null;
  let dutyHeartbeatRunning = false;
  const activeJobs = new Set();
  const signalHandler = () => {
    if (!stopRequested) {
      stopRequested = true;
      console.log("\nStopping after active Workshop jobs finish...");
    }
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  const heartbeatDuty = async () => {
    if (dutyHeartbeatRunning) return;
    dutyHeartbeatRunning = true;
    try {
      canonicalDuty = await sponsorRequest({
        options,
        auth,
        method: "POST",
        path: `/duty/${dutyId}/heartbeat`,
        body: { leaseToken },
      });
      dutyLeaseError = null;
      if (canonicalDuty.state === "stopped") stopRequested = true;
    } catch (error) {
      const status = await sponsorRequest({
        options,
        auth,
        path: "/status",
      }).catch(() => null);
      const confirmedDuty = (status?.duties || []).find(
        (duty) => Number(duty.id) === dutyId,
      );
      if (confirmedDuty?.state === "stopped") {
        canonicalDuty = confirmedDuty;
        dutyLeaseError = null;
        stopRequested = true;
        return;
      }
      dutyLeaseError = error;
      stopRequested = true;
    } finally {
      dutyHeartbeatRunning = false;
    }
  };
  const dutyHeartbeat = setInterval(
    () => void heartbeatDuty(),
    Math.max(10, Number(started.heartbeatEverySeconds || 30)) * 1_000,
  );

  console.log(
    `${displayPersona(persona)} sponsor duty started with ${provider}.`,
  );
  printDutyRuntime(canonicalDuty);
  console.log(
    "The Workshop is now discoverable to users. Press Ctrl-C for a graceful stop.",
  );

  try {
    while (!stopRequested) {
      if (canonicalDuty.state !== "active") {
        await sleep(options.sponsorPollMs || DEFAULT_DUTY_POLL_MS);
        continue;
      }
      const concurrency = Math.max(
        1,
        Number(canonicalDuty.capacity?.maxConcurrentTasks || 1),
      );
      while (!stopRequested && activeJobs.size < concurrency) {
        const claim = await sponsorRequest({
          options,
          auth,
          method: "POST",
          path: "/jobs/claim",
          body: { dutySessionId: dutyId, leaseToken },
        });
        if (!claim.job) break;
        const work = processSponsorJob({
          options,
          sponsorAuth: auth,
          dutyId,
          dutyLeaseToken: leaseToken,
          persona,
          provider,
          claim,
          commandServices,
        })
          .catch((error) => {
            console.error(
              `Workshop job #${claim.job.id} ended: ${error?.message || error}`,
            );
          })
          .finally(() => activeJobs.delete(work));
        activeJobs.add(work);
      }
      await sleep(options.sponsorPollMs || DEFAULT_DUTY_POLL_MS);
    }
    if (!dutyLeaseError && canonicalDuty.state === "active") {
      const paused = await sponsorRequest({
        options,
        auth,
        method: "POST",
        path: `/duty/${persona}/state`,
        body: { state: "paused" },
      });
      canonicalDuty = paused.duty || canonicalDuty;
    }
    await Promise.allSettled(Array.from(activeJobs));
    if (dutyLeaseError) throw dutyLeaseError;
  } finally {
    clearInterval(dutyHeartbeat);
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    if (canonicalDuty.state !== "stopped") {
      await sponsorRequest({
        options,
        auth,
        method: "POST",
        path: `/duty/${persona}/state`,
        body: { state: "stopped" },
      }).catch((error) => {
        if (!dutyLeaseError) {
          console.error(
            `Could not mark duty stopped: ${error?.message || error}`,
          );
        }
      });
    }
  }
  console.log(`${displayPersona(persona)} sponsor duty stopped.`);
}

async function processSponsorJob({
  options,
  sponsorAuth,
  dutyId,
  dutyLeaseToken,
  persona,
  provider,
  claim,
  commandServices,
}) {
  const job = claim.job;
  const jobId = Number(job.id);
  const attemptToken = String(claim.attempt?.token || "");
  const workspaceToken = String(claim.workspaceToken?.accessToken || "");
  if (!jobId || !attemptToken || !workspaceToken) {
    throw new Error("Twinkle returned an incomplete Workshop job lease.");
  }
  const runtime = {
    provider: String(claim.runtime?.provider || ""),
    requestedModel: String(claim.runtime?.requestedModel || "").trim() || null,
    requestedEffort:
      String(claim.runtime?.requestedEffort || "").trim() || null,
    requestedServiceTier:
      String(claim.runtime?.requestedServiceTier || "").trim() || null,
  };
  if (!PROVIDERS.has(runtime.provider) || runtime.provider !== provider) {
    throw new Error(
      "Twinkle returned a Workshop runtime that does not match this duty.",
    );
  }
  const relayById = new Map(
    (claim.relays || []).map((relay) => [relay.id, relay]),
  );
  let heartbeatError = null;
  let heartbeatRunning = false;
  const jobAbortController = new AbortController();
  const heartbeatEveryMs =
    Math.max(10, Number(claim.heartbeatEverySeconds || 30)) * 1_000;
  let lastHeartbeatSuccessAt = Date.now();
  const abortWorkerIfLeaseIsGone = (error) => {
    const status = Number(error?.status || 0);
    const serverRejectedLease = [401, 403, 409].includes(status);
    const leaseWindowElapsed =
      Date.now() - lastHeartbeatSuccessAt >=
      Math.max(120_000, heartbeatEveryMs * 3);
    if (
      !jobAbortController.signal.aborted &&
      (serverRejectedLease || leaseWindowElapsed)
    ) {
      jobAbortController.abort(
        error instanceof Error
          ? error
          : new Error("The sponsored Workshop lease ended."),
      );
    }
  };
  const heartbeatJob = async () => {
    if (heartbeatRunning) return null;
    heartbeatRunning = true;
    try {
      const result = await sponsorJobRequest({
        options,
        sponsorAuth,
        dutyId,
        dutyLeaseToken,
        jobId,
        attemptToken,
        path: "/heartbeat",
      });
      heartbeatError = null;
      lastHeartbeatSuccessAt = Date.now();
      for (const relay of result.relays || []) relayById.set(relay.id, relay);
      return result;
    } catch (error) {
      heartbeatError = error;
      abortWorkerIfLeaseIsGone(error);
      return null;
    } finally {
      heartbeatRunning = false;
    }
  };
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `lumine-${persona}-job-${jobId}-`),
  );
  const workspaceDir = path.join(tempDir, "workspace");
  const authFile = path.join(tempDir, "job-auth.json");
  const jobOptions = {
    ...options,
    authToken: null,
    authFile,
    dir: workspaceDir,
    target: String(job.contributionBuild.id),
    buildIdFlag: String(job.contributionBuild.id),
    provider: runtime.provider,
    model: runtime.requestedModel || "",
    agentEffort: runtime.requestedEffort || "",
    serviceTier: runtime.requestedServiceTier || "",
    agentAbortSignal: jobAbortController.signal,
    reviewLoop: false,
    openBrowser: false,
    skipAssetManifest: true,
  };
  // Do not start a long-lived lease timer until the owned temporary workspace
  // exists. If temp creation fails there is then no interval keeping the duty
  // process alive after this job promise rejects.
  const heartbeatTimer = setInterval(
    () => void heartbeatJob(),
    heartbeatEveryMs,
  );
  const logicalAgents = [];
  let lastSave = null;

  console.log(
    `Claimed Workshop job #${jobId} for ${job.requester.username || `user ${job.requester.userId}`} (${job.contributionBuild.title}).`,
  );
  try {
    await writeAuthFile(jobOptions, {
      token: workspaceToken,
      username: claim.workspaceToken?.user?.username || displayPersona(persona),
      userId: claim.workspaceToken?.user?.id || job.personaUserId,
      expiresAt: Number(claim.workspaceToken?.expiresAt || 0) * 1_000,
      apiUrl: options.apiUrl,
      createdAt: new Date().toISOString(),
    });
    const jobAuth = await resolveAuth(jobOptions);
    await commandServices.pullWorkspace({
      options: jobOptions,
      auth: jobAuth,
      buildId: Number(job.contributionBuild.id),
    });
    const forumContext = await loadForumContext({
      options: jobOptions,
      auth: jobAuth,
      buildId: Number(job.contributionBuild.id),
    });
    const coordinator = await startLogicalAgent({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      runtime,
      role: "coordinator",
      ordinal: 0,
      parentAgentId: null,
    });
    logicalAgents.push(coordinator);
    const appliedRelayIds = new Set();
    const coordinatorResults = [];
    const initialRelays = Array.from(relayById.values());
    const initialResult = await runWorkshopAgentPass({
      jobOptions,
      saveWorkspace: commandServices.saveWorkspace,
      job,
      persona,
      relays: initialRelays,
      forumContext,
      helperOrdinal: 0,
    });
    coordinatorResults.push(initialResult);
    await acknowledgeRelaysApplied({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      relays: initialRelays,
      appliedRelayIds,
    });
    lastSave = initialResult.saveResult || lastSave;

    const helperCount = Math.max(0, Number(job.requestedSubagents || 0));
    for (let ordinal = 1; ordinal <= helperCount; ordinal += 1) {
      await heartbeatJob();
      if (heartbeatError) throw heartbeatError;
      const helper = await startLogicalAgent({
        options,
        sponsorAuth,
        dutyId,
        jobId,
        attemptToken,
        runtime,
        role: "helper",
        ordinal,
        parentAgentId: coordinator.agentId,
      });
      logicalAgents.push(helper);
      try {
        const helperRelays = Array.from(relayById.values());
        const helperResult = await runWorkshopAgentPass({
          jobOptions,
          saveWorkspace: commandServices.saveWorkspace,
          job,
          persona,
          relays: helperRelays,
          forumContext,
          helperOrdinal: ordinal,
        });
        await acknowledgeRelaysApplied({
          options,
          sponsorAuth,
          dutyId,
          jobId,
          attemptToken,
          relays: helperRelays,
          appliedRelayIds,
        });
        lastSave = helperResult.saveResult || lastSave;
        await completeLogicalAgent({
          options,
          sponsorAuth,
          dutyId,
          jobId,
          attemptToken,
          agent: helper,
          status: "completed",
          results: [helperResult],
        });
        helper.completed = true;
      } catch (error) {
        await completeLogicalAgent({
          options,
          sponsorAuth,
          dutyId,
          jobId,
          attemptToken,
          agent: helper,
          status: "failed",
          results: [],
          error,
        }).catch(() => undefined);
        helper.completed = true;
        throw error;
      }
    }

    let relayStreamClosed = false;
    for (let pass = 0; pass < MAX_FOLLOW_UP_PASSES; pass += 1) {
      await heartbeatJob();
      if (heartbeatError) throw heartbeatError;
      const pendingRelays = Array.from(relayById.values()).filter(
        (relay) => !appliedRelayIds.has(relay.id),
      );
      if (pendingRelays.length > 0) {
        const followUpResult = await runWorkshopAgentPass({
          jobOptions,
          saveWorkspace: commandServices.saveWorkspace,
          job,
          persona,
          relays: pendingRelays,
          forumContext: "",
          helperOrdinal: 0,
          isFollowUp: true,
        });
        coordinatorResults.push(followUpResult);
        await acknowledgeRelaysApplied({
          options,
          sponsorAuth,
          dutyId,
          jobId,
          attemptToken,
          relays: pendingRelays,
          appliedRelayIds,
        });
        lastSave = followUpResult.saveResult || lastSave;
      }
      const closure = await retrySponsorTransport(() =>
        sponsorJobRequest({
          options,
          sponsorAuth,
          dutyId,
          jobId,
          attemptToken,
          path: "/relays/close",
        }),
      );
      for (const relay of closure.relays || []) relayById.set(relay.id, relay);
      if (closure.closed) {
        relayStreamClosed = true;
        break;
      }
    }
    if (!relayStreamClosed) {
      throw new Error(
        "The Workshop kept receiving follow-ups and could not close a fully applied relay stream safely.",
      );
    }

    await completeLogicalAgent({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      agent: coordinator,
      status: "completed",
      results: coordinatorResults,
    });
    coordinator.completed = true;
    if (!lastSave?.artifactVersion?.versionId || !lastSave?.filesHash) {
      throw new Error(
        "The agent did not produce a new canonical saved artifact for this Workshop job.",
      );
    }
    const outcomeSummary = summarizeWorkshopOutcome(
      coordinatorResults.at(-1)?.finalText,
      job,
    );
    const branchNoticeMessageId = await ensureCanonicalBranchNotice({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      jobOptions,
      jobAuth,
      job,
      outcomeSummary,
    });
    await retrySponsorTransport(() =>
      sponsorJobRequest({
        options,
        sponsorAuth,
        dutyId,
        jobId,
        attemptToken,
        path: "/complete",
        body: {
          artifactVersionId: Number(lastSave.artifactVersion.versionId),
          branchNoticeMessageId,
          outcomeSummary,
          reportedFilesHash: lastSave.filesHash,
        },
      }),
    );
    console.log(
      `Completed Workshop job #${jobId}; ${displayPersona(persona)} sent the branch update.`,
    );
  } catch (error) {
    for (const agent of logicalAgents.filter((item) => !item.completed)) {
      await completeLogicalAgent({
        options,
        sponsorAuth,
        dutyId,
        jobId,
        attemptToken,
        agent,
        status: "failed",
        results: [],
        error,
      }).catch(() => undefined);
      agent.completed = true;
    }
    await retrySponsorTransport(() =>
      sponsorJobRequest({
        options,
        sponsorAuth,
        dutyId,
        jobId,
        attemptToken,
        path: "/fail",
        body: {
          failureCode: "worker_failed",
          failureReason: String(error?.message || error).slice(0, 1000),
        },
      }),
    ).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `lumine: could not remove temporary Workshop directory ${tempDir} (${error?.message || error})`,
      );
    }
  }
}

async function runWorkshopAgentPass({
  jobOptions,
  saveWorkspace,
  job,
  persona,
  relays,
  forumContext,
  helperOrdinal,
  isFollowUp = false,
}) {
  const prompt = workshopAgentPrompt({
    job,
    persona,
    relays,
    forumContext,
    helperOrdinal,
    isFollowUp,
  });
  return await agentCommand(
    { ...jobOptions, agentPrompt: prompt },
    { saveWorkspace },
  );
}

async function startLogicalAgent({
  options,
  sponsorAuth,
  dutyId,
  jobId,
  attemptToken,
  runtime,
  role,
  ordinal,
  parentAgentId,
}) {
  return await retrySponsorTransport(() =>
    sponsorJobRequest({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      path: "/agents",
      body: {
        role,
        ordinal,
        parentAgentId,
        provider: runtime.provider,
        requestedModel: runtime.requestedModel,
        requestedEffort: runtime.requestedEffort,
        requestedServiceTier: runtime.requestedServiceTier,
      },
    }),
  );
}

async function completeLogicalAgent({
  options,
  sponsorAuth,
  dutyId,
  jobId,
  attemptToken,
  agent,
  status,
  results,
  error = null,
}) {
  const provenance = summarizeProviderRuns(results);
  const allChangedPaths = Array.from(
    new Set(results.flatMap((result) => result.changedPaths || [])),
  );
  return await retrySponsorTransport(() =>
    sponsorJobRequest({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      path: `/agents/${agent.agentId}/complete`,
      body: {
        status,
        resolvedModel: provenance.resolvedModel,
        resolvedEffort: provenance.resolvedEffort,
        resolvedServiceTier: provenance.resolvedServiceTier,
        runtimeVersion: provenance.runtimeVersion,
        evidenceTier: provenance.evidenceTier,
        usage: provenance.usage,
        outcome: {
          providerPassCount: provenance.providerPassCount,
          changedPathCount: allChangedPaths.length,
          changedPaths: allChangedPaths
            .map((changedPath) => String(changedPath || "").slice(0, 300))
            .filter(Boolean)
            .slice(0, 50),
          finalText: String(results.at(-1)?.finalText || "").slice(0, 2000),
          ...(error
            ? { error: String(error?.message || error).slice(0, 1000) }
            : {}),
        },
      },
    }),
  );
}

async function acknowledgeRelaysApplied({
  options,
  sponsorAuth,
  dutyId,
  jobId,
  attemptToken,
  relays,
  appliedRelayIds,
}) {
  const relayIds = Array.from(
    new Set(relays.map((relay) => Number(relay.id)).filter((id) => id > 0)),
  );
  if (relayIds.length === 0) return;
  for (let index = 0; index < relayIds.length; index += 50) {
    const relayIdBatch = relayIds.slice(index, index + 50);
    const receipt = await retrySponsorTransport(() =>
      sponsorJobRequest({
        options,
        sponsorAuth,
        dutyId,
        jobId,
        attemptToken,
        path: "/relays/applied",
        body: { relayIds: relayIdBatch },
      }),
    );
    const canonicalIds = new Set(
      (receipt.appliedRelayIds || []).map((relayId) => Number(relayId)),
    );
    if (relayIdBatch.some((relayId) => !canonicalIds.has(relayId))) {
      throw new Error("Twinkle did not confirm every applied Workshop relay.");
    }
    for (const relayId of canonicalIds) appliedRelayIds.add(relayId);
  }
}

async function ensureCanonicalBranchNotice({
  options,
  sponsorAuth,
  dutyId,
  jobId,
  attemptToken,
  jobOptions,
  jobAuth,
  job,
  outcomeSummary,
}) {
  const lookup = () =>
    sponsorJobRequest({
      options,
      sponsorAuth,
      dutyId,
      jobId,
      attemptToken,
      path: "/branch-notice",
    });
  const existing = await lookup();
  const existingMessageId = Number(existing.branchNotice?.id || 0);
  if (existingMessageId) return existingMessageId;

  try {
    const notice = await notifyBuildOwnerOfContribution({
      options: jobOptions,
      auth: jobAuth,
      rootBuildId: Number(job.rootBuild.id),
      contributionBuildId: Number(job.contributionBuild.id),
      note: outcomeSummary,
    });
    const messageId = Number(notice?.message?.id || 0);
    if (!messageId) {
      throw new Error("Twinkle did not confirm the branch update message.");
    }
    return messageId;
  } catch (error) {
    for (const delayMs of [250, 750, 1_500]) {
      await sleep(delayMs);
      const recovered = await lookup().catch(() => null);
      const recoveredMessageId = Number(recovered?.branchNotice?.id || 0);
      if (recoveredMessageId) return recoveredMessageId;
    }
    throw error;
  }
}

function summarizeProviderRuns(results) {
  const runs = results.flatMap((result) => result.providerRuns || []);
  const lastRun = runs.at(-1) || {};
  const valueFromLastRun = (key, maximum) =>
    String(lastRun?.[key] || "")
      .trim()
      .slice(0, maximum) || null;
  const evidenceTiers = runs.map((run) => run?.evidenceTier);
  const evidenceTier =
    evidenceTiers.length > 0 &&
    evidenceTiers.every((tier) => tier === "runtime_observed")
      ? "runtime_observed"
      : evidenceTiers.length > 0 &&
          evidenceTiers.every((tier) =>
            ["runtime_observed", "provider_reported"].includes(tier),
          )
        ? "provider_reported"
        : "requested_only";
  return {
    resolvedModel: valueFromLastRun("resolvedModel", 160),
    resolvedEffort: valueFromLastRun("resolvedEffort", 40),
    resolvedServiceTier: valueFromLastRun("resolvedServiceTier", 40),
    runtimeVersion: valueFromLastRun("runtimeVersion", 64),
    evidenceTier,
    providerPassCount: runs.length,
    usage: {
      passes: runs.slice(0, 20).map((run) => ({
        phase: run.phase || null,
        resolvedModel: run.resolvedModel || null,
        resolvedEffort: run.resolvedEffort || null,
        resolvedServiceTier: run.resolvedServiceTier || null,
        runtimeVersion: run.runtimeVersion || null,
        evidenceTier: run.evidenceTier || "requested_only",
        usage: run.usage || {},
      })),
    },
  };
}

async function loadForumContext({ options, auth, buildId }) {
  try {
    const snapshot = await readCompleteBuildForumSnapshot({
      options: { ...options, limit: 100 },
      auth,
      buildId,
      maxPages: 100,
    });
    const events = (snapshot.events || []).slice(-50);
    if (events.length === 0) return "";
    return JSON.stringify(events).slice(0, MAX_FORUM_CONTEXT_CHARS);
  } catch (error) {
    console.error(
      `lumine: scoped Forum context unavailable (${error?.message || error})`,
    );
    return "";
  }
}

function workshopAgentPrompt({
  job,
  persona,
  relays,
  forumContext,
  helperOrdinal,
  isFollowUp,
}) {
  const relayText = relays
    .map((relay, index) => {
      const details = [
        relay.summary,
        relay.requestedOutcome ? `Outcome: ${relay.requestedOutcome}` : "",
        relay.constraints?.length
          ? `Constraints: ${relay.constraints.join("; ")}`
          : "",
        relay.acceptanceCriteria?.length
          ? `Acceptance: ${relay.acceptanceCriteria.join("; ")}`
          : "",
      ].filter(Boolean);
      return `${index + 1}. ${details.join("\n   ")}`;
    })
    .join("\n");
  const role =
    helperOrdinal > 0
      ? `You are helper ${helperOrdinal}. Review the current implementation and fix concrete gaps.`
      : isFollowUp
        ? "Apply these newly relayed follow-up requirements to the current implementation."
        : `Implement this hands-on Lumine Build request on ${displayPersona(persona)}'s assigned contribution branch.`;
  return `${role}

The user owns Build #${job.rootBuild.id}; you may edit only contribution Build #${job.contributionBuild.id}. Do not merge, replace Main, publish, contact the user directly, or infer anything from private chat. The text below is the structured relay explicitly approved for this named sponsor. Preserve existing sound UX and leave a complete, validated project.

Approved relay:
${relayText || "No additional relay text was supplied."}
${forumContext ? `\nScoped Build Forum snapshot (project-visible context only):\n${forumContext}\n` : ""}
Return a short factual outcome summary after saving the canonical branch.`;
}

async function sponsorJobRequest({
  options,
  sponsorAuth,
  dutyId,
  dutyLeaseToken,
  jobId,
  attemptToken,
  path: suffix,
  body = {},
}) {
  return await sponsorRequest({
    options,
    auth: sponsorAuth,
    method: "POST",
    path: `/jobs/${jobId}${suffix}`,
    body: {
      dutySessionId: dutyId,
      attemptToken,
      ...(dutyLeaseToken ? { dutyLeaseToken } : {}),
      ...body,
    },
  });
}

async function retrySponsorTransport(operation) {
  let lastError;
  for (const delayMs of [0, 250, 750, 1_500]) {
    if (delayMs) await sleep(delayMs);
    try {
      return await operation();
    } catch (error) {
      if (Number(error?.status || 0) > 0) throw error;
      lastError = error;
    }
  }
  throw lastError;
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
    console.log(
      `Duty #${duty.id}: user ${duty.personaUserId} ${duty.state} · ${duty.provider} · model=${duty.requestedModel || "provider default"} · effort=${duty.requestedEffort || "provider default"}`,
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

function printDutyRuntime(duty) {
  console.log(
    `Runtime: model=${duty.requestedModel || "provider default"}, effort=${duty.requestedEffort || "provider default"}, service-tier=${duty.requestedServiceTier || "provider default"}`,
  );
  console.log(
    `Limits: ${duty.capacity?.maxConcurrentTasks || 1} concurrent, ${duty.capacity?.maxSubagentsPerTask || 0} helpers, ${duty.capacity?.dailyTaskLimit || 0}/day, ${duty.capacity?.weeklyTaskLimit || 0}/week`,
  );
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
    "Type I ACCEPT to confirm this agreement and submit the application: ",
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

function normalizeProvider(value) {
  const provider = String(value || "")
    .trim()
    .toLowerCase();
  if (!PROVIDERS.has(provider)) {
    throw new Error("Pass --provider codex or --provider claude-code.");
  }
  return provider;
}

function normalizePersona(value) {
  const persona = String(value || "")
    .trim()
    .toLowerCase();
  if (!PERSONAS.has(persona)) {
    throw new Error("Choose a duty persona: zero or ciel.");
  }
  return persona;
}

function displayPersona(persona) {
  return String(persona || "").toLowerCase() === "ciel" ? "Ciel" : "Zero";
}

function summarizeWorkshopOutcome(finalText, job) {
  const summary = String(finalText || "")
    .trim()
    .slice(0, 1000);
  return (
    summary ||
    `Updated ${job.rootBuild.title} on the assigned contribution branch.`
  );
}

function sponsorUsage() {
  return [
    "Usage:",
    "  lumine sponsor agreement",
    "  lumine sponsor apply --providers codex[,claude-code] [--motivation <text>] [--availability <text>] [--accept-agreement]",
    "  lumine sponsor status",
    "  lumine sponsor withdraw [--yes]",
    "  lumine sponsor capacity [--concurrency <n>] [--helpers <n>] [--daily-limit <n>] [--weekly-limit <n>]",
    "  lumine sponsor duty start <zero|ciel> --provider <codex|claude-code> [--model <name>] [--effort <level>] [--service-tier <tier>]",
    "  lumine sponsor duty pause|resume|stop <zero|ciel>",
    "  lumine sponsor jobs [--limit <n>]",
  ].join("\n");
}
