// Unit tests for IcedCoffee's TipTap extensions (src/cv-extensions.ts): letter-spacing, per-paragraph
// line-height, and column breaks, plus the shared font-size/font-weight extensions build.mjs remaps in
// from src/shared/. Builds a headless TipTap Editor with the SAME StarterKit configuration
// src/CvMaker.tsx uses (read there: trailingNode: false, plus TextStyle/Color/FontSize/FontWeight/
// LetterSpacing/BlockLineHeight/ColumnBreak/TextAlign), so these tests exercise the real parse/render
// round trip, not a reimplementation of it. `bundleSourceAndImport` bundles a tiny inline entry that
// re-exports the pieces under test alongside the npm @tiptap packages (a data:-URL transform, like
// cv-source.test.mjs uses, can't resolve bare specifiers like "@tiptap/core" — bundling is required).
// Needs a DOM: tiptap's Editor mounts a real ProseMirror EditorView even headless.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installJsdom, bundleSourceAndImport } from "./_helpers.mjs";

installJsdom();

const { Editor, StarterKit, TextStyle, FontSize, FontWeight, BlockLineHeight, ColumnBreak, LetterSpacing } = await bundleSourceAndImport(`
    export { Editor } from "@tiptap/core";
    export { StarterKit } from "@tiptap/starter-kit";
    export { TextStyle } from "@tiptap/extension-text-style";
    export { FontSize } from "@/components/ui/font-size-extension";
    export { FontWeight } from "@/components/ui/font-weight-extension";
    export { BlockLineHeight, ColumnBreak, LetterSpacing } from "./src/cv-extensions";
`);

// mirrors the extensions array built in CvMaker.tsx's mount effect (minus Color/TextAlign, which need
// extra @tiptap packages not otherwise used by this suite and aren't under test here)
function makeEditor(content) {
    return new Editor({
        extensions: [
            StarterKit.configure({
                heading: false, codeBlock: false, code: false, blockquote: false, trailingNode: false,
                link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } },
            }),
            TextStyle, FontSize, FontWeight, LetterSpacing, BlockLineHeight, ColumnBreak,
        ],
        content,
        injectCSS: false,
    });
}

/* ---------------- (i) round trip ---------------- */

test("a paragraph's line-height style survives setContent -> getHTML", () => {
    const ed = makeEditor('<p style="line-height: 1.53">x</p>');
    assert.equal(ed.getHTML(), '<p style="line-height: 1.53;">x</p>');
    ed.destroy();
});

test("a column-break list item survives setContent -> getHTML", () => {
    const ed = makeEditor("<ul><li data-col-break><p>x</p></li></ul>");
    assert.equal(ed.getHTML(), '<ul><li data-col-break=""><p>x</p></li></ul>');
    ed.destroy();
});

test("an inline letter-spacing span survives setContent -> getHTML", () => {
    const ed = makeEditor('<p><span style="letter-spacing: -0.2pt">x</span></p>');
    assert.equal(ed.getHTML(), '<p><span style="letter-spacing: -0.2pt;">x</span></p>');
    ed.destroy();
});

test("a font-size span survives setContent -> getHTML", () => {
    const ed = makeEditor('<p><span style="font-size: 12pt">x</span></p>');
    assert.equal(ed.getHTML(), '<p><span style="font-size: 12pt;">x</span></p>');
    ed.destroy();
});

// NB: StarterKit's Bold mark has its own parseHTML rule that also matches a `style="font-weight: …"`
// of 500+ (numeric weights that read as bold) and additionally wraps the text in <strong> — so this
// round trip only stays font-weight-only, with no incidental <strong>, below that threshold.
test("a font-weight span survives setContent -> getHTML", () => {
    const ed = makeEditor('<p><span style="font-weight: 300">x</span></p>');
    assert.equal(ed.getHTML(), '<p><span style="font-weight: 300;">x</span></p>');
    ed.destroy();
});

/* ---------------- (ii) commands ---------------- */

test("setLetterSpacing / unsetLetterSpacing", () => {
    const ed = makeEditor("<p>x</p>");
    ed.commands.setTextSelection({ from: 1, to: 2 });
    ed.commands.setLetterSpacing("2pt");
    assert.equal(ed.getHTML(), '<p><span style="letter-spacing: 2pt;">x</span></p>');
    ed.commands.unsetLetterSpacing();
    assert.equal(ed.getHTML(), "<p>x</p>");
    ed.destroy();
});

test("setBlockLineHeight / unsetBlockLineHeight", () => {
    const ed = makeEditor("<p>x</p>");
    ed.commands.setTextSelection({ from: 1, to: 1 });
    ed.commands.setBlockLineHeight("1.4");
    assert.equal(ed.getHTML(), '<p style="line-height: 1.4;">x</p>');
    ed.commands.unsetBlockLineHeight();
    assert.equal(ed.getHTML(), "<p>x</p>");
    ed.destroy();
});

test("setFontSize / unsetFontSize (shared extension, sanity check against the editor's extension list)", () => {
    const ed = makeEditor("<p>x</p>");
    ed.commands.setTextSelection({ from: 1, to: 2 });
    ed.commands.setFontSize("12pt");
    assert.equal(ed.getHTML(), '<p><span style="font-size: 12pt;">x</span></p>');
    ed.commands.unsetFontSize();
    assert.equal(ed.getHTML(), "<p>x</p>");
    ed.destroy();
});

test("setFontWeight / unsetFontWeight (shared extension)", () => {
    const ed = makeEditor("<p>x</p>");
    ed.commands.setTextSelection({ from: 1, to: 2 });
    ed.commands.setFontWeight("700");
    assert.equal(ed.getHTML(), '<p><span style="font-weight: 700;">x</span></p>');
    ed.commands.unsetFontWeight();
    assert.equal(ed.getHTML(), "<p>x</p>");
    ed.destroy();
});

test("toggleColumnBreak on a plain paragraph", () => {
    const ed = makeEditor("<p>x</p>");
    ed.commands.setTextSelection({ from: 1, to: 1 });
    ed.commands.toggleColumnBreak();
    assert.equal(ed.getHTML(), '<p data-col-break="">x</p>');
    ed.commands.toggleColumnBreak();
    assert.equal(ed.getHTML(), "<p>x</p>");
    ed.destroy();
});

test("toggleColumnBreak on a list item (not the paragraph inside it)", () => {
    const ed = makeEditor("<ul><li><p>x</p></li></ul>");
    ed.commands.setTextSelection({ from: 3, to: 3 });
    ed.commands.toggleColumnBreak();
    assert.equal(ed.getHTML(), '<ul><li data-col-break=""><p>x</p></li></ul>');
    ed.commands.toggleColumnBreak();
    assert.equal(ed.getHTML(), "<ul><li><p>x</p></li></ul>");
    ed.destroy();
});

/* ---------------- (iii) regression: no phantom trailing <p> ---------------- */

// StarterKit's `trailingNode` (on by default) appends an empty paragraph whenever the document doesn't
// already end in one — which, for a résumé whose last block is a bullet list (very common), added +35pt
// of blank page height on export. CvMaker.tsx sets `trailingNode: false` to prevent this; this test
// locks that in.
test("content ending in a bullet list gets no empty trailing <p>", () => {
    const ed = makeEditor("<p>a</p><ul><li><p>b</p></li></ul>");
    assert.equal(ed.getHTML(), "<p>a</p><ul><li><p>b</p></li></ul>");
    assert.equal(ed.state.doc.childCount, 2, "expected exactly the paragraph and the list — no appended node");
    // provoke a transaction the way a real edit would (an insert INSIDE the existing content, not
    // appended after the list — that would need to open its own wrapping paragraph regardless of
    // trailingNode, which would be testing ProseMirror's insertion rules, not this extension)
    ed.commands.insertContentAt(1, "!");
    assert.equal(ed.state.doc.childCount, 2, "an edit must not cause a trailing node to appear either");
    ed.destroy();
});

test("regression check: StarterKit's default trailingNode DOES append one (proves the guard above is meaningful)", () => {
    const ed = new Editor({
        extensions: [StarterKit.configure({ heading: false, codeBlock: false, code: false, blockquote: false })],
        content: "<p>a</p><ul><li><p>b</p></li></ul>",
        injectCSS: false,
    });
    // trailingNode is an `appendTransaction` plugin: it doesn't touch the doc built from initial
    // content, only what a subsequent transaction leaves behind — so provoke one the way a real edit
    // would (an in-place insert), then check what it left after.
    ed.commands.insertContentAt(ed.state.doc.content.size, " ");
    assert.equal(ed.state.doc.childCount, 3, "expected StarterKit's default trailingNode to add a 3rd node");
    assert.equal(ed.state.doc.lastChild?.type.name, "paragraph");
    assert.equal(ed.state.doc.lastChild?.textContent, " ");
    ed.destroy();
});
