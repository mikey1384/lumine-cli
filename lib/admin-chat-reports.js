// Human output for `lumine admin chat-reports list|show|set`. The generic
// printer used to fall through to the daily-run report branch for any
// `data.report` and crash on `report.run.id`; these formatters own the
// chat-report shapes (controllers/chat/model/messageReports.ts).

function formatTime(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "unknown time";
  return `${new Date(value * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function who(person) {
  if (!person) return "unknown";
  const id = Number(person.id || person.userId || 0);
  if (person.username) return id ? `${person.username} (#${id})` : person.username;
  return id ? `user #${id}` : "unknown";
}

function indent(text, prefix) {
  return String(text ?? "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatMessageLine(message, marker = " ") {
  const author = message.username || (message.userId ? `user #${message.userId}` : "unknown");
  const content = String(message.content ?? "").trim() || "(no text)";
  const [first, ...rest] = content.split("\n");
  const head = `${marker} ${formatTime(message.timeStamp)}  ${author}: ${first}`;
  return rest.length ? `${head}\n${indent(rest.join("\n"), "      ")}` : head;
}

function where(report) {
  const parts = [];
  if (report.channelKind) parts.push(report.channelKind);
  if (report.channelId) parts.push(`channel ${report.channelId}`);
  if (report.subchannelId) parts.push(`subchannel ${report.subchannelId}`);
  const channelName = report.message?.channelName;
  return `${parts.join(" ")}${channelName ? ` "${channelName}"` : ""}`;
}

export function formatChatReportLine(report) {
  const preview = String(report.message?.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const short = preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
  return `#${report.id} ${String(report.status || "open").toUpperCase()} · ${report.reasonLabel || report.reason || "no reason"} · ${who(report.reporter)} → ${who(report.reported)} · ${formatTime(report.createdAt)}${Number(report.reportsOfThisMessage) > 1 ? ` · ${report.reportsOfThisMessage} reports of this message` : ""}${short ? `\n    "${short}"` : ""}`;
}

export function formatChatReportList(data = {}) {
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const filter = data.filter ? `${data.filter} ` : "";
  const lines = [
    `${reports.length} ${filter}chat report(s)${reports.length ? ":" : "."}`,
  ];
  for (const report of reports) lines.push(`  ${formatChatReportLine(report)}`);
  if (data.nextCursor) {
    const status =
      data.filter && data.filter !== "pending" ? ` --status ${data.filter}` : "";
    lines.push(
      `More: lumine admin chat-reports list${status} --cursor ${data.nextCursor}`,
    );
  }
  if (reports.length) {
    lines.push("Open one with: lumine admin chat-reports show <id>");
  }
  return lines;
}

export function formatChatReport(report = {}) {
  const lines = [];
  lines.push(
    `Chat report #${report.id}: ${String(report.status || "open").toUpperCase()} · filed ${formatTime(report.createdAt)}${report.ownerNotifiedAt ? ` · Mikey notified ${formatTime(report.ownerNotifiedAt)}` : ""}`,
  );
  lines.push(`Reporter → reported: ${who(report.reporter)} → ${who(report.reported)}`);
  lines.push(
    `Reason: ${report.reasonLabel || report.reason || "none"}${report.reason && report.reasonLabel && report.reason !== report.reasonLabel ? ` (${report.reason})` : ""}`,
  );
  if (report.note) lines.push(`Reporter's note: ${report.note}`);
  const place = where(report);
  if (place) lines.push(`Where: ${place}`);
  if (Number(report.reportsOfThisMessage) > 1) {
    lines.push(`This message has ${report.reportsOfThisMessage} reports.`);
  }
  if (Array.isArray(report.safetyHoldIds) && report.safetyHoldIds.length) {
    lines.push(`Safety hold(s): #${report.safetyHoldIds.join(", #")}`);
  }
  if (report.reviewedAt || report.reviewNote) {
    lines.push(
      `Review: ${formatTime(report.reviewedAt)}${report.reviewedByUserId ? ` by user #${report.reviewedByUserId}` : ""}${report.reviewNote ? ` — ${report.reviewNote}` : ""}`,
    );
  } else {
    lines.push("Review: not reviewed yet.");
  }

  const message = report.message;
  lines.push("");
  lines.push(`Reported message${report.messageId ? ` #${report.messageId}` : ""}:`);
  lines.push(message ? formatMessageLine(message, ">") : "  (no snapshot kept)");

  const before = Array.isArray(report.context?.before) ? report.context.before : [];
  const after = Array.isArray(report.context?.after) ? report.context.after : [];
  if (!report.context) {
    lines.push("");
    lines.push("Context: none kept.");
    return lines;
  }
  lines.push("");
  lines.push(`Context before (${before.length}):`);
  if (!before.length) lines.push("  (none)");
  for (const item of before) lines.push(formatMessageLine(item));
  lines.push(`Context after (${after.length}):`);
  if (!after.length) lines.push("  (none)");
  for (const item of after) lines.push(formatMessageLine(item));
  return lines;
}

// Returns the lines for a chat-report operation, or null when the operation
// is not one of these (holds/export/suspend have their own printer).
export function formatChatReportResult({ operation, data }) {
  if (operation?.name === "chat-reports.list") return formatChatReportList(data);
  if (operation?.name === "chat-reports.show" || operation?.name === "chat-reports.set") {
    const lines = data?.report ? formatChatReport(data.report) : ["No report returned."];
    if (operation.name === "chat-reports.set") lines.unshift("Recorded.");
    return lines;
  }
  return null;
}
