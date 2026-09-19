// Unit tests for src/cv-blocks.ts — the "+" between rows: new blocks are cloned from the document's own blocks,
// filled with placeholders, and land exactly where asked. Run against the real sample résumé and a bare page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installJsdom, importTransformed, repoRoot } from "./_helpers.mjs";

installJsdom();

const { buildBlock, insertBlock, topBlocks } = await importTransformed("src/cv-blocks.ts");
const { parseSource } = await importTransformed("src/cv-source.ts");

const sample = fs.readFileSync(path.join(repoRoot, "templates/sample-resume.html"), "utf8");
function samplePage() {
    const holder = document.createElement("div"); holder.innerHTML = parseSource(sample).html;
    return holder.querySelector(".cv-page");
}
function barePage() {
    const holder = document.createElement("div"); holder.innerHTML = `<div class="cv-page"><div data-cv-block data-cv-edit><p>Name</p></div></div>`;
    return holder.querySelector(".cv-page");
}

test("an experience block is shaped like the document's own job, with placeholder copy", () => {
    const page = samplePage(), block = buildBlock("experience", page);
    assert.equal(block.getAttribute("data-cv-repeat"), "job");
    assert.ok(block.hasAttribute("data-cv-block"));
    const regions = Array.from(block.querySelectorAll("[data-cv-edit]"));
    assert.equal(regions.length, 3);
    assert.equal(regions[0].textContent, "Job Title, Company");
    assert.match(regions[1].textContent || "", /Present/);
    assert.ok(regions[2].classList.contains("cv-flow"), "the bullets keep flowing across columns");
    assert.equal(regions[2].querySelectorAll("li > p").length, 2);
});

test("a new block carries none of the prototype's copy or one-off tweaks", () => {
    const page = samplePage();
    for (const kind of ["content", "experience", "dual"]) {
        const block = buildBlock(kind, page);
        assert.doesNotMatch(block.textContent || "", /Halcyon|Tidewater|Paperboat|Mara/);
        assert.equal(block.querySelectorAll("[data-col-break]").length, 0);
        assert.equal(block.querySelectorAll("[data-cv-edit][style]").length, 0);
        assert.ok(!block.hasAttribute("data-cv-keep-next"));
    }
});

test("a dual list has two independent columns, each a heading plus a labelled list", () => {
    const block = buildBlock("dual", samplePage());
    assert.equal(block.children.length, 2);
    for (const col of Array.from(block.children)) {
        const regions = Array.from(col.querySelectorAll("[data-cv-edit]"));
        assert.equal(regions.length, 2);
        assert.equal(regions[0].textContent, "List Heading");
        assert.equal(regions[1].querySelectorAll("li").length, 3);
        assert.equal(regions[1].querySelectorAll("li strong").length, 3);
    }
});

test("a content block is a single editable paragraph region", () => {
    const block = buildBlock("content", samplePage());
    assert.ok(block.matches("[data-cv-block][data-cv-edit]"));
    assert.equal(block.querySelectorAll("p").length, 1);
    assert.equal(block.querySelectorAll("ul").length, 0);
});

test("insertBlock lands after the hovered row and reports the new index", () => {
    const page = samplePage(), before = topBlocks(page), anchor = before[3];
    const index = insertBlock(page, 3, "content");
    const after = topBlocks(page);
    assert.equal(after.length, before.length + 1);
    assert.equal(index, 4);
    assert.equal(after[4].previousElementSibling, anchor);
    assert.equal(insertBlock(page, after.length - 1, "dual"), after.length, "after the last row appends");
});

test("every region in a new block is mountable: non-empty, paragraphs or lists only", () => {
    const page = samplePage();
    for (const kind of ["content", "experience", "dual"]) {
        const block = buildBlock(kind, page), regions = block.matches("[data-cv-edit]") ? [block] : Array.from(block.querySelectorAll("[data-cv-edit]"));
        for (const r of regions) {
            assert.ok(r.children.length > 0);
            for (const child of Array.from(r.children)) assert.match(child.tagName, /^(P|UL|OL)$/);
        }
    }
});

test("a template with no block of that kind falls back to the built-in one", () => {
    const page = barePage();
    const job = buildBlock("experience", page);
    assert.equal(job.querySelectorAll("[data-cv-edit]").length, 3);
    assert.equal(buildBlock("dual", page).children.length, 2);
    assert.ok(buildBlock("content", page).matches("[data-cv-edit]"));
    assert.equal(insertBlock(page, 0, "experience"), 1);
});

test("a template can name its prototypes with data-cv-kind", () => {
    const holder = document.createElement("div");
    holder.innerHTML = `<div class="cv-page"><article class="my-role" data-cv-block data-cv-kind="experience"><h3 data-cv-edit><p>Old title</p></h3><div data-cv-edit><ul><li><p>Old bullet</p></li></ul></div></article></div>`;
    const block = buildBlock("experience", holder.querySelector(".cv-page"));
    assert.ok(block.classList.contains("my-role"));
    assert.ok(!block.hasAttribute("data-cv-kind"), "the clone is an ordinary block, not a second prototype");
    assert.doesNotMatch(block.textContent || "", /Old/);
});
