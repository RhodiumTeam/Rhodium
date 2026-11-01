# Contributing

This answers: why the public repository publishes versioned snapshots, how a change from outside gets into Rhodium, and what to set up before you write one.

Read first: [README.md](README.md), [AGENTS.md](AGENTS.md), [docs/agents/implement.md](docs/agents/implement.md), [coding and review standards](docs/agents/coding-standards.md), [running tests](docs/agents/testing.md)

[中文](CONTRIBUTING_zh.md)

## Why Snapshots

While iterating in the private development repository, the author was not careful enough early on and inadvertently wrote too much private information into issues, pull requests, and documentation T_T. To protect privacy, this public repository only publishes versioned snapshots exported from the private repository, without commit history, issues, or pull requests.

References like `#number` in documentation and code comments point to issues in the private repository and cannot be looked up here.

## Contribution Workflow

### Discussing Features

If you are planning a large change or a new feature, please open an Issue first to discuss the direction before writing code. Features evolve around the author's own needs and may not cover every request. External contributors are welcome to write Issues and PRs in English or Chinese.

### Reporting Issues

When reporting a bug, please include the software version, reproduction steps, and what you observed. Strip any real accounts, IDs, and conversation content before pasting logs. The author has limited time and may not reply right away.

### Submitting a PR

Rhodium is built with coding agents, and contributions should be made the same way.

- Install [ponytail](https://github.com/DietrichGebert/ponytail) for your agent and verify that its always-on mode is active. Its hooks (or extensions on some agents) inject ponytail's rules into every session:
  - On Claude Code and Codex, these hooks run on Node.js, so `node` must be in your `PATH`.
  - On Codex, you must also confirm trust for the hooks in `/hooks`.
  - You do not need to run ponytail's review or audit commands.
- Install [Matt Pocock's skills](https://github.com/mattpocock/skills):
  - This repository is already configured for them: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md` are the files they read.
  - Use `tdd` when implementing changes, and `diagnosing-bugs` when investigating bugs.
- Your agent will read `AGENTS.md` (Claude Code reads it through `CLAUDE.md`). It sets the rules that every change must follow: language, documentation, Claude Code compliance, test isolation, and quota.
- You need Linux with a systemd user session, Bun, Rust with `rustfmt` installed through rustup, and xz; see [running tests](docs/agents/testing.md) for why.
- Create your branch from the latest `main` in this repository.
- Follow steps 1 through 4 in [docs/agents/implement.md](docs/agents/implement.md): create a branch, write tests first, run `bun run check`, and open a PR. If your PR addresses an issue in this public repository, put `Part of #<issue>` on the first line of the PR description; omit that line if there is no matching issue. The maintainer handles review and merging.
- The maintainer reviews changes against the [coding and review standards](docs/agents/coding-standards.md).
- For intentional shortcuts, add a `ponytail:` comment stating the ceiling and how to upgrade it later.
- If you modify the web board, attach screenshots to your PR covering both mobile and widescreen layouts in light and dark modes, using fictional data.

### How PRs Land

- This repository is a versioned snapshot exported from a private development repository. PRs are not merged directly on GitHub.
- Once a PR is accepted, the maintainer ports it into the private development repository, where it goes through the standard review and checks. The commit in the development repository credits you as a co-author using the name and email from your commit.
- Your change enters this public repository with the next release, folded into that version's single commit. The maintainer will then close your PR with a note stating which release includes it.

## Privacy

- Never include real accounts, IDs, or conversation content in tests, fixtures, or commits. Use fictional names.
- Pass any recorded fixtures through `scripts/probes/synth.ts`; see [running tests](docs/agents/testing.md). If anything is missed, `test/fixture-hygiene.test.ts` will fail.

## License

Your contributions are licensed under this repository's MIT License ([LICENSE](LICENSE)).

