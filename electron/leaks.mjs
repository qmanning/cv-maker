#!/usr/bin/env node
// electron/leaks.mjs — `npm run leaks`: runs the app hidden through two equal batches of work (MCP edit + undo, zoom,
// exports, the Settings window) and compares forced-GC measurements: warmed-up baseline → after batch 1 → after batch 2.
// A leak shows as growth that REPEATS in the second batch; one-off growth that then flattens is caches filling.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), out = path.join(here, ".leaks");
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const electron = createRequire(import.meta.url)("electron");
spawnSync(electron, ["--js-flags=--expose-gc", here], { env: { ...process.env, CVM_SMOKE_DIR: out, CVM_LEAK: "1" }, stdio: "inherit", timeout: 20 * 60 * 1000 });
const r = JSON.parse(fs.readFileSync(path.join(out, "leak.json"), "utf8"));
if (!r.ok) { console.error("✗ leak check did not finish:", r.error); process.exit(1); }
const { before, middle, after, rounds } = r.leak, keys = Object.keys(before);
console.log(`\n${rounds} rounds per batch (each: MCP edit + insert block + undo, zoom; every 4th opens Settings, every 5th exports)\n`);
console.log("metric".padEnd(14), "baseline".padStart(10), "batch 1".padStart(10), "batch 2".padStart(10), "  growth in batch 2");
let bad = [];
for (const k of keys) {
    const d2 = +(after[k] - middle[k]).toFixed(2);
    console.log(k.padEnd(14), String(before[k]).padStart(10), String(middle[k]).padStart(10), String(after[k]).padStart(10), "  " + (d2 > 0 ? "+" : "") + d2);
    const limit = { pageHeapMB: 3, mainHeapMB: 3, mainRssMB: 60, domNodes: 50, listeners: 5 }[k] ?? 0;
    if (d2 > limit) bad.push(`${k} grew by ${d2} in the second batch`);
}
console.log(bad.length ? "\n✗ possible leak: " + bad.join("; ") : "\n✓ nothing keeps growing");
process.exit(bad.length ? 1 : 0);
