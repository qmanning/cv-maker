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

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = "cv-maker";

export function setupMcp({ editorWindow, currentFile, socketPath = "" }) {
    const SOCKET = socketPath || (process.platform === "win32" ? `\\\\.\\pipe\\cv-maker-mcp-${os.userInfo().username}` : path.join(app.getPath("userData"), "mcp.sock"));
    let seq = 0, clients = 0, lastSeen = 0; const pending = new Map(), listeners = new Set();
    const changed = () => listeners.forEach((fn) => fn());

    /* ---- ask the editor (its handlers are CvRemoteHandlers in ../src/cv-assistant.ts, wired up in preload.cjs) ---- */
    ipcMain.on("remote:result", (e, m) => { if (e.sender !== editorWindow()?.webContents) return; const w = pending.get(m?.id); if (!w) return; pending.delete(m.id); m.ok ? w.resolve(m.value) : w.reject(new Error(m.error || "The editor couldn't do that.")); });
    const editor = (method, args = []) => new Promise((resolve, reject) => {
        const win = editorWindow(); if (!win || win.isDestroyed()) return reject(new Error("CV Maker has no résumé window open."));
        const id = ++seq; pending.set(id, { resolve, reject });
        win.webContents.send("remote:call", { id, method, args });
        setTimeout(() => { if (pending.delete(id)) reject(new Error("The editor didn't answer (is a résumé open?).")); }, 30000);
    });

    async function handle(method, params, clientName) {
        lastSeen = Date.now(); changed();
        if (method === "describe") return { file: currentFile() ? path.basename(currentFile()) : "Untitled (not saved yet)", ...(await editor("describe")) };
        if (method === "apply") {
            const { ops, message } = normalize({ ops: params?.ops, message: params?.summary });
            const out = await editor("apply", [ops, message, clientName]);
            return { applied: out.applied, skipped: out.skipped, pages_before: out.pagesBefore, pages_after: out.pagesAfter, fit_scale: out.fitScale };
        }
        if (method === "undo") return { undone: await editor("undo") };
        if (method === "export") {
            const format = params?.format === "png" ? "png" : "pdf";
            const payload = await editor("exportPayload");
            const { buffer } = await renderExport({ ...payload, format, scale: 2 });
            let file = path.join(app.getPath("downloads"), `${payload.name}.${format}`);
            for (let n = 2; fs.existsSync(file); n++) file = path.join(app.getPath("downloads"), `${payload.name}-${n}.${format}`);
            fs.writeFileSync(file, buffer);
            return { saved: file };
        }
        throw new Error("unknown method " + method);
    }

    const server = net.createServer((sock) => {
        clients++; changed();
        readline.createInterface({ input: sock }).on("line", async (line) => {
            let m; try { m = JSON.parse(line); } catch { return; }
            try { sock.write(JSON.stringify({ id: m.id, result: await handle(m.method, m.params, String(m.client || "Your AI").slice(0, 40)) }) + "\n"); }
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
    const needsMove = "Move CV Maker into your Applications folder and open it from there first. Right now it is running from the disk image, so your AI app would lose track of it after a restart.";
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
            try { config = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error("Claude's settings file isn't valid JSON, so CV Maker left it alone. Use “Copy the settings” instead."); }
            fs.writeFileSync(file + ".cv-maker-backup", raw);
        }
        if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
        config.mcpServers = { ...(config.mcpServers || {}), [SERVER_NAME]: entry() };
        fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
        return claudeState();
    }
    function disconnectClaude() {
        const config = readClaude(); if (!config?.mcpServers?.[SERVER_NAME]) return claudeState();
        delete config.mcpServers[SERVER_NAME];
        fs.writeFileSync(claudeConfigPath(), JSON.stringify(config, null, 2) + "\n");
        return claudeState();
    }

    /* ---- ChatGPT desktop app / Codex CLI / Codex IDE extension: one shared TOML file ---- */
    const codexConfigPath = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
    const codexBlock = () => { const e = entry(); return `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(e.command)}\nargs = ${JSON.stringify(e.args)}\n\n[mcp_servers.${SERVER_NAME}.env]\nELECTRON_RUN_AS_NODE = "1"\n`; };
    // drop our tables: from each of our headers up to the next table header that isn't ours (no TOML parser needed)
    const stripOurs = (raw) => { let skipping = false; return raw.split("\n").filter((line) => { if (/^\s*\[/.test(line)) skipping = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_NAME}(\\.[^\\]]+)?\\]`).test(line); return !skipping; }).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd(); };
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
        if (raw) fs.writeFileSync(file + ".cv-maker-backup", raw);
        const rest = stripOurs(raw);
        fs.writeFileSync(file, (rest ? rest + "\n\n" : "") + codexBlock());
        return codexState();
    }
    function disconnectCodex() {
        const raw = readCodex(); if (raw == null) return codexState();
        fs.writeFileSync(codexConfigPath(), stripOurs(raw) + "\n");
        return codexState();
    }

    return {
        codexState, connectCodex, disconnectCodex,
        socket: SOCKET, entry, claudeState, connectClaude, disconnectClaude,
        state: () => ({ needsMove: temporaryHome() ? needsMove : "", claude: claudeState(), codex: codexState(), codexCommand: `codex mcp add ${SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${JSON.stringify(entry().command)} ${JSON.stringify(entry().args[0])}`, clients, lastSeen, snippet: JSON.stringify({ mcpServers: { [SERVER_NAME]: entry() } }, null, 2), claudeCode: `claude mcp add ${SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${JSON.stringify(entry().command)} ${JSON.stringify(entry().args[0])}` }),
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        revealClaudeConfig: () => shell.showItemInFolder(claudeConfigPath()),
    };
}
