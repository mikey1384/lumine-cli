# Lumine CLI

Launch Twinkle Lumine builds from any terminal.

```bash
npx @stage5/lumine@latest
npx @stage5/lumine@latest login
npx @stage5/lumine@latest projects
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

For team projects, Lumine mirrors the website workspace flow: choosing or
pulling the owner's main project creates or reuses your contribution branch and
checks out that branch locally. Saves go to your branch, so the project owner
can merge or replace main from Twinkle.

Use `lumine explore` to list public open-source Build apps that can be used as
examples or starting points. It supports `--search` and `--sort forks`,
`--sort popular`, or `--sort recent`. Use `lumine reference <build-url-or-id>`
to pull source files into a read-only reference folder, or
`lumine fork <build-url-or-id>` to create your own editable fork and pull it
locally.

After editing pulled files, run `lumine save` from that folder. The CLI saves
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

`lumine login` opens the Twinkle approval page automatically. If you are running
in SSH, CI, or an agent environment, use:

```bash
npx @stage5/lumine@latest login --no-open
```
