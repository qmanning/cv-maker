// electron/assistant/settings-preload.cjs — the AI Settings window's bridge. A typed key goes from this window
// straight to the main process, which encrypts it; it is never sent back, and the editor window has no such bridge.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("cvAssistantSettings", {
    get: () => ipcRenderer.invoke("assistant-settings:get"),
    save: (next) => ipcRenderer.invoke("assistant-settings:save", next),
    test: (next) => ipcRenderer.invoke("assistant-settings:test", next),
    forget: () => ipcRenderer.invoke("assistant-settings:forget"),
    close: () => ipcRenderer.send("assistant-settings:close"),
    updates: {
        get: () => ipcRenderer.invoke("assistant-settings:updates-get"),
        setAuto: (on) => ipcRenderer.invoke("assistant-settings:updates-set", !!on),
        check: () => ipcRenderer.send("assistant-settings:updates-check"),
    },
    onShow: (handler) => { ipcRenderer.on("assistant-settings:show", (_e, section) => handler(section)); },
    notes: {
        get: () => ipcRenderer.invoke("assistant-settings:notes-get"),
        set: (text) => ipcRenderer.invoke("assistant-settings:notes-set", String(text || "")),
    },
    mcp: {
        state: () => ipcRenderer.invoke("assistant-settings:mcp-state"),
        connectClaude: () => ipcRenderer.invoke("assistant-settings:mcp-connect-claude"),
        disconnectClaude: () => ipcRenderer.invoke("assistant-settings:mcp-disconnect-claude"),
        connectCodex: () => ipcRenderer.invoke("assistant-settings:mcp-connect-codex"),
        disconnectCodex: () => ipcRenderer.invoke("assistant-settings:mcp-disconnect-codex"),
        moveToApplications: () => ipcRenderer.invoke("assistant-settings:move-to-applications"),
        copy: (what) => ipcRenderer.invoke("assistant-settings:mcp-copy", what),
        onChange: (handler) => { ipcRenderer.on("assistant-settings:mcp-changed", (_e, state) => handler(state)); },
    },
});
