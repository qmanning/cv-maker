// Unit tests for src/import/rtf.ts — RTF → FlowDoc. Small inline RTF for each rule, plus fixtures: the sample
// résumé run through macOS textutil (Cocoa RTF), a Word-style file (stylesheet, \listtext, tab stops, tables,
// fields, header/footer) and a picture file (\pngblip as hex and as \bin).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installJsdom, bundleAndImport, repoRoot } from "./_helpers.mjs";

installJsdom();
const { rtfToFlow } = await bundleAndImport("src/import/rtf.ts");

const buf = (s) => new TextEncoder().encode(s).buffer;
const fixture = (f) => { const b = fs.readFileSync(path.join(repoRoot, "test/fixtures/import", f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
const conv = async (body, head = "") => (await rtfToFlow(buf(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}{\\f1\\froman Georgia;}}{\\colortbl;\\red255\\green0\\blue0;\\red0\\green0\\blue255;}${head}\n${body}}`), "t")).html;
const doc = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };

// the FlowDoc contract (flow.ts): only these tags, attributes and style properties
const TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "TR", "TD", "TH", "HR", "FIGURE", "IMG", "STRONG", "EM", "U", "S", "A", "BR", "SUP", "SUB", "SPAN", "DIV", "TBODY"]); // (TBODY: the HTML parser adds it)
const BLOCK_PROPS = new Set(["text-align", "margin-top", "margin-bottom", "margin-left", "margin-right", "text-indent", "line-height", "font-family", "font-size", "color", "font-weight", "font-style", "text-transform", "letter-spacing", "background-color", "border-top", "border-bottom", "padding-top", "padding-bottom", "list-style-type", "width", "vertical-align", "padding", "border-left", "border-right"]);
const SPAN_PROPS = new Set(["color", "font-size", "font-weight", "font-style", "font-family", "letter-spacing", "text-transform", "background-color"]);
export function assertContract(html) {
    for (const el of doc(html).querySelectorAll("*")) {
        assert.ok(TAGS.has(el.tagName), `tag ${el.tagName}`);
        for (const a of el.getAttributeNames()) {
            assert.ok(["style", "href", "src", "colspan", "rowspan", "data-flow-tab", "data-flow-pos", "alt"].includes(a), `attribute ${a} on ${el.tagName}`);
        }
        const props = (el.getAttribute("style") || "").split(";").map((d) => d.split(":")[0].trim()).filter(Boolean);
        const allowed = el.tagName === "SPAN" ? SPAN_PROPS : el.tagName === "IMG" ? new Set(["width", "height"]) : el.tagName === "HR" ? new Set(["border-top", "margin-top", "margin-bottom"]) : BLOCK_PROPS;
        for (const p of props) assert.ok(allowed.has(p), `style ${p} on ${el.tagName}`);
        const style = el.getAttribute("style") || "";
        for (const m of style.matchAll(/(\d)(px|em|rem|%)\b/g)) assert.fail(`non-pt unit ${m[0]} in ${style}`);
        for (const m of style.matchAll(/#[0-9a-f]+\b/gi)) assert.match(m[0], /^#[0-9a-f]{6}$/, "colours are #rrggbb");
    }
}

/* ---------------- tokenizer and characters ---------------- */

test("rejects a file that is not RTF", async () => {
    const r = await rtfToFlow(buf("hello"), "x.rtf");
    assert.equal(r.html, "");
    assert.match(r.warnings[0], /RTF/);
});

test("\\'hh uses the code page (cp1252 0x80–0x9F), \\uN skips \\ucN fallback characters, specials map", async () => {
    const html = await conv("\\'93Caf\\'e9\\'94 \\'80 5 \\u8364?9 {\\uc2\\u8212 xx}done \\uc0\\u8226 \\emdash\\endash\\bullet\\~\\{x\\}\\\\\\par");
    assert.equal(doc(html).textContent, "“Café” € 5 €9 —done •—–• {x}\\");
});

test("\\ansicpg1251 decodes Cyrillic bytes; a Symbol-font \\'b7 is a bullet", async () => {
    const r = await rtfToFlow(buf("{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0 Arial;}{\\f3\\fcharset2 Symbol;}}\\f0 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2 {\\f3 \\'b7}\\par}"), "t");
    assert.equal(doc(r.html).textContent, "Привет •");
});

test("ignorable destinations (\\*) and known non-text destinations never leak text", async () => {
    const html = await conv("{\\*\\generator Foo 1.0;}{\\*\\themedata 0123abcd}{\\*\\bkmkstart b}{\\*\\unknownthing secret}{\\xe index entry}Visible\\par", "{\\info{\\title Doc Title}{\\author Someone}}");
    assert.equal(doc(html).textContent, "Visible");
});

test("\\info \\title becomes the title; \\paperw/\\marg* become the page in pt", async () => {
    const r = await rtfToFlow(buf("{\\rtf1\\ansi{\\info{\\title My CV}}\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt720\\margb720 x\\par}"), "t");
    assert.equal(r.title, "My CV");
    assert.deepEqual(r.page, { widthPt: 595.3, heightPt: 841.9, marginLeftPt: 56.7, marginRightPt: 56.7, marginTopPt: 36, marginBottomPt: 36 });
});

/* ---------------- character formatting ---------------- */

test("runs: bold/italic/underline/strike/super/sub, merged when identical; \\plain resets", async () => {
    const html = await conv("Plain {\\b bold}{\\b  more} {\\i it} {\\ul un\\ulnone der} {\\strike gone} x{\\super 2}y{\\sub 3} \\b B\\plain  P\\par");
    assert.equal(html, "<p>Plain <strong>bold more</strong> <em>it</em> <u>un</u>der <s>gone</s> x<sup>2</sup>y<sub>3</sub> <strong>B</strong> P</p>");
});

test("font, size, colour, highlight, caps and letter-spacing: the paragraph's dominant look is the block style, the rest spans", async () => {
    const html = await conv("\\f1\\fs28\\cf1 Mostly Georgia red 14pt text {\\f0\\fs20\\cf0 small arial} {\\highlight2 hi}{\\caps caps}{\\expndtw20 wide}\\par");
    const p = doc(html).querySelector("p");
    const st = p.getAttribute("style");
    assert.match(st, /font-family: Georgia, serif/);
    assert.match(st, /font-size: 14pt/);
    assert.match(st, /color: #ff0000/);
    assert.match(html, /<span style="font-family: Arial, sans-serif; font-size: 10pt; color: #000000">small arial<\/span>/);
    assert.match(html, /<span style="background-color: #0000ff">hi<\/span>/);
    assert.match(html, /<span style="text-transform: uppercase">caps<\/span>/);
    assert.match(html, /<span style="letter-spacing: 1pt">wide<\/span>/);
    assertContract(html);
});

test("base style comes from the defaults: \\deff font and 12pt, or Word's \\defchp/\\defpap", async () => {
    const r1 = await rtfToFlow(buf("{\\rtf1\\ansi\\deff1{\\fonttbl{\\f0 Arial;}{\\f1\\froman Garamond;}} x\\par}"), "t");
    assert.deepEqual(r1.base, { fontFamily: "Garamond, serif", fontSizePt: 12 });
    const r2 = await rtfToFlow(buf("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}{\\f1 Calibri;}}{\\*\\defchp \\f1\\fs22}{\\*\\defpap \\sl259\\slmult1\\sa160} \\pard\\plain x\\par}"), "t");
    assert.deepEqual(r2.base, { fontFamily: "Calibri", fontSizePt: 11, lineHeight: 1.08 });
    assert.equal(r2.html, `<p style="margin-bottom: 8pt">x</p>`);
});

test("Cocoa PostScript font names become families with weights; \\fsmilli gives exact sizes; white \\cb is dropped", async () => {
    const r = await rtfToFlow(buf("{\\rtf1\\ansi\\cocoartf2822{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fnil\\fcharset0 HelveticaNeue-Medium;}{\\colortbl;\\red255\\green255\\blue255;}\\f0\\fs24 \\cb1 Body text is longer {\\f1\\fs26\\fsmilli13333 Medium}\\\n}"), "t");
    assert.equal(r.html, `<p>Body text is longer <span style="font-family: 'Helvetica Neue'; font-size: 13.33pt; font-weight: 500">Medium</span></p>`);
});

/* ---------------- paragraphs ---------------- */

test("paragraph alignment, indents, spacing, line spacing and borders; blank paragraphs fold into spacing; a bordered blank is an hr", async () => {
    const html = await conv("\\pard\\qc Centre\\par\\pard\\qr\\li720\\ri360\\fi-360\\sb240\\sa120 Right\\par\\pard\\qj\\sl360\\slmult1 Just\\par\\pard\\sl-300\\slmult0 Exact\\par\\pard\\par\\pard After blank\\par\\pard\\brdrb\\brdrs\\brdrw20\\brdrcf2\\brsp40 Ruled\\par\\pard\\brdrt\\brdrdb\\brdrw10 \\par");
    const ps = doc(html).children;
    assert.equal(ps[0].getAttribute("style"), "text-align: center");
    assert.equal(ps[1].getAttribute("style"), "text-align: right; margin-top: 12pt; margin-bottom: 6pt; margin-left: 36pt; margin-right: 18pt; text-indent: -18pt");
    assert.equal(ps[2].getAttribute("style"), "text-align: justify; line-height: 1.5");
    assert.equal(ps[3].getAttribute("style"), "line-height: 15pt");
    assert.equal(ps[4].getAttribute("style"), "margin-top: 14.4pt");
    assert.equal(ps[5].getAttribute("style"), "border-bottom: 1pt solid #0000ff; padding-bottom: 2pt");
    assert.equal(ps[6].tagName, "HR");
    assert.equal(ps[6].getAttribute("style"), "border-top: 0.5pt double #000000");
    assertContract(html);
});

test("\\line is a <br>; \\page and \\sect do not add blocks", async () => {
    const html = await conv("one\\line two\\page\\par three\\sect four\\par");
    assert.equal(html, "<p>one<br>two</p><p>three</p><p>four</p>");
});

test("\\tab resolves to the paragraph's tab stops (\\tqr/\\tqc → right/center, twips → pt); extra tabs have no stop", async () => {
    const html = await conv("\\pard\\tqc\\tx4680\\tqr\\tx9360 Title\\tab Middle\\tab 2019 \\endash  2023\\tab x\\par\\pard\\li720\\tx360\\tx1440 Past indent\\tab y\\par");
    assert.equal(html, `<p>Title<span data-flow-tab="center" data-flow-pos="234"></span>Middle<span data-flow-tab="right" data-flow-pos="468"></span>2019 – 2023<span data-flow-tab="" data-flow-pos=""></span>x</p>` +
        `<p style="margin-left: 36pt">Past indent<span data-flow-tab="left" data-flow-pos="72"></span>y</p>`);
});

test("stylesheet 'heading N' styles and \\outlinelevel become h1–h6", async () => {
    const html = await conv("\\pard\\s1 Big\\par\\pard\\s2 Smaller\\par\\pard\\outlinelevel2 Third\\par\\pard\\s0 Body\\par", "{\\stylesheet{\\s0 Normal;}{\\s1\\b\\fs32 heading 1;}{\\s2 Heading 2;}}");
    assert.equal(html, "<h1>Big</h1><h2>Smaller</h2><h3>Third</h3><p>Body</p>");
});

/* ---------------- lists ---------------- */

test("lists from \\listtext + \\ls/\\ilvl: bullet vs number from the listtext text, nesting by level", async () => {
    const html = await conv(
        "{\\listtext \\'95\\tab}\\pard\\li720\\fi-360\\ls1\\ilvl0 One\\par" +
        "{\\listtext o\\tab}\\pard\\li1440\\fi-360\\ls1\\ilvl1 Nested\\par" +
        "{\\listtext \\'95\\tab}\\pard\\li720\\fi-360\\ls1\\ilvl0 Two\\par" +
        "\\pard Between\\par" +
        "{\\listtext 1.\\tab}\\pard\\li720\\fi-360\\ls2\\ilvl0 First\\par{\\listtext 2.\\tab}\\pard\\li720\\fi-360\\ls2\\ilvl0 Second\\par");
    assert.equal(html,
        `<ul style="list-style-type: disc; margin-left: 36pt"><li>One<ul style="list-style-type: circle; margin-left: 36pt"><li>Nested</li></ul></li><li>Two</li></ul>` +
        `<p>Between</p><ol style="list-style-type: decimal; margin-left: 36pt"><li>First</li><li>Second</li></ol>`);
});

test("the \\listtable's \\levelnfc decides ul vs ol even without \\listtext; old \\pntext lists work", async () => {
    const head = "{\\*\\listtable{\\list{\\listlevel\\levelnfc4{\\leveltext\\'02\\'00.;}}\\listid7}{\\list{\\listlevel\\levelnfc23{\\leveltext\\'01\\u-3929 ?;}}\\listid8}}{\\*\\listoverridetable{\\listoverride\\listid7\\ls1}{\\listoverride\\listid8\\ls2}}";
    const html = await conv("\\pard\\ls1 a\\par\\pard\\ls2 b\\par\\pard{\\pntext\\'95\\tab}c\\par", head);
    assert.equal(html, `<ol style="list-style-type: lower-alpha"><li>a</li></ol><ul style="list-style-type: square"><li>b</li></ul><ul style="list-style-type: disc"><li>c</li></ul>`);
});

/* ---------------- links, pictures, tables ---------------- */

test("HYPERLINK fields wrap their result in <a href>; other fields keep their result text", async () => {
    const html = await conv("{\\field{\\*\\fldinst{HYPERLINK \"https://ex.example/a?b=1\"}}{\\fldrslt{\\ul\\cf2 ex.example}}} and {\\field{\\*\\fldinst PAGE}{\\fldrslt 3}} is the page number\\par");
    assert.equal(html, `<p><a href="https://ex.example/a?b=1"><span style="color: #0000ff"><u>ex.example</u></span></a> and 3 is the page number</p>`);
});

test("pictures: \\pngblip hex and \\bin become data: URIs sized by \\picwgoal/\\pichgoal; a lone picture is a <figure>; WMF is skipped with a warning", async () => {
    const r = await rtfToFlow(fixture("picture.rtf"), "picture");
    const d = doc(r.html);
    const fig = d.querySelector("figure");
    assert.equal(fig.getAttribute("style"), "text-align: center");
    assert.match(fig.querySelector("img").getAttribute("src"), /^data:image\/png;base64,iVBORw0KGgo/);
    assert.equal(fig.querySelector("img").getAttribute("style"), "width: 36pt; height: 36pt");
    const inline = d.querySelector("p img");
    assert.equal(inline.getAttribute("style"), "width: 12pt; height: 12pt");
    assert.equal(d.querySelector("p").textContent, "Logo  inline");
    assert.equal(d.querySelectorAll("img").length, 2, "the \\nonshppict WMF twin is not shown");
    assertContract(r.html);
    const w = await rtfToFlow(buf("{\\rtf1 {\\pict\\emfblip 0100}x\\par}"), "t");
    assert.match(w.warnings.join(" "), /1 picture .* was left out/);
});

test("tables: \\trowd/\\cellx widths, \\intbl paragraphs, merges, cell borders/shading/vertical alignment", async () => {
    const html = await conv("\\trowd\\trleft0\\clbrdrb\\brdrs\\brdrw10\\clvertalc\\cellx2880\\clcbpat1\\cellx7200\\pard\\intbl A\\cell\\pard\\intbl B\\line b\\cell\\row" +
        "\\trowd\\clmgf\\cellx2880\\clmrg\\cellx7200\\pard\\intbl Wide\\cell\\pard\\intbl\\cell\\row\\pard After\\par");
    assert.equal(html, `<table><tr><td style="width: 144pt; vertical-align: middle; border-bottom: 0.5pt solid #000000"><p>A</p></td><td style="width: 216pt; background-color: #ff0000"><p>B<br>b</p></td></tr>` +
        `<tr><td colspan="2" style="width: 360pt"></td></tr></table><p>After</p>`.replace("<td colspan=\"2\" style=\"width: 360pt\"></td>", "<td colspan=\"2\" style=\"width: 360pt\"><p>Wide</p></td>"));
    assertContract(html);
});

test("vertical merges become rowspan", async () => {
    const html = await conv("\\trowd\\clvmgf\\cellx1440\\cellx2880\\pard\\intbl Tall\\cell\\pard\\intbl r1\\cell\\row\\trowd\\clvmrg\\cellx1440\\cellx2880\\pard\\intbl\\cell\\pard\\intbl r2\\cell\\row");
    const rows = doc(html).querySelectorAll("tr");
    assert.equal(rows[0].querySelector("td").getAttribute("rowspan"), "2");
    assert.equal(rows[1].querySelectorAll("td").length, 1);
    assert.equal(rows[1].textContent, "r2");
});

/* ---------------- fixtures ---------------- */

test("fixture: the sample résumé through textutil (Cocoa RTF) keeps text, sizes, bold, links and bullet lists", async () => {
    const r = await rtfToFlow(fixture("sample-resume.rtf"), "sample-resume");
    assertContract(r.html);
    const d = doc(r.html);
    assert.deepEqual(r.base, { fontFamily: "Helvetica, sans-serif", fontSizePt: 12 });
    assert.equal(d.querySelector("p").textContent, "Mara Quill");
    assert.match(d.querySelector("p").getAttribute("style"), /font-size: 16pt; font-weight: bold/);
    assert.equal(d.querySelector('a[href="mailto:hi@mara.example"]').textContent, "hi@mara.example");
    assert.equal(d.querySelectorAll("ul").length, 6);
    assert.equal(d.querySelectorAll("li").length, 27);
    assert.match(r.html, /<li style="font-size: 9.33pt"><strong>Research:<\/strong> field visits/);
    assert.match(d.textContent, /Designer → Design Lead, Paperboat Studio/);
    assert.match(d.textContent, /2022 - Present • Portland, OR \(Hybrid\)/);
    assert.doesNotMatch(r.html, /background-color/, "Cocoa's white \\cb is not carried");
    assert.deepEqual(r.warnings, []);
});

test("fixture: Word-style RTF — header placed first, headings from the stylesheet, tab stops, lists, table, footnote/footer/WMF warnings", async () => {
    const r = await rtfToFlow(fixture("word-style.rtf"), "word-style");
    assertContract(r.html);
    const d = doc(r.html);
    assert.equal(r.title, "Jordan Vale Résumé");
    assert.equal(r.page.widthPt, 612);
    assert.deepEqual(r.base, { fontFamily: "Calibri, sans-serif", fontSizePt: 11, lineHeight: 1.08 });
    assert.equal(d.children[0].textContent, "Jordan Vale – Page header");
    assert.match(d.children[1].getAttribute("style"), /letter-spacing: 2pt/);
    assert.equal(d.querySelector("h1").textContent, "Experience");
    assert.equal(d.querySelector("h2").textContent, "Certifications");
    assert.match(r.html, /Operations Manager, Northwind Freight<span data-flow-tab="right" data-flow-pos="504"><\/span><span style="font-weight: normal">2019 – Present<\/span>/);
    assert.equal(d.querySelector("ul > li > ul").getAttribute("style"), "list-style-type: circle; margin-left: 36pt");
    assert.equal(d.querySelectorAll("ol > li").length, 2);
    assert.match(d.querySelector("ol").textContent, /Hüber-certified E=mc2 and H2O “quoted”/);
    assert.equal(d.querySelectorAll("table td").length, 3);
    assert.equal(d.querySelector("table td[colspan]").textContent, "Spanning cell");
    assert.doesNotMatch(d.textContent, /footnote text|Confidential/);
    assert.match(d.textContent, /After the table\./);
    assert.equal(r.warnings.length, 4);
    assert.match(r.warnings.join("\n"), /header was placed at the top/);
    assert.match(r.warnings.join("\n"), /footer was left out/);
    assert.match(r.warnings.join("\n"), /footnote/);
    assert.match(r.warnings.join("\n"), /WMF/);
});

test("fixture: TextEdit RTF — literal tabs with Cocoa tab stops, centred bold red Helvetica Neue, smart quotes", async () => {
    const r = await rtfToFlow(fixture("textedit.rtf"), "textedit");
    assertContract(r.html);
    assert.deepEqual(r.page, { marginLeftPt: 72, marginRightPt: 72 });
    assert.match(r.html, /<p style="text-align: center; font-family: 'Helvetica Neue'; font-size: 18pt; color: #c80000; font-weight: bold">Centered Bold Red<\/p>/);
    assert.match(r.html, /line-height: 1.2; font-family: 'Times New Roman', serif; font-style: italic">Italic Times with a “smart quote” and café and €5/);
    assert.match(r.html, /<p>Designer<span data-flow-tab="right" data-flow-pos="432"><\/span>2020–Now<\/p>/);
    assert.match(r.html, /<p style="margin-top: 28.8pt">Line after blanks<\/p>/);
});
