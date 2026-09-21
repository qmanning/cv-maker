#!/usr/bin/env node
// electron/smoke.mjs — launches the desktop app hidden, clicks Export → PDF and Export → PNG like a
// person would, then checks what came out. If puppeteer is resolvable (here, or from the node_modules
// folder named in CVM_PUPPETEER_FROM), it also renders the SAME payload the way ../server.mjs does
// and compares the two PDFs page by page: count, size, and every text run's string + position.
//
//   npm run smoke                      → evidence lands in electron/.smoke/
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, ".smoke");
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const fail = (msg) => { console.error("✗ " + msg); process.exit(1); };

const run = spawnSync(require("electron"), [here], { env: { ...process.env, CVM_SMOKE_DIR: out }, stdio: "inherit", timeout: 120000 });
const result = JSON.parse(fs.readFileSync(path.join(out, "result.json"), "utf8"));
console.log(JSON.stringify(result, null, 2));
if (run.status !== 0 || !result.ok) fail("the app did not complete both exports");
if (result.problems.length) fail("console errors / CSP violations in the editor window");
for (const s of result.saved) if (s.state !== "completed") fail(`download ${s.file}: ${s.state}`);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
async function describe(file) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i), [x0, y0, x1, y1] = page.view;
        const items = (await page.getTextContent()).items.filter((t) => t.str.trim());
        pages.push({ size: [x1 - x0, y1 - y0].map((n) => Math.round(n * 100) / 100), runs: items.map((t) => ({ str: t.str, x: t.transform[4], y: t.transform[5], h: t.height })) });
    }
    return pages;
}
const mine = await describe(path.join(out, "electron.pdf"));
const payload = JSON.parse(fs.readFileSync(path.join(out, "payload-pdf.json"), "utf8"));
console.log(`electron.pdf: ${mine.length} page(s), ${mine.map((p) => p.size.join("×") + "pt").join(", ")}, ${mine.reduce((n, p) => n + p.runs.length, 0)} text runs`);
if (mine.length !== result.info.pages && !(mine.length === 1 && result.info.pages === 0)) fail(`editor shows ${result.info.pages} page number(s) but the PDF has ${mine.length} page(s)`);
for (const p of mine) if (Math.abs(p.size[0] - payload.widthPt) > 0.5 || Math.abs(p.size[1] - payload.heightPt) > 0.5) fail(`page is ${p.size.join("×")}pt, expected ${payload.widthPt}×${payload.heightPt}pt`);
if (!mine.some((p) => p.runs.length)) fail("the PDF has no real text");

const png = fs.readFileSync(path.join(out, "electron.png"));
const pngW = png.readUInt32BE(16), pngH = png.readUInt32BE(20), wantW = Math.round(payload.widthPt * 96 / 72) * 2;
console.log(`electron.png: ${pngW}×${pngH}`);
if (pngW !== wantW) fail(`PNG is ${pngW}px wide, expected ${wantW}`);

let puppeteer = null;
for (const from of [here, process.env.CVM_PUPPETEER_FROM].filter(Boolean)) {
    try { puppeteer = (await import(pathToFileURL(createRequire(path.join(from, "x.js")).resolve("puppeteer")).href)).default; break; } catch { /* try the next */ }
}
if (!puppeteer) { console.log("• puppeteer not found — skipped the side-by-side PDF comparison (set CVM_PUPPETEER_FROM)"); console.log("✓ smoke passed"); process.exit(0); }

// exactly what ../server.mjs does
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--font-render-hinting=none"] });
try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req) => (/^(data|about|blob):/i.test(req.url()) ? req.continue() : req.abort()));
    await page.setViewport({ width: Math.round(payload.widthPt * 96 / 72), height: Math.round(payload.heightPt * 96 / 72), deviceScaleFactor: 1 });
    await page.setContent(payload.html, { waitUntil: "load" });
    fs.writeFileSync(path.join(out, "puppeteer.pdf"), await page.pdf({ width: `${payload.widthPt / 72}in`, height: `${payload.heightPt / 72}in`, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } }));
    console.log("puppeteer Chrome: " + (await browser.version()));
} finally { await browser.close().catch(() => {}); }

const theirs = await describe(path.join(out, "puppeteer.pdf"));
if (theirs.length !== mine.length) fail(`page count differs: electron ${mine.length}, puppeteer ${theirs.length}`);
let worst = 0;
for (let i = 0; i < mine.length; i++) {
    const a = mine[i].runs, b = theirs[i].runs;
    if (a.map((r) => r.str).join("\n") !== b.map((r) => r.str).join("\n")) fail(`page ${i + 1}: the text runs differ (a line broke differently)`);
    for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k].x - b[k].x), Math.abs(a[k].y - b[k].y));
}
console.log(`side by side: same ${mine.length} page(s), same text runs, largest position difference ${worst.toFixed(3)}pt`);
if (worst > 0.5) fail("text positions drift by more than half a point");
console.log("✓ smoke passed — Electron's PDF matches puppeteer's");
