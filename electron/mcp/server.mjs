#!/usr/bin/env node
// electron/mcp/server.mjs — Itera's MCP server. An AI app (Claude Desktop, Claude Code, Cursor, …) starts
// this as a subprocess and talks MCP to it over stdio; it relays to the RUNNING Itera app over a local
// socket that only this user can open. No network, no API key, no dependencies — plain Node, so the app can run
// it with its own binary (ELECTRON_RUN_AS_NODE=1) and people don't need Node installed.
//
// The tool schema mirrors electron/assistant/prompt.mjs and the editor's src/cv-assistant.ts; keep the three in step.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const SOCKET = process.env.CVM_MCP_SOCKET || (process.platform === "win32"
    ? `\\\\.\\pipe\\itera-mcp-${os.userInfo().username}`
    : path.join(process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")), "Itera", "mcp.sock"));
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Itera is a desktop editor for a résumé AND its cover letter; these tools act on what the person has open in it right now, and they watch the page change as you work.

Two documents: Itera holds a résumé and a cover letter side by side (two tabs, two files). Every tool takes an optional "document": "resume" or "cover_letter" — Itera shows that one and acts on it; leave it out and the tool acts on whichever tab is showing (results say which). Ids (b0, r0, i0 …) belong to ONE document: call get_resume with the same "document" before editing it. The cover letter's header is a read-only copy of the résumé's header — change the name, contact details or headline on the résumé and the letter follows; the letter's own regions are its date, recipient, greeting, body and sign-off.

Always call get_resume first. It returns top-level blocks (b0, b1, …; kind "job" = an experience entry, "divider" = a rule) holding editable regions (r0, r1, …) whose "html" is the current content. Change the résumé only with edit_resume: you send operations, the editor applies them as one step the person can undo, and the template's layout and CSS are never yours to touch.

HTML for a region: only p, ul, ol, li, strong, em, u, a (href) and br. A region with "list": true must stay exactly one list whose items are <li><p>…</p></li>. Match the shape of what is there (a title stays one short line, a dates line stays dates).

This is someone's real résumé. Work only from facts in the document or given by the person; never invent employers, titles, dates, numbers, degrees or skills. If you need information you do not have, ask the person instead of editing.

Files: each document is a file. list_documents shows the recent ones (one may be marked master: the person's base résumé) and which is open. To tailor a résumé for a job, open_document the master, then save_document with save_as (e.g. "Acme — Product Designer") BEFORE editing, so the master is never changed; exports are named after the open file. open_document refuses while there are unsaved changes: save_document first, or ask the person. Never save over a document the person did not ask you to change.

Page and images: get_page_setup / set_page_setup read and change paper size, fit-to-one-page, pagination and zoom. list_images / replace_image swap a picture (a photo, a logo) for an image file on this computer. export_resume writes a PDF, PNG, Word (docx) or Source HTML file to Downloads.

edit_resume reports pages_before and pages_after. If your edit pushed the résumé onto another page, tighten what you just wrote (same facts, fewer words) and call edit_resume again, unless the person asked for more pages. After editing, tell the person briefly what you changed. Ids are re-issued by every get_resume, so call it again before a second round of edits.`;

const OP = {
    type: "object", additionalProperties: false, required: ["op", "target"],
    properties: {
        op: { type: "string", enum: ["set_text", "insert_block", "duplicate_block", "delete_block", "move_block"] },
        target: { type: "string", description: "set_text: a region id (r3). delete_block / duplicate_block / move_block: a block id (b2). insert_block: the block id to insert AFTER, or \"start\"." },
        html: { type: "string", description: "set_text: the region's new content." },
        kind: { type: "string", enum: ["content", "experience", "dual", "divider"], description: "insert_block: content = a paragraph; experience = a job entry (title, dates, bullets); dual = two lists side by side; divider = a rule." },
        fill: { type: "array", items: { type: "string" }, description: "insert_block / duplicate_block: HTML for the new block's regions, in order (an experience block is title, dates, bullets)." },
        to: { type: "string", description: "move_block: the block id to place it AFTER, or \"start\"." },
    },
};
const DOC = { document: { type: "string", enum: ["resume", "cover_letter"], description: "Which document to act on. Omit for the tab that is showing." } };
const TOOLS = [
    { name: "get_resume", description: "Read the résumé that is open in Itera: its blocks and editable regions (with ids), the file name, how many pages it fills, and whether the editor is already shrinking it to fit. Call this before editing.", inputSchema: { type: "object", additionalProperties: false, properties: { ...DOC } }, annotations: { readOnlyHint: true, title: "Read the open résumé or cover letter" } },
    { name: "edit_resume", description: "Change the open résumé. Operations are applied in order as ONE step the person can undo; ids refer to the document as get_resume last returned it, even after earlier operations in the same call. Returns how many were applied, any that were skipped and why, and pages_before / pages_after.", inputSchema: { type: "object", additionalProperties: false, required: ["summary", "ops"], properties: { ...DOC, summary: { type: "string", description: "One short sentence shown to the person inside Itera, e.g. \"Tightened the Halcyon bullets.\"" }, ops: { type: "array", minItems: 1, items: OP } } }, annotations: { title: "Edit the open résumé", destructiveHint: false } },
    { name: "undo_last_edit", description: "Take back the most recent edit_resume or replace_image on that document.", inputSchema: { type: "object", additionalProperties: false, properties: { ...DOC } }, annotations: { title: "Undo the last edit" } },
    { name: "export_resume", description: "Export the open résumé to the person's Downloads folder: pdf (real, selectable text), png, docx (Word, ATS-friendly) or html (the re-loadable Source HTML). The file is named after the open document. Returns the file path.", inputSchema: { type: "object", additionalProperties: false, required: ["format"], properties: { ...DOC, format: { type: "string", enum: ["pdf", "png", "docx", "html"] } } }, annotations: { title: "Export the résumé" } },
    { name: "list_documents", description: "For the résumé and for the cover letter: the recent files (name, path, which is pinned as the master), which file is open, whether it has unsaved changes — and which of the two is showing.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true, title: "List recent résumés" } },
    { name: "open_document", description: "Open a résumé in Itera — what the person does with the Import/Open button. Pass a name from list_documents (e.g. the master) or an absolute path to an .html file. The file itself says whether it is a résumé or a cover letter, and it opens in that tab. Refuses if that document has unsaved changes. Call get_resume afterwards: ids are new.", inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", description: "A document name from list_documents, or an absolute file path." }, document: { type: "string", enum: ["resume", "cover_letter"], description: "Optional: look among these first when two files share a name." } } }, annotations: { title: "Open a résumé" } },
    { name: "save_document", description: "Save the open résumé to its file. With save_as, save a COPY under that name instead (next to the current file; it becomes the open document and names future exports) — use this to branch a tailored résumé off the master, or to rename. Never overwrites a different existing file.", inputSchema: { type: "object", additionalProperties: false, properties: { ...DOC, save_as: { type: "string", description: "A new document name, without a folder or extension, e.g. \"Acme — Product Designer\"." } } }, annotations: { title: "Save the résumé" } },
    { name: "get_page_setup", description: "Paper size, fit-to-one-page, pagination and zoom (shared by both documents), plus how many pages the document fills and the fit scale in effect.", inputSchema: { type: "object", additionalProperties: false, properties: { ...DOC } }, annotations: { readOnlyHint: true, title: "Read the page setup" } },
    { name: "set_page_setup", description: "Change any of: paper (\"letter\" or \"a4\"), fit_to_one_page (scale the design down, never below 80%, to land on one sheet), paginate (pages + page numbers vs one continuous page), zoom (\"width\", \"height\", or a number: 1.25 = 125%; view only). Returns the resulting setup including pages.", inputSchema: { type: "object", additionalProperties: false, properties: { ...DOC, paper: { type: "string", enum: ["letter", "a4"] }, fit_to_one_page: { type: "boolean" }, paginate: { type: "boolean" }, zoom: { anyOf: [{ type: "string", enum: ["width", "height"] }, { type: "number", minimum: 0.25, maximum: 4 }] } } }, annotations: { title: "Change the page setup" } },
    { name: "list_images", description: "Every image in the document (photo, logo, …) with its id (i0, i1, …), alt text and pixel size. The letter's header images are copies of the résumé's: replace them on the résumé.", inputSchema: { type: "object", additionalProperties: false, properties: { ...DOC } }, annotations: { readOnlyHint: true, title: "List the résumé's images" } },
    { name: "replace_image", description: "Replace one image with an image file on this computer (png, jpg, gif, webp, svg; up to 8 MB). It is embedded in the résumé file. One undoable step (undo_last_edit).", inputSchema: { type: "object", additionalProperties: false, required: ["image", "path"], properties: { ...DOC, image: { type: "string", description: "An id from list_images, e.g. i0." }, path: { type: "string", description: "Absolute path to the new image file." }, alt: { type: "string", description: "New alt text (optional)." } } }, annotations: { title: "Replace an image" } },
];

/* ---- the app, over the local socket: one JSON line out, one JSON line back ---- */
let sock = null, seq = 0, client = "Your AI"; const waiting = new Map();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function dial() {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(SOCKET);
        s.once("connect", () => {
            sock = s;
            readline.createInterface({ input: s }).on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.result); });
            const drop = () => { if (sock === s) sock = null; for (const w of waiting.values()) w.reject(new Error("Itera closed.")); waiting.clear(); };
            s.on("close", drop); s.on("error", drop);
            resolve();
        });
        s.once("error", reject);
    });
}
async function app(method, params) {
    if (!sock) {
        try { await dial(); } catch {
            // not running: on a Mac we can open it for them, then wait for its socket
            if (process.platform === "darwin" && !process.env.CVM_MCP_SOCKET) spawn("open", ["-g", "-a", "Itera"], { stdio: "ignore", detached: true }).unref();
            let up = false; for (let i = 0; i < 24 && !up; i++) { await delay(500); try { await dial(); up = true; } catch { /* keep waiting */ } }
            if (!up) throw new Error("Itera isn't open. Ask the person to open the Itera app (with their résumé), then try again.");
        }
    }
    const id = ++seq;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); sock.write(JSON.stringify({ id, method, params, client }) + "\n"); setTimeout(() => { if (waiting.delete(id)) reject(new Error("Itera didn't answer in time.")); }, 60000); });
}

/* ---- MCP over stdio: newline-delimited JSON-RPC 2.0 ---- */
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args) {
    const doc = args?.document;
    if (name === "get_resume") return text(await app("describe", { document: doc }));
    if (name === "edit_resume") {
        if (!Array.isArray(args?.ops) || !args.ops.length) return text("Send at least one operation in ops.", true);
        const out = await app("apply", { document: doc, ops: args.ops, summary: String(args.summary || "") });
        const spilled = out.pages_after > out.pages_before;
        return text({ ...out, note: spilled ? `It now runs to ${out.pages_after} pages (it was ${out.pages_before}). Unless the person wants that, tighten what you just wrote and call edit_resume again.` : out.applied ? "Applied. The person can see it and has an Undo button in Itera." : "Nothing was applied; see skipped." });
    }
    if (name === "undo_last_edit") return text(await app("undo", { document: doc }));
    if (name === "export_resume") return text(await app("export", { document: doc, format: args?.format }));
    if (name === "list_documents") return text(await app("documents"));
    if (name === "open_document") return text({ ...(await app("open", { name: args?.name, document: doc })), note: "Call get_resume (with the same document) now: this is a different document and the ids are new." });
    if (name === "save_document") return text(await app("save", { document: doc, save_as: args?.save_as }));
    if (name === "get_page_setup") return text(await app("page_get", { document: doc }));
    if (name === "set_page_setup") return text(await app("page_set", args || {}));
    if (name === "list_images") return text(await app("images", { document: doc }));
    if (name === "replace_image") return text(await app("image_set", { document: doc, image: args?.image, path: args?.path, alt: args?.alt }));
    return text(`Unknown tool: ${name}`, true);
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (msg.id === undefined || msg.id === null) return;                                   // notifications need no answer
    const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
    try {
        if (msg.method === "initialize") { const n = String(msg.params?.clientInfo?.title || msg.params?.clientInfo?.name || ""); if (n) client = /claude/i.test(n) ? (/code/i.test(n) ? "Claude Code" : "Claude") : n.slice(0, 40); }
        if (msg.method === "initialize") return reply({ protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "itera", title: "Itera", version: "0.3.0" }, instructions: INSTRUCTIONS });
        if (msg.method === "ping") return reply({});
        if (msg.method === "tools/list") return reply({ tools: TOOLS });
        if (msg.method === "tools/call") { try { return reply(await callTool(msg.params?.name, msg.params?.arguments || {})); } catch (e) { return reply(text(String(e?.message || e), true)); } }
        if (msg.method === "resources/list") return reply({ resources: [] });
        if (msg.method === "prompts/list") return reply({ prompts: [] });
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    } catch (e) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } }); }
});
process.stdin.on("end", () => process.exit(0));
