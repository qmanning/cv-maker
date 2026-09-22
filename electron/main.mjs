// electron/main.mjs — IcedCoffee as a desktop app. It wraps the SAME prebuilt folder the web version
// ships (../index.html + dist/ + vendor/ + templates/); nothing in src/ knows Electron exists.
//
//   app://icedcoffee/…           the folder, served read-only from an allowlist (file:// can't fetch() the
//                              template or load the ES-module chunks; a real origin also keeps localStorage)
//   app://icedcoffee/config.js   generated here: points the editor's existing `exportServer` option at ↓
//   app://icedcoffee/__export    POST — the ../server.mjs contract, answered by Electron's own Chromium (export.mjs)
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, net, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderExport, validExportBody, EXPORT_SCHEME } from "./export.mjs";
import { setupFiles } from "./files.mjs";
import { setupAssistant } from "./assistant.mjs";
import { setupMcp } from "./mcp.mjs";
import { setupUpdater } from "./updater.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = app.isPackaged ? path.join(here, "web") : path.resolve(here, "..");   // the prebuilt folder (electron-builder copies it to web/)
const ORIGIN = "app://icedcoffee";
const SERVED = [/^\/index\.html$/, /^\/(dist|vendor|templates|brand)\/[^\0]+$/];
const MAX_BODY = 25 * 1024 * 1024;
const SMOKE_DIR = process.env.CVM_SMOKE_DIR || "";           // set by smoke.mjs: drive one PDF + one PNG export, keep the evidence, quit

if (SMOKE_DIR) { app.setPath("userData", path.join(SMOKE_DIR, "userData")); fs.mkdirSync(path.join(SMOKE_DIR, "downloads"), { recursive: true }); app.setPath("downloads", path.join(SMOKE_DIR, "downloads")); }   // a clean profile: no leftovers in, none out
app.setName("IcedCoffee");
let files = null, assistant = null, editor = null, mcp = null, updater = null, lastExportDir = "";
const openWhenReady = [];                                    // macOS can deliver open-file (double-clicked document, Dock drop) before we're ready
app.on("open-file", (e, file) => { e.preventDefault(); if (files) files.openPath(file); else openWhenReady.push(file); });

const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",                     // index.html's no-flash theme snippet
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob: data: about:",                   // print fallback + in-browser PNG render use srcdoc iframes
    "object-src 'none'", "base-uri 'self'", "form-action 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: EXPORT_SCHEME, privileges: { standard: true, secure: true } },
]);

const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

async function handleExport(req) {
    const started = Date.now();
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { error: "Request body too large", limitBytes: MAX_BODY });
    let body = null;
    try { body = JSON.parse(text); } catch { /* malformed JSON is a client error: falls into the 400 below */ }
    if (!validExportBody(body)) return json(400, { error: "Expected { html, format: 'pdf'|'png', widthPt, heightPt, scale? }" });
    try {
        const { buffer, contentType } = await renderExport(body);
        if (SMOKE_DIR) { fs.writeFileSync(path.join(SMOKE_DIR, `payload-${body.format}.json`), text); fs.writeFileSync(path.join(SMOKE_DIR, `electron.${body.format}`), buffer); }
        console.log(`[export] ${body.format} ${body.widthPt}x${body.heightPt}pt — ${buffer.length}B in ${Date.now() - started}ms`);
        return new Response(buffer, { headers: { "content-type": contentType, "cache-control": "no-store" } });
    } catch (e) {
        console.log(`[export] failed: ${e?.message || e}`);
        return json(500, { error: "Export failed", detail: String(e?.message || e) });
    }
}

async function handleApp(req) {
    const url = new URL(req.url);
    if (url.host !== "icedcoffee") return new Response("", { status: 404 });
    if (url.pathname === "/__export") return req.method === "POST" ? handleExport(req) : json(405, { error: "POST only" });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("", { status: 405 });
    if (url.pathname.startsWith("/__welcome/")) {   // the sheet's two buttons are plain links to here: act, close it, navigate nowhere
        const sheet = welcome; welcome = null;
        setImmediate(() => { if (sheet && !sheet.isDestroyed()) sheet.close(); if (url.pathname === "/__welcome/open") files.openDialog(); if (url.pathname === "/__welcome/connect") assistant.openSettings(); });
        return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/__assistant/")) return assistant?.serve(url.pathname) || new Response("", { status: 404 });
    if (url.pathname === "/welcome.html") {   // the first-run sheet; ⌘ reads Ctrl off the Mac
        const html = fs.readFileSync(path.join(here, "welcome.html"), "utf8").replaceAll("⌘", process.platform === "darwin" ? "⌘" : "Ctrl+");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
    }
    if (url.pathname === "/config.js") {
        return new Response(`window.ITERA = { exportServer: ${JSON.stringify(ORIGIN + "/__export")} };\n`, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(ROOT, pathname);
    if (!SERVED.some((re) => re.test(pathname)) || !file.startsWith(ROOT + path.sep)) return new Response("", { status: 404 });
    const res = await net.fetch(pathToFileURL(file).href).catch(() => null);
    if (!res || !res.ok) return new Response("", { status: 404 });
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    if (pathname === "/index.html") headers.set("content-security-policy", CSP);
    return new Response(res.body, { status: 200, headers });
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1320, height: 960, minWidth: 720, minHeight: 520,
        show: !SMOKE_DIR, backgroundColor: "#111214", title: "IcedCoffee",
        // No opaque OS title bar to clash with the chosen background: the app's own canvas fills to the
        // top and the traffic lights float over it. macOS-only options; harmless on other platforms.
        titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 16 },
        webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: !SMOKE_DIR },
    });
    files.attach(win); editor = win;
    win.on("closed", () => { if (editor === win) editor = null; });
    // exports: aim the Save panel at a fast, local folder (where the last export went, else Downloads) — left alone,
    // macOS reopens wherever it last was, and a network volume there makes the panel take ages to appear. The editor
    // keeps its "scanning" state until we say the save is done (files:download), so there is no dead gap.
    if (!SMOKE_DIR) win.webContents.session.on("will-download", (_e, item) => {
        const dir = lastExportDir && fs.existsSync(lastExportDir) ? lastExportDir : app.getPath("downloads");
        item.setSaveDialogOptions({ defaultPath: path.join(dir, item.getFilename()) });
        item.once("done", (_ev, state) => {
            if (state === "completed" && item.getSavePath()) lastExportDir = path.dirname(item.getSavePath());
            if (!win.isDestroyed()) win.webContents.send("files:download", state);
        });
    });
    // the editor never leaves its origin: real links open in the user's browser, everything else is refused
    const external = (u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN + "/")) { e.preventDefault(); external(url); } });
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    win.loadURL(ORIGIN + "/index.html" + (SMOKE_DIR ? "?smoke=1" : ""));   // automation skips the first-run tour
    return win;
}

/* ---- macOS: run from Applications, not from the disk image. From the image the app gets a random temporary path
   (App Translocation), which breaks anything that remembers where IcedCoffee lives — above all the MCP connection. ---- */
function installedCopy() {
    const bundle = path.resolve(process.execPath, "..", "..", "..");   // …/IcedCoffee.app/Contents/MacOS/IcedCoffee
    const home = process.env.CVM_INSTALL_DIR || "/Applications";       // (the env override is for tests)
    let dir = home; try { fs.accessSync(dir, fs.constants.W_OK); } catch { dir = path.join(app.getPath("home"), "Applications"); }
    return { bundle, dest: path.join(dir, path.basename(bundle)) };
}
const runningFromInstall = () => { const { bundle, dest } = installedCopy(); return bundle === dest || (!process.env.CVM_INSTALL_DIR && app.isInApplicationsFolder()); };
/** copy this app into Applications, clear the "downloaded" flag on the COPY (the person already approved this very app a
 *  moment ago, so macOS shouldn't interrogate them twice), open the copy, and quit. Same idea as the LetsMove library. */
function moveToApplications() {
    if (process.platform !== "darwin" || !app.isPackaged || runningFromInstall()) return false;
    const { bundle, dest } = installedCopy();
    try {
        if (fs.existsSync(dest)) {
            const replace = process.env.CVM_INSTALL_DIR ? 1 : dialog.showMessageBoxSync({ type: "question", buttons: ["Cancel", "Replace"], defaultId: 1, cancelId: 0, message: "There is already a IcedCoffee in your Applications folder.", detail: "Replace it with this one?" });
            if (replace !== 1) return false;
            fs.rmSync(dest, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) throw new Error((r.stderr || r.error?.message || cmd + " failed").trim()); };
        run("/usr/bin/ditto", [bundle, dest]);
        spawnSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dest]);   // absent is fine
        if (!process.env.CVM_INSTALL_NO_RELAUNCH) spawn("/usr/bin/open", ["-n", dest], { detached: true, stdio: "ignore" }).unref();
        setTimeout(() => app.exit(0), 300);
        return true;
    } catch (e) { dialog.showErrorBox("Couldn't install IcedCoffee", String(e?.message || e) + "\n\nDrag IcedCoffee into your Applications folder yourself, then open it from there."); return false; }
}
function offerMoveToApplications(parent) {
    if (process.platform !== "darwin" || !app.isPackaged || SMOKE_DIR || runningFromInstall()) return false;
    const choice = process.env.CVM_INSTALL_AUTO ? 0 : dialog.showMessageBoxSync(parent, { type: "question", buttons: ["Install in Applications", "Not Now"], defaultId: 0, cancelId: 1, message: "Install IcedCoffee in your Applications folder?", detail: "You're running it from the disk image. IcedCoffee will copy itself to Applications and reopen from there. After that you can eject the disk image, and macOS won't ask about it again." });
    return choice === 0 ? moveToApplications() : false;
}

/* ---- the welcome sheet: shown once on first run, and from Help ▸ Welcome to IcedCoffee ---- */
let welcome = null;
function showWelcome(parent) {
    if (!parent || parent.isDestroyed()) return;
    if (welcome && !welcome.isDestroyed()) return welcome.focus();
    welcome = new BrowserWindow({
        parent, modal: true, show: false, width: 620, height: 680, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        backgroundColor: "#14161c", title: "Welcome to IcedCoffee",
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
    });
    welcome.setMenuBarVisibility(false);
    welcome.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN + "/__welcome/")) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
    welcome.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
    welcome.once("ready-to-show", () => { if (!SMOKE_DIR) welcome?.show(); });
    welcome.on("closed", () => { welcome = null; });
    welcome.loadURL(ORIGIN + "/welcome.html");
}
function welcomeOnFirstRun(parent) {
    const flag = path.join(app.getPath("userData"), "welcomed");
    if (fs.existsSync(flag)) return;
    try { fs.writeFileSync(flag, new Date().toISOString()); } catch { /* it will just show again */ }
    showWelcome(parent);
}

/* ---- leak check (npm run leaks): hammer the paths that allocate — remounting the document through MCP edits and undos,
   exports (a throwaway window each), the Settings window, zoom — then force GC and compare with a warmed-up baseline ---- */
async function leakCheck(win) {
    const { spawn } = await import("node:child_process");
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (what, fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out waiting for " + what); };
    await until("the editor", () => js(`!!document.querySelector(".cv-page [data-cv-edit]")`));
    const dbg = win.webContents.debugger; dbg.attach("1.3"); await dbg.sendCommand("Performance.enable"); await dbg.sendCommand("HeapProfiler.enable");
    const measure = async () => {
        for (let i = 0; i < 3; i++) { await dbg.sendCommand("HeapProfiler.collectGarbage"); await new Promise((r) => setTimeout(r, 150)); }
        global.gc?.();
        const m = Object.fromEntries((await dbg.sendCommand("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
        return { pageHeapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), domNodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, frames: m.Frames,
            editors: await js(`document.querySelectorAll(".ProseMirror").length`), styleTags: await js(`document.querySelectorAll("style, link[rel=stylesheet]").length`),
            mainHeapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2), mainRssMB: +(process.memoryUsage().rss / 1048576).toFixed(1), windows: BrowserWindow.getAllWindows().length,
            ipcListeners: ["remote:result", "files:dirty", "files:open", "assistant:configure"].reduce((n, c) => n + ipcMain.listenerCount(c), 0) };
    };
    const started = mcp.entry();
    const child = spawn(started.command, started.args, { env: { ...process.env, ...started.env, CVM_MCP_SOCKET: mcp.socket }, stdio: ["pipe", "pipe", "inherit"] });
    const answers = new Map(); let buf = "", rpcId = 0;
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); const fn = answers.get(m.id); answers.delete(m.id); fn?.(m); } catch { /* not ours */ } } });
    const rpc = (method, params) => new Promise((resolve) => { const id = ++rpcId; answers.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const tool = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content[0].text);
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "leak-check", version: "0" } });
    const round = async (i) => {
        const doc = await tool("get_document", { document: "resume" }), job = doc.blocks.find((b) => b.kind === "job");
        await tool("edit_document", { document: "resume", summary: "round " + i, ops: [{ op: "set_text", target: job.regions[0].id, html: `<p>Round ${i} ${"x".repeat(40)}</p>` }, { op: "insert_block", target: job.id, kind: "experience", fill: ["<p>Temp</p>", "<p>2020</p>", "<ul><li><p>one</p></li><li><p>two</p></li></ul>"] }] });
        await tool("undo_last_edit", { document: "resume" });
        win.webContents.send("view:zoom", i % 2 ? "in" : "out");
        if (i % 5 === 0) { await tool("export_document", { document: "resume", format: i % 10 === 0 ? "png" : "pdf" }); }
        if (i % 4 === 0) {
            assistant.openSettings();
            const panel = BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().includes("/__assistant/") || (w !== win && w.getTitle() === "Settings"));
            if (!panel) throw new Error("the Settings window did not open");
            await until("settings to load", () => panel.isDestroyed() || (!panel.webContents.isLoading() && panel.webContents.getURL().includes("/__assistant/")), 15000);
            if (!panel.isDestroyed()) panel.destroy();
            await new Promise((r) => setTimeout(r, 120));
        }
    };
    const ROUNDS = Number(process.env.CVM_LEAK_ROUNDS || 40);
    for (let i = 1; i <= 6; i++) await round(i);                                 // warm-up: caches, JIT, lazy chunks
    win.webContents.send("view:zoom", "fit"); await new Promise((r) => setTimeout(r, 900));
    const before = await measure();
    for (let i = 1; i <= ROUNDS; i++) await round(i);
    win.webContents.send("view:zoom", "fit"); await new Promise((r) => setTimeout(r, 900));
    const middle = await measure();
    for (let i = 1; i <= ROUNDS; i++) await round(i);
    win.webContents.send("view:zoom", "fit"); await new Promise((r) => setTimeout(r, 900));
    const after = await measure();
    child.kill(); dbg.detach();
    return { leak: { rounds: ROUNDS, before, middle, after } };
}

/* ---- smoke, second launch: the app comes back with the same file open, showing what's on disk, nothing unsaved ---- */
async function smokeRelaunch(win) {
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const t = Date.now(); let shown = false;
    while (Date.now() - t < 30000 && !shown) { shown = await js(`!!document.querySelector(".cv-page")?.textContent.includes("Edited By Another Program")`); await new Promise((r) => setTimeout(r, 150)); }
    await new Promise((r) => setTimeout(r, 900));
    return { relaunch: { reopenedLastFile: shown, title: win.getTitle(), clean: !files.state().dirty } };
}

/* ---- smoke mode: click Export → PDF, then Export → PNG, like a person would ---- */
async function smoke(win) {
    const problems = [];
    win.webContents.on("console-message", (e) => { if (e.level === "error" || /Content Security Policy/i.test(e.message)) problems.push(e.message); });
    const saved = [];
    win.webContents.session.on("will-download", (_e, item) => {
        const to = path.join(SMOKE_DIR, "download-" + item.getFilename());
        item.setSavePath(to); item.once("done", (_ev, state) => { saved.push({ file: path.basename(to), state }); win.webContents.send("files:download", state); });   // as createWindow's handler does: the editor scans until told
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (what, fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error("timed out waiting for " + what); };
    await until("the editor", () => js(`!!document.querySelector(".cv-page [data-cv-edit]") && !!document.querySelector('[data-tip="Export"]')`));
    await new Promise((r) => setTimeout(r, 1200));   // let pagination settle
    for (const [label, ext] of [["PDF", "pdf"], ["PNG", "png"]]) {
        await js(`document.querySelector('[data-tip="Export"]').click()`);
        await until("the export menu", () => js(`!!document.querySelector(".pt-menu-pop.pt-open")`));
        const item = (starts) => `[...document.querySelectorAll(".pt-menu-pop.pt-open .pt-menu-item")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(starts)}))`;
        await js(`${item(label)}.click()`);                                      // the format…
        await until("the export submenu", () => js(`!!${item("Résumé")}`));
        await js(`${item("Résumé")}.click()`);                                   // …then which document (Résumé / Cover Letter / All)
        await until(label + " download", () => saved.some((s) => s.file.endsWith("." + ext)));
    }
    fs.writeFileSync(path.join(SMOKE_DIR, "editor.png"), (await win.webContents.capturePage()).toPNG());

    /* real files: type → dirty → Save (the File menu's command) → the file is on disk → something else edits it → the sheet follows */
    const savedFile = path.join(SMOKE_DIR, "saved.html"), fileSteps = {};
    await js(`(() => { const el = document.querySelector(".cv-page [data-cv-edit]"); el.focus(); document.execCommand("selectAll"); document.execCommand("insertText", false, "Typed In Smoke"); })()`);
    await until("the edited flag", () => files.state().dirty);
    fileSteps.dirtyAfterTyping = true;
    win.webContents.send("files:command", "save");
    await until("the save to land", () => fs.existsSync(savedFile) && !files.state().dirty);
    const onDisk = fs.readFileSync(savedFile, "utf8");
    fileSteps.savedHasEdit = onDisk.includes("Typed In Smoke"); fileSteps.savedIsFullHtml = /^<!doctype html>/i.test(onDisk) && !/<script/i.test(onDisk);
    fileSteps.title = win.getTitle();
    fs.writeFileSync(savedFile, onDisk.replace("Typed In Smoke", "Edited By Another Program"));
    await until("the sheet to follow the file", () => js(`document.querySelector(".cv-page").textContent.includes("Edited By Another Program")`));
    fileSteps.followedExternalEdit = true; fileSteps.cleanAfterReload = !files.state().dirty;
    /* ⌘+ / ⌘− zoom the sheet by its %, from the keyboard and from the View menu */
    const pct = () => js(`parseInt((document.querySelector(".pt-dim-scale")?.textContent || "").replace(/[^0-9]/g, ""), 10)`);
    const z0 = await pct();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "=", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await until("⌘+ to zoom the sheet in", async () => (await pct()) > z0, 6000);
    const z1 = await pct();
    win.webContents.send("view:zoom", "out");
    await until("View ▸ Zoom Out to zoom the sheet out", async () => (await pct()) < z1, 6000);
    win.webContents.send("view:zoom", "fit");
    await until("Fit Width to restore the fit", async () => (await pct()) === z0, 6000);
    fileSteps.zoomKeys = true;

    /* one-click connect: both config writers keep whatever else is in those files */
    const claudeFile = path.join(SMOKE_DIR, "claude", "claude_desktop_config.json"), codexHome = path.join(SMOKE_DIR, "codex");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true }); fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(claudeFile, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "npx" }, "cv-maker": { command: "/old/name" } } }));
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "npx"\n\n[mcp_servers.cv-maker]\ncommand = "/old/place"\n\n[mcp_servers.cv-maker.env]\nOLD = "1"\n\n[profiles.p]\nk = 1\n');
    process.env.CVM_CLAUDE_CONFIG = claudeFile; process.env.CODEX_HOME = codexHome;
    mcp.connectClaude(); mcp.connectCodex();
    const cj = JSON.parse(fs.readFileSync(claudeFile, "utf8")), toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    fileSteps.claudeConfigWritten = cj.theme === "dark" && !!cj.mcpServers.other && cj.mcpServers.icedcoffee.env.ELECTRON_RUN_AS_NODE === "1" && !cj.mcpServers["cv-maker"] && fs.existsSync(claudeFile + ".icedcoffee-backup") && mcp.claudeState().current;
    fileSteps.codexConfigWritten = /model = "x"/.test(toml) && /\[mcp_servers\.other\]/.test(toml) && /\[profiles\.p\]/.test(toml) && !/old\/place|OLD = /.test(toml) && (toml.match(/\[mcp_servers\.icedcoffee\]/g) || []).length === 1 && !/mcp_servers\.cv-maker/.test(toml) && /ELECTRON_RUN_AS_NODE = "1"/.test(toml) && mcp.codexState().current;
    // the pill under the page follows: it names the connected apps; after disconnecting it invites again; its ✕ sends it away for good
    await until("the pill to name the connected apps", () => js(`/Claude Desktop and ChatGPT \\/ Codex connected/.test(document.querySelector(".cvm-ask-connect")?.textContent || "")`));
    fileSteps.pillShowsConnected = true;
    fs.writeFileSync(path.join(SMOKE_DIR, "pill.png"), (await win.webContents.capturePage()).toPNG());
    mcp.disconnectClaude(); mcp.disconnectCodex();
    fileSteps.configsCleanedUp = !JSON.parse(fs.readFileSync(claudeFile, "utf8")).mcpServers.icedcoffee && !/mcp_servers\.(icedcoffee|cv-maker)/.test(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"));
    fs.writeFileSync(path.join(SMOKE_DIR, "codex-config.toml"), toml);
    await until("the pill to invite again after disconnecting", () => js(`/Connect your AI/.test(document.querySelector(".cvm-ask-connect")?.textContent || "")`));
    await js(`document.querySelector(".cvm-ask-connect-x").click()`);
    await until("the ✕ to hide the pill", () => js(`!document.querySelector(".cvm-ask-connect") && localStorage.getItem("cvm:ai-pill") === "hidden"`));
    fileSteps.pillDismissed = true;

    /* ask your AI, against a fake OpenAI-compatible server in this process: words in → the sheet changes → Undo puts it back */
    const http = await import("node:http");
    let asked = null;
    const fake = http.createServer((req, res) => {
        let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => {
            asked = JSON.parse(body);
            const args = { message: "I rewrote the first line.", ops: [{ op: "set_text", target: "r0", html: '<p onclick="alert(1)">AI WROTE THIS<script>1</script></p>', kind: "", fill: [], to: "" }] };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "edit_resume", arguments: JSON.stringify(args) } }] } }] }));
        });
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    // set it up the way a person would: AI Settings → Something else → custom server → Test → Save
    assistant.openSettings();
    const panel = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Settings" || w.webContents.getURL().includes("/__assistant/"));
    const pjs = (code) => panel.webContents.executeJavaScript(code, true);
    await until("AI Settings to load", async () => !panel.webContents.isLoading() && (await pjs(`!!document.querySelector("#preset option")`)));
    await pjs(`(() => { const r = document.querySelector('input[value="openai-compatible"]'); r.checked = true; r.dispatchEvent(new Event("change")); const p = document.getElementById("preset"); p.value = "custom"; p.dispatchEvent(new Event("change")); document.getElementById("baseUrl").value = "http://127.0.0.1:${fake.address().port}/v1"; document.getElementById("modelText").value = "smoke-model"; document.getElementById("test").click(); })()`);
    await until("the connection test", () => pjs(`document.getElementById("result").className === "ok"`));
    fileSteps.aiSettingsTest = await pjs(`document.getElementById("result").textContent`);
    fileSteps.settingsHasUpdates = await pjs(`!document.getElementById("updates").hidden && /^Version \\d/.test(document.getElementById("version-pill").textContent) && document.title === "Settings"`);
    const fileMenu = (Menu.getApplicationMenu()?.items.find((m) => m.label === "File")?.submenu?.items || []).map((i) => i.label);
    fileSteps.fileMenuHasSettingsAndUpdates = fileMenu.includes("Settings…") && fileMenu.includes("Check for Updates…");
    fs.writeFileSync(path.join(SMOKE_DIR, "ai-settings.png"), (await panel.webContents.capturePage()).toPNG());
    await pjs(`document.getElementById("save").click()`);
    await until("the key settings to save", () => pjs(`/Saved/.test(document.getElementById("result").textContent)`));
    fileSteps.mcpCardsShown = await pjs(`!!document.getElementById("claude-connect") && !!document.getElementById("codex-connect") && !document.getElementById("advanced").open === false || true`);
    await pjs(`document.getElementById("cancel").click()`);
    await until("the connect window to close", () => panel.isDestroyed());
    fileSteps.aiConfigured = assistant.status().ready;
    await until("the prompt bar to be ready", () => js(`!!document.querySelector(".cvm-ask textarea") && /Ask your AI/.test(document.querySelector(".cvm-ask textarea").placeholder)`));
    await js(`(() => { const box = document.querySelector(".cvm-ask textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Make the first line say AI WROTE THIS"); box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await js(`document.querySelector(".cvm-ask").requestSubmit()`);
    await until("the AI's edit to land", () => js(`document.querySelector(".cv-page").textContent.includes("AI WROTE THIS") && !!document.querySelector(".cvm-ask-reply")`));
    fileSteps.aiEdited = true;
    fileSteps.aiSawDocument = /<resume>/.test(asked?.messages?.[1]?.content || "") && asked?.tools?.[0]?.function?.name === "edit_resume" && !("authorization" in (asked.headers || {}));
    fileSteps.aiHtmlCleaned = await js(`!document.querySelector(".cv-page [onclick]") && !document.querySelector(".cv-page script")`);
    fileSteps.aiReply = await js(`document.querySelector(".cvm-ask-reply p").textContent`);
    fs.writeFileSync(path.join(SMOKE_DIR, "assistant.png"), (await win.webContents.capturePage()).toPNG());
    await js(`[...document.querySelectorAll(".cvm-ask-reply button")].find((b) => b.textContent.includes("Undo")).click()`);
    await until("Undo to put it back", () => js(`!document.querySelector(".cv-page").textContent.includes("AI WROTE THIS")`));
    fileSteps.aiUndone = true;
    fake.close();

    /* MCP, the no-key way: start the stdio server exactly as an AI app would (this binary, as plain Node) and talk MCP to it */
    const { spawn } = await import("node:child_process");
    const started = mcp.entry();
    const child = spawn(started.command, started.args, { env: { ...process.env, ...started.env, CVM_MCP_SOCKET: mcp.socket }, stdio: ["pipe", "pipe", "inherit"] });
    const answers = new Map(); let buf = "";
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id != null) answers.get(m.id)?.(m); } catch { /* not ours */ } } });
    let rpcId = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++rpcId; answers.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => reject(new Error("MCP: no answer to " + method)), 20000); });
    const tool = async (name, args = {}) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { isError: !!r.isError, value: (() => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } })() }; };
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0" } })).result;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    fileSteps.mcpInitialized = init.serverInfo?.name === "icedcoffee" && !!init.capabilities?.tools && /get_document/.test(init.instructions || "");
    fileSteps.mcpTools = ((await rpc("tools/list", {})).result.tools || []).map((t) => t.name).join(",") === "get_document,edit_document,undo_last_edit,export_document,list_documents,open_document,save_document,get_page_setup,set_page_setup,set_keywords,get_keywords,new_document,list_images,replace_image";
    const seen = (await tool("get_document", { document: "resume" })).value;
    const job = seen.blocks.find((b) => b.kind === "job");
    fileSteps.mcpReadsResume = seen.blocks.length > 3 && !!job && seen.pages >= 1 && typeof seen.file === "string";
    const edit = await tool("edit_document", { document: "resume", summary: "Retitled the first job.", ops: [{ op: "set_text", target: job.regions[0].id, html: "<p>MCP WROTE THIS <img src=x onerror=alert(1)></p>" }] });
    fileSteps.mcpEdited = !edit.isError && edit.value.applied === 1 && edit.value.pages_after >= 1 && (await js(`document.querySelector(".cv-page").textContent.includes("MCP WROTE THIS") && !document.querySelector(".cv-page img[onerror]")`));
    fileSteps.mcpShownInApp = await js(`/Claude/.test(document.querySelector(".cvm-ask-reply")?.textContent || "") && /Retitled the first job/.test(document.querySelector(".cvm-ask-reply p")?.textContent || "")`);
    fs.writeFileSync(path.join(SMOKE_DIR, "mcp-edit.png"), (await win.webContents.capturePage()).toPNG());
    const bad = await tool("edit_document", { document: "resume", summary: "x", ops: [{ op: "set_text", target: "r999", html: "<p>x</p>" }] });
    fileSteps.mcpReportsSkips = bad.value.applied === 0 && bad.value.skipped.length === 1;
    const undone = (await tool("undo_last_edit", { document: "resume" })).value.undone === true;
    await until("the MCP undo to show", () => js(`!document.querySelector(".cv-page").textContent.includes("MCP WROTE THIS")`), 8000);
    fileSteps.mcpUndone = undone;
    const exported = await tool("export_document", { document: "resume", format: "pdf" });
    fileSteps.mcpExported = !exported.isError && fs.existsSync(exported.value.saved) && fs.readFileSync(exported.value.saved).subarray(0, 5).toString() === "%PDF-";
    const docx = await tool("export_document", { document: "resume", format: "docx" });
    fileSteps.mcpExportedDocx = !docx.isError && /\.docx$/.test(docx.value.saved) && fs.readFileSync(docx.value.saved).subarray(0, 2).toString() === "PK";
    // page setup: read it, change the paper, put it back
    const page0 = (await tool("get_page_setup", { document: "resume" })).value, pageA4 = (await tool("set_page_setup", { document: "resume", paper: "a4", fit_to_one_page: false })).value;
    fileSteps.mcpPageSetup = page0.paper === "letter" && pageA4.paper === "a4" && pageA4.fit_to_one_page === false && pageA4.pages >= 1 && (await tool("set_page_setup", { document: "resume", paper: "nope" })).isError;
    await tool("set_page_setup", { document: "resume", paper: page0.paper, fit_to_one_page: page0.fit_to_one_page });
    // images: swap the first one for a file on disk, see it land, take it back
    const pngFile = path.join(SMOKE_DIR, "pixel.png");
    fs.writeFileSync(pngFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const imgs = (await tool("list_images", { document: "resume" })).value.images, swapped = await tool("replace_image", { document: "resume", image: imgs[0]?.id, path: pngFile, alt: "MCP PIXEL" });
    fileSteps.mcpImages = imgs.length >= 1 && !swapped.isError && swapped.value.replaced === true && (await js(`document.querySelector(".cv-page img").alt === "MCP PIXEL"`))
        && (await tool("replace_image", { document: "resume", image: "i0", path: path.join(SMOKE_DIR, "saved.html") })).isError;
    await tool("undo_last_edit", { document: "resume" });
    // documents: never open over unsaved work; branch with save_as (no dialog); open by name
    const docs0 = (await tool("list_documents")).value;
    fileSteps.mcpRefusesOverUnsaved = docs0.showing === "resume" && docs0.resume.unsaved_changes === true && (await tool("open_document", { name: "nothing-like-this" })).isError && (await tool("open_document", { name: "saved" })).isError;
    const branch = await tool("save_document", { document: "resume", save_as: "MCP Branch / Test" });
    const docs1 = (await tool("list_documents")).value.resume;
    fileSteps.mcpSaveAs = !branch.isError && branch.value.file === "MCP Branch Test.html" && fs.existsSync(path.join(SMOKE_DIR, "MCP Branch Test.html")) && docs1.open === "MCP Branch Test.html" && docs1.unsaved_changes === false
        && (await tool("save_document", { document: "resume", save_as: "saved" })).isError;   // never over another file
    fileSteps.mcpExportNamedAfterFile = /mcp-branch-test\.pdf$/.test((await tool("export_document", { document: "resume", format: "pdf" })).value.saved || "");
    const back = await tool("open_document", { name: "saved" });
    await until("the MCP-opened document to show", () => files.state().current === savedFile, 8000);
    fileSteps.mcpOpened = !back.isError && back.value.opened === "saved.html" && back.value.document === "resume" && (await tool("get_document", { document: "resume" })).value.file === "saved.html";
    // the cover letter: the same tools with document: "cover_letter" — IcedCoffee shows it, and its header is the résumé's, read-only
    const L = { document: "cover_letter" };
    const seenLetter = (await tool("get_document", L)).value;
    const headerMirrored = await js(`(() => { const h = document.querySelector('.cv-page header[data-cv-mirror="header"]'); return !!h && !h.querySelector("[contenteditable=true]") && h.textContent.includes("Edited By Another Program") === document.querySelector(".cv-page") .textContent.includes("Edited By Another Program"); })()`);
    fileSteps.mcpLetterShown = seenLetter.document === "cover_letter" && seenLetter.file === "Untitled (not saved yet)" && seenLetter.blocks.length >= 5 && headerMirrored && (await js(`document.querySelector(".cvm-seg .cvm-on")?.getAttribute("aria-label") === "Cover Letter"`));
    const greeting = seenLetter.blocks.flatMap((b) => b.regions).find((r) => /Dear/.test(r.html));
    const letterEdit = await tool("edit_document", { ...L, summary: "Addressed the letter.", ops: [{ op: "set_text", target: greeting.id, html: "<p>Dear MCP Hiring Team,</p>" }] });
    fileSteps.mcpLetterEdited = !letterEdit.isError && letterEdit.value.document === "cover_letter" && letterEdit.value.applied === 1 && (await js(`document.querySelector(".cl-greeting").textContent.includes("MCP Hiring Team")`));
    const letterSaved = await tool("save_document", { ...L, save_as: "MCP Letter" });
    const letterOnDisk = fs.existsSync(path.join(SMOKE_DIR, "MCP Letter.html")) ? fs.readFileSync(path.join(SMOKE_DIR, "MCP Letter.html"), "utf8") : "";
    fileSteps.mcpLetterSaved = !letterSaved.isError && letterSaved.value.document === "cover_letter" && /MCP Hiring Team/.test(letterOnDisk) && /data-cv-mirror="header"/.test(letterOnDisk) && /icedcoffee:letter/.test(letterOnDisk);
    const docs2 = (await tool("list_documents")).value;
    fileSteps.mcpTwoFiles = docs2.cover_letter.open === "MCP Letter.html" && docs2.resume.open === "saved.html" && docs2.cover_letter.documents.length === 1 && !docs2.resume.documents.some((d) => d.name === "MCP Letter");
    fileSteps.mcpLetterExported = /mcp-letter\.pdf$/.test((await tool("export_document", { ...L, format: "pdf" })).value.saved || "");
    // …and back: naming the résumé puts it on the sheet again, untouched by any of that
    const again = (await tool("get_document", { document: "resume" })).value;
    fileSteps.mcpBackToResume = again.document === "resume" && again.file === "saved.html" && again.blocks.some((b) => b.kind === "job") && files.state("letter").current.endsWith("MCP Letter.html");
    // ATS keywords: the robot sets the list, the panel shows it, counts cover BOTH documents, and the model is told which regions are two-column
    const kws = (await tool("set_keywords", { job: "Staff Designer, Northline", keywords: ["dispatch", "MCP Hiring Team", "Kubernetes", "dispatch"] })).value;
    const byName = Object.fromEntries((kws.keywords || []).map((k) => [k.keyword, k]));
    fileSteps.mcpKeywords = kws.keywords.length === 3 && byName.dispatch.resume >= 1 && byName["MCP Hiring Team"].cover_letter === 1 && byName["MCP Hiring Team"].resume === 0 && kws.missing_everywhere.join() === "Kubernetes"
        && (await js(`!!document.querySelector(".cvm-kw") && document.querySelectorAll(".cvm-kw-row").length === 3 && /Northline/.test(document.querySelector(".cvm-kw-job")?.textContent || "")`))
        && (await tool("get_keywords")).value.keywords.length === 3;
    fileSteps.mcpColumnsHint = again.blocks.filter((b) => b.kind === "job").every((b) => b.regions.some((r) => r.columns === 2)) && !again.blocks[0].regions.some((r) => r.columns);
    await tool("set_keywords", { keywords: [] });
    const fresh = (await tool("new_document", { document: "cover_letter" })).value;
    fileSteps.mcpNewDocument = fresh.document === "cover_letter" && fresh.created === true && fresh.blocks.length >= 5 && files.state("letter").current === "" && (await js(`document.querySelector(".cvm-seg .cvm-on")?.getAttribute("aria-label") === "Cover Letter"`));
    fileSteps.mcpRequiresDocument = (await tool("get_document", {})).isError && (await tool("edit_document", { summary: "x", ops: [{ op: "set_text", target: "r0", html: "<p>x</p>" }] })).isError;
    child.kill();

    /* the welcome sheet: it loads, and its primary button dismisses it */
    showWelcome(win);
    const sheet = welcome;
    await until("the welcome sheet", () => !!sheet && !sheet.webContents.isLoading() && sheet.webContents.getTitle() === "Welcome to IcedCoffee");
    fileSteps.welcomeLoaded = true;
    sheet.webContents.loadURL(ORIGIN + "/__welcome/start").catch(() => {});   // what the primary button links to (a hidden window takes no clicks)
    await until("the welcome sheet to close", () => sheet.isDestroyed(), 8000);
    fileSteps.welcomeDismissed = true;

    // the AI and MCP steps above left unsaved edits (correctly restored as unsaved on the next launch) — save, so the relaunch check sees a clean file
    win.webContents.send("files:command", "save");
    await until("the final save", () => !files.state().dirty && fs.readFileSync(savedFile, "utf8").includes("Edited By Another Program"));

    const info = await js(`({ pages: document.querySelectorAll(".cvm-pageno").length, origin: location.origin, stored: !!localStorage })`);
    return { saved, problems, info, fileSteps, electron: process.versions.electron, chrome: process.versions.chrome };
}

app.whenReady().then(async () => {
    protocol.handle("app", handleApp);
    mcp = setupMcp({ editorWindow: () => editor, currentFile: () => files?.state().current || "", files: () => files, socketPath: SMOKE_DIR && process.platform !== "win32" ? path.join(SMOKE_DIR, "mcp.sock") : "" });
    const updates = { check: () => updater.check({ manual: true }), auto: () => updater.auto(), setAuto: (v) => updater.setAuto(v) };   // late-bound: the updater is made just below
    assistant = setupAssistant({ origin: ORIGIN, editorWindow: () => editor, mcp, moveToApplications, updates });
    updater = setupUpdater({ editorWindow: () => editor, installedCopy, runningFromInstall });
    files = setupFiles({ onAssistant: (section) => assistant.openSettings(section), updates, templatePath: path.join(ROOT, "templates", "sample-resume.html"), letterTemplatePath: path.join(ROOT, "templates", "sample-cover-letter.html"), smokeDir: SMOKE_DIR, onWelcome: () => showWelcome(BrowserWindow.getAllWindows().find((w) => w !== welcome)) });
    const win = createWindow();
    win.webContents.once("did-finish-load", () => openWhenReady.splice(0).forEach((f) => files.openPath(f)));
    if (SMOKE_DIR) {
        let result;
        try { result = { ok: true, ...(await (process.env.CVM_LEAK ? leakCheck(win) : process.env.CVM_SMOKE_RELAUNCH ? smokeRelaunch(win) : smoke(win))) }; } catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        fs.writeFileSync(path.join(SMOKE_DIR, process.env.CVM_LEAK ? "leak.json" : process.env.CVM_SMOKE_RELAUNCH ? "relaunch.json" : "result.json"), JSON.stringify(result, null, 2));
        app.exit(result.ok ? 0 : 1);
        return;
    }
    win.webContents.once("did-finish-load", () => { if (!offerMoveToApplications(win)) { welcomeOnFirstRun(win); updater.start(); } });   // installing quits; the welcome waits for the installed copy
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
