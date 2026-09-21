// electron/preload.cjs — the only bridge between the editor and the shell. It exposes CvMaker's
// `CvFiles` contract (see src/CvMaker.tsx) as window.cvMakerFiles, plus the `CvAssistant` contract as window.cvMakerAssistant, and nothing else: no Node, no paths,
// no ipcRenderer. (CommonJS because sandboxed preloads can't be ES modules.)
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const subscribe = (channel) => (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("cvMakerFiles", {
    // two documents, one per tab: every call may say which ("resume" | "letter"); left out, it means the tab that is showing
    current: (kind) => ipcRenderer.invoke("files:current", kind),
    save: (html, opts) => ipcRenderer.invoke("files:save", String(html), { as: !!(opts && opts.as), suggested: String((opts && opts.suggested) || "resume.html"), kind: opts && opts.kind }),
    open: (kind) => ipcRenderer.send("files:open", kind),
    onOpen: subscribe("files:opened"),
    onCommand: subscribe("files:command"),
    setDirty: (dirty, kind) => ipcRenderer.send("files:dirty", !!dirty, kind),
    setActive: (kind) => ipcRenderer.send("files:active", kind),
    // recent-documents typeahead (the omni bar)
    recent: (kind) => ipcRenderer.invoke("files:recent", kind),
    openPath: (p) => ipcRenderer.send("files:openPath", String(p)),
    pin: (p, on) => ipcRenderer.send("files:pin", { path: String(p), pinned: !!on }),
    onRecent: subscribe("files:recent-changed"),
    saveAs: (html, name, kind) => ipcRenderer.invoke("files:saveAs", String(html), String(name), kind)
        .catch((e) => { throw new Error(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }),
    onDownload: subscribe("files:download"),
    // the brand menu's quick actions
    checkUpdates: () => ipcRenderer.send("shell:check-updates"),
    openExternal: (url) => ipcRenderer.send("shell:open-external", String(url)),
});

// "ask your AI": words and the document go to the shell, operations come back. The key never comes near this page.
contextBridge.exposeInMainWorld("cvMakerAssistant", {
    status: () => ipcRenderer.invoke("assistant:status"),
    configure: () => ipcRenderer.send("assistant:configure"),
    onStatus: subscribe("assistant:status-changed"),
    run: (request) => ipcRenderer.invoke("assistant:run", { prompt: String(request && request.prompt || ""), document: request && request.document })
        .catch((e) => { throw new Error(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }),
});

// an AI app outside Itera (through the shell's MCP server) drives the editor: the shell calls, the editor's handlers answer
let remoteHandlers = null;
contextBridge.exposeInMainWorld("cvMakerRemote", {
    serve: (handlers) => { remoteHandlers = handlers; return () => { if (remoteHandlers === handlers) remoteHandlers = null; }; },
    status: () => ipcRenderer.invoke("remote:status"),            // { apps: ["Claude Desktop", …], live: n } — for the pill under the page
    onStatus: subscribe("remote:status-changed"),
    configure: () => ipcRenderer.send("assistant:configure"),
});
ipcRenderer.on("remote:call", async (_e, { id, method, args }) => {
    try {
        if (!remoteHandlers || typeof remoteHandlers[method] !== "function") throw new Error("The editor isn't ready yet.");
        ipcRenderer.send("remote:result", { id, ok: true, value: await remoteHandlers[method](...(args || [])) });
    } catch (e) { ipcRenderer.send("remote:result", { id, ok: false, error: String(e && e.message || e) }); }
});

// AI ▸ Ask Your AI… (⌘K): the menu's accelerator swallows the key press, so the shell asks us to focus the prompt bar
ipcRenderer.on("assistant:focus", () => { const box = document.querySelector(".cvm-ask textarea"); if (box) box.focus(); });

// View ▸ Zoom In / Zoom Out / Fit Width, chosen with the mouse: the editor listens for these (see CvMaker's zoomBy)
ipcRenderer.on("view:zoom", (_e, which) => { if (["in", "out", "fit"].includes(which)) window.dispatchEvent(new Event("cvm:zoom-" + which)); });

// drop a résumé file anywhere on the window to open it (the page never sees the path; the shell reads the file)
window.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !/\.html?$/i.test(file.name)) return;   // images etc. stay the editor's business
    e.preventDefault();
    ipcRenderer.send("files:dropped", webUtils.getPathForFile(file));
});
