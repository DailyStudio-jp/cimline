const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexDesk", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  getRateLimits: () => ipcRenderer.invoke("usage:get-rate-limits"),
  chooseFolder: () => ipcRenderer.invoke("dialog:choose-folder"),
  createTask: (input) => ipcRenderer.invoke("tasks:create", input),
  continueTask: (id, prompt) => ipcRenderer.invoke("tasks:continue", id, prompt),
  stopTask: (id) => ipcRenderer.invoke("tasks:stop", id),
  stopAll: () => ipcRenderer.invoke("tasks:stop-all"),
  closeTask: (id) => ipcRenderer.invoke("tasks:close", id),
  reopenTask: (id) => ipcRenderer.invoke("tasks:reopen", id),
  deleteTask: (id) => ipcRenderer.invoke("tasks:delete", id),
  onTasksUpdated: (callback) => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on("tasks:updated", listener);
    return () => ipcRenderer.removeListener("tasks:updated", listener);
  },
});
