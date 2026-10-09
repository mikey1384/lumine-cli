function seenAt(value) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0)
    return "unknown";
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function eventTypes(counts) {
  const entries = Object.entries(counts || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return entries.length
    ? `; ${entries.map(([type, count]) => `${type}: ${count}`).join(", ")}`
    : "";
}

/** Display observed device events separately from accounts and physical visits. */
export function formatIdentityDeviceUsage(inspection) {
  const devices = inspection.sharedDevices || [];
  const coverage = inspection.evidenceCoverage || {};
  const lines = [];
  if (devices.length) {
    lines.push(
      `Device history (${coverage.deviceLookbackDays || "unknown"} days): recorded account events, not visits or unique sessions.`,
    );
    for (const device of devices) {
      const usage = device.usage;
      if (!usage) {
        lines.push(
          `  Device ${device.key}: usage counts unavailable from this API; ${device.accountCount ?? "unknown"} observed account(s).`,
        );
        continue;
      }
      if (usage.status === "not_read" || usage.eventCount == null) {
        lines.push(
          `  Device ${device.key}: usage and sharing not read (${usage.truncatedBy?.join(", ") || "incomplete evidence"}).`,
        );
        continue;
      }
      const partial = usage.status !== "complete";
      const prefix = partial ? "at least " : "";
      lines.push(
        `  Device ${device.key}: ${prefix}${usage.eventCount} recorded event(s), ${prefix}${device.accountCount} account(s)${eventTypes(usage.eventsByType)}.`,
        `    First observed ${seenAt(usage.firstSeenAt)}; last observed ${seenAt(usage.lastSeenAt)}.`,
      );
      if (partial) {
        lines.push(
          `    Partial history (${usage.truncatedBy?.join(", ") || "incomplete evidence"}); older events and other accounts may be missing.`,
        );
      }
      for (const account of usage.accounts || []) {
        lines.push(
          `    #${account.userId} ${account.username || "(unknown account)"}: ${prefix}${account.eventCount} recorded event(s)${eventTypes(account.eventsByType)}; first ${seenAt(account.firstSeenAt)}, last ${seenAt(account.lastSeenAt)}.`,
        );
      }
      if (usage.accountsTruncated)
        lines.push("    Account detail list capped; totals include omitted accounts.");
    }
  }
  if (coverage.truncated) {
    lines.push(
      `Device discovery/evidence is incomplete (${coverage.truncatedBy?.join(", ") || "history limit"}); additional devices or accounts may exist.`,
    );
  }
  return lines;
}
