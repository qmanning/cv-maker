// electron/preload.cjs — the only bridge between the editor and the shell. It exposes CvMaker's
// `CvFiles` contract (see src/CvMaker.tsx) as window.cvMakerFiles and nothing else: no Node, no paths,
// no ipcRenderer. (CommonJS because sandboxed preloads can't be ES modules.)
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const subscribe = (channel) => (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld("cvMakerFiles", {
    current: () => ipcRenderer.invoke("files:current"),
    save: (html, opts) => ipcRenderer.invoke("files:save", String(html), { as: !!(opts && opts.as), suggested: String((opts && opts.suggested) || "resume.html") }),
    open: () => ipcRenderer.send("files:open"),
    onOpen: subscribe("files:opened"),
    onCommand: subscribe("files:command"),
    setDirty: (dirty) => ipcRenderer.send("files:dirty", !!dirty),
});

// drop a résumé file anywhere on the window to open it (the page never sees the path; the shell reads the file)
window.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file || !/\.html?$/i.test(file.name)) return;   // images etc. stay the editor's business
    e.preventDefault();
    ipcRenderer.send("files:dropped", webUtils.getPathForFile(file));
});
