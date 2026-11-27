This guide walks a Windows tester through a first Rhodium conversation and shows how to test recovery and report the results.

Read first — no prior Rhodium experience required. The Chinese edition is TESTING-zh.md.

# Windows preview test

Rhodium runs your signed-in command-line agent on your PC. A slot is a conversation in a working directory. You configure slots on the local board and talk to them through a phone bot. The controller is rhodium.exe. A separate rh-hold.exe keeps the agent and its streams alive when the controller exits.

## Before you start

Use a trusted single-user Windows 11 x64 PC and ordinary **Windows PowerShell 5.1**. No Bun, Rust or administrator installation is needed. The CI host is Windows Server 2022 x64. ARM64, 32-bit Windows and service before sign-in are outside this test.

Use the signed-in native CLI you want to test. The first conversation below uses Claude; if only Codex or pi is available, select that agent when creating the slot. For Claude, check `Get-Command claude.exe,claude.cmd -ErrorAction SilentlyContinue` and `claude --version` in a fresh PowerShell. Create an empty directory with `New-Item -Force -Type Directory "$env:USERPROFILE\RhodiumPreview-work"`. Run Claude there, finish login and directory trust, get one genuine reply, then exit. For an npm-only installation set `claude` to the absolute path of your `claude.cmd` under `[programs]`. Test each CLI separately in the terminal section. Real turns use your account and may incur charges. [Claude setup](https://code.claude.com/docs/en/setup)

On Telegram, use the official @BotFather, send /newbot and keep the new bot's username and token privately. Use a dedicated test bot with no other polling client. [Telegram bot tutorial](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)

The sample board binds only to **127.0.0.1:17860**. Open it on this PC. It trusts local browser requests and is reachable by local processes. Do not expose it through forwarding, a proxy or a firewall rule. The phone uses the bot.

## Install, pair and send

1. Save the ZIP and obtain its SHA256 from the sender. In Windows PowerShell:

   ~~~powershell
   $zip = Get-Item -LiteralPath (Read-Host 'Paste the full ZIP path without quotation marks')
   (Get-FileHash -Algorithm SHA256 -LiteralPath $zip.FullName).Hash
   ~~~

   Compare all 64 hex digits before proceeding. In the same window:

   ~~~powershell
   $apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
   $data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
   $work = Join-Path $env:USERPROFILE 'RhodiumPreview-work'
   $app = Join-Path $apps $zip.BaseName
   if (Test-Path $app) { throw 'Version directory already exists; inspect it before proceeding.' }
   New-Item -Type Directory -Force $apps,$work | Out-Null
   Unblock-File -LiteralPath $zip.FullName
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
   Expand-Archive -LiteralPath $zip.FullName -DestinationPath $app
   Set-Location -LiteralPath $app
   .\rhodium.exe --version
   ~~~

   Expect the preview version and commit printed on the first line of VERSION.txt. The policy change applies only to this PowerShell window. Repeat it in a new window if needed for the verified scripts. Keep corporate execution policies in place; report any block to your administrator.

2. Inspect config.example.toml. The task script fills the paths, including the location of claude.exe. It preserves an existing config. Extract to a local NTFS directory. The ZIP carries one controller binary. During installation the script creates rh.exe as a hard link to rhodium.exe in the same directory, under your ordinary account. Use rh.exe after this step. Run:

   ~~~powershell
   .\windows-task.ps1 -TaskName RhodiumPreview -InstallDir $app -InstanceDir $data -ConfigTemplate .\config.example.toml
   Get-ScheduledTask -TaskName RhodiumPreview | Select-Object TaskName,State
   $env:RHODIUM_SOCKET = Join-Path $data 'run\rh.sock'
   .\rh.exe ls
   ~~~

   Expect Running and a CLI response after a few seconds. The active config is `$data\config.toml`. If the task cannot find Claude, change its path there to the actual executable (single-quoted TOML strings preserve backslashes) and restart the preview task while idle. If the port is occupied, set another free local port and use that address. After a new login restore your PowerShell variables:

   ~~~powershell
   $data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
   $app = Split-Path (Get-ScheduledTask -TaskName RhodiumPreview).Actions[0].Execute
   ~~~

3. Open **http://127.0.0.1:17860/** on the PC. Choose **新建** (New), select the empty test directory, create a workspace and a Claude slot, for example preview/chat. In the slot's chat ask for the exact reply WEB-01. Check that it appears once. Create a slot first; the New Bot button requires a destination.
4. Choose **+ → 新建 Bot** (New Bot), **Telegram**, name it tgtest and select the new slot under **投递给** (Destination). Paste the token into the credential field. From your own Telegram account, privately message the displayed pairing code to your new bot. Expect **创建成功** (Created). The first paired private chat becomes the main chat.
5. Send “Reply only IM-01” from the phone. Expect a phone reply and the exchange in the same slot on the board. Then send WEB-02 from the board and check the board reply. A board-originated turn normally replies on the board only.

## What to observe

Record the Windows build, preview version, local time with offset, steps, outcome and pass/fail/pending for each row. Before and after restart tests, save this process snapshot. It filters by the preview installation path and avoids printing raw command lines.

~~~powershell
$apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($apps+'\',[StringComparison]::OrdinalIgnoreCase) -and $_.Name -in 'rhodium.exe','rh-hold.exe' } |
  Select-Object @{n='role';e={if ($_.Name -eq 'rhodium.exe') {'daemon'} elseif ($_.CommandLine -match '\s"?task"?\s') {'task launcher'} elseif ($_.CommandLine -match '\s"?run"?\s') {'agent holder'} else {'CLI listener'}}},ProcessId,CreationDate
Get-ScheduledTaskInfo -TaskName RhodiumPreview | Select-Object LastRunTime,LastTaskResult
~~~

| Test | Do | Expect | If different, record |
|---|---|---|---|
| Desktop windows | After upgrading, start a fresh pi slot, send a message and ask it to run a Node command. Close the installer PowerShell and send a follow-up from the phone. | No extra terminal opens at task startup, slot startup or tool execution. Both replies arrive. | Record which step opened a window, its title (redacted), and the slot state. |
| Sign-in | Let the slot go idle, sign out, sign in again. Send LOGIN-01 from the phone without running an installer. | Task starts at login and the phone receives a reply, normally within a minute. Sign-out ends old processes. | Sign-in time, task state, last result and reply delay. |
| Lock/unlock | Keep PC awake and online. Press Win+L and send LOCK-01 while locked. Unlock. | Reply arrives while locked; controller PID and creation time survive. | Both times, whether sleep occurred, and whether the reply appeared only after unlock. |
| Sleep/wake | Put PC to sleep, send SLEEP-01, wake the PC. When online, send WAKE-01. | No immediate answer during sleep; a new message works after reconnection. Check separately whether Telegram re-delivered SLEEP-01. | Sleep, wake and network times, missing or duplicate replies. |
| Phone/board | Use a different marker on each, as in step 5. | Phone reply for a phone turn; visible history and a working reply on the board. | Which slot, origin and destination, timestamps and duplicate count. |
| Kill the controller | Use the long-turn procedure below; kill only the old controller after the start marker appears. | After the first abnormal exit the task launcher waits two seconds before starting the controller. Allow startup time. Expect a new controller PID, same agent holder PID and creation time, one start/end pair and one reply. A follow-up still works. | Old/new PIDs, LastTaskResult, counts and any manual restart needed. |
| Install a different version | When a second preview with a different commit is available, follow the upgrade procedure and use U1 markers. | New executable runs, old holder survives until the turn completes, same bot/slot history, one reply. | Both versions, process snapshots, exact ordering and any missing or repeated reply. With only one build mark pending. |
| Permissions | Inspect `icacls "$data\config.toml"` and `icacls "$data"` locally. | Newly created private directory grants your account access; ordinary other users, Users and Everyone have no read grant. The checker also trusts Administrators and SYSTEM. | State only whether an unexpected grant existed and whether startup refused. Omit account names and SIDs. |

**Long turn.** From the phone ask the agent to execute this single PowerShell operation in the empty test directory, wait and then reply R1-DONE. Watch probe-R1.txt. Use a new marker/file for each run.

~~~powershell
Add-Content .\probe-R1.txt 'R1-start'; Start-Sleep 90; Add-Content .\probe-R1.txt 'R1-end'
~~~

After a launch error or nonzero controller exit, the watchdog retries after 2, 4, 8, 16 and 32 seconds. It exits after the fifth consecutive failed retry. A controller that runs for a minute replenishes the five retries. An exit code of zero (even when supplied by an external process killer) or ending the scheduled task stops the watchdog. During recovery the task stays Running and LastTaskResult can be 267009. Check the new PID and board response for recovery. The scheduler's separate failure retry remains configured as a fallback.

When start exists and end does not, take the snapshot. From another PowerShell, end only the controller whose full executable path matches this task. Do not end rh-hold, the agent or the scheduled task itself.

~~~powershell
$oldExe = Join-Path (Split-Path (Get-ScheduledTask -TaskName RhodiumPreview).Actions[0].Execute) 'rhodium.exe'
$old = @(Get-Process -Name rhodium -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $oldExe })
if ($old.Count -ne 1) { throw 'Expected exactly one preview controller.' }
$old[0].Kill()
~~~

**Upgrade.** Verify the new ZIP, extract it into its own version directory under the same apps root and compare both --version outputs. Keep the same data directory and task name. Start the long turn with probe-U1.txt and U1 markers. Once started, save the process snapshot and the **old** controller path ($oldExe below the process snapshot). Run the step 2 registration command from the new directory, passing the new -InstallDir. The new directory gets its own rh.exe hard link. Run `.\rh.exe --version` there and check that it matches the new rhodium.exe. The installer retires the old task and starts the new version. Check that the registered action points to rh-hold.exe in the new directory and confirm the new controller PID and path. Verify the original holder and agent finish the turn. If the board is still unavailable after two minutes, record task history and process snapshots before using `Start-ScheduledTask -TaskName RhodiumPreview` for manual recovery. Keep the old version directory while its holders run.

## Claude Code, Codex and pi slots and the web terminal

1. Sign in to each CLI you plan to test and verify one standalone reply. Give pi its own provider and login. Put the CLI and Herdr paths under the existing `[programs]` section of the preview config. Under `[herdr]`, set `session = "rhodium-test-preview"`. Run `herdr --session rhodium-test-preview server` in another terminal, then reload the preview service with this config. Record the Rhodium, Herdr (the probe used 0.9.5) and CLI versions.

Windows accepts the entry points below under `[programs]`. Use TOML single quotes for absolute paths containing backslashes. Rhodium checks the path before stopping the headless process.

| Slot | Windows terminal entry point |
|---|---|
| Claude Code | Native `claude.exe`, or the official npm `claude.cmd`. Current npm packages run their native target; older packages run the JS entry point declared by the package with Node. |
| Codex | Native `codex.exe`, or the Node entry point declared by the official npm `codex.cmd`. |
| pi | Native `pi.exe`, a standard npm `pi.cmd`, or the exact `pi.cmd` template installed by pi.dev's `install.ps1`. For the last form Rhodium follows the template's Node selection, runs the original `pi-launcher.js`, preserves its update environment and checks the PID and creation time of the inner Node agent. |

For an unrecognized or customized cmd/bat, record the board error, set `programs.claude`, `programs.codex` or `programs.pi` to a supported entry point and retry.

2. On the board use **+ → 新建** (New) in a test workspace. Create three headless slots, selecting Claude, Codex and pi respectively. Run the following checks separately for each available login and mark any missing one as untested. Choose two short random markers A and B for each slot. From the board chat or its paired bot, ask “Remember A and reply only OK,” substituting your marker. Wait for the reply and an idle slot.
3. Choose **切到终端** (switch to terminal), or send `/rh_tui` from the bound chat, and open the board terminal. At the CLI prompt type “Repeat my previous marker and remember B,” substituting the second marker. Expect A. Let the turn finish, resize the terminal and open the same slot terminal in a second browser tab. The second tab should take over the same screen and accept input; the first should indicate that it lost control.
4. Quit the CLI normally. After the board shows headless mode, ask “What was my second marker?” from the board chat or bound bot. Expect one reply containing B. Switch to the terminal again, give it a fresh marker, and wait for a reply. This time confirm Release on the board or send `/rh_release` from the bound chat and confirm. Ask for the latest marker in headless mode without repeating it. Closing a browser tab alone leaves the CLI running.
5. For each agent, mark the headless turn, same-session terminal reply, web input, takeover, return after normal exit and return after confirmed release as pass/fail/untested. For a failure record local time, versions, launcher form, slot mode, last successful step and short redacted error. Distinguish a missing prompt, manual input working while auto-input waits, and an unexpected fresh conversation. Omit config, raw transcripts, recordings, tokens and account/session IDs.

**Claude hook, vim and pi extension.** `herdr integration install claude` installs the SessionStart hook that reports Claude's session identity to Herdr. Screen detection also provides working state. `herdr integration install pi` installs the extension that reports pi session and state. Use an existing integration if available. These commands write agent settings or extensions; if needed, run them only in a dedicated test account or isolated test profile and reopen the test pane. Record only whether a session was reported.

If vim is enabled in the Claude test project and terminal type-in is on, send a test message from the bound chat at an empty NORMAL prompt. It should wait, then be delivered once at an empty INSERT prompt. Record the mode and delivery count; manual typing tests a different path. For a separate pi environment check, set `ANTHROPIC_AUTH_TOKEN` to a synthetic placeholder only in the environment of a dedicated test Herdr server. Use no real secret. Ask pi to run the command below as a tool and report only `present` or `absent`. Expect `absent` and a working reply through pi's own provider. Do not print the environment or the value.

~~~sh
node -e "console.log(Object.hasOwn(process.env,'ANTHROPIC_AUTH_TOKEN')?'present':'absent')"
~~~

When all test slots are back in headless mode, stop this named session with `herdr session stop rhodium-test-preview`.

## Diagnostics, limitations and removal

From the current version directory run one command:

~~~powershell
.\collect-feedback.ps1
~~~

It prints the path of a feedback ZIP. It includes task status, Windows build, timezone, process timestamps, sanitized task event IDs/times for the last 48 hours if Task Scheduler history is enabled, and holder log sizes/modification times. See Task Scheduler → RhodiumPreview → History locally. The controller writes stderr; Task Scheduler does not create a daemon.log. Raw agent stderr is in `$data\state\hold\<conversation>\err.log`; in.log/out.log contain the actual conversation/protocol and rh.db contains local records. These raw files are excluded from the diagnostic bundle.

Send the package provider your version, test table, reproduction steps and reviewed diagnostic ZIP. Inspect it first. Remove tokens, API keys, pairing codes, account/chat IDs, SIDs, usernames, personal paths, prompts and tool output from all text/screenshots. Never send config.toml, the database or the whole state directory.

The directory picker accepts C:\, C:/ and ~\ and displays forward slashes. At a drive root, type another drive to switch. Use + → 导入 (Import) to select a saved session. A process naming its ID or a Herdr pane reporting it blocks import. Other instances of the same agent can keep running. Close an active session that does not advertise its ID before importing it.

Rhodium can create TUI panes for Claude, Codex and pi. Live Claude panes can be imported. A live pi pane can be adopted only when its credential check explicitly clears it. Codex panes, rh stop --all and rh trace are unavailable. Local rh denies owner-only commands; supported privileged actions use the board or paired IM.

To uninstall, first stop your test slots on the board and save any results. These commands apply only to the dedicated names and directories above. Revoke the test bot token in @BotFather as needed.

~~~powershell
$apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
$data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
Set-Location $env:USERPROFILE
Disable-ScheduledTask -TaskPath '\' -TaskName RhodiumPreview | Out-Null
Stop-ScheduledTask -TaskPath '\' -TaskName RhodiumPreview
Unregister-ScheduledTask -TaskPath '\' -TaskName RhodiumPreview -Confirm:$false
$remaining = @(Get-Process -Name rhodium,rh-hold -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($apps+'\',[StringComparison]::OrdinalIgnoreCase) })
foreach ($p in $remaining) { if (-not $p.HasExited) { $p.Kill() }; $p.WaitForExit() }
Remove-Item -LiteralPath $apps,$data -Recurse -Force
~~~

This removes the preview binaries, bot credentials and Rhodium history. Remove the test work directory, downloaded ZIP and feedback archives separately. Leave your agent's own login and session directories intact.
