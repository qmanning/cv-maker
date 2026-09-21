// electron/mcp.mjs — the app's side of MCP. AI apps start mcp/server.mjs (stdio); that relays to this local
// socket, which only this user account can open; this forwards to the editor window and answers. No network
// port, no key. Also: "Connect Claude Desktop" — writing the one config entry so nobody edits JSON by hand.
import { app, ipcMain, shell } from "electron";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { renderExport } from "./export.mjs";
import { normalize } from "./assistant/prompt.mjs";
import { INSTRUCTIONS, TOOLS, callTool } from "./mcp/catalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = "itera";
const LEGACY_NAMES = ["cv-maker"];   // what this app called itself until September 2026 — cleaned up whenever we write a config

export function setupMcp({ editorWindow, currentFile, files = () => null, socketPath = "" }) {
    const SOCKET = socketPath || (process.platform === "win32" ? `\\\\.\\pipe\\itera-mcp-${os.userInfo().username}` : path.join(app.getPath("userData"), "mcp.sock"));
    let seq = 0, clients = 0, lastSeen = 0; const pending = new Map(), listeners = new Set();
    const changed = () => listeners.forEach((fn) => fn());

    /* ---- ask the editor (its handlers are CvRemoteHandlers in ../src/cv-assistant.ts, wired up in preload.cjs) ---- */
    ipcMain.on("remote:result", (e, m) => { if (e.sender !== editorWindow()?.webContents) return; const w = pending.get(m?.id); if (!w) return; pending.delete(m.id); m.ok ? w.resolve(m.value) : w.reject(new Error(m.error || "The editor couldn't do that.")); });
    const editor = (method, args = []) => new Promise((resolve, reject) => {
        const win = editorWindow(); if (!win || win.isDestroyed()) return reject(new Error("Itera has no résumé window open."));
        const id = ++seq; pending.set(id, { resolve, reject });
        win.webContents.send("remote:call", { id, method, args });
        setTimeout(() => { if (pending.delete(id)) reject(new Error("The editor didn't answer (is a résumé open?).")); }, 30000);
    });

    async function handle(method, params, clientName) {
        lastSeen = Date.now(); changed();
        // the catalogue comes from THIS app, not from the stdio process an AI app started hours ago (see mcp/catalog.mjs)
        if (method === "mcp:hello") return { app: "Itera", version: app.getVersion(), tools: TOOLS, instructions: INSTRUCTIONS };
        if (method === "mcp:call") return callTool(String(params?.name || ""), params?.args || {}, (inner, p) => handle(inner, p, clientName));
        const shellFiles = () => { const f = files(); if (!f) throw new Error("Itera is still starting. Try again in a moment."); return f; };
        const want = params?.document == null || params.document === "" ? null : (/letter/i.test(String(params.document)) ? "letter" : "resume");
        const named = (k) => (k === "letter" ? "cover_letter" : "resume");
        // anything that reads or changes a document acts on the one on the sheet — so put the one they named there first
        let kind = "resume";
        if (!["documents", "open", "keywords_get", "keywords_set"].includes(method)) kind = await editor("showDocument", [want]);
        if (method === "describe") {
            const cur = files()?.state(kind).current ?? currentFile();
            const { document: _shown, ...doc } = await editor("describe");
            return { document: named(kind), file: cur ? path.basename(cur) : "Untitled (not saved yet)", ...doc };
        }
        if (method === "apply") {
            const { ops, message } = normalize({ ops: params?.ops, message: params?.summary });
            const out = await editor("apply", [ops, message, clientName]);
            return { document: named(kind), applied: out.applied, skipped: out.skipped, pages_before: out.pagesBefore, pages_after: out.pagesAfter, fit_scale: out.fitScale };
        }
        if (method === "undo") return { document: named(kind), undone: await editor("undo") };
        if (method === "export") {
            const format = ["png", "docx", "html"].includes(params?.format) ? params.format : "pdf";
            let base, buffer;
            if (format === "docx" || format === "html") {   // the editor renders these itself
                const out = await editor("exportFile", [format]);
                base = String(out.name).replace(/\.[a-z]+$/i, ""); buffer = out.base64 ? Buffer.from(out.data, "base64") : Buffer.from(String(out.data), "utf8");
            } else {
                const payload = await editor("exportPayload");
                base = payload.name; ({ buffer } = await renderExport({ ...payload, format, scale: 2 }));
            }
            let file = path.join(app.getPath("downloads"), `${base}.${format}`);
            for (let n = 2; fs.existsSync(file); n++) file = path.join(app.getPath("downloads"), `${base}-${n}.${format}`);
            fs.writeFileSync(file, buffer);
            return { document: named(kind), saved: file };
        }
        if (method === "documents") {
            const f = shellFiles(), one = (k) => { const st = f.state(k); return { open: st.current ? path.basename(st.current) : null, open_path: st.current || null, unsaved_changes: !!st.dirty, documents: f.recentList(k).map((r) => ({ name: r.name, path: r.path, master: !!r.pinned })) }; };
            return { showing: named(f.state().active), resume: one("resume"), cover_letter: one("letter") };
        }
        if (method === "open") {
            const out = shellFiles().openRemote(params?.name ?? params?.document, params?.name != null ? (want || "") : "");
            if (!out.already_open) await new Promise((r) => setTimeout(r, 900));   // let the editor mount it before the next get_resume
            return out;
        }
        if (method === "save") {
            const f = shellFiles(), { html } = await editor("sourceHtml");
            const out = f.writeDocument(html, { saveAs: typeof params?.save_as === "string" ? params.save_as : "", kind });
            await editor("markSaved", [out.file]);
            return { document: named(kind), saved: out.path, file: out.file };
        }
        const kwOut = (k) => ({ job: k.job, keywords: k.keywords.map((u) => ({ keyword: u.keyword, resume: u.resume, cover_letter: u.letter })), missing_everywhere: k.keywords.filter((u) => !u.resume && !u.letter).map((u) => u.keyword) });
        if (method === "keywords_get") return kwOut(await editor("getKeywords"));
        if (method === "keywords_set") {
            if (!Array.isArray(params?.keywords)) throw new Error("keywords must be a list of words or short phrases.");
            return kwOut(await editor("setKeywords", [params.keywords.filter((k) => typeof k === "string"), typeof params?.job === "string" ? params.job : null]));
        }
        const pageOut = (p) => ({ paper: p.paper, paper_label: p.paperLabel, papers: p.papers, fit_to_one_page: p.fit, paginate: p.paginate, zoom: p.zoom, zoom_percent: p.zoomPercent, pages: p.pages, fit_scale: p.fitScale });
        if (method === "page_get") return pageOut(await editor("getPage"));
        if (method === "page_set") return pageOut(await editor("setPage", [{ paper: params?.paper, fit: params?.fit_to_one_page, paginate: params?.paginate, zoom: params?.zoom }]));
        if (method === "images") return { images: await editor("listImages") };
        if (method === "image_set") {
            const file = String(params?.path || ""), ext = path.extname(file).slice(1).toLowerCase();
            const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext];
            if (!path.isAbsolute(file) || !mime) throw new Error("path must be an absolute path to a .png, .jpg, .gif, .webp or .svg file on this computer.");
            let stat; try { stat = fs.statSync(file); } catch { throw new Error(`There is no file at ${file}.`); }
            if (stat.size > 8 * 1024 * 1024) throw new Error("That image is over 8 MB — it gets embedded in the résumé file, so use a smaller one.");
            const out = await editor("setImage", [String(params?.image || ""), `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`, typeof params?.alt === "string" ? params.alt : null, clientName]);
            return { replaced: out.replaced, pages_before: out.pagesBefore, pages_after: out.pagesAfter };
        }
        throw new Error("unknown method " + method);
    }

    const server = net.createServer((sock) => {
        clients++; changed();
        readline.createInterface({ input: sock }).on("line", async (line) => {
            let m; try { m = JSON.parse(line); } catch { return; }
            try { let result = await handle(m.method, m.params, String(m.client || "Your AI").slice(0, 40));
                // a stdio server from BEFORE the relay (its AI app hasn't been restarted since Itera was updated) can't learn about new
                // tools — so say it where the model will read it, and the model can tell the person
                if (!m.relay && m.method === "describe" && result && typeof result === "object") result = { itera_notice: `Itera was updated to ${app.getVersion()} and has tools this connection cannot see yet (cover letter, documents, page setup, images, ATS keywords). Tell the person: quit and reopen this AI app once (not just reconnect) to get them.`, ...result };
                sock.write(JSON.stringify({ id: m.id, result }) + "\n"); }
            catch (e) { sock.write(JSON.stringify({ id: m.id, error: String(e?.message || e) }) + "\n"); }
        });
        const gone = () => { clients = Math.max(0, clients - 1); changed(); };
        sock.once("close", gone); sock.on("error", () => {});
    });
    if (process.platform !== "win32") fs.rmSync(SOCKET, { force: true });   // a stale socket from a crash
    server.on("error", (e) => console.log("[mcp] socket error: " + e.message));
    server.listen(SOCKET, () => { if (process.platform !== "win32") { try { fs.chmodSync(SOCKET, 0o600); } catch { /* best effort */ } } console.log("[mcp] listening on " + SOCKET); });
    app.on("will-quit", () => { server.close(); if (process.platform !== "win32") fs.rmSync(SOCKET, { force: true }); });

    /* ---- how an AI app should start the server: this app's own binary, as plain Node ---- */
    const serverScript = app.isPackaged ? path.join(process.resourcesPath, "mcp", "server.mjs") : path.join(here, "mcp", "server.mjs");
    // macOS runs a quarantined app that hasn't been moved by the person from a random, temporary, read-only path
    // ("App Translocation"), and a disk image goes away when ejected — neither is a path to hand to another app
    const temporaryHome = () => app.isPackaged && (/\/AppTranslocation\//.test(process.execPath) || process.execPath.startsWith("/Volumes/"));
    const needsMove = "Install Itera in your Applications folder first. Right now it is running from the disk image, so your AI app would lose track of it after a restart.";
    const entry = () => ({ command: process.execPath, args: [serverScript], env: { ELECTRON_RUN_AS_NODE: "1" } });

    const claudeConfigPath = () => process.env.CVM_CLAUDE_CONFIG ? process.env.CVM_CLAUDE_CONFIG : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude", "claude_desktop_config.json");
    const readClaude = () => { try { return JSON.parse(fs.readFileSync(claudeConfigPath(), "utf8")); } catch { return null; } };
    function claudeState() {
        const file = claudeConfigPath(), installed = fs.existsSync(path.dirname(file)), mine = readClaude()?.mcpServers?.[SERVER_NAME];
        const current = !!mine && mine.command === entry().command && mine.args?.[0] === entry().args[0];
        return { installed, connected: !!mine, current };
    }
    function connectClaude() {
        if (temporaryHome()) throw new Error(needsMove);
        const file = claudeConfigPath();
        if (!fs.existsSync(path.dirname(file))) throw new Error("Claude Desktop doesn't seem to be installed on this computer.");
        let config = {};
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, "utf8");
            try { config = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error("Claude's settings file isn't valid JSON, so Itera left it alone. Use “Copy the settings” instead."); }
            fs.writeFileSync(file + ".itera-backup", raw);
        }
        if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
        config.mcpServers = { ...(config.mcpServers || {}), [SERVER_NAME]: entry() };
        for (const old of LEGACY_NAMES) delete config.mcpServers[old];
        fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
        return claudeState();
    }
    function disconnectClaude() {
        const config = readClaude(); if (!config?.mcpServers?.[SERVER_NAME]) return claudeState();
        delete config.mcpServers[SERVER_NAME]; for (const old of LEGACY_NAMES) delete config.mcpServers[old];
        fs.writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2) + "\n");
        return claudeState();
    }

    /* ---- ChatGPT desktop app / Codex CLI / Codex IDE extension: one shared TOML file ---- */
    const codexConfigPath = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
    const codexBlock = () => { const e = entry(); return `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(e.command)}\nargs = ${JSON.stringify(e.args)}\n\n[mcp_servers.${SERVER_NAME}.env]\nELECTRON_RUN_AS_NODE = "1"\n`; };
    // drop our tables: from each of our headers up to the next table header that isn't ours (no TOML parser needed)
    const stripOurs = (raw) => { let skipping = false; return raw.split("\n").filter((line) => { if (/^\s*\[/.test(line)) skipping = [SERVER_NAME, ...LEGACY_NAMES].some((n) => new RegExp(`^\\s*\\[mcp_servers\\.${n}(\\.[^\\]]+)?\\]`).test(line)); return !skipping; }).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(); };
    const readCodex = () => { try { return fs.readFileSync(codexConfigPath(), "utf8"); } catch { return null; } };
    function codexState() {
        const raw = readCodex(), installed = fs.existsSync(path.dirname(codexConfigPath())), connected = !!raw && new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, "m").test(raw);
        return { installed, connected, current: connected && raw.includes(`command = ${JSON.stringify(entry().command)}`) && raw.includes(JSON.stringify(entry().args[0])) };
    }
    function connectCodex() {
        if (temporaryHome()) throw new Error(needsMove);
        const file = codexConfigPath();
        if (!fs.existsSync(path.dirname(file))) throw new Error("ChatGPT / Codex doesn't seem to be set up on this computer yet.");
        const raw = readCodex() ?? "";
        if (raw) fs.writeFileSync(file + ".itera-backup", raw);
        const rest = stripOurs(raw);
        fs.writeFileSync(file, (rest ? rest + "\n\n" : "") + codexBlock());
        return codexState();
    }
    function disconnectCodex() {
        const raw = readCodex(); if (raw == null) return codexState();
        fs.writeFileSync(codexConfigPath(), stripOurs(raw) + "\n");
        return codexState();
    }

    // what the editor's pill shows: which apps have been told about Itera, and how many are attached right now
    const editorStatus = () => ({ apps: [claudeState().connected && claudeState().current ? "Claude Desktop" : "", codexState().connected && codexState().current ? "ChatGPT / Codex" : ""].filter(Boolean), live: clients });
    const tellEditor = () => { const w = editorWindow(); if (w && !w.isDestroyed()) w.webContents.send("remote:status-changed", editorStatus()); };
    ipcMain.handle("remote:status", (e) => (e.sender === editorWindow()?.webContents ? editorStatus() : { apps: [], live: 0 }));
    listeners.add(tellEditor);
    const andTell = (fn) => (...args) => { const out = fn(...args); changed(); return out; };

    return {
        codexState, connectCodex: andTell(connectCodex), disconnectCodex: andTell(disconnectCodex),
        socket: SOCKET, entry, claudeState, connectClaude: andTell(connectClaude), disconnectClaude: andTell(disconnectClaude), editorStatus,
        state: () => ({ needsMove: temporaryHome() ? needsMove : "", claude: claudeState(), codex: codexState(), codexCommand: `codex mcp add ${SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${JSON.stringify(entry().command)} ${JSON.stringify(entry().args[0])}`, clients, lastSeen, snippet: JSON.stringify({ mcpServers: { [SERVER_NAME]: entry() } }, null, 2), claudeCode: `claude mcp add ${SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${JSON.stringify(entry().command)} ${JSON.stringify(entry().args[0])}` }),
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        revealClaudeConfig: () => shell.showItemInFolder(claudeConfigPath()),
    };
}
