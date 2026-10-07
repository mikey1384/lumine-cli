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
      return result;
  }
}
