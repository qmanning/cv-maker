// src/import/pdf.ts — PDF → FlowDoc. This half only EXTRACTS: pdf.js reads the text runs (with their real font
// names), walks each page's drawing operators for colours, rules, bullet dots and pictures, reads the link
// annotations, and renders the page to a canvas to crop the pictures out. pdf-layout.ts then rebuilds paragraphs,
// lists and columns from those positions — pure geometry, testable in node.
//
// pdf.js is loaded lazily (index.ts imports this module on demand, and this module imports pdf.js on demand), so
// nobody downloads it until they import a PDF. Its worker ships next to the bundle: build.mjs copies
// pdfjs-dist/build/pdf.worker.min.mjs to dist/pdf.worker.min.mjs.
import type { FlowResult } from "./flow";
import { layoutToFlow, type PdfBox, type PdfImage, type PdfLink, type PdfMark, type PdfPage, type PdfTextItem } from "./pdf-layout";

type PdfJs = typeof import("pdfjs-dist");
type PageProxy = Awaited<ReturnType<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>["getPage"]>>;

/** the bit of a canvas this needs: HTMLCanvasElement in the app, anything canvas-shaped elsewhere */
export interface CanvasLike { width: number; height: number; getContext(type: "2d"): unknown; toDataURL(type?: string, quality?: number): string }
export interface PdfDeps {
    /** the pdf.js module (tests pass the legacy build; the app loads the modern one) */
    pdfjs?: PdfJs;
    /** makes a canvas to render pages into, for cropping pictures; null → pictures are left out */
    canvas?: ((width: number, height: number) => CanvasLike) | null;
}

const SCALE = 2;   // pictures are cropped from a 2× render: 144 dpi, sharp enough for a logo or a head shot

type M = number[];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const hex = (c: unknown): string => {
    if (typeof c === "string") return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : "#000000";
    if (Array.isArray(c) || ArrayBuffer.isView(c)) { const a = Array.from(c as ArrayLike<number>); return "#" + a.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join(""); }
    return "#000000";
};

interface Drawn { items: { x: number; y: number; color: string }[]; rules: PdfBox[]; marks: PdfMark[]; fills: PdfBox[]; graphics: PdfBox[]; images: { x: number; y: number; w: number; h: number }[] }

/** walk the operator list with a small graphics-state machine: pdf.js's text content has no colours and no
 *  shapes, so text starts (for colour), paths (rules, bullets, shaded boxes, drawings) and picture placements
 *  are all read from here, in viewport coordinates (pt, top-left origin) */
function walk(OPS: PdfJs["OPS"], fnArray: number[], argsArray: unknown[][], base: M): Drawn {
    const out: Drawn = { items: [], rules: [], marks: [], fills: [], graphics: [], images: [] };
    let g = { ctm: base, fill: "#000000", stroke: "#000000", lw: 1, fillNone: false };
    const stack: (typeof g)[] = [];
    let tm: M = [1, 0, 0, 1, 0, 0], tx = 0, ty = 0, lineX = 0, lineY = 0, size = 0, cs = 0, ws = 0, hs = 1, lead = 0, rise = 0;
    const textStart = () => { const [x, y] = apply(mul(g.ctm, tm), tx, ty + rise); out.items.push({ x, y, color: g.fill }); };
    const advance = (glyphs: unknown[]) => {
        for (const gl of glyphs) {
            if (typeof gl === "number") tx -= (gl * size) / 1000 * hs;
            else if (gl && typeof gl === "object") { const o = gl as { width?: number; isSpace?: boolean }; tx += ((o.width || 0) * size / 1000 + cs + (o.isSpace ? ws : 0)) * hs; }
        }
    };
    const show = (glyphs: unknown) => { textStart(); if (Array.isArray(glyphs)) advance(glyphs); };
    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i], a = argsArray[i] || [];
        switch (fn) {
            case OPS.save: stack.push({ ...g }); break;
            case OPS.restore: g = stack.pop() || g; break;
            case OPS.transform: g.ctm = mul(g.ctm, a as M); break;
            case OPS.paintFormXObjectBegin: stack.push({ ...g }); if (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) g.ctm = mul(g.ctm, Array.from(a[0] as ArrayLike<number>)); break;
            case OPS.paintFormXObjectEnd: g = stack.pop() || g; break;
            case OPS.setFillRGBColor: g.fill = hex(a[0]); g.fillNone = false; break;
            case OPS.setStrokeRGBColor: g.stroke = hex(a[0]); break;
            case OPS.setFillTransparent: g.fillNone = true; break;
            case OPS.setLineWidth: g.lw = Number(a[0]) || 0; break;
            case OPS.setGState: for (const [k, v] of (a[0] as [string, unknown][]) || []) if (k === "LW") g.lw = Number(v) || 0; break;
            case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; tx = ty = lineX = lineY = 0; break;
            case OPS.setTextMatrix: tm = Array.from((Array.isArray(a[0]) || ArrayBuffer.isView(a[0]) ? a[0] : a) as ArrayLike<number>); tx = ty = lineX = lineY = 0; break;
            case OPS.setFont: size = Number(a[1]) || 0; break;
            case OPS.setCharSpacing: cs = Number(a[0]) || 0; break;
            case OPS.setWordSpacing: ws = Number(a[0]) || 0; break;
            case OPS.setHScale: hs = (Number(a[0]) || 100) / 100; break;
            case OPS.setLeading: lead = -Number(a[0]) || 0; break;
            case OPS.setTextRise: rise = Number(a[0]) || 0; break;
            case OPS.setLeadingMoveText: lead = Number(a[1]) || 0; tx = lineX += Number(a[0]) || 0; ty = lineY += Number(a[1]) || 0; break;
            case OPS.moveText: tx = lineX += Number(a[0]) || 0; ty = lineY += Number(a[1]) || 0; break;
            case OPS.nextLine: tx = lineX; ty = lineY += lead; break;
            case OPS.showText: case OPS.showSpacedText: show(a[0]); break;
            case OPS.nextLineShowText: tx = lineX; ty = lineY += lead; show(a[0]); break;
            case OPS.nextLineSetSpacingShowText: ws = Number(a[0]) || 0; cs = Number(a[1]) || 0; tx = lineX; ty = lineY += lead; show(a[2]); break;
            case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageXObjectRepeat: case OPS.paintImageMaskXObject: {
                const pts = [apply(g.ctm, 0, 0), apply(g.ctm, 1, 0), apply(g.ctm, 0, 1), apply(g.ctm, 1, 1)];
                const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
                const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
                if (box.w >= 4 && box.h >= 4) out.images.push(box);
                break;
            }
            case OPS.constructPath: path(out, g, a);
        }
    }
    return out;

    function path(o: Drawn, st: typeof g, a: unknown[]) {
        const op = Number(a[0]);
        const filled = op === OPS.fill || op === OPS.eoFill || op >= OPS.fillStroke && op <= OPS.closeEOFillStroke;
        const stroked = op === OPS.stroke || op === OPS.closeStroke || op >= OPS.fillStroke && op <= OPS.closeEOFillStroke;
        if (!filled && !stroked) return;                         // a clip path
        const data = (a[1] as unknown[])?.[0] as ArrayLike<number> | undefined;
        if (!data || !data.length) return;
        const pts: [number, number][] = [];
        let curves = false;
        for (let k = 0; k < data.length;) {
            const c = data[k++];
            const n = c === 0 || c === 1 ? 2 : c === 2 ? 6 : c === 3 ? 4 : 0;
            if (c === 2 || c === 3) curves = true;
            for (let j = 0; j < n; j += 2) pts.push(apply(st.ctm, data[k + j], data[k + j + 1]));
            k += n;
        }
        if (!pts.length) return;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        let x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
        const axis = !curves && pts.every((p) => pts.some((q) => q !== p && (Math.abs(q[0] - p[0]) < 0.01 || Math.abs(q[1] - p[1]) < 0.01)));
        const scale = Math.hypot(st.ctm[0], st.ctm[1]) || 1;
        if (stroked && !filled && axis && h < 0.5 && w > 2) {        // a stroked horizontal line
            const t = Math.max(0.25, st.lw * scale);
            o.rules.push({ x, y: y - t / 2, w, h: t, color: st.stroke });
            return;
        }
        if (filled && !st.fillNone && axis && pts.length <= 5) {
            if (h <= 3 && w >= 3 * h && w >= 2) o.rules.push({ x, y, w, h, color: st.fill });
            else if (w <= 7 && h <= 7 && w >= 1 && h >= 1 && w / h > 0.5 && w / h < 2) o.marks.push({ x, y, w, h, color: st.fill, shape: "square" });
            else if (w > 3 && h > 3) o.fills.push({ x, y, w, h, color: st.fill });
            return;
        }
        if (w <= 7 && h <= 7 && w >= 1 && h >= 1 && w / h > 0.5 && w / h < 2 && curves) {
            o.marks.push({ x, y, w, h, color: filled ? st.fill : st.stroke, shape: filled && !st.fillNone ? "disc" : "circle" });
            return;
        }
        if (stroked) { const t = st.lw * scale / 2; x -= t; y -= t; w += 2 * t; h += 2 * t; }
        if (w >= 1 && h >= 1) o.graphics.push({ x, y, w, h, color: filled ? st.fill : st.stroke });
    }
}

/** drawings (logo, icons) are many small paths: merge touching bounding boxes into one picture each */
function cluster(boxes: PdfBox[]): PdfBox[] {
    const out = boxes.map((b) => ({ ...b }));
    for (let merged = true; merged;) {
        merged = false;
        for (let i = 0; i < out.length && !merged; i++) for (let j = i + 1; j < out.length; j++) {
            const a = out[i], b = out[j];
            if (a.x > b.x + b.w + 1 || b.x > a.x + a.w + 1 || a.y > b.y + b.h + 1 || b.y > a.y + a.h + 1) continue;
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
            out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, color: a.color };
            out.splice(j, 1); merged = true; break;
        }
    }
    return out;
}

const cleanTitle = (t: unknown): string | undefined => {
    const s = String(t || "").replace(/^Microsoft (Word|PowerPoint) - /i, "").replace(/\.(docx?|pages|odt|rtf|pdf)$/i, "").trim();
    return s && !/^untitled/i.test(s) ? s : undefined;
};

function defaultCanvas(): PdfDeps["canvas"] {
    if (typeof document === "undefined") return null;
    return (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
}

async function loadPdfJs(): Promise<PdfJs> {
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        // this module is its own chunk in dist/chunks/, the worker sits in dist/ (build.mjs copies it there); if a
        // bundler ever inlines this module into the entry file instead, the worker is next to it
        const here = import.meta.url;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(/\/chunks\/[^/]*$/.test(here) ? "../pdf.worker.min.mjs" : "./pdf.worker.min.mjs", here).href;
    }
    return pdfjs;
}

export async function pdfToFlow(data: ArrayBuffer, name: string, deps: PdfDeps = {}): Promise<FlowResult> {
    const pdfjs = deps.pdfjs || (await loadPdfJs());
    const makeCanvas = deps.canvas === undefined ? defaultCanvas() : deps.canvas;
    const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), verbosity: 0 });   // a copy: pdf.js detaches the buffer it is given
    const doc = await task.promise;
    const warnings: string[] = [];
    let left = 0, rotated = 0;
    try {
        const pages: PdfPage[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
            const page = await doc.getPage(n);
            const vp = page.getViewport({ scale: 1 });
            const ops = await page.getOperatorList();                // also resolves the page's fonts into commonObjs
            const drawn = walk(pdfjs.OPS, ops.fnArray, ops.argsArray as unknown[][], vp.transform);
            const tc = await page.getTextContent({ includeMarkedContent: false });
            const byY = new Map<number, Drawn["items"]>();
            for (const d of drawn.items) { const k = Math.round(d.y); if (!byY.has(k)) byY.set(k, []); byY.get(k)!.push(d); }
            const colorAt = (x: number, y: number) => {
                let best: { x: number; color: string } | null = null;
                for (const k of [Math.round(y) - 1, Math.round(y), Math.round(y) + 1]) for (const d of byY.get(k) || []) if (Math.abs(d.y - y) < 1 && d.x <= x + 1 && (!best || d.x > best.x)) best = d;
                return best?.color || "#000000";
            };
            const items: PdfTextItem[] = [];
            for (const it of tc.items) {
                if (!("str" in it) || !it.str) continue;
                const m = mul(vp.transform, it.transform);
                if (Math.abs(m[1]) > 0.01 * Math.abs(m[0]) || m[0] <= 0) { if (it.str.trim()) rotated++; continue; }
                const size = Math.abs(m[3]) || Math.hypot(m[2], m[3]);
                const style = tc.styles[it.fontName] as { ascent?: number; fontFamily?: string } | undefined;
                let font: { name?: string; bold?: boolean; italic?: boolean; black?: boolean } | undefined;
                try { if (page.commonObjs.has(it.fontName)) font = page.commonObjs.get(it.fontName) as typeof font; } catch { /* not a loaded font */ }
                const ascent = style?.ascent && style.ascent > 0.3 ? style.ascent : 0.8;
                items.push({
                    str: it.str, x: m[4], y: m[5] - size * ascent, width: it.width, height: size, ascent,
                    fontName: font?.name || it.fontName, fontFamily: style?.fontFamily, bold: !!(font?.bold || font?.black) || undefined, italic: font?.italic || undefined,
                    color: colorAt(m[4], m[5]),
                });
            }
            const links: PdfLink[] = [];
            for (const an of (await page.getAnnotations()) as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]) {
                const href = an.url || (an.unsafeUrl && /^(https?:|mailto:|tel:)/i.test(an.unsafeUrl) ? an.unsafeUrl : "");
                if (an.subtype !== "Link" || !href || !an.rect) continue;
                const [x1, y1] = vp.convertToViewportPoint(an.rect[0], an.rect[1]), [x2, y2] = vp.convertToViewportPoint(an.rect[2], an.rect[3]);
                links.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), href });
            }

            // drawings worth keeping as pictures: a logo, a monogram, icons — not a shaded box behind a paragraph
            const textChars = items.reduce((k, i) => k + i.str.trim().length, 0);
            const inside = (b: PdfBox, i: PdfTextItem) => i.x >= b.x - 1 && i.x + i.width <= b.x + b.w + 1 && i.y >= b.y - 1 && i.y + i.height <= b.y + b.h + 1;
            const graphics = cluster(drawn.graphics).filter((b) => {
                if (b.w < 6 || b.h < 6 || b.w * b.h > 0.25 * vp.width * vp.height) return false;
                const txt = items.filter((i) => inside(b, i)).reduce((k, i) => k + i.str.trim().length, 0);
                return txt === 0 || (txt <= 3 && b.w / b.h <= 1.5 && b.h / b.w <= 1.5);
            });
            const wanted: { box: PdfBox; kind: "photo" | "drawing" }[] = [
                ...drawn.images.map((b) => ({ box: b, kind: "photo" as const })),
                ...graphics.map((b) => ({ box: b, kind: "drawing" as const })),
            ];
            // no text on the page: render the whole page (a scan, or text drawn as outlines)
            if (textChars < 5 && !drawn.images.some((b) => b.w * b.h >= 0.5 * vp.width * vp.height)) wanted.push({ box: { x: 0, y: 0, w: vp.width, h: vp.height }, kind: "photo" });
            const images: PdfImage[] = [];
            if (wanted.length && makeCanvas) {
                const crops = await crop(page, vp.width, vp.height, wanted, makeCanvas);
                crops.forEach((uri, k) => {
                    if (!uri) return;
                    const b = wanted[k].box;
                    images.push({ x: b.x, y: b.y, w: b.w, h: b.h, dataUri: uri });
                    // the letters of a monogram are in the picture now
                    if (wanted[k].kind === "drawing") for (let j = items.length - 1; j >= 0; j--) if (inside(b, items[j])) items.splice(j, 1);
                });
            } else left += wanted.length;
            pages.push({ width: vp.width, height: vp.height, items, images, rules: drawn.rules, marks: drawn.marks, fills: drawn.fills, links });
            page.cleanup();
        }
        if (left) warnings.push(`${left === 1 ? "A picture" : `${left} pictures`} could not be copied out of the PDF here.`);
        if (rotated) warnings.push("Some sideways or rotated text was left out.");
        const meta = await doc.getMetadata().catch(() => null);
        const title = cleanTitle((meta?.info as { Title?: string } | undefined)?.Title) || name;
        return layoutToFlow(pages, { title, warnings });
    } finally {
        await task.destroy();
    }
}

/** render the page once at 2× and cut each box out of it: robust against every image encoding (JPX, masks, SMasks,
 *  indexed colour) because pdf.js has already drawn it — and it is the only way to get a vector drawing at all */
async function crop(page: PageProxy, w: number, h: number, boxes: { box: PdfBox; kind: "photo" | "drawing" }[], make: (w: number, h: number) => CanvasLike): Promise<(string | null)[]> {
    try {
        const canvas = make(Math.ceil(w * SCALE), Math.ceil(h * SCALE));
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport: page.getViewport({ scale: SCALE }) }).promise;
        return boxes.map(({ box, kind }) => {
            const sx = Math.max(0, Math.floor(box.x * SCALE)), sy = Math.max(0, Math.floor(box.y * SCALE));
            const sw = Math.min(canvas.width - sx, Math.ceil(box.w * SCALE)), sh = Math.min(canvas.height - sy, Math.ceil(box.h * SCALE));
            if (sw < 2 || sh < 2) return null;
            const out = make(sw, sh);
            (out.getContext("2d") as CanvasRenderingContext2D).drawImage(canvas as unknown as CanvasImageSource, sx, sy, sw, sh, 0, 0, sw, sh);
            // photos compress far better as JPEG; drawings keep their hard edges as PNG (the render is opaque either way)
            return kind === "photo" ? out.toDataURL("image/jpeg", 0.9) : out.toDataURL("image/png");
        });
    } catch {
        return boxes.map(() => null);
    }
}
