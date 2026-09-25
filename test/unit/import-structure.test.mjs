// test/unit/import-structure.test.mjs — FlowDoc → IcedCoffee Source HTML: what the rules decide each piece IS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installJsdom, bundleAndImport } from "./_helpers.mjs";

installJsdom();
const { structure } = await bundleAndImport("src/import/structure.ts");
const { parseSource } = await bundleAndImport("src/cv-source.ts");
const { describeDocument } = await bundleAndImport("src/cv-assistant.ts");

const page = (text) => new DOMParser().parseFromString(text, "text/html").querySelector(".cv-page");
const tab = '<span data-flow-tab="right" data-flow-pos="540"></span>';

const WORD = {
    html: [
        '<p style="font-size: 22pt; font-weight: 700; text-align: center; font-family: Georgia">Jordan Avery</p>',
        '<p style="text-align: center">jordan@example.com · (555) 123-4567 · linkedin.com/in/javery</p>',
        '<p style="font-size: 12pt; font-weight: 700; border-bottom: 1pt solid #1f3864; color: #1f3864; margin-top: 12pt">EXPERIENCE</p>',
        `<p><strong>Senior Product Designer, Northline</strong>${tab}Jan 2021 – Present</p>`,
        '<ul style="margin-left: 18pt"><li>Led the redesign of <span style="color: #c00000">checkout</span>, lifting conversion 12%.</li><li>Built the design system.</li></ul>',
        `<p><strong>Product Designer, Fieldwork</strong>${tab}2017 – 2020</p>`,
        '<ul style="margin-left: 18pt"><li>Shipped the mobile app.</li></ul>',
        '<p style="font-size: 12pt; font-weight: 700; border-bottom: 1pt solid #1f3864; color: #1f3864; margin-top: 12pt">EDUCATION</p>',
        '<p><strong>BFA, Interaction Design</strong> — Rhode Island School of Design, 2013 – 2017</p>',
        '<p style="font-size: 12pt; font-weight: 700; border-bottom: 1pt solid #1f3864; color: #1f3864; margin-top: 12pt">SKILLS</p>',
        '<p>Figma, prototyping, research synthesis</p>',
    ].join(""),
    page: { widthPt: 612, heightPt: 792, marginLeftPt: 54, marginRightPt: 54, marginTopPt: 36, marginBottomPt: 36 },
    base: { fontFamily: "Calibri, sans-serif", fontSizePt: 10.5, color: "#000000" },
    warnings: [],
};

test("a Word-style résumé: header, sections, entries with dates on the right", () => {
    const { text, name, report } = structure(WORD, { kind: "resume", format: "docx", fallbackName: "resume" });
    assert.equal(name, "Jordan Avery — Résumé");
    assert.deepEqual(report.sections, ["EXPERIENCE", "EDUCATION", "SKILLS"]);
    assert.equal(report.entries, 3);
    assert.equal(report.rough, false);
    const pg = page(text);
    // the header is one block the cover letter can mirror, name and contact line inside it
    const header = pg.querySelector("header[data-cv-header][data-cv-block]");
    assert.ok(header);
    assert.match(header.textContent, /Jordan Avery/);
    assert.ok(header.querySelector('a[href="mailto:jordan@example.com"]'), "the email becomes a link");
    // headings keep with what follows, jobs are repeatable entries, dates sit in their own region on the right
    assert.equal(pg.querySelectorAll("[data-cv-keep-next]").length, 3);
    const jobs = pg.querySelectorAll('section[data-cv-repeat="job"]');
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].querySelector(".imp-r").textContent, "Jan 2021 – Present");
    assert.match(jobs[0].querySelector(".imp-l").innerHTML, /<strong>Senior Product Designer, Northline<\/strong>/);
    assert.equal(jobs[0].querySelectorAll("li").length, 2);
    assert.ok(jobs[0].querySelector('li > p > span[style*="color: #c00000"]'), "run colour kept inside the region");
    // the look came across as generated CSS: page margins, the base font, the heading's rule and colour
    assert.match(text, /--cv-content-w: 504pt/);
    assert.match(text, /font-family: Calibri, sans-serif/);
    assert.match(text, /border-bottom: 1pt solid #1f3864/);
    // and it is a document the editor and the AI understand
    const parsed = parseSource(text);
    assert.ok(parsed.regions >= 10);
    const described = describeDocument(parsed.html, { name, paper: "US Letter", pages: 1, fitScale: 1 });
    assert.equal(described.blocks.filter((b) => b.kind === "job").length, 3);
    assert.ok(described.blocks.some((b) => b.regions.some((r) => r.list)));
});

test("markdown / plain text get a clean default look; an unlabelled summary stays out of the header", () => {
    const md = {
        html: "<h1>Sam Lee</h1><p>sam@lee.dev | https://lee.dev</p><p>Engineer with ten years building payment systems at scale, from the first ledger to the audit tooling that let the team ship weekly.</p><h2>Experience</h2><p><strong>Staff Engineer, Ledgerly</strong></p><p>2019 – 2024 · Remote</p><ul><li>Cut settlement time in half.</li></ul>",
        warnings: [],
    };
    const { text, report } = structure(md, { kind: "resume", format: "md", fallbackName: "sam" });
    const pg = page(text);
    assert.equal(pg.querySelector("header").querySelectorAll("[data-cv-edit]").length, 2);
    assert.deepEqual(report.sections, ["Experience"]);
    assert.equal(report.entries, 1);
    assert.match(text, /text-transform: uppercase/, "an unstyled h2 becomes a résumé section heading");
    assert.ok(pg.querySelector('a[href="https://lee.dev"]'));
});

test("columns, tables, pictures and positioned boxes stay in the layout layer with regions inside", () => {
    const flow = {
        html: '<p style="font-size: 20pt">Ana Ruiz</p><p>ana@ruiz.co</p>'
            + '<div data-flow-cols><div data-flow-col style="width: 170pt"><h2>Skills</h2><ul><li>Research</li></ul></div><div data-flow-col style="width: 340pt"><h2>Experience</h2><p>Lead, Acme — 2020 – 2023</p></div></div>'
            + '<table><tr><td style="width: 200pt">Left <strong>cell</strong></td><td><p>Right</p></td></tr></table>'
            + '<p><img src="data:image/png;base64,iVBORw0KGgo=" style="width: 40pt; height: 40pt">Logo line</p>'
            + '<div data-flow-abs style="top: 20pt; left: 480pt; width: 90pt"><p>Box</p></div>',
        warnings: ["1 thing was approximate."],
    };
    const { text, report } = structure(flow, { kind: "resume", format: "docx", fallbackName: "x" });
    const pg = page(text);
    assert.equal(report.columns, true);
    assert.equal(pg.querySelectorAll(".imp-col").length, 2);
    assert.equal(pg.querySelector(".imp-col").getAttribute("style"), "width: 170pt");
    assert.ok(pg.querySelector(".imp-cols[data-cv-block] [data-cv-repeat=job]"), "an entry inside a column is still an entry");
    assert.equal(pg.querySelectorAll(".imp-table td [data-cv-edit]").length, 2);
    assert.ok(pg.querySelector(".imp-media > img[style*='width: 40pt']"), "the picture sits beside its text, outside the region");
    assert.equal(pg.querySelectorAll("[data-cv-edit] img").length, 0, "no picture inside a region");
    assert.ok(pg.querySelector(".imp-abs[style*='left: 480pt'] [data-cv-edit]"));
    assert.ok(report.warnings.includes("1 thing was approximate."));
});

test("a cover letter keeps its paragraphs as paragraphs and says it is a letter", () => {
    const flow = { html: "<p>Jordan Avery</p><p>jordan@example.com</p><p>September 1, 2026</p><p>Dear Hiring Team,</p><p>I am writing because of the role — 2019 – 2023 was a good run.</p><p>Sincerely,</p><p>Jordan</p>", warnings: [] };
    const { text, report } = structure(flow, { kind: "letter", format: "txt", fallbackName: "letter" });
    assert.match(text, /data-cv-kind="letter"/);
    assert.equal(report.entries, 0);
});

test("plain sources: 'Title | 2021 – Present' puts the dates on the right; ### job titles are entries, ## are sections", () => {
    const flow = { html: "<h1>Kai Moreno</h1><p>kai@moreno.example</p><h2>Experience</h2><h3><strong>Lead Designer, Acme</strong> | 2021 – Present</h3><ul><li>Shipped it.</li></ul><h3>Designer, Beta</h3><p>2017 – 2021 · Remote</p><h2>Earlier roles</h2><p>Intern at Gamma (2015–2016).</p>", warnings: [] };
    const { text, report } = structure(flow, { kind: "resume", format: "md", fallbackName: "k" });
    assert.deepEqual(report.sections, ["Experience", "Earlier roles"]);
    assert.equal(report.entries, 2);
    const pg = page(text);
    assert.equal(pg.querySelector(".imp-r").textContent, "2021 – Present");
    assert.match(pg.querySelector(".imp-l").innerHTML, /<strong>Lead Designer, Acme<\/strong>/);
});
