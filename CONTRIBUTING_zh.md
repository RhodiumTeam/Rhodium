# 参与贡献

这篇回答：为什么公开仓库只发布版本快照，外部改动如何进入 Rhodium，以及动手前需要准备什么。

前置阅读：[README_zh.md](README_zh.md)、[AGENTS.md](AGENTS.md)、[docs/agents/implement.md](docs/agents/implement.md)、[编码与审查规范](docs/agents/coding-standards.md)、[跑测试](docs/agents/testing.md)

[English](CONTRIBUTING.md)

## 为什么采用快照方式开源

作者在私有仓库里迭代时考虑不周，无意中把过多隐私信息写进了仓库的 Issue、PR 和文档 T_T。为了保护隐私，公开仓库不得已只发布按版本导出的快照，不带提交历史、Issue 和 PR。

文档和代码注释里的 `#编号` 指私有仓库的 Issue，在公开仓库里查询不到。

## 贡献流程

### 讨论功能

如果你计划编写较大的改动或新功能，请先创建 Issue 讨论，确认方向后再动手。功能按作者自己的需求迭代，可能无法满足所有需求。Issue 和 PR 使用中文或英文撰写均可。

### 提 Issue

报告问题时，请写清软件版本、复现步骤和看到的现象。粘贴日志前，请先去掉真实的账号、ID 和对话内容。作者精力有限，可能不会及时回复。

### 发 PR

Rhodium 使用编程 agent 开发，贡献代码也应当遵循同样的方式。

- 为你的 agent 安装 [ponytail](https://github.com/DietrichGebert/ponytail)，并确认常开模式生效。ponytail 的 hook（部分 agent 上是扩展）会把规则注入每个会话：
  - 在 Claude Code 和 Codex 上，这些 hook 使用 Node.js 运行，需要确保 `node` 在 `PATH` 里。
  - Codex 还需要通过 `/hooks` 确认信任这些 hook。
  - 你不需要运行 ponytail 的审查和审计命令。
- 安装 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)：
  - 仓库已经按这套 skills 配置完毕，`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md` 和 `docs/agents/domain.md` 就是它们需要读取的文件。
  - 实现改动时使用 `tdd`，排查 bug 时使用 `diagnosing-bugs`。
- 你的 agent 会读取 `AGENTS.md`，Claude Code 则通过 `CLAUDE.md` 读取它。文档里列出了每次修改都必须遵守的规范：语言、文档、Claude Code 合规、测试隔离和额度。
- 开发环境需要 Linux 和 systemd 用户会话、Bun、用 rustup 安装的带有 `rustfmt` 的 Rust，以及 xz，原因见[跑测试](docs/agents/testing.md)。
- 分支请从公开仓库最新的 `main` 分支创建。
- 按照 [docs/agents/implement.md](docs/agents/implement.md) 的第 1 到第 4 步执行：创建分支、测试先行、运行 `bun run check`、创建 PR。如果 PR 对应公开仓库里的某个 Issue，正文第一行请写 `Part of #<issue>`；如果没有对应 Issue，则省略这一行。审查和合并由维护者完成。
- 维护者按照[编码与审查规范](docs/agents/coding-standards.md)审查代码。
- 如果有意走了捷径，请添加一条 `ponytail:` 注释，写明上限和后续升级方式。
- 如果修改了网页看板，请在 PR 里附上手机和宽屏、浅色和深色模式的截图，截图需使用虚构数据。

### PR 会被怎样处理

- 公开仓库是私有开发仓库按版本导出的快照，PR 不会在 GitHub 上直接合并。
- PR 被接受后，维护者会把它搬进私有开发仓库，照常执行审查和检查。开发仓库里的提交会使用你提交时的名字和邮箱，署你为共同作者。
- 改动会随下一个版本进入公开仓库，归在对应版本唯一的提交里。随后维护者会关闭你的 PR，并留言说明改动包含在哪个版本里。

## 隐私

- 测试、素材和提交里不得出现真实的账号、ID 和对话内容，名字请使用虚构数据。
- 你录制的素材需要经过 `scripts/probes/synth.ts` 处理，详见[跑测试](docs/agents/testing.md)。如果有遗漏，`test/fixture-hygiene.test.ts` 测试就会失败。

## 许可

你贡献的内容按本仓库的 MIT 许可授权（[LICENSE](LICENSE)）。

