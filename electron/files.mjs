// electron/files.mjs — real files for the desktop app. The document is one Source HTML file on disk:
// Open / Open Recent / drop-in, Save / Save As, an edited dot in the title bar, a guard on close, and a
// watcher — so when something else edits the file (your AI assistant, another editor), the sheet follows.
// The editor side of this contract is `CvFiles` in ../src/CvMaker.tsx; preload.cjs is the wire between them.
import { app, dialog, ipcMain, Menu, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_FILE = 25 * 1024 * 1024;
const FILTERS = [{ name: "Résumé (HTML)", extensions: ["html", "htm"] }];
const hash = (text) => crypto.createHash("sha1").update(text).digest("hex");

export function setupFiles({ templatePath, smokeDir = "", onWelcome = () => {}, onAssistant = () => {} }) {
    const statePath = () => path.join(app.getPath("userData"), "files.json");
    let win = null, current = "", dirty = false, known = "", watcher = null, watchTimer = null, closeAfterSave = false, recent = [];
    try { const s = JSON.parse(fs.readFileSync(statePath(), "utf8")); recent = (s.recent || []).filter((p) => typeof p === "string"); if (s.current && fs.existsSync(s.current)) current = s.current; } catch { /* first run */ }

    const persist = () => { try { fs.writeFileSync(statePath(), JSON.stringify({ current, recent }, null, 2)); } catch { /* not worth a dialog */ } };
    const title = () => {
        if (!win || win.isDestroyed()) return;
        win.setTitle((current ? path.basename(current) : "Untitled") + (dirty && process.platform !== "darwin" ? " •" : "") + " — CV Maker");
        win.setRepresentedFilename(current || ""); win.setDocumentEdited(dirty);   // macOS: the proxy icon and the dot in the close button
    };
    const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
    const ask = (options) => (smokeDir ? 0 : dialog.showMessageBoxSync(win, { type: "question", noLink: true, ...options }));

    function watch() {
        watcher?.close(); watcher = null;
        if (!current) return;
        // watch the folder, not the file: editors (and our own save) replace the file, which orphans a file watcher
        const dir = path.dirname(current), base = path.basename(current);
        try { watcher = fs.watch(dir, (_evt, name) => { if (!name || name === base) { clearTimeout(watchTimer); watchTimer = setTimeout(changedOnDisk, 250); } }); } catch { /* unwatchable volume: Save still works */ }
    }
    function changedOnDisk() {
        let text; try { text = fs.readFileSync(current, "utf8"); } catch { return; }   // deleted or mid-write; the next event will tell
        if (hash(text) === known) return;                                              // our own save, or a touch
        if (dirty && ask({ message: `“${path.basename(current)}” changed on disk.`, detail: "You also have edits here that aren't saved. Reload the file and lose them, or keep yours?", buttons: ["Keep Mine", "Reload from Disk"], defaultId: 0, cancelId: 0 }) !== 1) { known = hash(text); return; }
        known = hash(text);
        send("files:opened", { text, name: path.basename(current), note: "Reloaded — the file changed on disk" });
    }

    function setCurrent(file, text) {
        current = file; known = text == null ? "" : hash(text);
        if (file) { recent = [file, ...recent.filter((p) => p !== file)].slice(0, 10); app.addRecentDocument(file); }
        persist(); watch(); title(); buildMenu();
    }
    const okToReplace = (verb) => !dirty || ask({ message: "You have unsaved changes.", detail: `${verb} anyway and lose them?`, buttons: ["Cancel", verb], defaultId: 0, cancelId: 0 }) === 1;

    function openPath(file) {
        if (!/\.html?$/i.test(file)) return;
        if (!okToReplace("Open")) return;
        let text;
        try { if (fs.statSync(file).size > MAX_FILE) throw new Error("That file is too large to be a résumé."); text = fs.readFileSync(file, "utf8"); }
        catch (e) { recent = recent.filter((p) => p !== file); persist(); buildMenu(); dialog.showErrorBox("Could not open the file", String(e?.message || e)); return; }
        dirty = false; setCurrent(file, text);
        send("files:opened", { text, name: path.basename(file) });
    }
    async function openDialog() {
        const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: FILTERS });
        if (!r.canceled && r.filePaths[0]) openPath(r.filePaths[0]);
    }
    function newDocument() {
        if (!okToReplace("Start New")) return;
        dirty = false; setCurrent("", null);
        send("files:opened", { text: fs.readFileSync(templatePath, "utf8"), name: "Résumé", note: "New résumé — Save (⌘S) to choose where it lives" });
    }

    ipcMain.handle("files:current", () => {
        if (!current) return null;
        try { const text = fs.readFileSync(current, "utf8"); known = hash(text); watch(); title(); return { text, name: path.basename(current) }; }
        catch { setCurrent("", null); return null; }
    });
    ipcMain.handle("files:save", async (_e, html, opts) => {
        let target = current;
        if (!target || opts.as) {
            if (smokeDir) target = path.join(smokeDir, "saved.html");
            else {
                const r = await dialog.showSaveDialog(win, { defaultPath: target || path.join(app.getPath("documents"), path.basename(opts.suggested)), filters: FILTERS });
                if (r.canceled || !r.filePath) { closeAfterSave = false; return null; }
                target = /\.html?$/i.test(r.filePath) ? r.filePath : r.filePath + ".html";
            }
        }
        const tmp = target + ".cvm-tmp";
        try { fs.writeFileSync(tmp, html); fs.renameSync(tmp, target); }   // never leave half a résumé behind
        catch (e) { fs.rmSync(tmp, { force: true }); closeAfterSave = false; throw new Error("Could not save: " + (e?.message || e)); }
        setCurrent(target, html);
        return path.basename(target);
    });
    ipcMain.on("files:open", () => openDialog());
    ipcMain.on("files:dropped", (_e, file) => { if (typeof file === "string" && file) openPath(file); });
    ipcMain.on("files:dirty", (_e, flag) => {
        dirty = !!flag; title();
        if (!dirty && closeAfterSave) { closeAfterSave = false; win?.close(); }
    });

    function buildMenu() {
        const mac = process.platform === "darwin";
        const openRecent = recent.filter((p) => fs.existsSync(p)).map((p) => ({ label: path.basename(p), sublabel: path.dirname(p), toolTip: p, click: () => openPath(p) }));
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            ...(mac ? [{ role: "appMenu" }] : []),
            { label: "File", submenu: [
                { label: "New Résumé", accelerator: "CmdOrCtrl+N", click: newDocument },
                { label: "Open…", accelerator: "CmdOrCtrl+O", click: openDialog },
                { label: "Open Recent", enabled: openRecent.length > 0, submenu: [...openRecent, { type: "separator" }, { label: "Clear Menu", click: () => { recent = []; app.clearRecentDocuments(); persist(); buildMenu(); } }] },
                { type: "separator" },
                { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("files:command", "save") },
                { label: "Save As…", accelerator: "Shift+CmdOrCtrl+S", click: () => send("files:command", "saveAs") },
                { type: "separator" },
                { label: mac ? "Show in Finder" : "Show in Folder", enabled: !!current, click: () => current && shell.showItemInFolder(current) },
                ...(mac ? [] : [{ type: "separator" }, { role: "quit" }]),
            ] },
            { role: "editMenu" },
            { label: "AI", submenu: [{ label: "Connect Your AI…", click: () => onAssistant() }] },
            { label: "View", submenu: [
                // shown with their shortcuts but NOT registered: the key presses go to the page, which zooms the sheet (the % in the toolbar)
                { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", registerAccelerator: false, click: () => send("view:zoom", "in") },
                { label: "Zoom Out", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: () => send("view:zoom", "out") },
                { label: "Fit Width", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: () => send("view:zoom", "fit") },
                { type: "separator" },
                { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }])] },
            { role: "windowMenu" },
            { role: "help", submenu: [{ label: "Welcome to CV Maker", click: () => onWelcome() }, { type: "separator" }, { label: "CV Maker on the Web", click: () => shell.openExternal("https://qmanning.com/labs/cv-maker") }, { label: "Source on GitHub", click: () => shell.openExternal("https://github.com/qmanning/cv-maker") }] },
        ]));
    }

    return {
        /** call once per editor window */
        attach(window) {
            win = window; dirty = false; title(); buildMenu(); watch();
            win.on("close", (e) => {
                if (!dirty || smokeDir) return;
                const choice = dialog.showMessageBoxSync(win, { type: "question", noLink: true, message: "Save your changes before closing?", detail: "Your edits are kept as a safety copy either way, but the file on disk won't have them.", buttons: ["Save", "Cancel", "Don't Save"], defaultId: 0, cancelId: 1 });
                if (choice === 2) return;
                e.preventDefault();
                if (choice === 0) { closeAfterSave = true; send("files:command", "save"); }
            });
            win.on("closed", () => { watcher?.close(); watcher = null; if (win === window) win = null; });
        },
        openPath, openDialog,
        state: () => ({ current, dirty }),
    };
}
