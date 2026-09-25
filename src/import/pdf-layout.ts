// src/import/pdf-layout.ts — the PURE half of the PDF importer: positioned text, rules and pictures → FlowDoc.
//
// A PDF has no paragraphs, lists or columns — only glyph runs placed at coordinates. This file rebuilds what a
// reader sees from geometry alone (pdf.ts does the pdf.js extraction and hands over plain PdfPage objects, so all
// of this runs — and is tested — in node without pdf.js or a canvas):
//   items → runs (split where a link or an underline starts/ends) → fragments (runs on one baseline with no big gap)
//   → running headers/footers and page numbers dropped → each page split into bands: full-width flow, or two
//   columns where a clear vertical gutter runs between two stacks of text → lines (fragments on one baseline;
//   a wide gap becomes a tab, right-aligned text a right tab) → blocks (paragraphs, lists, rules, pictures).
// It reconstructs appearance, never meaning: a big bold line is a big bold <p>, not "the name".
import { esc, escAttr, pt, styleAttr, type FlowPage, type FlowResult } from "./flow";

export interface PdfTextItem {
    str: string;
    /** left edge and TOP of the em box, in pt from the page's top-left corner */
    x: number; y: number;
    width: number;
    /** the font size in pt (= the em box's height) */
    height: number;
    /** the font's ascent as a fraction of the size: baseline = y + height × ascent (default 0.8) */
    ascent?: number;
    /** the PDF's font name, e.g. "ABCDEF+Georgia-BoldItalic" (cleaned here) */
    fontName?: string;
    /** the generic family when known: "serif" | "sans-serif" | "monospace" */
    fontFamily?: string;
    bold?: boolean; italic?: boolean;
    /** #rrggbb */
    color?: string;
}
/** a filled rectangle / thick line, pt from the page's top-left */
export interface PdfBox { x: number; y: number; w: number; h: number; color?: string }
/** a small drawn shape (a list bullet a browser or Word drew instead of a • glyph) */
export interface PdfMark extends PdfBox { shape?: "disc" | "circle" | "square" }
export interface PdfImage { x: number; y: number; w: number; h: number; dataUri: string }
export interface PdfLink { x: number; y: number; w: number; h: number; href: string }
export interface PdfPage {
    width: number; height: number;
    items: PdfTextItem[];
    images: PdfImage[];
    /** horizontal rules and underlines (thin filled rects / stroked lines) */
    rules: PdfBox[];
    marks?: PdfMark[];
    /** larger filled rectangles (shaded bars behind a heading) */
    fills?: PdfBox[];
    links?: PdfLink[];
}
export interface LayoutOptions { title?: string; warnings?: string[] }

export const SCAN_MESSAGE = "This PDF is a scan (pictures of pages, no text). IcedCoffee can only read it with an AI that can see images.";

/* ---------------- fonts ---------------- */

const WEIGHTS: [RegExp, number][] = [[/black|heavy/, 900], [/(extra|ultra)bold/, 800], [/semibold|demibold|demi|semi/, 600], [/bold/, 700], [/medium/, 500], [/(extra|ultra)light|thin|hairline/, 200], [/light/, 300]];
// style words glued onto a family ("ArialBold", "TimesNewRomanPSMT"); "Roman" and "Book" stay (Times New Roman, Book Antiqua)
const STYLE_WORDS = /(Bold|Black|Heavy|Semibold|SemiBold|Demibold|DemiBold|Medium|Light|Thin|Regular|Italic|Oblique|Condensed|Narrow|MT|PS|Std)$/;
const SERIF = /times|georgia|garamond|cambria|book ?antiqua|palatino|baskerville|caslon|minion|merriweather|serif|charter|didot|bodoni|constantia|century|playfair|lora|crimson|tinos|liberation serif|dejavu serif|noto serif|source serif|pt serif|charis|libre baskerville/i;
const MONO = /courier|mono|consolas|menlo|inconsolata|code/i;

/** "ABCDEF+TimesNewRomanPS-BoldItalicMT" → { family: "'Times New Roman', serif", weight: 700, italic: true } */
export function cleanFont(raw = "", generic = "", bold?: boolean, italic?: boolean): { family: string; weight: number; italic: boolean } {
    const name = raw.replace(/^[A-Z]{6}\+/, "");
    const low = name.toLowerCase();
    const stylepart = low.replace(/^[^-,]*/, "") || low;
    let weight = 400;
    for (const [re, w] of WEIGHTS) if (re.test(stylepart)) { weight = w; break; }
    if (bold && weight < 600) weight = 700;
    const isItalic = !!italic || /italic|oblique|kursiv|[-,]it$|boldit$/.test(low);
    let fam = name.split(/[-,]/)[0];
    for (let i = 0; i < 4; i++) fam = fam.replace(STYLE_WORDS, "");
    // pdf.js names fonts it had to invent "g_d0_f1"; those carry no family
    if (/^g_d\d+_f\d+$/.test(fam) || !/[a-z]/i.test(fam)) fam = "";
    fam = fam.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/_/g, " ").trim();
    const gen = /^(serif|sans-serif|monospace)$/.test(generic) ? generic : SERIF.test(fam) ? "serif" : MONO.test(fam) ? "monospace" : "sans-serif";
    const quoted = fam ? (/\s/.test(fam) ? `'${fam}'` : fam) + ", " : "";
    return { family: quoted + gen, weight, italic: isItalic };
}

/* ---------------- geometry types ---------------- */

interface Run {
    text: string; x0: number; x1: number; baseline: number; size: number; ascent: number;
    family: string; weight: number; italic: boolean; color: string;
    href?: string; u?: boolean; vshift?: "sup" | "sub";
    img?: PdfImage;
    tab?: { align: "left" | "right" | "center"; pos: number };
}
interface Frag { runs: Run[]; x0: number; x1: number; top: number; bottom: number; baseline: number; size: number }
interface Line {
    kind: "line";
    runs: Run[]; x0: number; x1: number; top: number; bottom: number; baseline: number; size: number;
    style: Style; text: string; tabs: boolean;
    bullet?: { list: "ul" | "ol"; type: string; markerX: number };
}
interface Rule { kind: "rule"; x0: number; x1: number; top: number; bottom: number; color: string }
interface Fig { kind: "fig"; img: PdfImage; x0: number; x1: number; top: number; bottom: number }
type Elem = Line | Rule | Fig;
interface Style { family: string; size: number; weight: number; italic: boolean; color: string }
interface Box { x0: number; x1: number; top: number; bottom: number; frag?: Frag; mark?: PdfMark; rule?: PdfBox; img?: PdfImage }

const ASC = 0.8, DESC = 0.22;
const r2 = (n: number) => Math.round(n * 100) / 100;
const half = (n: number) => Math.round(n * 2) / 2;
const sameStyle = (a: Style, b: Style) => a.family === b.family && Math.abs(a.size - b.size) <= 0.3 && (a.weight >= 600) === (b.weight >= 600) && a.italic === b.italic && a.color === b.color;

/* ---------------- items → runs → fragments ---------------- */

/** cut a run at page x, snapping to a word boundary nearby: pdf.js gives whole lines as one item, but a link or
 *  an underline may cover only a few words of it. Positions are estimated per character (proportional fonts
 *  make that approximate — hence the snap). */
function splitRun(run: Run, x: number): [Run, Run] | null {
    const n = run.text.length;
    if (x <= run.x0 + 0.5 || x >= run.x1 - 0.5 || n < 2) return null;
    let i = Math.round(((x - run.x0) / (run.x1 - run.x0)) * n);
    let best = -1;
    for (let d = 0; d <= 3 && best < 0; d++) for (const j of [i - d, i + d]) if (j > 0 && j < n && (/\s/.test(run.text[j - 1]) || /\s/.test(run.text[j]) || /[·|•,;]/.test(run.text[j - 1]))) { best = j; break; }
    if (best > 0) i = best;
    if (i <= 0 || i >= n) return null;
    const xm = run.x0 + ((run.x1 - run.x0) * i) / n;
    return [{ ...run, text: run.text.slice(0, i), x1: xm }, { ...run, text: run.text.slice(i), x0: xm }];
}

function cutRuns(runs: Run[], x0: number, x1: number, apply: (r: Run) => void, test: (r: Run) => boolean) {
    for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        if (!test(r) || r.x1 <= x0 || r.x0 >= x1) continue;
        const a = splitRun(r, x0);
        if (a) { runs.splice(k, 1, ...a); continue; }            // re-visit the right half
        const b = splitRun(r, x1);
        if (b) { runs.splice(k, 1, ...b); apply(b[0]); k++; continue; }
        const mid = (r.x0 + r.x1) / 2;
        if (mid >= x0 && mid <= x1) apply(r);
    }
}

function pageRuns(page: PdfPage, used: Set<PdfBox>): Run[] {
    const runs: Run[] = [];
    for (const it of page.items) {
        const text = it.str.replace(/[  - ]/g, " ");
        if (!text.trim() || it.width <= 0 || it.height <= 0) continue;
        const f = cleanFont(it.fontName, it.fontFamily, it.bold, it.italic);
        const ascent = it.ascent && it.ascent > 0.3 && it.ascent < 1.2 ? it.ascent : ASC;
        // 9.494999pt is a 9.5pt font after a float round trip
        const size = Math.abs(it.height * 4 - Math.round(it.height * 4)) < 0.1 ? Math.round(it.height * 4) / 4 : r2(it.height);
        runs.push({ text, x0: it.x, x1: it.x + it.width, baseline: it.y + it.height * ascent, size, ascent, family: f.family, weight: f.weight, italic: f.italic, color: it.color || "#000000" });
    }
    // fake bold: the same text drawn twice a hair apart
    runs.sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
    for (let i = runs.length - 1; i > 0; i--) {
        const a = runs[i - 1], b = runs[i];
        if (a.text === b.text && Math.abs(a.x0 - b.x0) < 1 && Math.abs(a.baseline - b.baseline) < 0.5) { a.weight = Math.max(a.weight, 700); runs.splice(i, 1); }
    }
    for (const l of page.links || []) cutRuns(runs, l.x, l.x + l.w, (r) => (r.href = l.href), (r) => r.baseline >= l.y - 1 && r.baseline - r.size * 0.5 <= l.y + l.h + 1);
    // an underline: a thin rule just under a baseline, no wider than the text it sits under
    for (const rule of page.rules) {
        if (rule.h > 2.5 || rule.w < 2) continue;
        const under = runs.filter((r) => rule.y - r.baseline >= -0.15 * r.size && rule.y - r.baseline <= 0.4 * r.size && r.x1 > rule.x + 0.5 && r.x0 < rule.x + rule.w - 0.5);
        if (!under.length) continue;
        const lx0 = Math.min(...under.map((r) => r.x0)), lx1 = Math.max(...under.map((r) => r.x1));
        if (rule.x < lx0 - 2 || rule.x + rule.w > lx1 + 2) continue;   // wider than the words: a rule, not an underline
        used.add(rule);
        const linkedW = under.filter((r) => r.href).reduce((w, r) => w + Math.min(r.x1, rule.x + rule.w) - Math.max(r.x0, rule.x), 0);
        if (linkedW < 0.6 * rule.w) cutRuns(runs, rule.x, rule.x + rule.w, (r) => { if (!r.href) r.u = true; }, (r) => under.includes(r) || (Math.abs(r.baseline - under[0].baseline) < 1));
    }
    return runs;
}

function toFrags(runs: Run[]): Frag[] {
    // rows: runs sharing a baseline (superscripts sit a little higher — the tolerance scales with the size)
    const rows: Run[][] = [];
    for (const r of [...runs].sort((a, b) => a.baseline - b.baseline)) {
        const row = rows.find((w) => w.some((o) => Math.abs(o.baseline - r.baseline) <= Math.max(1, 0.35 * Math.max(o.size, r.size)) && !(o.x0 < r.x1 - 1 && r.x0 < o.x1 - 1)));
        if (row) row.push(r); else rows.push([r]);
    }
    const frags: Frag[] = [];
    for (const row of rows) {
        row.sort((a, b) => a.x0 - b.x0);
        let cur: Run[] = [];
        const flush = () => { if (cur.length) frags.push(mkFrag(cur)); cur = []; };
        for (const r of row) {
            const prev = cur[cur.length - 1];
            if (prev && r.x0 - prev.x1 > Math.max(1.2 * Math.min(prev.size, r.size), 6)) flush();
            else if (prev && r.x0 - prev.x1 > 0.15 * Math.min(prev.size, r.size) && !/\s$/.test(prev.text) && !/^\s/.test(r.text)) prev.text += " ";
            cur.push(r);
        }
        flush();
    }
    return frags;
}

function mkFrag(runs: Run[]): Frag {
    const main = runs.reduce((a, b) => (b.text.length * b.size > a.text.length * a.size ? b : a));
    for (const r of runs) if (r.size < main.size * 0.85 && Math.abs(r.baseline - main.baseline) > 0.2 * r.size) r.vshift = r.baseline < main.baseline ? "sup" : "sub";
    return {
        runs, x0: runs[0].x0, x1: runs[runs.length - 1].x1, baseline: main.baseline, size: main.size,
        top: Math.min(...runs.map((r) => r.baseline - r.size * r.ascent)), bottom: Math.max(...runs.map((r) => r.baseline + r.size * DESC)),
    };
}

const fragText = (f: Frag) => f.runs.map((r) => r.text).join("").trim();

/* ---------------- running headers, footers, page numbers ---------------- */

function dropPageFurniture(pages: PdfPage[], frags: Frag[][]) {
    if (pages.length < 2) return 0;
    const zone = (f: Frag, p: PdfPage) => (f.bottom < p.height * 0.09 ? "top" : f.top > p.height * 0.91 ? "bottom" : "");
    const key = (f: Frag) => fragText(f).toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
    const seen = new Map<string, Set<number>>();
    frags.forEach((list, i) => list.forEach((f) => { const z = zone(f, pages[i]); if (z) { const k = z + key(f); if (!seen.has(k)) seen.set(k, new Set()); seen.get(k)!.add(i); } }));
    const need = Math.max(2, Math.ceil(pages.length / 2));
    let dropped = 0;
    frags.forEach((list, i) => {
        for (let k = list.length - 1; k >= 0; k--) {
            const f = list[k], z = zone(f, pages[i]);
            if (!z) continue;
            const t = key(f);
            if (seen.get(z + t)!.size >= need || /^(page\s*)?#(\s*(of|\/)\s*#)?$|^[-–—]\s*#\s*[-–—]$|\bpage #( of #)?$/.test(t)) { list.splice(k, 1); dropped++; }
        }
    });
    return dropped;
}

/* ---------------- columns ---------------- */

interface Band { top: number; bottom: number; gx: number }

/** the best vertical gutter in this set of boxes: a strip ≥ 6pt wide that no text, rule, bullet or picture crosses,
 *  with ≥ 2 lines of text on each side. Text above where BOTH sides have started (a name over a sidebar) and a
 *  short tail below where one side ended stay outside the band. */
function findBand(boxes: Box[], L: number, R: number): Band | null {
    let best: (Band & { score: number; gap: number }) | null = null;
    const lines = (bs: Box[]) => new Set(bs.filter((b) => b.frag).map((b) => Math.round(b.frag!.baseline))).size;
    for (let x = L + 40; x <= R - 40; x += 2) {
        const crossing = boxes.filter((b) => b.x0 < x + 3 && b.x1 > x - 3).sort((a, b) => a.top - b.top);
        const free: [number, number][] = [];
        let edge = -Infinity;
        for (const c of crossing) { if (c.top > edge) free.push([edge, c.top]); edge = Math.max(edge, c.bottom); }
        free.push([edge, Infinity]);
        for (const [a, b] of free) {
            const inside = boxes.filter((o) => o.top >= a - 0.5 && o.bottom <= b + 0.5);
            let left = inside.filter((o) => o.x1 <= x - 3), right = inside.filter((o) => o.x0 >= x + 3);
            if (lines(left) < 2 || lines(right) < 2) continue;
            // trim the top: what sits above the later-starting side belongs to the flow above
            const top = Math.max(Math.min(...left.map((o) => o.top)), Math.min(...right.map((o) => o.top))) - 1;
            left = left.filter((o) => o.bottom > top); right = right.filter((o) => o.bottom > top);
            let bottom = Math.max(...left.concat(right).map((o) => o.bottom)) + 1;
            // only a LEFT tail can be full-width text below the columns (a job title under two columns of
            // bullets); a right-hand tail is the right column running longer, and a tail set like the text above
            // it is the left column running longer
            const endL = Math.max(...left.map((o) => o.bottom)), endR = Math.max(...right.map((o) => o.bottom));
            const shortEnd = Math.min(endL, endR);
            const tail = endL > endR ? left.filter((o) => o.top > shortEnd + 1) : [];
            const tf = tail.filter((o) => o.frag).sort((p, q) => p.top - q.top)[0]?.frag;
            const above = left.filter((o) => o.frag && o.bottom <= shortEnd + 1).sort((p, q) => q.top - p.top)[0]?.frag;
            const same = tf && above && Math.abs(tf.size - above.size) <= 0.3 && (dominant(tf.runs).weight >= 600) === (dominant(above.runs).weight >= 600);
            if (tail.length && !same && Math.max(...tail.map((o) => o.bottom)) - shortEnd < 0.4 * (bottom - top)) {
                bottom = shortEnd + 1;
                left = left.filter((o) => o.top < bottom); right = right.filter((o) => o.top < bottom);
            }
            const nl = lines(left), nr = lines(right);
            if (nl < 2 || nr < 2 || nl + nr < 4) continue;
            // "Title ……… 2019 – 2023" rows: every right line short, right-aligned and paired with a left one — tabs, not columns
            const rf = right.filter((o) => o.frag).map((o) => o.frag!), lf = left.filter((o) => o.frag).map((o) => o.frag!);
            const paired = rf.filter((f) => lf.some((g) => Math.abs(g.baseline - f.baseline) < 1)).length / rf.length;
            const rMax = Math.max(...rf.map((f) => f.x1));
            if (paired >= 0.9 && rf.every((f) => f.x1 - f.x0 < 0.35 * (R - L) && f.x1 > rMax - 2)) continue;
            // among gutters that take in the same boxes, prefer the one leaving fewer rows split by a wide gap
            const rows = (fs: Frag[]) => { const m = new Map<number, number>(); for (const f of fs) m.set(Math.round(f.baseline), (m.get(Math.round(f.baseline)) || 0) + 1); return [...m.values()].filter((n) => n > 1).length; };
            const score = (left.length + right.length) * 100 - rows(lf) - rows(rf);
            const gap = Math.min(...right.map((o) => o.x0)) - Math.max(...left.map((o) => o.x1));
            if (!best || score > best.score || (score === best.score && gap > best.gap)) best = { top, bottom, gx: x, score, gap };
        }
    }
    return best && { top: best.top, bottom: best.bottom, gx: best.gx };
}

type Segment = { kind: "flow"; boxes: Box[] } | { kind: "cols"; left: Box[]; right: Box[] };

function splitRegion(boxes: Box[], L: number, R: number, depth = 0): Segment[] {
    if (!boxes.length) return [];
    const band = depth < 6 ? findBand(boxes, L, R) : null;
    if (!band) return [{ kind: "flow", boxes }];
    const inBand = (b: Box) => b.bottom > band.top && b.top < band.bottom && !(b.x0 < band.gx + 3 && b.x1 > band.gx - 3);
    const above = boxes.filter((b) => !inBand(b) && b.top < band.top + 0.5);
    const below = boxes.filter((b) => !inBand(b) && b.top >= band.top + 0.5);
    const mid = boxes.filter(inBand);
    return [...splitRegion(above, L, R, depth + 1), { kind: "cols", left: mid.filter((b) => b.x1 <= band.gx), right: mid.filter((b) => b.x0 >= band.gx) }, ...splitRegion(below, L, R, depth + 1)];
}

/* ---------------- lines ---------------- */

const BULLET = /^\s*([•●○◦▪■□◆◇♦►▶▸➢➤→‣⁃✓✔✗❖∙·-])\s*/;
const DASH = /^\s*([-–—*])\s+/;
const NUMBER = /^\s*\(?(\d{1,2}|[a-z]|[ivx]{1,4}|[A-Z]|[IVX]{1,4})[.)]\s+/;
const listType = (g: string): string => /[•●∙·]/.test(g) ? "disc" : /[○◦]/.test(g) ? "circle" : /[▪■□]/.test(g) ? "square" : /[-]/.test(g) ? "disc" : `'${g} '`;
const numType = (n: string): string => /^\d/.test(n) ? "decimal" : /^[ivx]+$/.test(n) && n !== "v" && n !== "x" ? "lower-roman" : /^[IVX]+$/.test(n) && n.length > 1 ? "upper-roman" : /^[a-z]$/.test(n) ? "lower-alpha" : "upper-alpha";

function dominant(runs: Run[]): Style {
    const w = new Map<string, number>();
    let best: Run = runs[0], bw = -1;
    for (const r of runs) {
        if (r.img || r.tab || r.vshift) continue;
        const k = `${r.family}|${r.size}|${r.weight}|${r.italic}|${r.color}`;
        const v = (w.get(k) || 0) + r.text.trim().length;
        w.set(k, v);
        if (v > bw) { bw = v; best = r; }
    }
    return { family: best.family, size: best.size, weight: best.weight, italic: best.italic, color: best.color };
}

function buildLines(frags: Frag[], marks: PdfMark[], L: number, R: number): Line[] {
    const rows: Frag[][] = [];
    for (const f of [...frags].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
        const row = rows.find((w) => Math.abs(w[0].baseline - f.baseline) <= Math.max(1, 0.35 * Math.max(w[0].size, f.size)));
        if (row) row.push(f); else rows.push([f]);
    }
    const lines: Line[] = [];
    for (const row of rows) {
        row.sort((a, b) => a.x0 - b.x0);
        const runs: Run[] = [];
        row.forEach((f, i) => {
            if (i > 0) {
                const last = i === row.length - 1, size = f.size;
                const align: "left" | "right" | "center" = last && f.x1 >= R - 1.5 ? "right" : last && Math.abs((f.x0 + f.x1) / 2 - (L + R) / 2) < 2 && f.x0 - row[i - 1].x1 > 12 ? "center" : "left";
                const pos = align === "right" ? f.x1 - L : align === "center" ? (f.x0 + f.x1) / 2 - L : f.x0 - L;
                runs.push({ ...f.runs[0], text: "", x0: row[i - 1].x1, x1: f.x0, size, tab: { align, pos }, href: undefined, u: false });
            }
            runs.push(...f.runs);
        });
        const content = runs.filter((r) => !r.tab);
        const main = row.reduce((a, b) => (fragText(b).length * b.size > fragText(a).length * a.size ? b : a));
        const line: Line = {
            kind: "line", runs, x0: row[0].x0, x1: row[row.length - 1].x1, top: Math.min(...row.map((f) => f.top)), bottom: Math.max(...row.map((f) => f.bottom)),
            baseline: main.baseline, size: main.size, style: dominant(content), text: content.map((r) => r.text).join(""), tabs: row.length > 1,
        };
        detectBullet(line, marks);
        lines.push(line);
    }
    return lines;
}

function detectBullet(line: Line, marks: PdfMark[]) {
    const m = marks.find((k) => k.x + k.w <= line.x0 + 1 && line.x0 - (k.x + k.w) <= Math.max(2.5 * line.size, 20) && k.h <= 0.8 * line.size
        && k.y + k.h / 2 >= line.top - 0.5 && k.y + k.h / 2 <= line.baseline + 0.1 * line.size);
    if (m) {
        line.bullet = { list: "ul", type: m.shape === "circle" ? "circle" : m.shape === "square" ? "square" : "disc", markerX: m.x };
        return;
    }
    const first = line.runs.find((r) => !r.tab && !r.img);
    if (!first || first !== line.runs[0]) return;
    const text = line.text;
    let hit: RegExpExecArray | null, list: "ul" | "ol" = "ul", type = "";
    if ((hit = BULLET.exec(text))) type = listType(hit[1]);
    else if ((hit = DASH.exec(text))) type = hit[1] === "*" ? "disc" : `'${hit[1]} '`;
    else if ((hit = NUMBER.exec(text)) && text.length > hit[0].length + 1) { list = "ol"; type = numType(hit[1]); }
    else return;
    // strip the marker (it may be a run of its own, or the start of the first run)
    let strip = hit[0].length;
    const markerX = line.x0;
    while (strip > 0 && line.runs.length) {
        const r = line.runs[0];
        if (r.tab) { line.runs.shift(); continue; }
        if (r.text.length <= strip) { strip -= r.text.length; line.runs.shift(); continue; }
        const cut = (r.x1 - r.x0) * (strip / r.text.length);
        line.runs[0] = { ...r, text: r.text.slice(strip), x0: r.x0 + cut };
        strip = 0;
    }
    while (line.runs[0]?.tab) line.runs.shift();
    if (!line.runs.length) { line.runs = [{ ...first, text: "", x1: first.x0 }]; }
    line.x0 = line.runs[0].x0;
    line.tabs = line.runs.some((r) => r.tab);
    line.text = line.runs.filter((r) => !r.tab).map((r) => r.text).join("");
    line.bullet = { list, type, markerX };
}

/* ---------------- blocks ---------------- */

interface Para { kind: "p"; lines: Line[]; style: Style; align: string; border?: Rule }
interface Item { lines: Line[]; brs: Set<number>; children: List[] }
interface List { kind: "list"; tag: "ul" | "ol"; type: string; markerX: number; textX: number; items: Item[]; style: Style }
interface Hr { kind: "hr"; rule: Rule }
interface FigB { kind: "fig"; fig: Fig }
interface Abs { img: PdfImage; page: number }
type Block = Para | List | Hr | FigB;

interface Ctx { L: number; R: number; baseLH: number; fills: PdfBox[]; edges?: number[] }

function alignOf(l: Line, L: number, R: number, edges: number[] = []): "left" | "center" | "right" {
    // a line starting where another line of the region starts is left-aligned, however far it happens to reach
    if (l.tabs || l.bullet || edges.filter((x) => Math.abs(x - l.x0) <= 1).length > 1) return "left";
    const tol = Math.max(2, 0.3 * l.size);
    if (l.x0 - L > 1.5 * l.size && Math.abs((l.x0 + l.x1) / 2 - (L + R) / 2) <= tol) return "center";
    if (l.x0 - L > 1.5 * l.size && Math.abs(l.x1 - R) <= 1.5) return "right";
    return "left";
}

/** the previous line ended because the next word would not fit — i.e. the two lines are one paragraph */
function wrapped(prev: Line, next: Line, align: string, L: number, R: number): boolean {
    const word = /^\S+/.exec(next.text.trim())?.[0] ?? "";
    const chars = Math.max(1, next.text.trim().length);
    const wordW = ((next.x1 - next.x0) * word.length) / chars;
    const space = 0.25 * prev.size;
    if (align === "left") return prev.x1 + space + wordW >= R - Math.max(1, 0.2 * prev.size);
    return prev.x1 - prev.x0 + space + wordW >= R - L - 2;
}

const lineLead = (a: Line, b: Line) => b.baseline - a.baseline;

function joinText(prev: Line): "" | " " {
    if (/\u00ad$/.test(prev.text)) { const r = prev.runs[prev.runs.length - 1]; r.text = r.text.replace(/\u00ad$/, ""); return ""; }
    // browsers and Word break AFTER an existing hyphen ("self-" / "serve"); keep it, add no space
    if (/[A-Za-z]-$/.test(prev.text.trimEnd())) return "";
    return " ";
}

function buildBlocks(elems: Elem[], ctx: Ctx, pageOf: (e: Elem) => number): Block[] {
    const { L, R } = ctx;
    const blocks: Block[] = [];
    let stack: List[] = [];                 // open lists, outermost first
    const lastItem = () => { const l = stack[stack.length - 1]; return l?.items[l.items.length - 1]; };
    const sorted = [...elems].sort((a, b) => a.top - b.top || a.x0 - b.x0);
    ctx.edges = elems.filter((e) => e.kind === "line").map((e) => e.x0);
    for (const e of sorted) {
        if (e.kind === "rule") { stack = []; blocks.push({ kind: "hr", rule: e }); continue; }
        if (e.kind === "fig") { stack = []; blocks.push({ kind: "fig", fig: e }); continue; }
        const line = e;
        if (line.bullet) {
            const b = line.bullet;
            while (stack.length && b.markerX < stack[stack.length - 1].markerX - 2) stack.pop();
            const top = stack[stack.length - 1], item: Item = { lines: [line], brs: new Set(), children: [] };
            if (top && Math.abs(top.markerX - b.markerX) <= 2 && top.tag === b.list && lineLead(lastLine(top), line) < 4 * line.size) { top.items.push(item); continue; }
            const list: List = { kind: "list", tag: b.list, type: b.type, markerX: b.markerX, textX: line.x0, items: [item], style: line.style };
            if (top && b.markerX > top.markerX + 2 && lineLead(lastLine(top), line) < 4 * line.size) { top.items[top.items.length - 1].children.push(list); stack.push(list); continue; }
            stack = [list];
            blocks.push(list);
            continue;
        }
        // a line under an open list item, indented to its text: the item wraps (or has a second line)
        const it = lastItem(), open = stack[stack.length - 1];
        if (it && open && !line.tabs) {
            const prev = it.lines[it.lines.length - 1], lead = lineLead(prev, line);
            if (Math.abs(line.x0 - open.textX) <= 2.5 && lead >= 0.8 * line.size && lead <= 1.8 * line.size && Math.abs(line.size - prev.size) <= 1) {
                if (!wrapped(prev, line, "left", L, R)) it.brs.add(it.lines.length);
                it.lines.push(line);
                continue;
            }
        }
        stack = [];
        const para = blocks[blocks.length - 1];
        if (para && para.kind === "p" && canJoin(para, line, ctx, pageOf)) { para.lines.push(line); continue; }
        blocks.push({ kind: "p", lines: [line], style: line.style, align: alignOf(line, L, R, ctx.edges) });
    }
    return blocks;
}

const lastLine = (l: List): Line => { const it = l.items[l.items.length - 1]; const c = it.children[it.children.length - 1]; return c ? lastLine(c) : it.lines[it.lines.length - 1]; };

function canJoin(p: Para, line: Line, ctx: Ctx, pageOf: (e: Elem) => number): boolean {
    const prev = p.lines[p.lines.length - 1];
    if (prev.tabs || line.tabs || !sameStyle(p.style, line.style) && !sameStyle(prev.style, line.style)) return false;
    const lead = lineLead(prev, line);
    // a gap wider than the document's usual line spacing is a paragraph break, even where the words would wrap
    if (lead < 0.8 * line.size || lead > 1.8 * line.size || (p.lines.length === 1 && lead > (ctx.baseLH + 0.3) * line.size)) return false;
    if (p.lines.length > 1 && Math.abs(lead - lineLead(p.lines[0], p.lines[1])) > Math.max(1, 0.15 * line.size) && pageOf(prev) === pageOf(line)) return false;
    const a = alignOf(line, ctx.L, ctx.R, ctx.edges);
    if (p.align === "left") {
        const ref = p.lines.length > 1 ? p.lines[1].x0 : p.lines[0].x0;
        if (Math.abs(line.x0 - ref) > (p.lines.length > 1 ? 2 : 4 * line.size)) return false;
        if (line.x0 < ctx.L - 1) return false;
    } else if (a !== p.align && !(line.x1 - line.x0 > 0.9 * (ctx.R - ctx.L))) return false;
    return wrapped(prev, line, p.align, ctx.L, ctx.R);
}

/* ---------------- HTML ---------------- */

interface Base { family: string; size: number; color: string; lh: number }

function runsHtml(runs: Run[], s: Style): string {
    // merge neighbours that look the same, then wrap each in what differs from the block's own style
    const key = (r: Run) => r.tab || r.img ? `#${Math.random()}` : `${r.family}|${r.size}|${r.weight}|${r.italic}|${r.color}|${r.href}|${r.u}|${r.vshift}`;
    const merged: Run[] = [];
    for (const r of runs) { const m = merged[merged.length - 1]; if (m && key(m) === key(r)) m.text += r.text; else merged.push({ ...r }); }
    let out = "", href: string | undefined, anchor = "";
    const close = () => {
        // a link's box often takes in the spaces either side of its words; they belong outside the <a>
        if (href !== undefined) { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(anchor)!; out += `${m[1]}<a href="${escAttr(href)}">${m[2]}</a>${m[3]}`; }
        href = undefined; anchor = "";
    };
    for (const r of merged) {
        let h: string;
        if (r.tab) h = `<span data-flow-tab="${r.tab.align}" data-flow-pos="${r2(r.tab.pos)}"></span>`;
        else if (r.img) h = `<img src="${escAttr(r.img.dataUri)}" style="width: ${pt(r.img.w)}; height: ${pt(r.img.h)}">`;
        else {
            h = esc(r.text);
            const span = styleAttr({
                "font-family": r.family !== s.family ? r.family : "", "font-size": Math.abs(r.size - s.size) > 0.25 && !r.vshift ? pt(r.size) : "",
                color: r.color !== s.color ? r.color : "", "font-weight": r.weight >= 600 && s.weight >= 600 && r.weight !== s.weight ? String(r.weight) : r.weight < 600 && s.weight >= 600 ? String(r.weight) : r.weight >= 600 && r.weight !== 700 && s.weight < 600 ? String(r.weight) : "",
                "font-style": !r.italic && s.italic ? "normal" : "",
            });
            if (span) h = `<span style="${escAttr(span)}">${h}</span>`;
            if (r.weight === 700 && s.weight < 600) h = `<strong>${h}</strong>`;
            if (r.italic && !s.italic) h = `<em>${h}</em>`;
            if (r.u) h = `<u>${h}</u>`;
            if (r.vshift) h = `<${r.vshift}>${h}</${r.vshift}>`;
        }
        if (r.href !== href) close();
        if (r.href !== undefined && !r.tab) { href = r.href; anchor += h; } else out += h;
    }
    close();
    return out;
}

function linesHtml(lines: Line[], s: Style, brs?: Set<number>): string {
    let out = "";
    lines.forEach((l, i) => {
        if (i > 0) {
            const j = brs?.has(i) ? "br" : joinText(lines[i - 1]);
            out = out.replace(/\s+$/, "") + (j === "br" ? "<br>" : j);
        }
        out += runsHtml(l.runs, s).replace(/^\s+/, "");
    });
    return out.replace(/\s+$/, "");
}

function styleProps(s: Style, base: Base): Record<string, string> {
    return {
        "font-family": s.family !== base.family ? s.family : "", "font-size": Math.abs(s.size - base.size) > 0.25 ? pt(s.size) : "",
        color: s.color !== base.color ? s.color : "", "font-weight": s.weight !== 400 ? String(s.weight) : "", "font-style": s.italic ? "italic" : "",
    };
}

/** vertical extent of a block's CSS boxes: text lines are centred in their line-height, so the box reaches half the
 *  leading beyond the glyphs */
function extent(b: Block, ctx: Ctx): { top: number; bottom: number } {
    const text = (ls: Line[], lh: number) => { const f = ls[0], l = ls[ls.length - 1]; return { top: f.top - halfLead(f, lh), bottom: l.bottom + halfLead(l, lh) }; };
    switch (b.kind) {
        case "p": return text(b.lines, lhOf(b.lines, ctx.baseLH));
        case "list": { const all = listLines(b); return { top: text(all, ctx.baseLH).top, bottom: text(all, ctx.baseLH).bottom }; }
        case "hr": return { top: b.rule.top, bottom: b.rule.bottom };
        case "fig": return { top: b.fig.top, bottom: b.fig.bottom };
    }
}
const listLines = (l: List): Line[] => l.items.flatMap((i) => [...i.lines, ...i.children.flatMap(listLines)]);
const halfLead = (l: Line, lh: number) => Math.max(0, (lh * l.size - (l.bottom - l.top)) / 2);
function lhOf(lines: Line[], fallback: number): number {
    if (lines.length < 2) return fallback;
    const leads = lines.slice(1).map((l, i) => lineLead(lines[i], l)).filter((d) => d > 0).sort((a, b) => a - b);
    return leads.length ? r2(leads[Math.floor(leads.length / 2)] / lines[0].size) : fallback;
}

const absHtml = (a: Abs) => `<div data-flow-abs style="${styleAttr({ top: pt(a.img.y), left: pt(a.img.x), width: pt(a.img.w), height: pt(a.img.h) })}" data-flow-page="${a.page}"><figure><img src="${escAttr(a.img.dataUri)}" style="width: ${pt(a.img.w)}; height: ${pt(a.img.h)}"></figure></div>`;

function renderBlocks(blocks: Block[], ctx: Ctx, base: Base, prevBottom: number | null): { html: string; bottom: number | null } {
    const { L, R } = ctx;
    // a rule directly under a paragraph it spans (a heading's underline) becomes that paragraph's border-bottom
    blocks = blocks.filter((b, i) => {
        const p = blocks[i - 1];
        if (b.kind !== "hr" || !p || p.kind !== "p" || p.border) return true;
        const gap = b.rule.top - p.lines[p.lines.length - 1].bottom;
        if (gap > Math.max(3, 0.5 * p.style.size) || b.rule.x0 > Math.min(...p.lines.map((l) => l.x0)) + 3 || b.rule.x1 < Math.max(...p.lines.map((l) => l.x1)) - 2) return true;
        p.border = b.rule;
        return false;
    });
    let html = "";
    for (const b of blocks) {
        const ext = extent(b, ctx);
        const mt = prevBottom === null ? 0 : half(Math.max(0, ext.top - prevBottom));
        const margin = mt >= 0.5 ? pt(mt) : "";
        if (b.kind === "hr") {
            html += `<hr style="${styleAttr({ "border-top": `${pt(b.rule.bottom - b.rule.top)} solid ${b.rule.color}`, "margin-top": margin, "margin-bottom": "0pt" })}">`;
            prevBottom = b.rule.bottom;
        } else if (b.kind === "fig") {
            const f = b.fig, mid = (f.x0 + f.x1) / 2;
            const align = Math.abs(mid - (L + R) / 2) < 4 ? "center" : Math.abs(f.x1 - R) < 3 ? "right" : "left";
            html += `<figure style="${styleAttr({ "text-align": align, "margin-top": margin, "margin-left": align === "left" && f.x0 - L > 1 ? pt(f.x0 - L) : "" })}"><img src="${escAttr(f.img.dataUri)}" style="width: ${pt(f.img.w)}; height: ${pt(f.img.h)}"></figure>`;
            prevBottom = f.bottom;
        } else if (b.kind === "p") {
            const lines = b.lines, lh = lhOf(lines, ctx.baseLH);
            const contX = lines.length > 1 ? lines[1].x0 : lines[0].x0;
            const lx0 = Math.min(...lines.map((l) => l.x0)), lx1 = Math.max(...lines.map((l) => l.x1));
            const fill = ctx.fills.find((f) => f.x <= lx0 + 1 && f.x + f.w >= lx1 - 1 && f.y <= lines[0].top + 1 && f.y + f.h >= lines[lines.length - 1].bottom - 1 && f.h < lines[lines.length - 1].bottom - lines[0].top + 3 * b.style.size);
            const st = styleAttr({
                ...styleProps(b.style, base),
                "text-align": b.align !== "left" ? b.align : "",
                "margin-top": margin,
                "margin-left": b.align === "left" && contX - L > 1 ? pt(contX - L) : "",
                "text-indent": lines.length > 1 && b.align === "left" && Math.abs(lines[0].x0 - contX) > 1 ? pt(lines[0].x0 - contX) : "",
                "line-height": lines.length > 1 && Math.abs(lh - base.lh) > 0.02 ? String(lh) : "",
                "background-color": fill?.color || "",
                "border-bottom": b.border ? `${pt(b.border.bottom - b.border.top)} solid ${b.border.color}` : "",
                "padding-bottom": b.border && half(b.border.top - ext.bottom) >= 0.5 ? pt(half(b.border.top - ext.bottom)) : "",
            });
            html += `<p${st ? ` style="${escAttr(st)}"` : ""}>${linesHtml(lines, b.style)}</p>`;
            prevBottom = b.border ? b.border.bottom : ext.bottom;
        } else {
            html += listHtml(b, base, ctx, margin, L);
            prevBottom = ext.bottom;
        }
    }
    return { html, bottom: prevBottom };
}

function listHtml(l: List, base: Base, ctx: Ctx, margin: string, L: number): string {
    const multi = l.items.find((i) => i.lines.length > 1);
    const lh = multi ? lhOf(multi.lines, ctx.baseLH) : ctx.baseLH;
    const def = l.tag === "ul" ? "disc" : "decimal";
    const st = styleAttr({ ...styleProps(l.style, base), "margin-top": margin, "margin-left": pt(Math.max(0, l.textX - L)), "list-style-type": l.type !== def ? l.type : "", "line-height": Math.abs(lh - base.lh) > 0.02 ? String(lh) : "" });
    let prev: Line | null = null;
    const items = l.items.map((it) => {
        let mt = "";
        if (prev) {
            const gap = it.lines[0].top - halfLead(it.lines[0], ctx.baseLH) - (prev.bottom + halfLead(prev, ctx.baseLH));
            if (half(gap) >= 0.5) mt = pt(half(gap));
        }
        const last = it.children.length ? lastLine(it.children[it.children.length - 1]) : it.lines[it.lines.length - 1];
        prev = last;
        // an item set differently from the list's first one (a bold item among plain ones) carries its own style
        const s = dominant(it.lines.flatMap((x) => x.runs)), mine = styleProps(s, base), theirs = styleProps(l.style, base);
        const own = styleAttr({ ...Object.fromEntries(Object.entries(mine).map(([k, v]) => [k, v === theirs[k] ? "" : v || (k === "font-weight" ? "400" : k === "font-style" ? "normal" : "")])), "margin-top": mt });
        const kids = it.children.map((c) => listHtml(c, base, ctx, "", l.textX)).join("");
        return `<li${own ? ` style="${escAttr(own)}"` : ""}>${linesHtml(it.lines, sameStyle(s, l.style) ? l.style : s, it.brs)}${kids}</li>`;
    }).join("");
    return `<${l.tag}${st ? ` style="${escAttr(st)}"` : ""}>${items}</${l.tag}>`;
}

/* ---------------- the whole document ---------------- */

export function layoutToFlow(pages: PdfPage[], opts: LayoutOptions = {}): FlowResult {
    const warnings = [...(opts.warnings || [])];
    const used = new Set<PdfBox>();
    const runs = pages.map((p) => pageRuns(p, used));
    const frags = runs.map(toFrags);
    const chars = frags.reduce((n, fs) => n + fs.reduce((m, f) => m + fragText(f).length, 0), 0);

    // a scan: next to no text, and pictures that cover the pages
    const pageSized = (p: PdfPage) => p.images.some((im) => im.w * im.h >= 0.5 * p.width * p.height);
    if (chars < 20 * pages.length && pages.length && pages.filter(pageSized).length >= Math.ceil(pages.length / 2)) {
        const html = pages.flatMap((p) => p.images.filter((im) => im.dataUri && im.w * im.h >= 0.5 * p.width * p.height)
            .map((im) => `<figure style="text-align: center"><img src="${escAttr(im.dataUri)}" style="width: ${pt(im.w)}; height: ${pt(im.h)}"></figure>`)).join("");
        return { html, title: opts.title, page: pages[0] ? { widthPt: r2(pages[0].width), heightPt: r2(pages[0].height) } : undefined, warnings: [...warnings, "The pages are pictures, so they came in as pictures."], needsAi: SCAN_MESSAGE };
    }
    if (!chars) return { html: "", title: opts.title, warnings: [...warnings, "The PDF has no text IcedCoffee could read."], needsAi: "This PDF has no readable text (its letters may be drawn as shapes). IcedCoffee can only read it with an AI that can see images." };

    const furniture = dropPageFurniture(pages, frags);
    if (furniture) warnings.push("Running headers, footers and page numbers were left out.");

    // margins from what is printed (over every page: the last page of a résumé rarely reaches the bottom)
    const W = pages[0].width, H = pages[0].height;
    const allF = frags.flat();
    const x0 = Math.min(...allF.map((f) => f.x0)), x1 = Math.max(...allF.map((f) => f.x1));
    const y0 = Math.min(...frags.map((fs) => Math.min(...fs.map((f) => f.top)))), y1 = Math.max(...allF.map((f) => f.bottom));
    let mr = Math.max(0, W - x1), mb = Math.max(0, H - y1);
    const ml = Math.max(0, x0), mt = Math.max(0, y0);
    if (mr > 2 * ml + 18) mr = ml;                      // ragged text never reached the right margin
    if (mb > 1.5 * mt + 18) mb = mt;                    // the text stops before the page does
    const page: FlowPage = { widthPt: r2(W), heightPt: r2(H), marginTopPt: half(mt), marginBottomPt: half(mb), marginLeftPt: half(ml), marginRightPt: half(mr) };
    const L = x0, R = x1;

    // base style: the style most characters are set in, and the most common line spacing
    const tally = new Map<string, number>();
    for (const f of allF) for (const r of f.runs) { const k = `${r.family}|${r.size}|${r.color}`; tally.set(k, (tally.get(k) || 0) + r.text.length); }
    const [bf, bs, bc] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split("|");
    const baseStyle = { family: bf, size: Number(bs), color: bc };

    // per page: bands of flow and columns, each turned into lines
    type Seg = { kind: "flow"; elems: Elem[]; L: number; R: number } | { kind: "cols"; cols: { elems: Elem[]; L: number; R: number }[] };
    const segs: { seg: Seg; page: number; pageStart: boolean; abs: Abs[] }[] = [];
    const elemPage = new Map<Elem, number>();
    let absCount = 0;
    pages.forEach((p, pi) => {
        const boxes: Box[] = [
            ...frags[pi].map((f) => ({ x0: f.x0, x1: f.x1, top: f.top, bottom: f.bottom, frag: f })),
            ...(p.marks || []).map((m) => ({ x0: m.x, x1: m.x + m.w, top: m.y, bottom: m.y + m.h, mark: m })),
            ...p.rules.filter((r) => !used.has(r) && r.w >= 3 * r.h && r.w >= 12).map((r) => ({ x0: r.x, x1: r.x + r.w, top: r.y, bottom: r.y + r.h, rule: r })),
            ...p.images.filter((im) => im.dataUri && im.w * im.h < 0.8 * p.width * p.height).map((im) => ({ x0: im.x, x1: im.x + im.w, top: im.y, bottom: im.y + im.h, img: im })),
        ];
        if (p.images.some((im) => im.dataUri && im.w * im.h >= 0.8 * p.width * p.height)) warnings.push("A full-page background picture was left out.");
        const toElems = (bs: Box[], l: number, r: number): { elems: Elem[]; abs: Abs[] } => {
            const lines = buildLines(bs.filter((b) => b.frag).map((b) => b.frag!), bs.filter((b) => b.mark).map((b) => b.mark!), l, r);
            const elems: Elem[] = [...lines];
            const abs: Abs[] = [];
            for (const b of bs) {
                if (b.rule) elems.push({ kind: "rule", x0: b.x0, x1: b.x1, top: b.top, bottom: b.bottom, color: b.rule.color || "#000000" });
                if (!b.img) continue;
                const im = b.img, cy = im.y + im.h / 2;
                const host = lines.find((ln) => im.h <= 1.6 * ln.size && cy >= ln.top - 1 && cy <= ln.bottom + 1 && im.x + im.w >= ln.x0 - 3 * ln.size && im.x <= ln.x1 + 3 * ln.size);
                if (host) { insertImg(host, im); continue; }
                if (lines.some((ln) => ln.top < im.y + im.h && ln.bottom > im.y)) { abs.push({ img: im, page: pi }); absCount++; continue; }
                elems.push({ kind: "fig", img: im, x0: im.x, x1: im.x + im.w, top: im.y, bottom: im.y + im.h });
            }
            elems.forEach((e) => elemPage.set(e, pi));
            return { elems, abs };
        };
        splitRegion(boxes, L, R).forEach((s, si) => {
            if (s.kind === "flow") { const t = toElems(s.boxes, L, R); segs.push({ seg: { kind: "flow", elems: t.elems, L, R }, page: pi, pageStart: si === 0, abs: t.abs }); return; }
            const side = (bs: Box[]) => { const l = Math.min(...bs.map((b) => b.x0)), r = Math.max(...bs.map((b) => b.x1)); return { ...toElems(bs, l, r), L: l, R: r }; };
            const a = side(s.left), b = side(s.right);
            segs.push({ seg: { kind: "cols", cols: [{ elems: a.elems, L: a.L, R: a.R }, { elems: b.elems, L: b.L, R: b.R }] }, page: pi, pageStart: si === 0, abs: [...a.abs, ...b.abs] });
        });
    });
    if (absCount) warnings.push(`${absCount === 1 ? "A picture" : `${absCount} pictures`} beside the text ${absCount === 1 ? "was" : "were"} placed at ${absCount === 1 ? "its" : "their"} spot on the page.`);

    // a flow (or a pair of columns) that runs over a page break continues: page 2's lines are moved up to follow
    // page 1's last line at its own spacing, so a paragraph or list split by the break joins up again
    const merged: typeof segs = [];
    const follow = (a: Elem[], b: Elem[]) => {
        const la = [...a].reverse().find((e): e is Line => e.kind === "line"), fb = b.filter((e): e is Line => e.kind === "line").sort((x, y) => x.top - y.top)[0];
        if (!la || !fb) return;
        const off = la.baseline + la.size * 1.2 - fb.baseline;
        const endA = Math.max(...a.map((e) => e.bottom));
        const shift = Math.max(off, endA - Math.min(...b.map((e) => e.top)));
        for (const e of b) { e.top += shift; e.bottom += shift; if (e.kind === "line") { e.baseline += shift; } }
        a.push(...b);
    };
    for (const s of segs) {
        const prev = merged[merged.length - 1];
        if (prev && s.pageStart && prev.page === s.page - 1) {
            if (prev.seg.kind === "flow" && s.seg.kind === "flow" && Math.abs(prev.seg.L - s.seg.L) < 2) { follow(prev.seg.elems, s.seg.elems); prev.abs.push(...s.abs); prev.page = s.page; continue; }
            if (prev.seg.kind === "cols" && s.seg.kind === "cols" && prev.seg.cols.every((c, i) => Math.abs(c.L - (s.seg as { cols: { L: number }[] }).cols[i].L) < 4)) {
                prev.seg.cols.forEach((c, i) => { follow(c.elems, (s.seg as { cols: { elems: Elem[] }[] }).cols[i].elems); c.R = Math.max(c.R, (s.seg as { cols: { R: number }[] }).cols[i].R); });
                prev.abs.push(...s.abs); prev.page = s.page; continue;
            }
        }
        merged.push(s);
    }

    // line spacing most multi-line paragraphs use: the document's own
    const leads: number[] = [];
    for (const s of merged) for (const c of s.seg.kind === "flow" ? [s.seg] : s.seg.cols) {
        const ls = c.elems.filter((e): e is Line => e.kind === "line").sort((a, b) => a.top - b.top);
        for (let i = 1; i < ls.length; i++) { const d = lineLead(ls[i - 1], ls[i]); if (!ls[i].tabs && Math.abs(ls[i].size - ls[i - 1].size) < 0.3 && d > 0.9 * ls[i].size && d < 1.8 * ls[i].size) leads.push(r2(d / ls[i].size)); }
    }
    leads.sort((a, b) => a - b);
    const baseLH = leads.length ? leads[Math.floor(leads.length / 2)] : 1.2;
    const base: Base = { ...baseStyle, lh: baseLH };

    let html = "", prevBottom: number | null = null;
    const fills = pages.flatMap((p) => (p.fills || []).filter((f) => f.color && f.color !== "#ffffff" && f.w * f.h < 0.5 * p.width * p.height));
    for (const s of merged) {
        if (s.pageStart) prevBottom = null;
        const pageOf = (e: Elem) => elemPage.get(e) ?? 0;
        html += s.abs.map(absHtml).join("");
        if (s.seg.kind === "flow") {
            const ctx = { L: s.seg.L, R: s.seg.R, baseLH, fills };
            const r = renderBlocks(buildBlocks(s.seg.elems, ctx, pageOf), ctx, base, prevBottom);
            html += r.html; prevBottom = r.bottom;
        } else {
            const cols = s.seg.cols.map((c) => ({ width: r2(c.R - c.L), blocks: buildBlocks(c.elems, { L: c.L, R: c.R, baseLH, fills }, pageOf), L: c.L, R: c.R }));
            let bottom = -Infinity;
            html += "<div data-flow-cols>" + cols.map((c) => {
                const ctx = { L: c.L, R: c.R, baseLH, fills };
                const r = renderBlocks(c.blocks, ctx, base, prevBottom);
                if (r.bottom !== null) bottom = Math.max(bottom, r.bottom);
                return `<div data-flow-col style="width: ${pt(c.width)}">${r.html}</div>`;
            }).join("") + "</div>";
            if (Number.isFinite(bottom)) prevBottom = bottom;
        }
    }

    return { html, title: opts.title, page, base: { fontFamily: base.family, fontSizePt: base.size, color: base.color, lineHeight: baseLH }, warnings };
}

function insertImg(line: Line, im: PdfImage) {
    const run: Run = { ...line.runs[0], text: "", tab: undefined, href: undefined, u: false, img: im, x0: im.x, x1: im.x + im.w };
    const i = line.runs.findIndex((r) => r.x0 >= im.x);
    if (i < 0) line.runs.push(run); else line.runs.splice(i, 0, run);
    line.x0 = Math.min(line.x0, im.x); line.x1 = Math.max(line.x1, im.x + im.w);
}
