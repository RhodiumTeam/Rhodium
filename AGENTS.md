# Rhodium

Rhodium is a single-user agent host and control plane for one Linux machine with systemd. It hosts Claude Code, Codex and pi conversations, and its user drives them from IM (QQ, Telegram and Feishu), a web board, and ssh/Herdr.

These are the rules for any coding agent working in this repo. They are plain Markdown and need no tool-specific mechanism: Claude Code reads them through `CLAUDE.md`, which only imports this file.

Start with `docs/README.md`. It is the doc map. The docs form a DAG, and each doc links only to its upstream docs.

## This machine

If `AGENTS.local.md` exists at the repo root, read it before anything else. For Claude Code, a `CLAUDE.local.md` holding `@AGENTS.local.md` loads it into every session; other agents open it themselves. It holds the rules of the machine this checkout lives on: its name, the services running there, the accounts in use. Where it and this file disagree, it wins. Files named `*.local.md` stay in the private repo and are never published; a published checkout has none, and you may write your own.

## Project rules

- **Language.** Docs are written in Chinese: GLOSSARY, product, architecture, ADRs, spec, issues, and PR descriptions. `README.md` and `CONTRIBUTING.md` are in English, each with a Chinese translation beside it (`README_zh.md`, `CONTRIBUTING_zh.md`); change both together. Outside contributors may write issues and PRs in English (`CONTRIBUTING.md`). Code, identifiers, code comments, and commit messages are in English.
- **Doc DAG.** Every doc opens with one line saying what question it answers and a "前置阅读" line ("Read first" in the English docs) listing its upstream docs. It may link only to upstream docs (see `docs/README.md`). State each fact fully in one place and link to it from everywhere else.
- **Writing style.** Use short sentences and one idea per bullet. Explain a term the first time you use it, or link `GLOSSARY.md`. Never use reviewer jargon or internal codenames.
- **Claude Code compliance.**
  - Run the user's own unmodified `claude` binary under their own login: their subscription or their own API key.
  - Never pass `--bare`, because it breaks subscription login.
  - Only the user may trigger an agent.
  - pi must not use the Claude subscription.
- **Don't touch the user's live setup.** Leave alone the user's running Rhodium instance (beyond upgrading it as `docs/agents/implement.md` says), their Herdr sessions and the agent panes in them, and anything under `~/.claude`, `~/.codex`, `~/.pi`, `~/.config` that the user owns. Only the instance itself opens and closes tabs in the user's Herdr session; development agents and tests use only the test session.
- **Isolate tests.**
  - Herdr tests use a separate session: `herdr --session rhodium-test ...`.
  - systemd units created by tests are prefixed `rhodium-test-`.
  - Dev IM credentials live in `~/.config/rhodium-dev/`, never in the repo.
- **Quota.**
  - Day-to-day tests use fake agents and recorded fixtures.
  - Real `claude` runs for fixture recording use `--model haiku`. When Claude must actually do a task, prefer Sonnet.
  - pi uses its default model, and real pi runs are kept cheap.

## Build and test

- Build: `scripts/build.sh [out-dir]` writes `rhodium` (Bun) and `rh-hold` (Rust) to `dist/`; the large Rust build cache goes in a temp dir it deletes. `rh` is `rhodium` invoked under the name `rh`, e.g. via a symlink.
- Test: `bun install && bun run check` runs the Rust format check, strict `tsc` and all of `test/`; run it on the merged code before merging a PR, except for Markdown-only changes (see `docs/agents/testing.md`). `bun run test` runs only the tests, on a third of the cores; `bun test <file>` runs one file. See `docs/agents/testing.md`. Bump the version in both `package.json` and `holder/Cargo.toml`.

## Agent guides

### Contributing

How outside contributions land, and the agent tools contributors run (ponytail, Matt Pocock's skills): `CONTRIBUTING.md`.

### Coding standards

Before writing or reviewing code, read `docs/agents/coding-standards.md`: what to defend against, how to grade review findings, and the test rules.

### Implementing a change

Branch, TDD, checks, PR, review, merge, cleanup: `docs/agents/implement.md`.

### Debugging an instance

To inspect a running instance (database, holder logs, socket, `rh trace`), read `docs/agents/debugging.md`.

### Issue tracker

Issues live in the GitHub Issues of this repo, accessed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
