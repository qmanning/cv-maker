// Unit tests for src/cv-assistant.ts — "ask your AI": the model sees addressable blocks/regions and answers with
// operations. These are the safety net for whatever a model sends back: wrong ids, hostile HTML, prose where a list belongs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installJsdom, importTransformed, bundleSourceAndImport, repoRoot } from "./_helpers.mjs";

installJsdom();

const { applyOps, cleanHtml, describeDocument } = await bundleSourceAndImport(`export * from "./src/cv-assistant";`);   // bundled: it imports ./cv-blocks
const { parseSource } = await importTransformed("src/cv-source.ts");

const sample = parseSource(fs.readFileSync(path.join(repoRoot, "templates/sample-resume.html"), "utf8")).html;
const meta = { name: "Mara Quill", paper: "US Letter", pages: 1, fitScale: 1 };
const op = (o) => ({ op: "set_text", target: "", html: "", kind: "", fill: [], to: "", ...o });
const pageOf = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.querySelector(".cv-page"); };

test("the document is described as blocks and regions, every editable region exactly once", () => {
    const doc = describeDocument(sample, meta);
    const ids = [...doc.blocks.flatMap((b) => b.regions), ...doc.other].map((r) => r.id);
    assert.equal(ids.length, 21);
    assert.equal(new Set(ids).size, 21);
    assert.equal(doc.blocks.filter((b) => b.kind === "job").length, 3);
    assert.ok(doc.blocks.some((b) => b.regions.some((r) => r.list)));
});

test("set_text rewrites one region and leaves the template's own markup alone", () => {
    const doc = describeDocument(sample, meta), target = doc.blocks.find((b) => b.kind === "job").regions[0];
    const out = applyOps(sample, [op({ target: target.id, html: "<p>Principal Designer, Halcyon Transit</p>" })]);
    assert.equal(out.applied, 1);
    const before = pageOf(sample), after = pageOf(out.html);
    assert.match(after.textContent || "", /Principal Designer, Halcyon Transit/);
    assert.equal(after.querySelectorAll("[data-cv-edit]").length, before.querySelectorAll("[data-cv-edit]").length);
    assert.equal(after.querySelectorAll("[data-cv-block]").length, before.querySelectorAll("[data-cv-block]").length);
});

test("hostile HTML from a model is reduced to harmless formatting", () => {
    const dirty = `<p onclick="x()">Hi <img src=x onerror="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)">bad</a> <a href="https://ok.example" target="_blank">ok</a> <span style="color:red">red</span><iframe src="//evil"></iframe></p>`;
    const clean = cleanHtml(dirty);
    assert.doesNotMatch(clean, /on\w+=|<script|<img|<iframe|javascript:|style=|target=/i);
    assert.match(clean, /<a href="https:\/\/ok\.example">ok<\/a>/);
    assert.match(clean, /<a>bad<\/a>/);
});

test("a list region stays one list: prose is turned into bullets, never dropped in raw", () => {
    const doc = describeDocument(sample, meta), list = doc.blocks.flatMap((b) => b.regions).find((r) => r.list);
    const out = applyOps(sample, [op({ target: list.id, html: "<p>Shipped the rider app redesign.</p><p>Cut support tickets 30%.</p>" })]);
    assert.equal(out.applied, 1);
    const region = pageOf(out.html).querySelectorAll("[data-cv-edit]")[Number(list.id.slice(1))];
    assert.equal(region.children.length, 1);
    assert.equal(region.querySelectorAll(":scope > ul > li").length, 2);
});

test("ids refer to the document as described, even after earlier inserts and deletes", () => {
    const doc = describeDocument(sample, meta), jobs = doc.blocks.filter((b) => b.kind === "job");
    const out = applyOps(sample, [
        op({ op: "insert_block", target: "start", kind: "content", fill: ["<p>NEW SUMMARY</p>"] }),
        op({ op: "delete_block", target: jobs[0].id }),
        op({ target: jobs[1].regions[0].id, html: "<p>STILL THE SECOND JOB</p>" }),
    ]);
    assert.equal(out.applied, 3);
    const page = pageOf(out.html), text = page.textContent || "";
    assert.match(page.querySelector("[data-cv-block]").textContent || "", /NEW SUMMARY/);
    assert.equal(page.querySelectorAll('[data-cv-repeat="job"]').length, 2);
    assert.match(text, /STILL THE SECOND JOB/);
    assert.match(text, /Tidewater|Paperboat/);
});

test("duplicate, move, and filling a new experience block", () => {
    const doc = describeDocument(sample, meta), jobs = doc.blocks.filter((b) => b.kind === "job");
    const out = applyOps(sample, [
        op({ op: "insert_block", target: jobs[0].id, kind: "experience", fill: ["<p>Design Lead, Newco</p>", "<p>2024 - Present</p>", "<ul><li><p>Did a thing.</p></li></ul>"] }),
        op({ op: "move_block", target: jobs[2].id, to: "start" }),
    ]);
    assert.equal(out.applied, 2);
    const page = pageOf(out.html), all = Array.from(page.querySelectorAll('[data-cv-repeat="job"]'));
    assert.equal(all.length, 4);
    assert.match(page.textContent || "", /Design Lead, Newco/);
    assert.equal(page.querySelector("[data-cv-block]"), all[0]);
});

test("nonsense from a model is skipped and reported, never thrown", () => {
    const out = applyOps(sample, [op({ target: "r999", html: "<p>x</p>" }), op({ op: "delete_block", target: "b999" }), op({ op: "insert_block", target: "b0", kind: "banner" }), { nope: true }, null]);
    assert.equal(out.applied, 0);
    assert.equal(out.skipped.length, 4);
    assert.equal(pageOf(out.html).outerHTML, pageOf(sample).outerHTML);
});
