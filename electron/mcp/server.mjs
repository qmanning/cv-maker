#!/usr/bin/env node
// electron/mcp/server.mjs — IcedCoffee's MCP server. An AI app (Claude Desktop, Claude Code, Cursor, …) starts
// this as a subprocess and talks MCP to it over stdio; it relays to the RUNNING IcedCoffee app over a local
// socket that only this user can open. No network, no API key, no dependencies — plain Node, so the app can run
// it with its own binary (ELECTRON_RUN_AS_NODE=1) and people don't need Node installed.
//
// The tool schema mirrors electron/assistant/prompt.mjs and the editor's src/cv-assistant.ts; keep the three in step.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { INSTRUCTIONS, TOOLS, callTool, text } from "./catalog.mjs";

const SOCKET = process.env.CVM_MCP_SOCKET || (process.platform === "win32"
    ? `\\\\.\\pipe\\icedcoffee-mcp-${os.userInfo().username}`
    : path.join(process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")), "IcedCoffee", "mcp.sock"));
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/* ---- the app, over the local socket: one JSON line out, one JSON line back ---- */
let sock = null, seq = 0, client = "Your AI"; const waiting = new Map();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function dial() {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(SOCKET);
        s.once("connect", () => {
            sock = s;
            readline.createInterface({ input: s }).on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.result); });
            const drop = () => { if (sock === s) sock = null; for (const w of waiting.values()) w.reject(new Error("IcedCoffee closed.")); waiting.clear(); };
            s.on("close", drop); s.on("error", drop);
            resolve();
        });
        s.once("error", reject);
    });
}
async function app(method, params, { launch = true } = {}) {
    if (!sock) {
        try { await dial(); if (method !== "mcp:hello") void noticeChange().catch(() => {}); } catch {
            if (!launch) throw new Error("IcedCoffee isn't open.");
            // not running: on a Mac we can open it for them, then wait for its socket
            if (process.platform === "darwin" && !process.env.CVM_MCP_SOCKET) spawn("open", ["-g", "-a", "IcedCoffee"], { stdio: "ignore", detached: true }).unref();
            let up = false; for (let i = 0; i < 24 && !up; i++) { await delay(500); try { await dial(); up = true; } catch { /* keep waiting */ } }
            if (up && method !== "mcp:hello") void noticeChange().catch(() => {});
            if (!up) throw new Error("IcedCoffee isn't open. Ask the person to open the IcedCoffee app (with their résumé), then try again.");
        }
    }
    const id = ++seq;
    return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); sock.write(JSON.stringify({ id, method, params, client, relay: 1 /* this process takes its tools from the app: see catalog.mjs */ }) + "\n"); setTimeout(() => { if (waiting.delete(id)) reject(new Error("IcedCoffee didn't answer in time.")); }, 60000); });
}

/* ---- MCP over stdio: newline-delimited JSON-RPC 2.0 ---- */
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// The running app is the authority on what tools exist (see catalog.mjs); this process may be hours older than the app.
let offered = "";                                                       // what we last told the client, to notice a change
const remember = (tools) => { offered = JSON.stringify(tools.map((t) => [t.name, t.inputSchema])); return tools; };
let liveInstructions = INSTRUCTIONS;
async function currentTools({ launch = false } = {}) {
    try { const hello = await app("mcp:hello", {}, { launch }); if (hello?.instructions) liveInstructions = hello.instructions; if (Array.isArray(hello?.tools) && hello.tools.length) return hello.tools; } catch { /* not running, or an IcedCoffee from before the relay */ }
    return TOOLS;
}
async function runTool(name, args) {
    try { return await app("mcp:call", { name, args }); }
    catch (e) { if (!/unknown method mcp:call/.test(String(e?.message))) throw e; return callTool(name, args, app); }   // an older IcedCoffee: route it ourselves
}
// after any (re)connection to the app — it may have been updated since we last looked — tell the client if the tools changed
async function noticeChange() { const tools = await currentTools(); const was = offered; remember(tools); if (was && was !== offered) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    if (msg.id === undefined || msg.id === null) return;                                   // notifications need no answer
    const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
    try {
        if (msg.method === "initialize") { const n = String(msg.params?.clientInfo?.title || msg.params?.clientInfo?.name || ""); if (n) client = /claude/i.test(n) ? (/code/i.test(n) ? "Claude Code" : "Claude") : n.slice(0, 40); }
        if (msg.method === "initialize") { await currentTools().catch(() => {}); return reply({ protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: true } }, serverInfo: { name: "icedcoffee", title: "IcedCoffee", version: "0.3.0" }, instructions: liveInstructions }); }
        if (msg.method === "ping") return reply({});
        if (msg.method === "tools/list") return reply({ tools: remember(await currentTools()) });
        if (msg.method === "tools/call") { try { return reply(await runTool(msg.params?.name, msg.params?.arguments || {})); } catch (e) { return reply(text(String(e?.message || e), true)); } }
        if (msg.method === "resources/list") return reply({ resources: [] });
        if (msg.method === "prompts/list") return reply({ prompts: [] });
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    } catch (e) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } }); }
});
process.stdin.on("end", () => process.exit(0));
