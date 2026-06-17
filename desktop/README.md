# Synapse Desktop

A thin Electron shell around the **same** Synapse web app (same UI, same backend API, same env —
nothing is forked). The only difference from the browser: you create libraries from a **local
folder** instead of Google Drive. Everything else (chat, agent, knowledge graph, team, usage,
account) is identical because it loads the deployed web app directly.

## How it works

- `main.js` opens a window and loads the deployed app (`config.json` → `appUrl`, default
  `https://synapse-web.nex-gen-3023.workers.dev/`). Override per-run with the `SYNAPSE_APP_URL`
  environment variable, or for local dev point it at `http://localhost:3000`.
- `preload.js` injects `window.synapseDesktop` (folder picker + recursive file listing + file read).
- The web app detects `window.synapseDesktop` and switches the **Create library** dialog to a local
  folder picker. The folder's supported files are uploaded through the existing
  `/library/add-files/upload` → `/commit` pipeline, so only the new files are processed — same
  backend, same processing.

## Prerequisites

- Node.js 18+ and npm.
- Internet access to the deployed Synapse app (the desktop app loads it; it does not bundle the web
  build).

## Run in development

```bash
cd desktop
npm install
# loads the production app by default; for a local web server instead:
#   set SYNAPSE_APP_URL=http://localhost:3000   (Windows)  / export on macOS/Linux
npm start
```

## Build an installer / executable

```bash
cd desktop
npm install
npm run dist:win      # Windows: NSIS installer + portable .exe  → desktop/dist/
# npm run dist:mac    # macOS .dmg
# npm run dist:linux  # Linux AppImage
```

Output lands in `desktop/dist/`:

- `Synapse Setup <version>.exe` — installer (lets the user choose the install location, adds Start
  menu + desktop shortcuts).
- `Synapse-<version>-portable.exe` — single-file portable executable (no install).

To point a build at a different deployment, edit `config.json` (`appUrl`) before running `dist`, or
set `SYNAPSE_APP_URL` when launching.

## Icon

`assets/icon.png` is used for the window and the packaged app. Replace it with a 512×512 (or larger)
PNG to rebrand. For the sharpest Windows installer icon, drop a multi-resolution `assets/icon.ico`
in and point `build.win.icon` at it in `package.json`.
