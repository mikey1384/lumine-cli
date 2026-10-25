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
    // AI bucket changes answer with rule matches (emails, IPs) and member
    // names; the receipt keeps the decision: ids, modes and counts.
    case "ai-bucket.restrict":
    case "ai-bucket.rule.add":
    case "ai-bucket.rule.disable": {
      const ruleIds = (rules) =>
        (rules || []).map((rule) => ({
          id: rule.id ?? null,
          kind: rule.kind ?? null,
          scope: rule.scope ?? null,
          effectiveRestriction: rule.effectiveRestriction ?? null,
        }));
      return keep({
        bucketId: data.bucket?.id ?? null,
        restriction: data.bucket?.restriction?.mode ?? null,
        previousRestriction: data.previous?.mode ?? null,
        addedRules: ruleIds(data.addedRules),
        disabledRules: ruleIds(data.disabledRule ? [data.disabledRule] : []),
        kickedAccountCount: (data.kickedUserIds || []).length,
        releasedAccountCount: (data.releasedAccounts || []).length,
        ruleCount: data.ruleCount ?? null,
        memberCount: data.memberCount ?? null,
        verified: data.verified === true,
      });
    }
    // an Arena paper's blurred page: the signed link to the private file is not kept
    case "approvals.redact":
      return keep({
        submissionId: data.submissionId ?? null,
        page: data.page ?? null,
        kind: data.kind ?? null,
      });
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
