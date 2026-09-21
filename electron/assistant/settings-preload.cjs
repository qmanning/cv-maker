// electron/assistant/settings-preload.cjs — the AI Settings window's bridge. A typed key goes from this window
// straight to the main process, which encrypts it; it is never sent back, and the editor window has no such bridge.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cvAssistantSettings", {
    get: () => ipcRenderer.invoke("assistant-settings:get"),
    save: (next) => ipcRenderer.invoke("assistant-settings:save", next),
    test: (next) => ipcRenderer.invoke("assistant-settings:test", next),
    forget: () => ipcRenderer.invoke("assistant-settings:forget"),
    close: () => ipcRenderer.send("assistant-settings:close"),
});
