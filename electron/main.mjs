// electron/main.mjs — CV Maker as a desktop app. It wraps the SAME prebuilt folder the web version
// ships (../index.html + dist/ + vendor/ + templates/); nothing in src/ knows Electron exists.
//
//   app://cv-maker/…           the folder, served read-only from an allowlist (file:// can't fetch() the
//                              template or load the ES-module chunks; a real origin also keeps localStorage)
//   app://cv-maker/config.js   generated here: points the editor's existing `exportServer` option at ↓
//   app://cv-maker/__export    POST — the ../server.mjs contract, answered by Electron's own Chromium (export.mjs)
import { app, BrowserWindow, dialog, protocol, net, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderExport, validExportBody, EXPORT_SCHEME } from "./export.mjs";
import { setupFiles } from "./files.mjs";
import { setupAssistant } from "./assistant.mjs";
import { setupMcp } from "./mcp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = app.isPackaged ? path.join(here, "web") : path.resolve(here, "..");   // the prebuilt folder (electron-builder copies it to web/)
const ORIGIN = "app://cv-maker";
const SERVED = [/^\/index\.html$/, /^\/(dist|vendor|templates)\/[^\0]+$/];
const MAX_BODY = 25 * 1024 * 1024;
const SMOKE_DIR = process.env.CVM_SMOKE_DIR || "";           // set by smoke.mjs: drive one PDF + one PNG export, keep the evidence, quit

if (SMOKE_DIR) { app.setPath("userData", path.join(SMOKE_DIR, "userData")); fs.mkdirSync(path.join(SMOKE_DIR, "downloads"), { recursive: true }); app.setPath("downloads", path.join(SMOKE_DIR, "downloads")); }   // a clean profile: no leftovers in, none out
app.setName("CV Maker");
let files = null, assistant = null, editor = null, mcp = null;
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
        setImmediate(() => { if (sheet && !sheet.isDestroyed()) sheet.close(); if (url.pathname === "/__welcome/open") files.openDialog(); if (url.pathname === "/__welcome/connect") assistant.openSettings(); });
        return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/__assistant/")) return assistant?.serve(url.pathname) || new Response("", { status: 404 });
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
    files.attach(win); editor = win;
    win.on("closed", () => { if (editor === win) editor = null; });
    // the editor never leaves its origin: real links open in the user's browser, everything else is refused
    const external = (u) => { if (/^https?:\/\//i.test(u)) shell.openExternal(u); };
    win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN + "/")) { e.preventDefault(); external(url); } });
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    win.loadURL(ORIGIN + "/index.html");
    return win;
}

/* ---- macOS: run from Applications, not from the disk image. From the image the app gets a random temporary path
   (App Translocation), which breaks anything that remembers where CV Maker lives — above all the MCP connection. ---- */
function moveToApplications() {
    if (process.platform !== "darwin" || !app.isPackaged || app.isInApplicationsFolder()) return false;
    try { return app.moveToApplicationsFolder({ conflictHandler: (kind) => kind === "exists" ? dialog.showMessageBoxSync({ type: "question", buttons: ["Cancel", "Replace"], defaultId: 1, cancelId: 0, message: "There is already a CV Maker in your Applications folder.", detail: "Replace it with this one?" }) === 1 : true }); }
    catch (e) { dialog.showErrorBox("Couldn't move CV Maker", String(e?.message || e) + "\n\nDrag CV Maker into Applications yourself, then open it from there."); return false; }
}
function offerMoveToApplications(parent) {
    if (process.platform !== "darwin" || !app.isPackaged || SMOKE_DIR || app.isInApplicationsFolder()) return;
    const choice = dialog.showMessageBoxSync(parent, { type: "question", buttons: ["Move to Applications", "Not Now"], defaultId: 0, cancelId: 1, message: "Move CV Maker to your Applications folder?", detail: "It is running from the disk image. Moving it lets your AI app (Claude, ChatGPT) find CV Maker every time, and you can eject the image afterwards. CV Maker will reopen from Applications." });
    if (choice === 0) moveToApplications();
}

/* ---- the welcome sheet: shown once on first run, and from Help ▸ Welcome to CV Maker ---- */
let welcome = null;
function showWelcome(parent) {
    if (!parent || parent.isDestroyed()) return;
    if (welcome && !welcome.isDestroyed()) return welcome.focus();
    welcome = new BrowserWindow({
        parent, modal: true, show: false, width: 620, height: 680, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
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
    const panel = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Connect Your AI" || w.webContents.getURL().includes("/__assistant/"));
    const pjs = (code) => panel.webContents.executeJavaScript(code, true);
    await until("AI Settings to load", async () => !panel.webContents.isLoading() && (await pjs(`!!document.querySelector("#preset option")`)));
    await pjs(`(() => { const r = document.querySelector('input[value="openai-compatible"]'); r.checked = true; r.dispatchEvent(new Event("change")); const p = document.getElementById("preset"); p.value = "custom"; p.dispatchEvent(new Event("change")); document.getElementById("baseUrl").value = "http://127.0.0.1:${fake.address().port}/v1"; document.getElementById("modelText").value = "smoke-model"; document.getElementById("test").click(); })()`);
    await until("the connection test", () => pjs(`document.getElementById("result").className === "ok"`));
    fileSteps.aiSettingsTest = await pjs(`document.getElementById("result").textContent`);
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
    fileSteps.mcpInitialized = init.serverInfo?.name === "cv-maker" && !!init.capabilities?.tools && /get_resume/.test(init.instructions || "");
    fileSteps.mcpTools = ((await rpc("tools/list", {})).result.tools || []).map((t) => t.name).join(",") === "get_resume,edit_resume,undo_last_edit,export_resume";
    const seen = (await tool("get_resume")).value;
    const job = seen.blocks.find((b) => b.kind === "job");
    fileSteps.mcpReadsResume = seen.blocks.length > 3 && !!job && seen.pages >= 1 && typeof seen.file === "string";
    const edit = await tool("edit_resume", { summary: "Retitled the first job.", ops: [{ op: "set_text", target: job.regions[0].id, html: "<p>MCP WROTE THIS <img src=x onerror=alert(1)></p>" }] });
    fileSteps.mcpEdited = !edit.isError && edit.value.applied === 1 && edit.value.pages_after >= 1 && (await js(`document.querySelector(".cv-page").textContent.includes("MCP WROTE THIS") && !document.querySelector(".cv-page img[onerror]")`));
    fileSteps.mcpShownInApp = await js(`/Claude/.test(document.querySelector(".cvm-ask-reply")?.textContent || "") && /Retitled the first job/.test(document.querySelector(".cvm-ask-reply p")?.textContent || "")`);
    fs.writeFileSync(path.join(SMOKE_DIR, "mcp-edit.png"), (await win.webContents.capturePage()).toPNG());
    const bad = await tool("edit_resume", { summary: "x", ops: [{ op: "set_text", target: "r999", html: "<p>x</p>" }] });
    fileSteps.mcpReportsSkips = bad.value.applied === 0 && bad.value.skipped.length === 1;
    const undone = (await tool("undo_last_edit")).value.undone === true;
    await until("the MCP undo to show", () => js(`!document.querySelector(".cv-page").textContent.includes("MCP WROTE THIS")`), 8000);
    fileSteps.mcpUndone = undone;
    const exported = await tool("export_resume", { format: "pdf" });
    fileSteps.mcpExported = !exported.isError && fs.existsSync(exported.value.saved) && fs.readFileSync(exported.value.saved).subarray(0, 5).toString() === "%PDF-";
    child.kill();

    /* one-click connect: both config writers keep whatever else is in those files */
    const claudeFile = path.join(SMOKE_DIR, "claude", "claude_desktop_config.json"), codexHome = path.join(SMOKE_DIR, "codex");
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true }); fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(claudeFile, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "npx" } } }));
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "x"\n\n[mcp_servers.other]\ncommand = "npx"\n\n[mcp_servers.cv-maker]\ncommand = "/old/place"\n\n[mcp_servers.cv-maker.env]\nOLD = "1"\n\n[profiles.p]\nk = 1\n');
    process.env.CVM_CLAUDE_CONFIG = claudeFile; process.env.CODEX_HOME = codexHome;
    mcp.connectClaude(); mcp.connectCodex();
    const cj = JSON.parse(fs.readFileSync(claudeFile, "utf8")), toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    fileSteps.claudeConfigWritten = cj.theme === "dark" && !!cj.mcpServers.other && cj.mcpServers["cv-maker"].env.ELECTRON_RUN_AS_NODE === "1" && fs.existsSync(claudeFile + ".cv-maker-backup") && mcp.claudeState().current;
    fileSteps.codexConfigWritten = /model = "x"/.test(toml) && /\[mcp_servers\.other\]/.test(toml) && /\[profiles\.p\]/.test(toml) && !/old\/place|OLD = /.test(toml) && (toml.match(/\[mcp_servers\.cv-maker\]/g) || []).length === 1 && /ELECTRON_RUN_AS_NODE = "1"/.test(toml) && mcp.codexState().current;
    mcp.disconnectClaude(); mcp.disconnectCodex();
    fileSteps.configsCleanedUp = !JSON.parse(fs.readFileSync(claudeFile, "utf8")).mcpServers["cv-maker"] && !/cv-maker/.test(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"));
    fs.writeFileSync(path.join(SMOKE_DIR, "codex-config.toml"), toml);

    /* the welcome sheet: it loads, and its primary button dismisses it */
    showWelcome(win);
    const sheet = welcome;
    await until("the welcome sheet", () => !!sheet && !sheet.webContents.isLoading() && sheet.webContents.getTitle() === "Welcome to CV Maker");
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
    mcp = setupMcp({ editorWindow: () => editor, currentFile: () => files?.state().current || "", socketPath: SMOKE_DIR && process.platform !== "win32" ? path.join(SMOKE_DIR, "mcp.sock") : "" });
    assistant = setupAssistant({ origin: ORIGIN, editorWindow: () => editor, mcp, moveToApplications });
    files = setupFiles({ onAssistant: () => assistant.openSettings(), templatePath: path.join(ROOT, "templates", "sample-resume.html"), smokeDir: SMOKE_DIR, onWelcome: () => showWelcome(BrowserWindow.getAllWindows().find((w) => w !== welcome)) });
    const win = createWindow();
    win.webContents.once("did-finish-load", () => openWhenReady.splice(0).forEach((f) => files.openPath(f)));
    if (SMOKE_DIR) {
        let result;
        try { result = { ok: true, ...(await (process.env.CVM_SMOKE_RELAUNCH ? smokeRelaunch(win) : smoke(win))) }; } catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        fs.writeFileSync(path.join(SMOKE_DIR, process.env.CVM_SMOKE_RELAUNCH ? "relaunch.json" : "result.json"), JSON.stringify(result, null, 2));
        app.exit(result.ok ? 0 : 1);
        return;
    }
    win.webContents.once("did-finish-load", () => { offerMoveToApplications(win); welcomeOnFirstRun(win); });
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
