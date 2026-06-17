// Exposes a minimal, safe bridge to the renderer (the Synapse web app). The web UI checks for
// `window.synapseDesktop` to switch the "Create library" flow from Google Drive to local folders.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("synapseDesktop", {
  isDesktop: true,
  platform: process.platform,
  /** Open the native folder picker. Resolves to { path, name } or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke("synapse:pick-folder"),
  /** List supported files (recursively) under a folder. Resolves to { files: [{name, path, relPath, size}], error? }. */
  listFolder: (folderPath) => ipcRenderer.invoke("synapse:list-folder", folderPath),
  /** Read one file's bytes. Resolves to a Uint8Array. */
  readFile: (filePath) => ipcRenderer.invoke("synapse:read-file", filePath),
});
