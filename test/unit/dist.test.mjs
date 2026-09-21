// Sanity/portability checks on the COMMITTED build (dist/itera.js, dist/itera.css, dist/chunks/*)
// — not a rebuild. Confirms the published artifact is self-contained, has no absolute filesystem paths
// or personal-identity leaks baked in, and that index.html/config.js stay relocatable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./_helpers.mjs";

const distDir = path.join(repoRoot, "dist");
const jsPath = path.join(distDir, "itera.js");
const cssPath = path.join(distDir, "itera.css");

const js = fs.readFileSync(jsPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

// the author's own details must never ship in the sample or the bundle
const PRIVACY_NEEDLES = ["Manning", "qmanning"];

test("dist/itera.js and dist/itera.css exist and are non-trivial in size", () => {
    assert.ok(fs.statSync(jsPath).size > 50_000, "itera.js seems too small to be the real bundle");
    assert.ok(fs.statSync(cssPath).size > 2_000, "itera.css seems too small to be the real stylesheet");
});

test("every chunk itera.js imports (static or dynamic) exists on disk, relative to dist/", () => {
    const specifiers = new Set();
    for (const m of js.matchAll(/from"(\.[^"]+)"/g)) specifiers.add(m[1]);
    for (const m of js.matchAll(/from'(\.[^']+)'/g)) specifiers.add(m[1]);
    for (const m of js.matchAll(/import\("(\.[^"]+)"\)/g)) specifiers.add(m[1]);
    for (const m of js.matchAll(/import\('(\.[^']+)'\)/g)) specifiers.add(m[1]);
    assert.ok(specifiers.size > 0, "expected at least one relative import/chunk specifier in itera.js");
    for (const spec of specifiers) {
        const resolved = path.join(distDir, spec);
        assert.ok(fs.existsSync(resolved), `chunk "${spec}" imported by itera.js does not exist at ${resolved}`);
    }
});

test("dist files contain no absolute filesystem paths from this machine", () => {
    for (const [name, text] of [["itera.js", js], ["itera.css", css]]) {
        assert.doesNotMatch(text, /\/Users\//, `${name} unexpectedly contains a /Users/ path`);
        assert.doesNotMatch(text, /\/Volumes\//, `${name} unexpectedly contains a /Volumes/ path`);
    }
});

test("dist files contain none of the privacy-guard strings", () => {
    for (const [name, text] of [["itera.js", js], ["itera.css", css]]) {
        // the tool credits its author in the ⋯ menu ("Itera by Q Manning" → qmanning.com/labs/itera) — that is
        // intended. What must never ship is anything ELSE about him, so the credit is removed before the check: any
        // other mention (a résumé line, an email, a social handle) still fails.
        const withoutCredit = text.replaceAll("https://qmanning.com/labs/itera", "").replaceAll("by Q Manning", "").replace(/qmanning\.com (?:\u2197|\\u2197)/g, "");
        for (const needle of PRIVACY_NEEDLES) {
            assert.doesNotMatch(withoutCredit, new RegExp(needle.replace(/[.]/g, "\\."), "i"), `${name} contains "${needle}" outside the intended credit`);
        }
    }
});

test("index.html loads only relative URLs (works at any URL depth)", () => {
    const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
    // asset references only — <link rel="author"> points at the author's site on purpose and loads nothing
    const assets = html.replace(/<link[^>]+rel="author"[^>]*>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const urlAttrs = [...assets.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(urlAttrs.length > 0, "expected at least one href/src in index.html");
    for (const url of urlAttrs) {
        assert.ok(!url.startsWith("/"), `index.html url "${url}" starts with a leading "/" — breaks at non-root depths`);
        assert.doesNotMatch(url, /^https?:/, `index.html url "${url}" is an absolute http(s) URL`);
    }
});

test("config.js parses as valid JS and, with its commented examples left commented, only sets window.ITERA = {}", () => {
    const src = fs.readFileSync(path.join(repoRoot, "config.js"), "utf8");
    // parses without throwing
    new Function(src);
    const sandbox = { window: {} };
    // eslint-disable-next-line no-new-func
    new Function("window", src)(sandbox.window);
    assert.deepEqual(sandbox.window.ITERA, {});
});
