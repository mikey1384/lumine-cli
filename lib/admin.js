import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { assertAuthScope, resolveAuth } from "./auth.js";
import { requestJson } from "./http.js";
import { receiptToKeep } from "./admin-receipts.js";
import { prepareAdminMutationIntent } from "./admin-request-intents.js";
import { formatBytes, parseStorageSizeBytes } from "./util.js";
import {
  extractNewsClaim,
  readAdminJsonFile,
  validateNewsEditorial,
  writeNewsClaimArtifacts,
  writeAdminJsonFile,
} from "./admin-news.js";
import {
  forEachPaginatedResultItem,
  getPaginatedResultStorage,
  runAutomaticPagination,
  runBatchSkips,
  writePaginatedResultJson,
} from "./admin-workflows.js";
import {
  parseBuildReviewReceipt,
  runManagedBuildReview,
} from "./build-review.js";
import { runAdminRuntimeLogWorkflow } from "./admin-runtime-logs.js";
import {
  buildOwnerTraceOperation,
  printOwnerTrace,
} from "./admin-owner-trace.js";
import { formatChatReportResult } from "./admin-chat-reports.js";
import {
  buildTeacherBranchOperation,
  printTeacherBranchResult,
} from "./admin-teacher-branches.js";
import {
  buildProfileShowOperation,
  formatProfileReview,
} from "./admin-profile.js";
import {
  dailyRunGather,
  dailyRunProgress,
  featuredCandidates,
  reportServe,
} from "./admin-daily.js";
import {
  readApprovedFeaturedPlan,
  runFeaturedWorkflow,
} from "./admin-featured.js";
import {
  FEATURED_HISTORY_BATCH_SIZE,
  runBatchedFeaturedHistory,
} from "./admin-featured-history.js";

const MAX_EDITORIAL_FILE_BYTES = 256 * 1024;
const MAX_COMPOSED_TEXT_FILE_BYTES = 64 * 1024;
const MAX_COMPOSED_TEXT_LENGTH = 10_000;
const MAX_BUILD_REVIEW_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_BUILD_REVIEW_UNDERSTANDING_LENGTH = 12_000;
const MAX_NOTABLE_NOTE_LENGTH = 2_000;
const MAX_IDENTITY_INSPECTION_REASON_LENGTH = 500;
const MAX_ESCALATION_DECISION_NOTE_LENGTH = 2_000;
const MAX_TODO_TITLE_LENGTH = 200;
const MAX_TODO_NOTE_LENGTH = 4_000;

// Operator-composed persona text (plain UTF-8, not JSON). The agent writes
// the content in the bot's persona itself; the server never invokes
// its model and no AI Energy is spent.
function readComposedTextFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError("Pass composed text with --file <file.md>.");
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_COMPOSED_TEXT_FILE_BYTES) {
    throw cliValidationError("The composed text file must be under 64KB.");
  }
  const normalized = contents.trim();
  if (!normalized) {
    throw cliValidationError(
      `${normalizedPath} is empty; composed text is required.`,
    );
  }
  if (normalized.length > MAX_COMPOSED_TEXT_LENGTH) {
    throw cliValidationError(
      `Composed text must be at most ${MAX_COMPOSED_TEXT_LENGTH} characters.`,
    );
  }
  return normalized;
}

function readBuildReviewContextFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError(
      "Pass the private reviewed understanding with --review-context <context.json>.",
    );
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (
    Buffer.byteLength(contents, "utf8") > MAX_BUILD_REVIEW_CONTEXT_FILE_BYTES
  ) {
    throw cliValidationError(
      "The Build review context file must be under 64KB.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw cliValidationError(`${normalizedPath} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliValidationError(
      "The Build review context must be a JSON object with an understanding string.",
    );
  }
  const unexpectedKeys = Object.keys(parsed).filter(
    (key) => key !== "understanding",
  );
  if (unexpectedKeys.length > 0) {
    throw cliValidationError(
      "The Build review context JSON may contain only the understanding field; version and provenance are server-owned.",
    );
  }
  const understanding =
    typeof parsed.understanding === "string" ? parsed.understanding.trim() : "";
  if (!understanding) {
    throw cliValidationError(
      "The Build review context understanding must be a non-empty string.",
    );
  }
  if (understanding.length > MAX_BUILD_REVIEW_UNDERSTANDING_LENGTH) {
    throw cliValidationError(
      `The Build review context understanding must be at most ${MAX_BUILD_REVIEW_UNDERSTANDING_LENGTH} characters.`,
    );
  }
  return understanding;
}

const MAX_REWARD_CONFIG_FILE_BYTES = 256 * 1024;
const REWARD_REVIEW_STATUSES = ["pending", "approved", "all"];
const CHAT_REPORT_STATUSES = ["open", "reviewing", "resolved", "dismissed"];
const CHAT_REPORT_LIST_STATUSES = ["pending", ...CHAT_REPORT_STATUSES, "all"];
const REWARD_REVIEW_DECISIONS = ["approve", "reject", "revoke"];
// `lumine admin review`: one queue for every Build unlock (XP/Coin rewards,
// project room, Lumine file storage, AI Card crafting). The per-type commands
// (reward-review, cardcraft-review, storage) are thin aliases of it.
const REVIEW_REQUEST_TYPES = [
  "rewards",
  "project-limit",
  "storage-limit",
  "cardcraft",
];
const REVIEW_REQUEST_TYPE_ALIASES = {
  rewards: "rewards",
  reward: "rewards",
  "reward-review": "rewards",
  "project-limit": "project-limit",
  project: "project-limit",
  room: "project-limit",
  "storage-limit": "storage-limit",
  storage: "storage-limit",
  cardcraft: "cardcraft",
  "card-craft": "cardcraft",
  crafting: "cardcraft",
};
const REVIEW_REQUEST_LIST_STATUSES = [
  "queue",
  "pending",
  "open",
  "approved",
  "rejected",
  "all",
];
const REVIEW_REQUEST_LABELS = {
  rewards: "XP & Coin rewards",
  "project-limit": "Project room",
  "storage-limit": "Lumine file storage",
  cardcraft: "AI Card crafting",
};
const REVIEW_REQUEST_USAGE =
  "Usage: lumine admin review list [--type rewards|project|storage|cardcraft] [--status queue|pending|approved|rejected|all] [--cursor <c>] | show <type:id> [--dir <path>] | approve <type:id> [--config <rules.json>] [--size <500MB|1GB|2GB|n MB>] [--reason <text>] | reject <type:id> [--reason <text>] | revoke <type:id> --reason <text> | propose rewards:<id> --dir <edited-snapshot> --config <rules.json> [--reason <text>]. A bare id works with --type.";

function parseReviewRequestType(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  const type = REVIEW_REQUEST_TYPE_ALIASES[key];
  if (!type) {
    throw cliValidationError(
      `Unknown request type "${key}". Use rewards, project, storage or cardcraft.`,
    );
  }
  return type;
}

// "storage:12", "rewards:70", or a bare id with --type (or a fixed type).
function parseReviewRequestRef(target, { type: fixedType, typeOption } = {}) {
  const raw = String(target || "").trim();
  const match = /^([a-z-]+):(\d+)$/i.exec(raw);
  if (match) {
    const type = parseReviewRequestType(match[1]);
    if (fixedType && type !== fixedType) {
      throw cliValidationError(
        `This command handles ${REVIEW_REQUEST_LABELS[fixedType]} requests only.`,
      );
    }
    return {
      type,
      id: parseRequiredInteger(match[2], "Request ID", 1),
    };
  }
  const type = fixedType || (typeOption ? parseReviewRequestType(typeOption) : "");
  if (!type) {
    throw cliValidationError(
      "Name the request as <type>:<id> (e.g. storage:12) or pass --type.",
    );
  }
  return { type, id: parseRequiredInteger(raw, "Request ID", 1) };
}

// Management approvals (dob/mentor/meetup) and the teacher audit.
const APPROVAL_USAGE =
  "Use: lumine admin approvals list [--status pending|approved|rejected|all] [--type dob|mentor|meetup] | show <id> | approve <id> [--reason <text>] | reject <id> [--reason <text>] | supermod <id> [--reason <text>]";
const TEACHER_USAGE =
  "Use: lumine admin teachers audit [--limit <1-100>] [--cursor <c>] [--all] | branches suggest|networks|confirm|unconfirm|set|clear|apply|list (`lumine admin teachers branches usage` prints each one) | revoke <userId> --reason <text> | review <userId> --decision legit|revoke --note <text> [--fingerprint <fp>] (revoke needs it) | review --all-flagged --expect <id[:fp],...> --note <text>";

function parseApprovalId(target) {
  const raw = String(target || "").replace(/^approval:/, "");
  if (!/^\d+$/.test(raw)) throw cliValidationError(APPROVAL_USAGE);
  return Number(raw);
}

function buildApprovalOperation({ action, target, options }) {
  const reason = String(options.adminReason || "").trim();
  if (!action || action === "list") {
    return readOperation(
      "approvals.list",
      withQuery("/cli/admin/approvals", {
        status: parseChoice(options.adminStatus || "pending", "--status", [
          "pending",
          "approved",
          "rejected",
          "all",
        ]),
        type: options.adminType
          ? parseChoice(String(options.adminType), "--type", [
              "dob",
              "mentor",
              "meetup",
            ])
          : "",
      }),
      { requiresRun: false },
    );
  }
  const id = parseApprovalId(target);
  if (action === "show" || action === "get") {
    return readOperation("approvals.show", `/cli/admin/approvals/${id}`, {
      requiresRun: false,
    });
  }
  // supermod: a teacher signup from academy staff becomes a supermod account
  // (the account type staff get) instead of a teacher (Mikey 2026-10-05).
  if (action === "approve" || action === "reject" || action === "supermod") {
    return writeOperation(
      "approvals.decide",
      "POST",
      `/cli/admin/approvals/${id}`,
      { decision: action, reason },
      { requiresRun: false },
    );
  }
  throw cliValidationError(APPROVAL_USAGE);
}

// English skill tags for the Grammarbles bank: import the verdicts two Claude
// Code agent passes wrote (no model is called), then review what they could
// not settle (Mikey 2026-10-06: bulk AI work runs on Claude Code agents).
const ENGLISH_USAGE =
  "Use: lumine admin english import <verdicts.json> --pass a|b | adjudicate <verdicts.json> | add-questions <questions.json> | relevel <moves.json> | mastery <userId> --reason <why> | backfill-distractors | summary | review [--limit <n>] | accept|retire <questionId> [--reason <text>] | retag <questionId> --skill <code> [--reason <text>]";
const ENGLISH_IMPORT_MAX = 500;

function buildEnglishOperation({ action, target, options }) {
  const limitOf = (max, fallback) =>
    options.adminLimit != null ? parseRequiredInteger(options.adminLimit, "--limit", 1, max) : fallback;
  if (action === "import") {
    const pass = String(options.adminPass || "");
    if (!["a", "b"].includes(pass) || !target) throw cliValidationError(ENGLISH_USAGE);
    const raw = readAdminJsonFile(target, "<verdicts.json>", { maxBytes: 4 * 1024 * 1024 });
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
    if (!items || !items.length || items.length > ENGLISH_IMPORT_MAX) {
      throw cliValidationError(`The file must hold 1 to ${ENGLISH_IMPORT_MAX} verdicts (an array, or { items: [...] }).`);
    }
    return writeOperation("english.import", "POST", "/cli/admin/english/import", { pass, items }, { requiresRun: false, timeoutMs: 120000 });
  }
  // adjudicate / add-questions / relevel: one JSON file of up to 500 entries.
  const BANK_FILES = {
    adjudicate: ["english.adjudicate", "/cli/admin/english/adjudicate", "items"],
    "add-questions": ["english.add_questions", "/cli/admin/english/questions/import", "questions"],
    relevel: ["english.relevel", "/cli/admin/english/relevel", "items"],
  };
  if (BANK_FILES[action]) {
    const [name, path, key] = BANK_FILES[action];
    if (!target) throw cliValidationError(ENGLISH_USAGE);
    const raw = readAdminJsonFile(target, "<file.json>", { maxBytes: 4 * 1024 * 1024 });
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.[key]) ? raw[key] : null;
    if (!list || !list.length || list.length > ENGLISH_IMPORT_MAX) {
      throw cliValidationError(`The file must hold 1 to ${ENGLISH_IMPORT_MAX} entries (an array, or { ${key}: [...] }).`);
    }
    return writeOperation(name, "POST", path, { [key]: list }, { requiresRun: false, timeoutMs: 180000 });
  }
  if (action === "summary") {
    return readOperation("english.summary", "/cli/admin/english/tag-summary", { requiresRun: false });
  }
  // One learner's per-skill mastery and the sentences a report may use.
  // Private learner data: a reason is required and every read is audited.
  if (action === "mastery") {
    const userId = String(target || "");
    const reason = String(options.adminReason || "").trim();
    if (!/^\d+$/.test(userId) || reason.length < 8 || reason.length > 500) throw cliValidationError(ENGLISH_USAGE);
    // POST: the reason travels in the body, never in a URL that access logs keep.
    // A read, not a write: writes save their full response as a receipt file,
    // and a child's learning data must never be left on disk.
    return { ...bodyReadOperation("english.mastery", "POST", "/cli/admin/english/mastery", { userId: Number(userId), reason }), requiresRun: false, timeoutMs: 60000 };
  }
  if (action === "backfill-distractors") {
    return writeOperation("english.backfill_distractors", "POST", "/cli/admin/english/backfill-distractors", {}, { requiresRun: false, timeoutMs: 300000 });
  }
  if (action === "review" && !target) {
    return readOperation("english.review", withQuery("/cli/admin/english/review", { limit: limitOf(100, 20) }), { requiresRun: false });
  }
  if (["accept", "retire", "retag"].includes(action)) {
    const ref = String(target || "");
    if (!/^\d+$/.test(ref)) throw cliValidationError(ENGLISH_USAGE);
    if (action === "retag" && !options.adminSkill) throw cliValidationError(ENGLISH_USAGE);
    return writeOperation(
      "english.decide",
      "POST",
      `/cli/admin/english/review/${ref}`,
      { action, skillCode: options.adminSkill || undefined, reason: String(options.adminReason || "").trim() || undefined },
      { requiresRun: false },
    );
  }
  throw cliValidationError(ENGLISH_USAGE);
}

// One audit page stays well under proxy timeouts (100 teachers took over
// 20 s on 2026-10-05); `--all` pages through every teacher.
const TEACHER_AUDIT_PAGE = 50;
// the API's per-request bulk review bound (approvals.ts BULK_REVIEW_MAX)
const TEACHER_REVIEW_BATCH = 25;

function buildTeacherOperation({ action, target, options }) {
  // the teacher branch registry (admin-teacher-branches.js)
  if (action === "branches" || action === "branch") {
    return buildTeacherBranchOperation({
      sub: target,
      target: options.positional?.[3],
      options,
    });
  }
  if (!action || action === "audit") {
    const operation = readOperation(
      "teachers.audit",
      withQuery("/cli/admin/teachers/audit", {
        limit: options.adminAll
          ? TEACHER_AUDIT_PAGE
          : options.limit
            ? parseRequiredInteger(options.limit, "--limit", 1, 100)
            : "",
        cursor: options.adminAll ? "" : options.adminCursor || "",
      }),
      // Linked-account networks make large audits slow, so this read gets its own timeout.
      { requiresRun: false, timeoutMs: 120000 },
    );
    return options.adminAll ? { ...operation, teacherWorkflow: "audit-all" } : operation;
  }
  if (action === "revoke" || action === "remove") {
    const userId = String(target || "");
    if (!/^\d+$/.test(userId)) throw cliValidationError(TEACHER_USAGE);
    const reason = String(options.adminReason || "").trim();
    if (!reason) {
      throw cliValidationError(
        "lumine admin teachers revoke <userId> needs --reason <text> (kept on the request's record).",
      );
    }
    return writeOperation(
      "teachers.revoke",
      "POST",
      `/cli/admin/teachers/${userId}/revoke`,
      { reason },
      { requiresRun: false },
    );
  }
  // The owner's review of an audited teacher, kept with the fingerprint of the
  // facts he was shown: the server records nothing if they changed since.
  if (action === "review") {
    const note = String(options.note || "").trim();
    if (!note) {
      throw cliValidationError(
        "lumine admin teachers review needs --note <text> (kept with the review).",
      );
    }
    if (options.adminAllFlagged) {
      if (target || options.adminDecision || options.adminFingerprint) {
        throw cliValidationError(
          "--all-flagged reviews the --expect teachers as legit; leave out <userId>, --decision and --fingerprint.",
        );
      }
      return {
        ...writeOperation(
          "teachers.review_flagged",
          "POST",
          "/cli/admin/teachers/review-flagged",
          { note },
          { requiresRun: false, timeoutMs: 120000 },
        ),
        teacherWorkflow: "review-flagged",
        expect: parseTeacherExpect(options.adminExpect),
      };
    }
    const userId = String(target || "");
    if (!/^\d+$/.test(userId)) throw cliValidationError(TEACHER_USAGE);
    const decision = parseChoice(options.adminDecision || "", "--decision", [
      "legit",
      "revoke",
    ]);
    const fingerprint = String(options.adminFingerprint || "").trim().toLowerCase();
    if (fingerprint && !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw cliValidationError("--fingerprint is the 64-character fingerprint the teacher audit printed.");
    }
    // a revoke acts on facts Mikey read, never on an entry printed and acted on in one step
    if (decision === "revoke" && !fingerprint) {
      throw cliValidationError(
        "--decision revoke needs --fingerprint <fp> from the audit entry Mikey decided on.",
      );
    }
    const operation = writeOperation(
      "teachers.review",
      "POST",
      `/cli/admin/teachers/${userId}/review`,
      { decision, note, ...(fingerprint ? { fingerprint } : {}) },
      { requiresRun: false, timeoutMs: 60000 },
    );
    // without --fingerprint: read and show the entry first, then send its fingerprint
    return fingerprint ? operation : { ...operation, teacherWorkflow: "review-one", userId: Number(userId) };
  }
  throw cliValidationError(TEACHER_USAGE);
}

/**
 * --expect for `review --all-flagged`: the teachers Mikey decided on, as
 * `id` or `id:<fingerprint prefix, 8+ hex>` (the prefix pins the facts he
 * read, so a flag that moved since is caught even for an expected id).
 */
export function parseTeacherExpect(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    throw cliValidationError(
      "--all-flagged needs --expect <id[:fp],...>: the teachers Mikey decided on (from the audit he read). Only those are recorded.",
    );
  }
  const expect = new Map();
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)(?::([0-9a-fA-F]{8,64}))?$/);
    if (!match) throw cliValidationError(`--expect entry "${part}" is not <id> or <id>:<fingerprint prefix>.`);
    expect.set(Number(match[1]), match[2] ? match[2].toLowerCase() : "");
  }
  if (!expect.size) throw cliValidationError("--expect lists no teachers.");
  return Object.fromEntries(expect);
}

/** Split the audit's new/changed teachers by --expect: what is sent, and what is not and why. */
export function planExpectedReview(shown, expect) {
  const send = [];
  const notSent = [];
  const seen = new Set();
  for (const t of shown) {
    seen.add(t.userId);
    if (!(String(t.userId) in expect)) {
      notSent.push({ userId: t.userId, reason: "new or changed now, but not in --expect: not reviewed" });
      continue;
    }
    const prefix = expect[String(t.userId)];
    if (prefix && !t.fingerprint.startsWith(prefix)) {
      notSent.push({ userId: t.userId, reason: "changed since the fingerprint in --expect" });
      continue;
    }
    send.push(t);
  }
  for (const id of Object.keys(expect)) {
    if (!seen.has(Number(id))) notSent.push({ userId: Number(id), reason: "in --expect, but not new or changed in this audit" });
  }
  return { send, notSent };
}

const TEACHER_STATUS_ORDER = { unreviewed: 0, changed: 1, reviewed: 2, clean: 3 };

/** Audit pages merged into one audit, in the server's owner order. */
export function mergeTeacherAuditPages(pages) {
  const teachers = pages.flatMap((page) => page.teachers || []);
  teachers.sort(
    (a, b) =>
      (TEACHER_STATUS_ORDER[a.reviewStatus] ?? 9) - (TEACHER_STATUS_ORDER[b.reviewStatus] ?? 9) ||
      (b.flags || []).length - (a.flags || []).length ||
      Number(b.approvedAt) - Number(a.approvedAt),
  );
  const sum = (key) => pages.reduce((total, page) => total + Number(page[key] || 0), 0);
  return {
    teachers,
    audited: sum("audited"),
    flagged: sum("flagged"),
    newlyFlagged: sum("newlyFlagged"),
    changedSinceReview: sum("changedSinceReview"),
    reviewedUnchanged: sum("reviewedUnchanged"),
    failedUserIds: pages.flatMap((page) => page.failedUserIds || []),
    nextCursor: null,
    pages: pages.length,
  };
}

/** The teachers an --all-flagged review sends: those the audit showed as new or changed. */
export function teachersToReview(teachers) {
  return (teachers || [])
    .filter((t) => t.reviewStatus === "unreviewed" || t.reviewStatus === "changed")
    .map((t) => ({ userId: Number(t.account?.userId), fingerprint: t.fingerprint }))
    .filter((t) => t.userId > 0 && /^[0-9a-f]{64}$/.test(String(t.fingerprint || "")));
}

const unwrapAdminData = (receipt) => {
  if (!receipt || receipt.ok !== true) {
    const error = new Error(receipt?.error?.message || "The API did not confirm the teacher audit request.");
    error.code = receipt?.error?.code || "CLI_ADMIN_RECEIPT_INVALID";
    throw error;
  }
  return receipt.data || {};
};

/**
 * Multi-request teacher commands: `audit --all` (every page), `review <id>`
 * (show the entry, then send its fingerprint) and `review --all-flagged`
 * (page the audit, print it, then send what it showed as new or changed, in
 * bounded batches).
 */
export async function runTeacherWorkflow({ options, operation, authToken, requestId, request = requestJson, print = !options.json }) {
  const call = (method, requestPath, body, key) =>
    request({
      method,
      url: `${options.apiUrl}${requestPath}`,
      authToken,
      body,
      headers: key ? { "x-lumine-idempotency-key": key } : {},
      timeoutMs: Math.max(120000, Number(options.timeoutMs) || 0),
    }).then(unwrapAdminData);
  const auditAll = async () => {
    const pages = [];
    let cursor = "";
    for (let i = 0; i < 200; i += 1) {
      const page = await call("GET", withQuery("/cli/admin/teachers/audit", { limit: TEACHER_AUDIT_PAGE, cursor }));
      pages.push(page);
      if (!page.nextCursor) return mergeTeacherAuditPages(pages);
      cursor = page.nextCursor;
    }
    throw new Error("The teacher audit did not finish paging; nothing was reviewed.");
  };
  if (operation.teacherWorkflow === "audit-all") {
    return { ok: true, status: "success", data: await auditAll() };
  }
  if (operation.teacherWorkflow === "review-one") {
    const { teacher } = await call("GET", `/cli/admin/teachers/${operation.userId}/audit`);
    if (print) {
      console.log("Reviewing this audit entry:");
      printTeacherEntry(teacher, { full: true });
      console.log("");
    }
    if (teacher?.evidenceGap) {
      throw cliValidationError(`Not reviewed: ${teacher.evidenceGap}. Try again later.`);
    }
    const data = await call("POST", operation.path, { ...operation.body, fingerprint: teacher.fingerprint }, requestId);
    // the entry was printed above; it is never returned (the receipt stays minimal)
    return { ok: true, status: "success", data };
  }
  if (operation.teacherWorkflow === "review-flagged") {
    const audit = await auditAll();
    if (print) {
      printApprovalResult({ operation: { name: "teachers.audit" }, data: audit });
      console.log("");
    }
    const { send: shown, notSent } = planExpectedReview(teachersToReview(audit.teachers), operation.expect || {});
    const total = { reviewed: [], skipped: [...notSent], changedSinceYouLooked: [] };
    for (let i = 0; i < shown.length; i += TEACHER_REVIEW_BATCH) {
      const batch = shown.slice(i, i + TEACHER_REVIEW_BATCH);
      let data;
      try {
        data = await call("POST", operation.path, { note: operation.body.note, teachers: batch }, `${requestId}:${i / TEACHER_REVIEW_BATCH}`);
      } catch (error) {
        console.error(`Stopped at batch ${i / TEACHER_REVIEW_BATCH + 1}: ${total.reviewed.length} reviewed before it. ${error.message}`);
        throw error;
      }
      total.reviewed.push(...(data.reviewed || []));
      total.skipped.push(...(data.skipped || []));
      total.changedSinceYouLooked.push(...(data.changedSinceYouLooked || []));
    }
    return {
      ok: true,
      status: "success",
      data: {
        decision: "legit",
        note: operation.body.note,
        ...total,
        reviewedCount: total.reviewed.length,
        sent: shown.length,
        audited: audit.audited,
        flagged: audit.flagged,
      },
    };
  }
  throw new Error(`Unknown teacher workflow ${operation.teacherWorkflow}`);
}

// Builds the operation for list/show/approve/reject/revoke. `fixedType` is set
// by the per-type aliases; `listStatuses` keeps their own --status choices.
function buildReviewRequestOperation({
  action,
  target,
  options,
  fixedType = "",
  command = "lumine admin review",
  listStatuses = REVIEW_REQUEST_LIST_STATUSES,
}) {
  const reason = String(options.adminReason || "").trim();
  if (reason.length > 1000) {
    throw cliValidationError("--reason must be at most 1000 characters.");
  }
  if (!action || action === "list") {
    return readOperation(
      "review.list",
      withQuery("/cli/admin/reviews", {
        status: parseChoice(
          options.adminStatus || "pending",
          "--status",
          listStatuses,
        ),
        type:
          fixedType ||
          (options.adminType
            ? String(options.adminType)
                .split(",")
                .map((value) => parseReviewRequestType(value))
                .join(",")
            : ""),
        cursor: options.adminCursor
          ? /^\d+(\.\d\.\d+)?$/.test(String(options.adminCursor))
            ? String(options.adminCursor)
            : (() => {
                throw cliValidationError(
                  "--cursor must be the value a previous list printed.",
                );
              })()
          : "",
      }),
      { requiresRun: false, reviewType: fixedType || null },
    );
  }
  const ref = parseReviewRequestRef(target, {
    type: fixedType,
    typeOption: options.adminType,
  });
  if (action === "show" || action === "get") {
    const snapshotDir = String(options.dir || "").trim();
    if (options.dir && !snapshotDir) {
      throw cliValidationError("Pass a new or empty directory with --dir <path>.");
    }
    if (snapshotDir && ref.type !== "rewards") {
      throw cliValidationError("--dir writes a reward request's frozen source.");
    }
    return readOperation(
      "review.show",
      withQuery(`/cli/admin/reviews/${ref.type}/${ref.id}`, {
        // Reward source is listed with sizes only unless --dir asks for it.
        files: snapshotDir ? "1" : "0",
      }),
      {
        requiresRun: false,
        reviewType: ref.type,
        reviewId: ref.id,
        snapshotDir,
      },
    );
  }
  if (!REWARD_REVIEW_DECISIONS.includes(action)) {
    return null;
  }
  if (action === "revoke" && !["rewards", "cardcraft"].includes(ref.type)) {
    throw cliValidationError(
      `${REVIEW_REQUEST_LABELS[ref.type]} approvals are not revoked; change the limit instead${ref.type === "storage-limit" ? " (lumine admin storage grant)" : ""}.`,
    );
  }
  if (
    ["rewards", "cardcraft"].includes(ref.type) &&
    action !== "approve" &&
    !reason
  ) {
    throw cliValidationError(
      `${command} ${action} <id> needs --reason <text> the creator will read.`,
    );
  }
  const body = { decision: action, reason };
  if (options.adminConfigFile) {
    if (ref.type !== "rewards") {
      throw cliValidationError(
        "--config (earning rules) is only used with XP & Coin reward requests.",
      );
    }
    if (action !== "approve") {
      throw cliValidationError(
        "--config is only used with approve; rejections and revocations take --reason.",
      );
    }
    // Without --config the app's own proposal (rewards.json + sheet, frozen
    // in the request) is approved as it stands; --config replaces it.
    body.config = readRewardConfigFile(options.adminConfigFile);
  }
  if (options.storageSize) {
    if (ref.type !== "storage-limit") {
      throw cliValidationError(
        "--size is only used with Lumine file storage requests.",
      );
    }
    if (action !== "approve") {
      throw cliValidationError("--size is only used with approve.");
    }
    body.sizeBytes = parseAdminStorageSize(options.storageSize);
  }
  return writeOperation(
    "review.decide",
    "POST",
    `/cli/admin/reviews/${ref.type}/${ref.id}`,
    body,
    {
      requiresRun: false,
      reviewType: ref.type,
      reviewId: ref.id,
      decision: action,
    },
  );
}

// A reviewer counter-proposal for an XP & Coin reward request: the edited copy
// of the snapshot (from `show --dir`) plus the rules the creator's acceptance
// publishes.
function buildRewardProposalOperation(reviewId, options) {
  const reason = String(options.adminReason || "").trim();
  if (reason.length > 1000) {
    throw cliValidationError("--reason must be at most 1000 characters.");
  }
  if (!options.adminConfigFile) {
    throw cliValidationError(
      "lumine admin reward-review propose <id> needs --config <rules.json> (the rules the creator's acceptance publishes) and --dir <edited snapshot>.",
    );
  }
  const files = readRewardProposalDirectory(options.dir);
  return writeOperation(
    "reward-review.propose",
    "POST",
    `/cli/admin/reward-reviews/${reviewId}/propose`,
    {
      files,
      config: readRewardConfigFile(options.adminConfigFile),
      reason,
    },
    { requiresRun: false, reviewId, fileCount: files.length },
  );
}

const REWARD_PROPOSAL_MAX_FILES = 500;
const REWARD_PROPOSAL_MAX_BYTES = 5 * 1024 * 1024;
const REWARD_PROPOSAL_SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  ".lumine",
  ".twinkle",
]);

// Reads a reviewer's edited copy of a reward-review snapshot (a directory
// written by `show --dir`, then edited) back into project files for
// `reward-review propose`. Text files only; dotfiles and tool directories
// are skipped; paths are confined to the directory.
export function readRewardProposalDirectory(directory) {
  const requested = String(directory || "").trim();
  if (!requested) {
    throw cliValidationError(
      "Pass the edited snapshot directory with --dir <path>.",
    );
  }
  const root = path.resolve(requested);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw cliValidationError(`--dir ${root} does not exist.`);
  }
  if (!rootStat.isDirectory()) {
    throw cliValidationError(`--dir ${root} must be a directory.`);
  }
  const realRoot = realpathSync(root);
  const files = [];
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        REWARD_PROPOSAL_SKIPPED_DIRS.has(entry.name)
      )
        continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw cliValidationError(
          `Refusing to read symlink inside the proposal directory: ${fullPath}`,
        );
      }
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = readFileSync(fullPath);
      if (buffer.includes(0)) {
        throw cliValidationError(
          `${fullPath} is not a text file. Twinkle project files must be UTF-8 text; media belongs in build assets.`,
        );
      }
      bytes += buffer.length;
      const relative = path
        .relative(realRoot, fullPath)
        .split(path.sep)
        .join("/");
      files.push({ path: `/${relative}`, content: buffer.toString("utf8") });
    }
  };
  walk(realRoot);
  if (files.length === 0) {
    throw cliValidationError(`--dir ${root} holds no project files.`);
  }
  if (files.length > REWARD_PROPOSAL_MAX_FILES) {
    throw cliValidationError(
      `A proposal may carry at most ${REWARD_PROPOSAL_MAX_FILES} files.`,
    );
  }
  if (bytes > REWARD_PROPOSAL_MAX_BYTES) {
    throw cliValidationError("A proposal may carry at most 5 MB of files.");
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// The reviewer's earning rules for one Build reward approval: budgets plus
// server-verified numeric-quiz rules keyed by the rule IDs the app source
// starts challenges with. Validation is the server's; this only reads JSON.
export function readRewardConfigFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError(
      "Pass the earning rules with --config <rules.json> (userDailyXP, userDailyCoins, optional userDailyClaims, rules[]).",
    );
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_REWARD_CONFIG_FILE_BYTES) {
    throw cliValidationError("The earning rules file must be under 256KB.");
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw cliValidationError(`${normalizedPath} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw cliValidationError(
      "The earning rules file must be a JSON object with budgets and a rules array.",
    );
  }
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw cliValidationError(
      'Approval needs at least one earning rule in rules[] (id, title, xp, coins, verifier: "numeric-quiz", questions[{prompt, answer}] and/or sets[{from, to?, questions}], optional maxAttempts (null = unlimited) and retry {xpPercent, coinsPercent}).',
    );
  }
  return parsed;
}

// Writes the frozen source snapshot of a reward review into a local directory
// so the reviewing agent can read the exact code under review with ordinary
// tools. Paths are confined to the target directory; files are private.
export function writeRewardReviewSnapshot({ directory, files }) {
  const requested = String(directory || "").trim();
  if (!requested) {
    throw cliValidationError(
      "Pass a new or empty directory with --dir <path>.",
    );
  }
  const root = path.resolve(requested);
  if (root === path.resolve("/")) {
    throw cliValidationError(
      "Pass a new or empty directory with --dir <path>.",
    );
  }
  // The snapshot must land in a directory that holds nothing else, so the
  // reviewer never reads stale files from another review or clobbers a real
  // workspace, and so no pre-existing symlink can redirect a write.
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      readdirSync(root).length
    ) {
      throw cliValidationError(
        `--dir ${root} must be a new or empty directory (not a symlink, file, or populated folder).`,
      );
    }
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  const realRoot = realpathSync(root);
  const written = [];
  for (const file of Array.isArray(files) ? files : []) {
    const relative = String(file?.path || "").replace(/^\/+/, "");
    const target = path.resolve(realRoot, relative);
    if (
      !relative ||
      relative.includes("\\") ||
      !target.startsWith(`${realRoot}${path.sep}`)
    ) {
      throw cliValidationError(
        `Refusing to write snapshot path outside ${realRoot}: ${file?.path}`,
      );
    }
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!realpathSync(path.dirname(target)).startsWith(realRoot)) {
      throw cliValidationError(
        `Refusing to write snapshot path outside ${realRoot}: ${file?.path}`,
      );
    }
    const content = String(file?.content ?? "");
    // 'wx' creates a fresh file only; an existing entry (or symlink) fails.
    writeFileSync(target, content, { mode: 0o600, flag: "wx" });
    written.push({
      path: `/${relative}`,
      bytes: Buffer.byteLength(content, "utf8"),
      savedTo: target,
    });
  }
  return { directory: realRoot, files: written };
}

function readEditorialFile(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    throw cliValidationError(
      "Pass the editorial JSON with --file <editorial.json>.",
    );
  }
  let contents;
  try {
    contents = readFileSync(normalizedPath, "utf8");
  } catch {
    throw cliValidationError(`Could not read ${normalizedPath}.`);
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_EDITORIAL_FILE_BYTES) {
    throw cliValidationError("The editorial file must be under 256KB.");
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw cliValidationError(`${normalizedPath} is not valid JSON.`);
  }
}

export async function adminCommand(options) {
  const [namespace, action] = options.positional || [];
  const composite =
    namespace === "daily-run" && action === "gather"
      ? dailyRunGather
      : namespace === "daily-run" && action === "progress"
        ? dailyRunProgress
        : namespace === "featured" && action === "candidates"
          ? featuredCandidates
          : namespace === "report" && action === "serve"
            ? reportServe
            : null;
  if (composite) {
    const result = await composite(options);
    if (options.adminOutput) {
      writeFileSync(options.adminOutput, JSON.stringify(result), {
        mode: 0o600,
      });
    }
    console.log(JSON.stringify(result, null, options.json ? 0 : 2));
    if (result && result.ok === false) process.exitCode = 1;
    return result;
  }
  const operation = parseAdminOperation(options);
  if (operation.name === "news.validate") {
    const validation = validateNewsEditorial({
      claim: operation.claim,
      editorial: operation.editorial,
    });
    const result = {
      ok: true,
      status: "success",
      changed: false,
      data: { validation },
    };
    return finishAdminOutput({ options, operation, result });
  }
  const viewFilter = resolveOperatorViewFilter({
    operation,
    unviewed: options.adminUnviewed,
    viewed: options.adminViewed,
  });
  const recommendationContentTypes =
    operation.name === "recommendations.list"
      ? parseRecommendationContentTypes(options.adminContentTypes)
      : null;
  const auth = await resolveAuth(options);
  const authSession = await assertAuthScope({
    options,
    auth,
    scope: operation.mutates ? "build:write" : "build:read",
  });
  let runId = 0;
  let runScope = null;
  let correctionSessionId = 0;
  let correctionSession = null;
  let commentSessionId = 0;
  let commentSession = null;
  if (adminOperationRequiresRun(operation)) {
    if (operation.correctionEligible) {
      const correctionStatus = await requestJson({
        url: `${options.apiUrl}/cli/admin/corrections/status`,
        authToken: auth.token,
        timeoutMs: options.timeoutMs,
      });
      const correction = correctionStatus?.data?.correction || null;
      if (
        correction?.status === "active" &&
        Number(correction.correctionCommentId || 0) ===
          Number(operation.correctionCommentId || 0)
      ) {
        correctionSessionId = Number(correction.id || 0);
        correctionSession = correction;
      }
    }
    if (!correctionSessionId && adminOperationUsesCommentSession(operation)) {
      commentSession = await loadActiveCommentSession({
        options,
        authToken: auth.token,
      });
      commentSessionId = Number(commentSession?.id || 0);
    }
    // Look up the daily run too: when both are active the caller must choose
    // one (--via), and exactly one authority is sent.
    const runStatus = correctionSessionId
      ? null
      : await requestJson({
          url: `${options.apiUrl}/cli/admin/daily-runs/status`,
          authToken: auth.token,
          timeoutMs: options.timeoutMs,
        });
    const activeRun = runStatus?.data?.run || null;
    const retryableFinishedRun = [
      "daily-run.complete",
      "daily-run.fail",
    ].includes(operation.name)
      ? runStatus?.data?.lastRun || null
      : null;
    let selectedRun = activeRun || retryableFinishedRun;
    const via = parseAdminVia(options.adminVia, operation);
    if (via && correctionSessionId) {
      throw cliValidationError(
        `Correction session #${correctionSessionId} is active for this comment and handles it; drop --via or complete the correction first.`,
      );
    }
    if (commentSessionId && selectedRun) {
      let choice = via;
      if (!choice) {
        if (COMMENT_SESSION_WRITE_OPERATIONS.has(operation.name)) {
          throw cliValidationError(
            `Both comment session #${commentSessionId} (${commentSession.identity?.key || "unknown"}) and daily run #${selectedRun.id} (${selectedRun.identity?.key || "unknown"}) are active. Choose which one this ${operation.name} uses with --via session or --via run.`,
          );
        }
        // Reads create nothing; without --via they keep using the daily run.
        choice = "run";
      }
      if (choice === "session") {
        selectedRun = null;
      } else {
        commentSessionId = 0;
        commentSession = null;
      }
    } else if (via === "session" && !commentSessionId) {
      throw cliValidationError(
        "--via session: no comment session is active. Start one with lumine admin comment session start.",
      );
    } else if (via === "run" && !selectedRun && !correctionSessionId) {
      throw noActiveRunError();
    }
    runId = Number(selectedRun?.id || 0);
    if (
      !runId &&
      !correctionSessionId &&
      !commentSessionId &&
      !operation.runOptional
    ) {
      if (operation.correctionEligible) {
        const error = new Error(
          `Start a correction session first: lumine admin correction start ${operation.correctionCommentId}.`,
        );
        error.code = "CLI_ADMIN_CORRECTION_NOT_ACTIVE";
        throw error;
      }
      throw noActiveRunError();
    }
    if (selectedRun) {
      runScope = canonicalAdminRunScope(selectedRun);
      assertAdminOperationAllowedForRunScope({ operation, runScope });
    }
    if (options.adminIdentity && commentSession) {
      const requestedIdentity = parseIdentity(options.adminIdentity);
      if (
        requestedIdentity !== "auto" &&
        requestedIdentity !== commentSession.identity?.key
      ) {
        throw cliValidationError(
          `--identity ${requestedIdentity} does not match comment session #${commentSessionId} (${commentSession.identity?.key || "unknown"}).`,
        );
      }
    } else if (options.adminIdentity && (selectedRun || correctionSession)) {
      const requestedIdentity = parseIdentity(options.adminIdentity);
      const canonicalIdentity = correctionSession
        ? correctionSession.identity?.key
        : selectedRun?.identity?.key;
      if (
        requestedIdentity !== "auto" &&
        requestedIdentity !== canonicalIdentity
      ) {
        throw cliValidationError(
          correctionSession
            ? `--identity ${requestedIdentity} does not match correction session #${correctionSessionId} (${canonicalIdentity || "unknown"}).`
            : `--identity ${requestedIdentity} does not match active run #${runId} (${canonicalIdentity || "unknown"}).`,
        );
      }
    }
  }
  const mutationIntent =
    operation.mutates &&
    !operation.featuredWorkflow &&
    operation.name !== "post.skip-batch" &&
    !operation.name.startsWith("runtime-logs.")
      ? prepareAdminMutationIntent({
          operation,
          apiUrl: options.apiUrl,
          authority: {
            account: canonicalAdminAccount(authSession),
            runId,
            correctionSessionId,
            commentSessionId,
          },
          idempotencyKey: options.idempotencyKey,
        })
      : null;
  const requestId =
    mutationIntent?.requestId ||
    options.idempotencyKey ||
    (operation.mutates ? `cli:${randomUUID()}` : "");
  let result;
  try {
    const fetchOperation = async (requestPath = operation.path, signal) => {
      const receipt = await requestJson({
        method: operation.method,
        url: `${options.apiUrl}${requestPath}`,
        authToken: auth.token,
        body: operation.body,
        headers: {
          ...(runId ? { "x-lumine-admin-run-id": String(runId) } : {}),
          ...(correctionSessionId
            ? {
                "x-lumine-admin-correction-session-id":
                  String(correctionSessionId),
              }
            : {}),
          ...(commentSessionId
            ? {
                "x-lumine-admin-comment-session-id": String(commentSessionId),
              }
            : {}),
          ...(requestId ? { "x-lumine-idempotency-key": requestId } : {}),
        },
        // Long operations (reward-bank seed) carry their own timeout.
        // An operation's own timeout is a floor: a longer --timeout still wins.
        timeoutMs:
          Math.max(
            Number(operation.timeoutMs) || 0,
            Number(options.timeoutMs) || 0,
          ) || undefined,
        signal,
      });
      if (
        typeof receipt.ok !== "boolean" ||
        typeof receipt.status !== "string"
      ) {
        const error = new Error(
          "The API did not return a valid admin receipt. The request outcome is unconfirmed.",
        );
        error.code = "CLI_ADMIN_RECEIPT_INVALID";
        throw error;
      }
      return receipt;
    };
    const transformResult = (rawResult) =>
      transformAdminResult({
        operation,
        result: rawResult,
        options,
        recommendationContentTypes,
        viewFilter,
      });
    if (operation.featuredWorkflow) {
      result = await runFeaturedWorkflow({
        options,
        operation,
        authToken: auth.token,
        runId,
      });
    } else if (operation.name === "build.review") {
      result = await runManagedBuildReview({
        options,
        authToken: auth.token,
        buildId: operation.buildId,
      });
    } else if (operation.name === "post.skip-batch") {
      result = await runBatchSkips({
        options,
        authToken: auth.token,
        runId,
        parseTarget: parseRecommendationTarget,
      });
    } else if (operation.teacherWorkflow) {
      result = await runTeacherWorkflow({
        options,
        operation,
        authToken: auth.token,
        requestId,
      });
    } else if (operation.name.startsWith("runtime-logs.")) {
      result = await runAdminRuntimeLogWorkflow({
        options,
        operation,
        authToken: auth.token,
        requestId,
      });
    } else if (options.adminAll) {
      if (options.adminCursor) {
        throw cliValidationError(
          "Use --resume with the scan checkpoint instead of combining --all with --cursor.",
        );
      }
      const paginate =
        operation.name === "featured.history" &&
        operation.pagination.filters.subjectIds.length >
          FEATURED_HISTORY_BATCH_SIZE
          ? runBatchedFeaturedHistory
          : runAutomaticPagination;
      result = await paginate({
        options,
        operation,
        runId,
        fetchPage: fetchOperation,
        transformPage: transformResult,
        recordCoverage: shouldRecordAdminQueueCoverage(runScope)
          ? async (coverage, signal) =>
              requestJson({
                method: "POST",
                url: `${options.apiUrl}/cli/admin/daily-runs/coverage`,
                authToken: auth.token,
                body: coverage,
                headers: {
                  "x-lumine-admin-run-id": String(runId),
                  "x-lumine-idempotency-key": `cli:queue-coverage:${runId}:${adminValueFingerprint(coverage).slice(0, 32)}`,
                },
                timeoutMs: options.timeoutMs,
                signal,
              })
          : undefined,
      });
    } else {
      if (options.adminResume) {
        throw cliValidationError("--resume requires --all or post skip-batch.");
      }
      result = transformResult(await fetchOperation());
    }
    // private evidence is printed, never kept in the receipt file
    mutationIntent?.confirm(receiptToKeep(operation, result));
  } catch (error) {
    if (operation.name === "runtime.evidence" && error.status === 404) {
      error.code = "CLI_ADMIN_RUNTIME_EVIDENCE_NOT_DEPLOYED";
      error.message =
        "The runtime evidence route is not deployed on the requested host. Evidence is unknown; deploy the matching API and activate the collector in an authorized primary-generation release. No restart or host substitution was attempted.";
      error.data = {
        ok: false,
        status: "unavailable",
        error: {
          code: error.code,
          message: error.message,
          details: { httpStatus: 404 },
        },
      };
    }
    if (operation.featuredWorkflow && error.featuredProgress) {
      const serverError = error.data?.error;
      error.data = {
        ok: false,
        status: "partial_failure",
        error: {
          code:
            serverError?.code ||
            error.code ||
            "LUMINE_ADMIN_FEATURED_WORKFLOW_FAILED",
          message: error.message,
          details: {
            ...(serverError && typeof serverError === "object"
              ? serverError.details
              : {}),
            ...error.featuredProgress,
            retryInstruction:
              "Resume the exact command with --resume; confirmed items are not replayed.",
          },
        },
      };
    }
    if (
      operation.mutates &&
      requestId &&
      !operation.featuredWorkflow &&
      operation.name !== "post.skip-batch"
    ) {
      const retryInstruction = `Retry with --idempotency-key ${requestId}.`;
      error.data = error.data || {
        ok: false,
        status: "error",
        error: {
          code: error.code || "LUMINE_ADMIN_REQUEST_FAILED",
          message: String(error.message || "The administrator request failed."),
          details: null,
        },
      };
      if (error.data?.error) {
        const details =
          error.data.error.details &&
          typeof error.data.error.details === "object" &&
          !Array.isArray(error.data.error.details)
            ? error.data.error.details
            : {};
        error.data.error.details = {
          ...details,
          retryIdempotencyKey: requestId,
        };
      }
      error.message = `${error.message} ${retryInstruction}`;
    }
    throw error;
  }
  if (
    operation.name === "comment.draft" &&
    typeof operation.body?.content === "string"
  ) {
    assertComposedCommentDraftResult({
      result,
      expectedContent: operation.body.content,
      requiresBuildReviewContext:
        typeof operation.body.buildReviewUnderstanding === "string",
    });
  }
  if (operation.name === "comment.edit") {
    assertComposedCommentEditResult({ result, body: operation.body });
  }
  if (operation.name === "ai-email-policy.set") {
    assertAiEmailPolicySetResult({ operation, result });
  }
  if (operation.name === "daily-run.start") {
    assertAdminTodoHandoffResult(result, operation.body.scope);
  }
  if (
    (operation.name === "reward-review.show" ||
      operation.name === "review.show") &&
    operation.snapshotDir
  ) {
    // The snapshot leaves the JSON result and lands on disk, where the agent
    // reads it like any pulled workspace; the result keeps sizes and paths.
    const review = result?.data?.review || {};
    const snapshot = writeRewardReviewSnapshot({
      directory: operation.snapshotDir,
      files: review.files,
    });
    result = {
      ...result,
      data: {
        ...(result.data || {}),
        review: { ...review, files: snapshot.files },
        snapshotDirectory: snapshot.directory,
      },
    };
  }
  if (operation.name === "chat-reports.export" && operation.evidenceDir) {
    // The package goes to disk only; the printed result keeps paths, sizes
    // and hashes, never the evidence itself.
    const written = writeEvidencePackage({
      directory: operation.evidenceDir,
      files: result?.data?.files,
    });
    const { files: _files, manifest: _manifest, ...summary } = result?.data || {};
    if (
      summary.manifestSha256 &&
      summary.manifestSha256 !== written.manifestSha256
    ) {
      const error = new Error(
        "The written manifest.json does not match the hash the server recorded. Export again into a new directory.",
      );
      error.code = "LUMINE_ADMIN_EVIDENCE_HASH_MISMATCH";
      throw error;
    }
    result = {
      ...result,
      data: { ...summary, evidenceDirectory: written.directory, files: written.files },
    };
  }
  if (operation.name === "news.claim") {
    const artifacts = writeNewsClaimArtifacts({
      result,
      outputPath: options.adminOutput,
      scaffoldPath: options.adminScaffoldFile,
    });
    result = {
      ...result,
      data: { ...(result.data || {}), artifacts },
    };
  }
  const output = await finishAdminOutput({ options, operation, result });
  mutationIntent?.delivered();
  return output;
}

function canonicalAdminAccount(session) {
  const userId = Number(session?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw cliValidationError(
      "The API did not confirm the signed-in account. The mutation was not sent.",
    );
  }
  return userId;
}

function transformAdminResult({
  operation,
  result,
  options,
  recommendationContentTypes,
  viewFilter,
}) {
  let transformed = result;
  if (operation.name === "recommendations.list") {
    assertRecommendationWindowResult({ operation, result: transformed });
  }
  if (operation.name === "subjects.candidates") {
    assertSubjectWindowResult({ operation, result: transformed });
  }
  if (operation.name === "builds.candidates") {
    assertBuildWindowResult({ operation, result: transformed });
    transformed = normalizeAdminBuildCandidatesResult({
      result: transformed,
      siteUrl: options.siteUrl,
    });
  }
  if (recommendationContentTypes) {
    transformed = filterRecommendationQueueResult({
      result: transformed,
      contentTypes: recommendationContentTypes,
    });
  }
  if (viewFilter) {
    transformed = filterListResultByOperatorView({
      result: transformed,
      viewFilter,
    });
  }
  return transformed;
}

export function assertRecommendationWindowResult({ operation, result }) {
  const mode = operation?.pagination?.coverageMode;
  if (!mode || mode === "legacy") return;
  const after = result?.data?.pagination?.after;
  const snapshotTimeStamp = result?.data?.pagination?.snapshotTimeStamp;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(snapshotTimeStamp) ||
    snapshotTimeStamp < 0
  ) {
    const error = new Error(
      "The deployed API did not confirm the bounded recommendation window and snapshot. Deploy the matching API before using this CLI; use --include-legacy only for an intentional historical scan.",
    );
    error.code = "LUMINE_ADMIN_RECOMMENDATION_WINDOW_UNSUPPORTED";
    error.data = {
      ok: false,
      status: "validation_error",
      error: {
        code: error.code,
        message: error.message,
        details: { requestedMode: mode },
      },
    };
    throw error;
  }
}

export function assertSubjectWindowResult({ operation, result }) {
  const mode = operation?.pagination?.coverageMode;
  if (!mode || mode === "legacy") return;
  const after = result?.data?.pagination?.after;
  const snapshotTimeStamp = result?.data?.pagination?.snapshotTimeStamp;
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(snapshotTimeStamp) ||
    snapshotTimeStamp < 0
  ) {
    const error = new Error(
      "The deployed API did not confirm the bounded Subject window and snapshot. Deploy the matching API before using this CLI; use --include-legacy only for an intentional historical scan.",
    );
    error.code = "LUMINE_ADMIN_SUBJECT_WINDOW_UNSUPPORTED";
    error.data = {
      ok: false,
      status: "validation_error",
      error: {
        code: error.code,
        message: error.message,
        details: { requestedMode: mode },
      },
    };
    throw error;
  }
}

async function finishAdminOutput({ options, operation, result }) {
  const paginationStorage = getPaginatedResultStorage(result);
  if (
    options.adminOutput &&
    !paginationStorage &&
    operation.name !== "news.claim" &&
    operation.name !== "post.skip-batch"
  ) {
    writeAdminResultOutput({
      filePath: options.adminOutput,
      result,
      operation,
    });
  }
  if (options.json) {
    if (paginationStorage) {
      await writePaginatedResultJson({
        result,
        write: async (chunk) => {
          if (!process.stdout.write(chunk)) {
            await once(process.stdout, "drain");
          }
        },
      });
    } else {
      console.log(JSON.stringify(result));
    }
    return result;
  }
  if (paginationStorage) {
    await printSpooledAdminResult({
      operation,
      result,
      storage: paginationStorage,
    });
    return result;
  }
  printAdminResult({ operation, result });
  return result;
}

export function writeAdminResultOutput({ filePath, result, operation }) {
  try {
    return writeAdminJsonFile(filePath, result, { privateFile: true });
  } catch (cause) {
    const error = new Error(
      `The canonical ${operation.name} result was received, but --output could not be saved: ${cause.message}. Do not repeat a successful mutation just to save its output.`,
    );
    error.code = "LUMINE_ADMIN_OUTPUT_WRITE_FAILED";
    error.data = {
      ok: false,
      status: "error",
      error: {
        code: error.code,
        message: error.message,
        details: { canonicalResult: result, outputPath: String(filePath) },
      },
    };
    throw error;
  }
}

export function normalizeAdminBuildCandidatesResult({ result, siteUrl }) {
  const builds = result.data.builds;
  return {
    ...result,
    data: {
      ...result.data,
      builds: builds.map((build) => {
        const id = Number(build?.id || 0);
        return {
          ...build,
          url:
            id > 0
              ? `${String(siteUrl || "").replace(/\/$/, "")}/app/${id}`
              : null,
          review: {
            publishedArtifactVersionId:
              Number(build?.publishedArtifactVersionId || 0) || null,
            codePullAvailable: build?.collaborationMode === "open_source",
            requiredBeforeComment: true,
          },
        };
      }),
    },
  };
}

export function assertBuildWindowResult({ operation, result }) {
  const p = result?.data?.pagination;
  const mode = operation?.pagination?.coverageMode;
  if (
    result?.ok !== true ||
    !Array.isArray(result?.data?.builds) ||
    !p ||
    p.mode !== mode ||
    !Number.isSafeInteger(p.snapshotMaxId) ||
    p.snapshotMaxId < 0 ||
    !Number.isSafeInteger(p.snapshotTimeStamp) ||
    p.snapshotTimeStamp < 0 ||
    (mode === "legacy"
      ? p.after !== null
      : !Number.isSafeInteger(p.after) || p.after < 0) ||
    (mode === "after" && p.after !== operation.pagination.after) ||
    typeof p.exhausted !== "boolean" ||
    p.hasMore !== !p.exhausted ||
    (p.exhausted
      ? p.nextCursor !== null
      : typeof p.nextCursor !== "string" || !p.nextCursor)
  ) {
    const error = new Error(
      "The API did not confirm the requested published-Build window and snapshot. Deploy the matching API; do not substitute an unbounded public browser scan.",
    );
    error.code = "LUMINE_ADMIN_BUILD_WINDOW_UNSUPPORTED";
    throw error;
  }
}

export function assertComposedCommentEditResult({ result, body }) {
  const edit = result?.data?.edit;
  if (
    result?.ok === true &&
    result?.data?.comment?.content === body.content &&
    (!body.buildReviewUnderstanding ||
      (edit?.buildReviewContextStored === true &&
        edit?.reviewedBuildVersionId === body.reviewedBuildVersionId &&
        Number.isSafeInteger(edit?.managementDraftId) &&
        edit.managementDraftId > 0))
  )
    return;
  const error = new Error(
    "The API did not confirm the exact comment edit and its required Build review context. Inspect the canonical result before retrying; deploy the matching API if unsupported.",
  );
  error.code = "LUMINE_ADMIN_COMMENT_EDIT_UNCONFIRMED";
  error.data = {
    ok: false,
    status: "validation_error",
    error: {
      code: error.code,
      message: error.message,
      details: { canonicalResult: result },
    },
  };
  throw error;
}

function readAdminBuildReviewEvidence(options, parsedTarget) {
  const version = options.adminReviewedBuildVersion
    ? parseRequiredInteger(
        options.adminReviewedBuildVersion,
        "--reviewed-version",
        1,
      )
    : undefined;
  const method = options.adminBuildReviewMethod
    ? parseAdminBuildReviewMethod(options.adminBuildReviewMethod)
    : undefined;
  const receipt = options.adminReviewReceipt
    ? parseBuildReviewReceipt(options.adminReviewReceipt)
    : null;
  const understanding = options.adminReviewContext
    ? readBuildReviewContextFile(options.adminReviewContext)
    : undefined;
  if (receipt && (version || method)) {
    throw cliValidationError(
      "Pass either --review-receipt or manual --reviewed-version/--reviewed-via evidence, not both.",
    );
  }
  const reviewedBuildVersionId = receipt
    ? Number(receipt.publishedArtifactVersionId)
    : version;
  const buildReviewMethod = receipt ? "runtime" : method;
  if (understanding && (!reviewedBuildVersionId || !buildReviewMethod)) {
    throw cliValidationError(
      "--review-context requires confirmed Build review evidence.",
    );
  }
  if ((reviewedBuildVersionId || buildReviewMethod) && !understanding) {
    throw cliValidationError(
      "Build review evidence requires --review-context <context.json>.",
    );
  }
  if (
    receipt &&
    parsedTarget.type === "build" &&
    Number(receipt.buildId) !== parsedTarget.id
  ) {
    throw cliValidationError(
      "The review receipt belongs to a different Build.",
    );
  }
  if (
    !["build", "comment"].includes(parsedTarget.type) &&
    (reviewedBuildVersionId || buildReviewMethod)
  ) {
    throw cliValidationError(
      "Build review evidence applies only to build:<id> or a comment:<id> inside a Build.",
    );
  }
  return {
    ...(reviewedBuildVersionId ? { reviewedBuildVersionId } : {}),
    ...(buildReviewMethod ? { buildReviewMethod } : {}),
    ...(understanding ? { buildReviewUnderstanding: understanding } : {}),
  };
}

export function assertComposedCommentDraftResult({
  result,
  expectedContent,
  requiresBuildReviewContext = false,
}) {
  const draft = result?.data?.draft;
  if (
    draft?.decision === "draft" &&
    draft?.reason === "operator-composed" &&
    draft?.content === expectedContent &&
    draft?.status === "ready"
  ) {
    if (
      requiresBuildReviewContext &&
      draft?.buildReviewContextStored !== true
    ) {
      const error = new Error(
        "The API did not confirm that it stored the private Build review context. Stop without publishing this draft and deploy the context-aware API first, then retry with a new idempotency key.",
      );
      error.code = "LUMINE_ADMIN_BUILD_REVIEW_CONTEXT_UNSUPPORTED";
      error.data = {
        ok: false,
        status: "validation_error",
        error: {
          code: error.code,
          message: error.message,
          details: null,
        },
      };
      throw error;
    }
    return;
  }
  const error = new Error(
    "The API did not confirm the operator-composed draft. Stop without publishing it and deploy an API that supports composed drafts.",
  );
  error.code = "LUMINE_ADMIN_COMPOSED_COMMENT_UNSUPPORTED";
  error.data = {
    ok: false,
    status: "validation_error",
    error: {
      code: error.code,
      message: error.message,
      details: null,
    },
  };
  throw error;
}

export function assertAiEmailPolicySetResult({ operation, result }) {
  const requestedEmail = String(operation?.body?.email || "");
  const requestedMode = String(operation?.body?.mode || "");
  const policy = result?.data?.policy;
  const projection = result?.data?.projection;
  const accountUserIds = Array.isArray(result?.data?.accountUserIds)
    ? result.data.accountUserIds
    : [];
  const accountCount = Number(result?.data?.accountCount);
  const expectedIdentityType =
    requestedMode === "separate_accounts"
      ? "separate_verified_email"
      : "verified_email";
  if (
    policy?.exists === true &&
    policy?.normalizedEmail === requestedEmail &&
    policy?.mode === requestedMode &&
    Number.isSafeInteger(accountCount) &&
    accountCount >= 0 &&
    accountUserIds.length === accountCount &&
    projection?.expectedIdentityType === expectedIdentityType &&
    projection?.accountCount === accountCount &&
    projection?.matchingAccountCount === accountCount &&
    Array.isArray(projection?.mismatchedAccountUserIds) &&
    projection.mismatchedAccountUserIds.length === 0 &&
    projection?.converged === true
  ) {
    return;
  }
  const error = new Error(
    "The API did not confirm that every matching account converged to the requested AI email policy. Retry only after reviewing the canonical response and deployed API.",
  );
  error.code = "LUMINE_ADMIN_AI_EMAIL_POLICY_NOT_CONVERGED";
  error.data = {
    ok: false,
    status: "partial_failure",
    error: {
      code: error.code,
      message: error.message,
      details: {
        requestedEmail,
        requestedMode,
        canonical: result?.data || null,
      },
    },
  };
  throw error;
}

const RECOMMENDATION_CONTENT_TYPES = new Map([
  ["comment", "comment"],
  ["aistory", "aiStory"],
  ["dailyreflection", "dailyReflection"],
]);

export function parseRecommendationContentTypes(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const contentTypes = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => RECOMMENDATION_CONTENT_TYPES.get(item.toLowerCase()));
  if (
    contentTypes.length === 0 ||
    contentTypes.some((contentType) => !contentType) ||
    new Set(contentTypes).size !== contentTypes.length
  ) {
    throw cliValidationError(
      "--content-types accepts comment, aiStory, and dailyReflection.",
    );
  }
  return [...new Set(contentTypes)];
}

export function filterRecommendationQueueResult({ result, contentTypes }) {
  const items = Array.isArray(result?.data?.items) ? result.data.items : [];
  const allowed = new Set(contentTypes);
  const filteredItems = items.filter((item) => allowed.has(item?.contentType));
  return {
    ...result,
    data: {
      ...result.data,
      items: filteredItems,
      clientFilter: {
        contentTypes,
        excludedItems: items.length - filteredItems.length,
      },
    },
  };
}

// Escalation lists are only useful when they exclude what Mikey already read,
// so list output can be narrowed by his own view state. The server stamps
// `operatorViewed` on every listed item; an item missing the field (an older
// deployed API) is treated as unknown and kept, so the filter can never hide
// something by accident.
export function filterListResultByOperatorView({ result, viewFilter }) {
  if (!viewFilter) return result;
  const collections = ["items", "subjects", "comments"];
  const data = { ...(result?.data || {}) };
  let excluded = 0;
  let unknown = 0;
  for (const key of collections) {
    if (!Array.isArray(data[key])) continue;
    const kept = data[key].filter((entry) => {
      const state = entry?.operatorViewed;
      if (!state || typeof state.viewed !== "boolean") {
        unknown += 1;
        return true;
      }
      const keep = viewFilter === "unviewed" ? !state.viewed : state.viewed;
      if (!keep) excluded += 1;
      return keep;
    });
    data[key] = kept;
  }
  return {
    ...result,
    data: {
      ...data,
      operatorViewFilter: {
        mode: viewFilter,
        excludedItems: excluded,
        unknownStateItems: unknown,
      },
    },
  };
}

export function parseOperatorViewFilter({ unviewed, viewed }) {
  if (unviewed && viewed) {
    throw cliValidationError("Pass either --unviewed or --viewed, not both.");
  }
  if (unviewed) return "unviewed";
  if (viewed) return "viewed";
  return null;
}

const OPERATOR_VIEW_FILTER_OPERATIONS = new Set([
  "recommendations.list",
  "subjects.candidates",
  "featured.list",
  "subject.comments",
  "post.comments",
]);

export function resolveOperatorViewFilter({ operation, unviewed, viewed }) {
  const viewFilter = parseOperatorViewFilter({ unviewed, viewed });
  if (!viewFilter) return null;
  if (OPERATOR_VIEW_FILTER_OPERATIONS.has(operation.name)) return viewFilter;
  throw cliValidationError(
    "--unviewed and --viewed are supported only by admin content-list commands.",
  );
}

function requestedOperatorViewFilter(options) {
  return options.adminUnviewed
    ? "unviewed"
    : options.adminViewed
      ? "viewed"
      : null;
}

export function canonicalAdminRunScope(run) {
  const raw = run?.runScope;
  if (raw === undefined || raw === null || raw === "") return "full";
  const scope = String(raw);
  if (["full", "featured", "newspaper"].includes(scope)) return scope;
  throw cliValidationError(
    "The API returned an invalid administrator run scope.",
  );
}

export function shouldRecordAdminQueueCoverage(runScope) {
  return runScope === "full";
}

const FEATURED_RUN_OPERATIONS = new Set([
  "subjects.candidates",
  "subject.get",
  "subject.comments",
  "subject.reveal",
  "subject.feature",
  "subject.unfeature",
  "featured.list",
  "featured.history",
  "featured.add",
  "featured.reorder",
  "featured.rotate",
  "featured.plan",
  "featured.apply",
  "featured.comments.scan",
  "featured.comments.acknowledge",
  "featured.comments.recommend",
  "featured.comments.report",
  "daily-run.complete",
  "daily-run.fail",
]);

export function assertAdminOperationAllowedForRunScope({
  operation,
  runScope,
}) {
  if (runScope === "newspaper") {
    if (
      [
        "news.status",
        "news.claim",
        "news.submit",
        "news.print",
        "daily-run.complete",
        "daily-run.fail",
      ].includes(operation.name)
    )
      return;
    throw cliValidationError(
      `A newspaper-only run does not authorize ${operation.name}.`,
    );
  }
  if (runScope !== "featured") return;
  const subjectCommentAlias =
    operation.name === "post.comments" &&
    /^\/cli\/admin\/subjects\/\d+\/comments(?:\?|$)/.test(operation.path);
  if (FEATURED_RUN_OPERATIONS.has(operation.name) || subjectCommentAlias) {
    return;
  }
  throw cliValidationError(
    `A Featured-only run does not authorize ${operation.name}. Use the review-bound Featured comment workflow for encouragement; do not start unrelated daily work to bypass scope.`,
  );
}

// Commands a standalone comment session can serve: drafting, replying,
// publishing and editing its own comments, plus the reads needed to compose
// on its targets. The API still enforces the session's target lock on each.
const COMMENT_SESSION_WRITE_OPERATIONS = new Set([
  "comment.draft",
  "comment.post",
  "comment.edit",
]);
const COMMENT_SESSION_OPERATIONS = new Set([
  ...COMMENT_SESSION_WRITE_OPERATIONS,
  "subject.get",
  "subject.comments",
  "post.get",
  "post.comments",
]);

export function adminOperationUsesCommentSession(operation) {
  return COMMENT_SESSION_OPERATIONS.has(operation?.name);
}

export function parseAdminVia(value, operation) {
  const via = String(value || "").trim().toLowerCase();
  if (!via) return "";
  if (via !== "session" && via !== "run") {
    throw cliValidationError("--via must be session or run.");
  }
  if (!adminOperationUsesCommentSession(operation)) {
    throw cliValidationError(
      "--via applies only to comment draft/reply/post/edit and the subject/post/comment reads.",
    );
  }
  return via;
}

async function loadActiveCommentSession({ options, authToken }) {
  let status;
  try {
    status = await requestJson({
      url: `${options.apiUrl}/cli/admin/comment-sessions/status`,
      authToken,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    // An API without comment sessions yet: keep daily runs working.
    if (error?.status === 404) return null;
    throw error;
  }
  const session = status?.data?.commentSession || null;
  return session?.status === "active" && Number(session.id) > 0
    ? session
    : null;
}

export function parseCommentSessionTargets(values) {
  const raw = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!raw.length) {
    throw cliValidationError(
      "Name the targets with --target <subject:ID|comment:ID|build:ID|aiStory:ID|dailyReflection:ID>[,...].",
    );
  }
  const seen = new Set();
  const targets = [];
  for (const value of raw) {
    const target = parseAdminCommentTarget({ target: value });
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function adminOperationRequiresRun(operation) {
  if (typeof operation.requiresRun === "boolean") {
    return operation.requiresRun;
  }
  return (
    ![
      "identity.list",
      "identity.status",
      "identity.use",
      "identity.inspect",
      "economy.trace",
      "bot.context",
      "rescue.wordle.audit",
      "daily-run.start",
      "daily-run.status",
      "correction.start",
      "correction.status",
      "correction.complete",
      "comment-session.start",
      "comment-session.status",
      "comment-session.close",
      "escalation.list",
      "escalation.set",
      "notable.add",
      "notable.remove",
      "notable.status",
      "runtime-logs.start",
      "runtime-logs.status",
      "runtime-logs.capture",
      "runtime-logs.complete",
      "runtime-logs.resume",
      "runtime-logs.abandon",
      "energy-budget.report",
    ].includes(operation.name) &&
    !operation.name.startsWith("ai-bucket.") &&
    !operation.name.startsWith("ai-email-policy.") &&
    !operation.name.startsWith("todo.")
  );
}

function noActiveRunError() {
  const error = new Error(
    "Start a delegated administrator daily run before using this command.",
  );
  error.code = "CLI_ADMIN_NO_ACTIVE_RUN";
  error.data = {
    ok: false,
    status: "validation_error",
    error: {
      code: error.code,
      message: error.message,
      details: null,
    },
  };
  return error;
}

function requireChatSafetyNote(value) {
  const note = String(value || "").trim();
  if (!note) {
    throw cliValidationError(
      "Say why with --note <text>; it is kept in the safety audit trail.",
    );
  }
  if (note.length > 2000) {
    throw cliValidationError("--note must be at most 2000 characters.");
  }
  return note;
}

function parseIdList(value, label) {
  const ids = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseRequiredInteger(part, label, 1));
  if (!ids.length) throw cliValidationError(`${label} needs at least one id.`);
  return Array.from(new Set(ids));
}

// Writes a child-safety evidence package into a new or empty private
// directory and checks every written file against the server's SHA-256
// manifest, so what lands on disk is exactly what the server hashed.
export function writeEvidencePackage({ directory, files }) {
  const list = Array.isArray(files) ? files : [];
  const manifestFile = list.find((file) => file?.path === "manifest.json");
  if (!manifestFile) {
    throw cliValidationError("The evidence package has no manifest.json.");
  }
  let manifest;
  try {
    manifest = JSON.parse(String(manifestFile.content || ""));
  } catch {
    throw cliValidationError("The evidence manifest is not valid JSON.");
  }
  let written;
  try {
    written = writeRewardReviewSnapshot({ directory, files: list });
  } catch (error) {
    error.message = String(error.message || "").replaceAll("--dir", "--out");
    throw error;
  }
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const mismatches = [];
  for (const entry of manifest.files || []) {
    const target = path.join(written.directory, entry.path);
    const actual = existsSync(target) ? sha(readFileSync(target)) : "missing";
    if (actual !== entry.sha256) mismatches.push(entry.path);
  }
  const listed = new Set((manifest.files || []).map((entry) => entry.path));
  for (const file of list) {
    if (file.path !== "manifest.json" && !listed.has(file.path)) {
      mismatches.push(file.path);
    }
  }
  if (mismatches.length) {
    const error = new Error(
      `The evidence package in ${written.directory} does not match its manifest (${mismatches.join(", ")}). Do not hand it over; export again into a new directory.`,
    );
    error.code = "LUMINE_ADMIN_EVIDENCE_HASH_MISMATCH";
    throw error;
  }
  return {
    directory: written.directory,
    manifestSha256: sha(readFileSync(path.join(written.directory, "manifest.json"))),
    files: written.files.map((file) => ({
      path: file.path.replace(/^\//, ""),
      bytes: file.bytes,
      sha256:
        file.path === "/manifest.json"
          ? null
          : (manifest.files || []).find((entry) => `/${entry.path}` === file.path)
              ?.sha256 || null,
    })),
  };
}

export function parseAdminOperation(options) {
  const [namespace = "", action = "", target = "", extra = ""] =
    options.positional;

  // The owner's client trace (admin-owner-trace.js); read-only, no run.
  if (namespace === "owner-trace") {
    return buildOwnerTraceOperation(options);
  }

  if (namespace === "correction" || namespace === "corrections") {
    if (!action || action === "status") {
      return readOperation(
        "correction.status",
        "/cli/admin/corrections/status",
      );
    }
    if (action === "start") {
      const commentId = parseRequiredInteger(target, "comment ID", 1);
      return writeOperation(
        "correction.start",
        "POST",
        "/cli/admin/corrections",
        {
          commentId,
        },
      );
    }
    if (action === "complete" || action === "stop") {
      const correctionId = parseRequiredInteger(
        target,
        "correction session ID",
        1,
      );
      return writeOperation(
        "correction.complete",
        "POST",
        `/cli/admin/corrections/${correctionId}/complete`,
        {},
      );
    }
    throw cliValidationError(
      "Usage: lumine admin correction start <commentId> | correction status | correction complete <sessionId>.",
    );
  }

  if (namespace === "identity") {
    if (action === "list") {
      return readOperation("identity.list", "/cli/admin/identities");
    }
    if (action === "status") {
      return readOperation("identity.status", "/cli/admin/identity/status");
    }
    if (action === "use") {
      return writeOperation(
        "identity.use",
        "PUT",
        "/cli/admin/identity/preference",
        { identity: parseIdentity(target) },
      );
    }
    if (action === "inspect") {
      const inspectionTarget = String(target || "").trim();
      const reason = String(options.adminReason || "").trim();
      if (!inspectionTarget) {
        throw cliValidationError(
          "Usage: lumine admin identity inspect <userId|username> --reason <management reason> [--include-private-evidence].",
        );
      }
      if (!reason) {
        throw cliValidationError(
          "Explain why private identity evidence is needed with --reason <management reason>.",
        );
      }
      if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
        throw cliValidationError(
          `An identity-inspection reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
        );
      }
      // A read: writes keep their full response as a receipt file under
      // ./work/lumine-admin, and private identity evidence must never be left
      // on disk by default. The server still audits who looked, when and why
      // (one row per call). `--output <file>` saves a 0600 copy on purpose.
      return bodyReadOperation(
        "identity.inspect",
        "POST",
        "/cli/admin/identity/inspect",
        {
          target: inspectionTarget,
          reason,
          includePrivateEvidence: options.adminIncludePrivateEvidence === true,
        },
      );
    }
  }

  if (namespace === "identity" && action === "network") {
    const networkTarget = String(target || "").trim();
    const reason = String(options.adminReason || "").trim();
    if (!networkTarget || !reason) {
      throw cliValidationError(
        "Usage: lumine admin identity network <userId|username> --reason <management reason> [--include-private-evidence].",
      );
    }
    if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
      throw cliValidationError(
        `A network-evidence reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
      );
    }
    // A read for the same reason as identity inspect: no receipt on disk.
    return {
      ...bodyReadOperation(
        "identity.network",
        "POST",
        "/cli/admin/identity/network",
        {
          target: networkTarget,
          reason,
          includePrivateEvidence: options.adminIncludePrivateEvidence === true,
        },
      ),
      requiresRun: false,
    };
  }

  if (namespace === "economy" && action === "trace") {
    const traceTarget = String(target || "").trim();
    const reason = String(options.adminReason || "").trim();
    if (!traceTarget || !reason) {
      throw cliValidationError(
        "Usage: lumine admin economy trace <userId|username> --reason <management reason> [--days <1..30>].",
      );
    }
    if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
      throw cliValidationError(
        `An investigation reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
      );
    }
    return writeOperation("economy.trace", "POST", "/cli/admin/economy/trace", {
      target: traceTarget,
      reason,
      days: parseRequiredInteger(options.adminDays || "3", "--days", 1, 30),
    });
  }

  if (namespace === "rescue" && action === "wordle-audit") {
    const reason = String(options.adminReason || "").trim();
    if (!reason) {
      throw cliValidationError(
        "Usage: lumine admin rescue wordle-audit --reason <management reason> [--days <1..30>].",
      );
    }
    if (reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
      throw cliValidationError(
        `An investigation reason must be at most ${MAX_IDENTITY_INSPECTION_REASON_LENGTH} characters.`,
      );
    }
    return writeOperation(
      "rescue.wordle.audit",
      "POST",
      "/cli/admin/rescues/wordle/audit",
      {
        reason,
        days: parseRequiredInteger(options.adminDays || "30", "--days", 1, 30),
      },
    );
  }

  if (namespace === "ai-bucket" || namespace === "ai-buckets") {
    if (action === "create") {
      return writeOperation(
        "ai-bucket.create",
        "POST",
        "/cli/admin/ai-buckets",
        {
          label: parseAiBucketLabel(options.adminLabel),
          note: parseAiBucketNote(options.note),
        },
      );
    }
    const bucketId = parseRequiredInteger(
      options.adminBucketId,
      "AI bucket ID",
      1,
    );
    if (action === "get" || action === "status") {
      return readOperation(
        "ai-bucket.get",
        `/cli/admin/ai-buckets/${bucketId}`,
      );
    }
    if (action === "accounts" && target === "add") {
      return writeOperation(
        "ai-bucket.accounts.add",
        "POST",
        `/cli/admin/ai-buckets/${bucketId}/accounts`,
        {
          userIds: parseAiBucketUserIds(options.adminUserIds),
          note: options.note || undefined,
        },
      );
    }
    if (action === "note" && target === "set") {
      return writeOperation(
        "ai-bucket.note.set",
        "PUT",
        `/cli/admin/ai-buckets/${bucketId}/note`,
        { note: parseAiBucketNote(options.note) },
      );
    }
  }

  if (namespace === "ai-email-policy" || namespace === "ai-email-policies") {
    const email = parseAiEmailPolicyEmail(options.adminEmail);
    if (action === "get" || action === "status") {
      return bodyReadOperation(
        "ai-email-policy.get",
        "POST",
        "/cli/admin/ai-email-policies/lookup",
        { email },
      );
    }
    if (action === "set") {
      return writeOperation(
        "ai-email-policy.set",
        "PUT",
        "/cli/admin/ai-email-policies",
        {
          email,
          mode: parseAiEmailPolicyMode(options.adminMode),
          note: parseAiEmailPolicyNote(options.note),
        },
      );
    }
  }

  if (namespace === "approvals" || namespace === "approval") {
    // Management approvals: birthdates, teacher signups (mentor), meetups.
    // Mikey's decisions, any time; each comes with its evidence (approvals.ts).
    return buildApprovalOperation({ action, target, options });
  }
  if (namespace === "english") {
    return buildEnglishOperation({ action, target, options });
  }
  if (namespace === "teachers" || namespace === "teacher") {
    // Approved teachers: an audit any time, and a clean removal of the status.
    return buildTeacherOperation({ action, target, options });
  }

  if (namespace === "review" || namespace === "reviews") {
    // Every Build unlock in one queue. Mikey's own decisions: any time, never
    // part of a delegated Zero/Ciel daily run.
    if (action === "propose") {
      const ref = parseReviewRequestRef(target, {
        typeOption: options.adminType,
      });
      if (ref.type !== "rewards") {
        throw cliValidationError(
          "Only XP & Coin reward requests take a proposed copy.",
        );
      }
      return buildRewardProposalOperation(ref.id, options);
    }
    const operation = buildReviewRequestOperation({ action, target, options });
    if (operation) return operation;
    throw cliValidationError(REVIEW_REQUEST_USAGE);
  }

  if (
    namespace === "reward-review" ||
    namespace === "reward-reviews" ||
    namespace === "rewards"
  ) {
    // Alias of `lumine admin review ... rewards:<id>`; propose stays here.
    if (action === "propose") {
      return buildRewardProposalOperation(
        parseRequiredInteger(target, "Reward review ID", 1),
        options,
      );
    }
    const operation = buildReviewRequestOperation({
      action,
      target,
      options,
      fixedType: "rewards",
      command: "lumine admin reward-review",
      listStatuses: REWARD_REVIEW_STATUSES,
    });
    if (operation) return operation;
    throw cliValidationError(
      "Usage: lumine admin reward-review list [--status pending|approved|all] [--cursor <id>] | show <id> [--dir <path>] | approve <id> [--config <rules.json>] [--reason <text>] | propose <id> --dir <edited-snapshot> --config <rules.json> [--reason <text>] | reject <id> --reason <text> | revoke <id> --reason <text>.",
    );
  }

  if (
    namespace === "cardcraft-review" ||
    namespace === "cardcraft-reviews" ||
    namespace === "cardcraft"
  ) {
    // Alias of `lumine admin review ... cardcraft:<id>`.
    const operation = buildReviewRequestOperation({
      action,
      target,
      options,
      fixedType: "cardcraft",
      command: "lumine admin cardcraft-review",
      listStatuses: REWARD_REVIEW_STATUSES,
    });
    if (operation) return operation;
    throw cliValidationError(
      "Usage: lumine admin cardcraft-review list [--status pending|approved|all] [--cursor <id>] | show <id> | approve <id> [--reason <text>] | reject <id> --reason <text> | revoke <id> --reason <text>.",
    );
  }

  if (MEETUP_NAMESPACES.has(namespace)) {
    // Bridge Builder meetup quest crews (achievement type 'meetup'): the same
    // reviews as the admin controls on the website quest page. Mikey's own
    // decision, any time, never in a daily run.
    const usage =
      "Usage: lumine admin meetup list [--status review|active|completed|all] | approve-crew <crewId> | approve-grownup <crewId> | emails [list|send <id>|discard <id>|review on|off] | friends [status|on|off] | parent-reply <crewId> <memberUserId> --note <text> | funnel [--days <1-90>] | branches [list|show|approve|reject|merge] | show <crewId> | approve-plan <crewId> [--note <text>] | send-back <crewId> --note <text> | approve <crewId> --attended <userId,userId,...> [--note <text>] | info <crewId> <userId> --decision ask|accept|ask-again|withdraw [--note <text>] | slot <crewId> --confirm <slotIndex> | resend-email <crewId>.";
    const note = String(options.note || "").trim();
    if (note.length > 1000) {
      throw cliValidationError("--note must be at most 1000 characters.");
    }
    if (action === "parent-reply") {
      // Answer a parent's question: shown on their page, and they are emailed.
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      const memberId = parseRequiredInteger(extra, "Member (child) user ID", 1);
      if (!note) throw cliValidationError("parent-reply needs --note <your answer>.");
      return writeOperation(
        "meetup.parent-reply",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/parents/${memberId}/reply`,
        { reply: note },
        { requiresRun: false },
      );
    }
    if (action === "branches" || action === "branch") {
      // Every branch name a member types is registered; the first sighting alerts
      // Mikey (a Zero DM card). Approve = a real branch, reject = not real (the
      // members' branch text is cleared and their crew chat is told), merge =
      // same as an official branch (members are rewritten to its name).
      const branchUsage =
        "Usage: lumine admin meetup branches [list [--status pending|official|rejected|all]] | show <id> | approve <id> [--note <text>] | reject <id> [--note <text>] | merge <id> --into <officialId> [--note <text>].";
      const branchAction = target || "list";
      if (branchAction === "list") {
        return readOperation(
          "meetup.branches",
          withQuery("/cli/admin/meetup-quest/branches", {
            status: parseChoice(options.adminStatus || "pending", "--status", [
              "pending",
              "official",
              "rejected",
              "all",
            ]),
          }),
          { requiresRun: false },
        );
      }
      if (!["show", "approve", "reject", "merge"].includes(branchAction)) {
        throw cliValidationError(branchUsage);
      }
      const branchId = parseRequiredInteger(extra, "Branch ID", 1);
      if (branchAction === "show") {
        return readOperation(
          "meetup.branch.show",
          `/cli/admin/meetup-quest/branches/${branchId}`,
          { requiresRun: false },
        );
      }
      if (branchAction === "merge" && !options.adminInto) {
        throw cliValidationError(
          "lumine admin meetup branches merge <id> needs --into <officialBranchId> (see `branches list --status official`).",
        );
      }
      return writeOperation(
        `meetup.branch.${branchAction}`,
        "POST",
        `/cli/admin/meetup-quest/branches/${branchId}/review`,
        {
          action: branchAction === "approve" ? "official" : branchAction,
          mergeIntoId: branchAction === "merge" ? parseRequiredInteger(options.adminInto, "--into", 1) : 0,
          note,
        },
        { requiresRun: false },
      );
    }
    if (action === "story" || action === "stories") {
      // A crew's Bridge Builder story page: Mikey's final approval (the
      // admin bar on the story page does the same). Publishing copies only
      // the photos/clips every tagged member's parent allowed.
      const storyUsage =
        "Usage: lumine admin meetup story list | show <crewId> | approve <crewId> [--note <text>] [--no-announce] | send-back <crewId> --note <text> | unpublish <crewId> --note <text>.";
      const storyAction = target || "list";
      if (storyAction === "list") {
        return readOperation("meetup.story.list", "/cli/admin/meetup-quest/stories", {
          requiresRun: false,
        });
      }
      if (!["show", "approve", "send-back", "unpublish"].includes(storyAction)) {
        throw cliValidationError(storyUsage);
      }
      const crewId = parseRequiredInteger(extra, "Crew ID", 1);
      if (storyAction === "show") {
        return readOperation(
          "meetup.story.show",
          `/cli/admin/meetup-quest/stories/by-crew/${crewId}`,
          { requiresRun: false },
        );
      }
      if (storyAction !== "approve" && !note) {
        throw cliValidationError(
          `lumine admin meetup story ${storyAction} <crewId> needs --note <text> (the crew sees it).`,
        );
      }
      return writeOperation(
        `meetup.story.${storyAction}`,
        "POST",
        `/cli/admin/meetup-quest/stories/by-crew/${crewId}/${storyAction}`,
        storyAction === "approve"
          ? { note, announce: !options.adminNoAnnounce }
          : { note },
        { requiresRun: false },
      );
    }
    if (action === "emails") {
      // Parent emails held for the owner's review: list | send <id> | discard <id> | review on|off
      const sub = target || "list";
      if (sub === "list") {
        return readOperation("meetup.emails", "/cli/admin/meetup-quest/emails", { requiresRun: false });
      }
      if (sub === "review") {
        const on = extra === "on" ? true : extra === "off" ? false : null;
        if (on === null) throw cliValidationError("lumine admin meetup emails review on|off");
        return writeOperation("meetup.emails", "POST", "/cli/admin/meetup-quest/emails/review", { on }, { requiresRun: false });
      }
      if (sub === "send" || sub === "discard") {
        const id = parseRequiredInteger(extra, "Email ID", 1);
        return writeOperation("meetup.emails", "POST", `/cli/admin/meetup-quest/emails/${id}/${sub}`, {}, { requiresRun: false });
      }
      throw cliValidationError("lumine admin meetup emails [list | send <id> | discard <id> | review on|off]");
    }
    if (action === "friends") {
      const sub = target || "status";
      if (sub === "status") {
        return readOperation("meetup.friends", "/cli/admin/meetup-quest/friends-switch", { requiresRun: false });
      }
      if (sub === "on" || sub === "off") {
        return writeOperation("meetup.friends", "POST", "/cli/admin/meetup-quest/friends-switch", { on: sub === "on" }, { requiresRun: false });
      }
      throw cliValidationError("lumine admin meetup friends [status | on | off]");
    }
    if (action === "funnel") {
      // Early-funnel views + where active crews are stuck (for Claude's own
      // analysis; no owner view).
      return readOperation(
        "meetup.funnel",
        withQuery("/cli/admin/meetup-quest/funnel", {
          days: parseRequiredInteger(options.adminDays || "14", "--days", 1, 90),
        }),
        { requiresRun: false },
      );
    }
    if (!action || action === "list") {
      return readOperation(
        "meetup.list",
        withQuery("/cli/admin/meetup-quest/crews", {
          status: parseChoice(
            options.adminStatus || "review",
            "--status",
            ["review", "active", "completed", "all"],
          ),
        }),
        { requiresRun: false },
      );
    }
    if (action === "show" || action === "get") {
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      return readOperation(
        "meetup.show",
        `/cli/admin/meetup-quest/crews/${crewId}`,
        { requiresRun: false },
      );
    }
    if (action === "info") {
      // Staff's "who are you" check on a member (ruled 2026-10-07): the member
      // gives their teacher's name and class name (or how they know the crew)
      // on the crew page; the crew waits until you accept. Nobody is contacted.
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      const memberId = parseRequiredInteger(extra, "Member user ID", 1);
      const decision = parseChoice(options.adminDecision || "", "--decision", [
        "ask",
        "accept",
        "ask-again",
        "withdraw",
      ]);
      if (decision === "ask-again" && !note) {
        throw cliValidationError("--decision ask-again needs --note <what to tell the member>.");
      }
      return writeOperation(
        "meetup.info",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/members/${memberId}/info-check`,
        { action: decision === "ask" ? "request" : decision, note },
        { requiresRun: false },
      );
    }
    if (action === "approve-crew" || action === "approve-grownup") {
      // Every step passes through the owner: the crew (members + branches) and
      // the grown-up step (parents' yes + the named adult).
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      return writeOperation(
        action === "approve-crew" ? "meetup.approve-crew" : "meetup.approve-grownup",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/${action}`,
        {},
        { requiresRun: false },
      );
    }
    if (action === "approve-plan") {
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      return writeOperation(
        "meetup.approve-plan",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/approve-plan`,
        { note },
        { requiresRun: false },
      );
    }
    if (action === "send-back") {
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      if (!note) {
        throw cliValidationError(
          "lumine admin meetup send-back <crewId> needs --note <what to change> (the crew sees it).",
        );
      }
      return writeOperation(
        "meetup.send-back",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/send-back`,
        { note },
        { requiresRun: false },
      );
    }
    if (action === "approve") {
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      const attendedUserIds = String(options.adminAttended || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => parseRequiredInteger(part, "--attended user ID", 1));
      if (!attendedUserIds.length) {
        throw cliValidationError(
          "lumine admin meetup approve <crewId> needs --attended <userId,userId,...> (the members who showed up in the video).",
        );
      }
      return writeOperation(
        "meetup.approve",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/approve`,
        { attendedUserIds: [...new Set(attendedUserIds)], note },
        { requiresRun: false },
      );
    }
    if (action === "slot") {
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      if (options.adminConfirm === "") {
        throw cliValidationError(
          "lumine admin meetup slot <crewId> needs --confirm <slotIndex> (0 is the first offered slot; see `show`).",
        );
      }
      return writeOperation(
        "meetup.slot",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/slot`,
        { slotIndex: parseRequiredInteger(options.adminConfirm, "--confirm", 0, 9) },
        { requiresRun: false },
      );
    }
    if (action === "resend-email") {
      const crewId = parseRequiredInteger(target, "Crew ID", 1);
      return writeOperation(
        "meetup.resend-email",
        "POST",
        `/cli/admin/meetup-quest/crews/${crewId}/resend-email`,
        {},
        { requiresRun: false },
      );
    }
    throw cliValidationError(usage);
  }

  if (STORAGE_LIMIT_NAMESPACES.has(namespace)) {
    // Lumine file storage (Twinkle.files) unlocks: per-creator approvals past
    // the default quota. Mikey's own decision, any time, never in a daily run.
    const usage =
      "Usage: lumine admin storage list [--status pending|approved|rejected|all] [--cursor <id>] | show <user-id-or-username> | approve <request-id> [--size <500MB|1GB|2GB|n MB>] [--reason <text>] | reject <request-id> [--reason <text>] | grant <user-id-or-username> --size <500MB|1GB|2GB|n MB> [--reason <text>].";
    const reason = String(options.adminReason || "").trim();
    if (reason.length > 1000) {
      throw cliValidationError("--reason must be at most 1000 characters.");
    }
    if (!action || action === "list") {
      // Alias of `lumine admin review list --type storage`.
      return buildReviewRequestOperation({
        action,
        target,
        options,
        fixedType: "storage-limit",
        command: "lumine admin storage",
        listStatuses: ["pending", "approved", "rejected", "all"],
      });
    }
    if (action === "show" || action === "get") {
      const user = parseStorageTargetUser(target);
      return readOperation(
        "storage.show",
        `/cli/admin/storage-limits/users/${encodeURIComponent(user)}`,
        { requiresRun: false },
      );
    }
    if (action === "approve" || action === "reject") {
      // Alias of `lumine admin review approve|reject storage:<id>`.
      return buildReviewRequestOperation({
        action,
        target,
        options,
        fixedType: "storage-limit",
        command: "lumine admin storage",
      });
    }
    if (action === "grant" || action === "set") {
      const user = parseStorageTargetUser(target);
      if (!options.storageSize) {
        throw cliValidationError(
          "lumine admin storage grant <user> needs --size <500MB|1GB|2GB|n MB>.",
        );
      }
      return writeOperation(
        "storage.grant",
        "PUT",
        `/cli/admin/storage-limits/users/${encodeURIComponent(user)}`,
        { sizeBytes: parseAdminStorageSize(options.storageSize), reason },
        { requiresRun: false },
      );
    }
    throw cliValidationError(usage);
  }

  if (namespace === "chat-reports" || namespace === "chat-report") {
    // Members' in-chat message reports. Like reward reviews they are handled
    // any time, never inside a daily-run lease; recording an outcome only
    // annotates the report and never acts against a member.
    if (!action || action === "list") {
      return readOperation(
        "chat-reports.list",
        withQuery("/cli/admin/chat-reports", {
          status: parseChoice(
            options.adminStatus || "pending",
            "--status",
            CHAT_REPORT_LIST_STATUSES,
          ),
          beforeId: options.adminCursor
            ? parseRequiredInteger(options.adminCursor, "--cursor", 1)
            : "",
          limit: options.limit,
        }),
        { requiresRun: false },
      );
    }
    if (action === "show" || action === "get") {
      const reportId = parseRequiredInteger(target, "Chat report ID", 1);
      return readOperation(
        "chat-reports.show",
        `/cli/admin/chat-reports/${reportId}`,
        { requiresRun: false },
      );
    }
    if (action === "set") {
      const reportId = parseRequiredInteger(target, "Chat report ID", 1);
      const status = parseChoice(
        options.adminStatus,
        "--status",
        CHAT_REPORT_STATUSES,
      );
      const note = String(options.note || "").trim();
      if (!note) {
        throw cliValidationError(
          "Record what was decided or done with --note <text>.",
        );
      }
      if (note.length > 2000) {
        throw cliValidationError("--note must be at most 2000 characters.");
      }
      return writeOperation(
        "chat-reports.set",
        "PUT",
        `/cli/admin/chat-reports/${reportId}`,
        { status, note },
        { requiresRun: false, reportId },
      );
    }
    // Child-safety holds, evidence export and suspension (owner only; the
    // API admits only the owner's login). A hold keeps a protected copy of
    // anything the held conversation or members delete or edit.
    if (action === "hold") {
      const note = requireChatSafetyNote(options.note);
      const body = { note };
      if (target) body.reportId = parseRequiredInteger(target, "Chat report ID", 1);
      if (options.adminUser) {
        body.userIds = parseIdList(options.adminUser, "--user");
      }
      if (options.adminChannel) {
        body.channelId = parseRequiredInteger(options.adminChannel, "--channel", 1);
      }
      if (!body.reportId && !body.userIds && !body.channelId) {
        throw cliValidationError(
          "Usage: lumine admin chat-reports hold <report-id> | --user <id>[,<id>] [--channel <id>] | --channel <id> --note <why>.",
        );
      }
      return writeOperation(
        "chat-reports.hold",
        "POST",
        "/cli/admin/chat-reports/holds",
        body,
        { requiresRun: false },
      );
    }
    if (action === "release") {
      const holdId = parseRequiredInteger(
        target || options.adminHold,
        "Safety hold ID",
        1,
      );
      return writeOperation(
        "chat-reports.release",
        "PUT",
        `/cli/admin/chat-reports/holds/${holdId}/release`,
        { note: requireChatSafetyNote(options.note) },
        { requiresRun: false, holdId },
      );
    }
    if (action === "list-holds" || action === "holds") {
      return readOperation(
        "chat-reports.list-holds",
        withQuery("/cli/admin/chat-reports/holds", {
          status: parseChoice(
            options.adminStatus || "active",
            "--status",
            ["active", "released", "all"],
          ),
        }),
        { requiresRun: false },
      );
    }
    if (action === "export") {
      const out = String(options.out || "").trim();
      if (!out) {
        throw cliValidationError(
          "Pass a new or empty directory with --out <dir> for the evidence package.",
        );
      }
      if (target && options.adminHold) {
        throw cliValidationError("Export either one report ID or one --hold <id>, not both.");
      }
      const body = target
        ? { reportId: parseRequiredInteger(target, "Chat report ID", 1) }
        : options.adminHold
          ? { holdId: parseRequiredInteger(options.adminHold, "--hold", 1) }
          : null;
      if (!body) {
        throw cliValidationError(
          "Usage: lumine admin chat-reports export <report-id> | --hold <hold-id> --out <dir>.",
        );
      }
      // A POST because the export is audited server-side (who, when, the
      // manifest hash); it changes no member data.
      return writeOperation(
        "chat-reports.export",
        "POST",
        "/cli/admin/chat-reports/export",
        body,
        { requiresRun: false, evidenceDir: out },
      );
    }
    if (action === "suspend") {
      return writeOperation(
        "chat-reports.suspend",
        "POST",
        "/cli/admin/chat-reports/suspend",
        {
          userId: parseRequiredInteger(options.adminUser || target, "--user", 1),
          note: requireChatSafetyNote(options.note),
        },
        { requiresRun: false },
      );
    }
    throw cliValidationError(
      "Usage: lumine admin chat-reports list [--status pending|open|reviewing|resolved|dismissed|all] [--cursor <id>] | show <id> | set <id> --status reviewing|resolved|dismissed|open --note <decision> | hold <report-id>|--user <id>|--channel <id> --note <why> | release <hold-id> --note <why> | list-holds [--status active|released|all] | export <report-id>|--hold <id> --out <dir> | suspend --user <id> --note <why>.",
    );
  }

  if (namespace === "reward-bank" || namespace === "reward-banks") {
    // Seed questions for an approved app's reward question bank (generated-quiz
    // rules). coverage is read-only; seed writes ONE missing question per call
    // (lowest step first) as the daily run's Zero/Ciel identity and takes as
    // long as two GPT-6.1 Sol calls, so it gets its own timeout. The daily
    // website management run calls it in a bounded loop (Mikey, 2026-09-28).
    const usage =
      "Usage: lumine admin reward-bank coverage <buildId> [--max-step 3] | seed <buildId> [--max-step 3] [--identity zero|ciel|auto] | report <buildId> [--days 1].";
    const buildId = parseRequiredInteger(
      target || options.adminBuild,
      "Build ID",
      1,
    );
    const maxStep = options.adminMaxStep
      ? parseRequiredInteger(options.adminMaxStep, "--max-step", 1)
      : 3;
    if (maxStep > 10) throw cliValidationError("--max-step must be at most 10.");
    if (action === "report") {
      const days = options.adminDays
        ? parseRequiredInteger(options.adminDays, "--days", 1)
        : 1;
      if (days > 31) throw cliValidationError("--days must be at most 31.");
      return readOperation(
        "reward-bank.report",
        withQuery("/cli/admin/reward-bank/report", {
          buildId: String(buildId),
          days: String(days),
        }),
        { requiresRun: false },
      );
    }
    if (action === "coverage" || action === "status") {
      return readOperation(
        "reward-bank.coverage",
        withQuery("/cli/admin/reward-bank/coverage", {
          buildId: String(buildId),
          maxStep: String(maxStep),
        }),
        { requiresRun: false },
      );
    }
    if (action === "seed") {
      // Inside a daily run it seeds as that run's identity. Without one the
      // owner can seed whenever they like (Mikey, 2026-10-04): the server
      // checks the account and acts as --identity zero|ciel (default: today's
      // scheduled identity), billed to that identity's AI Energy as before.
      const identity = options.adminIdentity
        ? String(options.adminIdentity).toLowerCase()
        : "";
      if (identity && !["zero", "ciel", "auto"].includes(identity))
        throw cliValidationError("--identity must be zero, ciel or auto.");
      return writeOperation(
        "reward-bank.seed",
        "POST",
        "/cli/admin/reward-bank/seed",
        { buildId, maxStep, ...(identity ? { identity } : {}) },
        { timeoutMs: 240000, runOptional: true },
      );
    }
    throw cliValidationError(usage);
  }

  if (namespace === "reward-activity" || namespace === "reward-telemetry") {
    // Read-only claim telemetry for the daily run: no run lease, no mutation.
    const date = options.adminDate
      ? parseUtcDayKey(options.adminDate)
      : undefined;
    const days = options.adminDays
      ? parseRequiredInteger(options.adminDays, "--days", 1)
      : date
        ? 1
        : 7;
    if (days > 31) throw cliValidationError("--days must be at most 31.");
    return readOperation(
      "reward-activity.report",
      withQuery("/cli/admin/reward-activity", {
        days: String(days),
        date,
        buildId: options.buildIdFlag
          ? String(parseRequiredInteger(options.buildIdFlag, "--build", 1))
          : "",
      }),
      { requiresRun: false },
    );
  }

  if (namespace === "todo" || namespace === "todos") {
    if (!action || action === "list") {
      return readOperation(
        "todo.list",
        withQuery("/cli/admin/todos", {
          status: parseTodoListStatus(options.adminStatus || "pending"),
          limit: options.limit,
        }),
      );
    }
    if (action === "add" || action === "create") {
      const title = String(options.title || "").trim();
      const details = String(options.note || "").trim();
      if (!title || !details) {
        throw cliValidationError(
          "Usage: lumine admin todo add --title <title> --note <handoff and acceptance criteria> [--kind task|experiment] [--status open|in_progress|blocked].",
        );
      }
      if (title.length > MAX_TODO_TITLE_LENGTH) {
        throw cliValidationError(
          `A todo title must be at most ${MAX_TODO_TITLE_LENGTH} characters.`,
        );
      }
      if (details.length > MAX_TODO_NOTE_LENGTH) {
        throw cliValidationError(
          `Todo details must be at most ${MAX_TODO_NOTE_LENGTH} characters.`,
        );
      }
      return writeOperation("todo.add", "POST", "/cli/admin/todos", {
        kind: parseTodoKind(options.adminKind || "task"),
        title,
        details,
        status: parseTodoInitialStatus(options.adminStatus || "open"),
      });
    }
    if (action === "update") {
      const todoId = parseRequiredInteger(target, "Todo ID", 1);
      const note = String(options.note || "").trim();
      if (!note) {
        throw cliValidationError(
          "Record concrete progress, evidence, or the reason for the state change with --note <text>.",
        );
      }
      if (note.length > MAX_TODO_NOTE_LENGTH) {
        throw cliValidationError(
          `A todo progress note must be at most ${MAX_TODO_NOTE_LENGTH} characters.`,
        );
      }
      return writeOperation(
        "todo.update",
        "PUT",
        `/cli/admin/todos/${todoId}`,
        {
          status: parseTodoStatus(options.adminStatus),
          note,
        },
      );
    }
    throw cliValidationError(
      "Usage: lumine admin todo list [--status pending|open|in_progress|blocked|completed|cancelled|all] | todo add --title <title> --note <details> | todo update <id> --status <status> --note <progress>.",
    );
  }

  if (namespace === "sponsor" || namespace === "sponsors") {
    if (action === "applications") {
      if (!target || target === "list") {
        return readOperation(
          "sponsor.applications.list",
          withQuery("/cli/admin/sponsors/applications", {
            status: options.adminStatus || "pending",
            limit: options.limit,
          }),
        );
      }
      if (target === "review") {
        const applicationId = parseRequiredInteger(
          extra,
          "Sponsor application ID",
          1,
        );
        const decision = parseChoice(
          options.adminDecision || options.adminStatus,
          "--decision",
          ["approve", "reject"],
        );
        return writeOperation(
          "sponsor.application.review",
          "POST",
          `/cli/admin/sponsors/applications/${applicationId}/review`,
          { decision, note: options.note || undefined },
        );
      }
    }
    if (action === "status" && target === "set") {
      const sponsorUserId = parseRequiredInteger(extra, "Sponsor user ID", 1);
      const status = parseChoice(options.adminStatus, "--status", [
        "probationary",
        "trusted",
        "suspended",
        "revoked",
      ]);
      return writeOperation(
        "sponsor.status.set",
        "PUT",
        `/cli/admin/sponsors/${sponsorUserId}/status`,
        { status, note: options.note || undefined },
      );
    }
    if (action === "integrity") {
      if (target === "status") {
        return readOperation(
          "sponsor.integrity.status",
          "/cli/admin/daily-runs/sponsor-integrity/status",
        );
      }
      if (target === "scan") {
        return writeOperation(
          "sponsor.integrity.scan",
          "POST",
          "/cli/admin/daily-runs/sponsor-integrity/scan",
          {},
        );
      }
      if (target === "cases") {
        return readOperation(
          "sponsor.integrity.cases",
          withQuery("/cli/admin/daily-runs/sponsor-integrity/cases", {
            status: options.adminStatus || "open",
            limit: options.limit,
          }),
        );
      }
      if (target === "get") {
        const caseId = parseRequiredInteger(extra, "Integrity case ID", 1);
        return readOperation(
          "sponsor.integrity.get",
          `/cli/admin/daily-runs/sponsor-integrity/cases/${caseId}`,
        );
      }
      if (target === "review") {
        const caseId = parseRequiredInteger(extra, "Integrity case ID", 1);
        const decision = parseChoice(options.adminDecision, "--decision", [
          "clear",
          "hold",
          "flag",
          "disqualify",
        ]);
        if (decision !== "clear" && !String(options.note || "").trim()) {
          throw cliValidationError(
            "Sponsor-integrity hold, flag, and disqualify decisions require --note <evidence>.",
          );
        }
        return writeOperation(
          "sponsor.integrity.review",
          "POST",
          `/cli/admin/daily-runs/sponsor-integrity/cases/${caseId}/review`,
          { decision, note: options.note || undefined },
        );
      }
    }
    throw cliValidationError(
      "Usage: lumine admin sponsor applications list|review | sponsor status set | sponsor integrity status|scan|cases|get|review.",
    );
  }

  if (namespace === "daily-run") {
    if (action === "start") {
      const runScope = parseDailyRunScope(options.adminScope || "full");
      const commentMode = parseCommentMode(options.commentMode || "off");
      if (runScope !== "full" && commentMode !== "off") {
        throw cliValidationError("A scoped run requires --comment-mode off.");
      }
      return writeOperation(
        "daily-run.start",
        "POST",
        runScope === "full"
          ? "/cli/admin/daily-runs/start"
          : `/cli/admin/daily-runs/start/${runScope}`,
        {
          identity: options.adminIdentity
            ? parseIdentity(options.adminIdentity)
            : undefined,
          commentMode,
          scope: runScope,
          runKey: options.runKey || defaultDailyRunKey(runScope),
        },
      );
    }
    if (action === "status") {
      return readOperation("daily-run.status", "/cli/admin/daily-runs/status");
    }
    if (action === "report") {
      const positionalRun = String(target || "").trim();
      const flaggedRun = String(options.adminRun || "").trim();
      if (
        extra ||
        (positionalRun && flaggedRun && positionalRun !== flaggedRun)
      ) {
        throw cliValidationError(
          "Usage: lumine admin daily-run report [--run <completed-run-id>] [--json].",
        );
      }
      const historicalRun = positionalRun || flaggedRun;
      if (historicalRun) {
        const runId = parseRequiredInteger(historicalRun, "run ID", 1);
        return readOperation(
          "daily-run.report",
          `/cli/admin/daily-runs/${runId}/report`,
          { requiresRun: false, historicalRunId: runId },
        );
      }
      return readOperation("daily-run.report", "/cli/admin/daily-runs/report");
    }
    if (action === "escalation" && target === "add") {
      const rawTarget = String(options.adminTarget || "").trim();
      const summary = String(options.note || "").trim();
      if (!rawTarget || !summary) {
        throw cliValidationError(
          "Pass a concrete --target and --note when recording a run escalation.",
        );
      }
      const parsedTarget = parseAdminEscalationTarget(rawTarget);
      return writeOperation(
        "daily-run.escalation.add",
        "POST",
        "/cli/admin/daily-runs/escalations",
        {
          targetType: parsedTarget.targetType || undefined,
          targetId: parsedTarget.targetId || undefined,
          url: parsedTarget.url || undefined,
          summary,
          severity: options.adminSeverity || "attention",
        },
      );
    }
    if (action === "complete" || action === "fail") {
      return writeOperation(
        `daily-run.${action}`,
        "POST",
        `/cli/admin/daily-runs/${action}`,
        action === "fail" ? { reason: options.adminReason || undefined } : {},
      );
    }
  }

  if (namespace === "escalation" || namespace === "escalations") {
    if (!action || action === "list") {
      const status = parseEscalationListStatus(options.adminStatus || "open");
      return readOperation(
        "escalation.list",
        withQuery("/cli/admin/escalations", {
          status,
          limit: options.limit,
        }),
      );
    }
    if (action === "set") {
      const escalationAuditId = parseRequiredInteger(
        target,
        "Escalation audit ID",
        1,
      );
      const status = parseEscalationStatus(options.adminStatus);
      const note = String(options.note || "").trim();
      if (!note) {
        throw cliValidationError(
          "Record the decision or next step with --note <text>.",
        );
      }
      if (note.length > MAX_ESCALATION_DECISION_NOTE_LENGTH) {
        throw cliValidationError(
          `An escalation decision note must be at most ${MAX_ESCALATION_DECISION_NOTE_LENGTH} characters.`,
        );
      }
      return writeOperation(
        "escalation.set",
        "PUT",
        `/cli/admin/escalations/${escalationAuditId}`,
        { status, note },
      );
    }
    throw cliValidationError(
      "Usage: lumine admin escalation list [--status open|acknowledged|resolved|all] | escalation set <auditId> --status <status> --note <decision>.",
    );
  }

  if (
    (namespace === "recommend-queue" && (!action || action === "list")) ||
    (namespace === "recommendations" && action === "list")
  ) {
    const kind = String(options.adminKind || "recommend").toLowerCase();
    if (kind !== "recommend") {
      throw cliValidationError("--kind currently supports only recommend.");
    }
    const recommendationWindow = parseRecommendationWindow(options);
    return readOperation(
      "recommendations.list",
      withQuery("/cli/admin/recommendations", {
        kind,
        contentTypes: options.adminContentTypes,
        cursor: options.adminCursor,
        limit: options.limit,
        sinceRun: recommendationWindow.mode === "since-run" ? "true" : "",
        after:
          recommendationWindow.mode === "after"
            ? recommendationWindow.after
            : "",
        includeLegacy: recommendationWindow.mode === "legacy" ? "true" : "",
      }),
      {
        pagination: {
          collectionKey: "items",
          coverageQueue: "recommendations",
          coverageMode: recommendationWindow.mode,
          after:
            recommendationWindow.mode === "after"
              ? parseAfterForCoverage(recommendationWindow.after)
              : null,
          filters: {
            contentTypes: options.adminContentTypes || null,
            operatorView: options.adminUnviewed
              ? "unviewed"
              : options.adminViewed
                ? "viewed"
                : null,
          },
        },
      },
    );
  }

  if (namespace === "builds" && action === "candidates") {
    const window = parseBuildWindow(options);
    return readOperation(
      "builds.candidates",
      withQuery("/cli/admin/builds/candidates", {
        sinceRun: window.mode === "since-run" ? "true" : "",
        after: window.mode === "after" ? window.after : "",
        includeLegacy: window.mode === "legacy" ? "true" : "",
        cursor: options.adminCursor,
        limit: options.limit,
      }),
      {
        pagination: {
          collectionKey: "builds",
          coverageQueue: "builds",
          coverageMode: window.mode,
          after:
            window.mode === "after"
              ? parseAfterForCoverage(window.after)
              : null,
          filters: { sort: "published-release", scope: "all" },
        },
      },
    );
  }
  if (namespace === "builds" && action === "review") {
    const parsed = parseAdminCommentTarget({ target, explicitType: "build" });
    if (parsed.type !== "build") {
      throw cliValidationError(
        "Build review targets a Build URL or build:<id>.",
      );
    }
    return {
      name: "build.review",
      method: "GET",
      path: "",
      body: undefined,
      mutates: false,
      buildId: parsed.id,
      // Public artifact inspection also supports a one-comment correction;
      // it never needs a full daily-management authorization envelope.
      requiresRun: false,
    };
  }

  if (
    namespace === "subjects" &&
    (action === "list" || action === "candidates")
  ) {
    return subjectsListOperation(options);
  }
  if (namespace === "subjects" && action === "featured") {
    return readOperation("featured.list", "/cli/admin/subjects/featured");
  }
  if (namespace === "subjects") {
    return legacySubjectsOperation({ action, target, options });
  }

  if (namespace === "subject") {
    if (action === "get") return subjectGetOperation(target, options);
    if (action === "comments") {
      const subjectId = parseSubjectId(target);
      const operatorView = requestedOperatorViewFilter(options);
      return readOperation(
        "subject.comments",
        withQuery(`/cli/admin/subjects/${subjectId}/comments`, {
          cursor: options.adminCursor,
          limit: options.limit,
        }),
        {
          pagination: {
            collectionKey: "comments",
            filters: {
              ...(operatorView ? { operatorView } : {}),
            },
          },
        },
      );
    }
    if (action === "reveal") {
      return subjectWrite("subject.reveal", "POST", target, "/reveal");
    }
    if (action === "effort" && target === "set") {
      const subjectId = parseSubjectId(extra);
      const level = parseRequiredInteger(options.adminLevel, "--level", 1, 3);
      return writeOperation(
        "subject.effort.set",
        "PUT",
        `/cli/admin/subjects/${subjectId}/effort`,
        { level },
      );
    }
    if (action === "creator" && target === "set-made-by-poster") {
      return subjectWrite(
        "subject.creator.set-made-by-poster",
        "PUT",
        extra,
        "/created-by-author",
      );
    }
    if (action === "feature" || action === "unfeature") {
      return subjectWrite(
        `subject.${action}`,
        action === "feature" ? "POST" : "DELETE",
        target,
        "/featured",
      );
    }
  }

  if (namespace === "featured") {
    if (action === "comments") {
      if (!["scan", "acknowledge", "recommend", "report"].includes(target)) {
        throw cliValidationError(
          "Usage: featured comments scan|acknowledge|recommend|report --checkpoint <file>.",
        );
      }
      if (
        options.adminAll ||
        options.adminCursor ||
        options.adminUnviewed ||
        options.adminViewed ||
        options.adminAfter
      ) {
        throw cliValidationError(
          "The Featured review covers every comment; filtered or caller-supplied cursors are not supported.",
        );
      }
      return {
        ...writeOperation(
          `featured.comments.${target}`,
          "POST",
          "/cli/admin/subjects/featured/reviews",
          {},
        ),
        mutates: target !== "report",
        featuredWorkflow: target,
      };
    }
    if (action === "plan") {
      if (!options.adminPostedAfter)
        throw cliValidationError(
          "A Featured plan requires --posted-after <timestamp>.",
        );
      return writeOperation(
        "featured.plan",
        "POST",
        "/cli/admin/subjects/featured/plan",
        {
          removeIds: parseFeaturedSubjectIds(
            options.adminRemoveIds,
            "--remove-subject-ids",
          ),
          addIds: parseFeaturedSubjectIds(
            options.adminAddIds,
            "--add-subject-ids",
          ),
          ...(options.adminIds
            ? { finalIds: parseOrderedIds(options.adminIds) }
            : {}),
          postedAfter: options.adminPostedAfter,
        },
      );
    }
    if (action === "apply") {
      readApprovedFeaturedPlan(options.adminFile, options.adminApprove);
      return {
        ...writeOperation(
          "featured.apply",
          "POST",
          "/cli/admin/subjects/featured/plan/apply",
          {},
        ),
        featuredWorkflow: "apply",
      };
    }
    if (action === "list") {
      return readOperation("featured.list", "/cli/admin/subjects/featured");
    }
    if (action === "history") {
      const subjectIds = parseFeaturedSubjectIds(
        options.adminIds,
        "--subject-ids",
      );
      if (subjectIds.length > 20_000) {
        throw cliValidationError(
          "Featured history accepts at most 20000 subject IDs per CLI scan.",
        );
      }
      if (
        subjectIds.length > FEATURED_HISTORY_BATCH_SIZE &&
        !options.adminAll
      ) {
        throw cliValidationError(
          "Pass --all to automatically batch history reads larger than 100 subjects.",
        );
      }
      return readOperation(
        "featured.history",
        withQuery("/cli/admin/subjects/featured/history", {
          subjectIds: subjectIds.join(","),
          cursor: options.adminCursor,
          limit: options.limit,
        }),
        {
          pagination: {
            collectionKey: "events",
            summaryKeys: ["coverage", "subjects"],
            filters: { subjectIds },
          },
        },
      );
    }
    if (action === "add") {
      return featuredAddOperation(options);
    }
    if (action === "reorder") {
      return featuredReorderOperation(options);
    }
    if (action === "rotate") {
      return featuredRotateOperation(options);
    }
  }

  if (namespace === "comments" && action === "get") {
    const commentId = parseRequiredInteger(target, "comment ID", 1);
    return readOperation("comments.get", `/cli/admin/comments/${commentId}`, {
      correctionEligible: true,
      correctionCommentId: commentId,
    });
  }

  if (namespace === "post") {
    if (action === "get") return postGetOperation(target, options);
    if (action === "comments") {
      const parsedTarget = parseAdminCommentTarget({
        target,
        explicitType: options.adminType,
      });
      if (parsedTarget.type === "comment") {
        throw cliValidationError("A comment cannot contain a comment list.");
      }
      const path =
        parsedTarget.type === "subject"
          ? `/cli/admin/subjects/${parsedTarget.id}/comments`
          : `/cli/admin/posts/${parsedTarget.type}/${parsedTarget.id}/comments`;
      const operatorView = requestedOperatorViewFilter(options);
      return readOperation(
        "post.comments",
        withQuery(path, {
          cursor: options.adminCursor,
          limit: options.limit,
        }),
        {
          pagination: {
            collectionKey: "comments",
            filters: {
              ...(operatorView ? { operatorView } : {}),
            },
          },
        },
      );
    }
    if (action === "recommend") {
      return recommendOperation(target, options);
    }
    if (action === "skip") {
      const parsedTarget = parseRecommendationTarget({
        target,
        explicitType: options.adminType,
      });
      if (parsedTarget.type === "subject") {
        throw cliValidationError(
          "Skips apply to comment, aiStory, and dailyReflection targets; subjects leave the queue through effort assignment.",
        );
      }
      return writeOperation(
        "post.skip",
        "POST",
        `/cli/admin/skips/${parsedTarget.type}/${parsedTarget.id}`,
        { reason: options.adminReason || undefined },
      );
    }
    if (action === "skip-batch") {
      if (!options.adminTargetFile) {
        throw cliValidationError(
          "Pass batch skip targets with --target-file <file>.",
        );
      }
      return {
        name: "post.skip-batch",
        method: "POST",
        path: "",
        body: undefined,
        mutates: true,
      };
    }
    if (action === "reward") {
      const parsedTarget = parseRecommendationTarget({
        target,
        explicitType: options.adminType,
      });
      const twinkles = parseRequiredInteger(
        options.twinkles,
        "--twinkles",
        3,
        3,
      );
      return writeOperation(
        "post.reward",
        "POST",
        `/cli/admin/rewards/${parsedTarget.type}/${parsedTarget.id}`,
        { twinkles },
      );
    }
  }

  if (namespace === "recommend" && action) {
    return recommendOperation(action, options);
  }

  if (namespace === "news") {
    if (!action || action === "status") {
      return readOperation("news.status", "/cli/admin/news");
    }
    if (action === "print") {
      return writeOperation("news.print", "POST", "/cli/admin/news/print", {});
    }
    if (action === "claim") {
      const repairDate = String(options.adminDate || "").trim();
      if (repairDate && !/^\d{4}-\d{2}-\d{2}$/.test(repairDate)) {
        throw cliValidationError("--date must be YYYY-MM-DD.");
      }
      return writeOperation("news.claim", "POST", "/cli/admin/news/claim", {
        ...(repairDate ? { date: repairDate } : {}),
      });
    }
    if (action === "validate") {
      const claim = extractNewsClaim(
        readAdminJsonFile(options.adminClaimFile, "--claim <claim.json>"),
      );
      return {
        name: "news.validate",
        local: true,
        mutates: false,
        claim,
        editorial: readEditorialFile(options.adminFile),
      };
    }
    if (action === "submit") {
      const claim = options.adminClaimFile
        ? extractNewsClaim(
            readAdminJsonFile(options.adminClaimFile, "--claim <claim.json>"),
          )
        : null;
      const editionId = claim
        ? claim.editionId
        : parseRequiredInteger(options.adminEditionId, "--edition-id", 1);
      const leaseToken = claim
        ? claim.leaseToken
        : String(options.adminLeaseToken || "").trim();
      if (!leaseToken) {
        throw cliValidationError(
          "Pass the claim's lease token with --lease-token <token>.",
        );
      }
      const editorial = readEditorialFile(options.adminFile);
      if (claim) validateNewsEditorial({ claim, editorial });
      return writeOperation("news.submit", "POST", "/cli/admin/news/submit", {
        editionId,
        leaseToken,
        editorial,
        model: options.model || undefined,
      });
    }
    throw cliValidationError(
      "Usage: lumine admin news [status] | news print | news claim | news submit --edition-id <id> --lease-token <token> --file <editorial.json>",
    );
  }

  if (namespace === "notable" && ["add", "remove"].includes(action) && !extra) {
    const rawTarget = String(target || "").trim();
    if (!rawTarget) {
      throw cliValidationError(
        `Usage: lumine admin notable ${action} <userId|username> --note <text>.`,
      );
    }
    const body = /^\d+$/.test(rawTarget)
      ? { userId: parseRequiredInteger(rawTarget, "user ID", 1) }
      : { username: rawTarget };
    // --note records what made them notable (the management page's reason
    // column). On an already-listed user it updates the stored reason.
    const note = String(options.note || "").trim();
    if (!note) {
      throw cliValidationError(
        action === "remove"
          ? "Explain why this user should be removed with --note <text>."
          : "Pass what made this user notable with --note <text>.",
      );
    }
    if (note.length > MAX_NOTABLE_NOTE_LENGTH) {
      throw cliValidationError(
        `A notable-user note must be at most ${MAX_NOTABLE_NOTE_LENGTH} characters.`,
      );
    }
    body.note = note;
    return writeOperation(
      `notable.${action}`,
      action === "remove" ? "DELETE" : "POST",
      "/cli/admin/notable-users",
      body,
    );
  }

  // A member's public profile for review (admin-profile.js); a daily-run read.
  if (namespace === "profile") {
    return buildProfileShowOperation({ action, target, extra });
  }

  if (namespace === "notable" && action === "status" && !extra) {
    const rawTarget = String(target || "").trim();
    if (!rawTarget) {
      throw cliValidationError(
        "Usage: lumine admin notable status <userId|username>.",
      );
    }
    const query = /^\d+$/.test(rawTarget)
      ? { userId: parseRequiredInteger(rawTarget, "user ID", 1) }
      : { username: rawTarget };
    return readOperation(
      "notable.status",
      withQuery("/cli/admin/notable-users/status", query),
      { requiresRun: false },
    );
  }

  if (namespace === "ai-costs") {
    if (action === "monthly" && !target && !extra) {
      if (options.adminDays) {
        throw cliValidationError(
          "ai-costs monthly uses UTC calendar months and does not accept --days.",
        );
      }
      return readOperation("ai-costs.monthly", "/cli/admin/ai-costs/monthly", {
        requiresRun: false,
      });
    }
    if (action === "day" && !extra) {
      if (options.adminDays) {
        throw cliValidationError(
          "ai-costs day reads one closed UTC day and does not accept --days.",
        );
      }
      const positionalDay = String(target || "").trim();
      const flaggedDay = String(options.adminDate || "").trim();
      if (positionalDay && flaggedDay && positionalDay !== flaggedDay) {
        throw cliValidationError(
          "Pass the same UTC day once, either positionally or with --date.",
        );
      }
      const dayKey = parseUtcDayKey(positionalDay || flaggedDay);
      return readOperation(
        "ai-costs.day",
        `/cli/admin/ai-costs/day/${dayKey}`,
        { requiresRun: false },
      );
    }
    throw cliValidationError(
      "Usage: lumine admin ai-costs monthly | ai-costs day <YYYY-MM-DD> [--json].",
    );
  }

  if (namespace === "energy-budget" && !action) {
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 31) {
        throw cliValidationError("--days must be an integer between 1 and 31.");
      }
    }
    return readOperation(
      "energy-budget.report",
      withQuery("/cli/admin/energy-budget/report", { days: options.adminDays }),
      { requiresRun: false },
    );
  }

  if (namespace === "runtime") {
    if (
      action !== "evidence" ||
      !["primary", "target"].includes(target) ||
      extra
    ) {
      throw cliValidationError(
        "Usage: lumine admin runtime evidence primary|target [--days 1..7].",
      );
    }
    return readOperation(
      "runtime.evidence",
      withQuery(`/cli/admin/runtime-logs/hosts/${target}/evidence`, {
        days: parseRequiredInteger(options.adminDays || "7", "--days", 1, 7),
      }),
      { requiresRun: false },
    );
  }

  if (namespace === "runtime-logs") {
    if (
      (action === "start" || action === "status" || action === "read") &&
      (!target ||
        (action === "start" && ["primary", "target"].includes(target))) &&
      !extra
    ) {
      if (
        action !== "start" &&
        !String(options.adminReviewSession || "").trim()
      ) {
        throw cliValidationError(
          "Pass the production-log review session with --review-session <file>.",
        );
      }
      return {
        name:
          action === "read" ? "runtime-logs.capture" : `runtime-logs.${action}`,
        method: action === "status" ? "GET" : "POST",
        path: "",
        body: undefined,
        mutates: action !== "status",
        requiresRun: false,
        runtimeLogAction: action === "read" ? "capture" : action,
        ...(action === "start" && target ? { runtimeLogHost: target } : {}),
      };
    }
    if ((action === "resume" || action === "abandon") && !target && !extra) {
      return {
        name: `runtime-logs.${action}`,
        method: "POST",
        path: "",
        body: undefined,
        mutates: true,
        requiresRun: false,
        runtimeLogAction: action,
      };
    }
    if ((action === "finish" || action === "complete") && !target && !extra) {
      if (!String(options.adminReviewSession || "").trim()) {
        throw cliValidationError(
          "Pass the production-log review session with --review-session <file>.",
        );
      }
      if (!options.adminReviewed) {
        throw cliValidationError(
          "Inspect every downloaded runtime-log artifact, then confirm with --reviewed.",
        );
      }
      return {
        name: "runtime-logs.complete",
        method: "POST",
        path: "",
        body: undefined,
        mutates: true,
        requiresRun: false,
        runtimeLogAction: "complete",
      };
    }
    throw cliValidationError(
      "Usage: lumine admin runtime-logs start | status|read --review-session <file> | finish --review-session <file> --reviewed | resume | abandon [--review-session <file>].",
    );
  }

  if (namespace === "media-costs") {
    if (action === "monthly" && !target && !extra) {
      if (options.adminDays) {
        throw cliValidationError(
          "media-costs monthly uses the canonical UTC ledger and does not accept --days.",
        );
      }
      return readOperation(
        "media-costs.monthly",
        "/cli/admin/media-costs/monthly",
      );
    }
    throw cliValidationError(
      "Usage: lumine admin media-costs monthly [--json].",
    );
  }

  if (namespace === "brief" && !action) {
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw cliValidationError("--days must be an integer between 1 and 30.");
      }
    }
    return readOperation(
      "insights.brief",
      withQuery("/cli/admin/insights/brief", { days: options.adminDays }),
    );
  }

  if (namespace === "announcement" && action === "post") {
    return writeOperation(
      "announcement.post",
      "POST",
      "/cli/admin/announcements",
      {
        content: readComposedTextFile(options.adminFile),
      },
    );
  }

  if (namespace === "chat" && action === "send") {
    const rawTarget = String(target || "").trim();
    if (!rawTarget) {
      throw cliValidationError(
        "Usage: lumine admin chat send <userId|username> --file <message.md>.",
      );
    }
    // Composed-only, like persona comments: the agent writes the message in
    // the bot's voice; the server never invokes a model for it.
    return writeOperation("chat.send", "POST", "/cli/admin/chat-messages", {
      target: rawTarget,
      content: readComposedTextFile(options.adminFile),
    });
  }

  if (namespace === "bot-output" && action === "context") {
    const messageId = parseRequiredInteger(target, "bot message ID", 1);
    const reason = String(options.adminReason || "").trim();
    if (!reason || reason.length > MAX_IDENTITY_INSPECTION_REASON_LENGTH) {
      throw cliValidationError(
        "Explain the private bot investigation with --reason (1–500 characters).",
      );
    }
    if (options.adminAll || options.adminDays) {
      throw cliValidationError(
        "Bot context is a narrow message-ID investigation, not an --all or --days scan.",
      );
    }
    return writeOperation(
      "bot.context",
      "POST",
      `/cli/admin/bot-output/${messageId}/context`,
      {
        reason,
        cursor: options.adminCursor || undefined,
        limit: parseRequiredInteger(
          options.adminContextLimit ?? 20,
          "--limit",
          1,
          40,
        ),
      },
    );
  }

  if (namespace === "bot-output" && !action) {
    if (options.adminDays && options.adminCursor) {
      throw cliValidationError(
        "Continue a bot-output --cursor without changing its --days window.",
      );
    }
    if (options.adminDays) {
      const days = Number(options.adminDays);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        throw cliValidationError("--days must be an integer between 1 and 30.");
      }
    }
    return readOperation(
      "bot.output",
      withQuery("/cli/admin/bot-output", {
        days: options.adminDays,
        cursor: options.adminCursor,
      }),
    );
  }

  if (namespace === "audit" && (!action || action === "list")) {
    const runFilter = String(options.adminRun || "").trim();
    if (runFilter && !["current", "last"].includes(runFilter)) {
      parseRequiredInteger(runFilter, "--run", 1);
    }
    return readOperation(
      "audit.list",
      withQuery("/cli/admin/audit", {
        run: runFilter,
        target: options.adminTarget,
        actions: options.adminActions,
        cursor: options.adminCursor,
        limit: options.limit,
        full: options.adminFull ? "true" : "",
      }),
      { pagination: { collectionKey: "events" } },
    );
  }

  if (namespace === "comment") {
    if (action === "session") {
      const sessionAction = target || "status";
      if (sessionAction === "status") {
        return readOperation(
          "comment-session.status",
          "/cli/admin/comment-sessions/status",
        );
      }
      if (sessionAction === "start") {
        const identity = String(options.adminIdentity || "")
          .trim()
          .toLowerCase();
        if (identity !== "zero" && identity !== "ciel") {
          throw cliValidationError(
            "comment session start needs --identity zero|ciel.",
          );
        }
        const targets = parseCommentSessionTargets([
          options.adminTarget,
          ...(options.positional || []).slice(3),
        ]);
        const reason = String(options.adminReason || "").trim();
        return writeOperation(
          "comment-session.start",
          "POST",
          "/cli/admin/comment-sessions",
          {
            identity,
            targets,
            ...(reason ? { reason } : {}),
          },
        );
      }
      if (sessionAction === "close") {
        return writeOperation(
          "comment-session.close",
          "POST",
          "/cli/admin/comment-sessions/close",
          {},
        );
      }
      throw cliValidationError(
        "Usage: lumine admin comment session start --identity zero|ciel --target <type:id>[,<type:id>...] [--reason <text>] | comment session status | comment session close.",
      );
    }
    if (action === "draft" || action === "reply") {
      const parsedTarget = parseAdminCommentTarget({
        target,
        explicitType: options.adminType,
      });
      if (action === "reply" && parsedTarget.type !== "comment") {
        throw cliValidationError(
          "comment reply targets a comment: lumine admin comment reply comment:<id>.",
        );
      }
      const reviewEvidence = readAdminBuildReviewEvidence(
        options,
        parsedTarget,
      );
      if (parsedTarget.type === "build") {
        if (!options.adminFile) {
          throw cliValidationError(
            "Build comments are management-agent composed only; pass --file <comment.md> after reviewing the project.",
          );
        }
        if (
          !reviewEvidence.reviewedBuildVersionId ||
          !reviewEvidence.buildReviewMethod ||
          !reviewEvidence.buildReviewUnderstanding
        ) {
          throw cliValidationError(
            "After reviewing the project, pass review evidence and --review-context <context.json>.",
          );
        }
      }
      return writeOperation(
        "comment.draft",
        "POST",
        "/cli/admin/comment-drafts",
        {
          targetType: parsedTarget.type,
          targetId: parsedTarget.id,
          identity: options.adminIdentity
            ? parseIdentity(options.adminIdentity)
            : undefined,
          ...(options.adminFile
            ? { content: readComposedTextFile(options.adminFile) }
            : {}),
          ...reviewEvidence,
        },
      );
    }
    if (action === "edit") {
      const rawTarget = String(target || "").trim();
      let commentId;
      if (/^\d+$/.test(rawTarget)) {
        commentId = parseRequiredInteger(rawTarget, "comment id", 1);
      } else {
        const parsedTarget = parseRecommendationTarget({
          target,
          explicitType: options.adminType,
        });
        if (parsedTarget.type !== "comment") {
          throw cliValidationError(
            "comment edit targets a comment: lumine admin comment edit <commentId> --file <comment.md>.",
          );
        }
        commentId = parsedTarget.id;
      }
      return writeOperation(
        "comment.edit",
        "PUT",
        `/cli/admin/comments/${commentId}`,
        {
          content: readComposedTextFile(options.adminFile),
          ...readAdminBuildReviewEvidence(options, {
            type: "comment",
            id: commentId,
          }),
        },
        {
          correctionEligible: true,
          correctionCommentId: commentId,
        },
      );
    }
    if (action === "post") {
      const draftId = parseRequiredInteger(
        options.draftId || target,
        "--draft-id",
        1,
      );
      return writeOperation(
        "comment.post",
        "POST",
        `/cli/admin/comment-drafts/${draftId}/publish`,
        {},
      );
    }
  }

  throw cliValidationError(
    "Usage: lumine admin identity|economy|rescue|sponsor|daily-run|escalation|todo|recommendations|builds|post|subjects|subject|featured|comment|announcement|chat|news|audit|brief|ai-costs|media-costs|energy-budget|runtime-logs|bot-output|notable ...",
  );
}

function subjectsListOperation(options) {
  const operatorView = requestedOperatorViewFilter(options);
  const subjectWindow = parseSubjectWindow(options);
  return readOperation(
    "subjects.candidates",
    withQuery("/cli/admin/subjects", {
      sinceRun: subjectWindow.mode === "since-run" ? "true" : "",
      after: subjectWindow.mode === "after" ? subjectWindow.after : "",
      includeLegacy: subjectWindow.mode === "legacy" ? "true" : "",
      cursor: options.adminCursor,
      effort: options.adminEffort,
      limit: options.limit,
    }),
    {
      pagination: {
        collectionKey: "subjects",
        coverageQueue: "subjects",
        coverageMode: subjectWindow.mode,
        after:
          subjectWindow.mode === "after"
            ? parseAfterForCoverage(subjectWindow.after)
            : null,
        filters: {
          effort: options.adminEffort || "all",
          ...(operatorView ? { operatorView } : {}),
        },
      },
    },
  );
}

function subjectGetOperation(target, options) {
  const subjectId = parseSubjectId(target);
  return readOperation(
    "subject.get",
    withQuery(`/cli/admin/subjects/${subjectId}`, {
      includeComments: options.includeComments ? "true" : "",
    }),
  );
}

function postGetOperation(target, options) {
  const parsedTarget = parseRecommendationTarget({
    target,
    explicitType: options.adminType,
  });
  if (parsedTarget.type === "subject") {
    return subjectGetOperation(parsedTarget.id, options);
  }
  if (parsedTarget.type === "comment") {
    return readOperation("post.get", `/cli/admin/comments/${parsedTarget.id}`, {
      correctionEligible: true,
      correctionCommentId: parsedTarget.id,
    });
  }
  return readOperation(
    "post.get",
    `/cli/admin/posts/${parsedTarget.type}/${parsedTarget.id}`,
  );
}

function legacySubjectsOperation({ action, target, options }) {
  if (action === "get") return subjectGetOperation(target, options);
  if (action === "set-effort") {
    const subjectId = parseSubjectId(target);
    const level = parseRequiredInteger(options.adminLevel, "--level", 1, 3);
    return writeOperation(
      "subject.effort.set",
      "PUT",
      `/cli/admin/subjects/${subjectId}/effort`,
      { level },
    );
  }
  if (action === "mark-created-by-author") {
    return subjectWrite(
      "subject.creator.set-made-by-poster",
      "PUT",
      target,
      "/created-by-author",
    );
  }
  if (action === "feature" || action === "unfeature") {
    return subjectWrite(
      `subject.${action}`,
      action === "feature" ? "POST" : "DELETE",
      target,
      "/featured",
    );
  }
  if (action === "reorder") return featuredReorderOperation(options);
  if (action === "rotate") return featuredRotateOperation(options);
  throw cliValidationError(
    `Unknown subjects action: ${action || "(missing)"}.`,
  );
}

function subjectWrite(name, method, target, suffix) {
  const subjectId = parseSubjectId(target);
  return writeOperation(
    name,
    method,
    `/cli/admin/subjects/${subjectId}${suffix}`,
    {},
  );
}

function featuredReorderOperation(options) {
  return writeOperation(
    "featured.reorder",
    "PUT",
    "/cli/admin/subjects/featured/order",
    { ids: parseOrderedIds(options.adminIds) },
  );
}

function featuredAddOperation(options) {
  const addIds = parseFeaturedSubjectIds(options.adminIds, "--subject-ids");
  const postedAfter = String(options.adminPostedAfter || "").trim();
  if (!postedAfter) {
    throw cliValidationError(
      "New Featured additions require --posted-after <ISO-8601-or-Unix-time>.",
    );
  }
  return writeOperation(
    "featured.add",
    "POST",
    "/cli/admin/subjects/featured/additions",
    { addIds, postedAfter },
  );
}

function featuredRotateOperation(options) {
  const removeIds = parseFeaturedSubjectIds(
    options.adminRemoveIds,
    "--remove-subject-ids",
  );
  const addIds = parseFeaturedSubjectIds(
    options.adminAddIds,
    "--add-subject-ids",
  );
  if (removeIds.length !== addIds.length) {
    throw cliValidationError(
      "Featured rotation requires the same number of removal and addition IDs.",
    );
  }
  const removeSet = new Set(removeIds);
  if (addIds.some((id) => removeSet.has(id))) {
    throw cliValidationError(
      "Featured rotation removal and addition IDs must not overlap.",
    );
  }
  return writeOperation(
    "featured.rotate",
    "PUT",
    "/cli/admin/subjects/featured/rotation",
    {
      removeIds,
      addIds,
      ...(options.adminPostedAfter
        ? { postedAfter: options.adminPostedAfter }
        : {}),
    },
  );
}

function recommendOperation(target, options) {
  const recommendationTarget = parseRecommendationTarget({
    target,
    explicitType: options.adminType,
  });
  const rewardTwinkles = options.rewardTwinkles
    ? parseRequiredInteger(options.rewardTwinkles, "--reward-twinkles", 3, 3)
    : 0;
  if (rewardTwinkles === 3 && !options.anyoneCanReward) {
    throw cliValidationError(
      "--reward-twinkles 3 requires --anyone-can-reward.",
    );
  }
  return writeOperation(
    "post.recommend",
    "POST",
    `/cli/admin/recommendations/${recommendationTarget.type}/${recommendationTarget.id}`,
    {
      anyoneCanReward: options.anyoneCanReward,
      rewardTwinkles,
    },
  );
}

export function parseRecommendationWindow(options) {
  const selected = [
    options.adminSinceRun ? "since-run" : "",
    options.adminAfter ? "after" : "",
    options.adminIncludeLegacy ? "legacy" : "",
  ].filter(Boolean);
  if (selected.length > 1) {
    throw cliValidationError(
      "Choose one recommendation window: --since-run, --after, or --include-legacy.",
    );
  }
  const mode = selected[0] || "since-run";
  if (mode === "after") parseAfterForCoverage(options.adminAfter);
  return { mode, after: mode === "after" ? options.adminAfter : "" };
}

export function parseSubjectWindow(options) {
  const selected = [
    options.adminSinceRun ? "since-run" : "",
    options.adminAfter ? "after" : "",
    options.adminIncludeLegacy ? "legacy" : "",
  ].filter(Boolean);
  if (selected.length > 1) {
    throw cliValidationError(
      "Choose one Subject window: --since-run, --after, or --include-legacy.",
    );
  }
  const mode = selected[0] || "since-run";
  if (mode === "after") parseAfterForCoverage(options.adminAfter);
  return { mode, after: mode === "after" ? options.adminAfter : "" };
}

export function parseBuildWindow(options) {
  const selected = [
    options.adminSinceRun ? "since-run" : "",
    options.adminAfter ? "after" : "",
    options.adminIncludeLegacy ? "legacy" : "",
  ].filter(Boolean);
  if (selected.length > 1) {
    throw cliValidationError(
      "Choose one Build window: --since-run, --after, or --include-legacy.",
    );
  }
  const mode = selected[0] || "since-run";
  if (mode === "after") parseAfterForCoverage(options.adminAfter);
  return { mode, after: mode === "after" ? options.adminAfter : "" };
}

function parseUtcDayKey(value) {
  const dayKey = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    throw cliValidationError(
      "Pass a real UTC calendar date in YYYY-MM-DD format.",
    );
  }
  const parsed = new Date(`${dayKey}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== dayKey
  ) {
    throw cliValidationError(
      "Pass a real UTC calendar date in YYYY-MM-DD format.",
    );
  }
  return dayKey;
}

function parseAfterForCoverage(value) {
  const raw = String(value || "").trim();
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  const parsedMs = Date.parse(raw);
  if (Number.isFinite(parsedMs)) return Math.floor(parsedMs / 1000);
  throw cliValidationError(
    "--after must be a Unix timestamp or ISO-8601 date.",
  );
}

export function parseSubjectId(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/(?:^subject:|\/subjects\/)(\d+)(?:[/?#]|$)/i);
  return parseRequiredInteger(match?.[1] || normalized, "subject ID", 1);
}

export function parseRecommendationTarget({ target, explicitType = "" }) {
  const normalized = String(target || "").trim();
  const prefixed = normalized.match(
    /^(subject|comment|aistory|dailyreflection):(\d+)$/i,
  );
  const subjectUrl = normalized.match(/\/subjects\/(\d+)(?:[/?#]|$)/i);
  const commentUrl = normalized.match(/\/comments\/(\d+)(?:[/?#]|$)/i);
  const aiStoryUrl = normalized.match(/\/ai-stories\/(\d+)(?:[/?#]|$)/i);
  const dailyReflectionUrl = normalized.match(
    /\/daily-reflections\/(\d+)(?:[/?#]|$)/i,
  );
  const inferredType =
    normalizeRecommendationTargetType(prefixed?.[1]) ||
    (subjectUrl
      ? "subject"
      : commentUrl
        ? "comment"
        : aiStoryUrl
          ? "aiStory"
          : dailyReflectionUrl
            ? "dailyReflection"
            : "");
  const explicitNormalizedType =
    normalizeRecommendationTargetType(explicitType);
  if (explicitType && !explicitNormalizedType) {
    throw cliValidationError(
      "--type must be subject, comment, aiStory, or dailyReflection.",
    );
  }
  const type = explicitNormalizedType || inferredType || "subject";
  if (!["subject", "comment", "aiStory", "dailyReflection"].includes(type)) {
    throw cliValidationError(
      "--type must be subject, comment, aiStory, or dailyReflection.",
    );
  }
  if (explicitType && inferredType && type !== inferredType) {
    throw cliValidationError(
      "The target and --type identify different content types.",
    );
  }
  const id = parseRequiredInteger(
    prefixed?.[2] ||
      subjectUrl?.[1] ||
      commentUrl?.[1] ||
      aiStoryUrl?.[1] ||
      dailyReflectionUrl?.[1] ||
      normalized,
    `${type} ID`,
    1,
  );
  return { type, id };
}

export function parseAdminCommentTarget({ target, explicitType = "" }) {
  const normalized = String(target || "").trim();
  const prefixed = normalized.match(
    /^(subject|comment|build|aistory|dailyreflection):(\d+)$/i,
  );
  const buildUrl = normalized.match(/\/(?:app|build)\/(\d+)(?:[/?#]|$)/i);
  const baseTarget = parseRecommendationTarget({
    target:
      prefixed?.[1]?.toLowerCase() === "build" || buildUrl
        ? `subject:${prefixed?.[2] || buildUrl?.[1]}`
        : normalized,
    explicitType:
      String(explicitType || "").toLowerCase() === "build"
        ? "subject"
        : explicitType,
  });
  const inferredBuild = prefixed?.[1]?.toLowerCase() === "build" || !!buildUrl;
  const explicitBuild = String(explicitType || "").toLowerCase() === "build";
  if (explicitType && !explicitBuild && inferredBuild) {
    throw cliValidationError(
      "The target and --type identify different content types.",
    );
  }
  if (explicitBuild && !inferredBuild && !/^\d+$/.test(normalized)) {
    throw cliValidationError(
      "The target and --type identify different content types.",
    );
  }
  if (inferredBuild || explicitBuild) {
    return { type: "build", id: baseTarget.id };
  }
  return baseTarget;
}

export function parseAdminEscalationTarget(value) {
  const normalized = String(value || "").trim();
  const genericTarget = normalized.match(
    /^([a-zA-Z][a-zA-Z0-9_-]{0,39}):(\d+)$/,
  );
  if (genericTarget) {
    return {
      targetType: genericTarget[1],
      targetId: parseRequiredInteger(
        genericTarget[2],
        "escalation target ID",
        1,
      ),
      url: null,
    };
  }
  if (/^https:\/\//i.test(normalized)) {
    let parsedUrl;
    try {
      parsedUrl = new URL(normalized);
    } catch {
      throw cliValidationError("The escalation target URL is invalid.");
    }
    if (parsedUrl.protocol !== "https:") {
      throw cliValidationError("The escalation target URL must use HTTPS.");
    }
    if (
      /\/(?:subjects|comments|ai-stories|daily-reflections|app|build)\/\d+(?:[/?#]|$)/i.test(
        normalized,
      )
    ) {
      const parsed = parseAdminCommentTarget({ target: normalized });
      return { targetType: parsed.type, targetId: parsed.id, url: normalized };
    }
    return { targetType: null, targetId: null, url: normalized };
  }
  const parsed = parseAdminCommentTarget({ target: normalized });
  return { targetType: parsed.type, targetId: parsed.id, url: null };
}

function parseAdminBuildReviewMethod(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized !== "runtime" && normalized !== "code") {
    throw cliValidationError("--reviewed-via must be runtime or code.");
  }
  return normalized;
}

function normalizeRecommendationTargetType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "subject" || normalized === "comment") return normalized;
  if (normalized === "aistory" || normalized === "ai-story") return "aiStory";
  if (normalized === "dailyreflection" || normalized === "daily-reflection") {
    return "dailyReflection";
  }
  return "";
}

export function isAdminJsonInvocation(args) {
  return (
    args[0] === "admin" &&
    args.some((arg) => /^--json(?:=(?:1|true|yes|on))?$/i.test(arg))
  );
}

export function formatAdminJsonError(error) {
  const serverResult = error?.data;
  if (serverResult?.ok === false && serverResult?.error) return serverResult;
  return {
    ok: false,
    status:
      error?.code === "CLI_ADMIN_CLI_VALIDATION" ? "validation_error" : "error",
    error: {
      code: error?.code || "LUMINE_ADMIN_ERROR",
      message: String(error?.message || "The administrator command failed."),
      details: null,
    },
  };
}

export function assertAdminTodoHandoffResult(result, expectedRunScope = null) {
  const runId = Number(result?.data?.run?.id || 0);
  const runScope = canonicalAdminRunScope(result?.data?.run);
  if (expectedRunScope && runScope !== expectedRunScope) {
    const error = cliValidationError(
      `The API returned a ${runScope} run when the CLI requested ${expectedRunScope}.`,
    );
    error.code = "LUMINE_ADMIN_RUN_SCOPE_UNSUPPORTED";
    throw error;
  }
  const handoff = result?.data?.carryoverTodos;
  if (runScope !== "full") {
    if (
      !runId ||
      !handoff ||
      handoff.included !== false ||
      !Array.isArray(handoff.items) ||
      handoff.items.length !== 0 ||
      Number(handoff.count) !== 0 ||
      handoff.surfacedForRunId !== null ||
      Number(handoff.newlySurfacedCount) !== 0
    ) {
      const error = cliValidationError(
        "The API did not confirm that carry-over telemetry was suppressed for the scoped run.",
      );
      error.code = "LUMINE_ADMIN_SCOPED_RUN_UNSUPPORTED";
      throw error;
    }
    return handoff;
  }
  if (
    !runId ||
    !handoff ||
    handoff.included === false ||
    !Array.isArray(handoff.items) ||
    Number(handoff.count) !== handoff.items.length ||
    Number(handoff.surfacedForRunId) !== runId ||
    !Number.isSafeInteger(Number(handoff.newlySurfacedCount)) ||
    Number(handoff.newlySurfacedCount) < 0 ||
    Number(handoff.newlySurfacedCount) > handoff.items.length
  ) {
    const error = cliValidationError(
      "The API did not confirm the canonical carry-over todo handoff. Deploy the todo migration/API before using this Lumine CLI for community management.",
    );
    error.code = "LUMINE_ADMIN_TODO_HANDOFF_UNSUPPORTED";
    throw error;
  }
  return handoff;
}

function readOperation(name, path, extra = {}) {
  return {
    name,
    method: "GET",
    path,
    body: undefined,
    mutates: false,
    ...extra,
  };
}

function bodyReadOperation(name, method, path, body) {
  return { name, method, path, body, mutates: false };
}

function writeOperation(name, method, path, body, extra = {}) {
  return { name, method, path, body, mutates: true, ...extra };
}

function withQuery(path, values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value !== null && value !== undefined) {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function parseIdentity(value) {
  const identity = String(value || "")
    .trim()
    .toLowerCase();
  if (!["zero", "ciel", "auto"].includes(identity)) {
    throw cliValidationError("Identity must be zero, ciel, or auto.");
  }
  return identity;
}

function parseCommentMode(value) {
  const mode = String(value || "off")
    .trim()
    .toLowerCase();
  if (!["off", "draft", "post"].includes(mode)) {
    throw cliValidationError("--comment-mode must be off, draft, or post.");
  }
  return mode;
}

function parseDailyRunScope(value) {
  const scope = String(value || "full")
    .trim()
    .toLowerCase();
  if (!["full", "featured", "newspaper"].includes(scope)) {
    throw cliValidationError("--scope must be full, featured, or newspaper.");
  }
  return scope;
}

function parseEscalationStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (!["open", "acknowledged", "resolved"].includes(status)) {
    throw cliValidationError(
      "--status must be open, acknowledged, or resolved.",
    );
  }
  return status;
}

function parseEscalationListStatus(value) {
  const status = String(value || "open")
    .trim()
    .toLowerCase();
  if (!["open", "acknowledged", "resolved", "all"].includes(status)) {
    throw cliValidationError(
      "--status must be open, acknowledged, resolved, or all.",
    );
  }
  return status;
}

function parseTodoKind(value) {
  const kind = String(value || "task")
    .trim()
    .toLowerCase();
  if (!["task", "experiment"].includes(kind)) {
    throw cliValidationError("--kind must be task or experiment.");
  }
  return kind;
}

function parseTodoInitialStatus(value) {
  const status = String(value || "open")
    .trim()
    .toLowerCase();
  if (!["open", "in_progress", "blocked"].includes(status)) {
    throw cliValidationError(
      "A new todo --status must be open, in_progress, or blocked.",
    );
  }
  return status;
}

function parseTodoStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (
    !["open", "in_progress", "blocked", "completed", "cancelled"].includes(
      status,
    )
  ) {
    throw cliValidationError(
      "--status must be open, in_progress, blocked, completed, or cancelled.",
    );
  }
  return status;
}

function parseTodoListStatus(value) {
  const status = String(value || "pending")
    .trim()
    .toLowerCase();
  if (status === "pending" || status === "all") return status;
  return parseTodoStatus(status);
}

function parseOrderedIds(value) {
  return parseFeaturedSubjectIds(value, "--subject-ids", true);
}

function parseFeaturedSubjectIds(value, flag, completeList = false) {
  const ids = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseRequiredInteger(part, "Featured subject ID", 1));
  if (!String(value || "").trim() || ids.length === 0) {
    throw cliValidationError(
      completeList
        ? "Pass the complete ordered list with --subject-ids <id,id,...>."
        : `Pass at least one subject with ${flag} <id,id,...>.`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw cliValidationError(`${flag} subject IDs must be unique.`);
  }
  return ids;
}

function parseAiBucketLabel(value) {
  const label = String(value || "").trim();
  if (!label) {
    throw cliValidationError("Pass the bucket name with --label <name>.");
  }
  if (label.length > 120) {
    throw cliValidationError(
      "An AI bucket name can be at most 120 characters.",
    );
  }
  return label;
}

function parseAiBucketNote(value) {
  const note = String(value || "").trim();
  if (!note) {
    throw cliValidationError("Pass the quota-only context with --note <text>.");
  }
  if (note.length > 255) {
    throw cliValidationError(
      "An AI bucket note can be at most 255 characters.",
    );
  }
  return note;
}

function parseAiBucketUserIds(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw cliValidationError(
      "Pass explicit accounts with --user-ids <id,id,...>.",
    );
  }
  const ids = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseRequiredInteger(part, "AI bucket user ID", 1));
  if (ids.length > 500) {
    throw cliValidationError(
      "An AI bucket batch can contain at most 500 users.",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw cliValidationError("AI bucket user IDs must be unique.");
  }
  return ids;
}

function parseAiEmailPolicyEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  const at = email.indexOf("@");
  if (
    !email ||
    email.length > 320 ||
    /\s/.test(email) ||
    at <= 0 ||
    at !== email.lastIndexOf("@") ||
    at === email.length - 1
  ) {
    throw cliValidationError(
      "Pass a valid verified email with --email <address>.",
    );
  }
  return email;
}

function parseAiEmailPolicyMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  if (mode !== "automatic" && mode !== "separate_accounts") {
    throw cliValidationError("--mode must be automatic or separate_accounts.");
  }
  return mode;
}

function parseAiEmailPolicyNote(value) {
  const note = String(value || "").trim();
  if (!note) {
    throw cliValidationError("Pass the policy reason with --note <text>.");
  }
  if (note.length > 255) {
    throw cliValidationError(
      "An AI email-policy note can be at most 255 characters.",
    );
  }
  return note;
}

function parseRequiredInteger(
  value,
  label,
  minimum,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const raw = String(value ?? "").trim();
  const number = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    const range =
      maximum === Number.MAX_SAFE_INTEGER
        ? `at least ${minimum}`
        : `${minimum}-${maximum}`;
    throw cliValidationError(`${label} must be an integer ${range}.`);
  }
  return number;
}

function parseChoice(value, label, choices) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!choices.includes(normalized)) {
    throw cliValidationError(`${label} must be ${choices.join(", ")}.`);
  }
  return normalized;
}

function defaultDailyRunKey(runScope = "full") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const day = `${value.year}-${value.month}-${value.day}`;
  return runScope === "full"
    ? `daily:${day}`
    : `scoped:${runScope}:${day}:${randomUUID()}`;
}

function cliValidationError(message) {
  const error = new Error(message);
  error.code = "CLI_ADMIN_CLI_VALIDATION";
  return error;
}

function adminValueFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function formatAdminUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "unavailable";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatAdminMonthlyCostComparison(projection, previousMonthKey) {
  const rawPercent = projection?.comparisonToPreviousMonth?.percentChange;
  const percent = rawPercent === null ? NaN : Number(rawPercent);
  if (!Number.isFinite(percent)) {
    return `comparison with ${previousMonthKey} unavailable`;
  }
  if (percent === 0) return `even with ${previousMonthKey}`;
  return `${Math.abs(percent).toFixed(2)}% ${percent < 0 ? "below" : "above"} ${previousMonthKey}`;
}

function printAdminMonthlyAiCosts(monthlyAiCosts) {
  const previous = monthlyAiCosts.previousMonth;
  const current = monthlyAiCosts.currentMonth;
  const generatedAt = new Date(
    Number(monthlyAiCosts.generatedAt) * 1000,
  ).toISOString();
  console.log(`Application AI-cost ledger (UTC; generated ${generatedAt}).`);
  console.log(
    `${previous.monthKey} closed month: ${formatAdminUsd(previous.estimatedCostUsd)} estimated cost.`,
  );
  if (current.completed.dayCount > 0) {
    console.log(
      `${current.monthKey} completed-day MTD through ${current.completed.throughDayKey}: ${formatAdminUsd(current.completed.estimatedCostUsd)} across ${current.completed.dayCount} completed UTC day(s).`,
    );
  } else {
    console.log(
      `${current.monthKey} completed-day MTD: ${formatAdminUsd(current.completed.estimatedCostUsd)}; no UTC day has completed yet.`,
    );
  }
  console.log(
    `${current.inProgressDay.dayKey} in progress: ${formatAdminUsd(current.inProgressDay.estimatedCostUsd)} so far (excluded from completed-day MTD and both projections).`,
  );

  const allPace = current.projections.allCompletedDaysPace;
  if (allPace) {
    console.log(
      `All-completed-days pace full-month projection: ${formatAdminUsd(allPace.estimatedMonthTotalUsd)} (${formatAdminUsd(allPace.dailyAverageUsd)}/day across ${allPace.basisDayCount} completed day(s); ${formatAdminMonthlyCostComparison(allPace, previous.monthKey)}).`,
    );
  } else {
    console.log(
      "All-completed-days pace full-month projection: unavailable until one UTC day has completed.",
    );
  }

  const recentPace = current.projections.recentSevenCompletedDaysPace;
  if (recentPace) {
    console.log(
      `Recent-seven-completed-day pace full-month projection: ${formatAdminUsd(recentPace.estimatedMonthTotalUsd)} (${formatAdminUsd(recentPace.dailyAverageUsd)}/day from ${recentPace.basisStartDayKey} through ${recentPace.basisEndDayKey}; ${formatAdminMonthlyCostComparison(recentPace, previous.monthKey)}).`,
    );
  } else {
    console.log(
      "Recent-seven-completed-day pace full-month projection: unavailable until seven UTC days have completed.",
    );
  }
}

function printAdminDailyAiCosts(dailyAiCosts) {
  console.log(
    `Application AI-cost ledger for ${dailyAiCosts.day.dayKey} (closed UTC day): ${formatAdminUsd(dailyAiCosts.summary?.estimatedCostUsd)} across ${Number(dailyAiCosts.summary?.requestCount || 0)} request(s).`,
  );
  for (const row of dailyAiCosts.byProviderModel || []) {
    console.log(
      `  ${row.provider || "unknown"}/${row.model || "unknown"}: ${formatAdminUsd(row.estimatedCostUsd)} · ${Number(row.totalTokens || 0)} token(s) · ${Number(row.requestCount || 0)} request(s).`,
    );
  }
}

function printAdminEnergyBudget(energyBudget) {
  const headline = energyBudget.lastCompletedDay;
  if (headline) {
    console.log(
      `AI Energy budget health, last completed UTC day ${headline.dayKey}: ${formatAdminUsd(headline.chargedUsd)} charged, ${formatAdminUsd(headline.overflowUsd)} overflow, ${headline.users} user(s), ${headline.recharges} recharge(s), ${headline.runs.total.runs} run(s), ${headline.telemetry.metrics.busy_refusal.count} busy refusal(s).`,
    );
  } else {
    console.log(
      "AI Energy budget health: no completed UTC day in the requested window.",
    );
  }
  console.log(
    "day        | charged | overflow | users | rechg | runs | calls/run avg/p90 | $/run avg/p90 | stops chg/unchg | busy | queue rst/stop/resume | telemetry rows",
  );
  for (const day of energyBudget.byDay || []) {
    const m = day.telemetry.metrics;
    const runs = day.runs.total;
    // Queue metrics are absent from APIs older than the queued-request telemetry.
    const queue = ["queued_restored", "queued_stopped", "busy_resume_requested"]
      .map((metric) => String(m[metric]?.count ?? "-"))
      .join("/");
    console.log(
      `${day.dayKey}${day.inProgress ? "*" : " "}| ${formatAdminUsd(day.chargedUsd).padStart(7)} | ${formatAdminUsd(day.overflowUsd).padStart(8)} | ${String(day.users).padStart(5)} | ${String(day.recharges).padStart(5)} | ${String(runs.runs).padStart(4)} | ${String(runs.callsPerRun.avg).padStart(7)}/${String(runs.callsPerRun.p90).padEnd(9)} | ${formatAdminUsd(runs.usdPerRun.avg).padStart(6)}/${formatAdminUsd(runs.usdPerRun.p90).padEnd(6)} | ${String(m.budget_stop_changed.count).padStart(7)}/${String(m.budget_stop_unchanged.count).padEnd(7)} | ${String(m.busy_refusal.count).padStart(4)} | ${queue.padEnd(21)} | ${day.telemetry.rowCount}`,
    );
  }
  console.log("* = in-progress UTC day; never headline it.");
  const flags = energyBudget.flags || [];
  if (flags.length === 0) {
    console.log("Flags: none.");
    return;
  }
  console.log(
    `Flags (${flags.length}) — record each as a carry-over todo and escalate; never auto-enforce:`,
  );
  for (const flag of flags) {
    console.log(`  ${flag.dayKey} ${flag.code}: ${flag.message}`);
  }
}

function formatAdminMediaUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "unavailable";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function formatAdminMediaBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "unavailable";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
}

function printAdminMonthlyMediaCosts(monthlyMediaCosts) {
  const generatedAt = new Date(
    Number(monthlyMediaCosts.generatedAt) * 1000,
  ).toISOString();
  const current = monthlyMediaCosts.currentMonth;
  const today = monthlyMediaCosts.currentUtcDay;
  const operations = monthlyMediaCosts.operations;
  const streamAttempts = today.streamAttempts || {
    attemptedCount: 0,
    reachedLiveCount: 0,
    endedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    inProgressCount: 0,
    failureCodeCounts: [],
  };
  console.log(
    `Lumine media-cost monitor (UTC; ${monthlyMediaCosts.status}; generated ${generatedAt}).`,
  );
  console.log(
    `${current.monthKey}: ${formatAdminMediaUsd(current.estimatedSpentUsd)} settled estimate + ${formatAdminMediaUsd(current.activeReservedUsd)} active reservations + ${formatAdminMediaUsd(current.carryoverUsd)} carryover = ${formatAdminMediaUsd(current.guardedTotalUsd)} guarded of ${formatAdminMediaUsd(current.limitUsd)} (${Number(current.percentUsed).toFixed(2)}% used; ${formatAdminMediaUsd(current.remainingUsd)} remaining).`,
  );
  console.log(
    `${today.dayKey} so far: ${today.reservationsCreated} action(s) reserved, ${today.commitmentsSettled} committed, ${today.cancellationsSettled} cancelled, ${formatAdminMediaUsd(today.estimatedCostSettledUsd)} settled estimate.`,
  );
  console.log(
    `Stream attempts created ${today.dayKey} UTC: ${streamAttempts.attemptedCount} attempted / ${streamAttempts.reachedLiveCount} reached live / ${streamAttempts.endedCount} ended after live / ${streamAttempts.failedCount} failed / ${streamAttempts.cancelledCount} cancelled before live / ${streamAttempts.inProgressCount} still in progress.`,
  );
  const streamFailureCodeCounts = Array.isArray(
    streamAttempts.failureCodeCounts,
  )
    ? streamAttempts.failureCodeCounts
    : [];
  console.log(
    streamFailureCodeCounts.length > 0
      ? `Stream failure codes: ${streamFailureCodeCounts
          .map((entry) => `${entry.code}=${entry.count}`)
          .join(", ")}.`
      : "Stream failure codes: none.",
  );
  const stillActiveOrCleanupPendingCount =
    operations.live.stillActiveOrCleanupPendingCount ??
    Number(operations.live.provisioningCount || 0) +
      Number(operations.live.readyCount || 0) +
      Number(operations.live.liveCount || 0) +
      Number(operations.live.endingCount || 0) +
      Number(operations.live.cleanupFailedCount || 0);
  const replayOperations = operations.replays || {
    pendingCount: 0,
    processingCount: 0,
    readyCount: 0,
    failedCount: 0,
    deletePendingCount: 0,
    deleteFailedCount: 0,
    expiredReadyCount: 0,
    finalizationOverdueCount: 0,
    deletionOverdueCount: 0,
    storedBytes: 0,
    storedObjectCount: 0,
  };
  const replayViewers = operations.replayViewers || {
    activeGrantCount: 0,
    expiredActiveGrantCount: 0,
  };
  const kindRows = [
    ["Short clips", current.byKind.clip],
    ["Live inputs", current.byKind.liveInput],
    ["Live viewers", current.byKind.liveViewer],
  ];
  if (current.byKind.replayViewer) {
    kindRows.push(["Replay viewers", current.byKind.replayViewer]);
  }
  for (const [label, cost] of kindRows) {
    console.log(
      `${label}: ${cost.actionCount} action(s), ${cost.committedCount} committed for ${formatAdminMediaUsd(cost.estimatedSpentUsd)}, ${cost.activeReservedCount} active reservation(s) holding ${formatAdminMediaUsd(cost.activeReservedUsd)}, ${cost.cancelledCount} cancelled.`,
    );
  }
  console.log(
    `Ledger reconciliation: ${current.reconciliation.consistent ? "consistent" : "MISMATCH"}; spent delta ${formatAdminMediaUsd(current.reconciliation.spentDeltaUsd)}, reserved delta ${formatAdminMediaUsd(current.reconciliation.reservedDeltaUsd)}.`,
  );
  console.log(
    `Operations: clips ${operations.clips.completingCount} completing / ${operations.clips.processingCount} processing / ${operations.clips.staleCount} stale; live ${operations.live.liveCount} broadcasting / ${stillActiveOrCleanupPendingCount} active-or-cleanup-pending / ${operations.live.costBearingChannelCount} cost-bearing channel(s) / ${operations.live.possibleOrphanedCount ?? operations.live.cleanupOverdueCount} possible orphan(s); viewers ${operations.viewers.activeGrantCount} active / ${operations.viewers.expiredActiveGrantCount} expired-active.`,
  );
  console.log(
    `Replays: ${replayOperations.pendingCount} pending / ${replayOperations.processingCount} processing / ${replayOperations.readyCount} ready / ${replayOperations.failedCount} failed / ${replayOperations.deletePendingCount} deleting / ${replayOperations.deleteFailedCount} delete-failed; ${replayOperations.finalizationOverdueCount} finalization-overdue / ${replayOperations.deletionOverdueCount} deletion-overdue / ${replayOperations.expiredReadyCount} expired-ready; ${formatAdminMediaBytes(replayOperations.storedBytes)} across ${replayOperations.storedObjectCount} canonical object(s); viewers ${replayViewers.activeGrantCount} active / ${replayViewers.expiredActiveGrantCount} expired-active.`,
  );
  console.log(
    `Shared runtime storage context: ${operations.runtimeStorage.readyImages.assetCount} ready image(s), ${formatAdminMediaBytes(operations.runtimeStorage.readyImages.totalBytes)}; ${operations.runtimeStorage.readyClips.assetCount} ready clip(s), ${formatAdminMediaBytes(operations.runtimeStorage.readyClips.totalBytes)}. Images include all Build runtime image uploads, not only camera captures.`,
  );
  if (monthlyMediaCosts.alerts.length === 0) {
    console.log("Media-cost alerts: none.");
  } else {
    for (const alert of monthlyMediaCosts.alerts) {
      console.log(
        `Media-cost alert [${String(alert.severity).toUpperCase()}] ${alert.code}: ${alert.message}`,
      );
    }
  }
  console.log(
    "These are conservative provider-cost ledger estimates, not an AWS invoice; reconcile IVS, MediaConvert, replay S3, and shared runtime S3 Cost Explorer data separately after billing lag.",
  );
}

async function printSpooledAdminResult({ operation, result, storage }) {
  const data = result?.data || {};
  const count = Number(storage.candidateCount || 0);
  if (operation.name === "featured.history") {
    printFeaturedHistorySummary(data);
    console.log(`${count} Featured history event(s):`);
    await forEachPaginatedResultItem(result, async (event) => {
      printFeaturedHistoryEvent(event);
    });
  } else if (storage.collectionKey === "subjects") {
    console.log(`${count} subject(s):`);
    await forEachPaginatedResultItem(result, async (subject) => {
      console.log(
        `#${subject.id} ${subject.title || "(untitled)"} — ${subject.author?.username || "unknown"} — effort ${subject.effortLevel ?? "unknown"}`,
      );
      console.log(`  ${subject.url}`);
    });
  } else if (storage.collectionKey === "events") {
    console.log(`${count} audit event(s):`);
    await forEachPaginatedResultItem(result, async (event) => {
      const target =
        event.targetType && event.targetId
          ? ` ${event.targetType}:${event.targetId}`
          : "";
      console.log(
        `#${event.id} run ${event.runId ?? "-"} ${event.action}${target} — ${event.result}${event.changed === true ? " (changed)" : event.changed === false ? " (no change)" : ""}`,
      );
    });
  } else if (storage.collectionKey === "comments") {
    console.log(
      `${count} comment(s) for ${data.subject?.url || "this target"}:`,
    );
    await forEachPaginatedResultItem(result, async (comment) => {
      console.log(
        `#${comment.id} ${comment.author?.username || "unknown"}: ${comment.content || "(empty)"}`,
      );
    });
  } else if (storage.collectionKey === "items") {
    console.log(`${count} recommendation candidate(s):`);
    await forEachPaginatedResultItem(result, async (item) => {
      console.log(`#${item.contentId} ${item.contentType}`);
      if (item.url || item.subjectUrl) {
        console.log(`  ${item.url || item.subjectUrl}`);
      }
    });
  } else if (storage.collectionKey === "builds") {
    console.log(`${count} Build candidate(s):`);
    await forEachPaginatedResultItem(result, async (build) => {
      console.log(`#${build.id} ${build.title || "(untitled)"}`);
      if (build.url) console.log(`  ${build.url}`);
    });
  } else {
    console.log(
      `${count} ${storage.collectionKey} candidate(s) saved at ${storage.spoolPath}.`,
    );
  }
  printPagination(data.pagination);
}

function formatRewardReviewLine(review) {
  const owner = review.ownerUsername ? ` by ${review.ownerUsername}` : "";
  const rules = Array.isArray(review.config?.rules)
    ? review.config.rules.length
    : Number(review.ruleCount || 0);
  return `#${review.id} ${String(review.status || "").toUpperCase()} · ${review.title || `App ${review.buildId}`}${owner} · app ${review.buildId} · saved version ${review.sourceVersionId} · ${rules} rule${rules === 1 ? "" : "s"}`;
}

// One reviewer-facing line per earning rule: amounts, what a later try pays,
// how many tries, and which site days (UTC) the dated sets cover.
export function formatRewardRuleLine(rule) {
  const parts = [
    `rule ${rule.id}: ${rule.title} · ${rule.xp} XP + ${rule.coins} Coins`,
  ];
  if (rule.verifier === "completion") {
    parts.push(
      `completion · pays when the app reports it finished at least ${rule.minSeconds || 0}s after start · once per learner per day`,
    );
    return parts.join(" · ");
  }
  if (rule.retry) {
    parts.push(
      `retry pays ${Math.floor((rule.xp * rule.retry.xpPercent) / 100)} XP + ${Math.floor((rule.coins * rule.retry.coinsPercent) / 100)} Coins${rule.retry.paidAttempts ? ` through try ${rule.retry.paidAttempts} (later solves pay nothing)` : ""}`,
    );
  }
  parts.push(
    rule.maxAttempts === null
      ? "unlimited tries"
      : `${rule.maxAttempts ?? 3} tries`,
  );
  const standing = Array.isArray(rule.questions) ? rule.questions.length : 0;
  const sets = Array.isArray(rule.sets) ? rule.sets : [];
  if (sets.length && rule.progression === "until-earned") {
    const keys = sets.map((set, index) => set.key || `set-${index + 1}`);
    parts.push(
      `${sets.length} until-earned set(s) in order: ${keys.join(", ")}${standing ? ` · ${standing} standing question(s)` : ""}`,
    );
  } else if (sets.length) {
    const days = sets.map((set) =>
      set.to && set.to !== set.from ? `${set.from}..${set.to}` : set.from,
    );
    parts.push(
      `${sets.length} dated set(s): ${days.join(", ")}${standing ? ` · ${standing} standing question(s)` : " · no standing questions"}`,
    );
  } else {
    parts.push(`${standing} question(s)`);
  }
  return parts.join(" · ");
}

function printRewardReviewResult({ operation, data }) {
  if (operation.name === "reward-review.list") {
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    console.log(
      `${reviews.length} reward review(s) (${data.filter || "pending"}):`,
    );
    for (const review of reviews)
      console.log(`  ${formatRewardReviewLine(review)}`);
    if (data.nextCursor) console.log(`More: --cursor ${data.nextCursor}`);
    return;
  }
  const review = data.review || {};
  console.log(formatRewardReviewLine(review));
  if (operation.name === "reward-review.decide") {
    console.log(
      `Decision recorded: ${operation.decision}. ${review.reason ? `Reason: ${review.reason}` : ""}`.trim(),
    );
    if (review.published) {
      console.log(
        `Published on approval: version ${review.published.version} (artifact ${review.published.artifactVersionId}, ${review.published.transition}). The app is live now.`,
      );
    }
  }
  if (operation.name === "reward-review.propose") {
    console.log(
      `Proposal offered to the creator (${operation.fileCount} file(s) sent). They can accept (which publishes your version with these rules) or decline (which rejects the request).`,
    );
  }
  if (review.proposal) {
    const summary = review.proposal.diffSummary || {};
    console.log(
      `Proposal: ${summary.total ?? 0} file(s) changed (${summary.added ?? 0} added, ${summary.updated ?? 0} updated, ${summary.deleted ?? 0} deleted)${review.proposal.note ? ` · note: ${review.proposal.note}` : ""}${review.status === "changes_offered" ? " · waiting for the creator" : ""}`,
    );
    for (const file of review.proposal.changedFiles || [])
      console.log(`  ${file.status}: ${file.path}`);
  }
  if (review.status === "rejected" && review.declinedByCreator) {
    console.log(
      "The creator declined the proposed changes; the request is closed.",
    );
  }
  if (review.status === "approved" && review.publishedArtifactVersionId) {
    console.log(
      `Approved and published (artifact version ${review.publishedArtifactVersionId}).`,
    );
  }
  if (Array.isArray(review.detectedRuleIds)) {
    console.log(
      `Rule IDs found in source (heuristic): ${review.detectedRuleIds.join(", ") || "none"}`,
    );
  }
  if (review.isLatest === false)
    console.log(
      "WARNING: a newer request exists for this app; decide on the latest one.",
    );
  if (review.isLive)
    console.log("This review is the live approval currently paying out.");
  if (review.awarded) {
    console.log(
      `Paid by this review: ${review.awarded.awards} awards to ${review.awarded.earners} people · ${review.awarded.xp} XP · ${review.awarded.coins} Coins (app lifetime ${review.appLifetime?.xp ?? 0} XP / ${review.appLifetime?.coins ?? 0} Coins)`,
    );
  }
  const config = review.config || {};
  if (Array.isArray(config.rules)) {
    console.log(
      `Budgets: per user/day ${config.userDailyXP} XP/${config.userDailyCoins} Coins${config.userDailyClaims ? ` · ${config.userDailyClaims} claim(s)` : ""}`,
    );
    for (const rule of config.rules)
      console.log(`  ${formatRewardRuleLine(rule)}`);
  }
  if (Array.isArray(review.files)) {
    console.log(
      `Source: ${review.files.length} file(s)${data.snapshotDirectory ? ` written to ${data.snapshotDirectory}` : " (pass --dir <path> to write the snapshot)"}`,
    );
    for (const file of review.files)
      console.log(
        `  ${file.path} (${file.bytes ?? Buffer.byteLength(String(file.content || ""), "utf8")} bytes)`,
      );
  }
  console.log("Use --json for the full record.");
}

function formatAdminCounts(counts) {
  return Object.entries(counts || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key} ${count}`)
    .join(" · ");
}

function printRewardReviewLifecycle(lifecycle) {
  // Absent from APIs older than the review-lifecycle telemetry.
  if (!lifecycle) return;
  const totals = lifecycle.totals || {};
  if (!Object.keys(totals.actions || {}).length) {
    console.log("Review lifecycle: no review events in the window.");
    return;
  }
  console.log(`Review lifecycle: ${formatAdminCounts(totals.actions)}.`);
  if (Object.keys(totals.thumbnails || {}).length)
    console.log(
      `  automatic thumbnail after review publishes: ${formatAdminCounts(totals.thumbnails)}`,
    );
  if (Object.keys(totals.refusals || {}).length)
    console.log(
      `  refused decisions (decision:code): ${formatAdminCounts(totals.refusals)}`,
    );
}

function printRewardActivity(data) {
  const apps = Array.isArray(data.apps) ? data.apps : [];
  const suspects = Array.isArray(data.suspects) ? data.suspects : [];
  console.log(
    `Reward activity ${data.from} → ${data.to} (${data.days} day(s)): ${apps.length} app(s) paid, ${suspects.length} flagged player-day(s).`,
  );
  for (const app of apps) {
    console.log(
      `  app ${app.buildId} ${app.title}: ${app.claims} claim(s) · ${app.earners} earner(s) · ${app.xp} XP · ${app.coins} Coins · ${app.flagged} flagged`,
    );
  }
  printRewardReviewLifecycle(data.reviewLifecycle);
  if (!suspects.length) {
    console.log(
      "Nothing unusual: no claim on the minimum time, no bursts, no sweeps, no repeated cap days, no guessing.",
    );
    return;
  }
  console.log("Flagged (worst first):");
  for (const s of suspects) {
    const parts = [
      `${s.flags.join("+")}`,
      `user ${s.userId}${s.username ? ` ${s.username}` : ""}`,
      `app ${s.buildId} ${s.title}`,
      s.dayKey,
      `${s.claims} claim(s) · ${s.xp} XP`,
    ];
    if (s.fastClaims)
      parts.push(
        `${s.fastClaims} on the minimum (fastest ${s.minElapsedSeconds}s)`,
      );
    if (s.guessing)
      parts.push(
        `${s.guessing} challenge(s) with ${data.limits?.guessingAttempts ?? 15}+ wrong answers`,
      );
    console.log(`  ${parts.join(" · ")}`);
  }
  console.log(
    "Flags: fast = claimed within 5 s of the rule's minimum; burst = 3+ claims in 10 min; sweep = 75%+ of an app's completion rules within 30 min; cap = at the per-learner day cap; daily-max = at the cap on 3+ days; guessing = 15+ wrong answers on one quiz challenge. None is proof: read the player before acting.",
  );
}

function describeSafetyHold(hold) {
  const covers = [
    ...(hold.channelIds || []).map((id) => `channel ${id}`),
    ...(hold.userIds || []).map((id) => `user ${id}`),
  ].join(", ");
  const placed = hold.placedAt
    ? new Date(hold.placedAt * 1000).toISOString()
    : "unknown";
  return `Hold #${hold.id} ${hold.status} (${hold.source}, placed ${placed}${hold.placedByUserId ? ` by user ${hold.placedByUserId}` : " automatically"}): ${covers || "nothing"}; reports ${(hold.reportIds || []).map((id) => `#${id}`).join(", ") || "none"}; ${hold.preservedRecords || 0} preserved cop${hold.preservedRecords === 1 ? "y" : "ies"}. ${hold.reason || ""}`;
}

function printChatSafetyResult({ operation, data }) {
  if (operation.name === "chat-reports.hold" || operation.name === "chat-reports.release") {
    if (data.hold) console.log(describeSafetyHold(data.hold));
    return true;
  }
  if (operation.name === "chat-reports.list-holds") {
    const holds = data.holds || [];
    console.log(`${holds.length} ${data.filter || ""} safety hold(s).`);
    for (const hold of holds) console.log(`  ${describeSafetyHold(hold)}`);
    return true;
  }
  if (operation.name === "chat-reports.export") {
    console.log(
      `Evidence package written to ${data.evidenceDirectory} (${(data.files || []).length} files, hashes verified).`,
    );
    console.log(`manifest.json SHA-256: ${data.manifestSha256}`);
    for (const file of data.files || []) {
      console.log(`  ${file.path}  ${file.bytes} bytes${file.sha256 ? `  ${file.sha256}` : ""}`);
    }
    console.log(
      "Keep this folder private. Give it only to police or child-protection staff handling the case, and write the manifest hash in your records.",
    );
    return true;
  }
  if (operation.name === "chat-reports.suspend") {
    console.log(
      `${data.user?.username || "user"} (user ${data.user?.id}) ${data.alreadySuspended ? "was already" : "is now"} suspended (full ban: signed out, cannot use the site).${(data.holdIds || []).length ? ` Safety hold(s): #${data.holdIds.join(", #")}.` : " No safety hold covers this account yet; place one with chat-reports hold."}`,
    );
    return true;
  }
  return false;
}

function formatCardCraftReviewLine(review) {
  return `#${review.id} · ${review.status}${review.isLive ? " (live)" : ""} · Build ${review.buildId}${review.appTitle ? ` "${review.appTitle}"` : ""}${review.ownerUsername ? ` by ${review.ownerUsername}` : ""}${review.reason ? ` · ${review.reason}` : ""}`;
}

function printCardCraftReviewResult({ operation, data }) {
  if (operation.name === "cardcraft-review.list") {
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    console.log(
      `${reviews.length} card crafting review(s) (${data.filter || "pending"}):`,
    );
    for (const review of reviews)
      console.log(`  ${formatCardCraftReviewLine(review)}`);
    if (data.nextCursor) console.log(`More: --cursor ${data.nextCursor}`);
    return;
  }
  const review = data.review || {};
  if (operation.name === "cardcraft-review.decide") {
    console.log(
      `Decision recorded: ${operation.decision} → #${review.id} is ${review.status}.`,
    );
    if (review.status === "approved")
      console.log(
        "Crafting in the published app now uses this recipe (no republish needed).",
      );
    if (review.status === "revoked")
      console.log(
        "New crafts stopped. Existing assets stay with their cards.",
      );
    return;
  }
  console.log(formatCardCraftReviewLine(review));
  if (review.craftedCount !== undefined)
    console.log(`Assets crafted under this recipe: ${review.craftedCount}`);
  for (const problem of review.problems || [])
    console.log(`  problem: ${problem}`);
  const declaration = review.declaration || {};
  if (declaration.guidance) console.log(`Guidance: ${declaration.guidance}`);
  for (const kind of declaration.kinds || []) {
    console.log(`Kind ${kind.id} "${kind.label}"${kind.description ? ` — ${kind.description}` : ""}`);
    for (const [name, param] of Object.entries(kind.params || {})) {
      const shape =
        param.type === "enum"
          ? `one of ${param.values.join(", ")}`
          : param.type === "integer" || param.type === "number"
            ? `${param.type} ${param.min}-${param.max}${param.scaleWithTier ? " (scales with colour)" : ""}`
            : param.type === "string"
              ? `text up to ${param.maxLength}`
              : param.type;
      console.log(`    ${name}: ${shape}`);
    }
  }
  const colours = ["", "blue", "pink", "orange", "magenta", "gold", "black"];
  for (const level of ["1", "2", "3", "4", "5", "6"]) {
    const kinds = (declaration.tiers || {})[level];
    console.log(
      `  ${level} ${colours[Number(level)]}: ${kinds?.length ? kinds.join(", ") : "not craftable"}`,
    );
  }
  for (const event of review.events || [])
    console.log(
      `  ${new Date(event.createdAt * 1000).toISOString()} ${event.action} by ${event.actorId}${event.reason ? `: ${event.reason}` : ""}`,
    );
}

const MEETUP_NAMESPACES = new Set([
  "meetup",
  "meetups",
  "meetup-quest",
  "bridge-builder",
]);

function formatMeetupMembers(members) {
  return (members || [])
    .map(
      (member) =>
        `${member.username || `user ${member.userId}`} (${member.userId}, ${member.branch || "no branch"}${member.parentOk === undefined ? "" : member.parentOk ? ", parent OK" : ", parent not yet"}${member.attended ? ", attended" : ""}${member.infoCheck === "requested" ? ", details asked" : member.infoCheck === "answered" ? ", ANSWERED: review" : ""})`,
    )
    .join("; ");
}

function printMeetupCrew(crew) {
  const progress = crew.progress || {};
  console.log(
    `Crew #${crew.crewId}${crew.name ? ` "${crew.name}"` : ""} · ${crew.status}${crew.isOpen === false ? " · invite only" : ""} · step: ${progress.currentStep || "done"}${progress.blocking ? ` · ${progress.blocking}` : ""}`,
  );
  if (crew.about) console.log(`  About: ${crew.about}`);
  for (const step of progress.steps || []) {
    console.log(`  ${step.number}. ${step.label} [${step.state}] ${step.detail}`);
  }
  console.log(`  Members: ${formatMeetupMembers(crew.members)}`);
  // staff's "who are you" checks on these members (any crew), newest first
  for (const check of crew.memberChecks || []) {
    const answer = check.teacherName
      ? `teacher "${check.teacherName}", class "${check.className}"`
      : check.relationship
        ? `how they know the crew: "${check.relationship}"`
        : "no answer yet";
    console.log(
      `  Who-are-you check #${check.checkId} · ${check.username} (${check.userId}) · crew #${check.crewId} · ${check.status}${check.askNote ? ` · asked: "${check.askNote}"` : ""} · ${answer}${check.reviewedBy ? ` · ${check.status} by ${check.reviewedBy}` : ""}${check.staffNote ? ` · note: ${check.staffNote}` : ""}`,
    );
  }
  for (const parent of crew.parentContacts || []) {
    console.log(
      `  Parent of ${parent.childUsername}: ${parent.status}${parent.verifiedGuardian ? " (guardian on file)" : parent.staffVerified ? " (staff verified)" : " (child-typed address: NOT verified)"} · ${parent.email}${parent.question ? ` · asks: "${parent.question}"` : ""}`,
    );
  }
  if (Array.isArray(crew.invites) && crew.invites.length) {
    console.log(
      `  Pending invites: ${crew.invites.map((invite) => `${invite.username} (${invite.userId}, invite ${invite.inviteId})`).join("; ")}`,
    );
  }
  if (crew.adult?.kind) {
    console.log(
      `  Adult coming: ${crew.adult.kind === "teacher" ? "Twinkle teacher" : "parent"}: ${crew.adult.name}`,
    );
  }
  const plan = crew.plan || {};
  if (plan.status && plan.status !== "none") {
    console.log(
      `  Plan (${plan.status}): ${plan.date}${plan.time ? ` at ${plan.time}` : ""} in ${plan.area}: ${plan.activity}${plan.note ? ` · note: ${plan.note}` : ""}`,
    );
  }
  if (crew.planApprovedBy?.username) {
    console.log(`  Plan approved by ${crew.planApprovedBy.username}`);
  }
  const venue = crew.venue || {};
  if (venue.status && venue.status !== "none") {
    const slots = (venue.slots || []).map(
      (slot, index) => `[${index}] ${slot.date} ${slot.start}-${slot.end}`,
    );
    console.log(
      `  Venue (${venue.status}): ${venue.room ? `${venue.branch} · ${venue.room}` : "no classroom (meets elsewhere with the grown-up)"}${slots.length ? ` · slots ${slots.join(", ")}` : ""}${venue.confirmedSlot ? ` · SET: ${venue.confirmedSlot.date} ${venue.confirmedSlot.start}-${venue.confirmedSlot.end}` : ""}`,
    );
  }
  const video = crew.video || {};
  if (video.status && video.status !== "none") {
    console.log(
      `  Video (${video.status}): ${video.fileName}${video.note ? ` · note: ${video.note}` : ""}`,
    );
    if (video.url) console.log(`  Watch (link expires in 1 hour): ${video.url}`);
  }
}

function printMeetupResult({ operation, data, result }) {
  if (operation.name === "meetup.story.list") {
    const stories = Array.isArray(data.stories) ? data.stories : [];
    console.log(`${stories.length} Bridge Builder stor${stories.length === 1 ? "y" : "ies"} waiting for approval:`);
    for (const story of stories) {
      console.log(
        `  crew #${story.crewId} · "${story.title}" · ${story.crewName} (${(story.people || []).join(", ")}) · ${story.itemsPublic} public / ${story.itemsPrivate} private`,
      );
    }
    if (stories.length) console.log("Approve: lumine admin meetup story approve <crewId> (or send-back <crewId> --note).");
    return;
  }
  if (operation.name === "meetup.story.show") {
    const story = data.story || {};
    const items = [...(story.photos || []), ...(story.clips || [])];
    console.log(`Story #${story.storyId} (crew #${story.crewId}) · ${story.status} · "${story.title}"`);
    console.log(`  People: ${(story.people || []).map((p) => `${p.username} (${p.branch})`).join(", ")}`);
    for (const consent of story.review?.consents || []) {
      const person = (story.people || []).find((p) => p.userId === consent.userId);
      console.log(`  Parent of ${person?.username || consent.userId}: ${consent.state}`);
    }
    for (const item of items) {
      const gate = item.gate || {};
      console.log(
        `  ${item.kind} #${item.id}: ${gate.publishable ? "PUBLIC" : `private (${gate.reason || "live"})`}${item.caption ? ` · ${item.caption}` : ""}${item.url ? ` · ${item.url}` : ""}`,
      );
    }
    if ((story.review?.nameWarnings || []).length) {
      console.log(`  Possible real names: ${story.review.nameWarnings.join(", ")}`);
    }
    if (story.body) console.log(`\n${story.body}\n`);
    return;
  }
  if (operation.name.startsWith("meetup.story.")) {
    const r = data.result || {};
    if (operation.name === "meetup.story.approve") {
      console.log(
        `Published story #${r.storyId} (crew #${r.crewId}): ${(r.publicMediaIds || []).length} public, ${(r.privateMediaIds || []).length} private.${r.announcementSubjectId ? ` Announcement: subject #${r.announcementSubjectId}.` : ""}${(r.failed || []).length ? ` FAILED to process: ${r.failed.map((f) => `#${f.mediaId} ${f.error}`).join("; ")}.` : ""}`,
      );
    } else {
      console.log(`${operation.name === "meetup.story.unpublish" ? "Unpublished" : "Sent back"} story #${r.storyId} (crew #${r.crewId}).`);
    }
    return;
  }
  if (operation.name === "meetup.branches") {
    const branches = Array.isArray(data.branches) ? data.branches : [];
    console.log(`${branches.length} branch name(s) (${data.filter || "pending"}):`);
    for (const branch of branches) {
      console.log(
        `  #${branch.id} · ${branch.status}${branch.mergedIntoId ? ` → #${branch.mergedIntoId}` : ""} · "${branch.name}" · ${branch.members} member(s) · first entered by ${branch.firstUsername || "?"}${branch.firstCrewId ? ` in crew #${branch.firstCrewId}` : ""}`,
      );
    }
    if (branches.some((branch) => branch.status === "pending")) {
      console.log("Decide: lumine admin meetup branches approve <id> | reject <id> | merge <id> --into <officialId>.");
    }
    return;
  }
  if (operation.name === "meetup.branch.show" || String(operation.name).startsWith("meetup.branch.")) {
    const branch = data.branch || {};
    console.log(
      `Branch #${branch.id} "${branch.name}" is now ${branch.status}${branch.mergedIntoName ? ` (merged into "${branch.mergedIntoName}")` : ""} · ${branch.members} member(s) use it · first entered by ${branch.firstUsername || "?"}.`,
    );
    return;
  }
  if (operation.name === "meetup.emails") {
    console.log(`Parent email review: ${data.review ? "ON (emails wait for you)" : "OFF (emails go out at once)"}`);
    const open = (data.drafts || []).filter((d) => d.status === "held" || d.status === "failed");
    if (!open.length) console.log("Nothing is waiting.");
    for (const d of open) {
      console.log(`\n#${d.id} [${d.status}] crew #${d.crewId} ${d.kind === "brief" ? "meetup request" : "reply"} -> ${d.to}`);
      console.log(`  Subject: ${d.subject}`);
      console.log(`  ${String(d.body).split("\n").join("\n  ")}`);
    }
    return;
  }
  if (operation.name === "meetup.friends") {
    console.log(`Friend buttons are ${data.on ? "ON" : "OFF"}.`);
    return;
  }
  if (operation.name === "meetup.funnel") {
    console.log(`Bridge Builder funnel, last ${data.windowDays} day(s)${data.trackingLive ? "" : " (view tracking NOT live yet)"}:`);
    for (const [kind, v] of Object.entries(data.views || {})) {
      console.log(`  ${kind}: ${v.users} people, ${v.hits} visits`);
    }
    console.log(`  quest page viewers: ${data.questPage?.viewers ?? 0}, of whom ever in a crew: ${data.questPage?.viewersEverInCrew ?? 0}`);
    console.log(`  crews by status: ${JSON.stringify(data.crews?.byStatus || {})}; active by step: ${JSON.stringify(data.crews?.activeByStep || {})}; active by size: ${JSON.stringify(data.crews?.activeBySize || {})}`);
    if (data.branches) console.log(`  branch names: ${JSON.stringify(data.branches.byStatus)}${data.branches.oldestPendingHours ? `; oldest pending ${data.branches.oldestPendingHours}h` : ""}`);
    for (const crew of data.activeCrews || []) {
      console.log(`  #${crew.crewId} step ${crew.step} · ${crew.members} member(s) · idle ${crew.daysIdle}d · ${crew.unverifiedBranches ? `${crew.unverifiedBranches} branch(es) to verify · ` : ""}${crew.parents && crew.parents.asked ? `parents ${crew.parents.approved}/${crew.parents.asked} · ` : ""}chat7d ${crew.chat7d ? `${crew.chat7d.messages} msg/${crew.chat7d.speakers} people` : "n/a"} · ${crew.blocking}`);
    }
    return;
  }
  if (operation.name === "meetup.list") {
    const crews = Array.isArray(data.crews) ? data.crews : [];
    console.log(`${crews.length} meetup crew(s) (${data.filter || "review"}):`);
    for (const crew of crews) {
      console.log(
        `  #${crew.crewId} · ${crew.status}${crew.waitingFor ? ` · waiting: ${crew.waitingFor}` : ""} · founder ${crew.founderUsername || "?"} · ${formatMeetupMembers(crew.members)}${crew.blocking ? ` · ${crew.blocking}` : ""}`,
      );
    }
    if (crews.some((crew) => crew.waitingFor)) {
      console.log(
        "Review: lumine admin meetup show <crewId>, then approve-crew | approve-plan | approve-grownup | send-back --note | approve --attended <ids> | info <crewId> <userId> --decision accept|ask-again (a member's who-are-you answer) (classroom plans: approve at the headmaster desk with a room and times).",
      );
    }
    return;
  }
  if (operation.name === "meetup.info") {
    const status = data.result?.status;
    console.log(
      result?.changed === false
        ? `Member ${data.result?.userId} already has an open question (${status}).`
        : `Member ${data.result?.userId} on crew #${data.result?.crewId}: ${status === "requested" ? "asked (their crew page now asks for their teacher and class, or how they know the crew)" : status}.`,
    );
    if (data.crew) printMeetupCrew(data.crew);
    return;
  }
  if (operation.name === "meetup.show" || operation.name === "meetup.parent-reply") {
    printMeetupCrew(data.crew || {});
    return;
  }
  if (operation.name === "meetup.slot") {
    console.log(
      `Slot set for crew #${data.crew?.crewId}: ${data.slot?.date} ${data.slot?.start}-${data.slot?.end}.`,
    );
    if (data.crew) printMeetupCrew(data.crew);
    return;
  }
  if (operation.name === "meetup.resend-email") {
    const email = data.email || {};
    console.log(
      email.sent
        ? `Coordinator ${email.kind} email ${email.mode === "sent" ? "sent" : `built (${email.mode})`} to ${email.to}.`
        : `No email sent: ${email.reason || "unknown"}.`,
    );
    return;
  }
  const stage = data.result?.stage === "video" ? "video" : "plan";
  if (operation.name === "meetup.approve-crew" || operation.name === "meetup.approve-grownup") {
    console.log(
      `${result?.changed === false ? "Already approved" : "Approved"} crew #${data.result?.crewId}'s ${operation.name === "meetup.approve-crew" ? "crew step" : "grown-up step"}.`,
    );
  } else if (operation.name === "meetup.approve-plan") {
    console.log(
      result?.changed === false
        ? `Crew #${data.result?.crewId}'s plan was already approved.`
        : `Approved crew #${data.result?.crewId}'s plan. Next the crew gets its parents' yes and names a grown-up.`,
    );
  } else if (operation.name === "meetup.send-back") {
    console.log(`Sent crew #${data.result?.crewId}'s ${stage} back with your note.`);
  } else if (operation.name === "meetup.approve") {
    const unlocked = data.unlocks?.unlockedUserIds || [];
    const failed = data.unlocks?.failed || [];
    console.log(
      `${result?.changed === false ? "Already approved" : "Approved"} crew #${data.result?.crewId}${data.result?.tier ? ` at ${data.result.tier} tier` : ""}: unlocked for user(s) ${unlocked.join(", ") || "none"}.${failed.length ? ` Unlock FAILED for ${failed.join(", ")}; run the same command again.` : ""}`,
    );
  }
  if (data.crew) printMeetupCrew(data.crew);
}

const STORAGE_LIMIT_NAMESPACES = new Set([
  "storage",
  "storage-limit",
  "storage-limits",
  "storage-request",
  "storage-requests",
]);

function parseStorageTargetUser(value) {
  const user = String(value || "")
    .trim()
    .replace(/^@/, "");
  if (!user || !/^[\w.-]+$/.test(user)) {
    throw cliValidationError("Pass a user id or username.");
  }
  return user;
}

function parseAdminStorageSize(value) {
  try {
    return parseStorageSizeBytes(value);
  } catch (error) {
    throw cliValidationError(error.message);
  }
}

function formatStorageRequestLine(request) {
  const approved = request.approvedMaxRuntimeFileStorageBytes
    ? ` → ${formatBytes(request.approvedMaxRuntimeFileStorageBytes)}`
    : "";
  return `#${request.requestId} · ${request.status} · ${request.username || `user ${request.userId}`} (${request.userId}) asks ${formatBytes(request.requestedMaxRuntimeFileStorageBytes)}${approved} · using ${formatBytes(request.currentUsageBytes)} at request${request.reason ? ` · "${request.reason}"` : ""}${request.reviewReason ? ` · review: ${request.reviewReason}` : ""}`;
}

function printStorageLimitResult({ operation, data, result }) {
  if (operation.name === "storage.list") {
    const requests = Array.isArray(data.requests) ? data.requests : [];
    console.log(
      `${requests.length} storage request(s) (${data.filter || "pending"}):`,
    );
    for (const request of requests)
      console.log(`  ${formatStorageRequestLine(request)}`);
    if (data.nextCursor) console.log(`More: --cursor ${data.nextCursor}`);
    return;
  }
  if (operation.name === "storage.show") {
    const storage = data.storage || {};
    console.log(
      `${data.user?.username || "user"} (${data.user?.id}): ${formatBytes(storage.runtimeFileStorageBytes)} used of ${formatBytes(storage.maxRuntimeFileStorageBytes)} across ${Number(storage.runtimeFileCount || 0)} file(s) (default ${formatBytes(storage.defaultMaxRuntimeFileStorageBytes)}, cap ${formatBytes(storage.maxApprovableRuntimeFileStorageBytes)}).`,
    );
    if (data.override) {
      console.log(
        `Approved override: ${formatBytes(data.override.maxRuntimeFileStorageBytes)} by user ${data.override.approvedByUserId}${data.override.reason ? ` · ${data.override.reason}` : ""}`,
      );
    }
    for (const request of data.recentRequests || [])
      console.log(`  ${formatStorageRequestLine(request)}`);
    return;
  }
  const limit = formatBytes(data.maxRuntimeFileStorageBytes);
  if (operation.name === "storage.decide") {
    const request = data.request || {};
    console.log(
      result?.changed === false
        ? `Storage request #${request.requestId} was already ${request.status}. ${request.username || "The creator"}'s limit is ${limit}.`
        : `Storage request #${request.requestId} ${request.status}. ${request.username || "The creator"}'s Lumine file storage limit is now ${limit}.`,
    );
    return;
  }
  if (operation.name === "storage.grant") {
    console.log(
      result?.changed === false
        ? `${data.user?.username || "The user"} (${data.user?.id}) already has ${limit} of Lumine file storage.`
        : `${data.user?.username || "The user"} (${data.user?.id}) now has ${limit} of Lumine file storage.${data.request ? ` Closed pending request #${data.request.requestId} as approved.` : ""}`,
    );
  }
}

function formatReviewAge(seconds) {
  const at = Number(seconds || 0);
  if (!at) return "";
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatReviewItemLine(item) {
  const where =
    item.appTitle || (item.type === "storage-limit" ? "all their Builds" : "");
  return [
    `${item.ref} · ${item.status}${item.details?.isLive ? " (live)" : ""}`,
    REVIEW_REQUEST_LABELS[item.type] || item.type,
    `${where ? `${where} · ` : ""}by ${item.requesterUsername || "user"} (${item.requesterId})`,
    item.summary,
    item.reason ? `"${item.reason}"` : "",
    item.reviewReason && item.status !== "pending" ? `note: ${item.reviewReason}` : "",
    formatReviewAge(item.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

function printReviewEvents(events) {
  for (const event of events || [])
    console.log(
      `  ${new Date(Number(event.createdAt || 0) * 1000).toISOString()} ${event.action} by ${event.actorId}${event.reason ? `: ${event.reason}` : ""}`,
    );
}

const APPROVAL_LABELS = { dob: "birthdate", mentor: "teacher", meetup: "meetup" };
const approvalDate = (seconds) =>
  seconds ? new Date(Number(seconds) * 1000).toISOString().slice(0, 10) : "?";

// Network evidence (users_actions addresses): a shared network (academy,
// school) is only counted; a small one lists who shares it.
function printNetwork(network, indent = "") {
  const addresses = network?.addresses || [];
  if (!network) return;
  if (network.unavailable) {
    console.log(`${indent}Network: could not be read this time (try again)`);
    return;
  }
  if (!addresses.length) {
    console.log(`${indent}Network: no recorded addresses`);
    return;
  }
  console.log(`${indent}Network: ${addresses.length} recent address(es)`);
  for (const a of addresses) {
    const span = `${approvalDate(a.firstAt)}..${approvalDate(a.lastAt)}`;
    const older = a.olderHistoryNotRead ? " · older history not read" : "";
    if (a.kind === "shared_network") {
      console.log(
        `${indent}  - ${a.address} [${a.addressId}] · shared network: ${a.otherAccountsAtLeast}+ other accounts (not listed) · ${a.actions} actions ${span}${older}`,
      );
      continue;
    }
    if (a.kind === "only_this_account") {
      console.log(
        `${indent}  - ${a.address} [${a.addressId}] · only this account · ${a.actions} actions ${span}${older}`,
      );
      continue;
    }
    console.log(
      `${indent}  - ${a.address} [${a.addressId}] · small network shared with ${a.accounts.length} account(s) · ${a.actions} actions ${span}${older}`,
    );
    for (const o of a.accounts) {
      console.log(
        `${indent}      ${o.username || "?"} (#${o.userId})${o.linked ? " · their linked account" : ""}${o.exists === false ? " · deleted" : ""} · age ${o.age ?? "?"} · ${o.isTeacherOrStaff ? "teacher/staff" : "member"}${o.userType ? ` · type ${o.userType}` : ""}${o.banned ? " · BANNED" : ""} · ${o.actions} actions ${approvalDate(o.firstAt)}..${approvalDate(o.lastAt)}`,
      );
    }
  }
}

function printEvidence(evidence) {
  if (!evidence) return;
  const a = evidence.account || {};
  console.log(
    `Account: ${a.username} (#${a.userId}) · real name ${a.realName || "-"} · joined ${approvalDate(a.joinedAt)} · last active ${approvalDate(a.lastActive)} · age ${a.age ?? "not given"} · email ${a.verifiedEmail || "-"}`,
  );
  if (evidence.request) {
    const r = evidence.request;
    console.log(
      `Request: ${[r.branchName && `branch ${r.branchName}`, r.className && `class ${r.className}`, r.realName && `name ${r.realName}`, r.email && `email ${r.email}`, r.dob && `birthdate ${r.dob}`].filter(Boolean).join(" · ") || "-"} · sent ${approvalDate(r.requestedAt)}`,
    );
  }
  console.log(
    `Invited by: ${evidence.invitedBy ? `${evidence.invitedBy.username || "#" + evidence.invitedBy.userId} (${evidence.invitedBy.source || "invite"})` : "nobody (passphrase or other)"}`,
  );
  const act = evidence.activity || {};
  console.log(
    `Activity: ${act.comments || 0} comments (${act.commentsLast30Days || 0} in 30 days) · ${act.chatMessages || 0} chat messages`,
  );
  const linked = evidence.linkedAccounts || [];
  console.log(
    `Linked accounts: ${linked.length}${evidence.linkedEvidenceTruncated ? " (evidence truncated)" : ""}`,
  );
  for (const l of linked.slice(0, 15)) {
    console.log(
      `  - ${l.username} (#${l.userId}) via ${(l.linkedBy || []).join("+")}${l.sharedDeviceCount ? ` (${l.sharedDeviceCount} device)` : ""} · age ${l.age ?? "?"} · ${l.isTeacherOrStaff ? "teacher/staff" : "member"} · joined ${approvalDate(l.joinedAt)}${l.banned ? " · BANNED" : ""}`,
    );
  }
  printNetwork(evidence.network);
  console.log(
    `Flags: ${(evidence.flags || []).length ? evidence.flags.join(", ") : "none"}`,
  );
  if (evidence.note) console.log(evidence.note);
}

const TEACHER_REVIEW_LABELS = {
  unreviewed: "NEW: flagged, not reviewed",
  changed: "CHANGED since review",
  reviewed: "reviewed, unchanged",
  clean: "no flags",
};

export function formatTeacherAuditSummary(data) {
  return `Audited ${data.audited || 0} approved teachers · ${data.flagged || 0} flagged: ${data.newlyFlagged || 0} new, ${data.changedSinceReview || 0} changed since review, ${data.reviewedUnchanged || 0} reviewed and unchanged${data.failedUserIds?.length ? ` · evidence failed for ${data.failedUserIds.map((id) => `#${id}`).join(", ")}` : ""}${data.moreTeachersNotRead ? " · older teachers not read (raise --limit)" : ""}`;
}

export function formatTeacherReviewLine(teacher) {
  const a = teacher.account || {};
  const r = teacher.review;
  const status = TEACHER_REVIEW_LABELS[teacher.reviewStatus] || teacher.reviewStatus || "?";
  const reviewed = r
    ? ` · last review ${r.decision} ${approvalDate(r.reviewedAt)} by ${r.reviewedBy}${r.note ? `: "${r.note}"` : ""}`
    : "";
  const flags = (teacher.flags || []).length ? ` · flags ${teacher.flags.join(", ")}` : "";
  // the owner-confirmed branch (teachers branches); not part of the review
  const branch = teacher.branch
    ? ` · ${teacher.branch.displayName}${teacher.branch.source === "owner" ? " (set by owner)" : ""}`
    : "";
  return `[${status}] ${a.username || "?"} (#${a.userId})${branch}${flags}${reviewed}`;
}

// One audit entry: reviewed-unchanged teachers are one line (already judged);
// the rest show what changed, the evidence and the fingerprint a review sends.
function printTeacherEntry(teacher, { full = false } = {}) {
  console.log(formatTeacherReviewLine(teacher));
  if (teacher.reviewStatus === "reviewed" && !full) return;
  for (const change of teacher.review?.changes || []) console.log(`  changed: ${change}`);
  if (teacher.evidenceGap) console.log(`  cannot be reviewed now: ${teacher.evidenceGap}`);
  printEvidence(teacher);
  if (teacher.fingerprint) console.log(`Fingerprint: ${teacher.fingerprint}`);
}

function printApprovalResult({ operation, data }) {
  if (operation.name === "approvals.list") {
    const items = data.items || [];
    if (!items.length) return console.log("No approval requests.");
    for (const item of items) {
      console.log(
        `${item.ref} · ${APPROVAL_LABELS[item.type] || item.type} · ${item.status} · ${item.requesterUsername} (#${item.requesterId}) · ${approvalDate(item.requestedAt)}${item.flags ? ` · flags: ${item.flags.length ? item.flags.join(", ") : "none"}` : ""}`,
      );
    }
    return;
  }
  if (operation.name === "approvals.show") {
    const item = data.item || {};
    console.log(
      `${item.ref} · ${APPROVAL_LABELS[item.type] || item.type} · ${item.status} · ${item.requesterUsername} (#${item.requesterId})`,
    );
    printEvidence(data.evidence);
    return;
  }
  if (operation.name === "approvals.decide") {
    console.log(
      `${data.ref} ${data.status}${data.grantedAs ? ` as ${data.grantedAs}` : ""}: ${APPROVAL_LABELS[data.type] || data.type} request from ${data.requesterUsername} (#${data.requesterId}).`,
    );
    return;
  }
  if (operation.name === "teachers.audit") {
    console.log(formatTeacherAuditSummary(data));
    for (const teacher of data.teachers || []) {
      console.log("");
      printTeacherEntry(teacher);
    }
    if (data.nextCursor) console.log(`\nMore teachers: --cursor ${data.nextCursor}, or --all for every page.`);
    return;
  }
  if (operation.name === "teachers.review") {
    console.log(
      `Reviewed #${data.teacherUserId} as ${data.decision} (fingerprint ${String(data.fingerprint || "").slice(0, 12)}; flags ${(data.flags || []).join(", ") || "none"}). Note kept: ${data.note}`,
    );
    if (data.revoked) {
      console.log(
        `Teacher status removed (achievements ${(data.revoked.removedAchievementIds || []).join(", ") || "-"}; request #${data.revoked.approvalItemId ?? "-"} marked rejected).`,
      );
    }
    return;
  }
  if (operation.name === "teachers.review_flagged") {
    console.log(
      `Reviewed ${data.reviewedCount || 0} of the ${data.sent || 0} expected new or changed flagged teacher(s) shown above as legit (${data.flagged || 0} flagged, ${data.audited || 0} audited). Note: ${data.note}`,
    );
    for (const r of data.reviewed || []) {
      console.log(`  - ${r.username || "?"} (#${r.teacherUserId}) · was ${r.previousStatus}`);
    }
    for (const s of data.skipped || []) console.log(`  skipped #${s.userId}: ${s.reason}`);
    if ((data.changedSinceYouLooked || []).length) {
      console.log(`  Changed since the audit above (not reviewed; audit again): ${data.changedSinceYouLooked.map((id) => `#${id}`).join(", ")}`);
    }
    return;
  }
  if (operation.name === "teachers.revoke") {
    console.log(
      `Teacher status removed from #${data.userId} (achievements ${(data.removedAchievementIds || []).join(", ")}; request #${data.approvalItemId ?? "-"} marked rejected). Reason kept: ${data.reason}`,
    );
  }
}

function printEnglishResult({ operation, data }) {
  if (operation.name === "english.import") {
    console.log(`Pass ${data.pass}: ${data.stored} stored of ${data.received} (${data.invalid} invalid, ${data.unknownQuestion} unknown questions) · ${data.decided} decided: ${data.auto} accepted automatically, ${data.review} for review (${Object.entries(data.reasons || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "-"})`);
    return;
  }
  if (operation.name === "english.mastery") {
    console.log(`User #${data.userId} · last ${data.windowDays} days · ${data.responses} honest answers · ${data.skillsSeen} skills seen (mastery = ${Math.round(data.target * 100)}% right on the first try)`);
    const label = { fact: "facts only", focus: "NEXT FOCUS", gap: "CLEAR GAP", strength: "strength", "clear-strength": "CLEAR STRENGTH" };
    if (!data.reportable?.length) console.log("Nothing reportable yet: no skill has enough evidence.");
    for (const r of data.reportable || []) {
      console.log(`  [${label[r.kind] || r.kind}] ${r.nameEn} · ${r.correct}/${r.responses} first try · ${r.items} questions · ${r.days} days · P(below) ${r.pBelow.toFixed(2)}`);
      console.log(`      report may say: ${r.wordingEn}`);
    }
    if (data.practiceOnly?.length) console.log(`  practice only (not enough evidence yet): ${data.practiceOnly.map((s) => `${s.nameEn} ${s.responses}`).join(" · ")}`);
    return;
  }
  if (operation.name === "english.backfill_distractors") {
    console.log(`Wrong-choice labels restored on ${data.filled} of ${data.candidates} agent-written questions.`);
    return;
  }
  if (operation.name === "english.adjudicate") {
    console.log(`Adjudicated ${data.received}: ${data.keep} kept · ${data.fix} fixed (new versions) · ${data.retire} retired · ${data.skipped?.length || 0} skipped${data.skipped?.length ? ` (${data.skipped.slice(0, 5).map((s) => `${s.ref}: ${s.why}`).join("; ")})` : ""}`);
    return;
  }
  if (operation.name === "english.add_questions") {
    console.log(`Added ${data.added} of ${data.received} questions · ${data.duplicate} duplicates skipped · ${data.invalid?.length || 0} invalid${data.invalid?.length ? ` (${data.invalid.slice(0, 5).map((s) => `#${s.index}: ${s.why}`).join("; ")})` : ""}`);
    return;
  }
  if (operation.name === "english.relevel") {
    console.log(`Re-levelled ${data.moved} of ${data.received} · ${data.unchanged} already in place · ${data.invalid} invalid`);
    return;
  }
  if (operation.name === "english.summary") {
    console.log(`${data.total} questions · passes: ${(data.passes || []).map((row) => `${row.model} ${row.items}`).join(" · ") || "none yet"}`);
    console.log(`Tag status: ${(data.byStatus || []).map((row) => `${row.status} ${row.items}`).join(" · ") || "none yet"}`);
    (data.bySkill || []).slice(0, 40).forEach((row) => console.log(`  ${row.skillCode}: ${row.items}`));
    return;
  }
  if (operation.name === "english.review") {
    const items = data.items || [];
    if (!items.length) return console.log("Nothing waiting for review.");
    items.forEach((item) => {
      console.log(`\n#${item.itemRef} v${item.itemVersion} · ${item.skillCode} · ${item.cefr || "?"}`);
      console.log(`  ${item.question}`);
      ["a", "b", "c", "d"].forEach((letter) => console.log(`  ${letter === item.correct_choice ? "*" : " "} ${letter}) ${item[`choice_${letter}`]}`));
      (item.verdicts || []).forEach((v) => console.log(`  ${v.model}: ${v.primarySkill}${v.ambiguous ? ` · AMBIGUOUS: ${v.ambiguityReason}` : ""}`));
    });
    return;
  }
  if (operation.name === "english.decide") {
    console.log(`#${data.ref} v${data.version}: ${data.action} · ${data.skillCode}${data.reason ? ` (${data.reason})` : ""}`);
  }
}

function printReviewRequestResult({ operation, data, result }) {
  if (operation.name === "review.list") {
    const items = Array.isArray(data.items) ? data.items : [];
    const scope = operation.reviewType
      ? REVIEW_REQUEST_LABELS[operation.reviewType]
      : "Build";
    console.log(`${items.length} ${scope} request(s) (${data.filter || "pending"}):`);
    for (const item of items) console.log(`  ${formatReviewItemLine(item)}`);
    if (data.nextCursor) console.log(`More: --cursor ${data.nextCursor}`);
    if (items.some((item) => item.decisions?.includes("approve")))
      console.log(
        "Decide: lumine admin review approve|reject <ref> (storage: --size; rewards: --config; cardcraft/rewards reject needs --reason).",
      );
    return;
  }
  const type = operation.reviewType;
  // Rewards and card crafting keep their detailed printers.
  if (type === "rewards") {
    printRewardReviewResult({
      operation: {
        ...operation,
        name:
          operation.name === "review.decide"
            ? "reward-review.decide"
            : "reward-review.show",
      },
      data,
    });
    return;
  }
  if (type === "cardcraft") {
    printCardCraftReviewResult({
      operation: {
        ...operation,
        name:
          operation.name === "review.decide"
            ? "cardcraft-review.decide"
            : "cardcraft-review.show",
      },
      data,
    });
    return;
  }
  if (operation.name === "review.decide" && type === "storage-limit") {
    printStorageLimitResult({
      operation: { ...operation, name: "storage.decide" },
      data,
      result,
    });
    return;
  }
  if (data.item) console.log(formatReviewItemLine(data.item));
  if (operation.name === "review.decide") {
    console.log(
      result?.changed === false
        ? `Request ${data.item?.ref || ""} was already ${data.item?.status || data.request?.status}.`
        : `Decision recorded: ${operation.decision}.${type === "project-limit" && operation.decision === "approve" ? " Main and all its branches have the room now." : ""}`,
    );
    return;
  }
  if (type === "storage-limit" && data.storage) {
    const storage = data.storage;
    console.log(
      `Now: ${formatBytes(storage.runtimeFileStorageBytes)} used of ${formatBytes(storage.maxRuntimeFileStorageBytes)} across ${Number(storage.runtimeFileCount || 0)} file(s) (default ${formatBytes(storage.defaultMaxRuntimeFileStorageBytes)}, cap ${formatBytes(storage.maxApprovableRuntimeFileStorageBytes)}).`,
    );
  }
  if (type === "project-limit" && data.currentLimits) {
    console.log(
      `Now: ${data.currentLimits.maxFilesPerProject} files, ${formatBytes(data.currentLimits.maxProjectBytes)} (Main; every branch inherits it).`,
    );
  }
  printReviewEvents(data.events);
}

// Human view of `lumine admin reward-bank report`; --json has everything.
function printRewardBankReport(data) {
  const pct = (value) =>
    value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`;
  console.log(`Question bank report · build #${data.buildId} · last ${data.days} day(s)`);
  if (data.coverage) {
    console.log(
      `Seeding coverage (steps 1-3): ${data.coverage.filled} / ${data.coverage.total}`,
    );
  }
  if (!data.generation) {
    console.log("Generation: no telemetry table yet.");
  } else {
    for (const row of data.generation.bySource) {
      if (!row.rounds) continue;
      console.log(
        `Generation (${row.source}): ${row.rounds} rounds · ${row.accepted} accepted (${pct(row.acceptRate)}) · off-brief ${row.offBrief} · answer mismatch ${row.answerMismatch} · malformed ${row.malformed} · errors ${row.errors} · $${row.costUsd} · avg ${row.avgSeconds ?? "–"}s (max ${row.maxSeconds ?? "–"}s)`,
      );
    }
    for (const row of data.generation.recentRejections.slice(0, 5)) {
      console.log(
        `  rejected ${row.outcome} ${row.ruleId}/${row.topicKey} step ${row.step}: ${row.problems || "(no reason given)"}`,
      );
    }
  }
  console.log(`Learners: ${data.learners.total}`);
  for (const row of data.learners.byRuleStep) {
    console.log(
      `  ${row.ruleId} step ${row.step}: served ${row.served} · answered ${row.answered} · first-try ${pct(row.firstTryRate)} · solved ${row.solved} · skipped ${row.skipped}`,
    );
  }
  const paid = data.payouts.reduce(
    (sum, row) => ({ xp: sum.xp + row.xp, coins: sum.coins + row.coins, receipts: sum.receipts + row.receipts }),
    { xp: 0, coins: 0, receipts: 0 },
  );
  console.log(
    `Payouts: ${paid.receipts} receipts · ${paid.xp.toLocaleString()} XP · ${paid.coins.toLocaleString()} Coins`,
  );
  for (const row of data.payouts) {
    console.log(
      `  ${row.ruleId} step ${row.step}: ${row.receipts} (${row.firstTry} first try) · ${row.earners} earners · ${row.xp.toLocaleString()} XP · ${row.coins.toLocaleString()} Coins`,
    );
  }
  if (data.ladder.length) {
    console.log(
      `Ladder now: ${data.ladder.map((row) => `${row.ruleId} s${row.step}:${row.topicLadders}`).join(", ")}`,
    );
  }
  const hidden = data.bank.filter((row) => row.status === "hidden");
  console.log(
    `Bank: ${data.bank.filter((row) => row.status === "active").reduce((n, row) => n + row.questions, 0)} active · ${hidden.reduce((n, row) => n + row.questions, 0)} hidden${hidden.length ? ` (${hidden.map((row) => `${row.hiddenReason}: ${row.questions}`).join(", ")})` : ""} · ${data.bank.reduce((n, row) => n + row.createdInWindow, 0)} new in window`,
  );
  for (const row of data.questionsToReview.reported) {
    console.log(
      `  reported #${row.id} (${row.reports}, ${row.status}) ${row.ruleId}/${row.topicKey} s${row.step}: ${row.reasons}`,
    );
  }
  for (const row of data.questionsToReview.hardest) {
    console.log(
      `  hardest #${row.id} ${row.ruleId}/${row.topicKey} s${row.step}: solved ${pct(row.solveRate)} of ${row.learners}`,
    );
  }
}

function printAdminResult({ operation, result }) {
  const data = result?.data || {};
  if (printChatSafetyResult({ operation, data })) return;
  const chatReportLines = formatChatReportResult({ operation, data });
  if (chatReportLines) {
    for (const line of chatReportLines) console.log(line);
    return;
  }
  if (operation.name === "profile.show") {
    for (const line of formatProfileReview(data)) console.log(line);
    return;
  }
  if (operation.name === "reward-activity.report") {
    printRewardActivity(data);
    return;
  }
  if (operation.name === "reward-bank.report") {
    printRewardBankReport(data);
    return;
  }
  if (operation.name === "owner-trace.read") {
    printOwnerTrace(data);
    return;
  }
  if (operation.name.startsWith("reward-bank.")) {
    if (operation.name === "reward-bank.seed") {
      console.log(
        data.seeded
          ? `Seeded question #${data.seeded.questionId}: ${data.seeded.ruleId} · ${data.seeded.topicKey} · step ${data.seeded.step}.`
          : "Every slot is already seeded.",
      );
    }
    const coverage = data.coverage || data;
    console.log(
      `Coverage: ${Number(coverage.filled || 0)} / ${Number(coverage.total || 0)} topic-step slots have a question${data.maxStep ? ` (steps 1-${data.maxStep})` : ""}.`,
    );
    if (data.missingByStep && Object.keys(data.missingByStep).length) {
      console.log(
        `Missing by step: ${Object.entries(data.missingByStep)
          .map(([step, count]) => `step ${step}: ${count}`)
          .join(", ")}.`,
      );
    }
    return;
  }
  if (operation.name === "identity.network") {
    const account = data.account || {};
    console.log(`${account.username} (#${account.userId})`);
    printNetwork(data.network);
    console.log(
      `Flags: ${(data.network?.flags || []).length ? data.network.flags.join(", ") : "none"}`,
    );
    console.log(
      "An address many accounts share (an academy, a school) links strangers and is only counted; a small one lists who shares it. Facts, not a finding.",
    );
    return;
  }
  if (operation.name.startsWith("teachers.branches.")) {
    printTeacherBranchResult({ operation, data });
    return;
  }
  if (operation.name.startsWith("approvals.") || operation.name.startsWith("teachers.")) {
    printApprovalResult({ operation, data });
    return;
  }
  if (operation.name.startsWith("english.")) {
    printEnglishResult({ operation, data });
    return;
  }
  if (operation.name.startsWith("review.")) {
    printReviewRequestResult({ operation, data, result });
    return;
  }
  if (operation.name.startsWith("reward-review.")) {
    printRewardReviewResult({ operation, data });
    return;
  }
  if (operation.name.startsWith("cardcraft-review.")) {
    printCardCraftReviewResult({ operation, data });
    return;
  }
  if (operation.name.startsWith("storage.")) {
    printStorageLimitResult({ operation, data, result });
    return;
  }
  if (operation.name.startsWith("meetup.")) {
    printMeetupResult({ operation, data, result });
    return;
  }
  if (operation.name === "runtime.evidence") {
    const evidence = data.evidence || {};
    console.log(
      `Runtime evidence (${data.host?.requested || "unknown"}): ${evidence.status || "unknown"}.`,
    );
    console.log(
      `Samples: ${evidence.coverage?.samples ?? "unknown"}; latest: ${evidence.coverage?.lastAtMs ?? "unknown"}; age ms: ${evidence.coverage?.ageMs ?? "unknown"}.`,
    );
    for (const recycle of evidence.recycles || []) {
      console.log(
        `  ${recycle.id}: ${recycle.outcome}; under load: ${recycle.observedUnderLoad ?? "unknown"}.`,
      );
    }
    console.log(
      "Missing evidence is unknown, not healthy. A recovered topology does not verify interrupted user work. Use --json for full evidence.",
    );
    return;
  }
  if (operation.name === "featured.plan") {
    for (const pair of data.plan?.replacements || []) {
      console.log(
        `${pair.remove.id} ${pair.remove.title} -> ${pair.add.id} ${pair.add.title}`,
      );
    }
    console.log(
      `Proposed final order: ${(data.plan?.finalIds || []).join(",")}`,
    );
    console.log(
      `Plan hash: ${data.planHash}. Obtain Mikey's approval before using featured apply --file <plan.json> --approve ${data.planHash}.`,
    );
    return;
  }
  if (operation.featuredWorkflow) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data.applications)) {
    console.log(`${data.applications.length} sponsor application(s):`);
    for (const application of data.applications) {
      console.log(
        `  #${application.id} ${String(application.status).toUpperCase()} · ${application.username || `user ${application.userId}`} · agreement ${application.agreementVersion || "unknown"}`,
      );
    }
    return;
  }
  if (data.application) {
    console.log(
      `Sponsor application #${data.application.id}: ${String(data.application.status).toUpperCase()} · ${data.application.username || `user ${data.application.userId}`}`,
    );
    return;
  }
  if (data.sponsor) {
    console.log(
      `Sponsor ${data.sponsor.username || `user ${data.sponsor.userId}`}: ${String(data.sponsor.status).toUpperCase()}.`,
    );
    return;
  }
  if (data.scan) {
    const scan = data.scan;
    console.log(
      `Sponsor-integrity scan #${scan.id || "not started"}: ${scan.status || "not started"} · ${scan.scannedCount || 0} scanned · ${scan.selectedReviewCount || 0} selected · ${data.openCaseCount || 0} open.`,
    );
    if (Array.isArray(data.casesCreated) && data.casesCreated.length > 0) {
      console.log(
        `Created ${data.casesCreated.length} review case(s) on this page.`,
      );
    }
    return;
  }
  if (Array.isArray(data.cases)) {
    console.log(`${data.cases.length} sponsor-integrity case(s):`);
    for (const item of data.cases) {
      const flags =
        Array.isArray(item.hardFlags) && item.hardFlags.length
          ? ` · flags=${item.hardFlags.join(",")}`
          : "";
      console.log(
        `  #${item.id} ${String(item.status).toUpperCase()} · job #${item.jobId} · ${item.sponsorUsername || `sponsor ${item.sponsorUserId}`}${flags}`,
      );
    }
    return;
  }
  if (data.case) {
    const item = data.case;
    console.log(
      `Sponsor-integrity case #${item.id}: ${String(item.status).toUpperCase()} · job #${item.job?.id} · ${item.sponsorUsername || `sponsor ${item.sponsorUserId}`}.`,
    );
    const relays =
      Array.isArray(item.relays) && item.relays.length > 0
        ? item.relays
        : item.relay
          ? [item.relay]
          : [];
    console.log(
      `Relays: ${relays.map((relay) => `${relay.kind || "initial_request"}: ${relay.summary || "(missing)"}`).join(" | ") || "(missing)"}`,
    );
    console.log(
      `Provenance: ${(item.agents || []).map((agent) => `${agent.role}:${agent.provider}:${agent.resolvedModel || "unresolved"}:${agent.resolvedEffort || "unresolved"}`).join(" · ") || "missing"}`,
    );
    console.log(
      `Artifact files: ${(item.artifactFiles || []).map((file) => file.path).join(", ") || "none"}`,
    );
    return;
  }
  if (data.caseId) {
    console.log(
      `Sponsor-integrity case #${data.caseId}: ${data.decision}${data.scanCompleted ? "; scan complete" : ""}.`,
    );
    return;
  }
  if (data.review && data.artifacts?.reviewSessionPath) {
    console.log(
      `Production-log review #${data.review.id}: ${data.completionStatus || data.review.status}.`,
    );
    console.log(`Review session: ${data.artifacts.reviewSessionPath}`);
    if (data.artifacts.latestSnapshot?.snapshotPath) {
      console.log(
        `Latest captured bytes: ${data.artifacts.latestSnapshot.snapshotPath}`,
      );
    }
    if (
      data.completionStatus === "needs_review" ||
      data.completionStatus === "post_clear_review_required"
    ) {
      console.log(
        data.completionStatus === "post_clear_review_required"
          ? "The API error log was cleared in place. Review the post-clear snapshot, then rerun finish with --reviewed to close the lease."
          : "New bytes arrived at the final boundary. Review the latest snapshot, then rerun finish with --reviewed.",
      );
    }
    return;
  }
  if (data.review) {
    console.log(
      `Confirmed Build #${data.review.buildId} runtime at published artifact #${data.review.publishedArtifactVersionId}.`,
    );
    console.log(`Screenshot: ${data.screenshotPath}`);
    if (data.review.interaction) {
      console.log(
        `Interaction script: ${data.review.interaction.stepsCompleted}/${data.review.interaction.stepsPlanned} step(s) ${data.review.interaction.status}.`,
      );
    }
    for (const shot of data.review.screenshots || []) {
      console.log(`  Screenshot [${shot.label}]: ${shot.path}`);
    }
    console.log(`Review receipt: ${data.receiptPath}`);
    return;
  }
  if (data.monthlyAiCosts) {
    printAdminMonthlyAiCosts(data.monthlyAiCosts);
    return;
  }
  if (data.dailyAiCosts) {
    printAdminDailyAiCosts(data.dailyAiCosts);
    return;
  }
  if (data.energyBudget) {
    printAdminEnergyBudget(data.energyBudget);
    return;
  }
  if (data.monthlyMediaCosts) {
    printAdminMonthlyMediaCosts(data.monthlyMediaCosts);
    return;
  }
  if (data.validation) {
    console.log(
      `Editorial valid for edition #${data.validation.editionId}: ${data.validation.citedEventCount} cited and ${data.validation.coveredEventCount} covered event(s).`,
    );
    return;
  }
  if (data.batch) {
    console.log(
      `Skipped ${data.batch.completedCount} audited target(s); ${data.batch.changedCount} changed canonical state.`,
    );
    console.log(`Checkpoint: ${data.batch.checkpointPath}`);
    return;
  }
  // A daily-run report; other operations' `report` (chat reports) are
  // printed above and must never reach this branch.
  if (data.report?.run) {
    const report = data.report;
    const historical = report.basis?.kind === "historical_reconstruction";
    console.log(
      `${historical ? "Historical reconstruction for run" : "Run"} #${report.run.id}: ${report.mutations.successfulMutationCount} successful mutation(s), ${report.queueCoverage.length} queue coverage record(s), ${report.escalations.length} escalation(s)${historical ? "." : `, ${report.carryoverTodos?.count || 0} unfinished todo(s).`}`,
    );
    for (const coverage of report.queueCoverage) {
      console.log(
        `  ${coverage.queue}: ${coverage.candidateCount} candidate(s), ${coverage.scannedCount} row(s) scanned across ${coverage.pages} page(s).`,
      );
    }
    for (const item of report.featuredReviews || []) {
      const coverage = item.coverage;
      const counts = item.encouragement || {};
      console.log(
        `  Featured review #${item.review?.id || coverage?.reviewId}: ${coverage?.reviewed ? `${coverage.coveredSubjectIds.length}/${coverage.subjectCount} Subjects read, ${coverage.commentsRead} comments` : "not acknowledged as read"}; ${coverage?.complete ? "complete" : "incomplete"}; ${counts.newBasicRecommendations || 0} confirmed new basic recommendations, ${counts.alreadyDone || 0} already done, ${counts.rewardEligibilityGrants || 0} reward-permission grants, ${counts.directRewardsCreated || 0} direct rewards.`,
      );
    }
    for (const escalation of report.escalations) {
      const target =
        escalation.url ||
        `${escalation.targetType || "target"}:${escalation.targetId || "?"}`;
      console.log(
        `  ${String(escalation.severity || "attention").toUpperCase()} ${target} — ${escalation.summary}`,
      );
    }
    if (historical) {
      console.log(
        "The live brief and carry-over todo state were not snapshotted for this completed run.",
      );
    } else {
      printTodoItems(report.carryoverTodos?.items || [], "Unfinished work");
    }
    if (report.sponsorIntegrity) {
      const pendingApplications = Number.isSafeInteger(
        report.sponsorIntegrity.pendingApplications,
      )
        ? `; ${report.sponsorIntegrity.pendingApplications} pending application(s)`
        : "; historical pending-application count unavailable";
      console.log(
        `Sponsor integrity: ${report.sponsorIntegrity.scan?.status || "not started"}; ${report.sponsorIntegrity.cases?.open || 0} open case(s)${pendingApplications}.`,
      );
    }
    const surfaces = report.brief?.engagementPulse?.surfaces;
    if (surfaces && typeof surfaces === "object") {
      const deltas = Object.entries(surfaces)
        .filter(([, value]) => Number(value?.delta || 0) !== 0)
        .sort(
          ([, left], [, right]) =>
            Math.abs(Number(right?.delta || 0)) -
            Math.abs(Number(left?.delta || 0)),
        )
        .slice(0, 5)
        .map(
          ([name, value]) =>
            `${name} ${Number(value.delta) > 0 ? "+" : ""}${Number(value.delta)}`,
        );
      if (deltas.length)
        console.log(`Engagement deltas: ${deltas.join(", ")}.`);
    }
    if (!historical) {
      const notableCount = Array.isArray(report.brief?.notableCandidates)
        ? report.brief.notableCandidates.length
        : 0;
      console.log(`Notable-user candidates in this brief: ${notableCount}.`);
    }
    return;
  }
  if (data.inspection) {
    const inspection = data.inspection;
    console.log(
      `Identity inspection for user #${inspection.targetUserId}: ${inspection.accounts?.length || 0} candidate account(s); oldest #${inspection.oldestAccount?.userId || "unknown"}.`,
    );
    if (inspection.manualBucket) {
      console.log(
        `AI bucket #${inspection.manualBucket.id} (${inspection.manualBucket.label}); ${inspection.manualBucket.memberCount} canonical member(s).`,
      );
    }
    for (const account of inspection.accounts || []) {
      console.log(
        `  #${account.userId} ${account.username || "(no username)"} — joined ${account.joinedAt || "unknown"}; ${account.relationBasis.join(", ") || "no relation evidence"}${account.hasDateOfBirth ? "; DOB on file" : "; no DOB on file"}.`,
      );
      if (account.privateEvidence) {
        console.log(
          `    Private evidence: DOB ${account.privateEvidence.dateOfBirth || "none"}; verified email(s) ${account.privateEvidence.verifiedEmails.join(", ") || "none"}.`,
        );
      }
    }
    return;
  }
  if (Array.isArray(data.escalations)) {
    console.log(`${data.escalations.length} escalation(s):`);
    for (const escalation of data.escalations) {
      const target =
        escalation.url ||
        `${escalation.targetType || "target"}:${escalation.targetId || "?"}`;
      console.log(
        `  #${escalation.auditId} ${String(escalation.status || "open").toUpperCase()} ${target} — ${escalation.summary}`,
      );
      if (escalation.decisionNote) {
        console.log(`    Decision: ${escalation.decisionNote}`);
      }
    }
    if (data.truncated) {
      console.log(
        "More matching escalations exist than the requested limit; raise --limit or narrow --status.",
      );
    }
    return;
  }
  if (data.escalation?.decisionNote) {
    console.log(
      `Escalation #${data.escalation.auditId}: ${String(data.escalation.status).toUpperCase()} — ${data.escalation.decisionNote}`,
    );
    return;
  }
  if (data.escalation?.summary) {
    const target =
      data.escalation.url ||
      `${data.escalation.targetType || "target"}:${data.escalation.targetId || "?"}`;
    console.log(
      `Escalation${data.escalation.auditId ? ` #${data.escalation.auditId}` : ""} recorded: ${String(data.escalation.severity || "attention").toUpperCase()} ${target} — ${data.escalation.summary}`,
    );
    if (data.escalation.auditId) {
      console.log(
        `Set its disposition later with: lumine admin escalation set ${data.escalation.auditId} --status <status> --note <decision>`,
      );
    }
    return;
  }
  if (Array.isArray(data.todos)) {
    printTodoItems(data.todos, "Private carry-over work");
    if (data.truncated) {
      console.log(
        "More matching todos exist than the requested limit; raise --limit or narrow --status.",
      );
    }
    return;
  }
  if (data.todo) {
    printTodoItems([data.todo], "Canonical todo");
    return;
  }
  if (Object.hasOwn(data, "isNotable") && data.user) {
    console.log(
      `${data.user.username} (user #${data.user.id}) is${data.isNotable ? "" : " not"} currently in Notable Users.`,
    );
    if (data.notableUser?.reason) {
      console.log(`Reason: ${data.notableUser.reason}`);
    }
    return;
  }
  if (data.bucket && Array.isArray(data.memberUserIds)) {
    const added = Array.isArray(data.accounts)
      ? `; added ${data.accounts.length} explicit account(s)`
      : "";
    console.log(
      `AI bucket #${data.bucket.id} (${data.bucket.label}): ${data.memberCount} canonical member account(s)${added}.`,
    );
    return;
  }
  if (data.run !== undefined) {
    if (!data.run) {
      console.log("No active delegated administrator daily run.");
      if (data.lastRun) {
        console.log(
          `Last run #${data.lastRun.id}: ${data.lastRun.status}; scope ${canonicalAdminRunScope(data.lastRun)}; identity ${data.lastRun.identity.key}; comments ${data.lastRun.commentMode}.`,
        );
      }
      return;
    }
    console.log(
      `Run #${data.run.id}: ${data.run.status}; scope ${canonicalAdminRunScope(data.run)}; identity ${data.run.identity.key}; comments ${data.run.commentMode}.`,
    );
    if (data.scheduledDay && data.scheduledIdentity) {
      console.log(
        `Bangkok schedule for ${data.scheduledDay}: ${data.scheduledIdentity.key}.`,
      );
    }
    if (data.carryoverTodos) {
      printTodoItems(data.carryoverTodos.items || [], "Carry-over work");
    }
    return;
  }
  if (Array.isArray(data.identities)) {
    console.log(
      `Approved identities: ${data.identities.map((v) => v.key).join(", ")}.`,
    );
    console.log(`Preferred: ${data.preferredIdentity}.`);
    return;
  }
  if (Object.hasOwn(data, "activeRun")) {
    console.log(`Preferred identity: ${data.preferredIdentity}.`);
    if (data.scheduledDay && data.scheduledIdentity) {
      console.log(
        `Bangkok schedule for ${data.scheduledDay}: ${data.scheduledIdentity.key}.`,
      );
    }
    console.log(
      `Last completed identity: ${data.lastCompletedIdentity || "none"}.`,
    );
    console.log(
      data.activeRun
        ? `Active run #${data.activeRun.id}: scope ${canonicalAdminRunScope(data.activeRun)}; identity ${data.activeRun.identity.key}; comments ${data.activeRun.commentMode}.`
        : "No active delegated administrator daily run.",
    );
    return;
  }
  if (operation.name === "featured.history") {
    printFeaturedHistorySummary(data);
    console.log(`${(data.events || []).length} Featured history event(s):`);
    for (const event of data.events || []) {
      printFeaturedHistoryEvent(event);
    }
    printPagination(data.pagination);
    return;
  }
  if (Array.isArray(data.subjects)) {
    console.log(`${data.subjects.length} subject(s):`);
    for (const subject of data.subjects) {
      console.log(
        `#${subject.id} ${subject.title || "(untitled)"} — ${subject.author?.username || "unknown"} — effort ${subject.effortLevel ?? "unknown"}`,
      );
      console.log(`  ${subject.url}`);
    }
    printPagination(data.pagination);
    return;
  }
  if (Array.isArray(data.events)) {
    console.log(`${data.events.length} audit event(s):`);
    for (const event of data.events) {
      const target =
        event.targetType && event.targetId
          ? ` ${event.targetType}:${event.targetId}`
          : "";
      console.log(
        `#${event.id} run ${event.runId ?? "-"} ${event.action}${target} — ${event.result}${event.changed === true ? " (changed)" : event.changed === false ? " (no change)" : ""}`,
      );
    }
    printPagination(data.pagination);
    return;
  }
  if (data.claim) {
    if (data.artifacts?.claimFile) {
      console.log(
        `Claimed edition #${data.claim.editionId} (${data.claim.dateKey}): ${data.claim.events.length} event(s).`,
      );
      console.log(`Claim file: ${data.artifacts.claimFile}`);
      if (data.artifacts?.scaffoldFile) {
        console.log(`Editorial scaffold: ${data.artifacts.scaffoldFile}`);
      }
      console.log(
        `Validate before submission: lumine admin news validate --claim ${data.artifacts.claimFile} --file ${data.artifacts.scaffoldFile || "editorial.json"}`,
      );
      console.log(
        `Submit the confirmed pair: lumine admin news submit --claim ${data.artifacts.claimFile} --file ${data.artifacts.scaffoldFile || "editorial.json"}`,
      );
    } else {
      console.log(
        `Claimed edition #${data.claim.editionId} (${data.claim.dateKey}): ${data.claim.events.length} event(s); lease token ${data.claim.leaseToken}.`,
      );
      console.log(
        `Write the editorial JSON, then run: lumine admin news submit --edition-id ${data.claim.editionId} --lease-token ${data.claim.leaseToken} --file editorial.json`,
      );
    }
    return;
  }
  if (data.newspaper) {
    const paper = data.newspaper;
    if (paper.printedToday) {
      const printed = paper.latestPrinted || {};
      console.log(
        `Newspaper ${paper.dateKey}: printed (revision ${printed.revisionNumber || 1}, ${printed.sourceEventCount ?? 0} sources).`,
      );
    } else {
      console.log(
        `Newspaper ${paper.dateKey}: not printed (${paper.generationStatus}).`,
      );
    }
    if (paper.requestedAction && paper.requestedAction !== "none") {
      console.log(
        `${paper.requestedAction === "retry" ? "Queued a retry of" : "Queued"} today's edition; the press typesets it within about a minute. Re-check with: lumine admin news`,
      );
    } else if (
      !paper.printedToday &&
      ["pending", "generating"].includes(paper.generationStatus)
    ) {
      console.log(
        "An edition is being typeset now. Re-check with: lumine admin news",
      );
    }
    if (paper.failureMessage && !paper.printedToday) {
      console.log(`Last attempt failed: ${paper.failureMessage}`);
    }
    return;
  }
  if (data.notableUser) {
    console.log(
      `${result.status || "success"}: ${data.notableUser.username || "unknown"} (#${data.notableUser.userId}).`,
    );
    return;
  }
  if (data.skip) {
    console.log(
      `${result.status}: ${data.skip.contentType}:${data.skip.contentId} skipped.`,
    );
    if (data.skip.url) console.log(data.skip.url);
    return;
  }
  if (Array.isArray(data.items)) {
    console.log(`${data.items.length} recommendation candidate(s):`);
    for (const item of data.items) {
      console.log(`#${item.contentId} ${item.contentType}`);
      if (item.url || item.subjectUrl)
        console.log(`  ${item.url || item.subjectUrl}`);
    }
    printPagination(data.pagination);
    return;
  }
  if (Array.isArray(data.comments)) {
    console.log(`${data.comments.length} comment(s) for ${data.subject?.url}:`);
    for (const comment of data.comments) {
      console.log(
        `#${comment.id} ${comment.author?.username || "unknown"}: ${comment.content || "(empty)"}`,
      );
    }
    printPagination(data.pagination);
    return;
  }
  if (data.published) {
    console.log(
      `${result.status || "success"}: comment #${data.published.commentId}.`,
    );
    console.log(data.published.commentUrl || data.published.subjectUrl);
    return;
  }
  if (data.draft) {
    console.log(
      `Draft #${data.draft.id}: ${data.draft.decision} (${data.draft.status}).`,
    );
    if (data.draft.content) console.log(data.draft.content);
    const draftUrl = data.draft.targetUrl || data.draft.subjectUrl;
    if (draftUrl) console.log(draftUrl);
    return;
  }
  if (data.subject) {
    if (data.pairing) {
      console.log(
        `${result.status}: recommendation #${data.pairing.recommendationId}; reward ${data.pairing.rewardStatus}.`,
      );
    } else if (data.rewardOperation) {
      console.log(
        `${result.status}: reward ${data.rewardOperation.status || "confirmed"}.`,
      );
    } else if (data.reveal) {
      console.log(`${result.status}: ${data.reveal.status}.`);
    }
    console.log(`#${data.subject.id} ${data.subject.title || "(untitled)"}`);
    console.log(data.subject.url);
    return;
  }
  if (data.comment) {
    if (data.pairing) {
      console.log(
        `${result.status}: recommendation #${data.pairing.recommendationId}; reward ${data.pairing.rewardStatus}.`,
      );
    } else if (data.rewardOperation) {
      console.log(
        `${result.status}: reward ${data.rewardOperation.status || "confirmed"}.`,
      );
    }
    console.log(
      `#${data.comment.id} by ${data.comment.author?.username || "unknown"}`,
    );
    if (data.comment.subjectUrl) console.log(data.comment.subjectUrl);
    if (data.comment.content) console.log(data.comment.content);
    return;
  }
  console.log(
    `${result.status || "success"}${result.changed === false ? " (no change)" : ""}.`,
  );
}

function printFeaturedHistorySummary(data) {
  const coverage = data.coverage || {};
  console.log(
    coverage.complete
      ? `Featured history coverage begins at ${coverage.startedAt}.`
      : "Featured history coverage is not complete.",
  );
  for (const subject of data.subjects || []) {
    const lifetime = subject.knownFeatured
      ? "previously Featured"
      : subject.neverFeatured === true
        ? "never Featured"
        : "history unknown";
    console.log(
      `#${subject.id} ${subject.title || "(untitled)"} — ${lifetime}${subject.featured?.member ? ` — current position ${subject.featured.order}` : ""}`,
    );
    console.log(`  ${subject.url}`);
  }
}

function printFeaturedHistoryEvent(event) {
  console.log(
    `#${event.id} subject:${event.subjectId} ${event.action} ${event.fromPosition ?? "-"}->${event.toPosition ?? "-"} — ${event.operation}`,
  );
}

function printTodoItems(items, heading) {
  console.log(`${heading}: ${items.length} item(s).`);
  for (const todo of items) {
    console.log(
      `  #${todo.id} ${String(todo.status || "open").toUpperCase()} ${todo.kind || "task"} — ${todo.title || "(untitled)"}`,
    );
    if (todo.details) console.log(`    ${todo.details}`);
    if (todo.lastProgressNote) {
      console.log(`    Latest progress: ${todo.lastProgressNote}`);
    }
  }
}

function printPagination(pagination) {
  if (!pagination) return;
  console.log(
    pagination.exhausted
      ? "End of canonical snapshot."
      : `Next cursor: ${pagination.nextCursor}`,
  );
}
