// Unit tests for src/import/markdown.ts and src/import/text.ts — Markdown and plain text → FlowDoc. Small inline
// inputs for each rule, plus a realistic résumé fixture in each format (fictional people).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installJsdom, bundleAndImport, repoRoot } from "./_helpers.mjs";

installJsdom();
const { markdownToFlow } = await bundleAndImport("src/import/markdown.ts");
const { textToFlow } = await bundleAndImport("src/import/text.ts");

const md = async (s) => (await markdownToFlow(s, "t")).html;
const txt = async (s) => (await textToFlow(s, "t")).html;
const fixture = (f) => { const b = fs.readFileSync(path.join(repoRoot, "test/fixtures/import", f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
const doc = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };
const TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "TBODY", "TR", "TD", "TH", "HR", "FIGURE", "IMG", "STRONG", "EM", "U", "S", "A", "BR", "SUP", "SUB", "SPAN"]);
function assertContract(html) {
    for (const el of doc(html).querySelectorAll("*")) {
        assert.ok(TAGS.has(el.tagName), `tag ${el.tagName}`);
        for (const a of el.getAttributeNames()) assert.ok(["style", "href", "src", "alt", "data-flow-tab", "data-flow-pos"].includes(a), `attribute ${a}`);
    }
}

/* ================= Markdown ================= */

test("md: ATX and setext headings; front matter gives the title and is dropped; base is empty", async () => {
    const r = await markdownToFlow("---\ntitle: \"Ana Ruiz — CV\"\ndate: 2024-01-01\n---\n# One #\n###### Six\nTwo\n===\nThree\n---\n", "t");
    assert.equal(r.title, "Ana Ruiz — CV");
    assert.deepEqual(r.base, {});
    assert.equal(r.html, "<h1>One</h1><h6>Six</h6><h1>Two</h1><h2>Three</h2>");
});

test("md: paragraphs join soft line breaks; two trailing spaces or a backslash make <br>", async () => {
    assert.equal(await md("one\ntwo  \nthree\\\nfour\n\nnext"), "<p>one two<br>three<br>four</p><p>next</p>");
});

test("md: emphasis — bold, em, both, strike, underscores only at word edges, code spans in monospace", async () => {
    assert.equal(await md("**b** __b__ *i* _i_ ***bi*** ~~s~~ snake_case_name `a*b*c`"),
        `<p><strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <strong><em>bi</em></strong> <s>s</s> snake_case_name <span style="font-family: monospace">a*b*c</span></p>`);
    assert.equal(await md("**Research:** field *work* and **nested *em* here**"), "<p><strong>Research:</strong> field <em>work</em> and <strong>nested <em>em</em> here</strong></p>");
});

test("md: links, autolinks, reference links, bare URLs and emails; escapes and entities", async () => {
    assert.equal(await md("[Site](https://a.example \"t\") <https://b.example> <me@c.example> www.d.example/x, e@f.example. [ref][r] \\*lit\\* &amp; &mdash; [bad](javascript:alert(1))\n\n[r]: https://r.example"),
        `<p><a href="https://a.example">Site</a> <a href="https://b.example">https://b.example</a> <a href="mailto:me@c.example">me@c.example</a> <a href="https://www.d.example/x">www.d.example/x</a>, <a href="mailto:e@f.example">e@f.example</a>. <a href="https://r.example">ref</a> *lit* &amp; — bad)</p>`); // a javascript: link loses its link (and, here, a paren)
});

test("md: images — a data: URI is kept (a lone one is a figure); a path keeps its alt text with a warning", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const r = await markdownToFlow(`![Logo](${png})\n\nSee ![me](me.jpg) here`, "t");
    assert.equal(r.html, `<figure><img src="${png}" alt="Logo"></figure><p>See me here</p>`);
    assert.match(r.warnings[0], /1 image .* alt text was kept/);
});

test("md: bullets (- * +) and numbers, nesting by indentation, wrapped and lazy continuation lines", async () => {
    const html = await md("- one\n  wrapped\n- two\nlazy\n    - deep\n    - deeper\n- three\n\n1. first\n2) second\n   1. sub\n\n* star");
    assert.equal(html, `<ul><li>one wrapped</li><li>two lazy<ul><li>deep</li><li>deeper</li></ul></li><li>three</li></ul>` +
        `<ol style="list-style-type: decimal"><li>first</li><li>second<ol style="list-style-type: decimal"><li>sub</li></ol></li></ol><ul><li>star</li></ul>`);
});

test("md: a loose list keeps later paragraphs of an item as a break", async () => {
    assert.equal(await md("- a\n\n  more about a\n- b"), "<ul><li>a<br>more about a</li><li>b</li></ul>");
});

test("md: blockquote → paragraphs with a left margin; rules; pipe tables with alignment", async () => {
    assert.equal(await md("> quoted *line*\n> continues\n\n---\n***\n___\n\n| A | B |\n|:-:|--:|\n| 1 | **2** |"),
        `<p style="margin-left: 18pt">quoted <em>line</em> continues</p><hr><hr><hr>` +
        `<table><tr><th style="text-align: center"><p>A</p></th><th style="text-align: right"><p>B</p></th></tr><tr><td style="text-align: center"><p>1</p></td><td style="text-align: right"><p><strong>2</strong></p></td></tr></table>`);
});

test("md: inline HTML — <b> <i> <u> <br> pass through, other tags drop but keep their text, comments vanish", async () => {
    assert.equal(await md("<b>B</b> <i>I</i> <u>U</u><br><span class=\"x\">kept</span> <!-- gone -->end"), "<p><strong>B</strong> <em>I</em> <u>U</u><br>kept end</p>");
});

test("md: 'dates on the right' lines stay plain text — no invented tabs", async () => {
    const html = await md("**Senior Designer, Acme** | 2019 – 2023\n\nDesigner, Beta — 2016–2019");
    assert.equal(html, "<p><strong>Senior Designer, Acme</strong> | 2019 – 2023</p><p>Designer, Beta — 2016–2019</p>");
    assert.doesNotMatch(html, /data-flow-tab/);
});

test("md: fenced code is a monospace paragraph; ArrayBuffer input with a BOM decodes", async () => {
    assert.equal(await md("```\na <b>\n  b\n```"), `<p style="font-family: monospace">a &lt;b&gt;<br>  b</p>`);
    const r = await markdownToFlow(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# Zoë")]).buffer, "t");
    assert.equal(r.html, "<h1>Zoë</h1>");
});

test("md fixture: a realistic résumé", async () => {
    const r = await markdownToFlow(fixture("resume.md"), "resume");
    assertContract(r.html);
    const d = doc(r.html);
    assert.equal(r.title, "Priya Castellanos — Résumé");
    assert.equal(d.querySelector("h1").textContent, "Priya Castellanos");
    assert.deepEqual([...d.querySelectorAll("h2")].map((h) => h.textContent), ["Experience", "Earlier roles", "Skills"]);
    assert.equal(d.querySelectorAll("h3").length, 2);
    assert.equal(d.querySelector("h3").innerHTML, "<strong>Lead Service Designer, Lanternfish Health</strong> | 2021 – Present");
    assert.equal(d.querySelectorAll("ul > li").length, 5);
    assert.equal(d.querySelectorAll("ul ul > li").length, 2);
    assert.equal(d.querySelectorAll("ol > li").length, 3);
    assert.match(d.querySelector("li").textContent, /cutting average wait from 22 minutes/);
    assert.equal(d.querySelectorAll("table tr").length, 3);
    assert.equal(d.querySelector("table tr:last-child td:last-child").textContent, "Figma, prototyping, | service blueprints");
    assert.equal(d.querySelectorAll("hr").length, 1);
    assert.ok(d.querySelector('a[href="https://www.linkedin.com/in/priyacastellanos"]'));
    assert.ok(d.querySelector('a[href="https://castellanos.example/portfolio"]'));
    assert.match(r.html, /can use\.<br>Open to hybrid/);
    assert.equal(r.warnings.length, 1);
});

/* ================= plain text ================= */

test("txt: decoding — UTF-8 BOM, UTF-16 LE/BE by BOM, UTF-16 without BOM, cp1252 fallback for invalid UTF-8", async () => {
    const enc16 = (s, be) => { const a = []; for (const ch of s) { const c = ch.charCodeAt(0); a.push(...(be ? [c >> 8, c & 255] : [c & 255, c >> 8])); } return a; };
    const t = (bytes) => textToFlow(new Uint8Array(bytes).buffer, "t").then((r) => doc(r.html).textContent);
    assert.equal(await t([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Café")]), "Café");
    assert.equal(await t([0xff, 0xfe, ...enc16("Zoë Ng")]), "Zoë Ng");
    assert.equal(await t([0xfe, 0xff, ...enc16("Zoë Ng", true)]), "Zoë Ng");
    assert.equal(await t(enc16("Plain words here", false)), "Plain words here");
    assert.equal(await t([0x93, 0x43, 0x61, 0x66, 0xe9, 0x94, 0x20, 0x96, 0x20, 0x80]), "“Café” – €");
});

test("txt: blank lines split paragraphs; hard-wrapped prose joins, short lines (an address) keep <br>; CRLF", async () => {
    const prose = "This is a long line of prose that the editor wrapped at seventy-two\r\ncharacters so that it would fit on screen, which is common in text\r\nfiles.";
    assert.equal(await txt(prose + "\r\n\r\n12 Elm St\r\nSpringfield\r\n"), `<p>${prose.replace(/\r\n/g, " ")}</p><p>12 Elm St<br>Springfield</p>`);
});

test("txt: bullets (• - * ▪ ● ◦ – > o) and numbers (1. 1)) → lists, wrapped continuations, nesting by indentation", async () => {
    const html = await txt("• one\n  wrapped\n• two\n    ◦ nested\n• three\n\n1) first\n2) second\n\n- dash\n* star\n▪ sq\no oh\n– en\n> gt");
    assert.equal(html, `<ul style="list-style-type: disc"><li>one wrapped</li><li>two<ul style="list-style-type: circle"><li>nested</li></ul></li><li>three</li></ul>` +
        `<ol style="list-style-type: decimal"><li>first</li><li>second</li></ol>` +
        `<ul style="list-style-type: disc"><li>dash</li></ul><ul style="list-style-type: disc"><li>star</li></ul><ul style="list-style-type: square"><li>sq</li></ul>` +
        `<ul style="list-style-type: circle"><li>oh</li></ul><ul style="list-style-type: '– '"><li>en</li></ul><ul style="list-style-type: '&gt; '"><li>gt</li></ul>`);
});

test("txt: ALL-CAPS short lines and underlined lines are h2; lines of only - _ = * are <hr>", async () => {
    assert.equal(await txt("EXPERIENCE\nWorked hard.\n\nSkills\n======\nFast.\n\nEDUCATION\n---------\nBA\n\n-----\n____\n*****\n\nNYC, NY 10001 USA"),
        "<h2>EXPERIENCE</h2><p>Worked hard.</p><h2>Skills</h2><p>Fast.</p><h2>EDUCATION</h2><p>BA</p><hr><hr><hr><p>NYC, NY 10001 USA</p>");
});

test("txt: a date-like right part after 2+ spaces or a tab becomes a right tab; other tabs are plain tabs; runs of spaces collapse", async () => {
    assert.equal(await txt("Senior Designer, Acme        2019 – 2023\nLead\tJan 2020 – Present\nName\tRole\tTeam\nSpaced    out words"),
        `<p>Senior Designer, Acme<span data-flow-tab="right" data-flow-pos=""></span>2019 – 2023<br>` +
        `Lead<span data-flow-tab="right" data-flow-pos=""></span>Jan 2020 – Present<br>` +
        `Name<span data-flow-tab="" data-flow-pos=""></span>Role<span data-flow-tab="" data-flow-pos=""></span>Team<br>Spaced out words</p>`);
});

test("txt: leading spaces indent → margin-left; emails and URLs stay plain; text is escaped", async () => {
    assert.equal(await txt("    Indented <note> & more\n\nme@x.example https://x.example"),
        `<p style="margin-left: 24pt">Indented &lt;note&gt; &amp; more</p><p>me@x.example https://x.example</p>`);
});

test("txt fixture: a realistic résumé", async () => {
    const r = await textToFlow(fixture("resume.txt"), "resume");
    assertContract(r.html);
    const d = doc(r.html);
    assert.deepEqual(r.base, {});
    assert.deepEqual([...d.querySelectorAll("h2")].map((h) => h.textContent), ["JORDAN OKAFOR", "SUMMARY", "Experience", "EDUCATION"]);
    assert.match(d.querySelector("p").innerHTML, /^Chicago, IL 60614<br>jordan.okafor@example.com/);
    assert.match(r.html, /<p>Operations analyst with eight years of experience turning messy logistics data into decisions/);
    assert.match(r.html, /Senior Operations Analyst, Brightline Parcel<span data-flow-tab="right" data-flow-pos=""><\/span>2020 – Present/);
    assert.match(r.html, /Operations Analyst, Lakeshore Freight<span data-flow-tab="right" data-flow-pos=""><\/span>2016 – 2020/);
    assert.equal(d.querySelector("ul > li").textContent, "Built the daily dock-capacity model that cut overtime by 18% across three sites.");
    assert.equal(d.querySelector("ul ul > li").textContent, "Turned findings into a two-screen scanner flow.");
    assert.equal(d.querySelectorAll("ol > li").length, 2);
    assert.equal(d.querySelectorAll("hr").length, 1);
    assert.equal(d.querySelectorAll("a").length, 0);
});
