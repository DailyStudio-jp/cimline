# CimLine

CimLine is a desktop workspace for running Claude Code and Codex CLI in real, independent terminal sessions. Each pane uses `node-pty` and xterm.js, so input, approval prompts, and CLI slash commands behave as they do in a regular shell. The dashboard keeps a two-column layout, searchable session history, recently used folders, and drag-and-drop ordering.

The app also shows Codex account usage limits (5-hour and weekly windows) and lists locally available Codex skills. Those features use the installed Codex CLI configuration; the app does not store API keys or credentials in the project.

## Requirements

- Node.js 24 or later
- Windows or macOS
- At least one CLI installed and authenticated: `codex` or `claude`
- PowerShell (`pwsh`, with `powershell.exe` as fallback) on Windows, or a login shell on macOS

## Development

```powershell
npm install
npm run dev
```

On Windows, double-click [`start-cimline.bat`](./start-cimline.bat) to install missing dependencies and start the development app.

On macOS, double-click [`start-cimline.command`](./start-cimline.command) in Finder to install missing dependencies and start the development app in Terminal. If a change affects `electron/main.cjs` or `electron/preload.cjs`, fully stop and restart the app; Vite hot reload only updates the renderer.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `/` | Focus terminal search when a text field or dialog is not active |
| `Ctrl+N` on Windows; `Cmd+N` on macOS | Open the new terminal dialog |
| `Ctrl` + `+` / `-` / `0` on Windows; `Cmd` + `+` / `-` / `0` on macOS | Zoom in / out / reset |
| `Ctrl` + wheel on Windows; `Ctrl` or `Cmd` + wheel, or pinch on macOS | Change the terminal grid from 1 to 6 columns |
| `Alt` + wheel anywhere in the workspace | Scroll the workspace |
| Windows: `Ctrl+C` | Copy selected text; with no selection, send Ctrl+C to the CLI |
| Windows: `Ctrl+Shift+C`, `Ctrl+V`, `Ctrl+Shift+V` | Copy selection, paste, paste |
| macOS: `Cmd+C`, `Cmd+V` | Copy selected text, paste; `Cmd+C` with no selection is ignored |
| macOS: `Ctrl+C` | Send Ctrl+C to the CLI |
| Any platform: right-click in a terminal | Copy selected text, or paste when there is no selection |

Other terminal keys are passed through to the selected CLI, except for the app-level shortcuts above.

## Build installers

```powershell
npm run package:win
```

On macOS:

```sh
npm run package:mac
```

Installers are written to `release/`. `node-pty` is a native dependency and is unpacked from the Electron archive. If its binary needs to be rebuilt for the local Electron version, run:

```sh
npm run rebuild:native
```

## CLI and shell selection

The app detects `codex` and `claude` on `PATH` by default. Set these environment variables before launching CimLine to override detection or select a shell:

| Variable | Purpose |
| --- | --- |
| `CIMLINE_SHELL` | Shell executable to use for sessions |
| `CIMLINE_CODEX_CMD` | Codex command name or path |
| `CIMLINE_CLAUDE_CMD` | Claude Code command name or path |
| `CIMLINE_DEFAULT_PROJECT` | Initial folder; `CODEX_DEFAULT_PROJECT` is also accepted |
| `CODEX_CLI_JS` / `CODEX_NODE_EXE` | Codex CLI script and Node executable for account usage and skill discovery |

Windows defaults to PowerShell 7 (`pwsh`) and falls back to Windows PowerShell. macOS uses the user's login shell and falls back to `/bin/zsh`. CimLine starts the selected CLI in the chosen folder. New sessions launch the CLI normally; reopening a session runs `codex resume --last` or `claude --continue` in that folder.

## Session history

Closing a pane stops its shell process tree but keeps the folder, CLI choice, and session metadata in `sessions.json` under Electron's user-data directory. Closed sessions stay in history and can be reopened or deleted. Active PTYs end when CimLine exits; they are not background jobs. Reopening starts a fresh shell and asks the selected CLI to continue its latest conversation.

## Session status and notifications

Pane status is tracked as idle, running, completed, approval-waiting, or exited. Claude Code reports prompt, completion, permission, and user-input events through a per-session settings file in CimLine's user-data directory. Codex reports completed turns through a per-run `notify` override; submitted non-empty terminal input marks a Codex pane as running. CimLine never edits `~/.claude/settings.json` or `~/.codex/config.toml`.

Hooks send only the pane ID and event name to a random-port HTTP listener bound to `127.0.0.1`. A per-launch random token, active-session check, and 8 KB request limit protect that listener. Hook stdin and Codex event text are discarded; prompts and terminal output are not written to session history. A completion or permission request in an unfocused pane is highlighted and counted until the pane is focused. The app also shows an OS notification when it is in the background.

## Skills and plugins

Codex CLI remains responsible for interactive `/` commands and `$` skill invocations inside a Codex terminal. CimLine's Skills view reads the local Codex skill and plugin cache for browsing. Account usage displays the 5-hour and weekly rate-limit windows reported by the Codex account API; the API reports used percentages and reset times, not a remaining-token count.

## Licenses

CimLine is licensed under the MIT License; see [`LICENSE`](./LICENSE). Resolved third-party dependency versions and the license expressions recorded in `package-lock.json` are listed in [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md). That inventory reflects package metadata and does not verify each package's license text.
