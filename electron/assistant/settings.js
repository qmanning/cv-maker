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
    const busy = (on) => ["test", "save", "cancel"].forEach((id) => { $(id).disabled = on; });

    document.querySelectorAll('input[name="provider"]').forEach((r) => r.addEventListener("change", paint));
    $("preset").addEventListener("change", paint);
    $("test").addEventListener("click", async () => { busy(true); say("Asking your AI to say OK…"); try { const r = await api.test(read()); say("Connected. It answered: “" + r.message + "”", "ok"); } catch (e) { say(clean(e), "bad"); } busy(false); });
    $("save").addEventListener("click", async () => { busy(true); try { s = await api.save(read()); api.close(); } catch (e) { say(clean(e), "bad"); busy(false); } });
    $("forget").addEventListener("click", async () => { s = await api.forget(); fill(); say("Disconnected. The saved key was deleted.", "ok"); });
    $("cancel").addEventListener("click", () => api.close());
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") api.close(); });
    fill();
})();
