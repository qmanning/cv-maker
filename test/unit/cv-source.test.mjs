// Unit tests for the pure string/DOM helpers in src/cv-source.ts. No React, no bundler needed at test
// time: esbuild transforms the TS to JS on the fly, and jsdom supplies DOMParser for parseSource().
import { test } from "node:test";
import assert from "node:assert/strict";
import { installJsdom, importTransformed } from "./_helpers.mjs";

installJsdom();

const { slugify, fullHtml, parseSource, migrateCss, pageBoxCss, PAPERS, MIN_FIT, stepZoom } = await importTransformed("src/cv-source.ts");

/* ---------------- parseSource ---------------- */

test("parseSource extracts the .cv-page, its <style>, the title, and counts [data-cv-edit]", () => {
    const text = `<!doctype html><html><head><title>Sample</title><style>.cv-page{color:#000}</style></head><body><div class="cv-page"><p data-cv-edit>hi</p><p data-cv-edit>bye</p></div></body></html>`;
    const parsed = parseSource(text);
    assert.equal(parsed.name, "Sample");
    assert.equal(parsed.regions, 2);
    assert.match(parsed.css, /\.cv-page\{color:#000\}/);
    assert.match(parsed.html, /class="cv-page"/);
});

test("parseSource strips scripts and inline event handlers", () => {
    const text = `<html><body><div class="cv-page"><script>alert(1)</script><p onclick="alert(2)">hi</p></div></body></html>`;
    const parsed = parseSource(text);
    assert.doesNotMatch(parsed.html, /<script/i);
    assert.doesNotMatch(parsed.html, /onclick/i);
});

test("parseSource strips iframe, object, embed as well as script", () => {
    const text = `<html><body><div class="cv-page"><iframe src="https://evil.example"></iframe><object data="x"></object><embed src="y"></div></body></html>`;
    const parsed = parseSource(text);
    assert.doesNotMatch(parsed.html, /<iframe/i);
    assert.doesNotMatch(parsed.html, /<object/i);
    assert.doesNotMatch(parsed.html, /<embed/i);
});

test("parseSource strips on* attributes across multiple elements, case-insensitively", () => {
    const text = `<html><body><div class="cv-page"><p onclick="a()" OnMouseOver="b()" data-keep="1">hi</p><a href="#" onfocus="c()">link</a></div></body></html>`;
    const parsed = parseSource(text);
    assert.doesNotMatch(parsed.html, /onclick/i);
    assert.doesNotMatch(parsed.html, /onmouseover/i);
    assert.doesNotMatch(parsed.html, /onfocus/i);
    assert.match(parsed.html, /data-keep="1"/);
});

test("parseSource strips javascript: and other script-scheme URLs (they would run in the app's own origin)", () => {
    const text = `<html><body><div class="cv-page">
        <a id="js" href="javascript:alert(1)">x</a>
        <a id="jsmix" href="  JaVaScRiPt:alert(1)">x</a>
        <a id="vb" href="vbscript:msgbox">x</a>
        <a id="datahtml" href="data:text/html,<script>alert(1)</script>">x</a>
        <form id="f" action="javascript:alert(1)"><button formaction="javascript:alert(1)" id="b">go</button></form>
        <img id="js-src" src="javascript:alert(1)">
    </div></body></html>`;
    const parsed = parseSource(text);
    const doc = new DOMParser().parseFromString(parsed.html, "text/html");
    for (const id of ["js", "jsmix", "vb", "datahtml"]) assert.equal(doc.getElementById(id).hasAttribute("href"), false, `#${id} kept its href`);
    assert.equal(doc.getElementById("f").hasAttribute("action"), false);
    assert.equal(doc.getElementById("b").hasAttribute("formaction"), false);
    assert.equal(doc.getElementById("js-src").hasAttribute("src"), false);
    assert.doesNotMatch(parsed.html, /javascript:|vbscript:/i);
});

test("parseSource strips script schemes disguised with tabs/newlines/controls (browsers strip those before parsing)", () => {
    // each of these reads as `javascript:alert(1)` to a browser's URL parser, so it must not survive
    const sneaky = ["java\tscript:alert(1)", "java\nscript:alert(1)", "java\rscript:alert(1)", "\u0001javascript:alert(1)", " \t javascript:alert(1)", "JAVA\tSCRIPT:alert(1)"];
    const doc = new DOMParser().parseFromString('<html><body><div class="cv-page"></div></body></html>', "text/html");
    const page = doc.querySelector(".cv-page");
    sneaky.forEach((href, i) => { const a = doc.createElement("a"); a.id = "a" + i; a.setAttribute("href", href); a.textContent = "x"; page.append(a); });
    const parsed = parseSource(doc.documentElement.outerHTML);
    const out = new DOMParser().parseFromString(parsed.html, "text/html");
    sneaky.forEach((href, i) => assert.equal(out.getElementById("a" + i).hasAttribute("href"), false, `kept a disguised script URL: ${JSON.stringify(href)}`));
});

test("parseSource keeps the links and data: images a real resume uses", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const text = `<html><body><div class="cv-page">
        <a id="web" href="https://example.com/a">w</a>
        <a id="mail" href="mailto:me@example.com">m</a>
        <a id="tel" href="tel:+15550100">t</a>
        <a id="anchor" href="#skills">s</a>
        <a id="rel" href="./other.html">r</a>
        <img id="pic" src="${png}" alt="">
    </div></body></html>`;
    const parsed = parseSource(text);
    const doc = new DOMParser().parseFromString(parsed.html, "text/html");
    assert.equal(doc.getElementById("web").getAttribute("href"), "https://example.com/a");
    assert.equal(doc.getElementById("mail").getAttribute("href"), "mailto:me@example.com");
    assert.equal(doc.getElementById("tel").getAttribute("href"), "tel:+15550100");
    assert.equal(doc.getElementById("anchor").getAttribute("href"), "#skills");
    assert.equal(doc.getElementById("rel").getAttribute("href"), "./other.html");
    assert.equal(doc.getElementById("pic").getAttribute("src"), png);   // the template's own images are data: URIs
});

/* ---------------- migrateCss: documents saved before the column-alignment fix ---------------- */

test("migrateCss rewrites the legacy `li + li { margin-top }` list gap to margin-bottom", () => {
    assert.equal(migrateCss(".cv-page li + li { margin-top: 8pt; }"), ".cv-page li:not(:last-child) { margin-bottom: 8pt; }");
    assert.equal(migrateCss("li+li{margin-top:8pt}"), "li:not(:last-child) { margin-bottom: 8pt; }");
    assert.equal(migrateCss(".cv-page  li  +  li  {  margin-top : 0.5em ; }"), ".cv-page  li:not(:last-child) { margin-bottom: 0.5em; }");
});

test("migrateCss keeps the rest of the stylesheet, and the rules around the one it rewrites, intact", () => {
    const css = [".cv-page { color: #111; }", ".cv-page li { margin-left: 12pt; break-inside: avoid; }", ".cv-page li + li { margin-top: 8pt; }", ".cv-flow { column-count: 2; }"].join("\n");
    const out = migrateCss(css);
    assert.match(out, /\.cv-page \{ color: #111; \}/);
    assert.match(out, /\.cv-page li \{ margin-left: 12pt; break-inside: avoid; \}/);
    assert.match(out, /\.cv-flow \{ column-count: 2; \}/);
    assert.match(out, /li:not\(:last-child\) \{ margin-bottom: 8pt; \}/);
    assert.doesNotMatch(out, /li \+ li/);
});

test("migrateCss leaves alone anything that isn't that exact rule", () => {
    for (const css of [
        ".cv-page li + li { margin-top: 8pt; color: red; }",   // more than the one declaration: not ours to rewrite
        ".cv-page p + p { margin-top: 8pt; }",                 // a different selector
        ".cv-page li + li { margin-bottom: 8pt; }",            // already migrated
        ".cv-summary p + p { margin-top: 13.7pt; }",
    ]) assert.equal(migrateCss(css), css, `unexpectedly rewrote: ${css}`);
});

test("parseSource migrates a legacy document's stylesheet as it reads it", () => {
    const text = '<html><head><style>.cv-page li + li { margin-top: 8pt; }</style></head><body><div class="cv-page"><ul><li><p>a</p></li></ul></div></body></html>';
    const parsed = parseSource(text);
    assert.match(parsed.css, /li:not\(:last-child\) \{ margin-bottom: 8pt; \}/);
    assert.doesNotMatch(parsed.css, /li \+ li/);
});

test("parseSource wraps loose body content in a .cv-page div when none exists", () => {
    const text = `<!doctype html><html><head><title>t</title></head><body><p>a</p><p>b</p></body></html>`;
    const parsed = parseSource(text);
    assert.match(parsed.html, /^<div class="cv-page">/);
    assert.match(parsed.html, /<p>a<\/p>/);
    assert.match(parsed.html, /<p>b<\/p>/);
});

test("parseSource: <title> becomes name, trimmed", () => {
    const text = `<!doctype html><html><head><title>  Spaced Title  </title></head><body><div class="cv-page"></div></body></html>`;
    const parsed = parseSource(text);
    assert.equal(parsed.name, "Spaced Title");
});

test("parseSource: region count is exactly the [data-cv-edit] elements, not nested content", () => {
    const text = `<html><body><div class="cv-page"><div data-cv-edit>a</div><div data-cv-edit>b</div><div>c</div></div></body></html>`;
    const parsed = parseSource(text);
    assert.equal(parsed.regions, 2);
});

/* ---------------- pageBoxCss ---------------- */

test("pageBoxCss at scale 1: width equals the page width, zoom: 1, and includes the padding calc", () => {
    const css = pageBoxCss(PAPERS.letter.w, 1);
    assert.match(css, /width: 612\.000pt/);
    assert.match(css, /zoom: 1/);
    assert.match(css, /padding: var\(--cv-pad-top, 16pt\) calc\(\(612\.000pt - var\(--cv-content-w, 562pt\)\) \/ 2\) var\(--cv-pad-bottom, 16pt\)/);
});

test("pageBoxCss at scale 0.94: width is page-width/0.94 and zoom: 0.94", () => {
    const css = pageBoxCss(PAPERS.letter.w, 0.94);
    const expectedWidth = (612 / 0.94).toFixed(3);
    assert.match(css, new RegExp(`width: ${expectedWidth.replace(".", "\\.")}pt`));
    assert.match(css, /zoom: 0\.94/);
    assert.match(css, new RegExp(`calc\\(\\(${expectedWidth.replace(".", "\\.")}pt`));
});

test("pageBoxCss includes the .cvm-pagebreak and .cvm-pageno rules", () => {
    const css = pageBoxCss(PAPERS.letter.w, 1);
    assert.match(css, /\.cvm-pagebreak\s*\{\s*break-before:\s*page;/);
    assert.match(css, /\.cvm-pageno\s*\{[^}]*position:\s*absolute;/);
});

/* ---------------- fullHtml ---------------- */

test("fullHtml wraps body + css with an escaped title", () => {
    const html = fullHtml("A & B <x>", "body{color:red}", "<p>hi</p>");
    assert.match(html, /<!doctype html>/);
    assert.match(html, /<title>A  B x><\/title>/);
    assert.match(html, /color:red/);
    assert.match(html, /<p>hi<\/p>/);
});

test("fullHtml includes an extra <style> block only when provided", () => {
    const withExtra = fullHtml("n", "base", "body", "extra");
    const withoutExtra = fullHtml("n", "base", "body");
    assert.match(withExtra, /<style>extra<\/style>/);
    assert.doesNotMatch(withoutExtra, /<style>extra<\/style>/);
    assert.equal((withoutExtra.match(/<style>/g) || []).length, 1);
});

/* ---------------- slugify ---------------- */

test("slugify", () => {
    assert.equal(slugify("Alex Rivera — Résumé"), "alex-rivera-resume");   // accents fold to their base letter
    assert.equal(slugify(""), "resume");
    assert.equal(slugify("   "), "resume");
    assert.equal(slugify("---"), "resume");
});

/* ---------------- PAPERS / constants ---------------- */

test("PAPERS: letter is 612x792pt, a4 is 595x842pt", () => {
    assert.equal(PAPERS.letter.w, 612);
    assert.equal(PAPERS.letter.h, 792);
    assert.equal(PAPERS.a4.w, 595);
    assert.equal(PAPERS.a4.h, 842);
});

test("MIN_FIT is 0.8 (fit-to-one-page never shrinks below 80%)", () => {
    assert.equal(MIN_FIT, 0.8);
});

test("⌘+ and ⌘− step from wherever the sheet is, including a live fit like 151%", () => {
    assert.equal(stepZoom(1.51, 1), 1.75);
    assert.equal(stepZoom(1.51, -1), 1.5);
    assert.equal(stepZoom(1, 1), 1.1);
    assert.equal(stepZoom(1, -1), 0.9);
    assert.equal(stepZoom(3, 1), 3);
    assert.equal(stepZoom(0.25, -1), 0.25);
});
