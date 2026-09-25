// src/import/docx.ts — the Word (.docx) converter: OOXML → FlowDoc (see flow.ts), by rules alone.
//
// Word stores formatting as a cascade: document defaults → table style → paragraph style (and its basedOn chain) →
// numbering level → direct paragraph formatting; a run adds its character style and direct run formatting on top.
// We resolve that cascade to concrete values for every paragraph and run, then describe what the page LOOKS like:
// each block carries its resolved font / size / colour / spacing, each run only what differs from its block.
// Positions of floating things (text boxes, anchored pictures) are resolved to the page's top-left corner.

import JSZip from "jszip";
import { dataUri, esc, escAttr, hexColor, imageMime, pt, styleAttr, type FlowPage, type FlowResult } from "./flow";

/* ---------------- XML plumbing ---------------- */

// Namespaces by URI, so a file that uses unusual prefixes (or Strict OOXML's purl.oclc.org URIs) still reads.
const NS: Record<string, string> = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
    "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
    "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
    "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
    "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
    "http://purl.oclc.org/ooxml/drawingml/main": "a",
    "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
    "http://purl.oclc.org/ooxml/drawingml/picture": "pic",
    "http://schemas.microsoft.com/office/word/2010/wordprocessingShape": "wps",
    "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup": "wpg",
    "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
    "urn:schemas-microsoft-com:vml": "v",
    "http://schemas.openxmlformats.org/officeDocument/2006/math": "m",
    "http://purl.oclc.org/ooxml/officeDocument/math": "m",
    "http://purl.org/dc/elements/1.1/": "dc",
};

type El = Element | null | undefined;
const nameOf = (el: Element): string => `${NS[el.namespaceURI ?? ""] ?? "?"}:${el.localName}`;
function kids(el: El, name?: string): Element[] {
    const out: Element[] = [];
    for (let c = el ? el.firstElementChild : null; c; c = c.nextElementSibling) if (!name || nameOf(c) === name) out.push(c);
    return out;
}
function kid(el: El, name: string): Element | null {
    for (let c = el ? el.firstElementChild : null; c; c = c.nextElementSibling) if (nameOf(c) === name) return c;
    return null;
}
/** descendants with this prefixed name, in document order */
function findAll(el: El, name: string): Element[] {
    if (!el) return [];
    const local = name.slice(name.indexOf(":") + 1);
    return Array.from(el.getElementsByTagNameNS("*", local)).filter((d) => nameOf(d) === name);
}
const find = (el: El, name: string): Element | null => findAll(el, name)[0] ?? null;
function at(el: El, name: string): string | null {
    if (!el) return null;
    const i = name.indexOf(":"), p = i < 0 ? "" : name.slice(0, i), l = name.slice(i + 1);
    for (const a of Array.from(el.attributes)) if (a.localName === l && (a.namespaceURI ? NS[a.namespaceURI] ?? "?" : "") === p) return a.value;
    return null;
}
const val = (el: El): string | null => at(el, "w:val");

const num = (v: string | null | undefined): number | null => {
    if (v == null || v === "") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
};
/** a twips measure (Strict files may give a unit instead) → pt */
function twip(v: string | null | undefined): number | null {
    if (v == null) return null;
    const m = /^(-?[\d.]+)(pt|in|cm|mm|pc|pi)?$/.exec(v.trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    switch (m[2]) {
        case "pt": return n;
        case "in": return n * 72;
        case "cm": return (n * 72) / 2.54;
        case "mm": return (n * 72) / 25.4;
        case "pc": case "pi": return n * 12;
        default: return n / 20;
    }
}
const emu = (v: string | null | undefined): number | null => { const n = num(v); return n == null ? null : n / 12700; };
/** a toggle element: present → on, unless w:val says 0/false/off/none */
const on = (el: El): boolean | undefined => (el ? !/^(0|false|off|none)$/i.test(val(el) ?? "") : undefined);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/* ---------------- properties ---------------- */

interface Theme { major?: string; minor?: string; colors: Record<string, string> }
interface RunP {
    font?: string; size?: number; color?: string; b?: boolean; i?: boolean; u?: boolean; strike?: boolean;
    caps?: boolean; smallCaps?: boolean; spacing?: number; vert?: string; bg?: string; hidden?: boolean;
}
type Run = Required<RunP>;
interface Tab { pos: number; val: string }
interface ParaP {
    pStyle?: string; jc?: string; before?: number; after?: number; beforeLines?: number; afterLines?: number;
    beforeAuto?: boolean; afterAuto?: boolean; line?: number; lineRule?: string;
    left?: number; right?: number; firstLine?: number; hanging?: number;
    bTop?: string; bBottom?: string; padTop?: number; padBottom?: number; bg?: string; tabs?: Tab[];
    outline?: number; numId?: string; ilvl?: number; contextual?: boolean; breakBefore?: boolean;
}

function merge<T extends object>(a: T, b: Partial<T>): T {
    const out = { ...a } as Record<string, unknown>;
    for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = v;
    return out as T;
}
function mergeP(a: ParaP, b: Partial<ParaP>): ParaP {
    const out = merge(a, b);
    // firstLine and hanging are one setting in Word: whichever the later layer gives wins
    if (b.firstLine !== undefined && b.hanging === undefined) delete out.hanging;
    if (b.hanging !== undefined && b.firstLine === undefined) delete out.firstLine;
    if (b.tabs) { // tab stops accumulate down the cascade; a "clear" stop removes an inherited one
        const m = new Map((a.tabs ?? []).map((t) => [t.pos, t]));
        for (const t of b.tabs) if (t.val === "clear") m.delete(t.pos); else m.set(t.pos, t);
        out.tabs = [...m.values()].sort((x, y) => x.pos - y.pos);
    }
    return out;
}

const THEME_KEY: Record<string, string> = {
    text1: "dk1", background1: "lt1", text2: "dk2", background2: "lt2", dark1: "dk1", light1: "lt1", dark2: "dk2", light2: "lt2",
    hyperlink: "hlink", followedHyperlink: "folHlink",
};
const themeColor = (th: Theme, name: string | null) => (name ? th.colors[THEME_KEY[name] ?? name] ?? "" : "");
const HIGHLIGHT: Record<string, string> = {
    yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000",
    darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
    darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff",
};
function shade(el: El, th: Theme): string | undefined {
    if (!el) return undefined;
    // "solid" paints the pattern colour over everything; otherwise the fill shows
    return (val(el) === "solid" ? hexColor(at(el, "w:color")) : hexColor(at(el, "w:fill")) || themeColor(th, at(el, "w:themeFill"))) || "";
}

function readRPr(rPr: El, th: Theme): Partial<RunP> {
    const r: Partial<RunP> = {};
    if (!rPr) return r;
    const f = kid(rPr, "w:rFonts");
    if (f) {
        // a theme font reference wins over the literal name next to it (Word keeps the literal only as a cache)
        const t = at(f, "w:asciiTheme") ?? at(f, "w:hAnsiTheme");
        const font = (t && (t.startsWith("major") ? th.major : th.minor)) || at(f, "w:ascii") || at(f, "w:hAnsi") || at(f, "w:cs") || at(f, "w:eastAsia");
        if (font) r.font = font;
    }
    const sz = num(val(kid(rPr, "w:sz")));
    if (sz != null) r.size = sz / 2;
    const c = kid(rPr, "w:color");
    if (c) r.color = hexColor(val(c)) || themeColor(th, at(c, "w:themeColor")) || "#000000";
    r.b = on(kid(rPr, "w:b"));
    r.i = on(kid(rPr, "w:i"));
    r.u = on(kid(rPr, "w:u"));
    r.strike = on(kid(rPr, "w:strike") ?? kid(rPr, "w:dstrike"));
    r.caps = on(kid(rPr, "w:caps"));
    r.smallCaps = on(kid(rPr, "w:smallCaps"));
    r.hidden = on(kid(rPr, "w:vanish"));
    const sp = twip(val(kid(rPr, "w:spacing")));
    if (sp != null) r.spacing = sp;
    const va = val(kid(rPr, "w:vertAlign"));
    if (va) r.vert = va === "superscript" ? "super" : va === "subscript" ? "sub" : "";
    const hl = kid(rPr, "w:highlight"), sh = kid(rPr, "w:shd");
    if (hl) r.bg = HIGHLIGHT[val(hl) ?? ""] ?? "";
    else if (sh) r.bg = shade(sh, th);
    return r;
}
const normRun = (r: RunP): Run => ({
    font: r.font || "Times New Roman", size: r.size ?? 10, color: r.color || "#000000",
    b: !!r.b, i: !!r.i, u: !!r.u, strike: !!r.strike, caps: !!r.caps, smallCaps: !!r.smallCaps,
    spacing: r.spacing ?? 0, vert: r.vert ?? "", bg: r.bg ?? "", hidden: !!r.hidden,
});

/** a paragraph or cell border → CSS ("none" when switched off) and its spacing from the text (pt) */
function border(b: El, th: Theme): { css: string; space: number } | undefined {
    if (!b) return undefined;
    const v = val(b) ?? "single";
    if (/^(nil|none)$/.test(v)) return { css: "none", space: 0 };
    const w = Math.max(0.25, (num(at(b, "w:sz")) ?? 4) / 8); // eighths of a point
    const style = /double/i.test(v) ? "double" : /dot/i.test(v) ? "dotted" : /dash/i.test(v) ? "dashed" : "solid";
    const color = hexColor(at(b, "w:color")) || themeColor(th, at(b, "w:themeColor")) || "#000000";
    return { css: `${pt(w)} ${style} ${color}`, space: num(at(b, "w:space")) ?? 0 };
}

function readPPr(pPr: El, th: Theme): Partial<ParaP> {
    const p: Partial<ParaP> = {};
    if (!pPr) return p;
    p.pStyle = val(kid(pPr, "w:pStyle")) ?? undefined;
    const jc = val(kid(pPr, "w:jc"));
    if (jc) p.jc = jc === "both" || jc === "distribute" ? "justify" : jc === "end" ? "right" : jc === "start" ? "left" : jc;
    const s = kid(pPr, "w:spacing");
    if (s) {
        p.before = twip(at(s, "w:before")) ?? undefined;
        p.after = twip(at(s, "w:after")) ?? undefined;
        p.beforeLines = num(at(s, "w:beforeLines")) ?? undefined;
        p.afterLines = num(at(s, "w:afterLines")) ?? undefined;
        const ba = at(s, "w:beforeAutospacing"), aa = at(s, "w:afterAutospacing");
        if (ba != null) p.beforeAuto = /^(1|true|on)$/.test(ba);
        if (aa != null) p.afterAuto = /^(1|true|on)$/.test(aa);
        p.line = num(at(s, "w:line")) ?? undefined;
        if (p.line !== undefined) p.lineRule = at(s, "w:lineRule") ?? "auto";
    }
    const ind = kid(pPr, "w:ind");
    if (ind) {
        p.left = twip(at(ind, "w:left") ?? at(ind, "w:start")) ?? undefined;
        p.right = twip(at(ind, "w:right") ?? at(ind, "w:end")) ?? undefined;
        p.firstLine = twip(at(ind, "w:firstLine") ?? at(ind, "w:first-line")) ?? undefined; // first-line: older writers (macOS textutil)
        p.hanging = twip(at(ind, "w:hanging")) ?? undefined;
        if (p.firstLine != null && p.firstLine < 0) { p.hanging = -p.firstLine; p.firstLine = undefined; }
    }
    const bdr = kid(pPr, "w:pBdr");
    if (bdr) {
        const t = border(kid(bdr, "w:top"), th), b = border(kid(bdr, "w:bottom"), th);
        if (t) { p.bTop = t.css; p.padTop = t.space; }
        if (b) { p.bBottom = b.css; p.padBottom = b.space; }
    }
    const sh = kid(pPr, "w:shd");
    if (sh) p.bg = shade(sh, th);
    const tabs = kids(kid(pPr, "w:tabs"), "w:tab");
    if (tabs.length) {
        p.tabs = [];
        for (const t of tabs) {
            const v = val(t) ?? "left", pos = twip(at(t, "w:pos"));
            if (pos == null || v === "bar") continue; // a bar tab draws a line; it is not a stop
            p.tabs.push({ pos, val: v === "start" || v === "num" ? "left" : v === "end" ? "right" : v });
        }
    }
    const ol = num(val(kid(pPr, "w:outlineLvl")));
    if (ol != null) p.outline = ol;
    const np = kid(pPr, "w:numPr");
    if (np) {
        p.numId = val(kid(np, "w:numId")) ?? undefined;
        p.ilvl = num(val(kid(np, "w:ilvl"))) ?? undefined;
    }
    p.contextual = on(kid(pPr, "w:contextualSpacing"));
    p.breakBefore = on(kid(pPr, "w:pageBreakBefore"));
    return p;
}

/* ---------------- parts: theme, styles, numbering, section geometry ---------------- */

function readTheme(root: El): Theme {
    const th: Theme = { colors: {} };
    if (!root) return th;
    th.major = at(kid(find(root, "a:majorFont"), "a:latin"), "typeface") || undefined;
    th.minor = at(kid(find(root, "a:minorFont"), "a:latin"), "typeface") || undefined;
    for (const c of kids(find(root, "a:clrScheme"))) {
        const v = kid(c, "a:srgbClr"), s = kid(c, "a:sysClr");
        const hex = hexColor(v ? at(v, "val") : at(s, "lastClr"));
        if (hex) th.colors[c.localName] = hex;
    }
    return th;
}

interface StyleDef { type: string; name: string; basedOn?: string; p: Partial<ParaP>; r: Partial<RunP>; tblPr: Element | null }
interface Styles { defs: Map<string, StyleDef>; defaultP?: string; defaultT?: string; docP: ParaP; docR: RunP }

function readStyles(root: El, th: Theme): Styles {
    const st: Styles = { defs: new Map(), docP: {}, docR: {} };
    if (!root) return st;
    const dd = kid(root, "w:docDefaults");
    st.docR = readRPr(kid(kid(dd, "w:rPrDefault"), "w:rPr"), th);
    st.docP = mergeP({}, readPPr(kid(kid(dd, "w:pPrDefault"), "w:pPr"), th));
    for (const s of kids(root, "w:style")) {
        const id = at(s, "w:styleId"), type = at(s, "w:type") ?? "paragraph";
        if (!id) continue;
        st.defs.set(id, {
            type, name: val(kid(s, "w:name")) ?? id, basedOn: val(kid(s, "w:basedOn")) ?? undefined,
            p: readPPr(kid(s, "w:pPr"), th), r: readRPr(kid(s, "w:rPr"), th), tblPr: kid(s, "w:tblPr"),
        });
        if (/^(1|true|on)$/.test(at(s, "w:default") ?? "")) {
            if (type === "paragraph") st.defaultP = id;
            if (type === "table") st.defaultT = id;
        }
    }
    return st;
}
/** a style and its basedOn ancestors, root first */
function chain(st: Styles, id: string | undefined): StyleDef[] {
    const out: StyleDef[] = [], seen = new Set<string>();
    for (let cur = id; cur && !seen.has(cur); ) {
        seen.add(cur);
        const d = st.defs.get(cur);
        if (!d) break;
        out.unshift(d);
        cur = d.basedOn;
    }
    return out;
}

interface Lvl { fmt: string; text: string; font: string; p: Partial<ParaP> }
function readLvl(l: Element, th: Theme): Lvl {
    return {
        fmt: val(kid(l, "w:numFmt")) ?? "decimal", text: val(kid(l, "w:lvlText")) ?? "",
        font: at(kid(kid(l, "w:rPr"), "w:rFonts"), "w:ascii") ?? "", p: readPPr(kid(l, "w:pPr"), th),
    };
}
function readNumbering(root: El, th: Theme, st: Styles): Map<string, Map<number, Lvl>> {
    const out = new Map<string, Map<number, Lvl>>();
    if (!root) return out;
    const abs = new Map<string, Element>();
    for (const a of kids(root, "w:abstractNum")) abs.set(at(a, "w:abstractNumId") ?? "", a);
    const nums = new Map<string, Element>();
    for (const n of kids(root, "w:num")) nums.set(at(n, "w:numId") ?? "", n);
    const levels = (numId: string, depth = 0): Map<number, Lvl> => {
        const n = nums.get(numId), m = new Map<number, Lvl>();
        let a = abs.get(val(kid(n, "w:abstractNumId")) ?? "");
        // an abstractNum may only point at a numbering STYLE, whose numPr points at the real list
        const link = val(kid(a, "w:numStyleLink"));
        if (a && link && depth < 3) {
            const id = chain(st, link).map((d) => d.p.numId).filter(Boolean).pop();
            if (id) for (const [k, v] of levels(id, depth + 1)) m.set(k, v);
            a = undefined;
        }
        for (const l of kids(a, "w:lvl")) m.set(num(at(l, "w:ilvl")) ?? 0, readLvl(l, th));
        for (const o of kids(n, "w:lvlOverride")) {
            const l = kid(o, "w:lvl");
            if (l) m.set(num(at(o, "w:ilvl")) ?? 0, readLvl(l, th));
        }
        return m;
    };
    for (const id of nums.keys()) out.set(id, levels(id));
    return out;
}

/** a bullet level's glyph → the CSS marker nearest to it */
function bulletType(l: Lvl): string {
    let t = l.text;
    if (!t) return "none";
    const c = t.charCodeAt(0) >= 0xf000 ? t.charCodeAt(0) - 0xf000 : -1;
    if (c >= 0) t = /wingdings/i.test(l.font) ? ({ 0xa7: "▪", 0x6e: "■", 0x71: "▪", 0xa8: "◻", 0x6f: "◦" } as Record<number, string>)[c] ?? "•" : "•";
    if (/^[o◦○❍]$/.test(t)) return "circle";
    if (/^[▪■□◻▫§]$/.test(t)) return "square";
    return "disc";
}
const OL_TYPE: Record<string, string> = {
    decimal: "decimal", decimalZero: "decimal-leading-zero", lowerLetter: "lower-alpha", upperLetter: "upper-alpha",
    lowerRoman: "lower-roman", upperRoman: "upper-roman", none: "none",
};

interface Geo {
    w: number; h: number; mt: number; mb: number; ml: number; mr: number; header: number; type: string;
    cols: number; colSpace: number; colW: number[]; titlePg: boolean; headers: Map<string, string>; footers: string[];
}
function readGeo(s: El): Geo {
    const sz = kid(s, "w:pgSz"), mar = kid(s, "w:pgMar"), cols = kid(s, "w:cols");
    const g: Geo = {
        w: twip(at(sz, "w:w")) ?? 612, h: twip(at(sz, "w:h")) ?? 792,
        // a negative top/bottom margin means "exactly this, even if the header is taller": the size still holds
        mt: Math.abs(twip(at(mar, "w:top")) ?? 72), mb: Math.abs(twip(at(mar, "w:bottom")) ?? 72),
        ml: twip(at(mar, "w:left")) ?? 72, mr: twip(at(mar, "w:right")) ?? 72, header: twip(at(mar, "w:header")) ?? 36,
        type: val(kid(s, "w:type")) ?? "nextPage",
        cols: num(at(cols, "w:num")) ?? 1, colSpace: twip(at(cols, "w:space")) ?? 36,
        colW: kids(cols, "w:col").map((c) => twip(at(c, "w:w")) ?? 0),
        titlePg: !!on(kid(s, "w:titlePg")), headers: new Map(), footers: [],
    };
    for (const h of kids(s, "w:headerReference")) g.headers.set(at(h, "w:type") ?? "default", at(h, "r:id") ?? "");
    for (const f of kids(s, "w:footerReference")) g.footers.push(at(f, "r:id") ?? "");
    return g;
}

/* ---------------- small text helpers ---------------- */

const fam = (f: string) => (/^[A-Za-z0-9-]+$/.test(f) ? f : `'${f.replace(/'/g, "")}'`);
// HTML collapses runs of spaces; alternate plain and non-breaking spaces so Word's spacing survives
const spaces = (html: string) => html.replace(/ {2,}/g, (m) => Array.from(m, (_, k) => (k % 2 ? "&nbsp;" : " ")).join(""));
function safeHref(u: string | null | undefined): string | undefined {
    const t = (u ?? "").trim();
    if (/^(https?:|mailto:|tel:)/i.test(t)) return t;
    if (/^www\./i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return "https://" + t;
    return undefined;
}
function fieldHref(instr: string | null | undefined): string | undefined {
    const m = /^\s*HYPERLINK\s+(?:"([^"]*)"|(\S+))/i.exec(instr ?? "");
    if (!m) return undefined;
    return m[2]?.startsWith("\\") ? undefined : safeHref(m[1] ?? m[2]); // HYPERLINK \l "bookmark" stays inside the document
}
// Symbol / Wingdings characters, as used for bullets and contact-line icons; anything else in them reads as a bullet
const WINGDINGS: Record<number, string> = { 0x6c: "●", 0x6e: "■", 0x71: "❑", 0x76: "❖", 0xa7: "▪", 0xa8: "◻", 0xd8: "➢", 0xfc: "✓", 0xfb: "✗", 0x28: "☎", 0x2a: "✉", 0x9f: "•" };
const SYMBOL: Record<number, string> = { 0xb7: "•", 0xd7: "×", 0xae: "→", 0xb0: "°", 0xb1: "±", 0x2d: "−", 0xa5: "∞" };
function symChar(c: Element): string {
    let code = parseInt(at(c, "w:char") ?? "", 16);
    if (!Number.isFinite(code)) return "";
    if (code >= 0xf000) code -= 0xf000;
    const font = at(c, "w:font") ?? "";
    if (/wingdings/i.test(font)) return WINGDINGS[code] ?? "•";
    if (/symbol/i.test(font)) return SYMBOL[code] ?? "•";
    return String.fromCharCode(code);
}
function resolvePath(base: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    const parts = (base ? base.split("/") : []).concat(target.split("/")), out: string[] = [];
    for (const p of parts) if (p === "..") out.pop(); else if (p && p !== ".") out.push(p);
    return out.join("/");
}
const IMG_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

/* ---------------- the converter ---------------- */

interface Rel { target: string; external: boolean; type: string }
/** where content is being written: its part's relationships, the table style around it, and its text width */
interface Ctx { rels: Map<string, Rel>; tblStyle?: string; top: boolean; width: number; h: number; origin: number }
interface ListInfo { numId: string; ilvl: number; tag: "ul" | "ol"; type: string; left: number }
interface PBlock { kind: "p"; tag: string; style: Record<string, string>; inner: string; styleId: string; contextual: boolean; list?: ListInfo; weight: number }
type Block = PBlock | { kind: "html"; html: string; weight: number; abs?: boolean } | { kind: "colbreak" };
interface Seg { html: string; r: Run; href?: string; chars: number; img?: boolean; tab?: boolean; raw?: string }
interface Field { instr: string; result: boolean; href?: string }

export async function docxToFlow(data: ArrayBuffer, name: string): Promise<FlowResult> {
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(data); } catch { throw new Error(`"${name}" isn't a Word document IcedCoffee can open.`); }
    const xml = async (path: string): Promise<Element | null> => {
        const f = zip.file(path);
        if (!f) return null;
        const doc = new DOMParser().parseFromString(await f.async("string"), "application/xml");
        return doc.getElementsByTagName("parsererror").length ? null : doc.documentElement;
    };
    const readRels = async (part: string): Promise<Map<string, Rel>> => {
        const i = part.lastIndexOf("/"), dir = part.slice(0, i + 1);
        const root = await xml(`${dir}_rels/${part.slice(i + 1)}.rels`), m = new Map<string, Rel>();
        for (const r of Array.from(root?.getElementsByTagNameNS("*", "Relationship") ?? [])) {
            const external = at(r, "TargetMode") === "External", target = at(r, "Target") ?? "";
            m.set(at(r, "Id") ?? "", { external, type: at(r, "Type") ?? "", target: external ? target : resolvePath(dir.replace(/\/$/, ""), target) });
        }
        return m;
    };

    // the main part is named by the package relationships (almost always word/document.xml)
    const pkg = await readRels(""); // → _rels/.rels
    const mainPath = [...pkg.values()].find((r) => /\/officeDocument$/.test(r.type))?.target ?? "word/document.xml";
    const docRoot = await xml(mainPath);
    const body = kid(docRoot, "w:body");
    if (!body) throw new Error(`"${name}" isn't a Word document IcedCoffee can open.`);
    const docRels = await readRels(mainPath);
    const partOf = (type: string, fallback: string) => [...docRels.values()].find((r) => !r.external && r.type.endsWith("/" + type))?.target ?? fallback;
    const th = readTheme(await xml(partOf("theme", "word/theme/theme1.xml")));
    const st = readStyles(await xml(partOf("styles", "word/styles.xml")), th);
    const numbering = readNumbering(await xml(partOf("numbering", "word/numbering.xml")), th, st);
    const settings = await xml(partOf("settings", "word/settings.xml"));
    const defTab = twip(val(kid(settings, "w:defaultTabStop"))) || 36;
    const core = await xml("docProps/core.xml");
    const title = find(core, "dc:title")?.textContent?.trim() || undefined;

    // every picture the document can reference, read up front so the walk below stays synchronous
    const media = new Map<string, Uint8Array>();
    await Promise.all(zip.file(/^word\/.+/).filter((f) => !/\.(xml|rels)$/i.test(f.name)).map(async (f) => media.set(f.name, await f.async("uint8array"))));

    // ---- style resolution (memoised: résumés reuse a handful of styles hundreds of times) ----
    const pMemo = new Map<string, { p: ParaP; r: RunP }>();
    const styleProps = (id: string | undefined): { p: ParaP; r: RunP } => {
        const key = id ?? "";
        let v = pMemo.get(key);
        if (!v) {
            v = { p: {}, r: {} };
            for (const d of chain(st, id)) { v.p = mergeP(v.p, d.p); v.r = merge(v.r, d.r); }
            pMemo.set(key, v);
        }
        return v;
    };
    interface Para { p: ParaP; r: RunP; styleId: string; heading: number; list?: ListInfo }
    const resolvePara = (pPr: El, tblStyle?: string): Para => {
        const direct = readPPr(pPr, th);
        const sid = direct.pStyle && st.defs.has(direct.pStyle) ? direct.pStyle : st.defaultP ?? "";
        const s = styleProps(sid), t = tblStyle ? styleProps(tblStyle) : { p: {}, r: {} };
        let p = mergeP(mergeP(st.docP, t.p), s.p);
        const numId = direct.numId ?? s.p.numId, ilvl = direct.ilvl ?? (direct.numId ? 0 : s.p.ilvl ?? 0);
        const lvl = numId && numId !== "0" ? numbering.get(numId)?.get(ilvl) : undefined;
        if (lvl) p = mergeP(p, lvl.p); // numbering indents sit between the style and direct formatting
        p = mergeP(p, direct);
        const r = merge(merge(st.docR, t.r), s.r);
        const named = /^heading\s*([1-6])$/i.exec(st.defs.get(sid)?.name ?? "");
        const heading = named ? Number(named[1]) : p.outline != null && p.outline >= 0 && p.outline <= 5 ? p.outline + 1 : 0;
        let list: ListInfo | undefined;
        if (lvl && numId) {
            const bullet = lvl.fmt === "bullet" || lvl.fmt === "none";
            list = {
                numId, ilvl, tag: bullet ? "ul" : "ol", type: lvl.fmt === "bullet" ? bulletType(lvl) : OL_TYPE[lvl.fmt] ?? "decimal",
                left: p.left ?? 36 * (ilvl + 1),
            };
        }
        return { p, r, styleId: sid, heading, list };
    };
    const runProps = (rPr: El, base: RunP): Run => {
        const rs = val(kid(rPr, "w:rStyle"));
        let r = base;
        if (rs) for (const d of chain(st, rs)) r = merge(r, d.r);
        return normRun(merge(r, readRPr(rPr, th)));
    };

    // ---- layout state ----
    const sectPrs = findAll(body, "w:sectPr").filter((s) => { const pn = s.parentElement ? nameOf(s.parentElement) : ""; return pn === "w:pPr" || pn === "w:body"; });
    const geos = sectPrs.length ? sectPrs.map(readGeo) : [readGeo(null)];
    let geo = geos[0];
    const textW = () => geo.w - geo.ml - geo.mr;
    // a rough place on the page (pt below the top margin, and page index) — only for things anchored to a paragraph
    const cursor = { page: 0, y: 0 };
    const rendered = findAll(body, "w:lastRenderedPageBreak").length > 0; // Word's own record of where pages broke
    let pageBreakPending = false;
    const newPage = () => { cursor.page++; cursor.y = 0; };
    const absOut: string[] = [];
    const fields: Field[] = [];
    const warn = { fmt: new Map<string, number>(), linked: 0, charts: 0, objects: 0, shapes: 0, boxFill: 0, approx: 0, colsGuess: false };

    const image = (id: string | null, w: number, h: number, rels: Map<string, Rel>): string => {
        const rel = id ? rels.get(id) : undefined;
        if (!rel) return "";
        if (rel.external) { warn.linked++; return ""; }
        const bytes = media.get(rel.target);
        if (!bytes) return "";
        const ext = (rel.target.split(".").pop() ?? "").toLowerCase();
        const mime = imageMime(bytes, "") || IMG_EXT[ext] || "";
        if (!mime) { const f = ext.toUpperCase() || "unknown"; warn.fmt.set(f, (warn.fmt.get(f) ?? 0) + 1); return ""; }
        return `<img src="${escAttr(dataUri(bytes, mime))}" style="${escAttr(styleAttr({ width: pt(w), height: pt(h) }))}">`;
    };

    /** a floating object's top-left on the page, from Word's "relative to" rules */
    const place = (hRel: string, hOff: number | null, hAlign: string | null, vRel: string, vOff: number | null, vAlign: string | null, w: number, h: number, ctx: Ctx) => {
        let approx = false, hb: number, ha: number, vb: number, va: number;
        switch (hRel) {
            case "page": hb = 0; ha = geo.w; break;
            case "leftMargin": case "insideMargin": hb = 0; ha = geo.ml; break;
            case "rightMargin": case "outsideMargin": hb = geo.w - geo.mr; ha = geo.mr; break;
            case "character": approx = true; hb = geo.ml; ha = textW(); break;
            default: hb = geo.ml; ha = textW(); // margin, column
        }
        switch (vRel) {
            case "page": vb = 0; va = geo.h; break;
            case "margin": vb = geo.mt; va = geo.h - geo.mt - geo.mb; break;
            case "topMargin": case "insideMargin": vb = 0; va = geo.mt; break;
            case "bottomMargin": case "outsideMargin": vb = geo.h - geo.mb; va = geo.mb; break;
            default: approx = true; vb = ctx.origin + cursor.y; va = 0; // paragraph, line: we only know roughly where it is
        }
        const left = hAlign ? hb + (/right|outside/.test(hAlign) ? ha - w : hAlign === "center" ? (ha - w) / 2 : 0) : hb + (hOff ?? 0);
        const top = vAlign && va ? vb + (/bottom|outside/.test(vAlign) ? va - h : vAlign === "center" ? (va - h) / 2 : 0) : vb + (vOff ?? 0);
        if (approx) warn.approx++;
        return { left, top };
    };
    const absDiv = (left: number, top: number, w: number, h: number, inner: string) => {
        const page = cursor.page ? ` data-flow-page="${cursor.page}"` : "";
        absOut.push(`<div data-flow-abs${page} style="${escAttr(styleAttr({ top: pt(top), left: pt(left), width: pt(w), height: pt(h) }))}">${inner}</div>`);
    };
    /** a text box's content as FlowDoc blocks */
    const boxBlocks = (content: El, width: number, ctx: Ctx): string => {
        const out: Block[] = [];
        walk(kids(content), { rels: ctx.rels, top: false, width, h: 0, origin: ctx.origin }, out);
        return serialize(out);
    };

    /** a DrawingML shape / picture / group → things to place: html (blocks) and the rect (pt) it occupies */
    interface Item { html: string; x: number; y: number; w: number; h: number; box: boolean }
    const shapeItems = (g: Element, x: number, y: number, w: number, h: number, ctx: Ctx): Item[] => {
        switch (nameOf(g)) {
            case "pic:pic": {
                const blip = find(g, "a:blip");
                if (!at(blip, "r:embed") && at(blip, "r:link")) { warn.linked++; return []; }
                const html = image(at(blip, "r:embed"), w, h, ctx.rels);
                return html ? [{ html: `<figure>${html}</figure>`, x, y, w, h, box: false }] : [];
            }
            case "wps:wsp": {
                const content = find(kid(g, "wps:txbx"), "w:txbxContent");
                const spPr = kid(g, "wps:spPr"), filled = !!kid(spPr, "a:solidFill") || !!kid(spPr, "a:gradFill") || !!find(kid(spPr, "a:ln"), "a:solidFill");
                if (!content) { if (filled || kid(spPr, "a:ln")) warn.shapes++; return []; }
                if (filled) warn.boxFill++;
                const bp = kid(g, "wps:bodyPr");
                const l = emu(at(bp, "lIns")) ?? 7.2, r = emu(at(bp, "rIns")) ?? 7.2, t = emu(at(bp, "tIns")) ?? 3.6, b = emu(at(bp, "bIns")) ?? 3.6;
                return [{ html: boxBlocks(content, w - l - r, ctx), x: x + l, y: y + t, w: Math.max(0, w - l - r), h: Math.max(0, h - t - b), box: true }];
            }
            case "wpg:wgp": case "wpg:grpSp": {
                // a group's children are measured in its own coordinate space (chOff/chExt), scaled onto the group's box
                const xf = find(kid(g, "wpg:grpSpPr"), "a:xfrm");
                const ch = kid(xf, "a:chOff"), ce = kid(xf, "a:chExt"), ext = kid(xf, "a:ext");
                const sx = w / (emu(at(ce, "cx")) || emu(at(ext, "cx")) || w || 1), sy = h / (emu(at(ce, "cy")) || emu(at(ext, "cy")) || h || 1);
                const cx0 = emu(at(ch, "x")) ?? 0, cy0 = emu(at(ch, "y")) ?? 0;
                const out: Item[] = [];
                for (const c of kids(g)) {
                    const cxf = find(c, "a:xfrm");
                    if (!cxf || nameOf(c) === "wpg:grpSpPr") continue;
                    const off = kid(cxf, "a:off"), ce2 = kid(cxf, "a:ext");
                    out.push(...shapeItems(c, x + ((emu(at(off, "x")) ?? 0) - cx0) * sx, y + ((emu(at(off, "y")) ?? 0) - cy0) * sy, (emu(at(ce2, "cx")) ?? 0) * sx, (emu(at(ce2, "cy")) ?? 0) * sy, ctx));
                }
                return out;
            }
            default: return [];
        }
    };

    /* ---- paragraphs ---- */
    function paragraph(pEl: Element, ctx: Ctx, out: Block[]): void {
        const pPr = kid(pEl, "w:pPr");
        const P = resolvePara(pPr, ctx.tblStyle), p = P.p;
        const paraRun = normRun(P.r);
        if (ctx.top && p.breakBefore && (cursor.y > 0 || cursor.page > 0)) newPage();
        const after: Block[] = [];
        let segs: Seg[] = [], chars = 0, imgH = 0, brs = 0, pieces = 0;
        // tab bookkeeping: a rough x (pt from the left margin) so each tab lands on the stop Word would use
        const tabs = p.tabs ?? [];
        let x = 0, factor = 1, prevStop = -Infinity;
        const resetX = () => { x = (p.left ?? 0) + (p.firstLine ?? 0) - (p.hanging ?? 0); factor = 1; prevStop = -Infinity; };
        resetX();
        const charW = (r: Run) => r.size * (r.caps || r.smallCaps ? 0.62 : 0.5) * (r.b ? 1.06 : 1);
        const liveHref = () => { for (let i = fields.length - 1; i >= 0; i--) if (fields[i].result && fields[i].href) return fields[i].href; return undefined; };

        const text = (t: string, r: Run, href?: string) => {
            if (!t) return;
            x += factor * t.length * charW(r);
            chars += t.length;
            segs.push({ html: spaces(esc(t)), r, href: href ?? liveHref(), chars: t.length, raw: t });
        };
        const tabTo = (pos: number, kind: string, r: Run, href?: string) => {
            prevStop = pos; x = pos;
            factor = kind === "right" || kind === "decimal" ? 0 : kind === "center" ? 0.5 : 1;
            segs.push({ html: `<span data-flow-tab="${kind}" data-flow-pos="${Math.round(pos * 100) / 100}"></span>`, r, href: href ?? liveHref(), chars: 0, tab: true });
        };
        const tab = (r: Run, href?: string) => {
            const from = Math.max(x, prevStop);
            // the first stop past where we are; if our width guess overshot every stop, the next one after the last tab
            let stop = tabs.find((t) => t.pos > from + 0.5) ?? tabs.find((t) => t.pos > prevStop + 0.5);
            if (p.hanging && p.left != null && p.left > from + 0.5 && (!stop || stop.pos > p.left)) stop = { pos: p.left, val: "left" }; // hanging indent is an implicit stop
            if (stop) tabTo(stop.pos, stop.val, r, href);
            else tabTo((Math.floor(from / defTab) + 1) * defTab, "left", r, href);
        };
        const flush = () => { // close the current piece of the paragraph as a block
            pieces++;
            out.push(makeBlock(segs, P, paraRun));
            segs = [];
        };

        const drawing = (d: Element, r: Run, href?: string) => {
            for (const a of kids(d)) {
                const anchor = nameOf(a) === "wp:anchor";
                if (!anchor && nameOf(a) !== "wp:inline") continue;
                const ext = kid(a, "wp:extent"), w = emu(at(ext, "cx")) ?? 0, h = emu(at(ext, "cy")) ?? 0;
                const gd = find(a, "a:graphicData"), uri = at(gd, "uri") ?? "";
                const g = gd?.firstElementChild;
                if (/chart|diagram/i.test(uri)) { warn.charts++; continue; }
                if (!g) continue;
                if (!anchor && nameOf(g) === "pic:pic") {
                    const html = image(at(find(g, "a:blip"), "r:embed"), w, h, ctx.rels);
                    if (html) { segs.push({ html, r, href: href ?? liveHref(), chars: 0, img: true }); imgH = Math.max(imgH, h); x += w; }
                    continue;
                }
                const items = shapeItems(g, 0, 0, w, h, ctx);
                if (!anchor) { for (const it of items) after.push({ kind: "html", html: it.html, weight: it.html.length / 20 }); continue; }
                let pos: { left: number; top: number };
                const sp = kid(a, "wp:simplePos");
                if (/^(1|true)$/.test(at(a, "simplePos") ?? "") && sp) pos = { left: emu(at(sp, "x")) ?? 0, top: emu(at(sp, "y")) ?? 0 };
                else {
                    const ph = kid(a, "wp:positionH"), pv = kid(a, "wp:positionV");
                    pos = place(at(ph, "relativeFrom") ?? "column", emu(kid(ph, "wp:posOffset")?.textContent), kid(ph, "wp:align")?.textContent?.trim() ?? null,
                        at(pv, "relativeFrom") ?? "paragraph", emu(kid(pv, "wp:posOffset")?.textContent), kid(pv, "wp:align")?.textContent?.trim() ?? null, w, h, ctx);
                }
                for (const it of items) absDiv(pos.left + it.x, pos.top + it.y, it.w, it.h, it.html);
            }
        };
        // legacy VML (w:pict, and the preview picture inside w:object): pictures and text boxes, positioned by CSS
        const vml = (c: Element, r: Run, href?: string) => {
            const shapes = kids(c).filter((s) => nameOf(s).startsWith("v:") && !/^v:(shapetype|stroke|fill)$/.test(nameOf(s)));
            if (!shapes.length && nameOf(c) === "w:object") warn.objects++;
            for (const s of shapes) {
                if (nameOf(s) === "v:group") { warn.approx++; vml(s, r, href); continue; }
                const css: Record<string, string> = {};
                for (const d of (at(s, "style") ?? "").split(";")) { const i = d.indexOf(":"); if (i > 0) css[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); }
                const len = (v?: string) => { const m = /^(-?[\d.]+)(pt|in|px|cm|mm)?$/.exec(v ?? ""); if (!m) return 0; const n = parseFloat(m[1]); return m[2] === "in" ? n * 72 : m[2] === "px" ? n * 0.75 : m[2] === "cm" ? n * 72 / 2.54 : m[2] === "mm" ? n * 72 / 25.4 : n; };
                const w = len(css.width), h = len(css.height);
                const imd = kid(s, "v:imagedata"), tb = kid(s, "v:textbox");
                let html = "";
                if (imd) html = image(at(imd, "r:id"), w, h, ctx.rels);
                else if (tb) html = boxBlocks(find(tb, "w:txbxContent"), w - 14.4, ctx);
                else { if (nameOf(c) !== "w:object") warn.shapes++; continue; }
                if (!html) continue;
                if (css.position !== "absolute") {
                    if (imd) { segs.push({ html, r, href: href ?? liveHref(), chars: 0, img: true }); imgH = Math.max(imgH, h); }
                    else after.push({ kind: "html", html, weight: html.length / 20 });
                    continue;
                }
                const hr = css["mso-position-horizontal-relative"] ?? "text", vr = css["mso-position-vertical-relative"] ?? "text";
                const pos = place(hr === "text" ? "column" : hr === "char" ? "character" : hr === "left-margin-area" ? "leftMargin" : hr === "right-margin-area" ? "rightMargin" : hr,
                    len(css["margin-left"] ?? css.left), css["mso-position-horizontal"] && css["mso-position-horizontal"] !== "absolute" ? css["mso-position-horizontal"] : null,
                    vr === "text" ? "paragraph" : vr === "top-margin-area" ? "topMargin" : vr === "bottom-margin-area" ? "bottomMargin" : vr,
                    len(css["margin-top"] ?? css.top), css["mso-position-vertical"] && css["mso-position-vertical"] !== "absolute" ? css["mso-position-vertical"] : null, w, h, ctx);
                if (imd) absDiv(pos.left, pos.top, w, h, `<figure>${html}</figure>`);
                else absDiv(pos.left + 7.2, pos.top + 3.6, Math.max(0, w - 14.4), Math.max(0, h - 7.2), html);
            }
        };
        const runKids = (parent: El, r: Run, href?: string) => {
            for (const c of kids(parent)) {
                const n = nameOf(c);
                if (n === "w:fldChar") {
                    const t = at(c, "w:fldCharType");
                    if (t === "begin") fields.push({ instr: "", result: false });
                    else if (t === "separate" && fields.length) { const f = fields[fields.length - 1]; f.result = true; f.href = fieldHref(f.instr); }
                    else if (t === "end") fields.pop();
                    continue;
                }
                if (n === "w:instrText") { if (fields.length) fields[fields.length - 1].instr += c.textContent ?? ""; continue; }
                if (n === "w:lastRenderedPageBreak") { if (ctx.top && rendered) newPage(); continue; }
                if (fields.some((f) => !f.result) || r.hidden) continue; // a field's code, or hidden text: nothing shows
                switch (n) {
                    case "w:t": text(c.textContent ?? "", r, href); break;
                    case "w:tab": tab(r, href); break;
                    case "w:ptab": {
                        const al = at(c, "w:alignment") ?? "left", ind = at(c, "w:relativeTo") === "indent";
                        const l0 = ind ? p.left ?? 0 : 0, r0 = ctx.width - (ind ? p.right ?? 0 : 0);
                        tabTo(al === "right" ? r0 : al === "center" ? (l0 + r0) / 2 : l0, al, r, href);
                        break;
                    }
                    case "w:br": {
                        const t = at(c, "w:type");
                        if (t === "page") { if (ctx.top && !rendered) pageBreakPending = true; }
                        else if (t === "column") { flush(); out.push({ kind: "colbreak" }); resetX(); }
                        else { segs.push({ html: "<br>", r, href: href ?? liveHref(), chars: 0 }); brs++; resetX(); x = p.left ?? 0; }
                        break;
                    }
                    case "w:cr": segs.push({ html: "<br>", r, chars: 0 }); brs++; resetX(); break;
                    case "w:noBreakHyphen": text("‑", r, href); break;
                    case "w:softHyphen": text("­", r, href); break;
                    case "w:sym": text(symChar(c), r, href); break;
                    case "w:drawing": drawing(c, r, href); break;
                    case "w:pict": case "w:object": vml(c, r, href); break;
                    case "mc:AlternateContent": runKids(choose(c), r, href); break;
                }
            }
        };
        const inl = (parent: El, href?: string): void => {
            for (const c of kids(parent)) {
                switch (nameOf(c)) {
                    case "w:r": runKids(c, runProps(kid(c, "w:rPr"), P.r), href); break;
                    case "w:hyperlink": {
                        const rel = ctx.rels.get(at(c, "r:id") ?? "");
                        inl(c, rel?.external ? safeHref(rel.target) ?? href : href); // an anchor-only link points inside the document: no link
                        break;
                    }
                    case "w:fldSimple": inl(c, fieldHref(at(c, "w:instr")) ?? href); break;
                    case "w:ins": case "w:moveTo": case "w:smartTag": case "w:customXml": case "w:dir": case "w:bdo": inl(c, href); break;
                    case "w:sdt": inl(kid(c, "w:sdtContent"), href); break;
                    case "mc:AlternateContent": inl(choose(c), href); break;
                    case "m:oMathPara": case "m:oMath": text(findAll(c, "m:t").map((t) => t.textContent ?? "").join(""), paraRun, href); break;
                }
            }
        };
        inl(pEl);
        if (segs.length || !pieces) flush();
        out.push(...after);

        // rough height, for placing things anchored further down
        const lh = p.line == null ? paraRun.size * 1.17 : p.lineRule === "exact" ? p.line / 20
            : p.lineRule === "atLeast" ? Math.max(p.line / 20, paraRun.size * 1.17) : (paraRun.size * 1.17 * p.line) / 240;
        const avail = Math.max(36, ctx.width - (p.left ?? 0) - (p.right ?? 0));
        const lines = Math.max(1, Math.ceil((chars * paraRun.size * 0.5) / avail)) + brs;
        ctx.h += Math.max(lines * lh, imgH) + (p.before ?? 0) + (p.after ?? 0);
    }

    function makeBlock(segs: Seg[], P: Para, paraRun: Run): Block {
        const p = P.p;
        if (!P.list) { const type = typedBullet(segs); if (type) P = { ...P, list: { numId: "typed", ilvl: 0, tag: "ul", type, left: p.left || 18 } }; }
        // the block's run style: the paragraph style's, unless every piece of text agrees on something else
        // (Word users often format a whole line directly — that belongs on the block, not on every span)
        const blk: Run = { ...paraRun };
        const txt = segs.filter((s) => s.chars > 0);
        if (txt.length) for (const k of ["font", "size", "color", "b", "i", "caps", "smallCaps", "spacing"] as const) {
            const v = txt[0].r[k];
            if (txt.every((s) => s.r[k] === v)) (blk as Record<typeof k, unknown>)[k] = v;
        }
        const blockSpace = (lines: number | undefined, auto: boolean | undefined, abs: number | undefined) =>
            pt(auto ? 14 : lines != null ? (lines / 100) * blk.size * 1.2 : abs ?? 0);
        const s: Record<string, string> = {};
        if (p.jc && p.jc !== "left") s["text-align"] = p.jc;
        s["margin-top"] = blockSpace(p.beforeLines, p.beforeAuto, p.before);
        s["margin-bottom"] = blockSpace(p.afterLines, p.afterAuto, p.after);
        if (!P.list) {
            if (p.left) s["margin-left"] = pt(p.left);
            const ti = p.hanging ? -p.hanging : p.firstLine;
            if (ti) s["text-indent"] = pt(ti);
        }
        if (p.right) s["margin-right"] = pt(p.right);
        if (p.line != null) s["line-height"] = p.lineRule === "exact" || p.lineRule === "atLeast" ? pt(p.line / 20) : String(Math.round((p.line / 240) * 1000) / 1000);
        if (p.bTop && p.bTop !== "none") { s["border-top"] = p.bTop; if (p.padTop) s["padding-top"] = pt(p.padTop); }
        if (p.bBottom && p.bBottom !== "none") { s["border-bottom"] = p.bBottom; if (p.padBottom) s["padding-bottom"] = pt(p.padBottom); }
        if (p.bg) s["background-color"] = p.bg;
        s["font-family"] = fam(blk.font);
        s["font-size"] = pt(blk.smallCaps ? blk.size * 0.8 : blk.size);
        s.color = blk.color;
        if (blk.b || P.heading) s["font-weight"] = blk.b ? "bold" : "normal";
        if (blk.i) s["font-style"] = "italic";
        if (blk.caps || blk.smallCaps) s["text-transform"] = "uppercase";
        if (blk.spacing) s["letter-spacing"] = pt(blk.spacing);

        const weight = segs.reduce((n, g) => n + g.chars, 0) + 20;
        // a paragraph that holds nothing but pictures is a figure
        if (!P.list && segs.length && segs.every((g) => g.img)) {
            const fs: Record<string, string> = { "text-align": s["text-align"], "margin-top": s["margin-top"], "margin-bottom": s["margin-bottom"] };
            return { kind: "html", html: `<figure style="${escAttr(styleAttr(fs))}">${segs.map((g) => g.html).join("")}</figure>`, weight };
        }
        return {
            kind: "p", tag: P.list ? "li" : P.heading ? `h${P.heading}` : "p", style: s, inner: inlineHtml(segs, blk) || "<br>",
            styleId: P.styleId, contextual: !!p.contextual, list: P.list, weight,
        };
    }

    /* ---- tables ---- */
    function table(tbl: Element, ctx: Ctx): { html: string; h: number; weight: number } {
        const tblPr = kid(tbl, "w:tblPr");
        const sid = val(kid(tblPr, "w:tblStyle")) ?? st.defaultT;
        const prs = [...chain(st, sid).map((d) => d.tblPr), tblPr].filter((e): e is Element => !!e);
        const tBorder = (side: string, alt?: string) => {
            let b: { css: string; space: number } | undefined;
            for (const pr of prs) { const bs = kid(pr, "w:tblBorders"); b = border(kid(bs, `w:${side}`) ?? (alt ? kid(bs, `w:${alt}`) : null), th) ?? b; }
            return b?.css ?? "none";
        };
        const mar = (m: El, side: string, alt: string) => twip(at(kid(m, `w:${side}`) ?? kid(m, `w:${alt}`), "w:w"));
        const tMar = (side: string, alt: string, def: number) => {
            let v = def;
            for (const pr of prs) v = mar(kid(pr, "w:tblCellMar"), side, alt) ?? v;
            return v;
        };
        const grid = kids(kid(tbl, "w:tblGrid"), "w:gridCol").map((g) => twip(at(g, "w:w")) ?? 0);
        // rows and cells may be wrapped in content controls / custom XML
        const items = (el: Element, n: string): Element[] => kids(el).flatMap((c) => {
            const cn = nameOf(c);
            if (cn === n) return [c];
            if (cn === "w:sdt") return items(kid(c, "w:sdtContent") ?? c, n);
            if (cn === "w:customXml" || cn === "w:ins") return items(c, n);
            return [];
        });
        interface Cell { el: Element; tcPr: Element | null; col: number; span: number; row: number; rowspan: number; html: string; h: number; width: number }
        const rows: Cell[][] = [], open = new Map<number, Cell>();
        const trs = items(tbl, "w:tr");
        let total = 0;
        trs.forEach((tr, ri) => {
            let col = num(val(kid(kid(tr, "w:trPr"), "w:gridBefore"))) ?? 0, rowH = 0;
            const cells: Cell[] = [];
            for (const tc of items(tr, "w:tc")) {
                const tcPr = kid(tc, "w:tcPr");
                const span = Math.max(1, num(val(kid(tcPr, "w:gridSpan"))) ?? 1);
                const vm = kid(tcPr, "w:vMerge");
                if (vm && val(vm) !== "restart") { // continues the cell above: that one grows instead
                    const o = open.get(col);
                    if (o) o.rowspan++;
                    col += span;
                    continue;
                }
                const tcW = kid(tcPr, "w:tcW");
                const width = grid.slice(col, col + span).reduce((a, b) => a + b, 0) || (at(tcW, "w:type") === "dxa" || !at(tcW, "w:type") ? twip(at(tcW, "w:w")) ?? 0 : 0);
                const cm = kid(tcPr, "w:tcMar");
                const padL = mar(cm, "left", "start") ?? tMar("left", "start", 5.4), padR = mar(cm, "right", "end") ?? tMar("right", "end", 5.4);
                const cctx: Ctx = { rels: ctx.rels, tblStyle: sid, top: false, width: Math.max(36, (width || ctx.width / 2) - padL - padR), h: 0, origin: ctx.origin };
                const blocks: Block[] = [];
                walk(kids(tc), cctx, blocks);
                const cell: Cell = { el: tc, tcPr, col, span, row: ri, rowspan: 1, html: serialize(blocks), h: cctx.h, width };
                cells.push(cell);
                if (vm) open.set(col, cell); else open.delete(col);
                rowH = Math.max(rowH, cctx.h);
                col += span;
            }
            rows.push(cells);
            total += rowH;
        });
        const nCols = Math.max(grid.length, ...rows.map((r) => r.reduce((m, c) => Math.max(m, c.col + c.span), 0)));
        let html = "<table>";
        for (const cells of rows) {
            html += "<tr>";
            for (const c of cells) {
                const tcPr = c.tcPr, tb = kid(tcPr, "w:tcBorders"), cm = kid(tcPr, "w:tcMar");
                const side = (s: string, alt: string, fallback: () => string) => border(kid(tb, `w:${s}`) ?? kid(tb, `w:${alt}`), th)?.css ?? fallback();
                const lastRow = c.row + c.rowspan >= rows.length;
                const pad = [mar(cm, "top", "top") ?? tMar("top", "top", 0), mar(cm, "right", "end") ?? tMar("right", "end", 5.4),
                    mar(cm, "bottom", "bottom") ?? tMar("bottom", "bottom", 0), mar(cm, "left", "start") ?? tMar("left", "start", 5.4)];
                const va = val(kid(tcPr, "w:vAlign"));
                const css: Record<string, string> = {
                    width: c.width ? pt(c.width) : "",
                    "vertical-align": va === "center" ? "middle" : va === "bottom" ? "bottom" : "top",
                    padding: pad.map(pt).join(" "),
                    "border-top": side("top", "top", () => tBorder(c.row === 0 ? "top" : "insideH")),
                    "border-right": side("right", "end", () => tBorder(c.col + c.span >= nCols ? "right" : "insideV", c.col + c.span >= nCols ? "end" : undefined)),
                    "border-bottom": side("bottom", "bottom", () => tBorder(lastRow ? "bottom" : "insideH")),
                    "border-left": side("left", "start", () => tBorder(c.col === 0 ? "left" : "insideV", c.col === 0 ? "start" : undefined)),
                    "background-color": shade(kid(tcPr, "w:shd"), th) ?? "",
                };
                html += `<td${c.span > 1 ? ` colspan="${c.span}"` : ""}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""} style="${escAttr(styleAttr(css))}">${c.html}</td>`;
            }
            html += "</tr>";
        }
        html += "</table>";
        return { html, h: total, weight: (tbl.textContent ?? "").length + 20 };
    }

    /* ---- walking block containers (body, cells, text boxes, headers) ---- */
    function walk(nodes: Element[], ctx: Ctx, out: Block[]): void {
        for (const el of nodes) {
            switch (nameOf(el)) {
                case "w:p": paragraph(el, ctx, out); break;
                case "w:tbl": { const t = table(el, ctx); out.push({ kind: "html", html: t.html, weight: t.weight }); ctx.h += t.h; break; }
                case "w:sdt": walk(kids(kid(el, "w:sdtContent")), ctx, out); break;
                case "w:customXml": case "w:ins": case "w:moveTo": case "w:smartTag": walk(kids(el), ctx, out); break;
                case "mc:AlternateContent": walk(kids(choose(el)), ctx, out); break;
            }
        }
    }

    /** blocks → FlowDoc html: contextual spacing, list grouping and nesting */
    function serialize(blocks: Block[]): string {
        let prev: PBlock | null = null;
        for (const b of blocks) {
            if (b.kind !== "p") { if (b.kind === "html" && !b.abs) prev = null; continue; }
            // "don't add space between paragraphs of the same style"
            if (prev && prev.styleId === b.styleId) {
                if (b.contextual) b.style["margin-top"] = "0pt";
                if (prev.contextual) prev.style["margin-bottom"] = "0pt";
            }
            prev = b;
        }
        let html = "", deferred = "";
        const stack: ListInfo[] = [];
        const close = () => {
            html += `</${stack.pop()?.tag}>`;
            if (!stack.length && deferred) { html += deferred; deferred = ""; }
        };
        for (const b of blocks) {
            if (b.kind === "colbreak") continue;
            if (b.kind === "p" && b.list) {
                const L = b.list;
                while (stack.length && stack[stack.length - 1].ilvl > L.ilvl) close();
                let top: ListInfo | undefined = stack[stack.length - 1];
                if (top && top.ilvl === L.ilvl && (top.tag !== L.tag || top.type !== L.type || (L.tag === "ol" && top.numId !== L.numId))) { close(); top = stack[stack.length - 1]; }
                if (!top || top.ilvl < L.ilvl) {
                    html += `<${L.tag} style="${escAttr(styleAttr({ "margin-left": pt(L.left - (top ? top.left : 0)), "list-style-type": L.type }))}">`;
                    stack.push(L);
                }
                html += `<li style="${escAttr(styleAttr(b.style))}">${b.inner}</li>`;
                continue;
            }
            if (b.kind === "html" && b.abs && stack.length) { deferred += b.html; continue; } // don't cut a list in two
            while (stack.length) close();
            html += b.kind === "p" ? `<${b.tag} style="${escAttr(styleAttr(b.style))}">${b.inner}</${b.tag}>` : b.html;
        }
        while (stack.length) close();
        return html + deferred;
    }

    /* ---- headers and footers ---- */
    const partRoot = async (id: string | undefined) => {
        const rel = id ? docRels.get(id) : undefined;
        if (!rel || rel.external) return null;
        return { root: await xml(rel.target), rels: await readRels(rel.target) };
    };
    const first = geos[0];
    const headerId = first.titlePg ? first.headers.get("first") : first.headers.get("default");
    const header = await partRoot(headerId);
    const out: string[] = [];
    if (header?.root && (/\S/.test(findAll(header.root, "w:t").map((t) => t.textContent).join("")) || findAll(header.root, "w:drawing").length || findAll(header.root, "w:pict").length)) {
        const hb: Block[] = [];
        walk(kids(header.root), { rels: header.rels, top: false, width: textW(), h: 0, origin: geo.header }, hb);
        out.push(serialize(hb), ...absOut.splice(0));
    }
    let footerText = "";
    for (const id of new Set(geos.flatMap((g) => g.footers))) {
        const f = await partRoot(id);
        const t = findAll(f?.root, "w:t").map((e) => e.textContent ?? "").join(" ");
        // page numbers ("Page 2 of 3") are the editor's job; anything else is real text we are leaving out
        if (/\S/.test(t.replace(/\b(page|of)\b|\d+|[\s\-–—|/.,:]/gi, ""))) footerText ||= t.replace(/\s+/g, " ").trim();
    }

    /* ---- the body, section by section ---- */
    interface Section { geo: Geo; blocks: Block[] }
    const sections: Section[] = [];
    let si = 0, cur: Section = { geo, blocks: [] };
    for (const el of kids(body)) {
        if (nameOf(el) === "w:sectPr") continue;
        const ctx: Ctx = { rels: docRels, top: true, width: textW(), h: 0, origin: geo.mt };
        walk([el], ctx, cur.blocks);
        cursor.y += ctx.h;
        const contentH = geo.h - geo.mt - geo.mb;
        if (!rendered) while (contentH > 0 && cursor.y > contentH) { cursor.page++; cursor.y -= contentH; }
        if (pageBreakPending) { newPage(); pageBreakPending = false; }
        for (const a of absOut.splice(0)) cur.blocks.push({ kind: "html", html: a, weight: 0, abs: true });
        if (nameOf(el) === "w:p" && kid(kid(el, "w:pPr"), "w:sectPr")) { // this paragraph ends a section
            sections.push(cur);
            geo = geos[++si] ?? geo;
            cur = { geo, blocks: [] };
            if (geo.type !== "continuous" && !rendered) newPage();
        }
    }
    sections.push(cur);

    for (const s of sections) {
        const g = s.geo;
        if (g.cols < 2) { out.push(serialize(s.blocks)); continue; }
        // newspaper columns: floating things stay out of the columns; the flow splits at column breaks
        out.push(...s.blocks.filter((b) => b.kind === "html" && b.abs).map((b) => (b.kind === "html" ? b.html : "")));
        const flow = s.blocks.filter((b) => !(b.kind === "html" && b.abs));
        let groups: Block[][] = [[]];
        for (const b of flow) if (b.kind === "colbreak") groups.push([]); else groups[groups.length - 1].push(b);
        if (groups.length === 1 && flow.length > 1) { // no breaks: balance by amount of text, as Word would at the section end
            warn.colsGuess = true;
            const w = (b: Block) => (b.kind === "colbreak" ? 0 : b.weight), total = flow.reduce((n, b) => n + w(b), 0);
            groups = [[]];
            let acc = 0;
            for (const b of flow) {
                if (acc >= (total * groups.length) / g.cols && groups.length < g.cols) groups.push([]);
                groups[groups.length - 1].push(b);
                acc += w(b);
            }
        }
        const tw = g.w - g.ml - g.mr;
        const widths = g.colW.length === g.cols && g.colW.every((x) => x > 0) ? g.colW : Array.from({ length: g.cols }, () => (tw - g.colSpace * (g.cols - 1)) / g.cols);
        for (let i = 0; i < groups.length; i += g.cols) {
            out.push("<div data-flow-cols>" + groups.slice(i, i + g.cols).map((grp, k) => `<div data-flow-col style="width: ${pt(widths[k])}">${serialize(grp)}</div>`).join("") + "</div>");
        }
    }

    /* ---- result ---- */
    const g0 = geos[0];
    const page: FlowPage = { widthPt: g0.w, heightPt: g0.h, marginTopPt: g0.mt, marginBottomPt: g0.mb, marginLeftPt: g0.ml, marginRightPt: g0.mr };
    const baseP = mergeP(st.docP, styleProps(st.defaultP).p), baseR = normRun(merge(st.docR, styleProps(st.defaultP).r));
    const warnings: string[] = [];
    const nFmt = [...warn.fmt.values()].reduce((a, b) => a + b, 0);
    if (nFmt) warnings.push(`${nFmt} ${plural(nFmt, "picture was", "pictures were")} in a format IcedCoffee can't show (${[...warn.fmt.keys()].join(", ")}) and ${plural(nFmt, "was", "were")} left out.`);
    if (warn.linked) warnings.push(`${warn.linked} ${plural(warn.linked, "picture was", "pictures were")} linked from outside the document and left out.`);
    if (warn.charts) warnings.push(`${warn.charts} ${plural(warn.charts, "chart or diagram was", "charts or diagrams were")} left out.`);
    if (warn.objects) warnings.push(`${warn.objects} embedded ${plural(warn.objects, "object was", "objects were")} left out.`);
    if (warn.shapes) warnings.push(`${warn.shapes} decorative ${plural(warn.shapes, "shape (a line or box) was", "shapes (lines or boxes) were")} left out.`);
    if (warn.boxFill) warnings.push(`${warn.boxFill} text ${plural(warn.boxFill, "box had a background or outline that wasn't", "boxes had a background or outline that weren't")} brought across.`);
    if (warn.approx) warnings.push(`${warn.approx} floating ${plural(warn.approx, "item is", "items are")} placed relative to the text, so ${plural(warn.approx, "its", "their")} position on the page is approximate.`);
    if (warn.colsGuess) warnings.push("Part of the document is in columns with no column break, so IcedCoffee guessed where the next column starts.");
    if (footerText) warnings.push(`The footer text ("${footerText.length > 60 ? footerText.slice(0, 57) + "…" : footerText}") was left out.`);

    const html = out.join("");
    const result: FlowResult = {
        html, title, page, warnings,
        base: { fontFamily: baseR.font, fontSizePt: baseR.size, color: baseR.color, lineHeight: baseP.line != null && (baseP.lineRule ?? "auto") === "auto" ? Math.round((baseP.line / 240) * 1000) / 1000 : undefined },
    };
    if (!/\S/.test(html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "")) && /<img /.test(html)) result.needsAi = "The document holds pictures but no text — it may be a scan.";
    return result;
}

/** A paragraph that starts with a typed bullet glyph and a tab ("•⇥text", often after a leading tab) looks exactly
 * like a list item, so it is one: strip the glyph and its tabs from `segs` and return the marker type. */
function typedBullet(segs: Seg[]): string | null {
    let i = 0;
    while (i < segs.length && (segs[i].tab || segs[i].raw === "")) i++;
    const s = segs[i], m = s?.raw ? /^\s*([•◦▪■●○‣⁃·➢✓❖–*-])([\t ]*)$|^\s*([•◦▪■●○‣⁃·➢✓❖])(\s+)(.*)$/s.exec(s.raw) : null;
    if (!s || !m) return null;
    const glyph = m[1] ?? m[3];
    let j = i + 1;
    if (m[1] !== undefined) { // the glyph stands alone: a tab (or a space) must follow it, else it's just a dash
        if (segs[j]?.tab) j++;
        else if (!m[2] || /[–*-]/.test(glyph)) return null;
        segs.splice(0, j);
    } else {
        s.raw = m[5]; s.chars = m[5].length; s.html = spaces(esc(m[5]));
        segs.splice(0, i);
    }
    return /[◦○]/.test(glyph) ? "circle" : /[▪■]/.test(glyph) ? "square" : "disc";
}

/** a run's formatting as the tags and span it needs INSIDE its block: only what differs from the block */
function fmt(r: Run, b: Run): [string, string] {
    const css: Record<string, string> = {};
    const size = r.smallCaps ? r.size * 0.8 : r.size, bSize = b.smallCaps ? b.size * 0.8 : b.size;
    if (r.font !== b.font) css["font-family"] = fam(r.font);
    if (size !== bSize) css["font-size"] = pt(size);
    if (r.color !== b.color) css.color = r.color;
    if (!r.b && b.b) css["font-weight"] = "normal";
    if (!r.i && b.i) css["font-style"] = "normal";
    const up = r.caps || r.smallCaps;
    if (up !== (b.caps || b.smallCaps)) css["text-transform"] = up ? "uppercase" : "none";
    if (r.spacing !== b.spacing) css["letter-spacing"] = pt(r.spacing);
    if (r.bg) css["background-color"] = r.bg;
    const tags = [r.b && !b.b && "strong", r.i && !b.i && "em", r.u && "u", r.strike && "s", r.vert === "super" && "sup", r.vert === "sub" && "sub"]
        .filter((t): t is string => !!t);
    const s = styleAttr(css);
    return [(s ? `<span style="${escAttr(s)}">` : "") + tags.map((t) => `<${t}>`).join(""), tags.reverse().map((t) => `</${t}>`).join("") + (s ? "</span>" : "")];
}
/** segments → inline html: links around their runs, adjacent runs with the same look merged */
function inlineHtml(segs: Seg[], blk: Run): string {
    let html = "";
    for (let i = 0; i < segs.length; ) {
        const href = segs[i].href;
        let inner = "", j = i;
        while (j < segs.length && segs[j].href === href) {
            const [open, close] = fmt(segs[j].r, blk);
            let body = "";
            while (j < segs.length && segs[j].href === href && fmt(segs[j].r, blk)[0] === open) body += segs[j++].html;
            inner += open + body + close;
        }
        html += href ? `<a href="${escAttr(href)}">${inner}</a>` : inner;
        i = j;
    }
    return html;
}

/** mc:AlternateContent: the modern DrawingML choice when it is one we read, else Word's VML fallback */
function choose(ac: Element): Element | null {
    const ch = kid(ac, "mc:Choice"), fb = kid(ac, "mc:Fallback");
    const req = at(ch, "Requires") ?? "";
    return ch && ch.firstElementChild && !/\b(wpc|cx\d*|aink|am3d)\b/.test(req) ? ch : fb;
}
