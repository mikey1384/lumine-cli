import { teacherBranchApplyReceipt } from "./admin-teacher-branches.js";

// What a write keeps on disk as its receipt (admin-request-intents.js writes
// it to the admin work directory). Most writes keep the API's response; these
// return private evidence (a teacher's identity facts, a reported child's
// chat), which is printed but never persisted: the receipt keeps only what
// proves the decision (Mikey 2026-10-07, after the identity-inspect fix).
export function receiptToKeep(operation, result) {
  if (!result || typeof result !== "object") return result;
  const data = result.data || {};
  const keep = (fields) => ({ ok: result.ok, status: result.status, changed: result.changed, data: fields });
  switch (operation?.name) {
    case "teachers.review":
      return keep({
        userId: data.teacherUserId ?? null,
        decision: data.decision ?? null,
        fingerprint: data.fingerprint ?? null,
        reviewedAt: data.reviewedAt ?? null,
        note: data.note ?? null,
        reviewId: data.reviewId ?? null,
        revoked: Boolean(data.revoked),
      });
    case "teachers.review_flagged":
      return keep({
        decision: data.decision ?? null,
        note: data.note ?? null,
        reviewed: (data.reviewed || []).map((r) => ({
          userId: r.teacherUserId ?? null,
          fingerprint: r.fingerprint ?? null,
          reviewedAt: r.reviewedAt ?? null,
        })),
        skipped: (data.skipped || []).map((s) => ({ userId: s.userId ?? null, reason: s.reason ?? null })),
      });
    case "teachers.branches.apply":
      return keep(teacherBranchApplyReceipt(data));
    case "chat-reports.set": {
      const report = data.report || {};
      return keep({
        reportId: report.id ?? null,
        status: report.status ?? null,
        reviewedAt: report.reviewedAt ?? null,
        reviewedByUserId: report.reviewedByUserId ?? null,
        note: report.reviewNote ?? null,
      });
    }
    default:
      // Bridge Builder writes answer with the whole crew view: members' who-
      // are-you answers, parents' addresses and questions, held parent emails.
      // Keep the decision only (ids, statuses, counts), never the crew.
      if (String(operation?.name || "").startsWith("meetup.")) {
        const crew = data.crew || {};
        return keep({
          crewId: crew.crewId ?? data.result?.crewId ?? null,
          crewStatus: crew.status ?? null,
          currentStep: crew.progress?.currentStep ?? null,
          result: scalarsOf(data.result),
          ...(data.slot ? { slot: scalarsOf(data.slot) } : {}),
          ...(data.unlocks ? { unlocks: scalarsOf(data.unlocks) } : {}),
        });
      }
      return result;
  }
}

// Numbers, booleans, short status words and arrays of ids: what proves a
// decision without copying anyone's text.
function scalarsOf(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" || typeof item === "boolean" || item === null) out[key] = item;
    else if (typeof item === "string" && /^[\w:.-]{0,40}$/.test(item)) out[key] = item;
    else if (Array.isArray(item) && item.every((x) => typeof x === "number")) out[key] = item;
  }
  return out;
}
