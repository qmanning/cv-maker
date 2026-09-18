// Checks that templates/sample-resume.html still follows the conventions documented in its own header
// comment ([data-cv-edit], .cv-flow, [data-cv-block], etc.) — a regression test for the template file
// itself, not for CV Maker's code. Also guards against the fictional sample leaking any of the real
// author's identifying info.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot, installJsdom } from "./_helpers.mjs";

installJsdom();

const TEMPLATE_PATH = path.join(repoRoot, "templates", "sample-resume.html");
const html = fs.readFileSync(TEMPLATE_PATH, "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");

test("exactly one .cv-page", () => {
    assert.equal(doc.querySelectorAll(".cv-page").length, 1);
});

test("21 [data-cv-edit] regions", () => {
    assert.equal(doc.querySelectorAll("[data-cv-edit]").length, 21);
});

test('3 [data-cv-repeat="job"] blocks', () => {
    assert.equal(doc.querySelectorAll('[data-cv-repeat="job"]').length, 3);
});

test("every [data-cv-block] is a direct child of .cv-page", () => {
    const page = doc.querySelector(".cv-page");
    const blocks = Array.from(doc.querySelectorAll("[data-cv-block]"));
    assert.ok(blocks.length > 0, "expected at least one [data-cv-block]");
    for (const block of blocks) {
        assert.equal(block.parentElement, page, `[data-cv-block] "${block.className}" is not a direct child of .cv-page`);
    }
});

test("each job has a title, meta, and a .cv-flow body", () => {
    const jobs = Array.from(doc.querySelectorAll('[data-cv-repeat="job"]'));
    assert.equal(jobs.length, 3);
    for (const job of jobs) {
        assert.equal(job.querySelectorAll(".cv-job-title").length, 1);
        assert.equal(job.querySelectorAll(".cv-job-meta").length, 1);
        assert.equal(job.querySelectorAll(".cv-flow").length, 1);
    }
});

test("every .cv-flow region's direct content is exactly one <ul>", () => {
    const flows = Array.from(doc.querySelectorAll(".cv-flow"));
    assert.ok(flows.length > 0, "expected at least one .cv-flow region");
    for (const flow of flows) {
        const children = Array.from(flow.children);
        assert.equal(children.length, 1, `.cv-flow should have exactly one direct child (found ${children.length})`);
        assert.equal(children[0].tagName, "UL");
    }
});

test("no <script>", () => {
    assert.equal(doc.querySelectorAll("script").length, 0);
});

test("every <img> src is a data: URI", () => {
    const imgs = Array.from(doc.querySelectorAll("img"));
    assert.ok(imgs.length > 0, "expected at least one <img>");
    for (const img of imgs) {
        assert.match(img.getAttribute("src") || "", /^data:/, `<img> src should be a data: URI, got "${img.getAttribute("src")}"`);
    }
});

test("exactly one li[data-col-break], and it is in the 2nd job", () => {
    const breaks = Array.from(doc.querySelectorAll("li[data-col-break]"));
    assert.equal(breaks.length, 1);
    const jobs = Array.from(doc.querySelectorAll('[data-cv-repeat="job"]'));
    const secondJob = jobs[1];
    assert.ok(secondJob.contains(breaks[0]), "the data-col-break <li> should live inside the 2nd job block");
});

test("every <a> href is http(s)/mailto and points at the reserved .example TLD or linkedin/github", () => {
    const links = Array.from(doc.querySelectorAll("a[href]"));
    assert.ok(links.length > 0, "expected at least one <a href>");
    for (const a of links) {
        const href = a.getAttribute("href");
        assert.match(href, /^(https?:|mailto:)/, `link "${href}" should be http(s): or mailto:`);
        if (/^https?:/.test(href)) {
            const host = new URL(href).hostname;
            assert.ok(
                /\.example$/.test(host) || host === "www.linkedin.com" || host === "github.com" || host === "linkedin.com",
                `link host "${host}" should be the reserved .example TLD or linkedin/github, not a real personal domain`,
            );
        }
    }
});

test("PRIVACY GUARD: the fictional sample contains none of the real author's identifying strings", () => {
    // the author's own details must never ship in the sample
    for (const needle of ["Manning", "qmanning"]) {
        assert.doesNotMatch(html, new RegExp(needle.replace(/[.]/g, "\\.")), `template unexpectedly contains "${needle}"`);
    }
});
