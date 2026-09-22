// electron/assistant.mjs — "ask your AI" for the desktop app. The person brings their own model; the key is
// encrypted with the operating system's keychain (safeStorage), lives only in this main process, and is sent
// to exactly one place: the provider they chose. The editor window never sees it — it sends words and the
// document over IPC and gets operations back (the contract is `CvAssistant` in ../src/cv-assistant.ts).
import { BrowserWindow, ipcMain, safeStorage, app, shell, clipboard } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANTHROPIC_DEFAULT, ANTHROPIC_MODELS, runAnthropic } from "./assistant/anthropic.mjs";
import { PRESETS, checkBaseUrl, runOpenAiCompatible } from "./assistant/openai-compatible.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function setupAssistant({ origin, editorWindow, mcp, moveToApplications = () => false, updates = null }) {
    const file = () => path.join(app.getPath("userData"), "assistant.json");
    let settings = { provider: "", preset: "", baseUrl: "", model: "", key: "" }, sessionKey = "", win = null;
    try { settings = { ...settings, ...JSON.parse(fs.readFileSync(file(), "utf8")) }; } catch { /* not set up yet */ }

    // Touching safeStorage makes macOS ask for the login password to open the keychain (twice, on an unsigned build).
    // People who connect their AI app over MCP never need it — so it is only ever touched when a key exists or is being saved.
    const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
    const canEncryptWithoutAsking = () => (process.platform === "linux" ? canEncrypt() : true);   // only Linux can genuinely lack a keyring
    let opened = { from: "", key: "" };   // decrypt once per saved key, not on every status check
    const apiKey = () => { if (sessionKey) return sessionKey; if (!settings.key) return ""; if (opened.from === settings.key) return opened.key; if (!canEncrypt()) return ""; try { opened = { from: settings.key, key: safeStorage.decryptString(Buffer.from(settings.key, "base64")) }; return opened.key; } catch { return ""; } };
    const preset = () => PRESETS.find((p) => p.id === settings.preset);
    const needsKey = () => settings.provider === "anthropic" || !!preset()?.needsKey;
    const status = () => {
        const ready = !!settings.provider && !!settings.model && (!needsKey() || !!apiKey()) && (settings.provider === "anthropic" || !!settings.baseUrl);
        const name = settings.provider === "anthropic" ? (ANTHROPIC_MODELS.find((m) => m.id === settings.model)?.label || settings.model) : `${settings.model} · ${preset()?.label.replace(/ \(.*/, "") || "custom"}`;
        return { ready, label: ready ? name : "" };
    };
    const broadcast = () => { const w = editorWindow(); if (w && !w.isDestroyed()) w.webContents.send("assistant:status-changed", status()); };
    const fromEditor = (e) => e.sender === editorWindow()?.webContents;
    const fromSettings = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

    const run = (cfg, request) => cfg.provider === "anthropic"
        ? runAnthropic({ apiKey: cfg.apiKey, model: cfg.model || ANTHROPIC_DEFAULT }, request)
        : runOpenAiCompatible({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model }, request);

    ipcMain.handle("assistant:status", (e) => (fromEditor(e) ? status() : { ready: false, label: "" }));
    ipcMain.on("assistant:configure", (e) => { if (fromEditor(e)) openSettings(); });
    ipcMain.handle("assistant:run", async (e, request) => {
        if (!fromEditor(e)) throw new Error("not allowed");
        if (!status().ready) throw new Error("Connect your AI first (AI Settings).");
        const prompt = String(request?.prompt || "").slice(0, 20000);
        if (!prompt.trim() || !request?.document || typeof request.document !== "object") throw new Error("Nothing to ask.");
        const started = Date.now();
        try {
            const out = await run({ ...settings, apiKey: apiKey() }, { prompt, document: request.document, keywords: Array.isArray(request.keywords) ? request.keywords.filter((k) => typeof k === "string").slice(0, 60) : [] });
            console.log(`[assistant] ${settings.provider}/${settings.model} — ${out.ops.length} op(s) in ${Date.now() - started}ms`);
            return out;
        } catch (err) { console.log(`[assistant] failed: ${err?.message || err}`); throw new Error(String(err?.message || err)); }   // a plain Error crosses IPC cleanly
    });

    /* ---- the settings window's side ---- */
    const publicSettings = () => ({ provider: settings.provider, preset: settings.preset, baseUrl: settings.baseUrl, model: settings.model, hasKey: !!settings.key || !!sessionKey, canEncrypt: canEncryptWithoutAsking(), presets: PRESETS, anthropicModels: ANTHROPIC_MODELS, anthropicDefault: ANTHROPIC_DEFAULT });
    function adopt(next) {
        const provider = next?.provider === "anthropic" ? "anthropic" : next?.provider === "openai-compatible" ? "openai-compatible" : "";
        if (!provider) throw new Error("Choose a provider.");
        const p = PRESETS.find((x) => x.id === next.preset);
        const model = String(next.model || "").trim() || (provider === "anthropic" ? ANTHROPIC_DEFAULT : "");
        if (!model) throw new Error("Enter the model's name.");
        const baseUrl = provider === "anthropic" ? "" : checkBaseUrl(String(next.baseUrl || p?.baseUrl || ""));
        const typed = typeof next.key === "string" ? next.key.trim() : "";
        return { provider, preset: provider === "anthropic" ? "" : (p?.id || "custom"), baseUrl, model, typed };
    }
    ipcMain.handle("assistant-settings:get", (e) => (fromSettings(e) ? publicSettings() : null));
    ipcMain.handle("assistant-settings:save", (e, next) => {
        if (!fromSettings(e)) throw new Error("not allowed");
        const { typed, ...rest } = adopt(next);
        const sameHome = rest.provider === settings.provider && rest.baseUrl === settings.baseUrl;
        let key = sameHome ? settings.key : "";            // a key never follows you to a different provider
        if (!sameHome) sessionKey = "";
        if (typed) { if (canEncrypt()) { key = safeStorage.encryptString(typed).toString("base64"); sessionKey = ""; } else { key = ""; sessionKey = typed; } }
        settings = { ...rest, key };
        fs.writeFileSync(file(), JSON.stringify(settings, null, 2), { mode: 0o600 });
        broadcast();
        return publicSettings();
    });
    ipcMain.handle("assistant-settings:test", async (e, next) => {
        if (!fromSettings(e)) throw new Error("not allowed");
        const { typed, ...cfg } = adopt(next);
        const sameHome = cfg.provider === settings.provider && cfg.baseUrl === settings.baseUrl;
        const out = await run({ ...cfg, apiKey: typed || (sameHome ? apiKey() : "") }, { prompt: "This is a connection test. Change nothing; reply with the single word OK in message.", document: { name: "Test", paper: "US Letter", pages: 1, fitScale: 1, blocks: [], other: [] } });
        return { ok: true, message: out.message.slice(0, 200) };
    });
    ipcMain.handle("assistant-settings:forget", (e) => {
        if (!fromSettings(e)) throw new Error("not allowed");
        settings = { provider: "", preset: "", baseUrl: "", model: "", key: "" }; sessionKey = "";
        fs.rmSync(file(), { force: true }); broadcast();
        return publicSettings();
    });
    // the no-key way (see mcp.mjs): this window is also where "Connect Claude Desktop" lives
    ipcMain.handle("assistant-settings:mcp-state", (e) => (fromSettings(e) ? mcp.state() : null));
    ipcMain.handle("assistant-settings:mcp-connect-claude", (e) => { if (!fromSettings(e)) throw new Error("not allowed"); mcp.connectClaude(); return mcp.state(); });
    ipcMain.handle("assistant-settings:mcp-disconnect-claude", (e) => { if (!fromSettings(e)) throw new Error("not allowed"); mcp.disconnectClaude(); return mcp.state(); });
    ipcMain.handle("assistant-settings:mcp-connect-codex", (e) => { if (!fromSettings(e)) throw new Error("not allowed"); mcp.connectCodex(); return mcp.state(); });
    ipcMain.handle("assistant-settings:mcp-disconnect-codex", (e) => { if (!fromSettings(e)) throw new Error("not allowed"); mcp.disconnectCodex(); return mcp.state(); });
    ipcMain.handle("assistant-settings:move-to-applications", (e) => { if (!fromSettings(e)) throw new Error("not allowed"); return moveToApplications(); });
    ipcMain.handle("assistant-settings:mcp-copy", (e, what) => { if (!fromSettings(e)) return false; const m = mcp.state(); clipboard.writeText(what === "claude-code" ? m.claudeCode : what === "codex" ? m.codexCommand : m.snippet); return true; });
    ipcMain.handle("assistant-settings:notes-get", (e) => (fromSettings(e) ? mcp.getNotes() : ""));
    ipcMain.handle("assistant-settings:notes-set", (e, text) => { if (!fromSettings(e)) throw new Error("not allowed"); return mcp.setNotes(text); });
    mcp.onChange(() => { if (win && !win.isDestroyed()) win.webContents.send("assistant-settings:mcp-changed", mcp.state()); });
    // Updates live in the same Settings window
    const updateState = () => ({ available: !!updates, auto: !!updates?.auto(), version: app.getVersion() });
    ipcMain.handle("assistant-settings:updates-get", (e) => (fromSettings(e) ? updateState() : null));
    ipcMain.handle("assistant-settings:updates-set", (e, on) => { if (!fromSettings(e)) throw new Error("not allowed"); updates?.setAuto(!!on); return updateState(); });
    ipcMain.on("assistant-settings:updates-check", (e) => { if (fromSettings(e)) updates?.check(); });
    ipcMain.on("assistant-settings:close", (e) => { if (fromSettings(e)) win?.close(); });

    function openSettings(section = "") {
        const parent = editorWindow(); if (!parent || parent.isDestroyed()) return;
        if (win && !win.isDestroyed()) { if (section) win.webContents.send("assistant-settings:show", section); return win.focus(); }
        win = new BrowserWindow({
            parent, modal: true, show: false, width: 580, height: 740, useContentSize: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
            backgroundColor: "#14161c", title: "Settings",
            webPreferences: { preload: path.join(here, "assistant", "settings-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        win.setMenuBarVisibility(false);
        win.webContents.on("will-navigate", (e, url) => { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); });
        win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: "deny" }; });
        win.once("ready-to-show", () => win?.show());
        win.on("closed", () => { win = null; });
        win.loadURL(origin + "/__assistant/settings.html" + (section ? "#" + encodeURIComponent(section) : ""));
    }

    return {
        openSettings, status,
        /** app://icedcoffee/__assistant/* — the settings page's own files */
        serve(pathname) {
            const name = { "/__assistant/settings.html": "settings.html", "/__assistant/settings.js": "settings.js" }[pathname];
            if (!name) return null;
            const type = name.endsWith(".js") ? "text/javascript" : "text/html";
            return new Response(fs.readFileSync(path.join(here, "assistant", name)), { headers: { "content-type": type + "; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'" } });
        },
    };
}
