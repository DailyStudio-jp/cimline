# Claude Code Guide

## Project

CimLine is an Electron desktop workspace for real Claude Code and Codex CLI sessions on Windows and macOS. Each terminal is an xterm.js frontend connected to a `node-pty` shell running in the Electron main process.

## Structure

- `electron/main.cjs`: application composition root for Electron windows, PTYs, and IPC.
- `electron/features/usage/`: Codex usage-window logic.
- `electron/features/notifications/`: CLI notification hook.
- `electron/shared/`: reusable Electron infrastructure such as atomic file writes.
- `electron/preload.cjs`: exposes the narrow desktop API to the renderer.
- `src/App.tsx`: composes the workspace and coordinates app-level state.
- `src/features/sessions/`: session ordering, filtering, titles, and new-session UI.
- `src/features/terminal/`: terminal pane, input/output, image drops, resize, and clipboard behavior.
- `src/features/settings/`: appearance settings UI.
- `src/features/usage/`: Codex usage UI and types.
- `src/components/ui/`: shared UI primitives and dialog behavior.
- `src/index.css`: dashboard and terminal styling.

Keep filesystem and process access in Electron main. Do not enable renderer Node integration. Validate all IPC inputs and keep terminal access scoped to session IDs.

## Development

```sh
npm install
npm run dev
```

`npm run build` runs the TypeScript check and Vite production build. Windows and macOS installers use `npm run package:win` and `npm run package:mac`. `node-pty` is native; preserve its Electron rebuild and archive unpack settings.

## Appearance and zoom

- Theme: Settings offers system / light / dark, saved as `theme` in `<userData>/settings.json`. Main sets `nativeTheme.themeSource`, so the renderer uses `prefers-color-scheme`. Colors in `src/index.css` use `--c-*` variables with a dark value and a light value; define both when adding a color. xterm switches its ANSI palette when the system color scheme changes.
- Zoom: Cmd/Ctrl + `+` and `-` change the window zoom; Cmd/Ctrl + `0` resets it. Main validates the step, clamps the zoom factor, and persists it with the theme in `<userData>/settings.json`.

## Terminal behavior

- Windows shells default to `pwsh`, then `powershell.exe`; `CIMLINE_SHELL=cmd.exe` uses `cmd` syntax (`cd /d`). macOS uses the login shell and falls back to `/bin/zsh`.
- A pane starts either `codex` or `claude` in its selected folder. Reopening history uses `codex resume --last` or `claude --continue`.
- Closing a pane stops its process tree, but retains its folder, CLI, and metadata in session history.
- The terminal UI must remain directly interactive. Do not replace it with a log viewer or a separate follow-up prompt form.
- Use xterm's resize events to size the PTY. Keep each session's in-memory replay buffer bounded to 512 KB and sequence output to avoid duplicate writes when a pane attaches.
- Filter only `ESC[3J` from replay, queued, and live terminal output so screen redraws do not erase the scrollback history.
- Respect terminal keyboard behavior: Ctrl+C interrupts unless text is selected; copy, paste, and right-click behavior follow the platform conventions documented in README.
- Keep pane status in main-process session metadata. Persist only the status, timestamp, and unread flag alongside the existing session metadata; never persist the PTY buffer, prompts, or CLI output.
- Generate Claude hooks and Codex `notify` overrides per CimLine session. Store generated config under Electron `userData`, pass it only to that CLI run, and do not modify global Claude or Codex configuration files. Send only session ID and event name through the random-port loopback notifier; drain hook stdin without retaining it.
- Unreviewed completion is highlighted in green and permission-waiting in amber. Focusing the pane clears its unread flag and updates the OS badge. Send OS notifications only while the app is in the background.

## Codex features

Keep account usage (5-hour and weekly windows) and the local Skills view. Codex CLI owns interactive slash commands, plugins, and `$` skill calls inside its terminal. Do not implement CimLine-specific prompt completions inside the raw PTY input stream.

## Safety and contribution rules

- Read and follow `AGENTS.md`.
- Never write API keys, tokens, credentials, or local Codex configuration into source, logs, or commits.
- Keep `contextIsolation` enabled, `nodeIntegration` disabled, and the sandboxed preload API narrow.
- Use separate commits for independent features when publishing changes. Do not force-push.
