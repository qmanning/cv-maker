// electron/main.mjs — CV Maker as a desktop app. It wraps the SAME prebuilt folder the web version
// ships (../index.html + dist/ + vendor/ + templates/); nothing in src/ knows Electron exists.
//
//   app://cv-maker/…           the folder, served read-only from an allowlist (file:// can't fetch() the
//                              template or load the ES-module chunks; a real origin also keeps localStorage)
//   app://cv-maker/config.js   generated here: points the editor's existing `exportServer` option at ↓
//   app://cv-maker/__export    POST — the ../server.mjs contract, answered by Electron's own Chromium (export.mjs)
import { app, BrowserWindow, protocol, net, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderExport, validExportBody, EXPORT_SCHEME } from "./export.mjs";
import { setupFiles } from "./files.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = app.isPackaged ? path.join(here, "web") : path.resolve(here, "..");   // the prebuilt folder (electron-builder copies it to web/)
const ORIGIN = "app://cv-maker";
const SERVED = [/^\/index\.html$/, /^\/(dist|vendor|templates)\/[^\0]+$/];
const MAX_BODY = 25 * 1024 * 1024;
const SMOKE_DIR = process.env.CVM_SMOKE_DIR || "";           // set by smoke.mjs: drive one PDF + one PNG export, keep the evidence, quit

if (SMOKE_DIR) app.setPath("userData", path.join(SMOKE_DIR, "userData"));   // a clean profile: no leftovers in, none out
app.setName("CV Maker");
let files = null;
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
    if (url.host !== "cv-maker") return new Response("", { status: 404 });
    if (url.pathname === "/__export") return req.method === "POST" ? handleExport(req) : json(405, { error: "POST only" });
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("", { status: 405 });
    if (url.pathname.startsWith("/__welcome/")) {   // the sheet's two buttons are plain links to here: act, close it, navigate nowhere
        const sheet = welcome; welcome = null;
        setImmediate(() => { if (sheet && !sheet.isDestroyed()) sheet.close(); if (url.pathname === "/__welcome/open") files.openDialog(); });
        return new Response(null, { status: 204 });
    }
    if (url.pathname === "/welcome.html") {   // the first-run sheet; ⌘ reads Ctrl off the Mac
        const html = fs.readFileSync(path.join(here, "welcome.html"), "utf8").replaceAll("⌘", process.platform === "darwin" ? "⌘" : "Ctrl+");
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
    }
    if (url.pathname === "/config.js") {
        return new Response(`window.CV_MAKER = { exportServer: ${JSON.stringify(ORIGIN + "/__export")} };\n`, { headers: { "content-type": "text/javascript; charset=utf-8" } });
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
        show: !SMOKE_DIR, backgroundColor: "#111214", title: "CV Maker",
        webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: !SMOKE_DIR },
    });
    files.attach(win);
    // the editor never leaves its origin: real links open in the user's browser, everything else is refused
    const external = (u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN + "/")) { e.preventDefault(); external(url); } });
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    win.loadURL(ORIGIN + "/index.html");
    return win;
}

/* ---- the welcome sheet: shown once on first run, and from Help ▸ Welcome to CV Maker ---- */
let welcome = null;
function showWelcome(parent) {
    if (!parent || parent.isDestroyed()) return;
    if (welcome && !welcome.isDestroyed()) return welcome.focus();
    welcome = new BrowserWindow({
        parent, modal: true, show: false, width: 600, height: 620, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        backgroundColor: "#14161c", title: "Welcome to CV Maker",
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
        item.setSavePath(to); item.once("done", (_ev, state) => saved.push({ file: path.basename(to), state }));
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const until = async (what, fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error("timed out waiting for " + what); };
    await until("the editor", () => js(`!!document.querySelector(".cv-page [data-cv-edit]") && !!document.querySelector('[data-tip="Export"]')`));
    await new Promise((r) => setTimeout(r, 1200));   // let pagination settle
    for (const [label, ext] of [["PDF", "pdf"], ["PNG", "png"]]) {
        await js(`document.querySelector('[data-tip="Export"]').click()`);
        await until("the export menu", () => js(`!!document.querySelector(".pt-menu-pop.pt-open")`));
        await js(`[...document.querySelectorAll(".pt-menu-pop.pt-open .pt-menu-item")].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
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
    /* the welcome sheet: it loads, and its primary button dismisses it */
    showWelcome(win);
    const sheet = welcome;
    await until("the welcome sheet", () => !!sheet && !sheet.webContents.isLoading() && sheet.webContents.getTitle() === "Welcome to CV Maker");
    fileSteps.welcomeLoaded = true;
    sheet.webContents.loadURL(ORIGIN + "/__welcome/start").catch(() => {});   // what the primary button links to (a hidden window takes no clicks)
    await until("the welcome sheet to close", () => sheet.isDestroyed(), 8000);
    fileSteps.welcomeDismissed = true;

    const info = await js(`({ pages: document.querySelectorAll(".cvm-pageno").length, origin: location.origin, stored: !!localStorage })`);
    return { saved, problems, info, fileSteps, electron: process.versions.electron, chrome: process.versions.chrome };
}

app.whenReady().then(async () => {
    protocol.handle("app", handleApp);
    files = setupFiles({ templatePath: path.join(ROOT, "templates", "sample-resume.html"), smokeDir: SMOKE_DIR, onWelcome: () => showWelcome(BrowserWindow.getAllWindows().find((w) => w !== welcome)) });
    const win = createWindow();
    win.webContents.once("did-finish-load", () => openWhenReady.splice(0).forEach((f) => files.openPath(f)));
    if (SMOKE_DIR) {
        let result;
        try { result = { ok: true, ...(await (process.env.CVM_SMOKE_RELAUNCH ? smokeRelaunch(win) : smoke(win))) }; } catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        fs.writeFileSync(path.join(SMOKE_DIR, process.env.CVM_SMOKE_RELAUNCH ? "relaunch.json" : "result.json"), JSON.stringify(result, null, 2));
        app.exit(result.ok ? 0 : 1);
        return;
    }
    win.webContents.once("did-finish-load", () => welcomeOnFirstRun(win));
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
