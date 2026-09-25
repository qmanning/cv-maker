// Unit tests for src/import/docx.ts — the Word → FlowDoc converter. Fixtures are built here: some with the `docx`
// package (the library IcedCoffee's own export uses), some as hand-written minimal OOXML zipped with JSZip (for the
// parts `docx` can't write: theme fonts, text boxes, complex fields, merged cells), plus one real file made by macOS
// textutil from the sample résumé (test/fixtures/import/sample-resume.textutil.docx).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import * as docx from "docx";
import { installJsdom, bundleAndImport, repoRoot } from "./_helpers.mjs";

installJsdom();
const { docxToFlow } = await bundleAndImport("src/import/docx.ts");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const parse = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
const styleOf = (el) => Object.fromEntries((el.getAttribute("style") ?? "").split(";").map((d) => d.split(":").map((s) => s.trim())).filter((d) => d[0]));

const NSDECL = [
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    'xmlns:v="urn:schemas-microsoft-com:vml"',
].join(" ");
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** a minimal .docx: body XML (inside w:body), optional styles / numbering / theme / header / footer / extra rels + files */
async function makeDocx({ body, styles, numbering, theme, rels = [], files = {}, sectPr = "", title }) {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
    const all = [...rels];
    if (styles) { zip.file("word/styles.xml", `<w:styles ${NSDECL}>${styles}</w:styles>`); all.push(`<Relationship Id="rSt" Type="${REL}/styles" Target="styles.xml"/>`); }
    if (numbering) { zip.file("word/numbering.xml", `<w:numbering ${NSDECL}>${numbering}</w:numbering>`); all.push(`<Relationship Id="rNum" Type="${REL}/numbering" Target="numbering.xml"/>`); }
    if (theme) { zip.file("word/theme/theme1.xml", theme); all.push(`<Relationship Id="rTh" Type="${REL}/theme" Target="theme/theme1.xml"/>`); }
    if (title) zip.file("docProps/core.xml", `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`);
    for (const [p, data] of Object.entries(files)) zip.file(p, data);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${all.join("")}</Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${NSDECL}><w:body>${body}<w:sectPr>${sectPr}</w:sectPr></w:body></w:document>`);
    return zip.generateAsync({ type: "arraybuffer" });
}
const packDocx = async (doc) => toAB(await docx.Packer.toBuffer(doc));
const run = (text, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;

/* ---------------- styles & runs ---------------- */

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements>
  <a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>
  <a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`;
const STYLES = `
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496" w:themeColor="accent1"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Section"><w:name w:val="Section"/><w:basedOn w:val="Heading1"/>
    <w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="808080"/></w:pBdr><w:outlineLvl w:val="9"/></w:pPr>
    <w:rPr><w:caps/><w:spacing w:val="20"/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="Accent"><w:name w:val="Accent"/><w:basedOn w:val="Strong"/><w:rPr><w:color w:val="C00000"/></w:rPr></w:style>`;

test("styles: docDefaults, basedOn chains, theme fonts, outline level → h1, base", async () => {
    const r = await docxToFlow(await makeDocx({
        styles: STYLES, theme: THEME, title: "Jane Doe CV",
        body: para(run("Jane Doe"), '<w:pStyle w:val="Heading1"/>') + para(run("Experience"), '<w:pStyle w:val="Section"/>') + para(run("Body text")),
    }), "t.docx");
    const b = parse(r.html);
    const h1 = b.querySelector("h1");
    assert.equal(h1.textContent, "Jane Doe");
    assert.deepEqual(
        [styleOf(h1)["font-family"], styleOf(h1)["font-size"], styleOf(h1).color, styleOf(h1)["margin-top"], styleOf(h1)["margin-bottom"], styleOf(h1)["line-height"]],
        ["'Calibri Light'", "16pt", "#2f5496", "12pt", "0pt", "1.079"]);
    // Section is basedOn Heading1 but resets the outline level to body text: a <p>, still with its inherited look
    const sec = [...b.querySelectorAll("p")].find((p) => p.textContent === "Experience");
    assert.ok(sec, "Section paragraph is a <p>");
    const s = styleOf(sec);
    assert.equal(s["font-family"], "'Calibri Light'");
    assert.equal(s["font-size"], "12pt");
    assert.equal(s["text-transform"], "uppercase");
    assert.equal(s["letter-spacing"], "1pt");
    assert.equal(s["border-bottom"], "1pt solid #808080");
    const body = [...b.querySelectorAll("p")].find((p) => p.textContent === "Body text");
    assert.equal(styleOf(body)["font-family"], "Calibri");
    assert.equal(styleOf(body)["font-size"], "11pt");
    assert.equal(styleOf(body)["margin-bottom"], "8pt");
    assert.deepEqual(r.base, { fontFamily: "Calibri", fontSizePt: 11, color: "#000000", lineHeight: 1.079 });
    assert.equal(r.title, "Jane Doe CV");
});

test("runs: bold / italic / colour / size / character styles, only what differs from the block, adjacent runs merged", async () => {
    const r = await docxToFlow(await makeDocx({
        styles: STYLES, theme: THEME,
        body: para(run("Plain ") + run("Bo", "<w:b/>") + run("ld", "<w:b/>") + run(" ") + run("Ital", "<w:i/>") + run(" ")
            + run("Big", '<w:color w:val="FF0000"/><w:sz w:val="28"/>') + run(" ") + run("Styled", '<w:rStyle w:val="Accent"/>')
            + run(" ") + run("x", '<w:vertAlign w:val="superscript"/>') + run(" ") + run("under", '<w:u w:val="single"/>') + run("  two  spaces")),
    }), "t.docx");
    const html = r.html;
    assert.match(html, /<strong>Bold<\/strong>/, "adjacent bold runs merge");
    assert.match(html, /<em>Ital<\/em>/);
    assert.match(html, /<span style="font-size: 14pt; color: #ff0000">Big<\/span>/);
    assert.match(html, /<span style="color: #c00000"><strong>Styled<\/strong><\/span>/, "character style basedOn chain");
    assert.match(html, /<sup>x<\/sup>/);
    assert.match(html, /<u>under<\/u>/);
    assert.match(html, / &nbsp;two &nbsp;spaces/, "runs of spaces survive HTML");
    assert.doesNotMatch(html, /font-family: Calibri"?>Plain/, "plain text carries no span");
});

test("runs: formatting shared by every run is hoisted onto the block", async () => {
    const r = await docxToFlow(await makeDocx({
        styles: STYLES, theme: THEME,
        body: para(run("JANE", '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="48"/>') + run(" DOE", '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="48"/>')),
    }), "t.docx");
    const p = parse(r.html).querySelector("p");
    assert.equal(p.innerHTML, "JANE DOE");
    assert.equal(styleOf(p)["font-family"], "Georgia");
    assert.equal(styleOf(p)["font-size"], "24pt");
    assert.equal(styleOf(p)["font-weight"], "bold");
});

test("tabs: a right tab stop puts the dates on the right (pos in pt), style stops + direct stops merge", async () => {
    const styles = STYLES + `<w:style w:type="paragraph" w:styleId="Job"><w:name w:val="Job"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="1440"/></w:tabs></w:pPr></w:style>`;
    const r = await docxToFlow(await makeDocx({
        styles, theme: THEME,
        body: para(run("Designer, Acme Corp") + "<w:r><w:tab/></w:r>" + run("2019 – 2023"), '<w:pStyle w:val="Job"/><w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs>')
            + para(run("A") + "<w:r><w:tab/></w:r>" + run("B") + "<w:r><w:tab/></w:r>" + run("C"), '<w:pStyle w:val="Job"/><w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs>'),
    }), "t.docx");
    const [p1, p2] = parse(r.html).querySelectorAll("p");
    const t1 = p1.querySelector("[data-flow-tab]");
    assert.equal(t1.getAttribute("data-flow-tab"), "right");
    assert.equal(t1.getAttribute("data-flow-pos"), "504");
    assert.equal(p1.textContent, "Designer, Acme Corp2019 – 2023");
    const t2 = [...p2.querySelectorAll("[data-flow-tab]")].map((t) => `${t.getAttribute("data-flow-tab")}@${t.getAttribute("data-flow-pos")}`);
    assert.deepEqual(t2, ["left@72", "right@504"]);
});

/* ---------------- lists ---------------- */

test("lists (docx package): bullets, numbers, nesting, one list per run of items", async () => {
    const { Document, Paragraph, LevelFormat, AlignmentType } = docx;
    const lvl = (level, format, text, left) => ({ level, format, text, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left, hanging: 360 } } } });
    const doc = new Document({
        numbering: { config: [
            { reference: "b", levels: [lvl(0, LevelFormat.BULLET, "•", 720), lvl(1, LevelFormat.BULLET, "o", 1440)] },
            { reference: "n", levels: [lvl(0, LevelFormat.DECIMAL, "%1.", 720), lvl(1, LevelFormat.LOWER_LETTER, "%2)", 1440)] },
        ] },
        sections: [{ children: [
            new Paragraph({ text: "Intro" }),
            new Paragraph({ text: "One", numbering: { reference: "b", level: 0 } }),
            new Paragraph({ text: "One-a", numbering: { reference: "b", level: 1 } }),
            new Paragraph({ text: "Two", numbering: { reference: "b", level: 0 } }),
            new Paragraph({ text: "Between" }),
            new Paragraph({ text: "First", numbering: { reference: "n", level: 0 } }),
            new Paragraph({ text: "Sub", numbering: { reference: "n", level: 1 } }),
            new Paragraph({ text: "Second", numbering: { reference: "n", level: 0 } }),
        ] }],
    });
    const r = await docxToFlow(await packDocx(doc), "lists.docx");
    const b = parse(r.html);
    const top = [...b.children].map((e) => e.tagName.toLowerCase());
    assert.deepEqual(top, ["p", "ul", "p", "ol"]);
    const ul = b.querySelector("ul");
    assert.deepEqual([...ul.children].map((e) => e.tagName.toLowerCase()), ["li", "ul", "li"], "nested list follows its parent li");
    assert.equal(styleOf(ul)["list-style-type"], "disc");
    assert.equal(styleOf(ul)["margin-left"], "36pt");
    assert.equal(styleOf(ul.querySelector("ul"))["list-style-type"], "circle");
    assert.equal(styleOf(ul.querySelector("ul"))["margin-left"], "36pt", "nested margin is relative to its parent list");
    const ol = b.querySelector("ol");
    assert.equal(styleOf(ol)["list-style-type"], "decimal");
    assert.equal(styleOf(ol.querySelector("ol"))["list-style-type"], "lower-alpha");
    assert.deepEqual([...b.querySelectorAll("li")].map((li) => li.textContent), ["One", "One-a", "Two", "First", "Sub", "Second"]);
});

test("lists: numbering via the paragraph style, contextual spacing between items", async () => {
    const styles = STYLES + `<w:style w:type="paragraph" w:styleId="Bullet"><w:name w:val="List Bullet"/>
        <w:pPr><w:numPr><w:numId w:val="7"/></w:numPr><w:spacing w:before="60" w:after="60"/><w:contextualSpacing/></w:pPr></w:style>`;
    const numbering = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/>
        <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings"/></w:rPr></w:lvl></w:abstractNum>
        <w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num>`;
    const r = await docxToFlow(await makeDocx({ styles, numbering, theme: THEME,
        body: para(run("a"), '<w:pStyle w:val="Bullet"/>') + para(run("b"), '<w:pStyle w:val="Bullet"/>') }), "t.docx");
    const b = parse(r.html);
    const ul = b.querySelector("ul");
    assert.equal(styleOf(ul)["list-style-type"], "square", "Wingdings § glyph is a square bullet");
    assert.equal(styleOf(ul)["margin-left"], "18pt");
    const [a, bb] = b.querySelectorAll("li");
    assert.equal(styleOf(a)["margin-top"], "3pt");
    assert.equal(styleOf(a)["margin-bottom"], "0pt");
    assert.equal(styleOf(bb)["margin-top"], "0pt");
});

/* ---------------- tables ---------------- */

test("tables: a borderless 2-column layout keeps its widths, cells hold blocks; gridSpan / vMerge", async () => {
    const cell = (w, inner, tcPr = "") => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${tcPr}</w:tcPr>${inner}</w:tc>`;
    const body = `<w:tbl><w:tblPr><w:tblW w:w="10080" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>
        <w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="144" w:type="dxa"/></w:tblCellMar></w:tblPr>
        <w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="7200"/></w:tblGrid>
        <w:tr>${cell(2880, para(run("SKILLS", "<w:b/>")) + para(run("Figma")), '<w:shd w:val="clear" w:fill="EEEEEE"/>')}${cell(7200, para(run("Experience")), '<w:vAlign w:val="center"/>')}</w:tr>
        <w:tr>${cell(10080, para(run("Wide")), '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`
        + `<w:tbl><w:tblGrid><w:gridCol w:w="1440"/><w:gridCol w:w="1440"/></w:tblGrid>
        <w:tr>${cell(1440, para(run("Tall")), '<w:vMerge w:val="restart"/><w:tcBorders><w:top w:val="single" w:sz="4" w:color="000000"/></w:tcBorders>')}${cell(1440, para(run("r1")))}</w:tr>
        <w:tr>${cell(1440, para(""), "<w:vMerge/>")}${cell(1440, para(run("r2")))}</w:tr></w:tbl>`;
    const r = await docxToFlow(await makeDocx({ styles: STYLES, theme: THEME, body }), "t.docx");
    const b = parse(r.html);
    const [t1, t2] = b.querySelectorAll("table");
    const tds = t1.querySelectorAll("td");
    assert.equal(tds.length, 3);
    const s0 = styleOf(tds[0]);
    assert.equal(s0.width, "144pt");
    assert.equal(s0["border-top"], "none");
    assert.equal(s0["border-right"], "none");
    assert.equal(s0.padding, "0pt 7.2pt 0pt 0pt");
    assert.equal(s0["background-color"], "#eeeeee");
    assert.equal(s0["vertical-align"], "top");
    assert.equal(styleOf(tds[1])["vertical-align"], "middle");
    assert.equal(styleOf(tds[1]).width, "360pt");
    assert.equal(tds[0].querySelectorAll("p").length, 2, "a cell holds its paragraphs as blocks");
    assert.equal(tds[2].getAttribute("colspan"), "2");
    const tall = t2.querySelector("td");
    assert.equal(tall.getAttribute("rowspan"), "2");
    assert.equal(styleOf(tall)["border-top"], "0.5pt solid #000000", "sz is eighths of a point");
    assert.equal(t2.querySelectorAll("td").length, 3, "the merged-away cell is not emitted");
});

/* ---------------- images, text boxes, links ---------------- */

test("images (docx package): inline picture → figure, floating picture → data-flow-abs at its page position", async () => {
    const { Document, Paragraph, ImageRun, TextRun, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom } = docx;
    const doc = new Document({ sections: [{ children: [
        new Paragraph({ children: [new ImageRun({ type: "png", data: PNG, transformation: { width: 96, height: 48 } })] }),
        new Paragraph({ children: [new TextRun("Logo "), new ImageRun({ type: "png", data: PNG, transformation: { width: 16, height: 16 } })] }),
        new Paragraph({ children: [new ImageRun({ type: "png", data: PNG, transformation: { width: 40, height: 40 },
            floating: { horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 914400 }, verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 457200 } } })] }),
    ] }] });
    const r = await docxToFlow(await packDocx(doc), "img.docx");
    const b = parse(r.html);
    const fig = b.querySelector("figure > img");
    assert.ok(fig, "an image alone on its line is a figure");
    assert.match(fig.getAttribute("src"), /^data:image\/png;base64,/);
    assert.equal(styleOf(fig).width, "72pt");
    assert.equal(styleOf(fig).height, "36pt");
    const inline = [...b.querySelectorAll("p")].find((p) => p.textContent.startsWith("Logo"));
    assert.ok(inline.querySelector("img"), "an image beside text stays inline");
    const abs = b.querySelector("div[data-flow-abs]");
    assert.ok(abs);
    assert.deepEqual([styleOf(abs).left, styleOf(abs).top, styleOf(abs).width], ["72pt", "36pt", "30pt"]);
    assert.ok(abs.querySelector("figure > img"));
    assert.deepEqual(r.warnings, []);
});

test("text box (DrawingML in mc:AlternateContent): its blocks are positioned from the page corner, insets applied", async () => {
    const box = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>
        <wp:anchor behindDoc="0" simplePos="0" relativeHeight="1" locked="0" layoutInCell="1" allowOverlap="1">
          <wp:simplePos x="0" y="0"/>
          <wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>
          <wp:positionV relativeFrom="margin"><wp:posOffset>127000</wp:posOffset></wp:positionV>
          <wp:extent cx="2540000" cy="1270000"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Text Box 1"/>
          <a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>
            <wps:spPr><a:prstGeom prst="rect"/><a:noFill/></wps:spPr>
            <wps:txbx><w:txbxContent>${para(run("Sidebar", "<w:b/>"))}${para(run("Contact me"))}</w:txbxContent></wps:txbx>
            <wps:bodyPr lIns="127000" tIns="0" rIns="127000" bIns="0"/>
          </wps:wsp></a:graphicData></a:graphic>
        </wp:anchor></w:drawing></mc:Choice>
        <mc:Fallback><w:pict><v:shape style="position:absolute;width:200pt;height:100pt"><v:textbox><w:txbxContent>${para(run("FALLBACK"))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>
        </mc:AlternateContent></w:r>`;
    const r = await docxToFlow(await makeDocx({ styles: STYLES, theme: THEME, body: para(box) + para(run("Main column")),
        sectPr: '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' }), "t.docx");
    const b = parse(r.html);
    const abs = b.querySelector("div[data-flow-abs]");
    assert.ok(abs, "text box becomes data-flow-abs");
    const s = styleOf(abs);
    assert.deepEqual([s.left, s.top, s.width, s.height], ["10pt", "82pt", "180pt", "100pt"]);
    assert.deepEqual([...abs.querySelectorAll("p")].map((p) => p.textContent), ["Sidebar", "Contact me"]);
    assert.doesNotMatch(r.html, /FALLBACK/, "the VML fallback is not read twice");
    assert.match(r.html, /Main column/);
});

test("hyperlinks: w:hyperlink r:id, HYPERLINK fields (complex and simple); anchor-only links stay text", async () => {
    const { Document, Paragraph, ExternalHyperlink, TextRun } = docx;
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [
        new TextRun("See "), new ExternalHyperlink({ link: "https://example.com/work", children: [new TextRun({ text: "my work", style: "Hyperlink" })] }),
    ] })] }] });
    const r1 = await docxToFlow(await packDocx(doc), "l.docx");
    assert.match(r1.html, /<a href="https:\/\/example\.com\/work">(?:<[^>]+>)*my work/);

    const field = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:jane@example.com" </w:instrText></w:r>`
        + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("jane@example.com")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const simple = `<w:fldSimple w:instr=" HYPERLINK &quot;https://jane.dev&quot; ">${run("jane.dev")}</w:fldSimple>`;
    const anchor = `<w:hyperlink w:anchor="_Toc1">${run("Top")}</w:hyperlink>`;
    const page = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("1")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const r2 = await docxToFlow(await makeDocx({ styles: STYLES, theme: THEME, body: para(field + run(" | ") + simple + run(" ") + anchor + run(" p") + page) }), "t.docx");
    assert.match(r2.html, /<a href="mailto:jane@example.com">jane@example.com<\/a>/);
    assert.match(r2.html, /<a href="https:\/\/jane.dev">jane.dev<\/a>/);
    assert.doesNotMatch(r2.html, /HYPERLINK|PAGE/, "field codes never show");
    assert.match(r2.html, /Top p1/, "anchor link is plain text; other fields show their result");
    assert.equal((r2.html.match(/<a /g) ?? []).length, 2);
});

/* ---------------- page, sections, headers, odds and ends ---------------- */

test("page size and margins (docx package) → FlowResult.page in pt", async () => {
    const { Document, Paragraph } = docx;
    const doc = new Document({ sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, right: 1080, bottom: 720, left: 1080 } } },
        children: [new Paragraph({ text: "A4" })] }] });
    const r = await docxToFlow(await packDocx(doc), "a4.docx");
    assert.deepEqual(r.page, { widthPt: 595.3, heightPt: 841.9, marginTopPt: 36, marginBottomPt: 36, marginLeftPt: 54, marginRightPt: 54 });
});

test("columns: a 2-column section splits at its column break; first-page header goes first; footer text is flagged", async () => {
    const hdr = `<w:hdr ${NSDECL}>${para(run("JANE DOE — HEADER"))}</w:hdr>`;
    const ftr = `<w:ftr ${NSDECL}>${para(run("Confidential draft"))}</w:ftr>`;
    const body = para(run("Left one")) + para(run("Left two") + '<w:r><w:br w:type="column"/></w:r>' + run("Right one"));
    const r = await docxToFlow(await makeDocx({
        styles: STYLES, theme: THEME, body,
        rels: [`<Relationship Id="rH" Type="${REL}/header" Target="header1.xml"/>`, `<Relationship Id="rF" Type="${REL}/footer" Target="footer1.xml"/>`],
        files: { "word/header1.xml": hdr, "word/footer1.xml": ftr },
        sectPr: '<w:headerReference w:type="default" r:id="rH"/><w:footerReference w:type="default" r:id="rF"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:cols w:num="2" w:space="720"/>',
    }), "t.docx");
    const b = parse(r.html);
    assert.equal(b.firstElementChild.textContent, "JANE DOE — HEADER");
    const cols = b.querySelectorAll("div[data-flow-cols] > div[data-flow-col]");
    assert.equal(cols.length, 2);
    assert.equal(styleOf(cols[0]).width, "216pt");
    assert.deepEqual([...cols[0].querySelectorAll("p")].map((p) => p.textContent), ["Left one", "Left two"]);
    assert.deepEqual([...cols[1].querySelectorAll("p")].map((p) => p.textContent), ["Right one"]);
    assert.ok(r.warnings.some((w) => /footer text \("Confidential draft"\)/.test(w)), r.warnings.join(" | "));
});

test("odds and ends: EMF pictures warn, deleted text drops, sdt unwraps, Symbol bullet, escaping, hanging indent", async () => {
    const pic = (id) => `<w:r><w:drawing><wp:inline><wp:extent cx="127000" cy="127000"/><wp:docPr id="9" name="p"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const body = para(pic("rE")) + para(run("kept") + `<w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del>` + `<w:ins w:id="2">${run(" added")}</w:ins>`)
        + `<w:sdt><w:sdtContent>${para(run("in a control"))}</w:sdtContent></w:sdt>`
        + para(`<w:r><w:sym w:font="Symbol" w:char="F0B7"/></w:r>` + run(" &lt;b&gt;&amp;amp;&lt;/b&gt;"))
        + para(run("hang"), '<w:ind w:left="720" w:hanging="360"/><w:jc w:val="both"/>');
    const r = await docxToFlow(await makeDocx({ styles: STYLES, theme: THEME, body,
        rels: [`<Relationship Id="rE" Type="${REL}/image" Target="media/image1.emf"/>`],
        files: { "word/media/image1.emf": Buffer.from([1, 0, 0, 0, 0x6c, 0, 0, 0]) } }), "t.docx");
    assert.ok(r.warnings.some((w) => /1 picture was in a format IcedCoffee can't show \(EMF\)/.test(w)), r.warnings.join(" | "));
    assert.match(r.html, /kept added/);
    assert.doesNotMatch(r.html, /gone/);
    assert.match(r.html, />in a control</);
    assert.match(r.html, /• &lt;b&gt;&amp;amp;&lt;\/b&gt;/);
    const hang = [...parse(r.html).querySelectorAll("p")].find((p) => p.textContent === "hang");
    assert.deepEqual([styleOf(hang)["margin-left"], styleOf(hang)["text-indent"], styleOf(hang)["text-align"]], ["36pt", "-18pt", "justify"]);
    assert.doesNotMatch(r.html, /\sclass=|\sid=/);
});

test("a file that isn't a Word document is refused with a plain sentence", async () => {
    await assert.rejects(() => docxToFlow(toAB(Buffer.from("not a zip")), "x.docx"), /isn't a Word document/);
});

/* ---------------- a real file: the sample résumé, via macOS textutil ---------------- */

test("sample-resume.textutil.docx: name, headings, typed bullets become list items", async () => {
    const file = path.join(repoRoot, "test/fixtures/import/sample-resume.textutil.docx");
    const r = await docxToFlow(toAB(fs.readFileSync(file)), "sample-resume.docx");
    const b = parse(r.html);
    const name = [...b.querySelectorAll("p")].find((p) => p.textContent === "Mara Quill");
    assert.ok(name, "the name is its own paragraph");
    assert.equal(styleOf(name)["font-weight"], "bold");
    assert.equal(styleOf(name)["font-family"], "Helvetica");
    const lis = [...b.querySelectorAll("ul > li")];
    assert.ok(lis.length >= 15, `expected the job bullets as <li>, got ${lis.length}`);
    assert.ok(lis.some((li) => li.textContent.startsWith("Cut fare-purchase time")));
    assert.ok(lis.every((li) => !/^[\s•]/.test(li.textContent)), "the typed bullet glyph is not kept as text");
    assert.match(r.html, /<strong>Research:<\/strong> field visits/);
    assert.deepEqual(r.page, { widthPt: 612, heightPt: 792, marginTopPt: 72, marginBottomPt: 72, marginLeftPt: 72, marginRightPt: 72 });
});
