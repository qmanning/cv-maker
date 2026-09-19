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

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");                       // the prebuilt folder
const ORIGIN = "app://cv-maker";
const SERVED = [/^\/index\.html$/, /^\/(dist|vendor|templates)\/[^\0]+$/];
const MAX_BODY = 25 * 1024 * 1024;
const SMOKE_DIR = process.env.CVM_SMOKE_DIR || "";           // set by smoke.mjs: drive one PDF + one PNG export, keep the evidence, quit

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
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: !SMOKE_DIR },
    });
    // the editor never leaves its origin: real links open in the user's browser, everything else is refused
    const external = (u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN + "/")) { e.preventDefault(); external(url); } });
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    win.loadURL(ORIGIN + "/index.html");
    return win;
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
    const info = await js(`({ pages: document.querySelectorAll(".cvm-pageno").length, origin: location.origin, stored: !!localStorage })`);
    return { saved, problems, info, electron: process.versions.electron, chrome: process.versions.chrome };
}

app.whenReady().then(async () => {
    protocol.handle("app", handleApp);
    const win = createWindow();
    if (SMOKE_DIR) {
        let result;
        try { result = { ok: true, ...(await smoke(win)) }; } catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        fs.writeFileSync(path.join(SMOKE_DIR, "result.json"), JSON.stringify(result, null, 2));
        app.exit(result.ok ? 0 : 1);
        return;
    }
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
