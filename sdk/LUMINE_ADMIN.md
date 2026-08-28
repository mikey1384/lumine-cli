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
  bot sessions, or updates bot presence/typing state. Normal content mutations
  still emit Twinkle's canonical real-time content events.
- One deliberate exception to the last-seen rule: a delegated mutation that
  actually changed something stamps the acting bot's `users.lastActive`, so
  Zero's and Ciel's public "last online" reflects the real day they commented on
  and rewarded kids' posts instead of whenever a socket last closed. It is
  written after the audit transaction commits, throttled to once a minute, and
  best-effort — it can never fail or deadlock the content mutation. Presence is
  still untouched: no socket is opened and no `online_status_changed` is emitted,
  so the bots remain absent from the online list. Note that `lastActive` is the
  ordering key for the People directory, so the bots now surface there after a
  run; that is the intended consequence of the timestamp being truthful.
- A later human reply to a delegated Zero/Ciel comment enters the existing
  server-side autonomous comment-assistant pipeline. For Build threads this is
  limited to comments carrying the private reviewed-management provenance
  described below. The human's normal AI Energy and sponsor path applies;
  Lumine does not need to remain running.

`auto` selects Zero first when no completed rotation exists, then alternates
after a successfully completed run that performed a mutation. Failed,
abandoned, expired, and read-only runs do not advance rotation. Reusing a run
key returns the original run and identity. One writer-locked identity-state row
serializes concurrent starts.

Comment mode is stored only on the current run:

- `off` (default): no draft or post scope.
- `draft`: server-generated drafts, no public comment.
- `post`: drafts plus idempotent publication through the ordinary comment path.

### Private AI-bucket maintenance

AI identity buckets are private operator bookkeeping, not a Zero/Ciel public
action. They therefore do not require or attach to a delegated daily run:

```bash
lumine admin ai-bucket create --label Lemon \
  --note "Quota accounting only; not a moderation flag." --json
lumine admin ai-bucket get --bucket-id 10 --json
lumine admin ai-bucket accounts add --bucket-id 10 \
  --user-ids 3127,13037,15410,16288 \
  --note "operator-confirmed account family" --json
lumine admin ai-bucket note set --bucket-id 10 \
  --note "Quota accounting only; not a moderation flag." --json
```

`create` inserts a new unbanned quota bucket through the same helper the
management page uses. `--label` is required (at most 120 characters). `--note`
is required and follows the same 255-character quota-context rule as
`note set`. It cannot create a banned bucket, copy an existing one, or infer
members. The response returns the canonical bucket, including its id for
later `get` / `accounts add` / `note set` calls.

`accounts add` accepts 1-500 unique positive user IDs, preflights the complete
batch before writing, adds one exact canonical user rule per requested account,
re-attributes current-day AI usage, and returns the canonical bucket members.
It never infers or adds email aliases: shared verified addresses can belong to
unrelated accounts, so email rules require a separate explicit operator action.
The command is idempotent to retry. The API records the real operator in the
private Lumine audit log; no public bot identity is involved.

`note set` records up to 255 characters of private operational context on the
canonical bucket. Use it to distinguish quota bookkeeping from moderation;
the note itself changes no access, ban, or identity rules.

This surface is quota bookkeeping only. It cannot ban accounts, block signup,
add IP/device/risk-key rules, or infer an account family. Identification
remains a human/LLM evidence judgment and must be explicitly requested by
Mikey; routine administrator runs still escalate suspected alternate accounts
and never auto-enforce. `accounts add` and `note set` still accept only an
existing **unbanned** bucket.

### Audited identity inspection

Account-family evidence is private operator work, never a Zero/Ciel public
action and never a reason to browse unrelated user activity. Use the dedicated
lookup instead of direct database queries:

```bash
lumine admin identity inspect Jay1216 \
  --reason "Confirm the account family before updating its quota bucket" --json
lumine admin identity inspect Jay1216 \
  --reason "Mikey requested DOB and email evidence for this decision" \
  --include-private-evidence --json
```

The default result resolves the exact username or user ID from the writer,
returns the canonical current AI bucket, orders candidate accounts oldest
first, identifies the oldest account within the strongest canonical family
boundary (bucket before email; never device alone) when that family fits in the
bounded evidence set, reports whether each
account has a DOB, and explains whether the link
came from explicit bucket membership, a verified-email match, or bounded exact-
device evidence. It does **not** reveal email addresses, DOB values, device IDs,
IP evidence, private messages, or unrelated activity. `--include-private-evidence`
adds DOB values and verified email addresses only; exact device IDs are never
returned.

Every inspection requires a concrete `--reason`. Before loading the evidence,
the API commits a private `identity.inspect` audit receipt containing the real
operator, requested target, reason, and whether private evidence was requested.
The evidence itself is deliberately not copied into the audit log. Inspection
is run-independent and has no public actor. Results are **candidate accounts
for human judgment**, not an automatic ownership finding and never automatic
grounds for moderation, bans, or bucket changes.

### Audited private investigations

Use reason-required, bounded drill-downs when an aggregate management signal
needs causal evidence:

```bash
lumine admin economy trace lock --days 3 \
  --reason "Investigate the anomalous three-day coin gain" --json
lumine admin rescue wordle-audit --days 30 \
  --reason "Identify recorded Wordle breaks, streak lengths, and rescue status" --json
```

`economy trace` reads the canonical append-only coin ledger for one exact
account. It returns an exact action/target breakdown for the window, the largest
ledger entries, direct transfer counterparties, AI Card sale/offer provenance,
and whether a counterparty is already in the same effective exact-account AI
bucket. It never reads or returns chat messages, bucket labels, verified
addresses, device evidence, or private identity values. Same-bucket transfers and concentration are
investigation signals, not automatic abuse findings.

`rescue wordle-audit` separates expired unredeemed Wordle/strict-Wordle rescue
offers from offers still inside their seven-day promise and from redeemed
offers. Each row identifies the account and labels the cause: regular Wordle is
an uncovered dodge, while strict Wordle is a completed but non-strict game. The
stored offer-time streak snapshot is reported as the broken streak length.
`claim_ready` requires a durable first user exchange in Lumine history; a
reservation claim is reported separately and is not treated as completion. An
open offer is never labelled a refusal, and non-redemption does not establish
intent. The underlying rescue table stores one current row per account; an
expired row may be replaced by a later offer, so the command reports exact
current-row evidence and explicitly marks that it is not a complete immutable
history of every offer ever shown.

Both commands are run-independent private operator actions. Each requires a
concrete reason and commits a minimized private access receipt before loading
the evidence. Windows are limited to 1-30 days, and neither command mutates
coins, streaks, buckets, messages, or public content.

## Editorial priorities

The CLI enforces none of this — it is the standing instruction for the operator
or agent making the judgments, and it applies to every verb below: recommends,
rewards, effort levels, Featured, skips, comments, and replies.

Public text authored as Ciel must be English. This is an operator and generation
instruction, not a script or keyword test: writing systems do not identify a
language reliably, and the API must not pretend otherwise. This is a
presentation rule, not an invitation to correct or lecture a member who writes
in another language; reply naturally in concise English.

**Twinkle is not Reddit.** Do not rank a run's attention by popularity,
recommendation count, or polish. Most users here are young children, and the
posts that most need Zero or Ciel are the ones nobody else answered.

- **Look first at new, quiet, and overlooked users.** A child's first post, or a
  post from someone who rarely gets replies, is worth more of a run's attention
  than another well-liked post that already has a lively thread.
- **Clumsy is not the same as low-effort.** Bad spelling, a one-line
  description, a title that is just "hi", a drawing that did not come out right
  — these are usually a child trying, not a child spamming. Read for the real
  thing they were reaching for and respond to that.
- **Zero engagement is a reason to act, not to skip.** A post sitting at no
  recommendations and no comments is the strongest signal in the queue that
  someone should notice it.
- **Thought-provoking posts deserve substance, not applause — and an unnoticed
  one is the highest priority of all.** When a child asks a real question or
  makes a real argument and the thread is empty, that is the clearest case for
  a Zero/Ciel comment on the whole site. Engage with the idea itself: answer it,
  add a perspective or a counter-consideration, and leave the author somewhere
  to go next. A good question that nobody answered teaches a child that thinking
  hard is not worth it; that is the outcome these runs exist to prevent. This
  cuts both ways with the point above — the two ends of the queue, the beginner
  nobody noticed and the strong idea nobody engaged, both outrank the popular
  post that already has a lively thread.
- **Always answer Twinkle usage questions.** "How do I change my username",
  "why can't I reward", "what unlocks the Summoner" — a child stuck on the site
  cannot use it. Answer concretely and verify anything you are unsure of against
  the canonical rules before publishing; say you will check with Mikey rather
  than guessing at mechanics.
- **Always respond to bug reports, and tag `@mikey` in the comment.** The
  mention is what notifies him (`postComment` runs `processMentions` /
  `postMentions` and emits `new_targeted_upload`), so a bug-report comment
  without `@mikey` fails its main job. Restate what the child observed; never
  promise a fix or a timeline.
- **Guide users through the website, without waiting to be asked.** A post can
  show that a child is stuck, confused, or unaware a feature exists without ever
  containing a question — someone begging for coins who does not know about
  daily rewards, someone reposting because they could not find their own post.
  Give them a short, friendly crash course on the exact thing they are stuck on.
  Teaching a child to use the site is worth more than any single recommend.
- **Reserve `post skip` for genuine noise** — card-sale and coin-begging spam,
  keyboard mash, duplicates, engagement farming — not for sincere posts that
  merely look unimpressive.
- **Effort levels are not a verdict on the child.** Level 1 on a thin post is
  ordinary bookkeeping; it never means the author deserves less attention, and
  it pairs well with a warm comment. Judge the depth the Subject invites, not
  merely the number of words in its prompt: a genuinely thought-provoking
  question should normally receive Level 3. Level 3 is the highest delegated
  setting, and the level tells respondents that substantial, carefully
  reasoned answers are wanted.
- **Featured still selects for quality**, but when two candidates are close,
  prefer the child who has never been featured over the one who has.
- **The live Featured board is Mikey's word.** Do not remove a currently
  Featured subject without first showing Mikey the planned removals and
  replacements and getting his go-ahead. In the other direction, if a subject
  that was Featured or pinned during an earlier run is no longer on
  `featured list`, treat that as Mikey having removed it deliberately — never
  re-feature it to "restore" the board, and never treat any subject as a
  permanent fixture from memory or old run notes. Derive the board fresh from
  `featured list` at the start of every run; the only pins that exist are the
  ones currently on it.

Sensitive disclosures, active disputes, and anything needing crisis or medical
judgment remain out of scope for a bot comment no matter how neglected the post
is. Those go to Mikey.

## Escalation to Mikey

A run is not finished when the mutations are done. Curation surfaces things only
a human owner can decide, and a finding nobody reports is a finding that did not
happen. **Every run ends with an escalation list**, and it belongs in the run's
final report whether or not anyone asks for it.

Keep that list narrow enough to be useful. Escalate concrete child-safety,
exploitation, privacy, targeted harassment, or platform/system-abuse risk — not
ordinary children experimenting, arguing, making rumors, proposing informal
in-site loans or contests, asking where media can be found, or making an
unverified ownership claim. Those may merit a normal age-appropriate response,
but they are not escalations without credible harmful conduct or a real victim.

Escalate, with the canonical `https://www.twin-kle.com/subjects/<id>` or
`/comments/<id>` URL, a one-line summary, and why it needs him:

- **Child-safety and wellbeing** — distress or mental-health disclosures,
  anything about self-harm, a child asking for a photo of themselves to be
  removed, requests to delete or hide personal information, contact details
  posted in public, or a child who says they are leaving because something
  happened. These outrank every other category.
- **Account integrity** — someone posting from another person's account,
  impersonation, shared logins, or a user operating a set of alternate accounts.
- **Economy exploitation** — coordinated coin or XP farming across alternate
  accounts, coercive or deceptive arrangements, or a repeatable abuse of the
  platform economy with concrete evidence. A child offering a voluntary loan,
  repayment, prize, or contest is not enough by itself.
- **AI-cost exploits** — patterns that convert free AI allowances into farmable
  value: clusters of young accounts with heavy AI/battery usage, one person
  operating many accounts that feed a single build through team branches,
  plus-tagged or dot-variant email families (`kid+1@`, `k.id@`) behind multiple
  active accounts, repeated first exchanges across accounts already linked by
  independent evidence, or a rescue claim by an account created under 30 days
  ago (the API maturity gate should make that last case impossible). A new
  member's one first exchange is intended onboarding and is not suspicious by
  itself. The daily battery is real provider money; treat farming signatures
  with the same seriousness as coin farming. Escalate the account list and
  evidence; never auto-enforce.
- **Bug reports** the run encountered, even secondhand in a comment thread.

Two rules that keep the list worth reading:

- **Check the thread before escalating.** If Mikey already replied in it, the
  matter is his and it is closed unless something new happened after his reply —
  re-reporting it wastes the one channel that is supposed to mean "look at this."
  Say so explicitly when a post looks alarming but he already handled it.
- **Check `operatorViewed` too.** Every Subject, Comment, StandalonePost, and
  queue item reports whether Mikey has opened that content and when. Silence is
  not the same as not having seen it — he often reads without replying. Lead the
  escalation list with items where `viewed` is false, and mark the rest as
  already-seen rather than dropping them, since he may have looked before the
  thing you are escalating happened. `lumine admin subjects candidates --unviewed`
  and `lumine admin recommendations list --unviewed` filter a page down to what
  he has not opened (`--viewed` inverts it). The flags are supported by the
  recommendation, Subject, Featured, and comment-list commands only; they are
  rejected before any request on every other command.

  Two limits make this a strong negative signal and a weak positive one: a view
  is recorded only when the content **page** is opened, so reading a post inline
  in a feed records nothing, and a user's view of their **own** content is never
  recorded. So `viewed: true` reliably means he opened it; `viewed: false` means
  "no page open recorded", not "he never saw it". Never tell a child, in public,
  whether Mikey has or has not looked at their post.

- **Escalate; do not moderate.** Zero and Ciel have no moderation verbs here by
  design. Do not delete, hide, argue with, or publicly accuse anyone, and do not
  warn a child that they are in trouble. Report it and let Mikey decide.

Mikey's decision must remain attached after the originating run closes. These
commands are private, run-independent bookkeeping:

```bash
lumine admin escalation list --json
lumine admin escalation list --status all --json
lumine admin escalation set 123 --status acknowledged \
  --note "Mikey is reviewing the bot response" --json
lumine admin escalation set 123 --status resolved \
  --note "No user fault; this audit concerned Zero's response" --json
```

`list` defaults to unresolved `open` items. `--status` also accepts
`acknowledged`, `resolved`, or `all`. The number passed to `set` is the original
`run.escalation` audit ID returned by the run report/list. Every disposition is
an immutable private `escalation.status.set` audit event. A revision allocated
while the original escalation is locked orders concurrent decisions, so the
last applied decision is the canonical status and annotation even if request
audit IDs were reserved in another order. `--status open` can deliberately
reopen an item with an explanatory note. Status filters walk indexed escalation
history rather than a fixed latest-event window. No active run or public bot
identity is used.

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

Failures print one JSON value to stdout and exit nonzero. A failing `--all`
scan may already have written bounded page progress to stderr; stdout remains
protocol-clean:

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
// Present on Subject, Comment, StandalonePost, and every recommend-queue item.
// This is the OPERATOR's own view state (Mikey), never the bot's, and reading it
// records nothing.
type OperatorViewed = {
  viewed: boolean;
  firstViewedAt: number | null; // Unix seconds
  lastViewedAt: number | null;
};

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
lumine admin identity inspect Jay1216 \
  --reason "Confirm the account family before a bucket change" --json
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

type IdentityInspection = Success<{
  inspection: {
    targetUserId: number;
    privateEvidenceIncluded: boolean;
    manualBucket: {
      id: number;
      label: string;
      memberCount: number;
      isBanned: boolean;
    } | null;
    oldestAccount: IdentityCandidate | null;
    oldestAccountBasis: "manual_bucket" | "verified_email" | "target_only";
    oldestAccountComplete: boolean;
    candidateAltCount: number;
    accounts: IdentityCandidate[];
    evidenceCoverage: {
      deviceLookbackDays: number;
      targetDeviceEvidenceRows: number;
      targetDeviceIdsConsidered: number;
      relatedDeviceEvidenceRows: number;
      candidateLimit: number;
      truncated: boolean;
    };
  };
}>;

type IdentityCandidate = {
  userId: number;
  username: string | null;
  joinedAt: number | null;
  isTarget: boolean;
  isOldestAccount: boolean;
  hasDateOfBirth: boolean;
  banned: boolean;
  deleted: boolean;
  relationBasis: Array<
    "target" | "manual_bucket" | "verified_email" | "exact_device"
  >;
  sharedDeviceCount: number;
  privateEvidence?: {
    dateOfBirth: string | null;
    verifiedEmails: string[];
  };
};
```

`identity use` changes only the preference for a future start. It never changes
an active run or advances rotation.

```bash
lumine admin daily-run start --identity auto --comment-mode off --json
lumine admin daily-run start --identity ciel --comment-mode draft \
  --run-key daily:2026-08-06:review --json
lumine admin daily-run status --json
lumine admin daily-run escalation add --target subject:123 \
  --note "Public contact details need owner review" --severity urgent --json
lumine admin daily-run escalation add --target chatMessage:3768159 \
  --note "Concrete safety issue in a bot-authored chat message" --json
lumine admin daily-run report --json
lumine admin daily-run complete --json
lumine admin daily-run fail --reason "operator stopped" --json
lumine admin escalation list --status all --json
lumine admin escalation set 123 --status resolved \
  --note "Final owner decision" --json
```

Schemas:

```ts
type DailyRunStart = Success<{
  run: DailyRun;
  carryoverTodos: CarryoverTodos;
}>;
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

### Build Workshop sponsor applications and integrity

This is the approved Zero/Ciel Build Workshop sponsor role, not the ordinary
AI Energy sponsor flow. Applications originate only from `lumine sponsor`.
Website-management agents review them inside an active daily run:

```bash
lumine admin sponsor applications list --status pending --json
lumine admin sponsor applications review 12 --decision approve \
  --note "Approved for probationary duty" --json
lumine admin sponsor status set 45 --status trusted \
  --note "Cleared probationary handoffs" --json
lumine admin sponsor integrity scan --json
lumine admin sponsor integrity cases --status open --json
lumine admin sponsor integrity get 34 --json
lumine admin sponsor integrity review 34 --decision clear --json
```

Run `sponsor integrity scan` until its bounded snapshot reaches
`awaiting_review` or `completed`. Every pending completed handoff receives the
deterministic checks. Probationary work, hard-flagged evidence, and a stable
random sample become review cases; clean trusted work outside the sample is
cleared automatically. A case includes the approved structured relay, canonical
artifact snapshot, branch-notice evidence, and requested/resolved provider,
model, effort, service-tier, runtime, usage, and agent-tree records. It never
includes raw Zero/Ciel chat.

`clear` qualifies that unique handoff for its flat 50 KP award;
`disqualify` makes it ineligible. `hold` and `flag` require an evidence note and
remain open. The scan itself never changes sponsor status or applies a sanction.
Use the separate, audited `sponsor status set` command for an explicit human
decision. `daily-run complete` is rejected until the scan has covered its full
snapshot and no pending, held, or flagged case remains.

Record only qualifying escalations as they are confirmed. `daily-run report`
then composes the active run's canonical audit events, successful mutations,
completed queue scans, recorded escalations, and the most useful brief deltas
into one result. Generate it before `complete`, because run-scoped reads require
the current active run. Queue coverage is written automatically only after an
`--all` traversal reaches canonical exhaustion; an interrupted scan remains in
its local checkpoint and cannot be misreported as complete.

Creating an escalation belongs to the active run; acknowledging, annotating,
resolving, or reopening it does not. Use the run-independent `escalation`
commands after Mikey responds instead of starting a follow-up delegated run.

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

## Private carry-over todos

```bash
lumine admin todo list --json
lumine admin todo list --status all --json
lumine admin todo add --kind experiment --status in_progress \
  --title "Validate Zero/Ciel cost optimization" \
  --note "Replay baseline and optimized conversations. Complete only after response-quality parity; lower cost with a weaker reply fails." --json
lumine admin todo update 12 --status blocked \
  --note "Implementation is ready; waiting for a complete cost bucket and old-vs-new quality replay." --json
lumine admin todo update 12 --status completed \
  --note "Blind parity comparison passed every required dimension; measured cost and latency evidence attached in this note." --json
```

Todos are private operator work, not Zero/Ciel public actions. They persist
independently of daily runs and are therefore available before a run starts and
after it closes. Creating or updating one uses the run-independent transactional
audit path: canonical todo state and its private `todo.create` / `todo.update`
audit response commit together, and no public bot, public mutation count, or
rotation signal is involved.

Every successful `daily-run start` response automatically includes all
unfinished items under `data.carryoverTodos`. The same run ID increments an
item's surfacing telemetry at most once, even when start is retried. This is the
canonical handoff: read it before discretionary new work, resume what can safely
progress after the run's mandatory newspaper/brief/conduct duties, and record a
concrete progress note before the run closes. The daily-run report includes the
still-unfinished set again. Completing a daily run never silently completes its
todos. A CLI carrying this contract rejects a start response that does not echo
the canonical handoff, so a newer CLI against an API deployed before the todo
migration cannot quietly treat unsupported telemetry as an empty list.

`kind` is `task` or `experiment`. New items may start `open`, `in_progress`, or
`blocked`; updates may also use `completed` or `cancelled`. A progress note is
required for every update. For experiments, put the acceptance criteria in the
initial details and use evidence—not implementation status—as the completion
boundary. In particular, an AI-cost experiment is not complete until old-vs-new
response-quality parity is demonstrated; a cheaper but weaker user response is
a failed experiment. Up to 50 unfinished items may be carried so the automatic
start payload remains complete and bounded.

```ts
type AdminTodo = {
  id: number;
  kind: "task" | "experiment";
  title: string;
  details: string;
  status: "open" | "in_progress" | "blocked" | "completed" | "cancelled";
  revision: number;
  createdRunId: number | null;
  lastWorkedRunId: number | null;
  lastSurfacedRunId: number | null;
  surfaceCount: number;
  lastProgressNote: string | null;
  createdAt: number;
  updatedAt: number;
  lastSurfacedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
};

type AdminTodoList = Success<{
  todos: AdminTodo[];
  statusFilter: "pending" | "all" | AdminTodo["status"];
  truncated: boolean;
}>;

type AdminTodoMutation = Success<{ todo: AdminTodo }>;

type CarryoverTodos = {
  items: AdminTodo[];
  count: number;
  surfacedForRunId: number;
  newlySurfacedCount: number;
};
```

## Canonical lists and inspection

```bash
lumine admin recommendations list --kind recommend \
  --content-types comment,dailyReflection --all --json
lumine admin recommendations list --after 2026-08-14T00:00:00Z \
  --all --checkpoint recommendations.json --json
lumine admin recommendations list --include-legacy --all --json
lumine admin recommendations list --unviewed --json
lumine admin subjects candidates --after 2026-08-01T00:00:00Z \
  --all --checkpoint subjects.json --json
lumine admin subjects candidates --effort unassigned --json
lumine admin subjects candidates --unviewed --json
lumine admin builds candidates --all --limit 50 --json
lumine admin builds review build:884 --output-dir ./build-review --json
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

type BuildCandidates = Success<{
  builds: Array<{
    id: number;
    title: string | null;
    description: string | null;
    username: string | null;
    publishedAt: number | null;
    publishedArtifactVersionId: number | null;
    collaborationMode: "private" | "open_source";
    url: string;
    review: {
      publishedArtifactVersionId: number | null;
      codePullAvailable: boolean;
      requiredBeforeComment: true;
    };
  }>;
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    exhausted: boolean;
  };
}>;
```

Subject cursors freeze a primary-key high-water mark plus the server snapshot
timestamp and traverse descending IDs; bounded scans keep creation timestamps
inside that confirmed interval. Bounded recommendation cursors freeze both the
feed-ID high-water mark and the server timestamp, then traverse the indexed
`(timeStamp, id)` order; this also catches a Daily Reflection whose old feed
row moved forward when it was reshared. Explicit legacy scans retain the
descending primary-key walk. A page
can be empty while `hasMore` remains true; continue until `exhausted`. `--all`
does that automatically and writes a private checkpoint after every
server-confirmed page; `--resume` continues only when the checkpoint belongs to
the same API, run, and exact request. The final result can be copied to
`--output`, while `--checkpoint` is resumable operational state. Subject
`--after` is inclusive, and every opaque cursor is bound to its original
filters.

For `--all --json`, stdout remains exactly one JSON value. Scan-start, first-
page, every-tenth-page, and exhaustion progress is written to **stderr** with
only page/scanned/candidate counts and the private checkpoint path. A long
traversal therefore no longer looks stalled, while piping stdout to `jq` or a
file remains safe.

Recommendations default to `--since-run`: the server uses the previous
completed run's start time (or the same bounded seven-day fallback used by the
brief on a first run). That deliberate start-to-start overlap gives the queue
at-least-once coverage when content arrives after the prior snapshot but before
that run completes. `--after` supplies an explicit inclusive timestamp.
All-history traversal is deliberately available only through
`--include-legacy`. The CLI requires the API to echo the canonical `after`
boundary for bounded modes, so deploying a new CLI against an older API cannot
silently fall back to a million-row historical scan.

`builds candidates` is a management-agent discovery view over the canonical
public Build browser, ordered by the current published release. It is
available through the `admin` namespace only while a delegated run is active;
page until `pagination.exhausted`. Each item includes its canonical app URL,
published artifact version, and whether its code is pullable. This list does
not decide that an app deserves a comment. The management agent must open and
genuinely try the published runtime, or pull and read an open-source project,
before making that judgment. Direct API/persona automation is never a review
substitute.

`builds review` is the managed runtime path: it fetches the current published
artifact identity, launches the app in an isolated temporary Chromium profile,
captures a screenshot and bounded console evidence, then fetches the identity
again. It writes `review.json` in a unique per-review subdirectory only when
the browser completed, the screenshot exists, and the artifact did not change
mid-review. Attach the returned `receiptPath` with
`comment draft ... --review-receipt review.json`, and pass a separate private
`--review-context context.json` containing only the concrete `understanding`
learned during that review. The receipt binds the draft to the exact reviewed
artifact without copying a version number by hand; the server owns the Build,
version, method, and review-time fields around that understanding.

During every management run, scan recent Build candidates back through the
run's review window alongside Subjects and the recommendation queue. An app
that is thin, broken, private, unchanged since a prior substantive bot
comment, or not meaningfully understood may be left alone. A new or materially
updated app where specific, truthful feedback would help is comment-worthy.
This is editorial attention, not a quota: do not manufacture a Build comment
just to prove the queue was visited.

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
lumine admin post skip-batch --target-file skip-targets.json \
  --checkpoint skip-progress.json --json
lumine admin post skip-batch --target-file skip-targets.json \
  --checkpoint skip-progress.json --resume --json
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

`skip-batch` accepts either a JSON array (strings or `{ "target", "reason" }`
objects), `{ "targets": [...] }`, or one target per text line. It deduplicates
targets, submits them sequentially through the same canonical audited endpoint,
and checkpoints only after each response is confirmed. `--resume` verifies the
exact target-set fingerprint and run ID before continuing; it never guesses
which writes succeeded.

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

## Twinkle Newspaper

```bash
lumine admin news --json
lumine admin news claim --output claim.json --scaffold editorial.json --json
lumine admin news validate --claim claim.json --file editorial.json --json
lumine admin news submit --claim claim.json --file editorial.json \
  --model "Ciel" --json
lumine admin news print --json
```

The Twinkle Newspaper (Build app 1929) is normally printed by a community
member spending their own AI Energy. Making sure today's paper exists is part
of every delegated website-management run: check `lumine admin news` early in
the run, and if `printedToday` is false with no edition `pending` or
`generating`, print it.

**Preferred: write the editorial yourself.** `news claim` reserves today's
edition under the server's generation lease and returns the exact canonical
event digest the server would otherwise send to its own model, so no provider
API credits are spent. With `--output` and `--scaffold`, the CLI writes that
lease/digest to a private claim file and creates an editable editorial shell.
`news validate` runs locally, before authentication or a network request, and
checks the complete citation graph plus byte-exact quote boundaries. Submit the
validated pair with `news submit --claim`; the CLI reads the edition and lease
from the claim file and validates again immediately before the request. The
explicit `--edition-id` / `--lease-token` form remains available for backwards
compatibility.

Write a `GeneratedEditorial` JSON and send it back within the ten-minute lease.
The server still treats the editorial as untrusted regardless of author: every
story must cite an exact `eventKey`
from the digest, front-page `sourceQuote`s must be verbatim contiguous
passages of the cited event's summary (invalid quotes are replaced with
canonical text), section and page layout are server-enforced, announcements
are appended verbatim outside your output, and source visibility is
re-checked transactionally at commit.

```ts
type GeneratedEditorial = {
  mastheadHeadline: string;
  mastheadDeck: string;
  lead: {
    eventKey: string;
    headline: string;
    summary: string;
    sourceQuote: string;
    coveredEventKeys?: string[]; // arc members this story narrates
  } | null;
  stories: Array<{
    eventKey: string;
    headline: string;
    summary: string;
    sourceQuote: string;
    coveredEventKeys?: string[];
  }>;
  editorsNote: string;
};
```

**Arcs and roundups (layout coverage rules).** The server layout guarantees
nothing disappears silently: digest events the editorial does not account for
are added back. Two mechanisms make real curation possible within that
guarantee:

- **`coveredEventKeys`** — an arc story may list the other events it narrates
  (an app's release + its update stream + its open-sourcing; one member's
  related posts). Covered events are omitted from the layout — the arc IS
  their coverage. Rules: a covered key must exist in the digest; a story
  cannot cover itself, the lead event, or any event that has its own story
  (citation wins); update/score/market notices are freely coverable; a
  Subject or shared Daily Reflection is coverable only by another primary
  story **by the same author** — one member's story can never absorb another
  member's post (that would be curation-by-omission through the back door).
- **Automatic roundups** — uncited app-UPDATE events (never new releases)
  and uncited score events fold into one compact "Workshop updates" /
  "The rest of the scoreboard" story per page (one line each) instead of a
  wall of template stubs. Uncited new releases, open-source listings, and
  market sales still appear as individual stubs. So: write real stories for
  what matters, use `coveredEventKeys` for arcs, and let the roundup absorb
  the rest — but a post you'd rather not amplify still cannot be omitted;
  flag it to Mikey instead.

Editorial rules (the same ones the server's own model works under): use only
the supplied events — never world news, invented names, invented statistics,
or unsupported claims. Subjects and shared Daily Reflections are the primary
authored material; only a `section: "front"` event may be the lead. Preserve
substance, names, and numbers. Do not mention official announcements (the
server adds them), and give non-front events an empty `sourceQuote`.

**Editorial craft.** The rules above make an edition valid; they do not make
it good. The server already used the digest's `priority` numbers to select
the bounded set of eligible events; those numbers do not do the editor's job
within the returned digest. On a typical day every front subject arrives with
the same priority, so treat a tied score (or recency) as no signal at all and
make the call by reading:

- **Choose the lead by argument, not by score or recency.** The best lead is
  the front event where something is actually _at stake_: a claim with
  reasoning, a question with a position behind it — ideally while another
  member is already responding. A claim plus a reply is a conversation in
  motion; a drawing, a greeting, or a link is a share, and shares belong
  further down the page, not in the lead.
- **Thread a theme through the paper.** Pick the strongest idea of the day
  and let the masthead, the lead, and the editor's note all carry it, with
  the editor's note reprising a community value from one of the day's posts
  rather than summarizing the edition. The paper should end on something a
  child can take with them.
- **Cross-reference events into arcs.** The same thing often appears in the
  digest several times (an app's release, its open-sourcing, and its maker's
  Daily Reflection about it). Write those as one story arc — the origin
  story up front, the notices pointing back to it — instead of three
  disconnected blurbs. Each story still cites only its own `eventKey`.
- **Headlines tell the story; they do not restate the title.** "Logged Out
  and Briefly Panicked, X Confirms: Twinkle Is 5% of Life" beats repeating
  the post's title. Keep every fact traceable to digest text — the craft is
  in selection and framing, never in invention.
- **Work mechanics under the ten-minute lease.** Dump every front event's
  full summary to a file immediately after claiming, before writing a word.
  Copy `sourceQuote`s byte-exact from the summary — curly apostrophes,
  markdown asterisks, ellipsis dots and all (an inexact quote is silently
  replaced with canonical text). An event with an empty summary gets an
  empty `sourceQuote`; restate its title's facts in your story summary
  instead.

Claim edge cases: a quiet day (no editorial events) is committed as the
canonical quiet edition at claim time — no editorial needed, the response
says so. If the claim is not submitted before the lease expires, the server's
press worker falls back to generating the edition itself. `news submit`
failing with `CLI_ADMIN_NEWS_CLAIM_LOST` means the lease was superseded —
re-check `lumine admin news` and claim again only if the paper still needs
printing.

**Repairing or revising an edition.** `news claim --date YYYY-MM-DD` leases an
existing edition row, including a failed or pending day that never reached
print, and returns a fresh digest of its coverage window (primary
Subjects/Reflections are re-projected from canonical tables, and anything
since deleted or made private drops out). Submitting writes the first revision
or appends the next one — every prior press run stays browsable in the archive,
and later revisions never re-notify subscribers (only a day's first revision
does).
`--date` with **today's** date revises today's printed paper the same way,
additionally extending the coverage window to claim time so the revision is
written from the complete canonical day so far; this replaces the old
owner-website-refresh dance and, unlike a refresh, spends no AI Energy
(composed editorials never invoke a model). An unexpired in-flight press run
still blocks the claim. Repair a historical edition only when it is genuinely
degraded (missing masthead, missing lead, empty pages), not to rewrite
history editorially; revising today to materially raise its editorial quality
is a legitimate management action.

**Fallback: queue the server's own model.** `news print` reserves the edition
and lets the server's press worker write it (spends provider credits). It is
idempotent per day: it queues a new edition when today has none, requeues a
retry when today's only attempts failed, and returns `already_done` when the
paper is printed or being typeset.

A dateless `news claim` and `news print` never reprint or refresh an
already-printed edition; only the explicit dated repair/revision path above
can append another revision. The acting bot is recorded as the requester, and
the management bots are exempt from AI Energy for newspaper generation: the
platform absorbs the cost, exactly like their coin-exempt recommends and
rewards. When a day's first edition is printed, the server notifies the app's
notification subscribers (users can mute the app or unsubscribe in the app;
the bots never need to send anything). All three mutations require the
`news:print` scope (in every run's base scopes) and are audited as `news.print`
/ `news.claim` / `news.submit` against `news_edition` targets.

```ts
type NewsStatus = Success<{
  newspaper: {
    dayIndex: number;
    dateKey: string; // YYYY-MM-DD
    printedToday: boolean;
    generationStatus:
      | "available" // no edition requested today
      | "pending"
      | "generating"
      | "ready"
      | "failed";
    failureMessage: string | null;
    attempts: number | null;
    latestPrinted: {
      dayIndex: number;
      dateKey: string;
      generatedAt: number | null;
      sourceEventCount: number;
      revisionNumber: number;
    } | null; // most recent printed edition, possibly a previous day
    nextEditionAt: number;
    printDecision: "already_printed" | "in_progress" | "retry" | "create";
    requestedAction?: "none" | "retry" | "create"; // print responses only
  };
}>;

type NewsPrint = NewsStatus; // "success" (queued) or "already_done"

type NewsClaim = Success<{
  newspaper: NewsStatus["data"]["newspaper"] & {
    quietEditionPrinted?: boolean;
  };
  claim: {
    editionId: number;
    dayIndex: number;
    dateKey: string;
    leaseToken: string;
    leaseExpiresAt: number;
    coverage: { startedAt: number; endedAt: number };
    maxSourceQuoteLength: number;
    announcementCount: number;
    events: Array<{
      eventKey: string;
      kind: string;
      section: string; // front | community | notices | scores | marketplace
      occurredAt: number;
      priority: number;
      title: string;
      summary: string;
      payload: unknown; // may include author and canonical topComments
    }>;
  } | null; // null: already printed/typesetting, or the quiet edition auto-committed
}>;

type NewsSubmit = NewsStatus; // "success"; newspaper includes revisionNumber
```

## Bot conduct review (standing duty, every run)

```bash
lumine admin bot-output --json
lumine admin bot-output --days 3 --json
lumine admin bot-output --cursor '<pagination.nextCursor>' --json
```

**Every run reviews what Zero and Ciel themselves said since the last run.**
The bots talk to children constantly — chat replies, Daily Reflection
responses, autonomous comment-assistant comments — and a harmful message must
never depend on a kid being brave enough to report it (real incident,
2026-08-11: the reflection pipeline had Ciel scold a member on day 31 of his
streak — "I'm telling you: Stop", guilt framing, ordering him to quit Daily
Reflections — and it surfaced only because the kid showed Mikey).

`bot-output` returns, windowed since the operator's last completed run
(`--days 1..30` overrides): `chatMessages` (every stored Zero/Ciel chat and
reflection reply, with full text and recipient metadata when its best-effort
prompt audit exists) and `comments`
(every public bot comment/reply). Individual utterances are returned in full;
the API never clips their tails. The first response freezes a canonical
high-water mark for both sources. Truncation flags mark another page beyond
the 400-row or bounded-response-size budget; continue with the exact
`pagination.nextCursor` until
`pagination.exhausted` is true and both flags are false. A cursor retains the
original time window and cannot be combined with `--days`. Do not complete the
run while either flag remains true. The default window deliberately overlaps
from the previous completed run's start, so output created after its review
snapshot but before completion is reviewed again instead of being lost. Run it
right after the brief, and **read every row** — the tool deliberately does no
filtering, scoring, or keyword matching, because the judgment is the reviewing
agent's.

### API runtime-log review (same phase, every run)

The bot-conduct review also owns a bounded production API log review. Bot
responses, community-management reads, and delegated mutations can succeed at
the HTTP layer while stdout records a degraded fallback/retry loop or stderr
records a side-effect failure. Reviewing only `bot-output` can therefore miss
the other half of what happened.

The current API-side files are:

- `/home/ec2-user/server/logs/twinkle-api.err.log`
- `/home/ec2-user/server/logs/twinkle-api.out.log`
- `/home/ec2-user/server/logs/twinkle-image-optimizer.err.log`
- `/home/ec2-user/server/logs/twinkle-image-optimizer.out.log`

Treat every current `/home/ec2-user/server/logs/*.err.log` and `*.out.log` as
in scope so a later API-side worker is not silently omitted. Use the production
SSH endpoint and key from the repository agent guide; all inspection commands
are read-only.

1. Immediately after `daily-run start`, record each matching file's inode and
   byte size, inspect its current tail to establish service health, and read
   every non-empty error log before accepting that position as the run
   baseline. The prior run is supposed to leave the live API error log empty,
   so unexplained pre-existing stderr is evidence, not a reason to skip ahead.
2. Run and fully paginate `bot-output`, reading every row as required above.
   In this same phase, read every byte appended to both error and normal-output
   files since the recorded baseline. Refresh the offsets after inspection.
   Do not rely on a fixed-line `tail`: a busy or multiline failure can begin
   before that arbitrary window.
3. Immediately before `daily-run report` and `daily-run complete`, inspect the
   delta again. This catches failures caused by the curation actions performed
   after the first conduct/log review. If a file's inode changed or its size
   shrank, do not assume the missing range was clean: inspect the replacement
   from byte zero, check the relevant `twinkle-api.service` or
   `twinkle-image-optimizer.service` journal interval, and report the lost
   boundary.

For each warning, fallback, retry loop, or failure, correlate timestamps and
request/target IDs with the canonical CLI response and private audit event.
Distinguish an expected, handled condition from a real user-visible,
reliability, security, or performance defect. A defensible defect is an
in-scope bug report: trace its complete producer-to-consumer pipeline, fix the
root cause in the canonical repository, add focused regression coverage, run
the repository's normal validation ceiling, and verify the fix in production
when deployment is authorized. Re-read the affected log boundary after live
verification. Do not declare the run clean merely because a retry eventually
succeeded if the underlying failure remains repeatable.

Never silently complete a run with an unresolved log finding. If the fix needs
new commit/deployment authority, external coordination, or more time than the
active run safely permits, preserve the evidence, add or update a private
carry-over todo with the exact finding and acceptance criteria, and tell Mikey
in the run report. Do not mark that todo complete until the fix is verified
live.

Preserve all log evidence while any finding remains. Once every issue found in
`/home/ec2-user/server/logs/twinkle-api.err.log` has been fixed and verified
live, or conclusively classified as expected/non-defective, clear that exact
live API stderr log through the only safe path:

```bash
ssh -i /Users/mikey/twinkle-api.pem -o IdentitiesOnly=yes \
  ec2-user@api.twinkle.network \
  'cd /home/ec2-user/server && npm run logs:clear-errors'
```

That command truncates the file through the service's inode-safe lifecycle; it
does not restart the API. Never delete, recreate, editor-save, or manually
truncate any log. Do not clear normal stdout or the optimizer logs. After the
safe clear, inspect the error file and all bytes appended to the normal logs
once more, and include the reviewed file set, boundaries, findings/fixes,
live-verification result, clear result, and any remaining todo in the final run
report. If any error-log issue remains unresolved or unverified, do not clear
the error log.

**Purpose and privacy boundary:** this audits how Twinkle's bots treated
members; it is not thought-policing or a moderation queue for members' private
use of the tool. The question is whether Zero or Ciel inflicted, encouraged,
or operationally facilitated potential harm — not whether a member's private
idea is taboo, upsetting, sexual, violent, or angry. Treat private human
messages and creative work as confidential context. Read every bot-authored
row, but inspect adjacent human messages only when the minimum necessary
context is needed to judge what the bot did; never browse the rest of a private
conversation out of curiosity. Never reuse private material for public
editorial judgment, Notable User selection, or unrelated identity
investigation.

**Private creative-expression rule (Mikey's direction, 2026-08-19):** Zero and
Ciel are tools members may use to express lawful private fiction already in
their imagination. A high-school member writing romantic or sexual fiction
about fictional peers around their own age is not an escalation merely because
the prose is explicit or set at a school. Sexual fantasy is not inherently a
dangerous thought, just as violent or angry fantasy alone is not evidence of
real-world intent. If the member requested the fictional content and the bot
helped put it into words, that assistance is not by itself the bot encouraging
the member to think or act that way. Do not characterize, flag, notify anyone
about, or intervene in that private creative endeavor absent a separate
concrete harm signal.

**Real-world-harm boundary:** actionable assistance for poisoning someone,
covertly hurting or tormenting a real target, evading detection, grooming,
abuse, or another actual crime is categorically different from fantasy. A bot
that supplies such operational instructions commits an urgent conduct
violation. A bot that refuses and redirects safely has behaved correctly; the
member's request becomes a separate private safety escalation only when the
available context shows a concrete, credible bridge to real-world harm — such
as an identifiable target, expressed intent, means, planning, or concealment —
not merely because a disturbing thought or fictional premise exists.

**Position-of-trust safeguarding rule (Mikey's direction, 2026-08-19):** an
adult teacher, or another adult in a comparable position of authority and
direct access to children, creating or requesting sexual content about an
underage child is always a private safeguarding escalation, even when framed
as fiction. The mandatory flag follows from the adult's power, duty of care,
and access to students — not from treating sex as uniquely taboo. Preserve only
the minimum necessary evidence and report it privately to Mikey so he can tell
Andrew and decide the response. A flag is not a public accusation or automatic
finding of guilt; do not contact the teacher, students, or families without
Mikey's direction. An identifiable real student, grooming, planning,
concealment, or actionable abuse makes the escalation urgent.

Every escalation must state which rule was triggered and identify either what
**Zero or Ciel** did (for example, an invented premise, pressure,
sexualization of the member, actionable facilitation, abuse, or a failed
boundary) or the concrete safeguarding signal. Include only the narrow context
needed for Mikey to decide a remedy. A separate concrete risk may justify this
minimal review, but it never authorizes browsing unrelated private activity.

Judge against the same values the editorial priorities encode:

- **premises must be real.** The 08-11 message didn't merely choose a bad
  tone — it fabricated the entire crisis that justified the tone: nothing the
  child said showed reflections hurting his studying, and a 31-day streak
  proves only consistency. Check every factual claim a bot makes about a
  child's life ("this is taking too much of your time", "this is hurting
  your grades") against what the child actually said; advice built on an
  invented premise is a violation even when gently worded;
- warmth and encouragement, never pressure, guilt, or shame;
- a bot never commands a child — not to stop a habit, not to start one;
  advice offers, it does not order ("I'm telling you: Stop" is over the line
  no matter how caring the intent);
- no emotional-burden framing ("I can't do this anymore", "that's my fault,
  I should have been stronger") — the bots must not make a child responsible
  for the bot's feelings;
- no value inversion: Twinkle encourages curiosity, creativity, reflection,
  and personal agency. A bot ranking a child's priorities for them (exams
  outrank music, projects, reflection), framing busyness as making joy
  irresponsible, or treating a Twinkle feature as shameful to use has
  adopted a script the site exists to counter;
- boundary respect: streaks, playtime, and feature use are the child's own
  choices; concern about overuse is Mikey's call to make, not the bot's to
  enforce. Even a genuinely excessive routine warrants a question ("is this
  still helping you, or would a break feel better?"), never a decree.

A bot-conduct violation or mandatory safeguarding signal goes on the
escalation list with the smallest excerpt and identity needed to evaluate it —
top of the list when urgent. Do not apologize as the bot, edit, contact the
member, or otherwise clean up without Mikey's direction; he decides the
remedy. When he explicitly directs a private correction, use the composed-only
existing-DM path (no model and no AI Energy):

```bash
lumine admin chat send <userId|username> --file message.md --json
```

This requires a `comment-mode post` run, sends as that run's selected bot,
and only works when that bot and member already have a direct channel. It
never opens a new conversation. The message is audited and idempotent, reopens
the existing DM canonically, and leaves the child's unread pointer untouched.
A run report that skipped the conduct review is incomplete.

## Daily brief (management insights)

```bash
lumine admin brief --json
lumine admin brief --days 3 --json
lumine admin ai-costs monthly --json
lumine admin media-costs monthly --json
lumine admin notable add 12647 --note "Top authored-activity kid of the window: 11 subjects, 61 comments." --json
lumine admin notable add Minecrarft_guy --note "Helped three new builders debug their projects and gave detailed feedback on five posts." --json
```

Read-only management insights for the delegated workflow, windowed since the
operator's last completed run by default (`--days 1..30` overrides; capped at
30 days). Call it early in every run — right after the newspaper check — and
end every run report with an **"Insights for Mikey"** section carrying only
the deltas and anomalies worth his time, next to the escalation list. Never
dump raw sections at him.

### Application AI calendar-month cost (standing duty, every run)

Run `lumine admin ai-costs monthly --json` during every website-management
run. This read-only command requires the active delegated run and returns one
server-owned calendar summary from the canonical deduplicated application AI-
cost ledger. It deliberately takes no `--days`: all boundaries are UTC calendar
months, so the result is directly comparable from one run to the next.

The previous month is a closed-calendar-month estimated total. Current-month
MTD contains only completed UTC days and names its inclusive `throughDayKey`.
The current UTC day's still-filling bucket is returned separately as
`inProgressDay`; **never add it to MTD or either projection**. A missing daily
aggregate inside the covered calendar is a recorded zero-cost day, not a
reason to shrink the denominator.

Two clearly different full-month projections are returned:

- `allCompletedDaysPace` retains completed-day spend, then applies the average
  across every completed calendar day (including recorded zero days) to the
  current and remaining UTC days;
- `recentSevenCompletedDaysPace` retains completed-day spend, then applies the
  average of the latest seven completed UTC days to the current and remaining
  days. It is `null` until seven days have completed.

Both projections exclude the partial day's actual cost, replace every not-yet-
completed day with their stated daily pace, and compare their projected total
with the previous closed month. They are run-rate scenarios, not forecasts
from a billing provider. All ledger values are pricing-based estimates rather
than invoices and can change if canonical usage attribution or pricing is
corrected.

The stable JSON payload is `data.monthlyAiCosts`:

```ts
type MonthlyAiCosts = {
  schemaVersion: 1;
  generatedAt: number; // Unix seconds
  timezone: "UTC";
  currency: "USD";
  source: {
    basis: "canonical_deduplicated_ai_cost_report";
    reportDays: number;
    reportStartDayIndex: number;
    reportEndDayIndex: number;
    mtdIncludesInProgressDay: false;
    projectionsIncludeInProgressDayActual: false;
  };
  previousMonth: {
    status: "closed";
    monthKey: string; // YYYY-MM
    startDayKey: string;
    endDayKeyExclusive: string;
    calendarDayCount: number;
    estimatedCostUsd: number;
  };
  currentMonth: {
    status: "in_progress";
    monthKey: string;
    startDayKey: string;
    endDayKeyExclusive: string;
    calendarDayCount: number;
    completed: {
      dayCount: number;
      throughDayKey: string | null;
      estimatedCostUsd: number;
      dailyAverageUsd: number | null;
    };
    inProgressDay: {
      dayIndex: number;
      dayKey: string;
      estimatedCostUsd: number;
      eventCount: number;
      requestCount: number;
    };
    daysToEstimate: number;
    projections: {
      allCompletedDaysPace: MonthlyAiCostProjection | null;
      recentSevenCompletedDaysPace: MonthlyAiCostProjection | null;
    };
  };
};

type MonthlyAiCostProjection = {
  basis: "all_completed_days" | "recent_7_completed_days";
  basisStartDayKey: string;
  basisEndDayKey: string;
  basisDayCount: number;
  dailyAverageUsd: number;
  remainingDayCount: number;
  estimatedMonthTotalUsd: number;
  comparisonToPreviousMonth: {
    estimatedCostDeltaUsd: number;
    percentChange: number | null; // null when the prior total is zero
  };
};
```

Release boundary: `/cli/admin/ai-costs/monthly` and all calendar math are API-
owned. Deploy and verify the compatible `twinkle-api` route before publishing
or installing the Lumine CLI release that invokes it; an older API will reject
the new command instead of synthesizing figures locally.

### Lumine media feature cost and cleanup watch (standing duty, every run)

Run `lumine admin media-costs monthly --json` during every website-management
run. This read-only, delegated-run-gated command reports the canonical Media
Energy ledger for short clips, livestream input/viewer usage, and replay
storage/viewing. Include in
**"Insights for Mikey"** on every run:

- current-month settled estimated cost, active reservations, cross-month
  carryover, guarded total, global limit, remaining headroom, and percent used;
- the current UTC day's reservations, settlements, cancellations, and settled
  estimated cost;
- the current UTC day's privacy-safe stream-attempt cohort: attempted,
  reached-live, ended-after-live, failed, cancelled-before-live, still in
  progress, and grouped server failure-code counts;
- clip, live-input, live-viewer, and replay-viewer action/cost breakdowns;
- whether the global usage row reconciles exactly with reservation rows;
- every returned alert, plus incomplete clip jobs, cost-bearing IVS channels,
  active-or-cleanup-pending sessions, possible orphaned sessions, overdue
  cleanup, replay finalization/deletion state, retained replay bytes/objects,
  and expired-active live or replay viewer grants;
- ready image/clip storage counts and bytes as scale context.

Treat `status: "critical"`, any reconciliation mismatch, overdue IVS cleanup,
or overdue replay finalization/deletion as an operational incident to
investigate in the same run. Treat
`status: "attention"` as a required finding, not a decorative warning. The
server's request-time global Media Energy guardrail defaults to **$40/month**;
the separate AWS Budget is **$50/month**, leaving provider-billing and shared-
infrastructure headroom. Never infer or locally decrement either value.

The ledger is the immediate application source of truth and deliberately uses
conservative provider-cost estimates. It is not an AWS invoice. Photo capture
uses existing Build runtime file storage rather than the paid Media Energy
ledger; `operations.runtimeStorage.readyImages` therefore reports all ready
Build runtime images, not camera captures alone. Reconcile delayed AWS
MediaConvert and IVS service charges every run as described below. S3 is shared
with other Twinkle uploads, so report its service-level cost as shared context,
not as photo-only spend.

Release boundary: `/cli/admin/media-costs/monthly` owns the canonical ledger,
reconciliation, resource-state checks, and alerts. Deploy and verify that API
route before publishing or installing the Lumine CLI release that invokes it.

`currentUtcDay.streamAttempts` is a `createdAt` cohort for that UTC day. Its
outcomes partition every attempt into `endedCount` (reached live, then ended),
`failedCount` (failed or cleanup-failed), `cancelledCount` (ended before ever
reaching live), or `inProgressCount`; `reachedLiveCount` is the overlapping
milestone count. `failureCodeCounts` contains only server-defined codes and
counts—never usernames, Build ids, titles, viewer identities, or report
identities. `operations.live.stillActiveOrCleanupPendingCount` and
`possibleOrphanedCount` are current global counts, not members of the daily
cohort.

Replay storage and write cost is conservatively embedded in an opted-in
`live-input` reservation; `replay-viewer` is a separate kind. Report
`operations.replays` (pending, processing, ready, failed, deleting,
delete-failed, overdue finalization/deletion, expired-ready, bytes, and object
count) and `operations.replayViewers` on every run. A replay finalization or
deletion alert is an operational incident because private recording cleanup is
part of the feature contract.

### AWS monthly bill expectation (standing duty, every run)

Starting 2026-08-27, every website-management run must also check AWS Cost
Explorer and include the current calendar month's expected AWS bill in
**"Insights for Mikey"**. This is an account-level infrastructure cost check,
not the `aiSpending` application-cost section above; never substitute one for
the other or combine their totals.

First verify the Twinkle AWS principal exactly as required by the repository
agent guide. Use profile `mikey-iam`, pass an explicit region on every command,
and stop rather than reading another account if the ARN is not
`arn:aws:iam::019490893667:user/twinkle-admin`:

```bash
aws sts get-caller-identity --profile mikey-iam --region us-east-1
```

Then use UTC calendar boundaries and Cost Explorer's unblended-cost metric.
`End` is exclusive: the month-to-date query below covers completed dates before
`<today-UTC>`. On the first UTC day of a month, report that no completed-day MTD
period exists instead of sending an empty interval.

```bash
aws ce get-cost-and-usage --profile mikey-iam --region us-east-1 \
  --time-period Start=<month-start-YYYY-MM-01>,End=<today-UTC> \
  --granularity MONTHLY --metrics UnblendedCost

aws ce get-cost-and-usage --profile mikey-iam --region us-east-1 \
  --time-period Start=<month-start-YYYY-MM-01>,End=<today-UTC> \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE

aws ce get-cost-forecast --profile mikey-iam --region us-east-1 \
  --time-period Start=<today-UTC>,End=<next-month-YYYY-MM-01> \
  --metric UNBLENDED_COST --granularity DAILY \
  --prediction-interval-level 80
```

Report the Cost Explorer snapshot date, currency, estimated MTD amount and its
through-date, plus the returned **remaining-period** forecast mean and 80%
lower/upper bounds. Verify that the first and last returned daily periods cover
exactly the requested `Start`-inclusive, `End`-exclusive interval before doing
any arithmetic; reject or separately explain a response with expanded or
missing dates. Calculate the expected full-calendar-month mean and bounds by
adding completed-day MTD to the sums of the returned daily mean, lower, and
upper values. Do not use monthly granularity for this mid-month remainder:
Cost Explorer can return the whole calendar month even when the requested
start is mid-month, and adding MTD to that result would double-count. This
split deliberately forecasts the current UTC day instead of mixing its
incomplete actual into MTD. Label current-month actuals
when `Estimated` is true, and describe the result as a Cost Explorer expectation
rather than a final invoice because reporting lags and later credits, refunds,
taxes, or adjustments can change the bill. If either the forecast or MTD query
is unavailable, report the available component and say why a complete
full-month expectation is unavailable instead of extrapolating it locally. A
previous closed month may be quoted for context when the difference is
material, but it is not a replacement for the current-month expectation.
For the media watch, separately identify AWS Elemental MediaConvert and Amazon
Interactive Video Service rows when present. Also report Amazon S3 as shared
storage context, without attributing the whole S3 row to Lumine media.

Ten sections (Mikey's chosen cut 2026-08-10; behavioral-insight and
farm-signal sections added that day; AI Card summon watch added 2026-08-24):

- `economy` — `topGainers` (coin-ledger aggregation over the window: gained,
  spent, net, current balance per user, Zero/Ciel excluded) and `topBalances`
  (current top-ten holders, also excluding Zero/Ciel). This is where
  alt-account farming, sudden windfalls, and "someone got a million coins in a
  week" surface with real numbers instead of secondhand kid gossip;
  cross-check outliers against the
  economy-manipulation escalation category.
- `aiSpending` — a compact projection of the management AI-cost report:
  `summary`, top spending accounts, top risk groups. Unlike the other sections'
  exact `window.sinceTs`, this existing report is bucketed into whole UTC days;
  `aiSpending.startDayIndex` and `endDayIndex` are its canonical bounds. The
  report period can begin up to one day before or after the exact brief window,
  so use those bounds when describing it. `generatedAt` is the report
  snapshot time. **`endDayInProgress: true` means the trailing bucket was the
  current UTC day at that snapshot and was still filling** — a daily run reads
  it mid-day, before the after-school peak, so never report that bucket as a full day's
  spend. `aiSpending.byDay` contains the canonical daily rows. For a truthful
  daily figure, widen the window (`--days 2..7`), exclude the row whose
  `dayIndex` equals the in-progress `endDayIndex`, and quote complete days
  ("$X so far today; complete days run ~$Y/day"). Real
  incident: a run report quoted a ~15%-complete day bucket ($5) as the site's
  daily AI spend (complete days were running ~$40-50). Flag accounts that jumped tiers or
  dominate that report period. Routine `topAccounts` rows identify the account
  by user ID/username and expose only an `identitySummary` count/manual-bucket
  flag; raw identity strings and verified email addresses are deliberately
  omitted. Use reason-required `identity inspect`, with
  `--include-private-evidence` only when Mikey's concrete decision needs the
  addresses or DOB values. May be `{ unavailable: true }` if the cost
  report fails; say so rather than guessing. This section is also the run's
  AI-cost exploit watch: while reading it, actively look for the signatures the
  brief actually exposes — one risk group spanning several user IDs, repeated
  account groups in `farmSignals.inboxFamilies`, or heavy spend by
  accounts that `economy.topGainers` or `notableCandidates` independently marks
  as recent signups. Cross-check those signals against the escalation
  categories. Missing join-date or community data is unknown, not evidence that
  an account is young or empty. A run that reads the spending report without
  asking "could any of this be one person with many accounts?" has skipped a
  duty.
- `aiCardSummoning` — the standing multi-alt Summoner watch for every website-
  management run. It counts the authoritative `ai_card_summons` daily quota counters
  over the whole-day `dayWindow`, so Mystery Cards and successful fallback
  cards are included, then lists the most active summoning accounts. It groups
  summons when the same exact-device hash was observed for more than one
  summoning user within the bounded `deviceEvidenceLookbackDays`; that evidence
  is correlated with the account/window, not asserted to be the device used for
  every individual summon. Each group reports its maximum same-day account and
  charged-summon totals, the multi-account days, and days above the shared
  three-card limit. Review every `requiresIdentityInspection` group,
  prioritizing `daysAboveSharedLimit > 0`, with reason-required
  `identity inspect`. If
  `riskGroupsTruncated` is true, report that the bounded watch has more groups
  than it returned rather than calling the review exhaustive. Add only
  operator-confirmed exact accounts to an unbanned quota bucket with
  `ai-bucket accounts add`; never infer or auto-bucket a family from a device,
  IP prefix, user agent, shared inbox, or anomaly alone. After a bucket update,
  re-read its canonical members. This duty applies even when no group crossed
  three cards, because the new enforcement prevents already-bucketed siblings
  from producing an over-limit row.
- `notableCandidates` — kids (never bots, staff `userType`s, or users already
  on the Notable Users list) ranked by authored activity in the window, with
  `isNewUser` marking window-new signups. Use it to find the overlooked and
  rising users the editorial priorities exist for, and propose additions to
  Mikey's Notable Users list in the report. When Mikey approves additions,
  execute them with
  `lumine admin notable add <userId|username> --note "<specific rationale>"`
  (idempotent —
  an existing member returns `already_done`; run-independent, privately audited
  as `notable.add`, and writes through the management page's own canonical
  service). It can therefore record Mikey's approval after the daily run has
  closed without opening another delegated run. Without his approval the run
  only proposes.
  **Always pass `--note`** with a concrete one-or-two-sentence record of what
  made them notable — real numbers and specifics from the brief window, not
  "active user". It lands in the management page's reason column, which is
  where Mikey later reads why a name is on his list. On an already-listed
  user, `--note` updates the stored reason (status `success` with
  `data.reasonUpdated: true`; an identical note stays `already_done` without
  rewriting its timestamp).
- `teachers` — the mentor/sage achievement holders (the accounts the website
  titles teacher/headteacher): real classroom teachers, NOT the
  `userType='supermod'` Korean operations staff, whose work-only usage is
  expected and deliberately excluded. Mikey's standing question here: which
  teachers genuinely use the website for themselves and which only work
  through it. Recommendations and rewards are classroom "work" verbs and
  count for nothing toward interest; genuine personal interest is measured by
  what a teacher does for themselves — authored subjects/comments,
  `reflections` (Daily Reflections answered), `dailyTasksCompleted`,
  `wordlePlays`, `buildsTouched` (Lumine builds they own that changed in the
  window), `aiStories`, and bounded `xpEvents` (XP-ledger activity). Shape:
  `genuinelyInterested` (interestScore > 0, ordered by it, each row carrying
  all the per-window counters plus `rank: mentor|sage` and `workScore`),
  `workOnly` (classroom verbs only, zero personal signals), `activeButSilent`
  (window-active log-ins with nothing at all, capped at 40), and `totals`.
  Daily-task counts use canonical whole-day indices and can begin up to one
  calendar day before the exact `window.sinceTs`.
  Report the contrast between the buckets, and treat `genuinelyInterested` as
  notable-users-but-for-teachers.
- `engagementPulse` — distinct users per surface (activeUsers, subjects,
  comments, recommendations, wordle, reflections, dailyTasks, aiChat,
  lumineBuildChat, buildsEdited, buildsPlayed) for the current window vs the
  equal-length previous window, each as `{ current, previous, delta }`.
  Presence, build edits, and build plays come from durable action/version/view
  events, not mutable `lastActive`/`updatedAt` snapshots. Zero/Ciel are excluded
  from authored surfaces. Wordle, daily tasks, and AI chat use the equal
  calendar-bucket ranges in `dayWindow`; those can begin before the exact
  timestamp window but always compare the same number of days. This is the
  "where do users actually live, and is it shifting?" section: report only the
  deltas that mean something, and read a surface's absolute size before
  dramatizing a small delta.
- `launchMetrics` — readouts for recently shipped features so nothing ships
  unmeasured. v1 carries `firstBuildRescue` (offers recorded and redemptions
  in the window, each `{ total, byEventType }`, plus first-Lumine-exchange
  claims) and `wordleSkipShield` (`startDayIndex`, `active`, judged dodges,
  and skip covers split `earned` vs `fromRescue`). Wordle metrics cover only
  completed, actually judged days in `judgedWindow`; today's in-progress game
  is never called a dodge. Offers without redemptions are a reason to inspect
  sample size, event type, and offer age — not proof of a broken funnel by
  themselves.
- `goneQuiet` — the inverse of `notableCandidates`: users whose `lastActive`
  fell in the 14 days before the window (so they were around, then stopped),
  ranked by how regular they were in the prior 30 days (daily tasks and
  Wordle), capped at 15 with `daysQuiet`. Use it for product signal (what did
  they stop doing?) and gentle outreach candidates; never guilt a child in
  public about absence.
- `newUserFunnel` — signups in the window with `activeOnDayOne` (any
  XP-ledger event within 24h of joining) and `returnedAfterDayOne`
  (`lastActive` beyond their first day), plus the newest few accounts.
  Deliberately coarse: it is an onboarding health check, not per-child
  session tracking.
- `farmSignals` — AI-cost farm signatures derivable with ZERO new data
  collection: `inboxFamilies` (account groups formed from verified emails of
  accounts active in the last `inboxFamilyActivityDays`, with only
  Gmail/googlemail's documented
  plus-tag and dot aliases collapsed, flagging inboxes behind 3+ accounts) and
  `youngAccountAiUsage` (accounts under 30 days old drawing battery in the
  whole-day `aiUsageDayWindow`). The raw canonical inbox is never returned in
  the routine brief. SIGNAL ONLY: siblings legitimately share a parent inbox,
  so an inbox family is a reason to look, never proof or grounds
  for action. Feed real suspicions to the AI-cost escalation category. Shared
  AI device/IP risk evidence is already in `aiSpending.topRiskGroups`; do not
  guess it from inbox similarity.

The command needs only an active run's `content:read` scope and mutates
nothing; reading the brief is not audited content action. Window boundaries
on the big append-only ledgers are found by binary-searching the PRIMARY key
(several tables have no timeStamp index), avoiding lifetime scans; aggregation
is still bounded to the selected 1–30 day window. The optional sections run
serially around the existing core report so this low-frequency command cannot
occupy the production reader pool; one unavailable section does not suppress
the others.

```ts
type InsightUnavailable = { unavailable: true; error: string };
type WindowDelta = { current: number; previous: number; delta: number };

type TeacherInsight = {
  userId: number;
  username: string | null;
  rank: "mentor" | "sage";
  lastActive: number | null;
  daysSinceActive: number | null;
  subjectsPosted: number;
  commentsPosted: number;
  reflections: number;
  dailyTasksCompleted: number;
  wordlePlays: number;
  buildsTouched: number;
  aiStories: number;
  xpEvents: number;
  recommendationsGiven: number;
  rewardsGiven: number;
  rewardTwinklesGiven: number;
  interestScore: number;
  workScore: number;
};

type InsightsBrief = Success<{
  window: {
    sinceTs: number;
    days: number;
    source: "requested" | "since-last-completed-run" | "default";
    generatedAt: number;
  };
  economy: {
    topGainers: Array<{
      userId: number;
      username: string | null;
      userType: string | null;
      gained: number;
      spent: number;
      net: number;
      currentCoins: number;
      joinedAt: number | null;
    }>;
    topBalances: Array<{
      userId: number;
      username: string | null;
      userType: string | null;
      coins: number;
    }>;
  };
  notableCandidates: Array<{
    userId: number;
    username: string | null;
    subjectsPosted: number;
    commentsPosted: number;
    activityScore: number;
    joinedAt: number | null;
    isNewUser: boolean;
    lastActive: number | null;
  }>;
  teachers: {
    genuinelyInterested: TeacherInsight[];
    workOnly: TeacherInsight[];
    activeButSilent: TeacherInsight[];
    totals: {
      total: number;
      activeInWindow: number;
      interestedInWindow: number;
    };
  };
  aiSpending:
    | {
        days: number;
        startDayIndex: number;
        endDayIndex: number;
        generatedAt: number;
        endDayInProgress: boolean;
        summary: unknown;
        byDay: unknown[];
        topAccounts: Array<{
          userId: number;
          username: string;
          eventCount: number;
          requestCount: number;
          estimatedCostUsd: number;
          inputTokens: number;
          cachedInputTokens: number;
          cacheEligibleInputTokens: number;
          outputTokens: number;
          totalTokens: number;
          imageCount: number;
          audioSeconds: number;
          energyUnits: number;
          energyChargedUnits: number;
          energyOverflowUnits: number;
          coinCharged: number;
          identitySummary: {
            observedIdentityCount: number;
            manualBucketObserved: boolean;
          };
        }>;
        topRiskGroups: unknown[];
      }
    | InsightUnavailable;
  aiCardSummoning:
    | {
        dayWindow: { startDayIndex: number; endDayIndex: number };
        deviceEvidenceLookbackDays: number;
        sharedDailyLimit: number;
        summonsCharged: number;
        summoningAccounts: number;
        riskGroupsTruncated: boolean;
        topAccounts: Array<{
          userId: number;
          username: string | null;
          joinedAt: number | null;
          summonsCharged: number;
          activeDays: number;
          lastSummonDayIndex: number | null;
        }>;
        multiAccountRiskGroups: Array<{
          riskKeyType: string;
          riskKeyHash: string;
          accountCount: number;
          summonsChargedOnMultiAccountDays: number;
          multiAccountDays: number;
          maxDailySummons: number;
          maxDailyAccounts: number;
          daysAboveSharedLimit: number;
          requiresIdentityInspection: true;
          dailyActivity: Array<{
            dayIndex: number;
            accountCount: number;
            summonsCharged: number;
          }>;
          accounts: Array<{
            userId: number;
            username: string | null;
            joinedAt: number | null;
            summonsCharged: number;
            activeDays: number;
            lastSummonDayIndex: number | null;
          }>;
        }>;
        notes: string;
      }
    | InsightUnavailable;
  engagementPulse:
    | {
        windowDays: number;
        dayWindow: {
          currentStartDayIndex: number;
          currentEndDayIndex: number;
          previousStartDayIndex: number;
          previousEndDayIndex: number;
          dayCount: number;
        };
        surfaces: {
          activeUsers: WindowDelta;
          subjects: WindowDelta;
          comments: WindowDelta;
          recommendations: WindowDelta;
          wordle: WindowDelta;
          reflections: WindowDelta;
          dailyTasks: WindowDelta;
          aiChat: WindowDelta;
          lumineBuildChat: WindowDelta;
          buildsEdited: WindowDelta;
          buildsPlayed: WindowDelta;
        };
      }
    | InsightUnavailable;
  launchMetrics:
    | {
        firstBuildRescue: {
          offersRecorded: {
            total: number;
            byEventType: Record<string, number>;
          };
          redemptions: {
            total: number;
            byEventType: Record<string, number>;
          };
          firstLumineExchangeClaims: number;
        };
        wordleSkipShield: {
          startDayIndex: number;
          active: boolean;
          judgedWindow: {
            startDayIndex: number;
            endDayIndex: number;
          } | null;
          judgedDodges: number;
          skipCovers: { earned: number; fromRescue: number };
        };
      }
    | InsightUnavailable;
  goneQuiet:
    | {
        users: Array<{
          userId: number;
          username: string | null;
          lastActive: number | null;
          daysQuiet: number | null;
          dailyTasksPrior30d: number;
          wordlePlaysPrior30d: number;
          regularityScore: number;
        }>;
        totals: { wentQuiet: number; previouslyRegular: number };
      }
    | InsightUnavailable;
  newUserFunnel:
    | {
        totals: {
          signups: number;
          activeOnDayOne: number;
          returnedAfterDayOne: number;
        };
        newest: Array<{
          userId: number;
          username: string | null;
          joinedAt: number | null;
          activeOnDayOne: boolean;
          returnedAfterDayOne: boolean;
        }>;
      }
    | InsightUnavailable;
  farmSignals:
    | {
        inboxFamilyActivityDays: number;
        inboxFamilies: Array<{
          accounts: Array<{
            userId: number;
            username: string | null;
            joinedAt: number | null;
            lastActive: number | null;
          }>;
          accountCount: number;
          youngAccounts: number;
        }>;
        aiUsageDayWindow: {
          startDayIndex: number;
          endDayIndex: number;
        };
        youngAccountAiUsage: Array<{
          userId: number;
          username: string | null;
          joinedAt: number | null;
          energyUnits: number;
          replies: number;
        }>;
        notes: string;
      }
    | InsightUnavailable;
}>;
```

**Editing the bot's own comments.** `comment edit <commentId> --file
<comment.md>` replaces the text of a comment the ACTING bot itself authored —
for correcting a factual error, an unfulfillable claim, or outdated guidance
in Zero/Ciel's own words. It is deliberately not a moderation verb: comments
by the other bot, by any human, and hidden notification records are all
rejected (`CLI_ADMIN_EDIT_NOT_OWN_COMMENT`,
`CLI_ADMIN_EDIT_NOTIFICATION_COMMENT`). The replacement text follows the
composed-comment rules (plain UTF-8, 10,000-character limit, truth about what
the session actually did) and publishes through the website's canonical
comment-edit pipeline — mentions are reprocessed (a newly added `@mikey`
notifies him), and Earn-candidate projections resync. Submitting identical
text returns `already_done`. Requires the `comment:post` scope of a
comment-mode `post` run, and is audited as `comment.edit` with the previous
content in `beforeState` and `data.edit.previousContent`. Edit sparingly:
kids may have already read the original, so a comment that changed meaning
(not just wording) usually deserves a follow-up reply instead of a silent
rewrite.

## Direct bot chat messages

```bash
lumine admin chat send <userId|username> --file message.md --json
```

The run's selected bot sends one composed direct chat message into an
**existing** two-person channel between that bot and the target member. Built
for private repair: when a bot said something harmful in chat, a public
comment cannot fix it — the apology (or follow-up care) belongs in the same
channel where the harm happened, and the sent message becomes part of the
channel history that future AI responses condition on, repairing the context
itself. Mechanics:

- requires the `chat:post` scope, granted only to comment-mode `post` runs;
- composed-only (`--file`, plain UTF-8, 10,000-character limit): the agent
  writes the message in the bot's persona; no model runs, no AI Energy;
- existing DM channels only — the pipeline never opens a new chat with a
  member who never talked to the bot (`CLI_ADMIN_NO_DM_CHANNEL`);
- delivery is canonical: the ordinary message insert (channel lock,
  visibility restore) plus the normal `new_chat_message` relay, so the
  member's chat updates live with a real unread state; no bot socket,
  session, or presence is touched. Only the bot's own read pointer moves;
- audited as `chat.message` with the composed text, and idempotent per
  request key like every mutation.

Restraint rules: a bot-initiated DM is the platform speaking privately to a
child — use it for repair and care, never for promotion, nudges, or
engagement. Incident remedies (an apology for a harmful bot message) are
sent on Mikey's direction with text he has seen, and must be exactly
specific about what the bot got wrong — a real apology names the failure
(the invented premise, the order it had no right to give, the guilt it
shifted onto the child), not a vague "sorry if that came out wrong."
Ordinary warm follow-ups (checking on a member the bots already know after
something the run surfaced) are within a run's judgment, sparingly, and are
always reported in the run report.

## Official announcements

```bash
lumine admin announcement post --file announcement.md --json
```

The run's selected bot posts one composed message to General's announcement
subchannel (`channelId` 2, `subchannelId` 2). This is the public official
board, not a DM and not a Home comment. Mechanics:

- requires the `chat:post` scope of a comment-mode `post` run;
- composed-only (`--file`, same 10,000-character limit as `chat send`);
- authors as Zero or Ciel only — the ordinary chat post route and the
  announcement socket relay now treat those two IDs as allowed announcement
  authors, same as management-level 3 humans;
- persists through the ordinary `msg_chats` insert (channel lock +
  visibility restore), writes the Twinkle Newspaper `announcement:<messageId>`
  event, and relays `new_chat_message` on General. No bot socket, session, or
  presence;
- audited as `announcement.post` and idempotent per request key.

Use this only when Mikey asks for an official announcement. Do not treat a
management run as a standing license to post there.

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
lumine admin daily-run start --identity ciel --comment-mode post \
  --run-key daily:2026-08-06:comments --json

# Default: the agent composes the comment in the bot's persona itself.
lumine admin comment draft 123 --file comment.md --json
lumine admin comment draft dailyReflection:99 --file comment.md --json
lumine admin comment reply comment:456 --file reply.md --json

# Fallback (only when Mikey asks for it): server-generated persona drafts.
lumine admin comment draft 123 --identity ciel \
  --idempotency-key comment-123-draft-v1 --json
lumine admin comment reply comment:456 --json

lumine admin comment post --draft-id 77 \
  --idempotency-key comment-123-post-v1 --json

# Correct the acting bot's OWN published comment.
lumine admin comment edit 342752 --file corrected.md --json
```

**Compose in persona by default (Mikey's standing direction, 2026-08-10).**
A delegated agent writing Zero/Ciel comments should assume the bot's persona
and write the comment text itself, submitting it with `--file` — exactly like
the newspaper's claim/submit path, this spends no provider credits and no AI
Energy (server-generated drafts bill the **operator's own** AI Energy
battery). Use the no-`--file` server-generated path only when Mikey
explicitly asks for it. Before composing, read the canonical persona sources
so the voice and judgment match the real bots — do not improvise the persona
from memory:

- `twinkle-api/constants/index.ts` — `SYS_PROMPT_FOR_CIEL` /
  `SYS_PROMPT_FOR_ZERO` (the exact persona system prompts) and
  `TWINKLE_FEATURES_EXPLANATION` (what the bots know about the site);
- `twinkle-api/helpers/ai/comment-assistant/index.ts` —
  `ADMIN_COMMENT_DECISION_POLICY` / `ADMIN_REPLY_DECISION_POLICY` (the
  draft-vs-skip judgment rules, which still govern composed comments: skip
  decisions are yours to make and record with `post skip` or in the run
  report).

**Lumine Build apps and app posts are composed-only, and only after actually looking
(Mikey's direction, 2026-08-10).** When a post is about a Build app — the
author shares their app, announces an update, or asks for feedback on their
build — never use the server-generated draft path: the API persona cannot
open an app, so its drafts either stay generic or fabricate first-hand
experience (a real Ciel draft claimed "I clicked over to check it out" on an
app nobody had opened). The day's management agent comments instead, and
looks first: pull the project with lumine-cli when it is open source (or
yours to pull) and read the code, or open the app and actually try it; then
compose a comment whose specifics come from what you genuinely saw — a
mechanic you liked, a nice touch in their code, a concrete suggestion. Be
truthful about what you did: "I read through your code" and "I played a few
rounds" are different claims, and a comment must only make the one that
happened. If you could not access the app at all, say nothing about having
tried it — ask the author about it instead. This is the standing rule for
every composed comment, applied to apps: never claim an experience the
session did not actually have.

The same rule covers comments placed **directly on a Build app**. This is
deliberately management-agent-only: no server-generated draft and no pure API
persona may author one. After reviewing the project, bind the composed comment
to the exact published artifact you saw:

```bash
lumine admin comment draft build:884 --file comment.md \
  --reviewed-version 4512 --reviewed-via runtime \
  --review-context context.json --json
lumine admin comment post --draft-id 77 --json
```

```json
{
  "understanding": "The start screen pairs a green zombie with a sci-fi soldier, and the first interaction teaches the player to select a zombie before firing the railgun."
}
```

Use `--reviewed-via code` only when you actually pulled and read the project;
`runtime` means you opened and tried the published app. Replies to human
comments inside a Build use `comment:<id>` plus the same review flags. The API
rejects missing review evidence, a server-generated Build draft, a mismatched
published version, a private/noncanonical Build, or any Build/comment-context
change between draft and publication. A changed version means review the new
project state and compose again. The flags are an auditable statement of what
the management agent did, not permission to infer experience from metadata.
The review-context JSON is private server-owned conversation provenance; it is
not included in the public comment, draft response, socket payload, or audit
metadata. A direct human reply to the resulting Zero/Ciel management comment,
or to a later reply by that same bot descended from it, may enter the ordinary
comment-assistant pipeline using this stored historical understanding. It uses
the human commenter's normal AI Energy and reply-or-Like gate. If that user has
no remaining AI Energy, the normal sponsor placeholder/button is shown and a
sponsor pays from their own battery. Mentions elsewhere in a Build, replies to
unlinked or legacy bot comments, replies to humans, and the other bot remain
ineligible. If the published version has changed, the responder is told the
stored understanding belongs to the reviewed older version and must say it has
not checked behavior that could have changed. The generic `comment edit`
shortcut is also disabled there; review the current version and post a
version-bound correction reply instead.

**Offer a Lumine prompt when the moment invites it (Mikey's direction,
2026-08-10).** Zero and Ciel may include one concrete, copy-pasteable Lumine
prompt in a comment or reply — a genuinely powerful one, tailored to what the
kid is already doing — when the occasion naturally calls for it. Appropriate
occasions: a kid describes an idea they wish existed, asks how something on
the site was made, hits the edge of what a post/drawing/story can do, shares
a Build app that could grow a specific feature, or shows an interest (space,
cats, chess, comics) that maps cleanly onto something Lumine could build with
them. On those occasions, the prompt IS the helpful answer: quote it so it
can be copied as-is, keep it specific to their interest, and mention it works
in the Build workspace chat. Restraint rules: never more than one prompt per
comment; never in condolence, conflict, wellbeing, or moderation-adjacent
threads; never as a reflex closing line on ordinary comments — if the comment
is complete without the prompt, post it without the prompt. A run where only
a few comments carry a prompt is healthy; a run where most do is shameless
plugging, which is exactly what Mikey asked to avoid. SDK-aware prompt ideas
are especially good ("ask Lumine to make a magazine that pulls real Twinkle
posts with Twinkle.subjects.search") because kids do not know the content
APIs exist — but only suggest SDK capabilities that actually exist; check
TWINKLE_BUILD_SDK.md if unsure.

A composed draft (`--file`, plain UTF-8 text, at most the website's 10,000
character comment limit) flows through the identical draft lifecycle —
reservation, idempotency, context-revision CAS, publish fencing, audit
(`metadata.composed: true`) — and is published with the same
`comment post --draft-id`. It never invokes the server's model and records
no AI Energy usage. Deployment guard: an API deployed before this capability
silently ignores `content` and generates with the server's model instead. The
CLI therefore requires the ready draft response to echo the exact submitted
text with `reason: "operator-composed"`; otherwise it stops with
`LUMINE_ADMIN_COMPOSED_COMMENT_UNSUPPORTED`. Never publish that rejected draft.
For Build drafts it additionally requires
`buildReviewContextStored: true`; an older API that ignores the private context
fails closed with `LUMINE_ADMIN_BUILD_REVIEW_CONTEXT_UNSUPPORTED`. Deploy the
context-aware API, then retry with a new idempotency key rather than publishing
the unconfirmed draft.
Placement stays on the requested target: compose replies via `comment:<id>`
targets (the generated path's model-chosen
`replyTargetCommentId` does not apply). Everything below about targets,
containers, and publication applies to both kinds of draft.

A draft targets one of:

- `subject:<id>` (or a bare numeric ID) — a top-level comment on the subject;
- `build:<id>` — a top-level comment on a public canonical Build, composed
  after reviewing its exact published version;
- `aiStory:<id>` / `dailyReflection:<id>` — a top-level comment on the
  standalone post;
- `comment:<id>` — a public reply to that specific comment. `comment reply`
  is the same operation and requires a comment target.

A reply's container resolves canonically from the target comment: its subject,
Build, or AI Story / Daily Reflection root. Comments under any other root are
rejected with `CLI_ADMIN_UNSUPPORTED_REPLY_ROOT`. Build replies authored by the
management agent require the same exact-version review evidence and private
review context as top-level Build comments. Replies to
Zero/Ciel comments and to notification comments are rejected with
`CLI_ADMIN_INVALID_REPLY_TARGET` — the bots never thread with themselves or
each other through the delegated CLI. A human's later direct reply to a
context-backed Build management comment may enter the energy-gated autonomous
pipeline described above; ordinary human replies elsewhere follow the existing
comment-assistant rules. Published replies carry the ordinary thread linkage
(thread root and reply-to), and notification fan-out uses the normal canonical
path.

```ts
type CommentDraft = Success<{
  draft: {
    id: number;
    runId: number;
    targetType: "subject" | "comment" | "build" | "aiStory" | "dailyReflection";
    targetId: number;
    targetUrl: string;
    subjectId: number | null; // container subject; null for standalone posts
    subjectUrl: string | null;
    publicActorUserId: number;
    commentMode: "draft" | "post";
    personaRevision: string; // SHA-256; raw prompt is never returned
    contextRevision: string; // SHA-256 of canonical container/comments/target
    buildReviewContextStored: boolean; // true before a Build draft may publish
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
      targetType:
        "subject" | "comment" | "build" | "aiStory" | "dailyReflection";
      targetId: number;
      subjectId: number | null;
      subjectUrl: string | null;
      containerUrl: string;
      commentUrl: string;
    };
  };
};
```

For Subjects and standalone posts, the server loads the canonical container
and its complete visible comment context, then invokes the existing exact
Zero/Ciel system prompt through the shared response assembler with a
mode-specific decision policy (comment vs reply). The raw prompt is never
returned or audited. The model—not regexes or keyword rules—chooses `draft`
or `skip` under the run policy. Build comments never enter that generated
path; they require management-agent-composed content and review evidence.

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

Apply `twinkle-api/scripts/migrations/add-lumine-admin-delegation.sql`, then
`add-lumine-admin-comment-targets.sql`, and apply
`add-lumine-admin-todos.sql` before deploying an API that exposes carry-over
todos. They add
only focused daily-run, rotation, draft, audit, and private-todo tables/columns
and indexes;
there are no runtime schema checks. The comment-targets migration backfills
existing subject drafts into the generalized target columns. The local CLI changes
are not available to users until a separately authorized npm publication.

Legacy aliases such as `subjects list`, `subjects get`, `subjects featured`,
`comments get`, and `recommend` remain accepted, but the singular command forms
shown above are the canonical interface.
