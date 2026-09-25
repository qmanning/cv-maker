// electron/assistant/anthropic.mjs — Claude, through the official SDK. Runs in the main process only.
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM, TOOL, TRANSCRIBE, normalize, userContent } from "./prompt.mjs";

export const ANTHROPIC_MODELS = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];
export const ANTHROPIC_DEFAULT = "claude-opus-5";

// the safety classifiers on these two can decline a request; "default" lets the API re-run it on Anthropic's
// recommended substitute inside the same call instead of handing the person a refusal
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

/** pictures of pages → Markdown (a scanned PDF). Every current Claude model reads images. */
export async function transcribeAnthropic({ apiKey, model = ANTHROPIC_DEFAULT }, images) {
    const client = new Anthropic({ apiKey });
    const content = [...images.map((uri) => { const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(uri); return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : null; }).filter(Boolean), { type: "text", text: "Transcribe these pages." }];
    try {
        const response = await client.messages.create({ model, max_tokens: 16000, system: TRANSCRIBE, messages: [{ role: "user", content }] });
        return { markdown: response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").replace(/^```(?:markdown)?\s*|\s*```\s*$/g, "").trim() };
    } catch (e) {
        if (e instanceof Anthropic.APIError) throw new Error(`Anthropic couldn't read the scan (${e.status}): ${e.message}`);
        throw e;
    }
}

export async function runAnthropic({ apiKey, model = ANTHROPIC_DEFAULT }, request) {
    const client = new Anthropic({ apiKey });
    const params = {
        model, max_tokens: 16000, system: SYSTEM,
        tools: [{ ...TOOL, strict: true }],
        messages: [{ role: "user", content: userContent(request) }],
        ...(model.includes("haiku") ? {} : { thinking: { type: "adaptive" } }),
    };
    try {
        const response = FALLBACK_MODELS.has(model)
            ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
            : await client.messages.create(params);
        if (response.stop_reason === "refusal") return { message: "Claude declined that request" + (response.stop_details?.explanation ? ": " + response.stop_details.explanation : "."), ops: [] };
        if (response.stop_reason === "max_tokens") throw new Error("The reply was cut off before it finished. Try asking for a smaller change.");
        const call = response.content.find((b) => b.type === "tool_use" && b.name === TOOL.name);
        const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        return normalize(call?.input, text);
    } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic didn't accept that API key. Check it in AI Settings.");
        if (e instanceof Anthropic.PermissionDeniedError) throw new Error("That API key isn't allowed to use " + model + ".");
        if (e instanceof Anthropic.NotFoundError) throw new Error("Anthropic doesn't know the model “" + model + "”. Pick another in AI Settings.");
        if (e instanceof Anthropic.RateLimitError) throw new Error("Anthropic is rate-limiting this key. Wait a moment and try again.");
        if (e instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Anthropic. Check your internet connection.");
        if (e instanceof Anthropic.APIError) throw new Error(`Anthropic returned an error (${e.status}): ${e.message}`);
        throw e;
    }
}
