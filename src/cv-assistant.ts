// src/components/labs/itera/cv-assistant.ts
// The editor's side of "ask your AI to change this résumé". Pure DOM in, DOM out — no network, no keys:
// a desktop shell supplies the `CvAssistant` that actually talks to the person's own model.
//
// The model never rewrites the file. It is shown the document as addressable pieces (blocks b0…, editable
// regions r0…) and answers with OPERATIONS on them; applyOps() carries those out on a detached copy, with
// every scrap of model-written HTML passed through an allowlist first. The template's markup, classes and
// CSS are never the model's to touch — which is what keeps the layout intact.
import { buildBlock, topBlocks, type BlockKind } from "./cv-blocks";

export interface AiRegion { id: string; html: string; list: boolean }
export interface AiBlock { id: string; kind: string; regions: AiRegion[] }
export interface AiDocument { name: string; paper: string; pages: number; fitScale: number; blocks: AiBlock[]; other: AiRegion[] }

export type AiOpName = "set_text" | "insert_block" | "duplicate_block" | "delete_block" | "move_block";
export interface AiOp { op: AiOpName; target: string; html: string; kind: "" | BlockKind; fill: string[]; to: string }

/** A desktop shell's bridge to the person's own AI (their key, their provider — it never passes through the page). */
export interface CvAssistant {
    /** is a provider set up? `label` names it for the UI ("Claude Opus 5", "llama3.1 · local") */
    status(): Promise<{ ready: boolean; label: string }>;
    /** open the shell's own settings (provider, model, key) */
    configure(): void;
    /** the shell tells the editor when those settings change */
    onStatus(handler: (status: { ready: boolean; label: string }) => void): () => void;
    /** one request: the person's words + the document → what to say back and what to change */
    run(request: { prompt: string; document: AiDocument }): Promise<{ message: string; ops: AiOp[] }>;
}

/** The other direction: an AI app OUTSIDE the editor drives it (the desktop shell runs an MCP server for Claude
 *  Desktop and friends — no key involved at all). The shell calls in; the editor answers with these. */
export interface CvRemoteHandlers {
    /** the document as a model should see it, right now */
    describe(): AiDocument;
    /** apply operations as one undoable step; resolves once the page has re-laid itself out, so the caller learns whether it still fits */
    apply(ops: AiOp[], message: string, by: string): Promise<{ applied: number; skipped: string[]; pagesBefore: number; pagesAfter: number; fitScale: number }>;
    /** take back the most recent remote edit; false when there is nothing to undo */
    undo(): boolean;
    /** what the export pipeline needs to render this document (PDF / PNG happen in the shell) */
    exportPayload(): { html: string; widthPt: number; heightPt: number; name: string };
    /** the formats the editor renders itself: Word and the re-loadable Source HTML (docx travels as base64) */
    exportFile(kind: "docx" | "html"): Promise<{ name: string; data: string; base64: boolean }>;
    /** the toolbar's size menu, as data: paper, fit-to-one-page, pagination, zoom — and what they currently produce */
    getPage(): RemotePage;
    /** change any of them; resolves once the page has re-laid itself out */
    setPage(patch: { paper?: string; fit?: boolean; paginate?: boolean; zoom?: number | "width" | "height" }): Promise<RemotePage>;
    /** every <img> in the document, in order (i0, i1, …) */
    listImages(): RemoteImage[];
    /** swap one image for a data: URI (the shell read the file) — one undoable step, like an edit */
    setImage(id: string, dataUri: string, alt: string | null, by: string): Promise<{ replaced: boolean; pagesBefore: number; pagesAfter: number }>;
    /** the full Source HTML to write to disk, and the name a new file should get — the shell does the writing */
    sourceHtml(): { html: string; suggested: string };
    /** the shell wrote the file: it is now this document's identity and nothing is unsaved */
    markSaved(file: string): void;
}
export interface RemotePage { paper: string; paperLabel: string; papers: string[]; fit: boolean; paginate: boolean; zoom: number | "width" | "height"; zoomPercent: number; pages: number; fitScale: number }
export interface RemoteImage { id: string; alt: string; width: number; height: number; kilobytes: number; embedded: boolean }
/** which outside AI apps know about this editor, and whether one is attached at this moment */
export interface CvRemoteStatus { apps: string[]; live: number }
export interface CvRemote {
    /** the editor hands the shell its handlers; returns a function that withdraws them */
    serve(handlers: CvRemoteHandlers): () => void;
    /** optional: lets the editor say "Claude Desktop connected" instead of inviting the person to connect again */
    status?(): Promise<CvRemoteStatus>;
    onStatus?(handler: (status: CvRemoteStatus) => void): () => void;
    /** open the shell's Connect window */
    configure?(): void;
}

const KINDS: BlockKind[] = ["content", "experience", "dual", "divider"];

const pageOf = (pageHtml: string): { holder: HTMLElement; page: HTMLElement | null } => {
    const holder = document.createElement("div"); holder.innerHTML = pageHtml;
    return { holder, page: holder.querySelector<HTMLElement>(".cv-page") };
};
// a block's editable regions — the block itself can be one (`<div data-cv-block data-cv-edit>`)
const regionsIn = (el: Element): HTMLElement[] => [...(el.matches("[data-cv-edit]") ? [el as HTMLElement] : []), ...Array.from(el.querySelectorAll<HTMLElement>("[data-cv-edit]"))];
const hasList = (el: Element) => !!el.querySelector(":scope > ul, :scope > ol");
const blockKind = (el: Element) => el.getAttribute("data-cv-kind") || el.getAttribute("data-cv-repeat") || (regionsIn(el).length ? "" : "divider");

/** the document as the model sees it: every top-level block and every editable region, each with an id */
export function describeDocument(pageHtml: string, meta: { name: string; paper: string; pages: number; fitScale: number }): AiDocument {
    const { page } = pageOf(pageHtml);
    if (!page) return { ...meta, blocks: [], other: [] };
    const regions = Array.from(page.querySelectorAll<HTMLElement>("[data-cv-edit]"));
    const region = (el: HTMLElement): AiRegion => ({ id: "r" + regions.indexOf(el), html: el.innerHTML.trim(), list: hasList(el) });
    const blocks = topBlocks(page);
    return {
        ...meta,
        blocks: blocks.map((b, i) => ({ id: "b" + i, kind: blockKind(b), regions: regionsIn(b).map(region) })),
        other: regions.filter((r) => !blocks.some((b) => b.contains(r))).map(region),
    };
}

/* ---------------- model-written HTML: an allowlist, nothing else survives ---------------- */
const TAGS = new Set(["P", "UL", "OL", "LI", "STRONG", "B", "EM", "I", "U", "S", "A", "BR", "SPAN"]);
export function cleanHtml(html: string): string {
    // parsed in an INERT document: assigning untrusted markup to innerHTML of an element that belongs to the live
    // page starts loading its <img>s, and `<img src=x onerror=…>` then runs before anything here could strip it
    const box = new DOMParser().parseFromString(`<!doctype html><body>${String(html ?? "")}`, "text/html").body;
    const walk = (node: Element) => {
        for (const child of Array.from(node.children)) {
            if (!TAGS.has(child.tagName)) {   // unknown element: keep its text only when it is harmless prose
                if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|TEMPLATE|LINK|META)$/.test(child.tagName)) child.remove();
                else { walk(child); child.replaceWith(...Array.from(child.childNodes)); }
                continue;
            }
            for (const attr of Array.from(child.attributes)) {
                const href = child.tagName === "A" && attr.name === "href" && /^(https?:|mailto:)/i.test(attr.value.trim());
                if (!href) child.removeAttribute(attr.name);
            }
            walk(child);
        }
    };
    walk(box);
    return box.innerHTML.trim();
}
/** a region that holds a list keeps holding exactly one list (the flowing columns depend on it) */
function fitRegion(el: HTMLElement, html: string): string | null {
    const clean = cleanHtml(html);
    if (!hasList(el)) return clean;
    const box = document.createElement("div"); box.innerHTML = clean;
    const lists = box.querySelectorAll(":scope > ul, :scope > ol");
    if (lists.length === 1 && box.children.length === 1) return clean;
    // prose or loose <li>s where a list belongs: turn each paragraph / item into a bullet rather than refuse
    const tag = el.querySelector(":scope > ul, :scope > ol")!.tagName.toLowerCase();
    const items = Array.from(box.querySelectorAll("li, p")).filter((n) => !n.querySelector("li, p")).map((n) => n.innerHTML.trim()).filter(Boolean);
    return items.length ? `<${tag}>${items.map((i) => `<li><p>${i}</p></li>`).join("")}</${tag}>` : null;
}

/** carry the model's operations out on a copy of the page. Ids always refer to the document AS DESCRIBED —
 *  blocks and regions are tagged up front, so earlier inserts and deletes never shift later targets. */
export function applyOps(pageHtml: string, ops: AiOp[]): { html: string; applied: number; skipped: string[] } {
    const { page } = pageOf(pageHtml), skipped: string[] = [];
    if (!page) return { html: pageHtml, applied: 0, skipped: ["no page"] };
    const regions = new Map<string, HTMLElement>(), blocks = new Map<string, HTMLElement>();
    Array.from(page.querySelectorAll<HTMLElement>("[data-cv-edit]")).forEach((el, i) => regions.set("r" + i, el));
    topBlocks(page).forEach((el, i) => blocks.set("b" + i, el));
    const fill = (block: HTMLElement, texts: string[]) => regionsIn(block).forEach((el, i) => {
        if (texts[i] == null || !String(texts[i]).trim()) return;
        const html = fitRegion(el, texts[i]); if (html != null) el.innerHTML = html;
    });
    const place = (block: HTMLElement, after: string): boolean => {
        if (after === "start") { page.prepend(block); return true; }
        const anchor = blocks.get(after); if (!anchor || !page.contains(anchor) || anchor === block) return false;
        anchor.after(block); return true;
    };
    let applied = 0;
    for (const op of Array.isArray(ops) ? ops.slice(0, 200) : []) {
        const miss = (why: string) => { skipped.push(`${op?.op} ${op?.target}: ${why}`); };
        if (!op || typeof op !== "object") continue;
        if (op.op === "set_text") {
            const el = regions.get(op.target); if (!el || !page.contains(el)) { miss("no such region"); continue; }
            if (el.querySelector("img, svg")) { miss("this region holds a picture"); continue; }
            const html = fitRegion(el, op.html); if (html == null) { miss("a list region needs list items"); continue; }
            el.innerHTML = html; applied++;
        } else if (op.op === "insert_block") {
            const kind = KINDS.includes(op.kind as BlockKind) ? (op.kind as BlockKind) : null; if (!kind) { miss("unknown kind"); continue; }
            const block = buildBlock(kind, page);
            if (!place(block, op.target)) { miss("no such block to insert after"); continue; }
            fill(block, op.fill || []); applied++;
        } else if (op.op === "duplicate_block") {
            const src = blocks.get(op.target); if (!src || !page.contains(src)) { miss("no such block"); continue; }
            const copy = src.cloneNode(true) as HTMLElement; src.after(copy); fill(copy, op.fill || []); applied++;
        } else if (op.op === "delete_block") {
            const el = blocks.get(op.target); if (!el || !page.contains(el)) { miss("no such block"); continue; }
            el.remove(); applied++;
        } else if (op.op === "move_block") {
            const el = blocks.get(op.target); if (!el || !page.contains(el)) { miss("no such block"); continue; }
            if (!place(el, op.to)) { miss("no such place to move to"); continue; }
            applied++;
        } else miss("unknown operation");
    }
    return { html: page.outerHTML, applied, skipped };
}
