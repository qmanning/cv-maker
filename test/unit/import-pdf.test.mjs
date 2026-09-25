// Integration tests for src/import/pdf.ts: real PDFs (Chromium's print of the sample résumé and two hand-made
// ones, in test/fixtures/import/) read by the node ("legacy") build of pdf.js — the same extraction the app runs,
// minus the canvas that crops pictures (injected as null here).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundleAndImport, repoRoot } from "./_helpers.mjs";

const { pdfToFlow } = await bundleAndImport("src/import/pdf.ts", { external: ["pdfjs-dist", "pdfjs-dist/*"] });
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const read = (name) => {
    const buf = fs.readFileSync(path.join(repoRoot, "test", "fixtures", "import", name));
    return pdfToFlow(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name.replace(/\.pdf$/, ""), { pdfjs, canvas: null });
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the classic one-column résumé: centred name, ruled headings, dates on right tabs, bullets, a numbered list", async () => {
    const r = await read("classic-resume.pdf");
    assert.equal(r.title, "Jordan Vale Resume");
    assert.deepEqual([r.page.widthPt, r.page.heightPt], [612, 792]);
    assert.equal(r.needsAi, undefined);
    assert.match(r.html, /^<p style="[^"]*font-size: 22pt; color: #1a3c6e; font-weight: 700; text-align: center">Jordan Vale<\/p>/);
    for (const h of ["SUMMARY", "EXPERIENCE", "EDUCATION", "SKILLS"]) assert.match(r.html, new RegExp(`<p style="font-family: Helvetica, sans-serif; font-size: 12pt; color: #1a3c6e; font-weight: 700;[^"]*border-bottom: 1.5pt solid #1a3c6e[^"]*">${h}</p>`));
    assert.match(r.html, /Northline Freight — Operations Manager<span data-flow-tab="right" data-flow-pos="[\d.]+"><\/span>Mar 2020 – Present/);
    assert.match(r.html, /Harbor &amp; Main — Shift Supervisor<span data-flow-tab="right"[^>]*><\/span>2016 – 2020/);
    assert.match(r.html, /<li>Cut average dock-to-stock time from 11 hours to 4 by reorganizing receiving shifts around actual truck arrival patterns rather than the published schedule\.<\/li>/);
    assert.match(r.html, /<ol[^>]*><li>Lean process design<\/li>/);
    assert.match(r.html, /<a href="mailto:jordan@vale.example">jordan@vale.example<\/a>/);
    assert.match(r.html, /<p style="font-style: italic">Chicago, IL<\/p>/);
    assert.equal(r.base.fontFamily, "Georgia, serif");
});

test("the sidebar résumé: a header over two columns", async () => {
    const r = await read("sidebar-resume.pdf");
    assert.match(r.html, /^<p[^>]*font-size: 24pt[^>]*>Sam Rivera<\/p><p[^>]*>Data Analyst<\/p><div data-flow-cols>/);
    const [, side, main] = r.html.split("<div data-flow-col ");
    assert.match(text(side), /Contact sam@rivera\.example Austin, TX Skills SQL Python Tableau dbt Languages English, Spanish/);
    assert.match(side, /<ul[^>]*><li>SQL<\/li>/);
    assert.match(text(main), /Experience Analyst, Brightwell Health Built the weekly readmissions dashboard used by twelve clinic managers to plan staffing\./);
    assert.match(main, /could self-serve\.<\/li>/);
});

test("the app's own sample résumé (two pages, columns of bullets, links, rules)", async () => {
    const r = await read("sample-resume.pdf");
    assert.equal(r.title, "Mara Quill — Résumé");
    assert.match(r.html, /<p style="font-size: 12pt; font-weight: 700[^"]*">Mara Quill<\/p>/);
    for (const h of ["Experience", "Education and Recognition", "What I'm Good At", "Tools &amp; Methods"]) assert.match(r.html, new RegExp(`<p style="[^"]*font-weight: 700[^"]*">${h}</p>`));
    assert.match(r.html, /<a href="https:\/\/github.com\/maraquill">github.com\/maraquill<\/a>/);
    // the job bullets flow in two columns; each column is a list whose items joined their wrapped lines
    assert.match(r.html, /<div data-flow-cols><div data-flow-col style="width: [\d.]+pt"><ul[^>]*><li>Cut fare-purchase time in the rider app from 94 seconds to 31 by removing three screens nobody needed and one they did\.<\/li>/);
    assert.match(r.html, /<li[^>]*>Built the design system operators and riders now share, so a fix to one surface doesn't quietly break the other\.<\/li>/);
    // the skills columns continue across the page break
    assert.match(text(r.html), /Research: field visits.*Mentoring: growing designers who outgrow needing me in the room/);
    assert.match(r.html, /<li><strong>Research: <\/strong>field visits/);
    assert.match(r.html, /<hr style="border-top: 0.75pt solid #eeeeee/);
    assert.ok(r.warnings.some((w) => /picture/.test(w)), "the logo is reported as left out when there is no canvas");
});
