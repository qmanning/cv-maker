// Checks that src/ is what dist/ was actually built from — i.e. the committed build isn't stale.
// Rebuilds into a TEMP outdir (reusing build.mjs's own `runBuild`, so this exercises the exact same
// esbuild config/plugin as `npm run build`) and never touches the real dist/. cv-maker.css should come
// out byte-identical (esbuild's CSS output is deterministic); cv-maker.js is compared by length within
// ±1% since minified JS chunk filenames embed a content hash that can legitimately differ run to run
// even when the source is unchanged.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./_helpers.mjs";
import { runBuild } from "../../build.mjs";

const distDir = path.join(repoRoot, "dist");
const tmpOutdir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-maker-build-sync-"));

let buildOk = false;
let buildError;
try {
    await runBuild({ outdir: tmpOutdir });
    buildOk = true;
} catch (e) {
    buildError = e;
}

test("the build into a temp outdir succeeds", () => {
    assert.equal(buildOk, true, `build failed: ${buildError}`);
});

test("the temp build's entry files match dist/'s (same set of top-level outputs)", () => {
    const distTop = fs.readdirSync(distDir).filter((f) => f !== "chunks").sort();
    const tmpTop = fs.readdirSync(tmpOutdir).filter((f) => f !== "chunks").sort();
    assert.deepEqual(tmpTop, distTop, "top-level build outputs differ between dist/ and a fresh build from src/");

    const distChunks = fs.existsSync(path.join(distDir, "chunks")) ? fs.readdirSync(path.join(distDir, "chunks")).length : 0;
    const tmpChunks = fs.existsSync(path.join(tmpOutdir, "chunks")) ? fs.readdirSync(path.join(tmpOutdir, "chunks")).length : 0;
    assert.equal(tmpChunks, distChunks, "different number of chunk files between dist/ and a fresh build from src/");
});

test("cv-maker.css is byte-identical between dist/ and a fresh build from src/", () => {
    const distCss = fs.readFileSync(path.join(distDir, "cv-maker.css"));
    const tmpCss = fs.readFileSync(path.join(tmpOutdir, "cv-maker.css"));
    assert.ok(distCss.equals(tmpCss), "dist/cv-maker.css differs from a fresh build — dist/ may be stale relative to src/");
});

test("cv-maker.js is the same length as a fresh build, within ±1% (chunk-name hashes may differ)", () => {
    const distJs = fs.readFileSync(path.join(distDir, "cv-maker.js"));
    const tmpJs = fs.readFileSync(path.join(tmpOutdir, "cv-maker.js"));
    const diff = Math.abs(distJs.length - tmpJs.length);
    const pct = diff / distJs.length;
    assert.ok(
        pct <= 0.01,
        `dist/cv-maker.js length ${distJs.length} vs fresh build ${tmpJs.length} (${(pct * 100).toFixed(2)}% diff) — exceeds the 1% tolerance`,
    );
});

// best-effort cleanup of the temp outdir, after all tests in this file have run; never touches dist/
after(() => {
    fs.rmSync(tmpOutdir, { recursive: true, force: true });
});
