// Synapse desktop — Electron main process.
// Loads the SAME Synapse web app (same UI, same backend, same env — nothing is forked) and adds a
// native bridge so the renderer can create libraries from LOCAL folders instead of Google Drive.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

// ── Which web app to load ───────────────────────────────────────────────────────────────────────
// Priority: SYNAPSE_APP_URL env var > config.json "appUrl" > localhost:3000.
function resolveAppUrl() {
  if (process.env.SYNAPSE_APP_URL) return process.env.SYNAPSE_APP_URL.trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    if (cfg && typeof cfg.appUrl === "string" && cfg.appUrl.trim()) return cfg.appUrl.trim();
  } catch {
    /* fall through */
  }
  return "https://synapse-web.nex-gen-3023.workers.dev/";
}
const APP_URL = resolveAppUrl();

// Supported file extensions — mirrors backend `library_files_api._ALLOWED_EXT` so we only stage
// files the pipeline can actually parse.
const ALLOWED_EXT = new Set([
  // code
  ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".rb", ".php", ".c", ".cc", ".cpp",
  ".h", ".hpp", ".cs", ".swift", ".kt", ".scala", ".sh", ".bash", ".sql", ".r", ".m", ".lua",
  ".pl", ".dart", ".vue", ".css", ".scss",
  // documents
  ".pdf", ".docx", ".txt", ".text", ".log", ".md", ".markdown", ".csv", ".xlsx", ".xlsm",
  // images
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  // data
  ".json",
]);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0b0e16",
    title: "Synapse",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL(APP_URL);

  // Open off-app links (Google login, docs, etc.) in the system browser, keep app navigation in-window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const sameOrigin = new URL(url).origin === new URL(APP_URL).origin;
      if (!sameOrigin) {
        shell.openExternal(url);
        return { action: "deny" };
      }
    } catch {
      /* if URL can't be parsed, allow */
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Native folder / file access (used for local-folder library creation) ────────────────────────

ipcMain.handle("synapse:pick-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder to build a library from",
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const folder = res.filePaths[0];
  return { path: folder, name: path.basename(folder) };
});

function walk(dir, base, out, depth) {
  if (depth > 12) return; // guard against pathological trees
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip dotfiles / .git etc.
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      out.push({ name: entry.name, path: full, relPath: path.relative(base, full), size });
    }
  }
}

ipcMain.handle("synapse:list-folder", async (_evt, folderPath) => {
  if (!folderPath || typeof folderPath !== "string") return { files: [], error: "No folder" };
  const out = [];
  try {
    walk(folderPath, folderPath, out, 0);
  } catch (err) {
    return { files: [], error: String(err) };
  }
  return { files: out };
});

ipcMain.handle("synapse:read-file", async (_evt, filePath) => {
  // Returns a Uint8Array (structured-cloned to the renderer) so it can be wrapped in a File and
  // uploaded through the existing /library/add-files/upload endpoint.
  const buf = fs.readFileSync(filePath);
  return new Uint8Array(buf);
});
