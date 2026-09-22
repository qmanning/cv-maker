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

export function parseSource(text: string): Source & { name: string; regions: number } {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, link[rel='import']").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((el) => Array.from(el.attributes).forEach((a) => { if (/^on/i.test(a.name)) el.removeAttribute(a.name); }));
    const css = Array.from(doc.querySelectorAll("style")).map((s) => s.textContent || "").join("\n");
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
