// electron/files.mjs — real files for the desktop app. The document is one Source HTML file on disk:
// Open / Open Recent / drop-in, Save / Save As, an edited dot in the title bar, a guard on close, and a
// watcher — so when something else edits the file (your AI assistant, another editor), the sheet follows.
// The editor side of this contract is `CvFiles` in ../src/CvMaker.tsx; preload.cjs is the wire between them.
import { app, dialog, ipcMain, Menu, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE = 25 * 1024 * 1024;
const FILTERS = [{ name: "Résumé (HTML)", extensions: ["html", "htm"] }];
// Open takes anything the editor can import (src/import/): an IcedCoffee file opens as itself, the rest is converted
// in the editor into a NEW, unsaved document — the Word file / PDF on disk is only ever read, never written over.
const IMPORTS = ["docx", "docm", "dotx", "rtf", "pdf", "md", "markdown", "mdown", "mkd", "txt", "text", "xhtml"];
const OPEN_FILTERS = [{ name: "Résumé or cover letter", extensions: ["html", "htm", ...IMPORTS] }, ...FILTERS, { name: "Word, PDF, RTF, Markdown, text", extensions: IMPORTS }];
// formats with no reader, handed over anyway so the editor can say what to do instead (save as .docx …)
const ELSEWHERE = ["doc", "pages", "odt", "gdoc", "webarchive"];
export const importable = (file) => new RegExp(`\\.(${[...IMPORTS, ...ELSEWHERE].join("|")})$`, "i").test(file);
/** an IcedCoffee document (its template's editable regions) — any other HTML is imported, not opened in place */
export const isNative = (text) => /\bdata-cv-edit\b/.test(text);
const hash = (text) => crypto.createHash("sha1").update(text).digest("hex");

const KINDS = ["resume", "letter"];                      // the two documents the editor holds, one per tab
const LABEL = { resume: "résumé", letter: "cover letter" };
const kindOfText = (text) => (/data-cv-kind="letter"|data-cv-mirror="header"/.test(text) ? "letter" : "resume");   // same test as the editor's docKind()
const asKind = (k) => (k === "letter" || k === "cover_letter" ? "letter" : "resume");

export function setupFiles({ templatePath, letterTemplatePath = "", smokeDir = "", onWelcome = () => {}, onAssistant = () => {}, updates = null }) {
    const statePath = () => path.join(app.getPath("userData"), "files.json");
    // everything a document has — its open file, unsaved flag, what we last read/wrote, watcher, recents, pinned master — once per kind
    const docs = Object.fromEntries(KINDS.map((k) => [k, { current: "", dirty: false, known: "", watcher: null, watchTimer: null, recent: [], pinned: "" }]));
    let win = null, active = "resume", closeAfterSave = false;
    try {
        const s = JSON.parse(fs.readFileSync(statePath(), "utf8"));
        for (const k of KINDS) {
            const from = k === "resume" ? s : (s.letter || {}), d = docs[k];   // the résumé's keys sit at the top level (the file format before there were two)
            d.recent = (from.recent || []).filter((p) => typeof p === "string"); if (typeof from.pinned === "string") d.pinned = from.pinned;
            if (from.current && fs.existsSync(from.current)) d.current = from.current;
            if (!d.current && d.pinned && fs.existsSync(d.pinned)) d.current = d.pinned;   // a pinned "master" is the default document whenever nothing else is open
        }
    } catch { /* first run */ }

    const persist = () => { const out = (d) => ({ current: d.current, recent: d.recent, pinned: d.pinned }); try { fs.writeFileSync(statePath(), JSON.stringify({ ...out(docs.resume), letter: out(docs.letter) }, null, 2)); } catch { /* not worth a dialog */ } };
    const title = () => {
        if (!win || win.isDestroyed()) return;
        const d = docs[active], anyDirty = KINDS.some((k) => docs[k].dirty);
        win.setTitle((d.current ? path.basename(d.current) : active === "letter" ? "Untitled Cover Letter" : "Untitled") + (d.dirty && process.platform !== "darwin" ? " •" : "") + " — IcedCoffee");
        win.setRepresentedFilename(d.current || ""); win.setDocumentEdited(anyDirty);   // macOS: the proxy icon and the dot in the close button
    };
    const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
    const ask = (options) => (smokeDir ? 0 : dialog.showMessageBoxSync(win, { type: "question", noLink: true, ...options }));
    // the omni bar's typeahead: existing files only, the pinned master at the top, recency preserved otherwise
    const recentList = (kind = active) => { const d = docs[asKind(kind)]; return d.recent.filter((p) => fs.existsSync(p))
        .map((p) => ({ path: p, name: path.basename(p).replace(/\.html?$/i, ""), pinned: p === d.pinned }))
        .sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)); };
    const emitRecent = (kind) => send("files:recent-changed", { kind });

    function watch(kind) {
        const d = docs[kind]; d.watcher?.close(); d.watcher = null;
        if (!d.current) return;
        // watch the folder, not the file: editors (and our own save) replace the file, which orphans a file watcher
        const dir = path.dirname(d.current), base = path.basename(d.current);
        try { d.watcher = fs.watch(dir, (_evt, name) => { if (!name || name === base) { clearTimeout(d.watchTimer); d.watchTimer = setTimeout(() => changedOnDisk(kind), 250); } }); } catch { /* unwatchable volume: Save still works */ }
    }
    function changedOnDisk(kind) {
        const d = docs[kind]; let text; try { text = fs.readFileSync(d.current, "utf8"); } catch { return; }   // deleted or mid-write; the next event will tell
        if (hash(text) === d.known) return;                                                                  // our own save, or a touch
        if (d.dirty && ask({ message: `“${path.basename(d.current)}” changed on disk.`, detail: "You also have edits here that aren't saved. Reload the file and lose them, or keep yours?", buttons: ["Keep Mine", "Reload from Disk"], defaultId: 0, cancelId: 0 }) !== 1) { d.known = hash(text); return; }
        d.known = hash(text);
        send("files:opened", { text, name: path.basename(d.current), kind, note: "Reloaded — the file changed on disk" });
    }

    function setCurrent(kind, file, text) {
        const d = docs[kind]; d.current = file; d.known = text == null ? "" : hash(text);
        if (file) { d.recent = [file, ...d.recent.filter((p) => p !== file)].slice(0, 10); app.addRecentDocument(file); }
        persist(); watch(kind); title(); buildMenu(); emitRecent(kind);
    }
    const okToReplace = (kind, verb) => !docs[kind].dirty || ask({ message: `Your ${LABEL[kind]} has unsaved changes.`, detail: `${verb} anyway and lose them?`, buttons: ["Cancel", verb], defaultId: 0, cancelId: 0 }) === 1;

    const readDoc = (file) => { if (fs.statSync(file).size > MAX_FILE) throw new Error("That file is too large to be a résumé."); return fs.readFileSync(file, "utf8"); };
    const writeAtomic = (target, html) => {   // never leave half a document behind
        const tmp = target + ".cvm-tmp";
        try { fs.writeFileSync(tmp, html); fs.renameSync(tmp, target); }
        catch (e) { fs.rmSync(tmp, { force: true }); throw new Error("Could not save: " + (e?.message || e)); }
    };
    const forget = (file) => { for (const k of KINDS) docs[k].recent = docs[k].recent.filter((p) => p !== file); persist(); buildMenu(); KINDS.forEach(emitRecent); };
    // a file says what it is (a cover letter marks itself), so it always lands in its own slot — and the editor's sheet follows
    function importPath(file) {
        let data; try { if (fs.statSync(file).size > MAX_FILE) throw new Error("That file is too large to be a résumé."); data = fs.readFileSync(file); }
        catch (e) { dialog.showErrorBox("Could not open the file", String(e?.message || e)); return; }
        send("files:import", { name: path.basename(file), data: new Uint8Array(data) });   // the editor converts, then claims a slot (files:claim)
    }
    function openPath(file) {
        if (importable(file)) return importPath(file);
        if (!/\.html?$/i.test(file)) return;
        let text; try { text = readDoc(file); } catch (e) { forget(file); dialog.showErrorBox("Could not open the file", String(e?.message || e)); return; }
        if (!isNative(text)) return importPath(file);   // somebody else's HTML: import a copy, keep theirs as it is
        const kind = kindOfText(text);
        if (!okToReplace(kind, "Open")) return;
        docs[kind].dirty = false; setCurrent(kind, file, text);
        send("files:opened", { text, name: path.basename(file), kind });
    }
    /** an AI app asks (MCP): by recent name, or by path. No dialogs — and never over the person's unsaved work. */
    function openRemote(wanted, kindHint = "") {
        const q = String(wanted || "").trim(); if (!q) throw new Error("Say which document: a name from list_documents, or a file path.");
        const order = kindHint ? [asKind(kindHint), ...KINDS.filter((k) => k !== asKind(kindHint))] : KINDS;
        const list = order.flatMap((k) => recentList(k)), strip = (n) => n.replace(/\.html?$/i, "").toLowerCase();
        const hit = list.find((r) => r.path === q) || list.find((r) => strip(r.name) === strip(q)) || list.find((r) => strip(r.name).includes(strip(q)));
        const file = hit ? hit.path : (path.isAbsolute(q) && /\.html?$/i.test(q) && fs.existsSync(q) ? q : "");
        if (!file) throw new Error(`No document called "${q}". Recent documents: ${list.map((r) => r.name).join(", ") || "(none yet)"}. An absolute path to an .html file also works.`);
        const text = readDoc(file), kind = kindOfText(text), d = docs[kind];
        if (file === d.current && !d.dirty) return { opened: path.basename(file), document: kind === "letter" ? "cover_letter" : "resume", already_open: true };
        if (d.dirty) throw new Error(`The open ${LABEL[kind]} has unsaved changes. Call save_document first (or ask the person) — opening another would discard them.`);
        setCurrent(kind, file, text); send("files:opened", { text, name: path.basename(file), kind });
        return { opened: path.basename(file), path: file, document: kind === "letter" ? "cover_letter" : "resume" };
    }
    /** an AI app asks (MCP) to start a fresh document from the template — no dialog, and never over unsaved work */
    function newRemote(kind) {
        const k = asKind(kind), d = docs[k];
        if (d.dirty) throw new Error(`The open ${LABEL[k]} has unsaved changes. Save it first (save_document), or ask the person.`);
        d.dirty = false; setCurrent(k, "", null);
        const letter = k === "letter" && letterTemplatePath;
        const text = fs.readFileSync(letter ? letterTemplatePath : templatePath, "utf8");
        send("files:opened", { text, name: letter ? "Cover Letter" : "Résumé", kind: k, note: `New ${LABEL[k]} — Save (⌘S) to choose where it lives` });
        return { created: true };
    }
    /** save with no dialog: to the document's open file, or (saveAs) a NEW file of that name beside it — else beside the other
     *  document, else in Documents. Never overwrites another file. */
    function writeDocument(html, { saveAs = "", kind = active } = {}) {
        const k = asKind(kind), d = docs[k]; let target = d.current;
        if (saveAs) {
            const base = String(saveAs).replace(/\.html?$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120);
            if (!base) throw new Error("That name has no usable characters.");
            const beside = d.current || KINDS.map((o) => docs[o].current).find(Boolean) || "";
            target = path.join(beside ? path.dirname(beside) : app.getPath("documents"), base + ".html");
            if (target !== d.current && fs.existsSync(target)) throw new Error(`“${base}” already exists in ${path.dirname(target)}. Pick another name, or open that document instead.`);
        }
        if (!target) throw new Error(`This ${LABEL[k]} has never been saved, so it needs a name: pass save_as.`);
        writeAtomic(target, String(html)); setCurrent(k, target, String(html));
        return { file: path.basename(target), path: target };
    }
    async function openDialog(kind = active) {
        // aim the native panel at a fast, relevant local folder — this document's folder, else the other's, else Documents —
        // instead of letting macOS reuse its last location (which may be a slow network/SMB mount)
        const near = docs[asKind(kind)].current || KINDS.map((o) => docs[o].current).find(Boolean) || "";
        const r = await dialog.showOpenDialog(win, { defaultPath: near ? path.dirname(near) : app.getPath("documents"), properties: ["openFile"], filters: OPEN_FILTERS });
        if (!r.canceled && r.filePaths[0]) openPath(r.filePaths[0]);
    }
    function newDocument(kind = active) {
        if (!okToReplace(kind, "Start New")) return;
        docs[kind].dirty = false; setCurrent(kind, "", null);
        const letter = kind === "letter" && letterTemplatePath;
        send("files:opened", { text: fs.readFileSync(letter ? letterTemplatePath : templatePath, "utf8"), name: letter ? "Cover Letter" : "Résumé", kind, note: `New ${LABEL[kind]} — Save (⌘S) to choose where it lives` });
    }

    // Only the editor window may drive these. It is the one renderer with the cvMakerFiles bridge today, but
    // these handlers open dialogs and read and write real files, so they check rather than assume — the same
    // posture assistant.mjs and mcp.mjs already take with their own channels.
    const fromEditor = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

    ipcMain.handle("files:current", (e, kind) => {
        if (!fromEditor(e)) return null;
        const k = asKind(kind), d = docs[k]; if (!d.current) return null;
        try { const text = fs.readFileSync(d.current, "utf8"); d.known = hash(text); watch(k); title(); return { text, name: path.basename(d.current) }; }
        catch { setCurrent(k, "", null); return null; }
    });
    ipcMain.handle("files:save", async (e, html, opts) => {
        if (!fromEditor(e)) throw new Error("not allowed");
        const k = asKind(opts?.kind || active), d = docs[k]; let target = d.current;
        if (!target || opts.as) {
            if (smokeDir) target = path.join(smokeDir, k === "letter" ? "saved-letter.html" : "saved.html");
            else {
                const near = target || KINDS.map((o) => docs[o].current).find(Boolean) || "";
                const r = await dialog.showSaveDialog(win, { defaultPath: target || path.join(near ? path.dirname(near) : app.getPath("documents"), path.basename(opts.suggested)), filters: FILTERS });
                if (r.canceled || !r.filePath) { closeAfterSave = false; return null; }
                target = /\.html?$/i.test(r.filePath) ? r.filePath : r.filePath + ".html";
            }
        }
        try { writeAtomic(target, html); } catch (e) { closeAfterSave = false; throw e; }
        setCurrent(k, target, html);
        return path.basename(target);
    });
    ipcMain.handle("files:saveAs", (e, html, name, kind) => {
        if (!fromEditor(e)) throw new Error("not allowed");
        return writeDocument(html, { saveAs: String(name || ""), kind: asKind(kind || active) }).file;
    });
    ipcMain.on("files:open", (e, kind) => { if (fromEditor(e)) openDialog(asKind(kind || active)); });
    ipcMain.on("files:dropped", (e, file) => { if (fromEditor(e) && typeof file === "string" && file) openPath(file); });
    // an import is ready to take a tab: the same guard as Open, then that tab has no file until it is saved
    ipcMain.handle("files:claim", (e, kind, remote) => {
        if (!fromEditor(e)) return false;
        const k = asKind(kind);
        if (remote && docs[k].dirty) throw new Error(`The open ${LABEL[k]} has unsaved changes. Call save_document first (or ask the person) — importing would replace it.`);
        if (!remote && !okToReplace(k, "Import")) return false;
        docs[k].dirty = false; setCurrent(k, "", null);
        return true;
    });
    ipcMain.on("files:dirty", (e, flag, kind) => {
        if (!fromEditor(e)) return;
        docs[asKind(kind || active)].dirty = !!flag; title();
        if (closeAfterSave && !KINDS.some((k) => docs[k].dirty)) { closeAfterSave = false; win?.close(); }
    });
    ipcMain.on("files:active", (e, kind) => { if (!fromEditor(e)) return; active = asKind(kind); title(); buildMenu(); });
    ipcMain.handle("files:recent", (e, kind) => (fromEditor(e) ? recentList(asKind(kind || active)) : []));
    ipcMain.on("files:openPath", (e, file) => { if (fromEditor(e) && typeof file === "string" && file) openPath(file); });
    ipcMain.on("files:pin", (e, msg) => {
        if (!fromEditor(e)) return;
        const p = msg && msg.path, on = !!(msg && msg.pinned);
        if (typeof p !== "string" || !p) return;
        const k = KINDS.find((o) => docs[o].recent.includes(p)) || active, d = docs[k];
        d.pinned = on ? p : (d.pinned === p ? "" : d.pinned);   // one master per kind; unpin only clears its own
        persist(); buildMenu(); emitRecent(k);
    });
    // which build is this? — the IcedCoffee menu, the About box and the MCP server all say (build-info.json is written by build/stamp.mjs)
    const buildInfo = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "build-info.json"), "utf8")); } catch { return {}; } })();
    const versionLabel = `${app.getVersion()}${buildInfo.build ? ` · build ${buildInfo.build}` : " · dev"}`;
    app.setAboutPanelOptions?.({ applicationName: "IcedCoffee", applicationVersion: app.getVersion(), version: buildInfo.build ? `build ${buildInfo.build} · ${buildInfo.commit || ""}` : "dev", copyright: "Q Manning · MIT" });
    ipcMain.handle("shell:version", (e) => (fromEditor(e) ? versionLabel : ""));
    // the brand menu's quick actions
    ipcMain.on("shell:check-updates", (e) => { if (fromEditor(e)) updates?.check(); });
    ipcMain.on("shell:open-external", (e, url) => { if (fromEditor(e) && typeof url === "string" && /^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url); });   // web pages and mail only — never file: or an app scheme

    function buildMenu() {
        const mac = process.platform === "darwin";
        const updateItems = updates ? [{ label: "Check for Updates…", click: () => updates.check() }, { label: "Check Automatically", type: "checkbox", checked: updates.auto(), click: (item) => updates.setAuto(item.checked) }] : [];
        const items = (k) => docs[k].recent.filter((p) => fs.existsSync(p)).map((p) => ({ label: path.basename(p), sublabel: path.dirname(p), toolTip: p, click: () => openPath(p) }));
        const letters = items("letter"), openRecent = [...items("resume"), ...(letters.length ? [{ type: "separator" }, { label: "Cover Letters", enabled: false }, ...letters] : [])];
        const current = docs[active].current;
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            ...(mac ? [{ label: app.name, submenu: [
                { role: "about" },
                ...updateItems,
                { type: "separator" },
                { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => onAssistant() },
                { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
            ] }] : []),
            { label: "File", submenu: [
                { label: "New Résumé", accelerator: "CmdOrCtrl+N", click: () => newDocument("resume") },
                { label: "New Cover Letter", accelerator: "Shift+CmdOrCtrl+N", click: () => newDocument("letter") },
                { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => openDialog() },
                { label: "Open Recent", enabled: openRecent.length > 0, submenu: [...openRecent, { type: "separator" }, { label: "Clear Menu", click: () => { KINDS.forEach((k) => { docs[k].recent = []; }); app.clearRecentDocuments(); persist(); buildMenu(); KINDS.forEach(emitRecent); } }] },
                { type: "separator" },
                { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("files:command", "save") },
                { label: "Save As…", accelerator: "Shift+CmdOrCtrl+S", click: () => send("files:command", "saveAs") },
                { type: "separator" },
                { label: mac ? "Show in Finder" : "Show in Folder", enabled: !!current, click: () => current && shell.showItemInFolder(current) },
                { type: "separator" },
                { label: "Settings…", accelerator: mac ? undefined : "CmdOrCtrl+,", click: () => onAssistant() },   // on a Mac ⌘, belongs to the app menu's copy
                ...(updates ? [{ label: "Check for Updates…", click: () => updates.check() }] : []),
                ...(mac ? [] : [{ type: "separator" }, { role: "quit" }]),
            ] },
            { role: "editMenu" },
            { label: "AI", submenu: [{ label: "Connect Your AI…", click: () => onAssistant() }, { label: "API Key (Advanced)…", click: () => onAssistant("advanced") }] },
            { label: "View", submenu: [
                // shown with their shortcuts but NOT registered: the key presses go to the page, which zooms the sheet (the % in the toolbar)
                { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", registerAccelerator: false, click: () => send("view:zoom", "in") },
                { label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => send("view:zoom", "out") },
                { label: "Fit Width", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => send("view:zoom", "fit") },
                { type: "separator" },
                { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }])] },
            { role: "windowMenu" },
            { role: "help", submenu: [{ label: "Connect your AI…", click: () => onAssistant() }, { label: "Welcome to IcedCoffee", click: () => onWelcome() }, ...(mac ? [] : [{ type: "separator" }, ...updateItems]), { type: "separator" }, { label: "IcedCoffee on the Web", click: () => shell.openExternal("https://qmanning.com/labs/icedcoffee") }, { label: "Source on GitHub", click: () => shell.openExternal("https://github.com/qmanning/icedcoffee") }] },
        ]));
    }

    return {
        /** call once per editor window */
        attach(window) {
            win = window; KINDS.forEach((k) => { docs[k].dirty = false; watch(k); }); title(); buildMenu();
            win.on("close", (e) => {
                const unsaved = KINDS.filter((k) => docs[k].dirty);
                if (!unsaved.length || smokeDir) return;
                const choice = dialog.showMessageBoxSync(win, { type: "question", noLink: true, message: `Save your changes to the ${unsaved.map((k) => LABEL[k]).join(" and the ")} before closing?`, detail: "Your edits are kept as a safety copy either way, but the file on disk won't have them.", buttons: ["Save", "Cancel", "Don't Save"], defaultId: 0, cancelId: 1 });
                if (choice === 2) return;
                e.preventDefault();
                if (choice === 0) { closeAfterSave = true; send("files:command", "saveAll"); }
            });
            win.on("closed", () => { KINDS.forEach((k) => { docs[k].watcher?.close(); docs[k].watcher = null; }); if (win === window) win = null; });
        },
        openPath, openDialog, openRemote, newRemote, writeDocument, recentList,
        /** `current` / `dirty` are the résumé's unless a kind is given — what callers meant before there were two documents */
        state: (kind = "resume") => ({ current: docs[asKind(kind)].current, dirty: docs[asKind(kind)].dirty, active }),
    };
}
