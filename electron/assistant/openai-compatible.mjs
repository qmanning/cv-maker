// electron/assistant/openai-compatible.mjs — any server that speaks the OpenAI chat-completions shape:
// OpenAI, Gemini's and OpenRouter's compatible endpoints, and local models (Ollama, LM Studio).
// There is no single SDK for "whatever you point it at", so this is plain fetch. Main process only.
import { SYSTEM, TOOL, TRANSCRIBE, normalize, userContent } from "./prompt.mjs";

export const PRESETS = [
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
    { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
    { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
    { id: "ollama", label: "Ollama (on this computer)", baseUrl: "http://localhost:11434/v1", needsKey: false },
    { id: "lmstudio", label: "LM Studio (on this computer)", baseUrl: "http://localhost:1234/v1", needsKey: false },
    { id: "custom", label: "Another OpenAI-compatible server", baseUrl: "", needsKey: false },
];

/** https anywhere; plain http only to this computer, so a key never crosses a network in the clear */
export function checkBaseUrl(baseUrl) {
    let u; try { u = new URL(baseUrl); } catch { throw new Error("That server address isn't a valid URL."); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Use an https:// address (plain http:// is only allowed for a model on this computer).");
    return u.href.replace(/\/+$/, "");
}

/** pictures of pages → Markdown (a scanned PDF). Only vision models can; a text-only model says so in its error. */
export async function transcribeOpenAiCompatible({ apiKey, baseUrl, model }, images) {
    const url = checkBaseUrl(baseUrl) + "/chat/completions";
    let res;
    try {
        res = await fetch(url, {
            method: "POST", signal: AbortSignal.timeout(300000),
            headers: { "content-type": "application/json", ...(apiKey ? { authorization: "Bearer " + apiKey } : {}) },
            body: JSON.stringify({ model, messages: [{ role: "system", content: TRANSCRIBE }, { role: "user", content: [...images.map((u) => ({ type: "image_url", image_url: { url: u } })), { type: "text", text: "Transcribe these pages." }] }] }),
        });
    } catch (e) { throw new Error(e?.name === "TimeoutError" ? "Your AI took too long to read the scan." : `Couldn't reach ${new URL(url).host}. Is it running?`); }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Your AI couldn't read the scan (${res.status}): ${body?.error?.message || "does this model accept images?"}`);
    const text = String(body?.choices?.[0]?.message?.content || "").replace(/^```(?:markdown)?\s*|\s*```\s*$/g, "").trim();
    if (!text) throw new Error("Your AI sent back nothing for the scan. Does this model accept images?");
    return { markdown: text };
}

export async function runOpenAiCompatible({ apiKey, baseUrl, model }, request) {
    const url = checkBaseUrl(baseUrl) + "/chat/completions";
    let res;
    try {
        res = await fetch(url, {
            method: "POST", signal: AbortSignal.timeout(300000),
            headers: { "content-type": "application/json", ...(apiKey ? { authorization: "Bearer " + apiKey } : {}) },
            body: JSON.stringify({
                model,
                messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userContent(request) }],
                tools: [{ type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.input_schema } }],
                tool_choice: "auto",
            }),
        });
    } catch (e) { throw new Error(e?.name === "TimeoutError" ? "Your AI took too long to answer." : `Couldn't reach ${new URL(url).host}. Is it running?`); }
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* an HTML error page, most likely */ }
    if (!res.ok) {
        const why = body?.error?.message || body?.error || text.slice(0, 200);
        if (res.status === 401 || res.status === 403) throw new Error("That server didn't accept the API key. Check it in AI Settings.");
        if (res.status === 404) throw new Error(`The server doesn't know the model “${model}” (or the address is wrong).`);
        if (res.status === 429) throw new Error("Your AI provider is rate-limiting this key. Wait a moment and try again.");
        throw new Error(`Your AI provider returned an error (${res.status}): ${typeof why === "string" ? why : JSON.stringify(why)}`);
    }
    const message = body?.choices?.[0]?.message || {};
    const call = (message.tool_calls || []).find((c) => c?.function?.name === TOOL.name);
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (call) { try { return normalize(JSON.parse(call.function.arguments || "{}"), content); } catch { throw new Error("Your AI sent back changes the editor couldn't read. Try again, or try a stronger model."); } }
    // smaller local models often skip the tool and just write the JSON (sometimes fenced) — accept that too
    const json = content.match(/\{[\s\S]*\}/);
    if (json) { try { const parsed = JSON.parse(json[0]); if (Array.isArray(parsed.ops)) return normalize(parsed); } catch { /* it was prose after all */ } }
    return normalize(null, content || "Your AI sent back an empty reply.");
}
