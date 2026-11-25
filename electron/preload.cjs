const { contextBridge, ipcRenderer, webUtils } = require("electron");

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;

function getDroppedImagePaths(files) {
  if (!Array.isArray(files)) return [];
  return files.slice(0, 10).flatMap((file) => {
    try {
      if (!file || typeof file.name !== "string" || !IMAGE_EXTENSIONS.test(file.name)) return [];
      const filePath = webUtils.getPathForFile(file);
      return typeof filePath === "string" && filePath.length > 0 && filePath.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(filePath)
        ? [filePath]
        : [];
    } catch {
      return [];
    }
  });
}

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("codexDesk", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  getRateLimits: () => ipcRenderer.invoke("usage:get-rate-limits"),
  getSkills: (projectPaths) => ipcRenderer.invoke("skills:list", projectPaths),
  chooseFolder: () => ipcRenderer.invoke("dialog:choose-folder"),
  createSession: (input) => ipcRenderer.invoke("sessions:create", input),
  closeSession: (id) => ipcRenderer.invoke("sessions:close", id),
  reopenSession: (id) => ipcRenderer.invoke("sessions:reopen", id),
  deleteSession: (id) => ipcRenderer.invoke("sessions:delete", id),
  setFocusedSession: (id) => ipcRenderer.invoke("sessions:focus", id),
  attachPty: (id) => ipcRenderer.invoke("pty:attach", id),
  writePty: (id, data) => ipcRenderer.invoke("pty:write", id, data),
  resizePty: (id, columns, rows) => ipcRenderer.invoke("pty:resize", id, columns, rows),
  readClipboardText: () => ipcRenderer.invoke("clipboard:read-text"),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  getDroppedImagePaths,
  platform: process.platform,
  onSessionsUpdated: (callback) => subscribe("sessions:updated", callback),
  onPtyData: (callback) => subscribe("pty:data", callback),
  onPtyExit: (callback) => subscribe("pty:exit", callback),
});
