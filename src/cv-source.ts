// src/components/labs/icedcoffee/cv-source.ts
// IcedCoffee's pure, DOM-parsing/string-building helpers — pulled out of CvMaker.tsx so they can be
// unit-tested without mounting the component. No React, no fetch, no localStorage: just source text in,
// source text out.

export interface Source { css: string; html: string }

export const PAPERS = { letter: { label: "8.5 × 11 in", name: "US Letter", w: 612, h: 792 }, a4: { label: "210 × 297 mm", name: "A4", w: 595, h: 842 } } as const;
export type PaperId = keyof typeof PAPERS;

export const GAP_PT = 24;              // space between sheets on the canvas (never exported)
export const FOOTER_PT = 30;           // bottom of each page reserved for the page number when paginating
export const PT = 96 / 72;             // CSS px per pt
export const MIN_FIT = 0.8;           // "fit to one page" never shrinks the design below 80%; past that it becomes pages

/* ---------------- source files ---------------- */

/** the scheme of a URL-ish attribute value, lowercased; "" when it is relative (no scheme at all).
 *  A browser strips tab, LF and CR from a URL and trims leading control characters BEFORE parsing it, so
 *  `java&#9;script:alert(1)` is `javascript:` as far as it is concerned. Normalise the same way first, or
 *  the "no scheme means relative, and relative is fine" branch below hands that straight through. */
const schemeOf = (value: string): string => {
    const url = value.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    return m ? m[1].toLowerCase() : "";
};
/** attributes a click or a load would NAVIGATE through: web links, mail, phone, in-page anchors and relative paths only */
const NAVIGABLE = new Set(["href", "action", "formaction", "ping", "background", "xlink:href"]);
const NAVIGABLE_OK = new Set(["", "http", "https", "mailto", "tel"]);
/** never, on any attribute — `<a href="javascript:…">` in an opened file would run in the app's own origin */
const ALWAYS_BAD = new Set(["javascript", "vbscript"]);

/* ---------------- scoping a document's own stylesheet ----------------
   A source file brings its own CSS and the editor puts it on the page, so the sheet looks like the file.
   Left alone that CSS is GLOBAL: `body { font: … }` restyles the toolbar, and `.pt-menu-item { display:
   none }` in someone else's résumé hides the menus. Nothing here can run code, but a document has no
   business styling the product around it. So for the editor's live preview every selector is rewritten to
   sit under the element that holds the sheet. What gets SAVED or EXPORTED is left alone — there the CSS is
   global on purpose, because the file has to stand on its own. */

const ROOT_TOKEN = /^(:root|html|body)(?![\w-])/i;
/** conditional group rules whose contents are themselves rules, so scoping has to go inside them */
const GROUP_AT_RULES = new Set(["media", "supports", "container", "layer", "scope", "document"]);

/** one selector (no commas) rewritten to live under `scope` */
function scopeOne(selector: string, scope: string): string {
    let rest = selector.trim(), wasRoot = false;
    for (;;) {                                   // `html body .cv-page` — collapse every leading root token
        const m = ROOT_TOKEN.exec(rest);
        if (!m) break;
        wasRoot = true;
        rest = rest.slice(m[0].length);
        const another = /^\s+(?=(:root|html|body)(?![\w-]))/i.exec(rest);
        if (!another) break;
        rest = rest.slice(another[0].length);
    }
    // the document's root IS the scope element: `body.dark` → `.cvm-host.dark`, `body > p` → `.cvm-host > p`
    return wasRoot ? scope + rest : scope + " " + rest;
}

const scopeSelectorList = (list: string, scope: string): string =>
    list.split(",").map((s) => s.trim()).filter(Boolean).map((s) => scopeOne(s, scope)).join(", ");

/** from the `{` at `open`, the block's contents and the index just past its `}` (strings and comments skipped) */
function readBlock(css: string, open: number): { body: string; end: number } {
    let depth = 0, i = open;
    while (i < css.length) {
        const ch = css[i];
        if (ch === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); i = e < 0 ? css.length : e + 2; continue; }
        if (ch === '"' || ch === "'") { let j = i + 1; while (j < css.length && css[j] !== ch) j += css[j] === "\\" ? 2 : 1; i = j + 1; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) return { body: css.slice(open + 1, i), end: i + 1 }; }
        i++;
    }
    return { body: css.slice(open + 1), end: css.length };   // unbalanced: take what there is
}

/** Rewrite `css` so it can only reach what is inside `scope`. The editor's live preview only.
 *  Hand-walked rather than handed to the CSSOM on purpose: this has to behave identically in the app and
 *  under test, and a real parser silently drops whatever syntax it happens not to know. */
export function scopeCss(css: string, scope = ".cvm-host"): string {
    if (!css.trim()) return "";
    const out: string[] = [];
    let prelude = "", i = 0;
    while (i < css.length) {
        const ch = css[i];
        if (ch === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); const seg = e < 0 ? css.slice(i) : css.slice(i, e + 2); prelude += seg; i += seg.length; continue; }
        if (ch === '"' || ch === "'") { let j = i + 1; while (j < css.length && css[j] !== ch) j += css[j] === "\\" ? 2 : 1; prelude += css.slice(i, j + 1); i = j + 1; continue; }
        if (ch === ";") {
            const statement = prelude.trim();
            // @import would come back unscoped — and off the network. The desktop app's CSP already refuses
            // it, so dropping it here only makes the browser behave the way the app does.
            if (statement && !/^@import\b/i.test(statement)) out.push(statement + ";");
            prelude = ""; i++; continue;
        }
        if (ch === "{") {
            const { body, end } = readBlock(css, i);
            i = end;
            const comments: string[] = [];
            const head = prelude.replace(/\/\*[\s\S]*?\*\//g, (m) => { comments.push(m); return " "; }).trim();
            prelude = "";
            if (comments.length) out.push(comments.join("\n"));
            if (head.startsWith("@")) {
                const name = (/^@([\w-]+)/.exec(head) || ["", ""])[1].toLowerCase();
                // @font-face, @keyframes, @page, @property … hold no selectors of ours to scope
                out.push(GROUP_AT_RULES.has(name) ? `${head} {\n${scopeCss(body, scope)}\n}` : `${head} {${body}}`);
            } else if (head) {
                // the body is emitted verbatim: under CSS nesting its own rules are already relative to this one
                out.push(`${scopeSelectorList(head, scope)} {${body}}`);
            }
            continue;
        }
        prelude += ch; i++;
    }
    return out.join("\n");
}

/* ---------------- migrations: fixes to CSS that IcedCoffee's own templates once shipped ----------------
   A document carries its own copy of the stylesheet, so a fix to templates/ only reaches NEW documents.
   Anything here runs on every document as it is read, so files saved before the fix pick it up too. */

/** `li + li { margin-top: … }` spaced list items by pushing each one down from the one above. Inside a
 *  .cv-flow the browser breaks that list across columns, and the item that lands at the top of column 2
 *  keeps its margin — so the columns stop lining up (most obvious after a manual break leaves one item
 *  alone up there, which reads as though it has been vertically centred). Carrying the same gap on
 *  margin-bottom is equivalent between items and immune to where the break falls. */
const LEGACY_LIST_GAP = /(^|[}\n])([^{}]*?)li\s*\+\s*li\s*\{\s*margin-top\s*:\s*([^;}]+?)\s*;?\s*\}/g;
export const migrateCss = (css: string): string =>
    css.replace(LEGACY_LIST_GAP, (_m, lead: string, prefix: string, value: string) => `${lead}${prefix}li:not(:last-child) { margin-bottom: ${value}; }`);

export function parseSource(text: string): Source & { name: string; regions: number } {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, link[rel='import']").forEach((n) => n.remove());
    // a source file is somebody else's HTML and this is the only gate before it is mounted in the LIVE page,
    // so strip anything that could execute: event handlers, and URL attributes carrying a script scheme.
    // `data:` stays allowed on src — the template's own images are data: URIs — but not where it would navigate.
    doc.querySelectorAll("*").forEach((el) => Array.from(el.attributes).forEach((a) => {
        if (/^on/i.test(a.name)) return el.removeAttribute(a.name);
        const scheme = schemeOf(a.value);
        if (ALWAYS_BAD.has(scheme)) return el.removeAttribute(a.name);
        if (NAVIGABLE.has(a.name.toLowerCase()) && !NAVIGABLE_OK.has(scheme)) el.removeAttribute(a.name);
    }));
    const css = migrateCss(Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n"));
    let page = doc.body.querySelector(".cv-page");
    if (!page) { page = doc.createElement("div"); page.className = "cv-page"; page.append(...Array.from(doc.body.childNodes)); }
    return { css, html: page.outerHTML, name: doc.title.trim(), regions: page.querySelectorAll("[data-cv-edit]").length };
}

/* ---------------- résumé + cover letter: two documents, one header ---------------- */

export type DocKind = "resume" | "letter";
/** a cover letter says so on its page (`data-cv-kind="letter"`) or carries a mirrored header; everything else is a résumé */
export const docKind = (pageHtml: string): DocKind => (/data-cv-kind="letter"|data-cv-mirror="header"/.test(pageHtml) ? "letter" : "resume");

const LETTER_MARK = "/* icedcoffee:letter";
const LETTER_MARK_LEGACY = "/* itera:letter";   // files written before the IcedCoffee rename still open
/** index of the letter marker (new or legacy), or -1 */
const letterMarkIndex = (css: string): number => { const i = css.indexOf(LETTER_MARK); return i >= 0 ? i : css.indexOf(LETTER_MARK_LEGACY); };
/** a letter file's CSS = a snapshot of the résumé's styles + (after the marker) the letter's own. This is the letter's own. */
export const letterOwnCss = (css: string): string => { const i = letterMarkIndex(css); return i < 0 ? css : css.slice(i); };
/** …and this puts the OPEN résumé's styles back in front, so the mirrored header always looks like the résumé's */
export const letterCss = (resumeCss: string, css: string): string => (letterMarkIndex(css) < 0 ? css : resumeCss.trimEnd() + "\n" + letterOwnCss(css));

/** the letter's header IS the résumé's header: copy it in (read-only — no editable regions), keeping the letter's body.
 *  The résumé's header is its `[data-cv-header]`, else the page's first <header>. No header on either side → unchanged. */
export function mirrorHeader(letterPageHtml: string, resumePageHtml: string): string {
    const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");   // inert: nothing loads or runs
    const letter = parse(letterPageHtml), slot = letter.querySelector('[data-cv-mirror="header"]');
    const from = parse(resumePageHtml), head = from.querySelector(".cv-page [data-cv-header]") || from.querySelector(".cv-page > header");
    if (!slot || !head) return letterPageHtml;
    const copy = letter.importNode(head, true) as Element;
    [copy, ...Array.from(copy.querySelectorAll("*"))].forEach((el) => ["data-cv-edit", "contenteditable", "translate", "tabindex", "spellcheck", "role", "aria-multiline", "aria-label", "data-cv-repeat"].forEach((a) => el.removeAttribute(a)));
    copy.querySelectorAll(".ProseMirror, .tiptap").forEach((el) => el.classList.remove("ProseMirror", "tiptap", "ProseMirror-focused"));
    copy.classList.remove("ProseMirror", "tiptap", "ProseMirror-focused");
    copy.setAttribute("data-cv-block", ""); copy.setAttribute("data-cv-mirror", "header");
    slot.replaceWith(copy);
    return letter.body.innerHTML;
}

// scale < 1 = "fit to one page": the content keeps its own width (so every line breaks where the
// design breaks it) and the page is zoomed as a whole; the side margins absorb the difference
export const pageBoxCss = (wPt: number, scale = 1) => `
.cv-page { width: ${(wPt / scale).toFixed(3)}pt; zoom: ${scale}; box-sizing: border-box; position: relative; margin: 0 auto;
  padding: var(--cv-pad-top, 16pt) calc((${(wPt / scale).toFixed(3)}pt - var(--cv-content-w, 562pt)) / 2) var(--cv-pad-bottom, 16pt); }
.cvm-pagebreak { break-before: page; height: var(--cv-pad-top, 16pt); }
.cvm-pageno { position: absolute; left: 0; right: 0; text-align: center; font: 7pt/1 Helvetica, Arial, sans-serif; color: #555; }`;

export const fullHtml = (name: string, css: string, body: string, extraCss = "") =>
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<title>${name.replace(/[<&]/g, "")}</title>\n<style>\n${css}\n</style>${extraCss ? `\n<style>${extraCss}</style>` : ""}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

// accents fold to their base letter first ("Résumé" → "resume", not "r-sum")
export const slugify = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "resume";

// ⌘+ / ⌘− walk this ladder from wherever the sheet is now (a live fit like 151% included); ⌘0 goes back to fit-width
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const stepZoom = (from: number, dir: 1 | -1): number => (dir > 0 ? ZOOM_STEPS.find((z) => z > from + 0.005) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] : [...ZOOM_STEPS].reverse().find((z) => z < from - 0.005) ?? ZOOM_STEPS[0]);
