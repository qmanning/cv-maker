// Unit tests for the pure string/DOM helpers in src/cv-source.ts. No React, no bundler needed at test
// time: esbuild transforms the TS to JS on the fly, and jsdom supplies DOMParser for parseSource().
import { test } from "node:test";
import assert from "node:assert/strict";
import { installJsdom, importTransformed } from "./_helpers.mjs";

installJsdom();

const { slugify, fullHtml, parseSource, pageBoxCss, PAPERS, MIN_FIT } = await importTransformed("src/cv-source.ts");

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
