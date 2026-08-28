# Lumine CLI

Launch Twinkle Lumine builds from any terminal.

```bash
npx @stage5/lumine@latest
npx @stage5/lumine@latest login
npx @stage5/lumine@latest new "Daily Reflection App"
npx @stage5/lumine@latest new --title "Daily Reflection App" --description "Private journal with streaks"
npx @stage5/lumine@latest rename "My New Build Title"
npx @stage5/lumine@latest rename "New Title" --target 123
npx @stage5/lumine@latest describe "A welcoming place to build together"
npx @stage5/lumine@latest describe --no-description --target 123
npx @stage5/lumine@latest upgrade https://www.twin-kle.com/app/123
npx @stage5/lumine@latest projects
npx @stage5/lumine@latest branches 884
npx @stage5/lumine@latest forum 884 --json
npx @stage5/lumine@latest forum listen 884 --json
npx @stage5/lumine@latest suggestions 884
npx @stage5/lumine@latest explore --sort forks
npx @stage5/lumine@latest reference https://www.twin-kle.com/app/123
npx @stage5/lumine@latest fork https://www.twin-kle.com/app/123
npx @stage5/lumine@latest pull
npx @stage5/lumine@latest save
npx @stage5/lumine@latest save --publish
npx @stage5/lumine@latest launch https://www.twin-kle.com/app/123
```

Run `lumine` with no subcommand for the easiest flow: sign in when needed,
choose one of your owned or team projects, and pull the saved project files into
a local folder.

Use `lumine new` to create a new Twinkle Build with the same website create
route used by Build Studio. The CLI asks for a title when one is not passed and
asks for an optional description. It creates the Build and pulls an editable
local workspace, but it does not auto-start a Lumine greeting or prompt run, so
creating a project from the CLI does not spend AI battery. Add project files
locally, including `/index.html`, then run `lumine save`.

Use `lumine rename` to change an existing Build title and `lumine describe` to
change its description through the same canonical metadata route as the
website. Both commands target the current workspace or selected Build; pass
`--target <build-url-or-id>` to update another Build you own. Run
`lumine describe --no-description` to clear a description explicitly.

The configured project-limit reviewer can run
`lumine upgrade <build-url-or-id>` to grant Main—and therefore every branch—the
full approved project room of 500 files and 5 MB. The server verifies reviewer
authority, resolves branch URLs back to their canonical Main project, and
returns the confirmed canonical limits after commit. Running the command again
is a safe no-op that reports the already-active canonical limits. Omit the
target to use the current workspace or selected project.

For team projects, Lumine mirrors the website workspace flow: choosing or
pulling the owner's main project creates or reuses your contribution branch and
checks out that branch locally. Saves go to your branch, so the project owner
can merge or replace main from Twinkle.

Use `lumine branches <build-url-or-id>` to list the contribution branches you
can review, including each contributor, branch number, status, and URL. Then use
`lumine diff <branch-url>` to inspect one branch.

Use `lumine forum [build-url-or-id]` to read the complete canonical Team Forum
history visible to the current workspace. A project owner reading Main receives
Main plus every branch's posts and replies. A branch contributor receives that
branch plus every project-owner post and reply on Main, including older Main
threads that were not separately broadcast. `--json` returns one complete
snapshot. `lumine forum listen --json` then polls from the last server-confirmed
sequence and emits newline-delimited update batches without advancing through a
partial or failed read. Pass `--cursor <sequence>` only when intentionally
resuming a previously confirmed cursor; the default starts at the beginning.

Branch contributors can nudge the project owner from their pulled branch with
`lumine suggest branch [message]` or `lumine suggest thumbnail`. The thumbnail
command offers the thumbnail currently saved on that branch. Project owners can
run `lumine suggestions <build-url-or-id>` to see their open suggestion inbox.
The inbox prints canonical follow-up commands for merging or replacing Main and
for applying the exact frozen thumbnail shown in a suggestion. The same actions
are also available directly as `lumine suggestions merge <id>`,
`lumine suggestions replace-main <id>`, and
`lumine suggestions adopt-thumbnail <id>`. Large inboxes are cursor-paginated;
the CLI prints the exact `--cursor` command for the next page.

Use `lumine explore` to list public open-source Build apps that can be used as
examples or starting points. It supports `--search` and `--sort forks`,
`--sort popular`, or `--sort recent`. Use `lumine reference <build-url-or-id>`
to pull source files into a read-only reference folder, or
`lumine fork <build-url-or-id>` to create your own editable fork and pull it
locally.

After editing pulled files, run `lumine save` from that folder. Workspaces record
a `filesHash` in `.twinkle/lumine-project.json` when you pull or save; the next
save sends that hash so the server can reject a stale checkout instead of
silently overwriting newer files. Saves from a folder with no `filesHash` are
refused unless you pass `--force` (intentional overwrite). Prefer
`lumine pull` to resync before saving if the folder might be out of date.

The CLI saves
through Twinkle's normal workspace project-file route, creates a project artifact
version, records the same save metadata, and marks public builds as having
unpublished changes. For projects you own, run `lumine launch` to publish the
saved changes, or `lumine save --publish` to save and publish in one step.

Pulled workspaces include `AGENTS.md` and `CLAUDE.md` guides for local coding
agents, `TWINKLE_BUILD_SDK.md` with the current Build SDK reference, plus
`.twinkle/lumine-project.json` metadata that tells agents whether the checkout
is writable, publishable, or a contribution branch. These guide files are not
uploaded by `lumine save`. Build apps run in sandboxed iframes without native
form submission, so use JavaScript-handled inputs and buttons instead of
`<form>` elements.

Reference folders are marked `readOnly` in `.twinkle/lumine-project.json`.
Running `lumine save` from a reference folder is blocked; fork the source Build
first if you want an editable workspace.

## Using a published app over MCP

`lumine app-mcp <published-app-url-or-id>` turns an opted-in published Build
app into a standard stdio MCP server. Lumine pins the current published
artifact, reads its `/app-tools.json` manifest, and opens a dedicated signed-in
app tab. Tool calls run serially in that visible iframe through handlers the app
registered with `Twinkle.appTools.register({ handlers })`, so the agent and
viewer operate the same live UI and state. Keep that tab open while the MCP
client is connected. Pass `--no-open` only when you will open the URL printed on
stderr yourself.

Discovery is static and fail-closed: runtime code cannot add tools that were
not declared in the pinned manifest, and a session refuses to connect if any
declared handler is missing.

## Inspecting Build SDK data

`lumine sdk call <namespace.method> '<jsonArgs>'` calls a build's data SDK
endpoint with your login and prints the response, so you can inspect real data
and measure latency while building. Run `lumine sdk list` to see callable
methods. The JSON args are sent as the request body (shapes follow
`TWINKLE_BUILD_SDK.md`).

```bash
lumine sdk call aiStories.chapters '{"limit": 5}'
lumine sdk call aiStories.list '{"difficulty": 1}' --repeat 5 --build 1374
lumine sdk call live.list '{}'
lumine sdk call live.get '{"sessionId": "..."}'
lumine sdk call live.listReplays '{"limit": 20}'
lumine sdk call live.getReplay '{"replayId": "..."}'
```

It targets the build in the current workspace, or pass `--build <id>`. Add
`--repeat <n>` for min/avg/max latency. Output is the raw endpoint response,
which can differ from a method's `Twinkle.*` SDK return shape — check
`TWINKLE_BUILD_SDK.md` for SDK return shapes. Methods that change data require
`--allow-write`.
Stopping a hosted stream is available as
`lumine sdk call live.stop '{"sessionId":"..."}' --allow-write`; the command
prints canonical server state and refuses to mint `live:write` without the
explicit write flag.
Replay listing and status are available without exposing private playback
grants. A creator or app owner can remove one with
`lumine sdk call live.deleteReplay '{"replayId":"..."}' --allow-write`.

## Assets and AI image generation

Binary media never lives in the workspace — assets are uploaded to Twinkle and
referenced from code by URL. `lumine assets upload <file...>` uploads images,
audio, and MIDI data (`.mid`/`.midi`; playback still needs an app-side parser
or synth); `lumine assets list` prints your uploads and refreshes
`.twinkle/assets.json`.

`lumine assets generate "<prompt>" --model <gpt-image-2|nano-banana>` creates
an AI-generated image asset instead of uploading one. `--model` is required
(gpt-image-2 = best quality, slower, pricier; nano-banana = Gemini, faster,
cheaper). Generation spends your Twinkle AI Battery, so the CLI shows the
estimated cost and asks for confirmation first — non-interactive runs must pass
`--yes` to consent. `--quality low|medium|high` applies to gpt-image-2 only.

## Thumbnails

`lumine thumbnail set <file>` uploads a jpg/png/webp (max 8MB) as the build's
thumbnail. `lumine thumbnail capture` screenshots the running app server-side
and sets the result (add `--out <file>` to keep a local copy).
`lumine thumbnail generate ["<prompt>"] --model <gpt-image-2|nano-banana>`
generates an AI image and sets it as the thumbnail (the image is also kept as a
normal reusable asset); without a prompt the server composes one from the build
title and description. Replacing an existing thumbnail asks for confirmation;
pass `--yes` for non-interactive runs. Thumbnail commands are blocked in
read-only `pull --main` checkouts.

The CLI checks npm for the latest `@stage5/lumine` version on normal commands.
If the installed copy is outdated, it prints an update warning and records the
version state in `.twinkle/lumine-project.json` so local agents can tell when
they should rerun with `npx @stage5/lumine@latest`. Use `--no-update-check` to
skip that advisory network check.

## Subscription agents through the Lumine loop

After pulling a project, a signed-in Codex or Claude Code subscription can
power Lumine's workspace loop without spending Twinkle AI Energy:

```bash
lumine agent --provider codex "Add keyboard controls"
lumine agent --provider claude-code "Fix the mobile layout"
```

The external model cannot write project files directly. Lumine supplies the
same core workspace prompt/tool contract, read-before-edit behavior, bounded
scope checks, and validation-repair passes used by the hosted Build agent. A save happens only
after validation passes and still uses the workspace's server-issued
`filesHash`, so a concurrent server change stops the run instead of being
overwritten. Provider login and model usage stay inside the selected local CLI;
Twinkle never receives a provider credential and does not reserve AI Energy.

Every run writes a sanitized observable tool trace under
`.twinkle/agent-runs/`. By default, the selected subscription agent reviews
that trace after the pass and records evidence-based loop feedback without
collecting hidden chain-of-thought; use `--no-review-loop` to skip that extra
provider turn. Provider support is adapter-based rather than Codex-specific.
Codex uses its local app-server protocol and Claude Code uses the same Lumine
tools over MCP. Both adapters disable inherited model-side project tooling and
launch with a credential-minimized environment, so project access remains at
the Lumine tool boundary.

You can still use a coding agent directly for a manual edit-and-save workflow:

```bash
codex "Read AGENTS.md, then make the requested change."
claude "Read CLAUDE.md, then make the requested change."
```

The login command uses a browser approval code and stores a scoped token and the
selected project at `~/.twinkle/lumine-cli-auth.json`.

## Sponsoring shared Zero and Ciel Build Workshop help

Sponsorship is an approved contribution role, not an open switch and not a
website-management role. Applications are submitted only through Lumine CLI;
the Twinkle website provides instructions, but no application form.

```bash
lumine sponsor agreement
lumine sponsor apply --providers codex --motivation "Why I want to help" \
  --availability "My usual duty window" --accept-agreement
lumine sponsor status
```

After Mikey approves an application, configure conservative limits based on
the subscription you are contributing. From the Codex or Claude Code session
that will personally monitor and perform the work, start one shared duty and
keep renewing its short watch:

```bash
lumine sponsor capacity --concurrency 1 --helpers 0 \
  --daily-limit 3 --weekly-limit 10
lumine sponsor duty start --provider codex \
  --model gpt-5.6-sol --effort max --service-tier priority
lumine sponsor duty watch --json
```

Sponsor commands use the same browser-approval login as the rest of Lumine.
When no saved CLI login exists, the command opens Twinkle, waits for the person
using that browser to approve their own account, and then resumes. Any Twinkle
account may authenticate this way, but login never grants sponsor duty:
`sponsor duty start` still requires that exact account to have a canonical,
server-approved sponsor profile.
When the sponsor agreement changes, an already-approved sponsor must read the
new version and explicitly renew it before opening duty:

```bash
lumine sponsor agreement
lumine sponsor agreement accept --accept-agreement
```

Each `duty watch` is deliberately bounded. The same agent session runs it again
to remain present. If that session stops checking in, its short server lease
expires and the Workshop no longer advertises it as available. A detached
heartbeat, supervisor, or provider-spawning daemon is not sponsor duty. The CLI
rejects a provider name that differs from the agent session actually running
the command.

When a user approves a plan, `duty watch` returns the scoped assignment file and
contribution workspace to that same session. It does not launch a fresh Codex
or Claude process. The on-duty agent uses this explicit lifecycle while it
works:

```bash
lumine sponsor job begin 42
lumine sponsor job pulse 42
lumine sponsor job relay-applied 42 101
lumine sponsor job complete 42 --summary "Implemented and tested the approved change"
```

`pulse` renews the duty/job leases and returns any newly approved follow-up.
Run it between substantial work steps. `relay-applied` is an explicit receipt;
completion is rejected until every delivered relay has actually been applied
and acknowledged. Use `helper-start` and `helper-complete` to record native
same-session subagents within the configured helper limit—the CLI records them
but never spawns a replacement provider. Use `job fail --reason` for a real
terminal failure, and `duty pause|resume|stop` to control admission.
If the provider reroutes the session after duty starts, report the actual
runtime on `helper-complete` or `job complete` with `--resolved-model`,
`--resolved-effort`, and (when applicable) `--resolved-service-tier`.

Both Zero and Ciel delegate to this shared capacity. The user chooses the
visible assistant for each request and may see the named sponsor and canonical
queue. With no live duty, the website stays in its ordinary chat state and
shows none of the Workshop UI.

Zero or Ciel remains the user-facing teammate. The on-duty agent session
receives only the initial relay and active-job Build follow-ups covered by the
user’s explicit Workshop consent, the assigned contribution branch, and its
scoped Build Forum—not the raw assistant chat. It cannot merge into Main,
publish, or use website-management APIs. Lumine records
the requested and provider-reported model, effort, service tier, runtime/usage
evidence, coordinator/helper tree, saved artifact, and branch notice. Every
completed handoff enters the daily integrity flow; probationary, hard-flagged,
and sampled work requires review. Each unique cleared contribution to another
user earns a flat 50 Karma Points, while self-sponsored testing, retries, and
helper agents do not earn or multiply the award.

## Privileged website administration

`lumine admin` reuses Mikey's saved CLI login while keeping the visible public
actor separate. The server reloads Mikey's current authority from the writer,
resolves Zero/Ciel by immutable IDs, and binds every operation to an expiring,
purpose-scoped daily run. Flags, usernames, token claims, and local state never
grant delegation. Delegated work does not create a bot login or presence
session, but its public content changes use Twinkle's normal real-time socket
events.

```bash
lumine admin identity list --json
lumine admin identity inspect Jay1216 \
  --reason "Confirm account family before a quota-bucket change" --json
lumine admin economy trace lock --days 3 \
  --reason "Investigate the anomalous coin gain" --json
lumine admin rescue wordle-audit --days 30 \
  --reason "Identify recorded Wordle breaks and rescue status" --json
lumine admin daily-run start --identity auto --comment-mode off --json
lumine admin sponsor applications list --status pending --json
lumine admin sponsor applications review 12 --decision approve \
  --note "Approved for probationary duty" --json
lumine admin sponsor integrity scan --json
lumine admin sponsor integrity cases --status open --json
lumine admin sponsor integrity get 34 --json
lumine admin sponsor integrity review 34 --decision clear --json
lumine admin todo list --json
lumine admin todo add --kind experiment --status in_progress \
  --title "Validate Zero/Ciel cost optimization" \
  --note "Complete only after old-vs-new response-quality parity." --json
lumine admin todo update 12 --status blocked \
  --note "Waiting for a complete cost bucket and parity replay." --json
lumine admin recommendations list --all --checkpoint recommendations.json --json
lumine admin recommendations list --after 2026-08-14T00:00:00Z --all --json
lumine admin recommendations list --include-legacy --all --json
lumine admin subjects candidates --after 2026-08-01T00:00:00Z --json
lumine admin subjects candidates --effort unassigned --json
lumine admin builds candidates --all --json
lumine admin builds review build:884 --output-dir ./build-review --json
lumine admin subject get 123 --include-comments --json
lumine admin post get https://www.twin-kle.com/ai-stories/88 --json
lumine admin post comments dailyReflection:99 --json
lumine admin subject comments 123 --cursor '<cursor>' --json
lumine admin subject reveal 123 --json
lumine admin subject effort set 123 --level 3 --json
lumine admin subject creator set-made-by-poster 123 --json
lumine admin featured list --json
lumine admin subject feature 123 --json
lumine admin subject unfeature 123 --json
lumine admin featured reorder --subject-ids 30,20,10 --json
lumine admin brief --days 3 --json
lumine admin notable add Minecrarft_guy --note "Created 8 thoughtful subjects and helped peers in 23 comments this window." --json
lumine admin post recommend comment:456 --anyone-can-reward --reward-twinkles 3 --json
lumine admin post reward comment:456 --twinkles 3 --json
lumine admin post skip-batch --target-file skipped.json --checkpoint skip-progress.json --json
lumine admin comment draft build:884 --file comment.md \
  --review-receipt /path/from-build-review/review.json \
  --review-context build-context.json --json
lumine admin comment post --draft-id 77 --json
lumine admin news claim --output claim.json --scaffold editorial.json --json
lumine admin news validate --claim claim.json --file editorial.json --json
lumine admin news submit --claim claim.json --file editorial.json --json
lumine admin daily-run escalation add --target subject:123 \
  --note "Concrete privacy issue requiring owner review" --json
lumine admin daily-run report --json
lumine admin daily-run complete --json
lumine admin escalation list --status all --json
lumine admin escalation set 123 --status resolved \
  --note "Final owner decision" --json
```

Numeric recommendation targets default to subjects. Use `comment:<id>`,
`aiStory:<id>`, `dailyReflection:<id>`, a canonical URL, or the matching
`--type` for another post kind. Commenting is always `off` for a new run unless
`--comment-mode draft` or `--comment-mode post` is explicitly supplied. Drafts
and posts use the selected bot's server-owned canonical persona. Outside Build
threads, a later human reply is handled by Twinkle's existing autonomous
Zero/Ciel responder without Lumine remaining active.

Management agents also inspect recent public Build candidates during each run.
`builds review` opens one published app in an isolated temporary Chromium
profile, captures a screenshot and console evidence, verifies that the
published version stayed fixed, and writes a review receipt in a unique output
subdirectory. A direct Build comment is never server-generated: review the
runtime (or pull and read an
open-source app), compose with `--file`, and attach the receipt. The server
rejects missing or stale review evidence and any app/thread change before
publication. Also pass `--review-context` with a private JSON file containing
only an `understanding` string: the concrete app behavior and design the agent
actually learned during that review. The server stamps the canonical Build,
published version, review method, and review time around that understanding;
none of it is exposed in the public comment payload. Manual
`--reviewed-version` / `--reviewed-via` evidence remains available for genuine
code reviews.

When a human directly replies to that management comment, or to a later
Zero/Ciel reply descended from it, the same bot may answer from the stored
historical understanding. That answer uses the commenter's normal AI Energy
path, including the usual reply-or-Like decision; if their battery is empty,
the ordinary sponsor placeholder and button are shown. Build mentions and
replies without this private management provenance remain disabled. A newer
published Build version does not rewrite history: the bot is told that its
understanding came from the older reviewed version and must not claim it
rechecked the app.

Every operation is noninteractive when its required arguments are present.
`--json` prints exactly one uncolored JSON value and returns a nonzero status
for forbidden, not-found, validation, and partial-failure responses. Pass a
stable `--idempotency-key` when retrying one mutation across processes; the
server also enforces canonical no-duplicate invariants. Failed mutation JSON
includes `error.details.retryIdempotencyKey` so a partial attempt can be
resumed with the exact generated key.

Subject and queue listings use opaque, stable snapshot cursors. `--all`
follows them automatically, fsyncs each confirmed page to a private NDJSON
candidate spool, saves only bounded cursor/boundary/count metadata in the
checkpoint, and records completed queue coverage in the run audit; `--resume`
verifies the confirmed spool prefix and continues the exact same request. The
final JSON contract still contains the complete collection, streamed from the
spool instead of accumulated in memory. With `--all --json`, bounded progress
goes to stderr so stdout remains one pipe-safe JSON value. Recommendation scans default to the previous completed
run's start boundary for at-least-once coverage. Use `--after` for an explicit
timestamp or `--include-legacy`
for an intentional all-history scan. Subject `--after` is inclusive and
cursors are bound to the original date and effort filters.

`news claim` can write both the canonical leased digest and an editable
editorial scaffold. `news validate` is local and checks every citation and
quote before submission; `news submit --claim` reads the lease identity from
the claim file. Every `daily-run start` response includes writer-confirmed
unfinished private todos, with once-per-run surfacing telemetry, so an agent
can resume earlier work without relying on conversation memory. Record progress
with `todo update`; completing a run does not complete its todos. Experiments
must meet their stated acceptance criteria—lower AI cost with weaker user
responses is not a successful optimization. `daily-run report` summarizes
confirmed mutations, completed queue coverage, explicitly recorded escalations,
unfinished todos, sponsor-integrity state, and the run brief before the run is
completed. A run cannot complete until its bounded sponsor-integrity snapshot
has been scanned and every selected case is cleared or disqualified. `hold` and
`flag` deliberately keep the run open for human judgment; scans never suspend,
revoke, or disqualify a sponsor automatically.

Identity inspection, escalation dispositions, AI-bucket maintenance, and
approved Notable User additions and todos are private operator bookkeeping and
do not require a delegated daily run. Identity inspection always requires an
audited `--reason`; raw email/DOB evidence additionally requires
`--include-private-evidence`. Routine briefs omit raw email identities.

The complete run lifecycle, command contracts, nullable fields, Karma approval
behavior, pagination semantics, secret-subject behavior, presence isolation,
and retry rules are documented in
[`sdk/LUMINE_ADMIN.md`](sdk/LUMINE_ADMIN.md).

`lumine login` opens the Twinkle approval page automatically. If you are running
in SSH, CI, or an agent environment, use:

```bash
npx @stage5/lumine@latest login --no-open
```
