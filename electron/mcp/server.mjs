#!/usr/bin/env node
// electron/mcp/server.mjs — CV Maker's MCP server. An AI app (Claude Desktop, Claude Code, Cursor, …) starts
// this as a subprocess and talks MCP to it over stdio; it relays to the RUNNING CV Maker app over a local
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
    ? `\\\\.\\pipe\\cv-maker-mcp-${os.userInfo().username}`
    : path.join(process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")), "CV Maker", "mcp.sock"));
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `CV Maker is a desktop résumé editor; these tools act on the résumé the person has open in it right now, and they watch the page change as you work.

Always call get_resume first. It returns top-level blocks (b0, b1, …; kind "job" = an experience entry, "divider" = a rule) holding editable regions (r0, r1, …) whose "html" is the current content. Change the résumé only with edit_resume: you send operations, the editor applies them as one step the person can undo, and the template's layout and CSS are never yours to touch.

HTML for a region: only p, ul, ol, li, strong, em, u, a (href) and br. A region with "list": true must stay exactly one list whose items are <li><p>…</p></li>. Match the shape of what is there (a title stays one short line, a dates line stays dates).

This is someone's real résumé. Work only from facts in the document or given by the person; never invent employers, titles, dates, numbers, degrees or skills. If you need information you do not have, ask the person instead of editing.

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
const TOOLS = [
    { name: "get_resume", description: "Read the résumé that is open in CV Maker: its blocks and editable regions (with ids), the file name, how many pages it fills, and whether the editor is already shrinking it to fit. Call this before editing.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true, title: "Read the open résumé" } },
    { name: "edit_resume", description: "Change the open résumé. Operations are applied in order as ONE step the person can undo; ids refer to the document as get_resume last returned it, even after earlier operations in the same call. Returns how many were applied, any that were skipped and why, and pages_before / pages_after.", inputSchema: { type: "object", additionalProperties: false, required: ["summary", "ops"], properties: { summary: { type: "string", description: "One short sentence shown to the person inside CV Maker, e.g. \"Tightened the Halcyon bullets.\"" }, ops: { type: "array", minItems: 1, items: OP } } }, annotations: { title: "Edit the open résumé", destructiveHint: false } },
    { name: "undo_last_edit", description: "Take back the most recent edit_resume.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { title: "Undo the last edit" } },
    { name: "export_resume", description: "Export the open résumé to the person's Downloads folder as a PDF (real, selectable text) or a PNG. Returns the file path.", inputSchema: { type: "object", additionalProperties: false, required: ["format"], properties: { format: { type: "string", enum: ["pdf", "png"] } } }, annotations: { title: "Export the résumé" } },
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
            const drop = () => { if (sock === s) sock = null; for (const w of waiting.values()) w.reject(new Error("CV Maker closed.")); waiting.clear(); };
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
            if (process.platform === "darwin" && !process.env.CVM_MCP_SOCKET) spawn("open", ["-g", "-a", "CV Maker"], { stdio: "ignore", detached: true }).unref();
            let up = false; for (let i = 0; i < 24 && !up; i++) { await delay(500); try { await dial(); up = true; } catch { /* keep waiting */ } }
            if (!up) throw new Error("CV Maker isn't open. Ask the person to open the CV Maker app (with their résumé), then try again.");
        }
    }
    const id = ++seq;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); sock.write(JSON.stringify({ id, method, params, client }) + "\n"); setTimeout(() => { if (waiting.delete(id)) reject(new Error("CV Maker didn't answer in time.")); }, 60000); });
}

/* ---- MCP over stdio: newline-delimited JSON-RPC 2.0 ---- */
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args) {
    if (name === "get_resume") return text(await app("describe"));
    if (name === "edit_resume") {
        if (!Array.isArray(args?.ops) || !args.ops.length) return text("Send at least one operation in ops.", true);
        const out = await app("apply", { ops: args.ops, summary: String(args.summary || "") });
        const spilled = out.pages_after > out.pages_before;
        return text({ ...out, note: spilled ? `The résumé now runs to ${out.pages_after} pages (it was ${out.pages_before}). Unless the person wants that, tighten what you just wrote and call edit_resume again.` : out.applied ? "Applied. The person can see it and has an Undo button in CV Maker." : "Nothing was applied; see skipped." });
    }
    if (name === "undo_last_edit") return text(await app("undo"));
    if (name === "export_resume") return text(await app("export", { format: args?.format }));
    return text(`Unknown tool: ${name}`, true);
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (msg.id === undefined || msg.id === null) return;                                   // notifications need no answer
    const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
    try {
        if (msg.method === "initialize") { const n = String(msg.params?.clientInfo?.title || msg.params?.clientInfo?.name || ""); if (n) client = /claude/i.test(n) ? (/code/i.test(n) ? "Claude Code" : "Claude") : n.slice(0, 40); }
        if (msg.method === "initialize") return reply({ protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "cv-maker", title: "CV Maker", version: "0.1.0" }, instructions: INSTRUCTIONS });
        if (msg.method === "ping") return reply({});
        if (msg.method === "tools/list") return reply({ tools: TOOLS });
        if (msg.method === "tools/call") { try { return reply(await callTool(msg.params?.name, msg.params?.arguments || {})); } catch (e) { return reply(text(String(e?.message || e), true)); } }
        if (msg.method === "resources/list") return reply({ resources: [] });
        if (msg.method === "prompts/list") return reply({ prompts: [] });
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    } catch (e) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } }); }
});
process.stdin.on("end", () => process.exit(0));
