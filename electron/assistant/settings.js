// electron/assistant/settings.js — the AI Settings form. Talks only to window.cvAssistantSettings (settings-preload.cjs).
(async () => {
    const api = window.cvAssistantSettings, $ = (id) => document.getElementById(id);
    let s = await api.get();
    const KEY_LINKS = { anthropic: ["Get a key at console.anthropic.com", "https://console.anthropic.com/settings/keys"], openai: ["Get a key at platform.openai.com", "https://platform.openai.com/api-keys"], gemini: ["Get a key at aistudio.google.com", "https://aistudio.google.com/apikey"], openrouter: ["Get a key at openrouter.ai", "https://openrouter.ai/keys"] };

    for (const p of s.presets) $("preset").add(new Option(p.label, p.id));
    for (const m of s.anthropicModels) $("modelSelect").add(new Option(m.label, m.id));
    const provider = () => document.querySelector('input[name="provider"]:checked')?.value || "";
    const preset = () => s.presets.find((p) => p.id === $("preset").value);

    function paint() {
        const pv = provider(), claude = pv === "anthropic", other = pv === "openai-compatible", p = preset();
        $("row-preset").hidden = !other; $("row-url").hidden = !other || p?.id !== "custom";
        $("row-model-select").hidden = !claude; $("row-model-text").hidden = !other;
        $("row-key").hidden = !pv || (other && p && !p.needsKey && p.id !== "custom");
        $("model-hint").textContent = other && p && !p.needsKey && p.id !== "custom" ? "The name of a model you have already downloaded. It must support tool calling to make edits." : "";
        const link = KEY_LINKS[claude ? "anthropic" : p?.id];
        const kept = s.hasKey && pv === s.provider && (claude || p?.id === s.preset);
        $("key").placeholder = kept ? "•••••••• saved (leave blank to keep it)" : (p?.id === "custom" ? "only if your server needs one" : "paste your key");
        $("key-hint").replaceChildren(...(link ? [Object.assign(document.createElement("a"), { href: link[1], textContent: link[0] + " ↗" })] : []), ...(s.canEncrypt ? [] : [document.createTextNode(" This computer has no keychain available, so the key is kept only until you quit.")]));
        $("forget").hidden = !s.provider;
    }
    function fill() {
        document.querySelectorAll('input[name="provider"]').forEach((r) => { r.checked = r.value === s.provider; });
        $("preset").value = s.preset || "openai"; $("baseUrl").value = s.preset === "custom" ? s.baseUrl : "";
        $("modelSelect").value = s.anthropicModels.some((m) => m.id === s.model) ? s.model : s.anthropicDefault;
        $("modelText").value = s.provider === "openai-compatible" ? s.model : ""; $("key").value = "";
        paint();
    }
    const read = () => {
        const pv = provider(), p = preset();
        return { provider: pv, preset: pv === "openai-compatible" ? p?.id : "", baseUrl: pv === "openai-compatible" ? (p?.id === "custom" ? $("baseUrl").value : p?.baseUrl) : "", model: pv === "anthropic" ? $("modelSelect").value : $("modelText").value, key: $("key").value };
    };
    const say = (text, cls = "") => { $("result").textContent = text; $("result").className = cls; };
    const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    const busy = (on) => ["test", "save"].forEach((id) => { $(id).disabled = on; });

    document.querySelectorAll('input[name="provider"]').forEach((r) => r.addEventListener("change", paint));
    $("preset").addEventListener("change", paint);
    $("test").addEventListener("click", async () => { busy(true); say("Asking your AI to say OK…"); try { const r = await api.test(read()); say("Connected. It answered: “" + r.message + "”", "ok"); } catch (e) { say(clean(e), "bad"); } busy(false); });
    $("save").addEventListener("click", async () => { busy(true); try { s = await api.save(read()); say("Saved. The prompt bar is under the page.", "ok"); fill(); busy(false); } catch (e) { say(clean(e), "bad"); busy(false); } });
    $("forget").addEventListener("click", async () => { s = await api.forget(); fill(); say("Disconnected. The saved key was deleted.", "ok"); });
    $("cancel").addEventListener("click", () => api.close());
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") api.close(); });
    fill();
    if (s.provider) $("advanced").open = true;

    /* ---- the no-key way: your own AI app, over MCP ---- */
    function paintMcp(m) {
        $("needs-move").hidden = !m.needsMove; $("needs-move-text").textContent = m.needsMove;
        const c = m.claude, pill = $("claude-pill");
        pill.textContent = c.connected ? (c.current ? "Connected" : "Needs reconnecting") : ""; pill.className = "pill" + (c.connected && c.current ? " on" : "");
        $("claude-sub").textContent = !c.installed ? "Claude Desktop isn't installed on this computer. Get it free at claude.ai/download, then come back."
            : c.connected && c.current ? "Claude Desktop knows about Itera."
            : c.connected ? "Itera has moved since you connected (an update, or a different folder). Connect again to fix it."
            : "One click adds Itera to Claude's settings (a backup of the file is kept next to it).";
        $("claude-connect").hidden = c.connected && c.current; $("claude-connect").disabled = !c.installed;
        $("claude-connect").textContent = c.connected ? "Reconnect Claude Desktop" : "Connect Claude Desktop";
        $("claude-disconnect").hidden = !c.connected; $("claude-steps").hidden = !(c.connected && c.current);
        const x = m.codex, xp = $("codex-pill");
        xp.textContent = x.connected ? (x.current ? "Connected" : "Needs reconnecting") : ""; xp.className = "pill" + (x.connected && x.current ? " on" : "");
        $("codex-sub").textContent = !x.installed ? "Not set up on this computer yet. Open the ChatGPT desktop app's Codex (or install the Codex CLI) once, then come back."
            : x.connected && x.current ? "ChatGPT and Codex know about Itera. They share one settings file."
            : x.connected ? "Itera has moved since you connected. Connect again to fix it."
            : "One click adds Itera to the settings file the ChatGPT app, Codex CLI and the IDE extension share (a backup is kept).";
        $("codex-connect").hidden = x.connected && x.current; $("codex-connect").disabled = !x.installed;
        $("codex-connect").textContent = x.connected ? "Reconnect ChatGPT / Codex" : "Connect ChatGPT / Codex";
        $("codex-disconnect").hidden = !x.connected; $("codex-steps").hidden = !(x.connected && x.current);
        if (m.needsMove) { $("claude-connect").disabled = true; $("codex-connect").disabled = true; $("copy-json").disabled = true; $("copy-cc").disabled = true; }
        const live = $("live-pill"); live.textContent = m.clients ? (m.clients === 1 ? "1 app connected right now" : m.clients + " apps connected right now") : ""; live.className = "pill" + (m.clients ? " on" : "");
    }
    const flash = (t) => { $("copied").textContent = t; setTimeout(() => { $("copied").textContent = ""; }, 1800); };
    paintMcp(await api.mcp.state()); api.mcp.onChange(paintMcp);

    // Notes to your AI: house rules folded into the MCP instructions for every connection
    const notes = $("ai-notes");
    if (notes && api.notes) {
        notes.value = await api.notes.get();
        let notesTimer;
        notes.addEventListener("input", () => { clearTimeout(notesTimer); notesTimer = setTimeout(async () => { await api.notes.set(notes.value); const el = $("notes-saved"); if (el) { el.textContent = "Saved"; setTimeout(() => (el.textContent = ""), 1200); } }, 500); });
    }
    $("move-now").addEventListener("click", () => api.mcp.moveToApplications());
    $("claude-connect").addEventListener("click", async () => { try { paintMcp(await api.mcp.connectClaude()); } catch (e) { $("claude-sub").textContent = clean(e); } });
    $("claude-disconnect").addEventListener("click", async () => paintMcp(await api.mcp.disconnectClaude()));
    $("codex-connect").addEventListener("click", async () => { try { paintMcp(await api.mcp.connectCodex()); } catch (e) { $("codex-sub").textContent = clean(e); } });
    $("codex-disconnect").addEventListener("click", async () => paintMcp(await api.mcp.disconnectCodex()));
    $("copy-json").addEventListener("click", async () => { await api.mcp.copy("json"); flash("Copied"); });
    /* ---- updates ---- */
    const up = await api.updates.get();
    if (up && up.available) {
        $("updates").hidden = false; $("version-pill").textContent = "Version " + up.version; $("auto-update").checked = up.auto;
        $("auto-update").addEventListener("change", (e) => api.updates.setAuto(e.target.checked));
        $("check-now").addEventListener("click", () => api.updates.check());
    }
    // File ▸ Settings… opens the top; AI ▸ API Key (Advanced)… and the Updates links land on their section
    const show = (section) => { if (section === "advanced") { $("advanced").open = true; $("advanced").scrollIntoView({ block: "start" }); } if (section === "updates") $("updates").scrollIntoView({ block: "start" }); };
    show(decodeURIComponent(location.hash.slice(1))); api.onShow(show);

    $("copy-cc").addEventListener("click", async () => { await api.mcp.copy("claude-code"); flash("Copied"); });
})();
