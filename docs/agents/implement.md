# 实现一个改动

这篇回答：一个 issue 从开分支到合并按什么步骤走。不依赖哪一家的 agent 工具，照着做就行。

前置阅读：[AGENTS.md](../../AGENTS.md)、[编码与审查规范](coding-standards.md)、[跑测试](testing.md)、[Issue 跟踪](issue-tracker.md)、[部署](../../deploy/README.md)

## 一直要守的

- 只有用户能触发 agent，见 AGENTS.md 的 Claude Code compliance。
- 额度怎么用，见 AGENTS.md 的 Quota。
- 同一时间最多跑两遍全套测试。几个改动并行时，彼此错开。
- 不碰用户在用的设置，测试用自己的会话和单元，见 AGENTS.md。

## 步骤

1. **开工作区。** 从最新的 `main` 开独立的工作区和分支：

   ```sh
   git fetch origin
   git worktree add -b <分支> <目录> origin/main
   cd <目录> && bun install --frozen-lockfile
   ```

2. **测试先行。** 一次一个行为：先写测试，看它挂，再写实现让它过。规矩见[编码与审查规范](coding-standards.md#测试)。
3. **跑检查。** `bun run check` 过了才往下走。它依次跑 Rust 格式检查、类型检查和全套测试。只改了 Markdown 文件的不用跑，见[跑测试](testing.md)；审查照常。
4. **开 PR。** 提给 `main`，标题和正文用中文（外部贡献者也可以用英文，见 AGENTS.md 的 Language），正文第一行写 `Part of #<issue>`：

   ```sh
   git push -u origin <分支>
   gh pr create --base main --head <分支> --title "..." --body-file <正文文件>
   ```

   改了网页界面的，在正文里写上手机和宽屏、浅色和深色截图在本机的路径，见[编码与审查规范](coding-standards.md#意见怎么定级)。

   以后改 PR 的标题或正文用 `gh api -X PATCH repos/{owner}/{repo}/pulls/<PR> -f body=...`，`gh` 会自己填上仓库。有的 `gh` 版本的 `gh pr edit` 会报 Projects (classic) 的错，改不成。
5. **独立审查。** 由没参与实现的人或 agent 审，对照 issue 和[编码与审查规范](coding-standards.md)，每条意见定为“必须修”或“建议修”。
   - 结论贴成 PR 评论，第一行写结论，例如 `## 审查结论：可以合`、`## 第 2 轮复审结论：要改再合`。
   - 外部审查（例如 Codex）的意见同样按规范定级。
6. **修。** 必须修的都修，同样测试先行。修完贴一条评论，说改了什么、在哪个提交。
   - 每次修完都要复审，复审过了才合。上一轮结论是“可以合”、只修了“建议修”的，也要复审。这是用户 2026-10-30 定的。
   - 复核最多两轮，两轮后还有分歧就交给用户定。
7. **合并前再检查。** 把最新的 `origin/main` 合进分支（`git fetch origin && git merge origin/main`），在合并后的代码上跑一遍第 3 步的检查，过了再推上去。没有冲突也要跑。
8. **合并和清理。**

   ```sh
   gh pr merge <PR> --squash --subject "<英文标题> (#<PR>)"
   git push origin --delete <分支>
   git worktree remove <目录> && git branch -D <分支>
   ```

   - 合并提交的标题用英文，见 [Issue 跟踪](issue-tracker.md)。
   - 直接跑过 `cargo` 的，删掉 `holder/target/`。
   - 测试留下的 `rhodium-test-*` systemd 单元和 `/tmp/rhodium-test-*` 目录也清掉。`/tmp/rhodium-test-rh-hold-<哈希>/` 是测试故意留的 `rh-hold` 缓存，不删。别的测试还在跑时不清，会删掉它们正在用的（`pgrep -af 'bun test'` 能看有没有在跑的）：

     ```sh
     systemctl --user stop 'rhodium-test-*'; systemctl --user reset-failed 'rhodium-test-*'
     find /tmp -maxdepth 1 -name 'rhodium-test-*' ! -name 'rhodium-test-rh-hold-*' -exec rm -rf {} +
     ```
9. **升级开发实例。** 合进来以后，照[部署·升级](../../deploy/README.md#升级)升级开发实例。

## 用子代理和工作流时

用 Claude Code 的子代理或工作流来实现、审查时，再守这几条。

- 每个子代理都写明模型和思考强度，不让它沿用会话的模型。这是用户 2026-11-15 定的：

  | 做什么 | 模型和强度 |
  | --- | --- |
  | 实现、修审查意见、合并：碰数据库、协议、路由、安全或跨几个模块的 | Opus high |
  | 实现、修审查意见、合并：其余的（小改动、只改界面的） | Opus medium |
  | 审查和复审：重要的（碰数据库、协议、路由、安全或跨几个模块） | Fable high |
  | 审查和复审：其余的 | Opus high |
  | 以读资料为主的调研 | Sonnet，只读用 medium，要诊断、试验或归纳的用 high |
  | 排查本项目自己代码里的问题 | Opus xhigh |
  | 其余的（分诊等） | Opus xhigh |

- 不给正在跑的工作流里的 agent 发 SendMessage，也不按它的 ID 停掉它。消息会另起一个副本，原来那个会停下，两个还会改同一个工作区。
  - 中途要补的要求，写成 issue 或 PR 的评论，让下一轮审查或修复带上。
  - 非补不可的，停掉整个工作流，把要求写进提示词重新起。
