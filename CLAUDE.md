# Claude Code Guide

## Project

Codex Run Desk is a Windows desktop app for managing multiple Codex CLI sessions. It uses Electron, React, TypeScript, Vite, and a small set of shadcn-style UI components.

## Structure

- `electron/main.cjs`: starts and manages Codex CLI processes, task state, and Electron IPC handlers.
- `electron/preload.cjs`: exposes the narrow, typed desktop API to the renderer.
- `src/App.tsx`: terminal dashboard, task dialogs, and user interactions.
- `src/index.css`: application layout, terminal styling, and responsive behavior.
- `src/components/ui/`: reusable UI primitives.

The renderer must use `window.codexDesk` for desktop operations. Keep filesystem and process access in the Electron main process; do not enable renderer Node integration.

## Development

Install dependencies and start the desktop app:

```powershell
npm install
npm run dev
```

Create the Windows installer with:

```powershell
npm run package:win
```

The app expects an installed and authenticated Codex CLI. It looks for the global npm installation by default; `CODEX_CLI_JS` and `CODEX_NODE_EXE` can override the CLI script and Node executable.

## Contribution rules

- Read and follow `AGENTS.md`; it contains the repository's mandatory workflow and safety rules.
- Keep changes within the feature's scope and preserve per-terminal conversation behavior.
- Do not commit API keys, tokens, credentials, or local Codex configuration. Keep real secrets out of source and documentation.
- Do not add or run tests, or run a build, unless the user explicitly asks.
- Use focused commits for independent features when preparing changes for the remote repository.
