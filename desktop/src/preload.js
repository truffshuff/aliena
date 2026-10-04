const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("aliena", {
  pickPdfs: () => ipcRenderer.invoke("pick-pdfs"),
  expandPaths: (paths) => ipcRenderer.invoke("expand-paths", paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickOutputDir: (current) => ipcRenderer.invoke("pick-output-dir", current),
  defaultOutputDir: () => ipcRenderer.invoke("default-output-dir"),
  convert: (payload) => ipcRenderer.invoke("convert", payload),
  reveal: (target) => ipcRenderer.invoke("reveal", target),
  openPath: (target) => ipcRenderer.invoke("open-path", target),
  updateStatus: () => ipcRenderer.invoke("update-status"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  openRelease: () => ipcRenderer.invoke("update-open-release"),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_event, status) => callback(status)),
});
