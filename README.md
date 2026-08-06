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
npx @stage5/lumine@latest projects
npx @stage5/lumine@latest branches 884
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

For team projects, Lumine mirrors the website workspace flow: choosing or
pulling the owner's main project creates or reuses your contribution branch and
checks out that branch locally. Saves go to your branch, so the project owner
can merge or replace main from Twinkle.

Use `lumine branches <build-url-or-id>` to list the contribution branches you
can review, including each contributor, branch number, status, and URL. Then use
`lumine diff <branch-url>` to inspect one branch.

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

## Inspecting Build SDK data

`lumine sdk call <namespace.method> '<jsonArgs>'` calls a build's data SDK
endpoint with your login and prints the response, so you can inspect real data
and measure latency while building. Run `lumine sdk list` to see callable
methods. The JSON args are sent as the request body (shapes follow
`TWINKLE_BUILD_SDK.md`).

```bash
lumine sdk call aiStories.chapters '{"limit": 5}'
lumine sdk call aiStories.list '{"difficulty": 1}' --repeat 5 --build 1374
```

It targets the build in the current workspace, or pass `--build <id>`. Add
`--repeat <n>` for min/avg/max latency. Output is the raw endpoint response,
which can differ from a method's `Twinkle.*` SDK return shape — check
`TWINKLE_BUILD_SDK.md` for SDK return shapes. Methods that change data require
`--allow-write`.

## Assets and AI image generation

Binary media never lives in the workspace — assets are uploaded to Twinkle and
referenced from code by URL. `lumine assets upload <file...>` uploads images or
audio; `lumine assets list` prints your uploads and refreshes
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

After pulling a project, run an agent from the pulled folder:

```bash
codex "Read AGENTS.md, then make the requested change."
claude "Read CLAUDE.md, then make the requested change."
```

The login command uses a browser approval code and stores a scoped token and the
selected project at `~/.twinkle/lumine-cli-auth.json`.

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
lumine admin daily-run start --identity auto --comment-mode off --json
lumine admin recommendations list --cursor '<cursor>' --json
lumine admin subjects candidates --after 2026-08-01T00:00:00Z --json
lumine admin subjects candidates --effort unassigned --json
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
lumine admin post recommend comment:456 --anyone-can-reward --reward-twinkles 3 --json
lumine admin post reward comment:456 --twinkles 3 --json
lumine admin daily-run complete --json
```

Numeric recommendation targets default to subjects. Use `comment:<id>`,
`aiStory:<id>`, `dailyReflection:<id>`, a canonical URL, or the matching
`--type` for another post kind. Commenting is always `off` for a new run unless
`--comment-mode draft` or `--comment-mode post` is explicitly supplied. Drafts
and posts use the selected bot's server-owned canonical persona; a later human
reply is handled by Twinkle's existing autonomous Zero/Ciel responder without
Lumine remaining active.

Every operation is noninteractive when its required arguments are present.
`--json` prints exactly one uncolored JSON value and returns a nonzero status
for forbidden, not-found, validation, and partial-failure responses. Pass a
stable `--idempotency-key` when retrying one mutation across processes; the
server also enforces canonical no-duplicate invariants. Failed mutation JSON
includes `error.details.retryIdempotencyKey` so a partial attempt can be
resumed with the exact generated key.

Subject and recommendation-queue listings use opaque, stable snapshot cursors.
Pass the returned `data.pagination.nextCursor` back through `--cursor` until
`data.pagination.exhausted` is true. Subject `--after` is inclusive and cursors
are bound to the original date and effort filters.

The complete run lifecycle, command contracts, nullable fields, Karma approval
behavior, pagination semantics, secret-subject behavior, presence isolation,
and retry rules are documented in
[`sdk/LUMINE_ADMIN.md`](sdk/LUMINE_ADMIN.md).

`lumine login` opens the Twinkle approval page automatically. If you are running
in SSH, CI, or an agent environment, use:

```bash
npx @stage5/lumine@latest login --no-open
```
