// Sanity/portability checks on the COMMITTED build (dist/cv-maker.js, dist/cv-maker.css, dist/chunks/*)
// — not a rebuild. Confirms the published artifact is self-contained, has no absolute filesystem paths
// or personal-identity leaks baked in, and that index.html/config.js stay relocatable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./_helpers.mjs";

const distDir = path.join(repoRoot, "dist");
const jsPath = path.join(distDir, "cv-maker.js");
const cssPath = path.join(distDir, "cv-maker.css");

const js = fs.readFileSync(jsPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

const PRIVACY_NEEDLES = ["Manning", "qmanning"]   // the author's own details must never ship in the sample or the bundle;

test("dist/cv-maker.js and dist/cv-maker.css exist and are non-trivial in size", () => {
    assert.ok(fs.statSync(jsPath).size > 50_000, "cv-maker.js seems too small to be the real bundle");
    assert.ok(fs.statSync(cssPath).size > 2_000, "cv-maker.css seems too small to be the real stylesheet");
});

test("every chunk cv-maker.js imports (static or dynamic) exists on disk, relative to dist/", () => {
    const specifiers = new Set();
    for (const m of js.matchAll(/from"(\.[^"]+)"/g)) specifiers.add(m[1]);
    for (const m of js.matchAll(/from'(\.[^']+)'/g)) specifiers.add(m[1]);
    for (const m of js.matchAll(/import\("(\.[^"]+)"\)/g)) specifiers.add(m[1]);
    for (const m of js.matchAll(/import\('(\.[^']+)'\)/g)) specifiers.add(m[1]);
    assert.ok(specifiers.size > 0, "expected at least one relative import/chunk specifier in cv-maker.js");
    for (const spec of specifiers) {
        const resolved = path.join(distDir, spec);
        assert.ok(fs.existsSync(resolved), `chunk "${spec}" imported by cv-maker.js does not exist at ${resolved}`);
    }
});

test("dist files contain no absolute filesystem paths from this machine", () => {
    for (const [name, text] of [["cv-maker.js", js], ["cv-maker.css", css]]) {
        assert.doesNotMatch(text, /\/Users\//, `${name} unexpectedly contains a /Users/ path`);
        assert.doesNotMatch(text, /\/Volumes\//, `${name} unexpectedly contains a /Volumes/ path`);
    }
});

test("dist files contain none of the privacy-guard strings", () => {
    for (const [name, text] of [["cv-maker.js", js], ["cv-maker.css", css]]) {
        for (const needle of PRIVACY_NEEDLES) {
            assert.doesNotMatch(text, new RegExp(needle.replace(/[.]/g, "\\.")), `${name} unexpectedly contains "${needle}"`);
        }
    }
});

test("index.html references only relative URLs (works at any URL depth)", () => {
    const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
    const urlAttrs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(urlAttrs.length > 0, "expected at least one href/src in index.html");
    for (const url of urlAttrs) {
        assert.ok(!url.startsWith("/"), `index.html url "${url}" starts with a leading "/" — breaks at non-root depths`);
        assert.doesNotMatch(url, /^https?:/, `index.html url "${url}" is an absolute http(s) URL`);
    }
});

test("config.js parses as valid JS and, with its commented examples left commented, only sets window.CV_MAKER = {}", () => {
    const src = fs.readFileSync(path.join(repoRoot, "config.js"), "utf8");
    // parses without throwing
    new Function(src);
    const sandbox = { window: {} };
    // eslint-disable-next-line no-new-func
    new Function("window", src)(sandbox.window);
    assert.deepEqual(sandbox.window.CV_MAKER, {});
});
