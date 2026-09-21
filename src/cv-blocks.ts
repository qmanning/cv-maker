// src/components/labs/itera/cv-blocks.ts
// New rows for the "+" between blocks. A new block is CLONED from the matching block already in the
// document (so it wears that template's own markup and classes, whatever they are) and filled with
// placeholder copy; only when the document has no block of that kind does a plain built-in one step in.
// Pure DOM — no React, no editor — so it is unit-testable.

export type BlockKind = "content" | "experience" | "dual" | "divider";

export const BLOCK_KINDS: { kind: BlockKind; label: string; hint: string }[] = [
    { kind: "content", label: "Content block", hint: "a paragraph, like the summary" },
    { kind: "experience", label: "Experience block", hint: "title, dates, flowing bullets" },
    { kind: "dual", label: "Dual list", hint: "two lists side by side" },
    { kind: "divider", label: "Divider", hint: "a rule between sections" },
];

/** the units the editor treats as rows: what pagination keeps together and what the block tools act on */
export const UNIT = "[data-cv-block], [data-cv-repeat]";
export const topBlocks = (page: Element): HTMLElement[] => Array.from(page.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches("[data-cv-block]"));

const PLACEHOLDER = {
    paragraph: "Write a short paragraph here: what you do, what you are good at, what you are looking for.",
    title: "Job Title, Company",
    meta: "20XX – Present · City, State",
    bullets: ["Describe something you shipped and what changed because of it.", "Add another result. A number helps."],
    heading: "List Heading",
    items: 3,
};

// a template can name its blocks outright with data-cv-kind; otherwise the sample's classes, then shape, decide
function prototypeFor(kind: BlockKind, page: Element): HTMLElement | null {
    const named = page.querySelector<HTMLElement>(`[data-cv-kind="${kind}"]`);
    if (named) return named;
    if (kind === "divider") return null;                     // nothing to learn from the document: a rule is a rule
    const blocks = topBlocks(page);
    const regionsOf = (b: Element) => Array.from(b.querySelectorAll("[data-cv-edit]"));
    if (kind === "experience") return page.querySelector<HTMLElement>("[data-cv-repeat]");
    if (kind === "dual") {
        return page.querySelector<HTMLElement>(".cv-cols2")
            ?? blocks.find((b) => !b.matches("[data-cv-edit]") && b.children.length >= 2 && Array.from(b.children).every((col) => regionsOf(col).some((r) => r.querySelector("ul, ol")))) ?? null;
    }
    return page.querySelector<HTMLElement>(".cv-summary")
        ?? blocks.find((b) => b.matches("[data-cv-edit]") && !b.hasAttribute("data-cv-keep-next") && !b.querySelector("ul, ol") && b.querySelectorAll("p").length >= 1 && (b.textContent || "").length > 80) ?? null;
}

const BUILT_IN: Record<BlockKind, string> = {
    content: `<div class="cv-summary" data-cv-block data-cv-edit><p></p></div>`,
    experience: `<section class="cv-job" data-cv-block data-cv-repeat="job"><div class="cv-job-title" data-cv-edit><p></p></div><div class="cv-job-meta" data-cv-edit><p></p></div><div class="cv-job-body cv-flow" data-cv-edit><ul><li><p></p></li></ul></div></section>`,
    // self-styled, so the rule survives in the exported source HTML whatever the template's CSS says about <hr>;
    // the padding is its click target (a divider has no text to put a caret in — you select it by clicking it)
    divider: `<div class="cv-divider" data-cv-block style="padding: 5pt 0"><hr style="border: 0; border-top: 1px solid var(--cv-rule, #e5e5e5); margin: 0"></div>`,
    dual: `<section class="cv-cols2" data-cv-block><div><div class="cv-h2" data-cv-edit><p></p></div><div class="cv-skill-body" data-cv-edit><ul><li><p></p></li></ul></div></div><div><div class="cv-h2" data-cv-edit><p></p></div><div class="cv-skill-body" data-cv-edit><ul><li><p></p></li></ul></div></div></section>`,
};

function fill(block: HTMLElement, kind: BlockKind): void {
    const doc = block.ownerDocument;
    const p = (text: string) => { const el = doc.createElement("p"); el.textContent = text; return el; };
    const regions = block.matches("[data-cv-edit]") ? [block] : Array.from(block.querySelectorAll<HTMLElement>("[data-cv-edit]"));
    let plain = 0;
    for (const region of regions) {
        const list = region.querySelector("ul, ol"), tag = list ? list.tagName.toLowerCase() : "";
        region.removeAttribute("style");                       // one-off tweaks on the prototype (a hidden rule, extra padding) don't carry over
        region.replaceChildren();
        if (list) {
            const ul = doc.createElement(tag);
            const lines = kind === "dual" ? Array.from({ length: PLACEHOLDER.items }, () => "") : PLACEHOLDER.bullets;
            for (const line of lines) {
                const li = doc.createElement("li"), para = doc.createElement("p");
                if (kind === "dual") { const b = doc.createElement("strong"); b.textContent = "Label:"; para.append(b, " a short detail"); } else para.textContent = line;
                li.append(para); ul.append(li);
            }
            region.append(ul);
        } else if (kind === "content") region.append(p(PLACEHOLDER.paragraph));
        else if (kind === "dual") region.append(p(PLACEHOLDER.heading));
        else { region.append(p(plain === 0 ? PLACEHOLDER.title : PLACEHOLDER.meta)); plain++; }
    }
}

/** a fresh block of `kind`, shaped like the document's own and ready to insert */
export function buildBlock(kind: BlockKind, page: Element): HTMLElement {
    const proto = prototypeFor(kind, page);
    let block: HTMLElement;
    if (proto) block = proto.cloneNode(true) as HTMLElement;
    else { const holder = page.ownerDocument.createElement("div"); holder.innerHTML = BUILT_IN[kind]; block = holder.firstElementChild as HTMLElement; }
    block.querySelectorAll("[data-col-break]").forEach((el) => el.removeAttribute("data-col-break"));
    block.removeAttribute("data-cv-keep-next"); block.removeAttribute("data-cv-kind");
    if (!block.hasAttribute("data-cv-block")) block.setAttribute("data-cv-block", "");
    // inserted rows are marked so the editor can keep their spacing consistent (see normalizeGaps in CvMaker):
    // a cloned block only brings its own margins, not the breathing room its prototype got from its old neighbours
    block.setAttribute("data-cv-added", "");
    fill(block, kind);
    return block;
}

/** insert a new block after top-level block `afterIndex` (−1 = before the first); returns the new block's index */
export function insertBlock(page: Element, afterIndex: number, kind: BlockKind): number {
    const blocks = topBlocks(page), block = buildBlock(kind, page);
    if (afterIndex < 0 || !blocks.length) page.prepend(block); else blocks[Math.min(afterIndex, blocks.length - 1)].after(block);
    return topBlocks(page).indexOf(block);
}
