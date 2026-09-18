// src/components/labs/cv-maker/export-docx.ts
// DOCX export. Word can't be pixel-matched, so this aims at a clean, ATS-readable document that
// keeps the design's structure: it walks the LIVE page and reads computed styles, so it works for
// any source HTML — real paragraphs and bullets, native Word columns for .cv-flow regions (the copy
// flows there too), borderless tables for side-by-side columns, live hyperlinks, page-number footer.

import {
    AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, ImageRun, LineRuleType, Packer,
    PageNumber, Paragraph, SectionType, Table, TableCell, TableLayoutType, TableRow, TextRun,
    VerticalAlign, WidthType,
    type IBorderOptions, type IParagraphOptions, type ISectionOptions, type ParagraphChild,
} from "docx";

const PX_TO_PT = 0.75;
const tw = (pt: number) => Math.round(pt * 20);              // points → twips
const px = (v: string) => (parseFloat(v) || 0) * PX_TO_PT;   // computed px → points

type Block = Paragraph | Table;
interface Flow { columns: number; gapPt: number; children: Block[] }
interface Opts { pageWPt: number; pageHPt: number; paginate: boolean; name: string }

function hex(color: string): string | undefined {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return undefined;
    const [r, g, b, a] = m[1].split(",").map((s) => parseFloat(s));
    if (a === 0) return undefined;
    return [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
}

function bottomRule(el: Element): IBorderOptions | undefined {
    const cs = getComputedStyle(el), w = parseFloat(cs.borderBottomWidth) || 0, color = hex(cs.borderBottomColor);
    if (!w || !color || cs.borderBottomStyle === "none") return undefined;
    return { style: BorderStyle.SINGLE, size: Math.max(2, Math.round(w * PX_TO_PT * 8)), color, space: Math.round(px(cs.paddingBottom)) };
}

// space (pt) and rule that follow `el`, including ancestors it is the last child of (up to the page)
function trailing(el: Element, stop: Element): { after: number; rule?: IBorderOptions } {
    let after = 0, rule: IBorderOptions | undefined, node: Element | null = el;
    while (node && node !== stop) {
        const cs = getComputedStyle(node), r = bottomRule(node);
        if (r && !rule) rule = r; else if (!r) after += px(cs.paddingBottom);
        after += Math.max(0, px(cs.marginBottom));
        const parent: Element | null = node.parentElement;
        if (!parent || parent === stop || parent.lastElementChild !== node || getComputedStyle(parent).display.includes("flex")) break;
        node = parent;
    }
    return { after, rule };
}
function leading(el: Element): number { const cs = getComputedStyle(el); return Math.max(0, px(cs.marginTop)) + px(cs.paddingTop); }

function underlined(el: Element, stop: Element): boolean {
    for (let n: Element | null = el; n && n !== stop.parentElement; n = n.parentElement) if (getComputedStyle(n).textDecorationLine.includes("underline")) return true;
    return false;
}

function runsOf(p: Element): ParagraphChild[] {
    const out: ParagraphChild[] = [];
    const visit = (node: Node, sink: ParagraphChild[]) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = (node.textContent || "").replace(/\s+/g, " ");
            if (!text) return;
            const el = node.parentElement as Element, cs = getComputedStyle(el), ls = px(cs.letterSpacing);
            sink.push(new TextRun({
                text, font: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(), size: Math.round(px(cs.fontSize) * 2),
                bold: (parseInt(cs.fontWeight, 10) || 400) >= 600, italics: cs.fontStyle === "italic",
                underline: underlined(el, p) ? {} : undefined, color: hex(cs.color),
                characterSpacing: ls ? Math.round(ls * 20) : undefined,
            }));
        } else if (node instanceof HTMLBRElement) {
            if (!node.classList.contains("ProseMirror-trailingBreak")) sink.push(new TextRun({ break: 1 }));
        } else if (node instanceof HTMLAnchorElement && node.getAttribute("href")) {
            const kids: ParagraphChild[] = [];
            node.childNodes.forEach((c) => visit(c, kids));
            if (kids.length) sink.push(new ExternalHyperlink({ link: node.href, children: kids }));
        } else node.childNodes.forEach((c) => visit(c, sink));
    };
    p.childNodes.forEach((c) => visit(c, out));
    return out;
}

function paraProps(p: Element): Partial<IParagraphOptions> & { spacing: { before: number; after: number; line?: number; lineRule?: (typeof LineRuleType)[keyof typeof LineRuleType] } } {
    const cs = getComputedStyle(p), fs = parseFloat(cs.fontSize) || 12, lh = parseFloat(cs.lineHeight);
    const align = cs.textAlign === "right" || cs.textAlign === "end" ? AlignmentType.RIGHT : cs.textAlign === "center" ? AlignmentType.CENTER : cs.textAlign === "justify" ? AlignmentType.JUSTIFIED : undefined;
    return {
        alignment: align,
        spacing: { before: tw(Math.max(0, px(cs.marginTop))), after: tw(Math.max(0, px(cs.marginBottom))), ...(Number.isFinite(lh) ? { line: Math.round((lh / fs) * 240), lineRule: LineRuleType.AUTO } : {}) },
    };
}

function regionBlocks(region: Element, page: Element): Block[] {
    const specs: { el: Element; bullet: boolean; rule?: boolean }[] = [];
    const collect = (parent: Element) => {
        for (const child of Array.from(parent.children)) {
            if (child.matches("ul, ol")) Array.from(child.children).forEach((li) => Array.from(li.children).forEach((c) => (c.matches("ul, ol") ? collect(li) : specs.push({ el: c, bullet: true }))));
            else if (child.matches("hr")) specs.push({ el: child, bullet: false, rule: true });
            else specs.push({ el: child, bullet: false });
        }
    };
    collect(region);
    if (!specs.length) return [];
    const lead = leading(region), trail = trailing(region, page);

    // a flex-row region (contact links) is one line in Word
    if (getComputedStyle(region).display.includes("flex") && !getComputedStyle(region).flexDirection.startsWith("column")) {
        const children: ParagraphChild[] = [];
        specs.forEach((s, i) => { if (i) children.push(new TextRun({ text: "     ", size: Math.round(px(getComputedStyle(s.el).fontSize) * 2) })); children.push(...runsOf(s.el)); });
        const base = paraProps(specs[0].el);
        const jc = getComputedStyle(region).justifyContent;
        return [new Paragraph({ ...base, alignment: jc.includes("end") ? AlignmentType.RIGHT : jc === "center" ? AlignmentType.CENTER : base.alignment, spacing: { ...base.spacing, before: tw(lead), after: tw(trail.after) }, border: trail.rule ? { bottom: trail.rule } : undefined, children })];
    }

    return specs.map((s, i) => {
        const first = i === 0, last = i === specs.length - 1;
        if (s.rule) { const r = getComputedStyle(s.el); return new Paragraph({ spacing: { before: tw(px(r.marginTop)), after: tw(px(r.marginBottom)) }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: hex(r.borderTopColor) || "DDDDDD", space: 0 } } }); }
        const base = paraProps(s.el), li = s.bullet ? s.el.closest("li") : null, liCs = li ? getComputedStyle(li) : null;
        const before = base.spacing.before + (liCs && s.el === li!.firstElementChild ? tw(Math.max(0, px(liCs.marginTop))) : 0) + (first ? tw(lead) : 0);
        const after = base.spacing.after + (last ? tw(trail.after) : 0);
        const indent = liCs ? Math.max(8, px(liCs.marginLeft)) : 0;
        return new Paragraph({
            ...base, spacing: { ...base.spacing, before, after },
            ...(s.bullet ? { bullet: { level: 0 }, indent: { left: tw(indent), hanging: tw(Math.min(indent, 9)) } } : {}),
            keepLines: true, border: last && trail.rule ? { bottom: trail.rule } : undefined,
            children: runsOf(s.el),
        });
    });
}

async function imagePara(img: HTMLImageElement): Promise<Paragraph> {
    const cs = getComputedStyle(img), w = parseFloat(cs.width) || img.naturalWidth, h = parseFloat(cs.height) || img.naturalHeight, k = 4;
    const canvas = document.createElement("canvas"); canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("image"))), "image/png"));
    return new Paragraph({ children: [new ImageRun({ type: "png", data: new Uint8Array(await blob.arrayBuffer()), transformation: { width: w, height: h } })] });
}

const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

async function collect(el: Element, page: Element, flows: Flow[], inCell: boolean): Promise<void> {
    const push = (columns: number, gapPt: number, blocks: Block[]) => {
        const lastFlow = flows[flows.length - 1];
        if (lastFlow && lastFlow.columns === columns) lastFlow.children.push(...blocks); else flows.push({ columns, gapPt, children: [...blocks] });
    };
    if (el.classList.contains("cvm-spacer")) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return;
    if (el.matches("[data-cv-edit]")) {
        const cols = inCell ? 1 : parseInt(cs.columnCount, 10) || 1;
        return push(cols, px(cs.columnGap), regionBlocks(el, page));
    }
    if (el instanceof HTMLImageElement) return push(1, 0, [await imagePara(el)]);
    const kids = Array.from(el.children).filter((c) => getComputedStyle(c).display !== "none");
    if (!inCell && cs.display.includes("flex") && !cs.flexDirection.startsWith("column") && kids.length > 1) {
        // side-by-side columns → one borderless table row
        // each cell = its column + the gap that follows it (the gap becomes the cell's right margin)
        const gapPx = parseFloat(cs.columnGap) || 0, zoomK = (el.getBoundingClientRect().width / (parseFloat(cs.width) || 1)) || 1;
        const cellPx = kids.map((k, i) => k.getBoundingClientRect().width / zoomK + (i < kids.length - 1 ? gapPx : 0) + 2);
        const total = cellPx.reduce((n, w) => n + w, 0) || 1;
        const pageCs = getComputedStyle(page), contentPt = px(pageCs.width) - px(pageCs.paddingLeft) - px(pageCs.paddingRight);
        const widths = cellPx.map((w) => Math.round(tw(contentPt) * (w / total)));
        const gap = tw(px(cs.columnGap));
        const cells: TableCell[] = [];
        for (let i = 0; i < kids.length; i++) {
            const inner: Flow[] = [];
            await collect(kids[i], kids[i], inner, true);
            const children = inner.flatMap((f) => f.children);
            cells.push(new TableCell({
                children: children.length ? children : [new Paragraph({})], width: { size: widths[i], type: WidthType.DXA }, borders: NO_BORDERS,
                verticalAlign: cs.alignItems === "center" ? VerticalAlign.CENTER : VerticalAlign.TOP,
                margins: { top: 0, bottom: 0, left: 0, right: i < kids.length - 1 ? gap : 0 },
            }));
        }
        const rule = bottomRule(el), trail = trailing(el, page);
        push(1, 0, [
            new Table({ rows: [new TableRow({ children: cells, cantSplit: true })], width: { size: tw(contentPt), type: WidthType.DXA }, columnWidths: widths, layout: TableLayoutType.FIXED, borders: NO_BORDERS }),
            new Paragraph({ spacing: { before: 0, after: tw(Math.max(0, trail.after - 2)), line: 40, lineRule: LineRuleType.EXACT }, border: rule ? { top: { ...rule, space: Math.round(px(cs.paddingBottom)) } } : undefined }),
        ]);
        return;
    }
    for (const k of kids) await collect(k, page, flows, inCell);
}

export async function exportDocx(page: HTMLElement, opts: Opts): Promise<Blob> {
    const flows: Flow[] = [];
    for (const child of Array.from(page.children)) await collect(child, page, flows, false);
    const cs = getComputedStyle(page);
    const pageProps = {
        size: { width: tw(opts.pageWPt), height: tw(opts.pageHPt) },
        margin: { top: tw(px(cs.paddingTop)), bottom: tw(Math.max(px(cs.paddingBottom), opts.paginate ? 30 : 0)), left: tw(px(cs.paddingLeft)), right: tw(px(cs.paddingRight)), header: 0, footer: tw(10), gutter: 0 },
    };
    const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 14, color: "555555", font: "Helvetica" })] })] });
    const sections: ISectionOptions[] = flows.map((f, i) => ({
        properties: { type: i === 0 ? undefined : SectionType.CONTINUOUS, page: pageProps, column: { count: f.columns, space: tw(Math.max(f.gapPt, 4)), equalWidth: true } },
        ...(opts.paginate ? { footers: { default: footer } } : {}),
        children: f.children,
    }));
    const doc = new Document({ title: opts.name, creator: "CV Maker", styles: { default: { document: { run: { font: "Helvetica", size: 18 }, paragraph: { spacing: { before: 0, after: 0 } } } } }, sections });
    return Packer.toBlob(doc);
}
