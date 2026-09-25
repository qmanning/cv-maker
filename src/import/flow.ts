// src/import/flow.ts — the one shape every importer produces, and the one the structurer reads.
//
// Importing is two steps, both rules — no AI:
//   1. a CONVERTER reads one file format (docx, rtf, pdf, md, txt, foreign html) and writes a FlowDoc:
//      what the source looked like, as plain blocks and runs with real measurements (pt) and colours;
//   2. the STRUCTURER (structure.ts) reads the FlowDoc, works out what each piece IS (the name, the contact
//      line, a section heading, a job's title and dates, bullets) and builds an IcedCoffee Source HTML file:
//      editable regions, blocks pagination keeps together, and a stylesheet that reproduces the look.
// A converter never decides what a résumé means; the structurer never reads a file format.
//
// ---------------- the FlowDoc fragment ----------------
// `html` is a body fragment. Units are pt, colours #rrggbb, images data: URIs. Only what is listed here.
//
// TOP LEVEL — a sequence of blocks, in reading order:
//   <p>, <h1>…<h6>          a paragraph / heading
//   <ul>, <ol>               a list; <li> holds inline content directly (a nested <ul>/<ol> may follow it)
//   <table>                  <tr> / <td> / <th> (colspan, rowspan); a cell holds blocks
//   <hr>                     a horizontal rule; style may carry border-top (e.g. "1pt solid #000000")
//   <figure>                 one image on its own line: <figure style="text-align:…"><img …></figure>
//   <div data-flow-cols>     side-by-side columns: children are <div data-flow-col style="width: Npt"> holding blocks
//   <div data-flow-abs>      something positioned on the page, not in the flow (a floating logo, a text box):
//                            style="top: Npt; left: Npt; width: Npt[; height: Npt]" from the PAGE's top-left
//                            corner, data-flow-page="N" (0-based, default 0); holds blocks
//
// BLOCK STYLE (the style attribute of p, h*, li, ul, ol, td, figure) — only these properties:
//   text-align, margin-top, margin-bottom, margin-left, margin-right, text-indent, line-height (unitless
//   multiple, or pt), font-family, font-size, color, font-weight, font-style, text-transform, letter-spacing,
//   background-color, border-top, border-bottom, padding-top, padding-bottom, list-style-type (ul/ol),
//   width / vertical-align / padding / border-* (td)
//
// INLINE — text, <strong>, <em>, <u>, <s>, <a href>, <br>, <sup>, <sub>,
//   <span style> with: color, font-size, font-weight, font-style, font-family, letter-spacing,
//   text-transform, background-color;
//   <img src="data:…" style="width: Npt; height: Npt"> (an inline picture);
//   <span data-flow-tab="left|right|center|decimal|" data-flow-pos="N"></span> — a TAB character, with the
//     tab stop it jumps to when known (pos in pt from the left margin). "Title<tab→right 540>2019 – 2023"
//     is how a Word résumé puts dates on the right; the structurer splits it into two regions on one row.
//
// Nothing else: no classes, no ids, no scripts, no other attributes. The structurer drops what it does not know.

export interface FlowPage {
    widthPt?: number; heightPt?: number;
    marginTopPt?: number; marginBottomPt?: number; marginLeftPt?: number; marginRightPt?: number;
}

export interface FlowResult {
    /** the FlowDoc fragment (see above) */
    html: string;
    /** the document's own title, when it has one (docx core properties, <title>, PDF info) */
    title?: string;
    /** paper and margins of the source, when known */
    page?: FlowPage;
    /** the document default run/paragraph style (docx docDefaults + Normal, the body font of an HTML page) */
    base?: { fontFamily?: string; fontSizePt?: number; color?: string; lineHeight?: number };
    /** plain sentences for the person: what could not come across exactly ("2 text boxes were placed in the flow") */
    warnings: string[];
    /** set when rules alone could not do the job and an AI could (e.g. a scanned PDF with no text layer): why */
    needsAi?: string;
}

export type ImportFormat = "html" | "docx" | "rtf" | "pdf" | "md" | "txt";

/** the extensions the importer accepts, and which converter reads each */
export const IMPORT_EXTENSIONS: Record<string, ImportFormat> = {
    html: "html", htm: "html", xhtml: "html",
    docx: "docx", docm: "docx", dotx: "docx",
    rtf: "rtf",
    pdf: "pdf",
    md: "md", markdown: "md", mdown: "md", mkd: "md",
    txt: "txt", text: "txt",
};

export const formatOf = (fileName: string): ImportFormat | null => {
    const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
    return m ? IMPORT_EXTENSIONS[m[1].toLowerCase()] ?? null : null;
};

/* ---------------- small helpers every converter shares ---------------- */

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escAttr = (s: string): string => esc(s).replace(/"/g, "&quot;");

/** a number in pt, trimmed to 2 decimals: 12 → "12pt", 10.504 → "10.5pt" */
export const pt = (n: number): string => `${Math.round(n * 100) / 100}pt`;

/** `{ "font-size": "11pt", color: "" }` → `font-size: 11pt` (empty / null values skipped) */
export const styleAttr = (props: Record<string, string | number | null | undefined>): string =>
    Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${v}`).join("; ");

/** "rgb(12, 34, 56)", "#abc", "abc", "0C2238" → "#0c2238"; anything else → "" */
export function hexColor(value: string | null | undefined): string {
    const v = String(value || "").trim().toLowerCase();
    if (!v || v === "auto" || v === "transparent") return "";
    let m = /^#?([0-9a-f]{6})$/.exec(v); if (m) return "#" + m[1];
    m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v); if (m) return "#" + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(v);
    if (m) { if (m[4] !== undefined && Number(m[4]) === 0) return ""; return "#" + [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join(""); }
    return "";
}

/** bytes → a data: URI */
export function dataUri(bytes: Uint8Array, mime: string): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(bin)}`;
}

/** sniff an image's type from its first bytes (for formats that do not say) */
export function imageMime(bytes: Uint8Array, fallback = "application/octet-stream"): string {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
    if (bytes[0] === 0x3c) return "image/svg+xml";
    return fallback;
}
