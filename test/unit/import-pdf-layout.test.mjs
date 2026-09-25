// Unit tests for src/import/pdf-layout.ts — the pure geometry half of the PDF importer. Pages are built by hand
// (text runs at coordinates, rules, bullet dots, pictures), so every rule is exercised without pdf.js or a canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleAndImport } from "./_helpers.mjs";

const { layoutToFlow, cleanFont, SCAN_MESSAGE } = await bundleAndImport("src/import/pdf-layout.ts");

/** a text run whose BASELINE is at `base` (pt from the top); width ≈ 0.5em per character, like a real font */
const t = (str, x, base, size = 10, o = {}) => ({ str, x, y: base - size * 0.8, width: o.width ?? str.length * size * 0.5, height: size, ascent: 0.8, fontName: o.font ?? "ABCDEF+Helvetica", fontFamily: "sans-serif", color: o.color ?? "#000000", ...o });
const page = (items, extra = {}) => ({ width: 612, height: 792, items, images: [], rules: [], ...extra });
const flow = (pages) => layoutToFlow(Array.isArray(pages) ? pages : [pages], { title: "T" });

test("cleanFont drops the subset prefix and style suffixes and finds the weight, the slant and a generic family", () => {
    assert.deepEqual(cleanFont("ABCDEF+TimesNewRomanPS-BoldItalicMT"), { family: "'Times New Roman', serif", weight: 700, italic: true });
    assert.deepEqual(cleanFont("ArialMT"), { family: "Arial, sans-serif", weight: 400, italic: false });
    assert.deepEqual(cleanFont("Calibri,Bold"), { family: "Calibri, sans-serif", weight: 700, italic: false });
    assert.deepEqual(cleanFont("XYZABC+SourceSansPro-Semibold"), { family: "'Source Sans Pro', sans-serif", weight: 600, italic: false });
    assert.equal(cleanFont("g_d0_f3", "serif").family, "serif");
    assert.equal(cleanFont("CourierNewPSMT").family, "'Courier New', monospace");
});

test("wrapped lines of one style join into a paragraph; a short line ends it", () => {
    const r = flow(page([
        t("Operations lead with nine years running regional logistics teams and a knack", 72, 100),
        t("for calm processes that people follow.", 72, 112),
        t("A second paragraph starts here.", 72, 130),
    ]));
    const ps = r.html.match(/<p[^>]*>.*?<\/p>/g);
    assert.equal(ps.length, 2);
    assert.match(ps[0], />Operations lead .* a knack for calm processes that people follow\.<\/p>$/);
    assert.match(ps[1], /margin-top: \d/);
    assert.equal(r.base.fontSizePt, 10);
    assert.equal(r.page.marginLeftPt, 72);
});

test("bullets: a • glyph starts an item, a line indented to its text continues it, dashes and numbers make lists", () => {
    const r = flow(page([
        t("Before the list, a long intro line reaching all the way to the right margin xx", 72, 90),
        t("•", 72, 110), t("Cut average dock-to-stock time from 11 hours to 4 by reorganizing the receiving", 84, 110),
        t("shifts around actual truck arrivals.", 84, 122),
        t("•", 72, 134), t("Led a team of 42 across three sites.", 84, 134),
        t(" Symbol-font bullet from Word", 72, 146),
        t("1. First numbered", 72, 170), t("2. Second numbered", 72, 182),
    ]));
    assert.match(r.html, /<ul[^>]*><li>Cut average dock-to-stock time .* receiving shifts around actual truck arrivals\.<\/li><li[^>]*>Led a team of 42 across three sites\.<\/li><li[^>]*>Symbol-font bullet from Word<\/li><\/ul>/);
    assert.match(r.html, /<ul style="[^"]*margin-left: 12pt/);
    assert.match(r.html, /<ol[^>]*><li>First numbered<\/li><li[^>]*>Second numbered<\/li><\/ol>/);
    assert.doesNotMatch(r.html, /•|/);
});

test("bullets a browser or Word drew as small shapes become list items too", () => {
    const r = flow(page([
        t("Supervised 15 associates on the overnight shift.", 86, 100),
        t("Built the cross-training rota.", 86, 112),
    ], { marks: [{ x: 75, y: 95, w: 3, h: 3, shape: "disc" }, { x: 75, y: 107, w: 3, h: 3, shape: "square" }] }));
    assert.match(r.html, /<ul[^>]*><li>Supervised 15 associates on the overnight shift\.<\/li><li[^>]*>Built the cross-training rota\.<\/li><\/ul>/);
});

test("a date at the right margin on a title's line becomes a right tab", () => {
    const r = flow(page([
        t("A full width line of body text that sets the right margin for this page ok", 72, 80),
        t("Northline Freight — Operations Manager", 72, 100, 10, { font: "Georgia-Bold" }),
        t("Mar 2020 – Present", 540 - 90, 100, 10, { font: "Georgia-Bold", width: 90 }),
    ]));
    assert.match(r.html, /<p style="[^"]*font-weight: 700[^"]*">Northline Freight — Operations Manager<span data-flow-tab="right" data-flow-pos="(\d+(\.\d+)?)"><\/span>Mar 2020 – Present<\/p>/);
    const pos = Number(/data-flow-pos="([\d.]+)"/.exec(r.html)[1]);
    assert.ok(Math.abs(pos - (540 - 72)) < 1, `tab stop at the right margin, got ${pos}`);
});

test("headings keep their size, weight, colour and family; a centred name stays centred", () => {
    const r = flow(page([
        t("Jordan Vale", 256, 60, 22, { font: "Georgia-Bold", fontFamily: "serif", color: "#1a3c6e", width: 100 }),
        t("Experience", 72, 100, 13, { font: "ABCDEF+Helvetica-Bold" }),
        t("Body text in the ordinary size that runs across the whole width of the page.", 72, 118, 10, { width: 468 }),
        t("More body text, the most common style in the document by far, in fact.", 72, 140),
    ]));
    assert.match(r.html, /<p style="font-family: Georgia, serif; font-size: 22pt; color: #1a3c6e; font-weight: 700; text-align: center">Jordan Vale<\/p>/);
    assert.match(r.html, /<p style="font-size: 13pt; font-weight: 700; margin-top: [\d.]+pt">Experience<\/p>/);
    assert.equal(r.base.fontFamily, "Helvetica, sans-serif");
});

test("a rule right under a heading is its border-bottom; a rule between paragraphs is an <hr>", () => {
    const r = flow(page([
        t("SUMMARY", 72, 100, 12, { font: "Helvetica-Bold" }),
        t("Some text below the heading, long enough to reach the right margin of the page.", 72, 120),
        t("Text after a divider.", 72, 150),
    ], { rules: [{ x: 72, y: 103, w: 468, h: 1.5, color: "#1a3c6e" }, { x: 72, y: 132, w: 468, h: 0.75, color: "#eeeeee" }] }));
    assert.match(r.html, /<p style="[^"]*border-bottom: 1.5pt solid #1a3c6e[^"]*">SUMMARY<\/p>/);
    assert.match(r.html, /<hr style="border-top: 0.75pt solid #eeeeee; margin-top: [\d.]+pt[^"]*">/);
});

test("a thin rule under just a few words is an underline, and a link annotation makes an <a>", () => {
    const r = flow(page([
        t("Portfolio at mara.example and more words to fill the line out to the margin", 72, 100),
    ], {
        rules: [{ x: 72, y: 101.5, w: 40, h: 0.5, color: "#000000" }],
        links: [{ x: 72 + 13 * 5 - 1, y: 90, w: 12 * 5 + 2, h: 13, href: "https://mara.example" }],
    }));
    assert.match(r.html, /<u>Portfolio<\/u> at <a href="https:\/\/mara.example">mara.example<\/a> and more/);
    assert.doesNotMatch(r.html, /<hr/);
});

test("a sidebar layout becomes two columns under a full-width header", () => {
    const items = [t("Sam Rivera — Data Analyst and some more header text that spans", 72, 60, 16, { font: "Helvetica-Bold", width: 470 })];
    ["Contact", "sam@rivera.example", "Austin, TX", "Skills", "SQL", "Python"].forEach((s, i) => items.push(t(s, 72, 100 + i * 14, 9)));
    ["Experience", "Analyst, Brightwell Health, where I built the weekly readmissions", "dashboard used by twelve clinic managers to plan the staffing", "Education", "B.A. Economics, University of Texas"].forEach((s, i) => items.push(t(s, 230, 100 + i * 12, 10, { width: Math.min(310, s.length * 5) })));
    const r = flow(page(items));
    assert.match(r.html, /^<p[^>]*>Sam Rivera — Data Analyst[^<]*<\/p><div data-flow-cols><div data-flow-col style="width: [\d.]+pt">/);
    const cols = r.html.split("<div data-flow-col ");
    assert.equal(cols.length, 3);
    assert.match(cols[1], /Contact.*sam@rivera\.example.*Python/s);
    assert.doesNotMatch(cols[1], /Experience/);
    assert.match(cols[2], /Experience.*Analyst, Brightwell Health, where I built the weekly readmissions dashboard used by twelve/s);
});

test("title/date rows are tabs, not two columns", () => {
    const items = [t("A full width summary line of body text that reaches the right margin ok", 72, 60)];
    [["Northline Freight", "2020 – Present"], ["Chicago, IL", "Remote"], ["Harbor & Main", "2016 – 2020"]].forEach(([a, b], i) => {
        items.push(t(a, 72, 90 + i * 14), t(b, 540 - b.length * 5, 90 + i * 14));
    });
    const r = flow(page(items));
    assert.doesNotMatch(r.html, /data-flow-cols/);
    assert.equal((r.html.match(/data-flow-tab="right"/g) || []).length, 3);
});

test("pages: running headers, footers and page numbers are dropped and a paragraph split by the break joins up", () => {
    const body = (n) => [
        t("Jordan Vale — Résumé", 72, 30, 8), t(`Page ${n} of 2`, 500, 770, 8),
    ];
    const p1 = page([...body(1),
        t("First page text that is long enough to wrap onto the next line of the page", 72, 100),
        t("and this paragraph keeps going right to the very bottom margin of the page", 72, 112)]);
    const p2 = page([...body(2),
        t("and finishes at the top of page two.", 72, 80),
        t("A new paragraph.", 72, 110)]);
    const r = flow([p1, p2]);
    assert.doesNotMatch(r.html, /Résumé|Page \d/);
    assert.match(r.html, /bottom margin of the page and finishes at the top of page two\.<\/p>/);
    assert.ok(r.warnings.some((w) => /headers, footers/.test(w)));
});

test("pictures: beside text → positioned on the page; on their own → a figure; icon-sized in a line → inline", () => {
    const img = (x, y, w, h) => ({ x, y, w, h, dataUri: "data:image/png;base64,AAAA" });
    const r = flow(page([
        t("Mara Quill", 130, 60, 14),
        t("A line of text that is long enough to reach the right margin of this page!", 72, 150, 10, { width: 468 }),
        t("hi@mara.example", 86, 170),
    ], { images: [img(72, 40, 40, 40), img(256, 190, 100, 60), img(72, 162, 9, 9)] }));
    assert.match(r.html, /^<div data-flow-abs style="top: 40pt; left: 72pt; width: 40pt; height: 40pt" data-flow-page="0"><figure><img src="data:image\/png;base64,AAAA"/);
    assert.match(r.html, /<figure style="text-align: center[^"]*"><img [^>]*style="width: 100pt; height: 60pt"><\/figure>/);
    assert.match(r.html, /<p[^>]*><img src="data:image\/png;base64,AAAA" style="width: 9pt; height: 9pt">hi@mara\.example<\/p>/);
});

test("a PDF of page pictures and no text is a scan: it needs an AI, and the pages come in as pictures", () => {
    const scan = { width: 612, height: 792, items: [], rules: [], images: [{ x: 0, y: 0, w: 612, h: 792, dataUri: "data:image/jpeg;base64,/9j/" }] };
    const r = flow([scan, scan]);
    assert.equal(r.needsAi, SCAN_MESSAGE);
    assert.equal((r.html.match(/<figure/g) || []).length, 2);
    assert.match(r.html, /style="width: 612pt; height: 792pt"/);
});

test("the output uses only FlowDoc elements and attributes", () => {
    const r = flow(page([t("Jordan Vale", 256, 60, 22), t("•", 72, 100), t("Item", 84, 100), t("Left", 72, 120), t("2020", 520, 120, 10, { width: 20 })], { rules: [{ x: 72, y: 130, w: 468, h: 1 }] }));
    const tags = [...r.html.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]);
    for (const tag of tags) assert.ok(["p", "ul", "ol", "li", "hr", "figure", "img", "div", "span", "strong", "em", "u", "a", "br", "sup", "sub"].includes(tag), tag);
    const attrs = [...r.html.matchAll(/\s([a-z-]+)=/g)].map((m) => m[1]);
    for (const a of attrs) assert.ok(["style", "href", "src", "data-flow-tab", "data-flow-pos", "data-flow-page"].includes(a), a);
    for (const c of r.html.matchAll(/#[0-9a-fA-F]+/g)) assert.match(c[0], /^#[0-9a-f]{6}$/);
});
