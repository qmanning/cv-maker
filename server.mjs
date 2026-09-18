#!/usr/bin/env node
// server.mjs — optional local export server for CV Maker.
//
// Renders the editor's export HTML in headless Chrome (via puppeteer) to produce a real-text,
// selectable PDF or a PNG screenshot. Point config.js's `exportServer` at this (e.g.
// "http://localhost:7332/export") for one-click exports; without it, CV Maker still works — PDF falls
// back to the browser's print dialog and PNG to an in-browser render.
//
// Usage:  node server.mjs [port]      (default 7332)
//
// puppeteer is NOT a dependency of this repo — it's a big download most users won't need. Install it
// yourself, next to this file:
//
//   npm i puppeteer
//
// Without it installed, this server still starts and answers every /export request with 501 and a
// JSON message telling you to install it.
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.argv[2] || process.env.PORT || 7332);
const PT_TO_PX = 96 / 72;
const MAX_BODY = 25 * 1024 * 1024; // ~25MB

function isAllowedOrigin(origin) {
    if (!origin) return false;
    try {
        const { hostname } = new URL(origin);
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
        return false;
    }
}

function withCors(req, res) {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
}

async function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0, over = false;
        const chunks = [];
        req.on("data", (c) => {
            if (over) return;                         // keep draining so the 413 below can still be delivered
            size += c.length;
            if (size > MAX_BODY) {
                over = true; chunks.length = 0;
                // don't destroy the socket: the response travels on it. Reject with a status the handler can send.
                reject(Object.assign(new Error("Request body too large"), { status: 413, payload: { error: "Request body too large", limitBytes: MAX_BODY } }));
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
        req.on("error", reject);
    });
}

let puppeteerModule;
async function getPuppeteer() {
    if (puppeteerModule !== undefined) return puppeteerModule;
    try {
        puppeteerModule = (await import("puppeteer")).default;
    } catch {
        puppeteerModule = null;
    }
    return puppeteerModule;
}

async function renderExport(body) {
    const puppeteer = await getPuppeteer();
    if (!puppeteer) {
        const err = new Error("puppeteer not installed");
        err.status = 501;
        err.payload = { error: "Headless Chrome is not available here. Run `npm i puppeteer` next to server.mjs, then restart it." };
        throw err;
    }
    const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--font-render-hinting=none"] });
    try {
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on("request", (req) => (/^(data|about|blob):/i.test(req.url()) ? req.continue() : req.abort()));
        const width = Math.round(body.widthPt * PT_TO_PX);
        const scale = Math.min(4, Math.max(1, body.scale || 2));
        await page.setViewport({ width, height: Math.round(body.heightPt * PT_TO_PX), deviceScaleFactor: body.format === "png" ? scale : 1 });
        await page.setContent(body.html, { waitUntil: "load" });

        if (body.format === "pdf") {
            const pdf = await page.pdf({
                width: `${body.widthPt / 72}in`,
                height: `${body.heightPt / 72}in`,
                printBackground: true,
                preferCSSPageSize: true,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
            });
            return { buffer: Buffer.from(pdf), contentType: "application/pdf" };
        }
        const png = await page.screenshot({ type: "png", fullPage: true });
        return { buffer: Buffer.from(png), contentType: "image/png" };
    } finally {
        await browser.close().catch(() => {});
    }
}

const server = http.createServer(async (req, res) => {
    withCors(req, res);

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "cv-maker export server", port: PORT }));
        return;
    }

    if (req.method === "POST" && url.pathname === "/export") {
        const started = Date.now();
        try {
            const text = await readBody(req);
            let body = null;
            try { body = JSON.parse(text); } catch { /* malformed JSON is a client error: falls into the 400 below */ }
            if (!body || typeof body.html !== "string" || !["pdf", "png"].includes(body.format) || !(body.widthPt > 0) || !(body.heightPt > 0)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Expected { html, format: 'pdf'|'png', widthPt, heightPt, scale? }" }));
                return;
            }
            const { buffer, contentType } = await renderExport(body);
            res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
            res.end(buffer);
            console.log(`[export] ${body.format} ${body.widthPt}x${body.heightPt}pt — ${buffer.length}B in ${Date.now() - started}ms`);
        } catch (e) {
            const status = e.status || 500;
            const payload = e.payload || { error: "Export failed", detail: String(e && e.message ? e.message : e) };
            res.writeHead(status, { "content-type": "application/json", ...(status === 413 ? { connection: "close" } : {}) });
            res.end(JSON.stringify(payload));
            console.log(`[export] failed (${status}): ${payload.error}`);
        }
        return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`cv-maker export server: http://127.0.0.1:${PORT}/`);
});
