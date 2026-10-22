// Read-only interpretation of bounded wake geometry. Large gaps are leads,
// never a diagnosis or evidence that a browser workaround is safe.
export function summarizeOwnerViewport(data, sessionData = data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const sessions = new Map(
    [...(sessionData?.events || []), ...events].filter(e => e.type === "session").map(e => [e.sessionId, e.data || {}]),
  );
  const cycles = new Map();
  const usableBySession = new Map();
  let unavailable = 0;
  let dropped = 0;
  for (const event of events) {
    if (event.type === "trace-dropped") dropped += Number(event.data?.count) || 0;
    if (event.type !== "wake-viewport") continue;
    const d = event.data || {};
    if (d.error || d.v !== 1 || d._trimmed || !d.window || !d.root || !d.focus) {
      unavailable += 1;
      continue;
    }
    usableBySession.set(event.sessionId, (usableBySession.get(event.sessionId) || 0) + 1);
    const key = `${event.sessionId}:${d.cycle}`;
    const header = sessions.get(event.sessionId);
    let cycle = cycles.get(key);
    if (!cycle) {
      cycle = {
        sessionId: event.sessionId, cycle: d.cycle, version: d.version || header?.version || "unknown",
        platform: header?.platform || "unknown", ua: header?.ua || null,
        sessionHeaderAvailable: Boolean(header), samples: 0, settledSamples: 0,
        largeGapSamples: 0, backgroundSamples: 0, lastScheduledMs: 0,
        maxRootGap: null, maxVisualGap: null, firstLargeGapMs: null, lastLargeGapMs: null, examples: [],
      };
      cycles.set(key, cycle);
    }
    cycle.samples += 1;
    if (d.phase === "background") cycle.backgroundSamples += 1;
    cycle.lastScheduledMs = Math.max(cycle.lastScheduledMs, Number(d.scheduledMs) || 0);
    if (d.phase !== "settle" || d.scheduledMs < 1000 || d.visibility !== "visible") continue;
    cycle.settledSamples += 1;
    const nav = d.nav;
    // The desktop header is fixed at the TOP. Only a nav anchored to bottom:0
    // can support this candidate. Keyboard/zoom/hidden states stay in raw data.
    if (!nav || nav.position !== "fixed" || parseFloat(nav.bottomStyle) !== 0 || nav.height <= 0 || nav.display === "none" ||
        nav.visibility === "hidden" || nav.transform !== "none" ||
        !d.visual || !Number.isFinite(d.visual.scale) || Math.abs(d.visual.scale - 1) > 0.01 ||
        d.focus.editable || ["input", "textarea", "iframe"].includes(d.focus.tag) || d.inset !== 0) continue;
    if (![nav.bottom, d.root.height, d.visual.height, d.visual.offsetTop, d.elapsedMs].every(Number.isFinite)) continue;
    const rootGap = Math.round(d.root.height - nav.bottom);
    const visualGap = Math.round(d.visual.height + d.visual.offsetTop - nav.bottom);
    cycle.maxRootGap = Math.max(cycle.maxRootGap ?? -Infinity, rootGap);
    cycle.maxVisualGap = Math.max(cycle.maxVisualGap ?? -Infinity, visualGap);
    if (Math.max(rootGap, visualGap) >= 100) {
      cycle.largeGapSamples += 1;
      cycle.firstLargeGapMs = Math.min(cycle.firstLargeGapMs ?? Infinity, d.elapsedMs);
      cycle.lastLargeGapMs = Math.max(cycle.lastLargeGapMs ?? -Infinity, d.elapsedMs);
      if (cycle.examples.length < 3) cycle.examples.push({
        seq: event.seq, clientTime: event.clientTime, path: event.path,
        elapsedMs: d.elapsedMs, rootGap, visualGap,
      });
    }
  }
  const rows = [...cycles.values()];
  const viewportEvents = events.filter(e => e.type === "wake-viewport").length;
  const clients = [...new Set(events.map(e => e.sessionId))].map(sessionId => {
    const own = events.filter(e => e.sessionId === sessionId);
    const header = sessions.get(sessionId);
    return {
      sessionId, version: header?.version || own.find(e => e.type === "wake-viewport")?.data?.version || "unknown",
      platform: header?.platform || "unknown",
      viewportSupport: header ? header.viewportTrace === 1 : null,
      geometrySamples: own.filter(e => e.type === "wake-viewport").length,
      usableSamples: usableBySession.get(sessionId) || 0,
    };
  });
  const missingHeaders = rows.filter(c => !c.sessionHeaderAvailable).length;
  const clientsWithoutGeometry = clients.filter(c => !c.usableSamples).length;
  const usableSamples = viewportEvents - unavailable;
  const partial = Boolean(data?.truncated || sessionData?.truncated || unavailable || dropped || missingHeaders || clientsWithoutGeometry);
  return {
    schema: 1, since: data?.since ?? null,
    coverage: !usableSamples ? "unavailable" : partial ? "partial" : "observed",
    truncated: Boolean(data?.truncated), sessionHeadersTruncated: Boolean(sessionData?.truncated),
    viewportEvents, usableSamples, unavailableSamples: unavailable, droppedEvents: dropped,
    wakeProfiles: events.filter(e => e.type === "wake").length,
    clients, clientsWithoutGeometry,
    cycles: rows, cyclesMissingHeaders: missingHeaders,
    cyclesReaching20s: rows.filter(c => c.lastScheduledMs >= 20_000).length,
    largeGapCycles: rows.filter(c => c.largeGapSamples > 0).length,
    // Timers can all be released together after a stall. Scheduled times alone
    // do not establish separate observations; require actual time separation.
    repeatedLargeGapCycles: rows.filter(c => c.largeGapSamples >= 2 && c.lastLargeGapMs - c.firstLargeGapMs >= 500).length,
    note: "A >=100px settled gap is an investigation lead, not a proven defect. Normal browser chrome, viewport offsets and rendering state still require comparison. No samples means unavailable, not healthy. Wake network tags identify the upload network, not necessarily the network at capture.",
  };
}

export function formatOwnerViewportReport(summary) {
  const lines = [
    "# Owner wake viewport follow-up", "",
    `Coverage: **${summary.coverage}**. ${summary.usableSamples} usable geometry samples (${summary.viewportEvents} raw events) across ${summary.cycles.length} load/return cycles; ${summary.cyclesReaching20s} reached the 20-second sample.`, "",
    `Observed clients: ${[...new Set(summary.clients.map(c => `${c.version} (${c.platform}; geometry support ${c.viewportSupport === null ? "unknown" : c.viewportSupport ? "yes" : "no"})`))].join(", ") || "none"}.`, "",
    `Collection failures: ${summary.collectionFailures?.join(", ") || "none"}.`, "",
    `Large-gap candidates: ${summary.largeGapCycles} cycles; ${summary.repeatedLargeGapCycles} had settled bottom-nav gaps >=100px at least 500ms apart in actual time, no focused input, no app keyboard inset and scale 1.`, "",
    `Missing/trimmed geometry: ${summary.unavailableSamples}; clients without usable geometry: ${summary.clientsWithoutGeometry}; reported dropped events: ${summary.droppedEvents}; cycles without session context: ${summary.cyclesMissingHeaders}; truncated trace: ${summary.truncated}; truncated session history: ${summary.sessionHeadersTruncated}.`, "",
    summary.note, "",
    "Read owner-wake.json and owner-wake-sessions.json alongside this summary. Compare affected and ordinary cycles within the same client/browser version. Distinguish viewport height changes, viewport panning and nav displacement; correlate the wake performance profile and its upload network tag. Record the evidence and next action in the daily report even when coverage is unavailable.", "",
    "| Client | Platform | Cycle | Samples | Settled | Large gap | Max root gap | Max visual gap |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const c of summary.cycles) {
    const safe = v => String(v).replace(/[|\r\n]/g, " ");
    lines.push(`| ${safe(c.version)} | ${safe(c.platform)} | ${safe(c.sessionId).slice(0, 8)}:${c.cycle} | ${c.samples} | ${c.settledSamples} | ${c.largeGapSamples} | ${c.maxRootGap ?? "unavailable"} | ${c.maxVisualGap ?? "unavailable"} |`);
  }
  return lines.join("\n") + "\n";
}
