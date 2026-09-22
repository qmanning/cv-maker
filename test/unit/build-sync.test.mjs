// Checks that src/ is what dist/ was actually built from — i.e. the committed build isn't stale.
// This matters more here than in most repos: dist/ is COMMITTED and is what ships ("one prebuilt folder,
// no build"), so nothing else stands between src/ and what a user actually runs.
//
// Rebuilds into a TEMP outdir (reusing build.mjs's own `runBuild`, so this exercises the exact same
// esbuild config/plugin as `npm run build`) and never touches the real dist/. Everything is then compared
// BYTE FOR BYTE — entry files and every chunk — after normalising the content hashes that esbuild embeds
// in chunk filenames. Those hashes are stable run to run but move when the toolchain or a dependency
// version changes, which is why they are normalised rather than compared: the hash is not the point, the
// code is. (An earlier version of this file compared icedcoffee.js by LENGTH within ±1%, which a totally
// different ~700 KB bundle would have passed.)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./_helpers.mjs";
import { runBuild } from "../../build.mjs";

const distDir = path.join(repoRoot, "dist");
const tmpOutdir = fs.mkdtempSync(path.join(os.tmpdir(), "icedcoffee-build-sync-"));

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

/** chunk files are `chunks/<name>-<8-char content hash>.js`; the hash moves with the toolchain, the name doesn't */
const HASHED = /^(.+)-[A-Z0-9]{8}\.js$/;
const chunkNames = (dir) => (fs.existsSync(path.join(dir, "chunks")) ? fs.readdirSync(path.join(dir, "chunks")).sort() : []);
const canonical = (file) => file.replace(HASHED, "$1-HASH.js");

/** rewrite every real chunk filename appearing in `text` to its canonical form, so two builds whose chunk
 *  hashes differ can still be compared byte for byte. Literal replacement — only actual filenames match. */
function normalize(text, dir) {
    for (const file of chunkNames(dir)) text = text.split(file).join(canonical(file));
    return text;
}
const readNormalized = (dir, relPath) => normalize(fs.readFileSync(path.join(dir, relPath), "utf8"), dir);

test("the temp build's entry files match dist/'s (same set of top-level outputs)", () => {
    const distTop = fs.readdirSync(distDir).filter((f) => f !== "chunks").sort();
    const tmpTop = fs.readdirSync(tmpOutdir).filter((f) => f !== "chunks").sort();
    assert.deepEqual(tmpTop, distTop, "top-level build outputs differ between dist/ and a fresh build from src/");
});

test("dist/ and a fresh build have the same chunks (by name, ignoring the content hash)", () => {
    const distChunks = chunkNames(distDir), tmpChunks = chunkNames(tmpOutdir);
    assert.ok(distChunks.length > 0, "dist/chunks/ is empty — the committed build is missing its code-split chunks");
    assert.ok(distChunks.every((f) => HASHED.test(f)), `unexpected chunk filename shape in dist/chunks/: ${distChunks.join(", ")}`);
    assert.deepEqual(tmpChunks.map(canonical), distChunks.map(canonical), "dist/chunks/ and a fresh build from src/ contain different chunks");
});

test("icedcoffee.css is byte-identical between dist/ and a fresh build from src/", () => {
    const distCss = fs.readFileSync(path.join(distDir, "icedcoffee.css"));
    const tmpCss = fs.readFileSync(path.join(tmpOutdir, "icedcoffee.css"));
    assert.ok(distCss.equals(tmpCss), "dist/icedcoffee.css differs from a fresh build — dist/ may be stale relative to src/");
});

test("icedcoffee.js is byte-identical to a fresh build from src/ (chunk hashes normalised)", () => {
    const distJs = readNormalized(distDir, "icedcoffee.js");
    const tmpJs = readNormalized(tmpOutdir, "icedcoffee.js");
    assert.equal(
        distJs.length, tmpJs.length,
        `dist/icedcoffee.js is ${distJs.length} chars, a fresh build from src/ is ${tmpJs.length} — dist/ is stale, run \`npm run build\``,
    );
    assert.ok(distJs === tmpJs, "dist/icedcoffee.js differs from a fresh build from src/ — dist/ is stale, run `npm run build`");
});

test("every chunk is byte-identical to a fresh build from src/ (chunk hashes normalised)", () => {
    const byName = (dir) => new Map(chunkNames(dir).map((f) => [canonical(f), f]));
    const distByName = byName(distDir), tmpByName = byName(tmpOutdir);
    for (const [name, distFile] of distByName) {
        const tmpFile = tmpByName.get(name);
        assert.ok(tmpFile, `dist/chunks/${distFile} has no counterpart in a fresh build from src/`);
        const a = normalize(fs.readFileSync(path.join(distDir, "chunks", distFile), "utf8"), distDir);
        const b = normalize(fs.readFileSync(path.join(tmpOutdir, "chunks", tmpFile), "utf8"), tmpOutdir);
        assert.equal(a.length, b.length, `dist/chunks/${distFile} is ${a.length} chars, the fresh build's ${tmpFile} is ${b.length} — dist/ is stale, run \`npm run build\``);
        assert.ok(a === b, `dist/chunks/${distFile} differs from the fresh build's ${tmpFile} — dist/ is stale, run \`npm run build\``);
    }
});

// best-effort cleanup of the temp outdir, after all tests in this file have run; never touches dist/
after(() => {
    fs.rmSync(tmpOutdir, { recursive: true, force: true });
});
