# Lumine delegated-administrator contracts

`lumine admin` exposes deterministic community-management primitives. It does
not decide whether content is good, harmful, original, deserving of effort, or
worth commenting on. An LLM or human operator makes those judgments from the
canonical structured data.

## Security and run model

- The saved Lumine login always authenticates the real operator. The API reloads
  that user's current role from the writer database on every request.
- Only the server-configured administrator with authoritative administrator
  management authority may delegate. Effective Level 5 alone is rejected.
  Only the immutable
  server-owned Zero and Ciel user IDs are approved. Usernames and CLI flags are
  not authority.
- `daily-run start` creates or returns a six-hour `delegated-admin` run with
  explicit scopes and one public actor. Every run-scoped CLI command loads the
  canonical active run and sends its ID; the API rejects a missing, expired, or
  mismatched run.
- The public content actor is Zero or Ciel. Mikey's operator ID is retained in
  private audit rows and is not embedded in public comment metadata.
- Delegated HTTP work never authenticates as the bot, opens a bot socket, changes
  bot sessions, or updates bot presence/last-seen/typing state. Normal content
  mutations still emit Twinkle's canonical real-time content events.
- A later human reply to a delegated Zero/Ciel comment enters the existing
  server-side autonomous comment-assistant pipeline. Lumine does not need to
  remain running.

`auto` selects Zero first when no completed rotation exists, then alternates
after a successfully completed run that performed a mutation. Failed,
abandoned, expired, and read-only runs do not advance rotation. Reusing a run
key returns the original run and identity. One writer-locked identity-state row
serializes concurrent starts.

Comment mode is stored only on the current run:

- `off` (default): no draft or post scope.
- `draft`: server-generated drafts, no public comment.
- `post`: drafts plus idempotent publication through the ordinary comment path.

## Common JSON types

All `--json` success output is one uncolored JSON value:

```ts
type Success<D> = {
  ok: true;
  status: "success" | "already_done" | "no_op" | "maximum_reached";
  changed?: boolean; // mutations only
  data: D;
};
```

Failures print one JSON value, write no progress prose, and exit nonzero:

```ts
type Failure = {
  ok: false;
  status:
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "validation_error"
    | "partial_failure"
    | "internal_error"
    | "error";
  error: {
    code: string;
    message: string;
    details: unknown | null;
  };
};
```

Shared records:

```ts
type Author = { id: number | null; username: string | null };

type Attachment = {
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  thumbUrl: string | null;
  url: string | null; // canonical attachment URL when path and name exist
};

type RecommendationState = {
  recommendedByActor: boolean;
  actorRecommendationId: number | null;
  anyoneCanReward: boolean | null;
  count: number;
  items: Array<{
    id: number;
    actor: Author;
    anyoneCanReward: boolean;
    createdAt: number | null;
  }>;
};

type RewardState = {
  totalTwinkles: number;
  actorTwinkles: number;
  actorAlreadyRewardedThree: boolean;
  caps: {
    maxRewardAmount: number;
    maxRewardAmountForOnePerson: number;
  } | null;
  items: Array<{
    id: number;
    recipientUserId: number | null;
    rewarder: Author;
    type: string | null;
    amount: number;
    comment: string | null;
    claimed: boolean;
    createdAt: number | null;
  }>;
};

type Subject = {
  id: number;
  url: string; // https://www.twin-kle.com/subjects/<id>
  author: Author;
  createdAt: number | null; // Unix seconds
  updatedAt: null;
  title: string | null;
  description: string | null;
  attachment: Attachment | null;
  hasSecretAnswer: boolean;
  hasSecretAttachment: boolean;
  secret: { hasSecret: boolean; revealed: boolean | null };
  effortLevel: number; // 0 means unassigned
  effortRevision: number;
  featured: { member: boolean; order: number | null }; // one-based order
  createdByAuthor: boolean;
  recommendation: RecommendationState;
  reward: RewardState;
  root: { type: string | null; id: number | null };
  ageRestriction: string | null;
  deleted: false;
  unavailable: false;
};

type Comment = {
  id: number;
  url: string; // https://www.twin-kle.com/comments/<id>
  subjectUrl: string | null;
  author: Author;
  createdAt: number | null;
  updatedAt: null;
  content: string | null;
  contentHidden: boolean;
  attachment: Attachment | null;
  parentCommentId: number | null;
  replyToCommentId: number | null;
  isNotification: boolean;
  ageRestriction: string | null;
  deleted: false;
  unavailable: false;
  recommendation: RecommendationState;
  reward: RewardState;
};

type StandalonePost = {
  contentType: "aiStory" | "dailyReflection";
  contentId: number;
  id: number;
  url: string;
  author: Author;
  createdAt: number | null;
  updatedAt: null;
  title: string | null;
  question: string | null;
  content: string | null;
  explanation: string | null;
  imagePath: string | null;
  audioPath: string | null;
  deleted: false;
  unavailable: false;
  recommendation: RecommendationState;
  reward: RewardState;
};

type Pagination = {
  nextCursor: string | null;
  hasMore: boolean;
  exhausted: boolean;
  snapshotMaxId: number;
};

type Identity = {
  key: "zero" | "ciel";
  userId: number;
  username: string;
};

type DailyRun = {
  id: number;
  runKey: string;
  operatorUserId: number;
  publicActorUserId: number;
  identityMode: "auto" | "zero" | "ciel";
  commentMode: "off" | "draft" | "post";
  sessionKind: "delegated-admin";
  scopes: string[];
  status: "active" | "completed" | "failed" | "expired";
  successfulMutationCount: number;
  startedAt: number;
  expiresAt: number;
  completedAt: number | null;
  failedAt: number | null;
  failureReason: string | null;
  identity: Identity;
};
```

## Identity and daily-run commands

```bash
lumine admin identity list --json
lumine admin identity status --json
lumine admin identity use zero --json
lumine admin identity use ciel --json
lumine admin identity use auto --json
```

Schemas:

```ts
type IdentityList = Success<{
  identities: Identity[];
  preferredIdentity: "auto" | "zero" | "ciel";
  lastCompletedIdentity: "zero" | "ciel" | null;
}>;

type IdentityStatus = Success<{
  preferredIdentity: "auto" | "zero" | "ciel";
  lastCompletedIdentity: "zero" | "ciel" | null;
  activeRun: DailyRun | null;
}>;

type IdentityUse = IdentityStatus;
```

`identity use` changes only the preference for a future start. It never changes
an active run or advances rotation.

```bash
lumine admin daily-run start --identity auto --comment-mode off --json
lumine admin daily-run start --identity ciel --comment-mode draft \
  --run-key daily:2026-08-06:review --json
lumine admin daily-run status --json
lumine admin daily-run complete --json
lumine admin daily-run fail --reason "operator stopped" --json
```

Schemas:

```ts
type DailyRunStart = Success<{ run: DailyRun }>;
type DailyRunStatus = Success<{
  run: DailyRun | null;
  lastRun: DailyRun | null;
}>;
type DailyRunComplete = Success<{
  run: DailyRun;
  rotationAdvanced: boolean;
}>;
type DailyRunFail = DailyRunComplete;
```

`lastRun` makes a lost-response retry of `complete` or `fail` possible after
the active pointer has been cleared. Other run-scoped commands accept only the
current unexpired `active` run. Completion first finalizes any mutation whose
content change committed but whose audit bookkeeping was still pending,
counting it toward the run's rotation signal. It then rejects only while a
mutation from the last ten minutes is genuinely in flight (the 409 lists the
pending mutations and a `retryAfterSeconds`); older in-flight rows are treated
as orphans of a dead process and no longer block completion. `fail` remains
available to abandon a run without advancing rotation, including a run whose
six-hour authorization has expired; an expired run can never be completed.
A TTL-expired run is reported with status `expired` even before the next
start reaps it, so `daily-run status` never shows an unusable run as
`active`.

Starting with a run key that belongs to a finished or expired run fails with
`CLI_ADMIN_RUN_KEY_ALREADY_USED`; supply a fresh `--run-key` (for example
`daily:2026-08-07:2`) to start again the same day. Reusing the key of the
live active run returns that run only when the requested `--comment-mode`
and any explicit `--identity` match it; otherwise the start fails with
`CLI_ADMIN_RUN_SETTINGS_MISMATCH` instead of silently returning a run with
different scopes. The same check applies when a start without the active
run's key would fall back to that active run.

The default run key is `daily:YYYY-MM-DD` in Asia/Bangkok. Supply `--run-key`
for a separate explicit run. `--idempotency-key` may be supplied to any
mutation when a caller needs the same retry identity across processes. The CLI
generates a fresh key for every mutation invocation; if a mutation fails, its
JSON error includes `details.retryIdempotencyKey` for a safe exact retry.

## Canonical lists and inspection

```bash
lumine admin recommendations list --kind recommend \
  --content-types comment,dailyReflection --cursor '<cursor>' --json
lumine admin subjects candidates --after 2026-08-01T00:00:00Z \
  --cursor '<cursor>' --json
lumine admin subjects candidates --effort unassigned --json
```

Schemas:

```ts
type RecommendationQueueList = Success<{
  items: Array<{
    queueId: string;
    feedId: number;
    contentType: "comment" | "aiStory" | "dailyReflection";
    contentId: number;
    url: string | null;
    subjectUrl: string | null;
    author: Author;
    createdAt: number | null;
    title?: string | null;
    question?: string | null;
    content: string | null;
    explanation?: string | null;
    attachment?: Attachment | null;
    imagePath?: string | null;
    audioPath?: string | null;
    subject?: {
      id: number;
      title: string | null;
      effortLevel: number;
      url: string;
    };
    recommendation: RecommendationState;
    reward: RewardState;
  }>;
  pagination: Pagination & {
    scannedCount: number;
    contentTypes?: Array<"comment" | "aiStory" | "dailyReflection">;
  };
  clientFilter?: {
    contentTypes: Array<"comment" | "aiStory" | "dailyReflection">;
    excludedItems: number;
  };
}>;

type SubjectCandidates = Success<{
  subjects: Subject[];
  pagination: Pagination & { scannedCount: number };
}>;
```

Both cursors freeze a primary-key high-water mark and traverse descending IDs,
so concurrent inserts cannot shift or duplicate later pages. Both walks scan a
bounded primary-key window (500 rows) per call before applying their residual
filters, so a page — recommendation or subject — can be empty while `hasMore`
remains true; continue until `exhausted`. Subject `--after` is inclusive, and
the opaque cursor is bound to its original date and effort filters.

`--content-types` is sent to APIs that support server-side filtering so excluded
types do not run their eligibility/content queries. The local CLI also filters
the returned page defensively for deployment compatibility. The server cursor
still advances across every underlying feed row, so excluding `aiStory` cannot
create gaps in later comment or Daily Reflection pages. New server cursors bind
the canonical content-type set; one legacy unbound cursor can be resumed and is
then reissued as bound. `clientFilter.excludedItems` makes any client-side
filtering explicit in JSON output.

For a run-scoped command, `--identity zero|ciel` is an assertion against the
server-selected run identity; it cannot switch actors locally. A mismatch
fails before the mutation. `--identity auto` accepts the run's canonical
selection.

### Query and index design

Subject and queue traversal are bounded primary-key walks; the subject walk
reads at most 500 `content_subjects` rows per cursor step, and the queue reads
at most 500 `noti_feeds` rows per cursor step before applying the existing Earn
Recommend eligibility predicates. The effort projection's
`UPDATE noti_feeds ... WHERE type = 'subject' AND contentId = ?` reuses the
website's canonical reward-level projection shape; deployment should verify
`noti_feeds` carries an index whose leading columns cover `(type, contentId)`
(or `(contentId, ...)`) as the canonical route already requires. The joins/`NOT EXISTS` checks are necessary
to preserve the normal recommendation and skip rules, but they run only for
IDs in that bounded window. Subject-comment traversal uses
`idx_comments_isDeleted_subject_id`; standalone-post comments use the existing
`idx_content_comments_root_deleted` index (whose InnoDB entries also carry the
primary ID). Recommendation identity uses
`uniq_content_recommendations_active_identity`; `earn_comment_candidates` is
driven by its primary key. No offset scan or new broad table scan was added.

Deployment can verify the required existing index definitions with:

```sql
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME = 'content_comments'
      AND INDEX_NAME IN (
        'idx_comments_isDeleted_subject_id',
        'idx_content_comments_root_deleted'
      ))
    OR (TABLE_NAME = 'content_recommendations'
      AND INDEX_NAME = 'uniq_content_recommendations_active_identity')
    OR (TABLE_NAME = 'earn_comment_candidates' AND INDEX_NAME = 'PRIMARY')
  )
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
```

If a pre-migration environment lacks them, the repository's existing
`add-build-pinned-comments.sql`, active-recommendation-identity migration, and
Earn candidate migration are the canonical creation SQL; apply those migrations
instead of creating runtime checks or duplicate indexes.

For schema review, the exact missing-index DDL represented by those migrations
is:

```sql
ALTER TABLE content_comments
  ADD INDEX idx_comments_isDeleted_subject_id (isDeleted, subjectId, id);
ALTER TABLE content_comments
  ADD INDEX idx_content_comments_root_deleted (rootType, rootId, isDeleted);
ALTER TABLE content_recommendations
  ADD UNIQUE INDEX uniq_content_recommendations_active_identity
    (rootType, rootId, rootTargetType, activeUserId);
```

Run only the repository migrations after confirming an index is absent; do not
execute these statements blindly on a deployed database.

```bash
lumine admin subject get 123 --include-comments --json
lumine admin subject comments 123 --cursor '<cursor>' --json
lumine admin comments get 456 --json
lumine admin post get https://www.twin-kle.com/ai-stories/88 --json
lumine admin post comments dailyReflection:99 --cursor '<cursor>' --json
```

Schemas:

```ts
type SubjectGet = Success<{
  subject: Subject & {
    secret: {
      hasSecretAnswer: boolean;
      hasSecretAttachment: boolean;
      shown: boolean;
      answer: string | null;
      attachment: unknown | null;
    };
    // True only when comments were actually returned; a secret-gated subject
    // reports false here (with secret.shown false) even when they were
    // requested.
    commentsIncluded: boolean;
    // The inline list is capped at 200 comments in conversation order; when
    // true, page through `subject comments` for the rest.
    commentsTruncated: boolean;
    comments: Comment[];
  };
}>;

type SubjectComments = Success<{
  subject: { id: number; url: string; title: string | null };
  comments: Comment[];
  pagination: Pagination;
}>;

type CommentGet = Success<{
  comment: Comment;
  subject: {
    id: number;
    url: string;
    title: string | null;
    secretShown: boolean;
  } | null;
}>;

type StandalonePostGet = Success<{ post: StandalonePost }>;

type StandalonePostComments = Success<{
  post: {
    contentType: "aiStory" | "dailyReflection";
    contentId: number;
    url: string;
  };
  comments: Comment[];
  pagination: Pagination;
}>;
```

Inspection never silently bypasses secret semantics. Until the selected bot is
the author or has canonically responded/revealed, secret values and comments
remain unavailable.

## Subject and Featured mutations

```bash
lumine admin subject reveal 123 --json
lumine admin subject effort set 123 --level 2 --json
lumine admin subject creator set-made-by-poster 123 --json
lumine admin subject feature 123 --json
lumine admin subject unfeature 123 --json
lumine admin featured list --json
lumine admin featured reorder --subject-ids 30,20,10 --json
```

Schemas:

```ts
type SubjectReveal = SubjectGet & {
  status: "success" | "already_done";
  changed: boolean;
  data: SubjectGet["data"] & {
    reveal: {
      status: "created" | "already_revealed";
      notificationCommentId: number | null;
    };
  };
};

type SubjectEffortSet = SubjectGet & {
  status: "success" | "already_done";
  changed: boolean;
};

type SubjectCreatorSet = SubjectEffortSet;

type FeaturedList = Success<{
  subjects: Subject[];
  count: number;
  maximum: 20;
}>;

type SubjectFeature = FeaturedList & {
  status: "success" | "already_done";
  changed: boolean;
};

type SubjectUnfeature = SubjectFeature;
type FeaturedReorder = SubjectFeature;
```

`reveal` publishes the existing hidden “viewed without responding” notification
as the selected bot, with the ordinary notification and socket side effects.
Effort assignment rejects an unrevealed secret subject. Creator attribution
requires an attachment. Both effort assignment and creator attribution enforce
the website's moderator-precedence rule: when a strictly higher-level
moderator recorded the current value, the mutation fails with
`CLI_ADMIN_MODERATOR_PRECEDENCE` (the bots compare at the shared canonical
effective level). Every response is reloaded from the writer.

Featured reorder is a complete-set replacement: it rejects duplicates,
unknown/deleted IDs, missing current members, non-subject rows, and more than
20 subjects. Permanent pins and editorial ordering policy are deliberately not
hardcoded.

## Recommendation, Karma approval, and Twinkle rewards

```bash
lumine admin post recommend 123 --json
lumine admin post recommend https://www.twin-kle.com/ai-stories/88 --json
lumine admin post recommend comment:456 --anyone-can-reward \
  --reward-twinkles 3 --idempotency-key review-456-v1 --json
lumine admin post reward comment:456 --twinkles 3 --json
```

Numeric targets default to `subject`. Use `subject:<id>`, `comment:<id>`,
`aiStory:<id>`, `dailyReflection:<id>`, a canonical URL, or the corresponding
`--type`.

```ts
type PriorRecommendationApproval = {
  recommendationId: number;
  recipientUserId: number;
  karmaRecipientUserId: number;
  karmaAwarded: number; // 10 for a new canonical approval; 0 on retry
  karmaPoints: number; // writer-confirmed absolute balance after recomputation
  status: "created" | "already_approved";
  reward: Record<string, unknown>; // canonical users_rewards row
};

type Recommend = Success<
  (SubjectGet["data"] | CommentGet["data"] | StandalonePostGet["data"]) & {
    priorRecommendationApprovals: PriorRecommendationApproval[];
    managementBotDeduplication?: {
      alreadyProcessed: true;
      recommendationId: number;
      publicActorUserId: number;
      reason: "already_recommended_by_approved_management_bot";
    };
  }
>;

type MaxRecommend = Success<
  Recommend["data"] & {
    pairing: {
      recommendationId: number;
      anyoneCanReward: true;
      requestedTwinkles: 3;
      rewardStatus:
        | "created"
        | "already_rewarded"
        | "maximum_reached"
        | "insufficient_coins"
        | null;
      alreadyRewarded: boolean;
      rewardCaps: RewardState["caps"] | null;
      retrySafe: true;
      existingManagementReward?: {
        rewardId: number;
        publicActorUserId: number;
        amount: number;
      };
    };
  }
>;

type RewardThree = Success<
  (SubjectGet["data"] | CommentGet["data"] | StandalonePostGet["data"]) & {
    rewardOperation: {
      status: "created" | "already_rewarded" | "maximum_reached" | null;
      amount: number;
      reward: Record<string, unknown> | null;
      caps: RewardState["caps"] | null;
    };
  }
>;
```

Zero/Ciel are normalized to effective Level 5 only inside the shared canonical
recommendation-approval decision. This narrow rule does not grant delegation,
management authority, or any other permission. A newly activated qualifying
recommendation
approves eligible earlier lower-level recommenders through the existing
`users_rewards` recommendation mechanism and multiplier. It excludes the
content author's self-recommendation, the approving bot, both management bots,
Level 5+ users, deleted rows, and existing ineligible rows. The approval then
runs the same absolute canonical Karma recomputation as `/user/karma`, using
writer-locked state. A new approval reports the canonical 10-point contribution;
a retry reports zero newly awarded and the same confirmed absolute balance.

Recommendation history is checked across both management bots, so rotation
does not recommend the same target again — unless the request asks for
`--anyone-can-reward` and the other bot's recommendation does not carry that
permission, in which case the actor proceeds with its own recommendation so
the requested permission and paired reward are honored rather than silently
dropped. When the other bot's recommendation does satisfy the request, the
`managementBotDeduplication` payload is returned and any requested 3-Twinkle
reward is still processed. A bare recommend never downgrades an existing
recommendation's anyone-can-reward permission; only an explicit
`--anyone-can-reward` changes it, and only in the granting direction.
Changing only `anyoneCanReward` does not rerun prior-recommender approval.
Approval reward rows are locked and writer-read, so concurrent or restored
attempts cannot insert the same approval twice.

Both the standalone and combined reward paths also inspect existing 3-Twinkle
management rewards across Zero and Ciel. A canonical three from either bot is
reported as already rewarded instead of adding another management reward.

The separate 3-Twinkle reward targets the worthwhile canonical post or comment.
It uses the selected bot and Twinkle's ordinary canonical Level and recipient
rules; Mikey is never charged while Zero/Ciel is displayed. Zero and Ciel are
exempt from recommendation and reward coin charges in the shared canonical
mutation helpers, so neither `insufficient_coins` nor a bot balance decrease
can occur for these actors; every human actor still pays under the existing
Level-based rules. The
reward transaction serializes the rewarder and cap-bearing content row, then
adds only the amount needed for that actor to total exactly three. Existing
three is `already_done`; a cap is `maximum_reached`.
If recommendation succeeds but reward fails, the command exits nonzero with
`partial_failure` and `retrySafe: true`.

## Skip decisions

```bash
lumine admin post skip dailyReflection:99 --json
lumine admin post skip comment:456 --reason "one-line answer, nothing to add" --json
```

A skip records that the management rotation has judged a recommend-queue item
and decided not to act, so neither bot's queue resurfaces it. It writes the
same canonical `users_earn_skip_status` row the website's Earn page writes
(`earnType 'karma'`, `action 'recommendation'`) under the acting bot, and the
queue eligibility predicates honor either bot's row. Human moderators' own
Earn queues are deliberately unaffected: the bots are not database supermods,
so a bot skip never hides content from a human, who may judge differently.

Targets are `comment`, `aiStory`, and `dailyReflection` only; subjects leave
their queue through effort assignment. Skipping an already-skipped item (by
either bot) returns `already_done` with `changed: false`. The optional
`--reason` (at most 500 characters) is stored in the private audit row's
metadata — it is the agent's memory of the judgment, not public content.
The skip requires the `recommendation:write` scope and is audited like every
other mutation.

```ts
type PostSkip = Success<{
  skip: {
    contentType: "comment" | "aiStory" | "dailyReflection";
    contentId: number;
    url: string;
    skippedByUserId: number;
    skippedAt: number | null;
  };
}>;
```

## Audit history

```bash
lumine admin audit list --json
lumine admin audit list --run current --json
lumine admin audit list --run last --actions recommendation.skip --json
lumine admin audit list --target dailyReflection:99 --full --json
lumine admin audit list --cursor '<cursor>' --limit 50 --json
```

Lists the operator's own private audit events, newest first, so an agent can
see what earlier runs did. `--run` accepts `current`, `last`, or a run ID;
`--target` accepts `<targetType>:<id>`; `--actions` is a comma-separated
action list. Filters are bound into the cursor exactly like the other list
cursors. The walk is a bounded descending primary-key traversal over the
existing operator/run/target audit indexes.

Rows are compact by default (identifiers, action, target, result, response
`status`/`changed`, timestamps, and the request's idempotency key). `--full`
adds the stored `beforeState`, `afterState`, `responseJson`, and `metadata`
payloads — the same data the mutation already returned to this operator. The
private per-attempt fencing token is never returned. Reading audit history
requires only the `content:read` scope of an active run.

```ts
type AuditEvent = {
  id: number;
  runId: number | null;
  publicActorUserId: number | null;
  sessionKind: string;
  action: string;
  targetType: string | null;
  targetId: number | null;
  requestId: string;
  result: string; // in_progress | completed | failed | partial_failure | bookkeeping_pending
  status: string | null; // response status, e.g. success | already_done
  changed: boolean | null;
  createdAt: number;
  completedAt: number | null;
  // Present only with --full:
  beforeState?: unknown;
  afterState?: unknown;
  responseJson?: unknown;
  metadata?: unknown;
};

type AuditList = Success<{
  events: AuditEvent[];
  pagination: Pagination;
}>;
```

## Persona-backed comments and replies

```bash
lumine admin daily-run start --identity auto --comment-mode draft --json
lumine admin comment draft 123 --identity auto --json

lumine admin daily-run start --identity ciel --comment-mode post \
  --run-key daily:2026-08-06:comments --json
lumine admin comment draft 123 --identity ciel \
  --idempotency-key comment-123-draft-v1 --json
lumine admin comment draft dailyReflection:99 --json
lumine admin comment reply comment:456 --json
lumine admin comment post --draft-id 77 \
  --idempotency-key comment-123-post-v1 --json
```

A draft targets one of:

- `subject:<id>` (or a bare numeric ID) — a top-level comment on the subject;
- `aiStory:<id>` / `dailyReflection:<id>` — a top-level comment on the
  standalone post;
- `comment:<id>` — a public reply to that specific comment. `comment reply`
  is the same operation and requires a comment target.

A reply's container resolves canonically from the target comment: its subject,
or its AI Story / Daily Reflection root. Comments under any other root are
rejected with `CLI_ADMIN_UNSUPPORTED_REPLY_ROOT`. Replies to Zero/Ciel
comments and to notification comments are rejected with
`CLI_ADMIN_INVALID_REPLY_TARGET` — the bots never thread with themselves or
each other, and a human's later reply to a delegated comment still enters the
existing autonomous comment-assistant pipeline. Published replies carry the
ordinary thread linkage (thread root and reply-to), and notification fan-out
uses the normal canonical path.

```ts
type CommentDraft = Success<{
  draft: {
    id: number;
    runId: number;
    targetType: "subject" | "comment" | "aiStory" | "dailyReflection";
    targetId: number;
    targetUrl: string;
    subjectId: number | null; // container subject; null for standalone posts
    subjectUrl: string | null;
    publicActorUserId: number;
    commentMode: "draft" | "post";
    personaRevision: string; // SHA-256; raw prompt is never returned
    contextRevision: string; // SHA-256 of canonical container/comments/target
    decision: "draft" | "skip";
    reason: string | null;
    content: string | null;
    status: "ready" | "published";
    createdAt: number;
    expiresAt: number;
    publishedCommentId: number | null;
  };
}>;

type CommentPost = CommentGet & {
  status: "success" | "already_done";
  changed: boolean;
  data: CommentGet["data"] & {
    draft: {
      id: number;
      status: "published";
      personaRevision: string;
      contextRevision: string;
    };
    published: {
      commentId: number;
      targetType: "subject" | "comment" | "aiStory" | "dailyReflection";
      targetId: number;
      subjectId: number | null;
      subjectUrl: string | null;
      containerUrl: string;
      commentUrl: string;
    };
  };
};
```

The server loads the canonical container (subject or standalone post) and its
complete visible comment context, then invokes the existing exact Zero/Ciel
system prompt through the shared response assembler with a mode-specific
decision policy (comment vs reply). The raw prompt is never returned or
audited. The model—not regexes or keyword rules—chooses `draft` or `skip`
under the run policy.

Draft IDs are bound to operator, run, public bot, target, comment mode,
context revision, persona revision, expiry, and idempotency key. The context
revision covers the container, every visible comment, and the target binding,
so a thread that changes between draft and publish rejects publication.
Posting locks the draft and context in the same transaction as the ordinary
comment insert. Changed context or persona rejects publication and requires
regeneration. Retries return the already-published comment instead of
duplicating it. Secret-subject gating applies whenever the container is a
subject, including replies inside it.

Draft idempotency keys are permanent per operator: supplying a key that an
earlier run (or another target) already used fails rather than resolving to
the old reservation — normally as the audit layer's
`CLI_ADMIN_AUDIT_IDENTITY_MISMATCH` (different run) or
`CLI_ADMIN_IDEMPOTENCY_KEY_MISMATCH` (different target), with
`CLI_ADMIN_DRAFT_KEY_REUSED` as the draft-table backstop. All three mean the
same thing: embed the run or date in any caller-supplied draft key and retry
with a fresh one. Note that the agent's
own `subject effort set` or `creator set-made-by-poster` between draft and
post changes the context revision — order those mutations before drafting.

## Audit, sockets, and deployment

Every delegated mutation reserves a private audit row before execution and
records run ID, real operator ID, public bot ID, session kind, action, target,
idempotency key, before/after state, result, comment mode, and persona revision
where applicable. It never stores authorization headers, bearer tokens,
cookies, passwords, or raw system prompts.

Retry acquisition and completion are row-locked and fenced by a private
per-attempt token, so an expired request cannot overwrite a newer retry. A new
recommendation commits atomically (the management bots are exempt from the
recommendation coin charge); the canonical prior-recommender approval and the
separate 3-Twinkle reward remain independently retryable.

Public content actions use ordinary Twinkle fan-out:

- comments and secret-view notifications use normal comment notifications;
- comments emit `new_upload` after commit;
- recommendations emit `new_recommendation`;
- recommendation-approval and 3-Twinkle rewards emit `new_reward`;
- effort/creator changes emit `edit_content`;
- Featured changes emit a canonical `home_outdated` refresh.

Apply `twinkle-api/scripts/migrations/add-lumine-admin-delegation.sql` and
then `add-lumine-admin-comment-targets.sql` before deploying the API. They add
only focused daily-run, rotation, draft, and audit tables/columns and indexes;
there are no runtime schema checks. The comment-targets migration backfills
existing subject drafts into the generalized target columns. The local CLI changes
are not available to users until a separately authorized npm publication.

Legacy aliases such as `subjects list`, `subjects get`, `subjects featured`,
`comments get`, and `recommend` remain accepted, but the singular command forms
shown above are the canonical interface.
