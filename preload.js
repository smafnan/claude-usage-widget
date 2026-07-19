const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  onUsage: (cb) => ipcRenderer.on("usage:data", (_e, payload) => cb(payload)),
  refresh: () => ipcRenderer.invoke("usage:refresh"),
  resize: (height) => ipcRenderer.send("widget:resize", height),
  hide: () => ipcRenderer.send("widget:hide"),
  quit: () => ipcRenderer.send("widget:quit"),
  authStart: () => ipcRenderer.invoke("auth:start"),
  authSubmit: (code) => ipcRenderer.invoke("auth:submit", code),
});
