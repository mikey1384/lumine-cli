// `lumine admin jev-images report|switch|decide` (twinkle-api
// controllers/cli/admin/jevImages.ts): JEV image checks are advisory only.
//   report [--days 1..30]                     per-area health, cost, agreement,
//                                             disagreements and escalations
//   switch --area <area|all> --mode on|off [--daily-cap <n>]   owner only;
//                                             takes effect within 30 s, no deploy
//   decide --area <area> --key <subject> --decision <decision>   record a
//                                             reviewer's final decision
//   thumbnails --targets subject:<id>,build:<id>,... | --featured [--saved-only]
//                                             advisory thumbnail notes for
//                                             Featured review (area thumbnail)
export const JEV_IMAGES_AREAS = ["arena_paper", "arena_picture", "study_record", "thumbnail", "sdk_decide"];
export const JEV_IMAGES_USAGE =
  "Usage: lumine admin jev-images report [--days 1..30] | switch --area <" +
  ["all", ...JEV_IMAGES_AREAS].join("|") +
  "> --mode on|off [--daily-cap <0-5000>] [--build <id>, sdk_decide only, no --daily-cap] | decide --area <area> --key <subject key, e.g. arenaItem:10176> --decision <decision> | thumbnails --targets <subject:<id>,build:<id>,...> | --featured [--saved-only] [--json]";
export const JEV_THUMBNAIL_MAX_TARGETS = 40;

function invalid(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

export function buildJevImagesOperation({ action, options = {} }) {
  if (!action || action === "report") {
    const days = options.adminDays === "" || options.adminDays == null ? 1 : Number(options.adminDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw invalid("--days must be 1 to 30.");
    return {
      name: "jev-images.report",
      method: "GET",
      path: `/cli/admin/jev-images/report?days=${days}`,
      body: undefined,
      mutates: false,
      requiresRun: false,
    };
  }
  if (action === "switch") {
    const area = String(options.adminJevArea || "");
    if (area !== "all" && !JEV_IMAGES_AREAS.includes(area)) throw invalid(JEV_IMAGES_USAGE);
    const mode = String(options.adminMode || "");
    if (mode !== "on" && mode !== "off") throw invalid("--mode is on or off.");
    const body = { area, mode };
    if (options.adminJevDailyCap !== "" && options.adminJevDailyCap != null) {
      const cap = Number(options.adminJevDailyCap);
      if (area === "all" || !Number.isInteger(cap) || cap < 0 || cap > 5000) {
        throw invalid("--daily-cap is set per area, 0 to 5000.");
      }
      body.dailyCap = cap;
    }
    // One app's switch for sdk_decide (Twinkle.ai.decide with images). An app
    // has no daily cap of its own; bursts are limited by the server.
    if (options.adminBuild !== "" && options.adminBuild != null) {
      const buildId = Number(options.adminBuild);
      if (area !== "sdk_decide" || !Number.isSafeInteger(buildId) || buildId <= 0) {
        throw invalid("--build is set only with --area sdk_decide and a build id.");
      }
      if (body.dailyCap !== undefined) throw invalid("--build sets one app's switch only (--mode on|off); an app has no daily cap of its own.");
      body.buildId = buildId;
    }
    return {
      name: "jev-images.switch",
      method: "POST",
      path: "/cli/admin/jev-images/switch",
      body,
      mutates: true,
      requiresRun: false,
    };
  }
  if (action === "decide") {
    const area = String(options.adminJevArea || "");
    if (!JEV_IMAGES_AREAS.includes(area)) throw invalid(JEV_IMAGES_USAGE);
    const subjectKey = String(options.adminJevKey || "");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,30}:[0-9][A-Za-z0-9:_-]{0,60}$/.test(subjectKey)) {
      throw invalid("--key is a subject key such as arenaItem:10176 or arenaPaper:12.");
    }
    const decision = String(options.adminDecision || "");
    if (!/^[a-z_]{2,24}$/.test(decision)) throw invalid("--decision is required (e.g. keep, fix, retired).");
    return {
      name: "jev-images.decide",
      method: "POST",
      path: "/cli/admin/jev-images/decide",
      body: { area, subjectKey, decision },
      mutates: true,
      requiresRun: false,
    };
  }
  if (action === "thumbnails") {
    const featured = options.adminFeatured === true;
    const raw = String(options.adminTargets || "").trim();
    if (featured === Boolean(raw)) throw invalid("Use --targets subject:<id>,build:<id>,... or --featured (the current board), not both.");
    const body = featured ? { featured: true } : { targets: parseThumbnailTargets(raw) };
    // --saved-only: earlier answers only, no provider call.
    if (options.adminSavedOnly === true) body.run = false;
    return {
      name: "jev-images.thumbnails",
      method: "POST",
      path: "/cli/admin/jev-images/thumbnails",
      body,
      mutates: false,
      requiresRun: false,
      timeoutMs: 180000,
    };
  }
  throw invalid(JEV_IMAGES_USAGE);
}

export function parseThumbnailTargets(raw) {
  const targets = [...new Set(String(raw).split(",").map((value) => value.trim()).filter(Boolean))];
  if (!targets.length || targets.length > JEV_THUMBNAIL_MAX_TARGETS || targets.some((value) => !/^(subject|build):[1-9][0-9]{0,14}$/.test(value))) {
    throw invalid(`--targets is 1-${JEV_THUMBNAIL_MAX_TARGETS} of subject:<id> or build:<id>, comma-separated.`);
  }
  return targets;
}

export function thumbnailLine(item) {
  if (!item) return "no thumbnail check";
  if (item.status !== "ok") return `no thumbnail check (${item.reason || "unavailable"})`;
  return `${item.verdict === "flag" ? "LOOK AT THE THUMBNAIL" : "thumbnail looks fine"}${item.cached ? " (saved)" : ""}${item.notes?.length ? ` · ${item.notes.join("; ")}` : ""}`;
}

const usd = (value) => `$${Number(value || 0).toFixed(4)}`;

export function formatJevImagesResult({ operation, data = {} }) {
  if (operation.name === "jev-images.switch") {
    return [`JEV images ${data.area}${data.buildId ? ` for build ${data.buildId}` : ""}: ${data.mode}${data.dailyCap !== undefined ? `, daily cap ${data.dailyCap}` : ""} (all servers within ${data.effectiveWithinSeconds ?? 30} s).`];
  }
  if (operation.name === "jev-images.decide") {
    return [`Recorded ${data.decision} for ${data.subjectKey} (${data.area}) on ${data.updated ?? 0} advisory row(s).`];
  }
  if (operation.name === "jev-images.thumbnails") {
    const lines = [`Thumbnail notes (advisory, JEV images): ${data.status || "unavailable"}${data.featuredBoard ? " · current Featured board" : ""} · ${(data.flagged || []).length} to look at`];
    for (const item of data.items || []) {
      lines.push(`  ${item.target}${item.kind ? ` (${item.kind})` : ""} ${JSON.stringify(item.title || "")}: ${thumbnailLine(item)}`);
    }
    if (data.notice) lines.push(`  ${data.notice}`);
    return lines;
  }
  const lines = [
    `JEV images (${data.model || "?"}, advisory only) · last ${data.window?.days ?? "?"} day(s) · coverage ${data.coverage?.status || "unknown"} · ${data.totals?.checks ?? 0} checks · ${usd(data.totals?.costUsd)}`,
  ];
  for (const [area, a] of Object.entries(data.areas || {})) {
    const s = a.setting || {};
    lines.push(
      `${area}: ${s.mode} (${s.source}, cap ${s.dailyCap}, used today ${s.usedToday ?? "?"}) · ${a.checks} checks, ${a.ok} ok, ${a.errors} errors, ${a.timeouts} timeouts, ${a.droppedRetries} dropped-image retries · p95 ${a.latencyMs?.p95 ?? "-"} ms · ${a.tokens?.input ?? 0} tokens ${usd(a.costUsd)} · agreement ${a.agreementRate === null ? "-" : `${a.agreed}/${a.scored}`} · ${a.flaggedUndecided} flagged awaiting a decision`,
    );
    for (const d of a.disagreements || []) {
      lines.push(`  disagreement #${d.eventId} ${d.subjectKey}: advisory ${d.advisory}, final ${d.finalDecision}`);
    }
  }
  if ((data.escalations || []).length) {
    lines.push("Escalations:");
    for (const e of data.escalations) lines.push(`  ${e.area} ${e.code}: ${e.detail}`);
  } else {
    lines.push("Escalations: none.");
  }
  return lines;
}
