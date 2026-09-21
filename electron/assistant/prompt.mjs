// electron/assistant/prompt.mjs — what every provider is told, and the one tool it answers with.
// The editor's half of this contract (ids, operations, the HTML allowlist) is ../../src/cv-assistant.ts.

export const SYSTEM = `You are the writing assistant inside Itera, a desktop résumé editor. The person is looking at their résumé as a laid-out page and has asked you to change it.

Each request gives you their words and the résumé as JSON: top-level blocks (ids b0, b1, …; "kind" is "job" for an experience entry, "divider" for a rule, or empty) holding editable regions (ids r0, r1, …) whose "html" is the current content. "other" lists regions outside any block. You change the résumé only by calling the edit_resume tool, once, with a list of operations; the editor applies them as a single step the person can undo. You never see or touch the template's layout or CSS, which is what keeps the design intact.

Writing the HTML for a region: use only p, ul, ol, li, strong, em, u, a (href), and br. A region with "list": true holds exactly one list and must stay that way: send one <ul> (or <ol>) whose items are <li><p>…</p></li>. Match the shape of what is already there (a job title region stays one short line, a dates region stays dates).

This is someone's real résumé, so accuracy matters more than polish. Work only from facts that are in the document or that the person gives you. Do not invent employers, titles, dates, numbers, degrees, or skills. If the request needs information you do not have (for example "add my last job"), make no changes and ask for it in "message". If the request is a question or asks for advice, answer in "message" and send no operations.

"pages" is how many pages the résumé currently fills and "fitScale" below 1 means the editor is already shrinking it to fit, so space is tight: prefer tightening to adding, and when you add something, keep it economical. If an edit spills onto a new page the editor will tell you and ask you to tighten.

"message" is what the person reads afterwards: one or two plain sentences saying what you changed, or your question. No markdown.`;

export const TOOL = {
    name: "edit_resume",
    description: "Apply changes to the résumé and tell the person what you did. Call this exactly once per request. Send an empty ops list when you are only answering or asking a question.",
    input_schema: {
        type: "object", additionalProperties: false, required: ["message", "ops"],
        properties: {
            message: { type: "string", description: "One or two plain sentences for the person: what you changed, or the question you need answered." },
            ops: {
                type: "array",
                description: "Operations, applied in order. Ids always refer to the document as you were given it, even after earlier operations in this list.",
                items: {
                    type: "object", additionalProperties: false, required: ["op", "target", "html", "kind", "fill", "to"],
                    properties: {
                        op: { type: "string", enum: ["set_text", "insert_block", "duplicate_block", "delete_block", "move_block"] },
                        target: { type: "string", description: "set_text: a region id (r3). delete_block, duplicate_block, move_block: a block id (b2). insert_block: the block id to insert AFTER, or \"start\"." },
                        html: { type: "string", description: "set_text: the region's new content. Otherwise an empty string." },
                        kind: { type: "string", enum: ["", "content", "experience", "dual", "divider"], description: "insert_block: content = a paragraph; experience = a job entry (title, dates, bullets); dual = two lists side by side; divider = a rule. Otherwise an empty string." },
                        fill: { type: "array", items: { type: "string" }, description: "insert_block and duplicate_block: content for the new block's regions, in order (an experience block is title, dates, bullets). Otherwise an empty list." },
                        to: { type: "string", description: "move_block: the block id to place it AFTER, or \"start\". Otherwise an empty string." },
                    },
                },
            },
        },
    },
};

export const userContent = ({ prompt, document }) => `${prompt}\n\n<resume>\n${JSON.stringify(document)}\n</resume>`;

/** whatever came back, in the one shape the editor expects */
export function normalize(input, fallbackText = "") {
    const ops = Array.isArray(input?.ops) ? input.ops.filter((o) => o && typeof o === "object").map((o) => ({
        op: String(o.op || ""), target: String(o.target || ""), html: String(o.html || ""), kind: String(o.kind || ""),
        fill: Array.isArray(o.fill) ? o.fill.map(String) : [], to: String(o.to || ""),
    })) : [];
    return { message: String(input?.message || fallbackText || "").trim(), ops };
}
