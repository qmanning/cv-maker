// src/import/structure.ts — FlowDoc in (see flow.ts), an IcedCoffee Source HTML file out. Rules only, no AI.
//
// A converter has already described what the source LOOKED like. This decides what each piece IS, the way a
// person skimming the page would: the big line at the top is the name, the line with the email in it is the
// contact line, a short bold/capitalised/underlined line is a section heading, a line with a date range is
// the start of an entry (job, degree) and what follows belongs to it. Then it builds the file the editor
// understands — [data-cv-edit] regions, [data-cv-block] units pagination keeps together, [data-cv-repeat]
// entries the block tools and the AI can duplicate and move — and a stylesheet generated from the source's
// own measurements, so the page looks like the document it came from.
//
// What the editor can hold INSIDE a region is TipTap's schema (paragraphs, lists, bold/italic/underline/strike,
// links, and text-style spans: colour, size, weight, family, letter-spacing). Everything else a source has —
// paragraph spacing, indents, borders, fonts per paragraph, tables, columns, pictures — is put in the layout
// layer around the regions (classes + CSS), where it survives editing untouched.
import { fullHtml } from "../cv-source";
import { type FlowResult, type ImportFormat, esc, escAttr, hexColor, pt } from "./flow";

export interface ImportReport {
    format: ImportFormat;
    regions: number;
    /** the section headings found, in order ("Experience", "Education" …) */
    sections: string[];
    /** entries (jobs, degrees) recognised by their dates */
    entries: number;
    images: number;
    tables: number;
    columns: boolean;
    /** the paper the source was laid out on, when it said */
    paper?: "letter" | "a4";
    warnings: string[];
    /** rules alone could not do the job (a scanned PDF): why — an AI could */
    needsAi?: string;
    /** the rules found little structure (no sections, no name) — worth offering "tidy with AI" */
    rough: boolean;
}

export interface Structured { text: string; name: string; report: ImportReport }

type Style = Record<string, string>;

/* ---------------- reading the FlowDoc ---------------- */

const parseStyle = (el: Element): Style => {
    const out: Style = {};
    for (const decl of (el.getAttribute("style") || "").split(";")) {
        const i = decl.indexOf(":"); if (i < 0) continue;
        const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim();
        if (k && v) out[k] = v;
    }
    return out;
};
const ptOf = (v: string | undefined, base = 10): number | null => {
    if (!v) return null;
    const m = /^(-?[\d.]+)\s*(pt|px|em|rem|%)?$/.exec(v.trim()); if (!m) return null;
    const n = Number(m[1]), u = m[2] || "pt";
    return u === "pt" ? n : u === "px" ? n * 0.75 : u === "%" ? (n / 100) * base : n * base;
};
const isBoldWeight = (v: string | undefined) => !!v && (v === "bold" || v === "bolder" || Number(v) >= 600);
const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();

/** size and boldness of the text a block actually shows: the runs outvote the block's own style */
function typeOf(el: Element, blockSize: number, blockBold: boolean): { size: number; bold: number } {
    let total = 0, sized = 0, bold = 0;
    const walk = (node: Node, size: number, b: boolean) => {
        if (node.nodeType === 3) { const n = (node.textContent || "").replace(/\s/g, "").length; total += n; sized += n * size; if (b) bold += n; return; }
        if (!(node instanceof Element)) return;
        const s = parseStyle(node), tag = node.tagName;
        const nextSize = ptOf(s["font-size"], size) ?? size;
        const nextBold = tag === "STRONG" || tag === "B" || /^H[1-6]$/.test(tag) && !s["font-weight"] ? true : s["font-weight"] ? isBoldWeight(s["font-weight"]) : b;
        node.childNodes.forEach((c) => walk(c, nextSize, nextBold));
    };
    el.childNodes.forEach((c) => walk(c, blockSize, blockBold));
    return { size: total ? sized / total : blockSize, bold: total ? bold / total : 0 };
}

/* ---------------- what things are ---------------- */

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE = `(?:(?:${MONTH}\\s+)?(?:19|20)\\d{2}|\\d{1,2}\\s*/\\s*(?:(?:19|20)?\\d{2})|present|current|now|today|ongoing)`;
const RANGE = new RegExp(`${DATE}\\s*(?:[-–—~]|to|until|through|thru)\\s*${DATE}`, "i");
const ONE_DATE = new RegExp(`(?:^|[\\s(,|·•–—-])${DATE}\\s*\\)?\\s*$`, "i");
const hasRange = (s: string) => RANGE.test(s);
const endsWithDate = (s: string) => ONE_DATE.test(s);
const isDateLike = (s: string) => hasRange(s) || (s.length < 40 && new RegExp(`^\\s*${DATE}`, "i").test(s));

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin\.com|github\.com|behance\.net|dribbble\.com)\/\S+|\b[\w-]+\.(?:com|io|dev|design|me|net|org|co|studio|art|xyz)\b(?:\/\S*)?/i;
const isContact = (s: string) => EMAIL.test(s) || PHONE.test(s) || URLISH.test(s);

const SECTION_WORDS = /\b(summary|profile|objective|about|experience|employment|work|career|history|education|academic|skills|competenc(?:y|ies)|expertise|capabilities|projects?|certifications?|certificates?|licen[cs]es?|awards?|honou?rs|achievements?|accomplishments?|publications?|languages?|interests|hobbies|volunteer(?:ing)?|leadership|activities|references|training|courses?|coursework|affiliations|memberships?|tools|technologies|qualifications|highlights|portfolio|contact|patents|speaking|talks|press|clients|recognition|exhibitions|research|teaching|service)\b/i;

interface Item {
    el: HTMLElement;
    tag: string;                  // P, H1…, UL, OL, TABLE, HR, FIGURE, COLS, ABS
    text: string;
    style: Style;
    size: number;                 // the size its text is shown at (pt)
    bold: boolean;                // (nearly) all of it is bold
    caps: boolean;                // written or shown in capitals
    right?: { left: string; right: string };   // text either side of a right tab (dates on the right)
}

/** the tabs that put what follows at the far side of the line */
const STOPS = '[data-flow-tab="right"], [data-flow-tab="center"], [data-flow-tab="decimal"]';

function toItems(parent: Element, baseSize: number): Item[] {
    const items: Item[] = [];
    for (const el of Array.from(parent.children) as HTMLElement[]) {
        const style = parseStyle(el);
        // a list's type lives on its items (Word styles each bullet paragraph): the first item's look is the list's
        if (el.tagName === "UL" || el.tagName === "OL") {
            const li = el.querySelector(":scope > li"), own = li ? parseStyle(li) : {};
            for (const k of ["font-family", "font-size", "color", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform"]) if (own[k] && !style[k]) style[k] = own[k];
            if (!style["margin-bottom"] && own["margin-bottom"]) style["margin-bottom"] = own["margin-bottom"];
        }
        const tag = el.hasAttribute("data-flow-cols") ? "COLS" : el.hasAttribute("data-flow-abs") ? "ABS" : el.tagName;
        const blockSize = ptOf(style["font-size"], baseSize) ?? (/^H[1-6]$/.test(tag) ? baseSize * [2, 1.4, 1.15, 1, 1, 1][Number(tag[1]) - 1] : baseSize);
        const t = typeOf(el, blockSize, isBoldWeight(style["font-weight"]) || /^H[1-6]$/.test(tag));
        const text = textOf(el);
        const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, "");
        const item: Item = { el, tag, text, style, size: t.size, bold: t.bold >= 0.85, caps: letters.length >= 3 && (letters === letters.toUpperCase() || style["text-transform"] === "uppercase") };
        const last = tag === "P" || /^H[1-6]$/.test(tag) ? Array.from(el.querySelectorAll(STOPS)).pop() : undefined;
        if (last) { const [l, r] = splitAt(el, last); if (textOf(r)) item.right = { left: textOf(l), right: textOf(r) }; }
        items.push(item);
    }
    return items;
}

/** the two halves of a paragraph either side of one tab marker, as detached elements (formatting kept) */
function splitAt(el: Element, marker: Element): [HTMLElement, HTMLElement] {
    const left = el.cloneNode(true) as HTMLElement, right = el.cloneNode(true) as HTMLElement;
    const path: number[] = [];
    for (let n: Element = marker; n !== el; n = n.parentElement!) path.unshift(Array.prototype.indexOf.call(n.parentNode!.childNodes, n));
    const find = (root: Node) => path.reduce<Node>((n, i) => n.childNodes[i], root);
    // left: drop the marker and everything after it; right: the marker and everything before it
    const cut = (root: HTMLElement, keepBefore: boolean) => {
        const tab = find(root);   // held, not re-found: the indices stop being true once siblings go
        for (let node: Node = tab; node !== root; node = node.parentNode!) {
            const parent = node.parentNode!;
            if (keepBefore) { while (node.nextSibling) parent.removeChild(node.nextSibling); }
            else { while (node.previousSibling) parent.removeChild(node.previousSibling); }
        }
        tab.parentNode?.removeChild(tab);
    };
    cut(left, true); cut(right, false);
    return [left, right];
}

/* ---------------- building ---------------- */

interface Ctx {
    base: { family: string; size: number; color: string; lineHeight: string };
    unstyled: boolean;            // md / txt: the source has no look of its own, so give it a clean one
    kind: "resume" | "letter";
    classes: Map<string, string>; // style signature → class
    css: string[];
    regions: number;
    sections: string[];
    entries: number;
    images: number;
    tables: number;
    columns: boolean;
    warnings: string[];
}

const OWN = ["font-family", "font-size", "color", "font-weight", "font-style", "text-transform", "letter-spacing", "background-color", "border-top", "border-bottom", "padding-top", "padding-bottom", "margin-top", "margin-bottom"];
const PARA = ["margin-left", "margin-right", "text-indent", "line-height", "list-style-type"];
/** two blocks with the same signature can share a region (and a class) */
const sigOf = (style: Style, tag: string) => tag + "|" + [...OWN, ...PARA].map((k) => style[k] || "").join("|");

/** the CSS for a block's own look (everything TipTap can't keep on a paragraph), as a reusable class */
function classFor(ctx: Ctx, style: Style, tag: string): string {
    const s: Style = { ...style };
    if (/^H[1-6]$/.test(tag) && !s["font-size"]) {
        // an unstyled heading (markdown, text) gets a clean résumé look instead of browser defaults
        const lvl = Number(tag[1]);
        Object.assign(s, lvl === 1 ? { "font-size": pt(ctx.base.size * 2), "font-weight": "700", "margin-bottom": "2pt" }
            : lvl === 2 ? { "font-size": pt(ctx.base.size * 1.1), "font-weight": "700", "text-transform": "uppercase", "letter-spacing": "0.5pt", "border-bottom": "0.75pt solid currentColor", "padding-bottom": "2pt", "margin-top": "12pt", "margin-bottom": "5pt" }
            : { "font-size": pt(ctx.base.size * 1.05), "font-weight": "700", "margin-top": "7pt", "margin-bottom": "2pt" }, style);
    }
    if (ctx.unstyled && tag === "P" && !s["margin-bottom"]) s["margin-bottom"] = "4pt";
    const sig = sigOf(s, tag);
    let cls = ctx.classes.get(sig);
    if (cls) return cls;
    cls = "imp-s" + ctx.classes.size; ctx.classes.set(sig, cls);
    const color = (v: string) => hexColor(v) || v;
    const box: string[] = [], p: string[] = [];
    for (const k of OWN) {
        if (!s[k]) continue;
        const v = k === "color" || k === "background-color" ? color(s[k]) : s[k];
        if (v) box.push(`${k}: ${v}`);
    }
    if (s["margin-left"]) p.push(`margin-left: ${s["margin-left"]}`);
    if (s["margin-right"]) p.push(`margin-right: ${s["margin-right"]}`);
    if (s["text-indent"]) p.push(`text-indent: ${s["text-indent"]}`);
    if (s["line-height"]) box.push(`line-height: ${s["line-height"]}`);
    const gap = Math.max(ptOf(s["margin-top"]) ?? 0, ptOf(s["margin-bottom"]) ?? 0);
    ctx.css.push(`.cv-page .${cls} { ${box.join("; ")} }`);
    if (tag === "UL" || tag === "OL") {
        // no marker (list-style: none) needs no room for one; otherwise the source's indent, or enough for the bullet
        const indent = s["list-style-type"] === "none" ? ptOf(s["margin-left"]) ?? 0 : (ptOf(s["margin-left"]) ?? 0) || 14;
        ctx.css.push(`.cv-page .${cls} > :is(ul, ol) { ${s["list-style-type"] ? `list-style-type: ${s["list-style-type"]}; ` : ""}margin: 0; padding: 0 }`,
            `.cv-page .${cls} li { margin-left: ${pt(indent)} }`);
        if (gap) ctx.css.push(`.cv-page .${cls} li + li { margin-top: ${pt(gap)} }`);
    } else {
        if (p.length) ctx.css.push(`.cv-page .${cls} p { ${p.join("; ")} }`);
        if (gap) ctx.css.push(`.cv-page .${cls} p + p { margin-top: ${pt(gap)} }`);
    }
    return cls;
}

const SAFE_HREF = /^(https?:|mailto:|tel:)/i;
const KEEP_SPAN = ["color", "font-size", "font-weight", "font-family", "letter-spacing", "background-color", "text-transform"];

/** a block's inline content as the HTML a region holds (TipTap's schema and nothing else) */
function inline(node: Node): string {
    let out = "";
    node.childNodes.forEach((c) => {
        if (c.nodeType === 3) { out += esc(c.textContent || ""); return; }
        if (!(c instanceof Element)) return;
        const tag = c.tagName, inner = () => inline(c);
        if (c.hasAttribute("data-flow-tab")) { out += " "; return; }   // a tab nothing split on: an em space holds the gap
        if (tag === "BR") { out += "<br>"; return; }
        if (tag === "IMG" || tag === "SCRIPT" || tag === "STYLE") return;   // pictures are pulled out beforehand
        if (tag === "STRONG" || tag === "B") { out += `<strong>${inner()}</strong>`; return; }
        if (tag === "EM" || tag === "I") { out += `<em>${inner()}</em>`; return; }
        if (tag === "U") { out += `<u>${inner()}</u>`; return; }
        if (tag === "S" || tag === "STRIKE" || tag === "DEL") { out += `<s>${inner()}</s>`; return; }
        if (tag === "A") { const href = (c.getAttribute("href") || "").trim(); out += SAFE_HREF.test(href) ? `<a href="${escAttr(href)}">${inner()}</a>` : inner(); return; }
        if (tag === "SPAN") {
            const s = parseStyle(c); let html = inner();
            const keep = KEEP_SPAN.filter((k) => s[k] && !(k === "font-weight" && isBoldWeight(s[k]))).map((k) => `${k}: ${k === "color" || k === "background-color" ? hexColor(s[k]) || s[k] : s[k]}`);
            if (keep.length) html = `<span style="${escAttr(keep.join("; "))}">${html}</span>`;
            if (isBoldWeight(s["font-weight"])) html = `<strong>${html}</strong>`;
            if (s["font-style"] === "italic") html = `<em>${html}</em>`;
            out += html; return;
        }
        out += inner();   // sup, sub, anything else: its text
    });
    return out;
}

/** emails and web addresses written as plain text become links */
function autolink(root: HTMLElement): void {
    const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
    const texts: Text[] = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest("a"))) texts.push(n as Text);
    const re = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]|\b(?:linkedin\.com|github\.com|behance\.net|dribbble\.com)\/[^\s<>()]+[^\s<>().,;:!?'"])/gi;
    for (const t of texts) {
        const s = t.textContent || ""; re.lastIndex = 0; if (!re.test(s)) continue; re.lastIndex = 0;
        const frag = root.ownerDocument.createDocumentFragment(); let at = 0;
        for (let m = re.exec(s); m; m = re.exec(s)) {
            frag.append(s.slice(at, m.index));
            const a = root.ownerDocument.createElement("a");
            a.href = m[1] ? "mailto:" + m[1] : /^https?:/i.test(m[2]) ? m[2] : "https://" + m[2];
            a.textContent = m[0]; frag.append(a); at = m.index + m[0].length;
        }
        frag.append(s.slice(at)); t.replaceWith(frag);
    }
}

/** pictures sitting inside a paragraph come out of it (a region cannot hold them), keeping their size */
function takeImages(el: Element): string[] {
    return Array.from(el.querySelectorAll("img")).map((img) => {
        const src = img.getAttribute("src") || ""; img.remove();
        if (!/^data:image\//i.test(src)) return "";
        const s = parseStyle(img);
        return `<img src="${escAttr(src)}" alt="${escAttr(img.getAttribute("alt") || "")}" style="${escAttr([s.width && `width: ${s.width}`, s.height && `height: ${s.height}`].filter(Boolean).join("; "))}">`;
    }).filter(Boolean);
}

/** attributes a region/block gets */
const attrs = (top: boolean, extra = "") => (top ? " data-cv-block" : "") + extra;
const alignAttr = (s: Style) => { const a = s["text-align"]; return a && a !== "left" && a !== "start" ? ` style="text-align: ${a === "both" ? "justify" : a}"` : ""; };

/** one paragraph as a <p> for a region (its alignment rides on the <p>, which TipTap keeps) */
const para = (item: Item, el: Element = item.el) => `<p${alignAttr(item.style)}>${inline(el)}</p>`;

/** a list as the ONE list a region holds: <li><p>…</p></li>, nested lists moved into the item before them */
function listHtml(list: Element): string {
    const tag = list.tagName.toLowerCase(), items: string[] = [];
    for (const child of Array.from(list.children)) {
        if (child.tagName === "LI") {
            const nested = Array.from(child.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
            nested.forEach((n) => n.remove());
            items.push(`<li><p${alignAttr(parseStyle(child))}>${inline(child)}</p>${nested.map(listHtml).join("")}</li>`);
        } else if ((child.tagName === "UL" || child.tagName === "OL") && items.length) {
            items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, listHtml(child) + "</li>");
        }
    }
    return `<${tag}>${items.join("")}</${tag}>`;
}

const region = (ctx: Ctx, cls: string, html: string, top: boolean, extra = "") => { ctx.regions++; return `<div class="${cls}"${attrs(top, extra)} data-cv-edit>${html}</div>`; };

/** a paragraph with a right tab: two regions on one row (the title on the left, the dates on the right) */
function row(ctx: Ctx, item: Item, top: boolean, extra = ""): string {
    const [l, r] = splitAt(item.el, Array.from(item.el.querySelectorAll(STOPS)).pop()!);
    const cls = classFor(ctx, item.style, item.tag);
    if (!textOf(l)) return region(ctx, cls, `<p style="text-align: right">${inline(r)}</p>`, top, extra);
    ctx.regions += 2;
    return `<div class="${cls} imp-row"${attrs(top, extra)}><div class="imp-l" data-cv-edit><p>${inline(l)}</p></div><div class="imp-r" data-cv-edit><p>${inline(r)}</p></div></div>`;
}

/** paragraphs and lists (no headings, no entries) as regions: neighbours that look alike share one */
function flowRegions(ctx: Ctx, items: Item[], top: boolean): string {
    let out = "", i = 0;
    while (i < items.length) {
        const it = items[i];
        if (it.tag === "UL" || it.tag === "OL") {
            const cls = classFor(ctx, it.style, it.tag);
            let html = listHtml(it.el); i++;
            // the next list in the same style continues this one (Word splits a list around a stray paragraph mark)
            while (i < items.length && items[i].tag === it.tag && sigOf(items[i].style, it.tag) === sigOf(it.style, it.tag)) { html = html.replace(new RegExp(`</${it.tag.toLowerCase()}>$`), "") + listHtml(items[i].el).replace(/^<[uo]l>/, ""); i++; }
            out += region(ctx, cls, html, top);
            continue;
        }
        if (it.tag === "P" || /^H[1-6]$/.test(it.tag)) {
            const pics = takeImages(it.el);
            if (pics.length) {
                ctx.images += pics.length;
                if (!textOf(it.el)) { out += `<div class="imp-fig"${attrs(top)}${alignAttr(it.style)}>${pics.join("")}</div>`; i++; continue; }
                // a logo beside the name, a photo beside the text: the picture, then the words, on one row
                out += `<div class="imp-media"${attrs(top)}>${pics.join("")}<div class="imp-media-text">${it.right ? row(ctx, it, false) : region(ctx, classFor(ctx, it.style, it.tag), para(it), false)}</div></div>`;
                i++; continue;
            }
            if (it.right) { out += row(ctx, it, top); i++; continue; }
            const cls = classFor(ctx, it.style, it.tag);
            let html = para(it); i++;
            while (it.tag === "P" && i < items.length && items[i].tag === "P" && !items[i].right && !items[i].el.querySelector("img") && sigOf(items[i].style, "P") === sigOf(it.style, "P")) { html += para(items[i]); i++; }
            out += region(ctx, cls, html, top);
            continue;
        }
        out += other(ctx, it, top); i++;
    }
    return out;
}

/** tables, rules, pictures, columns, positioned things — the layout layer, with regions inside where there are words */
function other(ctx: Ctx, it: Item, top: boolean): string {
    if (it.tag === "HR") {
        const s = it.style, line = s["border-top"] || s["border-bottom"] || "0.75pt solid currentColor";
        return `<div class="imp-hr"${attrs(top)} style="padding: 4pt 0"><hr style="border: 0; border-top: ${escAttr(line)}; margin: 0"></div>`;
    }
    if (it.tag === "FIGURE") {
        const pics = takeImages(it.el); ctx.images += pics.length;
        return pics.length ? `<div class="imp-fig"${attrs(top)}${alignAttr(it.style)}>${pics.join("")}</div>` : "";
    }
    if (it.tag === "TABLE") {
        ctx.tables++;
        const rows = Array.from(it.el.querySelectorAll(":scope > tr, :scope > tbody > tr, :scope > thead > tr"));
        const cells = (tr: Element) => Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH").map((td) => {
            const s = parseStyle(td), keep = ["width", "vertical-align", "padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "border", "border-top", "border-bottom", "border-left", "border-right", "background-color", "text-align"]
                .filter((k) => s[k]).map((k) => `${k}: ${s[k]}`).join("; ");
            const span = ["colspan", "rowspan"].map((a) => (td.getAttribute(a) && td.getAttribute(a) !== "1" ? ` ${a}="${Number(td.getAttribute(a)) || 1}"` : "")).join("");
            // a cell's text may be loose inline content rather than blocks
            if (Array.from(td.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim() || n instanceof Element && !/^(P|H[1-6]|UL|OL|TABLE|HR|FIGURE|DIV)$/.test(n.tagName))) {
                const p = td.ownerDocument.createElement("p"); p.append(...Array.from(td.childNodes)); td.append(p);
            }
            return `<td${span}${keep ? ` style="${escAttr(keep)}"` : ""}>${build(ctx, toItems(td, ctx.base.size), false)}</td>`;
        }).join("");
        const fixed = rows.some((tr) => Array.from(tr.children).some((td) => parseStyle(td).width));
        return `<div class="imp-tablewrap"${attrs(top)}><table class="imp-table"${fixed ? ' style="table-layout: fixed"' : ""}>${rows.map((tr) => `<tr>${cells(tr)}</tr>`).join("")}</table></div>`;
    }
    if (it.tag === "COLS") {
        ctx.columns = true;
        const cols = Array.from(it.el.children).filter((c) => c.hasAttribute("data-flow-col"));
        return `<div class="imp-cols"${attrs(top)}>${cols.map((c) => { const w = parseStyle(c).width; return `<div class="imp-col"${w ? ` style="width: ${escAttr(w)}"` : ' style="flex: 1 1 0"'}>${build(ctx, toItems(c, ctx.base.size), false)}</div>`; }).join("")}</div>`;
    }
    if (it.tag === "ABS") {
        const s = it.style, pageNo = Number(it.el.getAttribute("data-flow-page")) || 0;
        if (pageNo) ctx.warnings.push("Something positioned on a later page of the original was placed on the first page's layout — check where it landed.");
        const pos = ["top", "left", "width", "height"].filter((k) => s[k]).map((k) => `${k}: ${escAttr(s[k])}`).join("; ");
        return `<div class="imp-abs" style="${pos}">${build(ctx, toItems(it.el, ctx.base.size), false)}</div>`;
    }
    return "";
}

/** a section heading: short, set apart by caps / bold / size / a rule under it, and followed by something */
function isHeading(ctx: Ctx, it: Item, next: Item | undefined, bodySize: number): boolean {
    if (!next || it.right) return false;
    const t = it.text;
    if (!t || t.length > 48 || t.split(/\s+/).length > 6 || /[.;,]$/.test(t) || isContact(t) || isDateLike(t) || hasRange(t)) return false;
    const known = SECTION_WORDS.test(t);
    // "ACME CORP" (or a ### job title) over "2019 – 2023" is an entry, not a section
    if (/^H[12]$/.test(it.tag)) return true;   // # and ## are sections whatever follows; ### and below may be a job title
    if (!known && next.tag === "P" && (hasRange(next.text) || next.right && isDateLike(next.right.right))) return false;
    if (/^H[1-6]$/.test(it.tag)) return true;
    if (it.tag !== "P") return false;
    const marked = it.caps || !!it.style["border-bottom"] || it.size >= bodySize * 1.15;
    return marked && (known || it.bold || it.caps) || known && it.bold && t.split(/\s+/).length <= 4;
}

/** the start of an entry (a job, a degree): a short line carrying a date range, or a bold line with one right under it */
function entryStart(items: Item[], i: number): boolean {
    const it = items[i]; if (!it || !/^(P|H[3-6])$/.test(it.tag) || it.text.length > 140) return false;
    if (it.right && isDateLike(it.right.right)) return true;
    if (hasRange(it.text) && it.text.length < 110 && !/[.!?]$/.test(it.text)) return true;   // a sentence with years in it is prose
    if (it.bold && endsWithDate(it.text)) return true;
    const next = items[i + 1];
    return !!next && next.tag === "P" && next.text.length < 110 && (hasRange(next.text) || !!next.right && isDateLike(next.right.right)) && (it.bold || it.size > next.size + 0.4);
}

/** a run of items (the whole page, a column, a cell): headings, entries, and everything else as regions */
function build(ctx: Ctx, items: Item[], top: boolean): string {
    const bodySize = ctx.base.size;
    let out = "", i = 0;
    const flush = (from: number, to: number) => { if (to > from) out += flowRegions(ctx, items.slice(from, to), top); };
    let pending = 0;
    while (i < items.length) {
        const it = items[i];
        if ((it.tag === "P" || /^H[1-6]$/.test(it.tag)) && isHeading(ctx, it, items[i + 1], bodySize)) {
            flush(pending, i);
            ctx.sections.push(it.text);
            const keepHr = items[i + 1]?.tag === "HR";
            out += region(ctx, classFor(ctx, it.style, it.tag), para(it), top, top ? " data-cv-keep-next" : "");
            i++;
            if (keepHr) { out += other(ctx, items[i], top).replace(/^<div class="imp-hr"( data-cv-block)?/, (m) => m + (top ? " data-cv-keep-next" : "")); i++; }
            // the section's body: entries when it has them, otherwise plain regions
            const end = (() => { let j = i; while (j < items.length && !((items[j].tag === "P" || /^H[1-6]$/.test(items[j].tag)) && isHeading(ctx, items[j], items[j + 1], bodySize))) j++; return j; })();
            out += section(ctx, items.slice(i, end), top);
            i = pending = end;
            continue;
        }
        i++;
    }
    flush(pending, items.length);
    return out;
}

function section(ctx: Ctx, items: Item[], top: boolean): string {
    if (ctx.kind === "letter") return flowRegions(ctx, items, top);
    const starts: number[] = [];
    for (let i = 0; i < items.length; i++) if (entryStart(items, i) && !(starts.length && starts[starts.length - 1] === i - 1 && !items[i - 1].right && !hasRange(items[i - 1].text))) starts.push(i);
    if (!starts.length) return flowRegions(ctx, items, top);
    let out = flowRegions(ctx, items.slice(0, starts[0]), top);
    starts.forEach((s, k) => {
        const end = starts[k + 1] ?? items.length;
        ctx.entries++;
        out += `<section class="imp-entry"${attrs(top)} data-cv-repeat="job">${flowRegions(ctx, items.slice(s, end), false)}</section>`;
    });
    return out;
}

/* ---------------- the whole page ---------------- */

const DEFAULT_FAMILY = 'Helvetica, "Helvetica Neue", Arial, sans-serif';

export function structure(flow: FlowResult, opts: { kind: "resume" | "letter"; format: ImportFormat; fallbackName: string }): Structured {
    const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${flow.html}</body></html>`, "text/html");
    const body = doc.body;
    body.querySelectorAll("script, style, iframe, object, embed").forEach((n) => n.remove());
    const unstyled = opts.format === "md" || opts.format === "txt";
    const size = flow.base?.fontSizePt || 10;
    const ctx: Ctx = {
        base: { family: flow.base?.fontFamily || DEFAULT_FAMILY, size, color: hexColor(flow.base?.color) || (unstyled ? "#111111" : "#000000"), lineHeight: String(flow.base?.lineHeight || (unstyled ? 1.3 : 1.15)) },
        unstyled, kind: opts.kind, classes: new Map(), css: [], regions: 0, sections: [], entries: 0, images: 0, tables: 0, columns: false, warnings: [...flow.warnings],
    };
    autolink(body);
    // plain sources write "Lead Designer, Acme | 2021 – Present" (or with a dash) for what Word does with a right tab
    if (unstyled) body.querySelectorAll(":scope > :is(p, h3, h4, h5, h6)").forEach((p) => {
        const last = p.lastChild; if (!last || last.nodeType !== 3) return;
        const m = new RegExp(`^([\\s\\S]*?)\\s*[|–—-]\\s+(${RANGE.source})\\s*$`, "i").exec(last.textContent || "");
        const before = (p.textContent || "").slice(0, (p.textContent || "").length - (last.textContent || "").length) + (m ? m[1] : "");
        if (!m || !before.trim()) return;   // there has to be a title on the left
        const tab = doc.createElement("span"); tab.setAttribute("data-flow-tab", "right");
        last.replaceWith(m[1], tab, m[2]);
    });
    const items = toItems(body, size).filter((it) => it.text || it.tag !== "P" || it.el.querySelector("img"));

    // the header: the first line (the name) and the short lines under it — contact details, a headline — up to the
    // first section heading or the first real paragraph (an unlabelled summary stays out of the header)
    // (right under the name a big bold line is a headline — "Product Designer" — unless it names a section)
    const firstHeading = items.findIndex((it, i) => i > 0 && (it.tag === "P" || /^H[1-6]$/.test(it.tag)) && isHeading(ctx, it, items[i + 1], size) && (i > 3 || SECTION_WORDS.test(it.text)));
    const head: Item[] = [];
    for (const it of items.slice(0, firstHeading < 0 ? 5 : Math.min(firstHeading, 8))) {
        if (!(it.tag === "P" || /^H[1-6]$/.test(it.tag) || it.tag === "FIGURE")) break;
        if (head.length && !isContact(it.text) && it.text.length > (firstHeading < 0 ? 60 : 90)) break;
        head.push(it);
    }
    const nameItem = head.find((it) => it.text);
    const personName = nameItem && nameItem.text.split(/\s+/).length <= 6 && !isContact(nameItem.text) ? nameItem.text.replace(/\s*[|·•].*$/, "") : "";
    if (nameItem && unstyled && nameItem.tag === "P" && !nameItem.style["font-size"]) Object.assign(nameItem.style, { "font-size": pt(size * 2), "font-weight": "700", "margin-bottom": "2pt" });

    let page = "";
    if (head.length) {
        const inner = flowRegions(ctx, head, false);
        page += `<header class="imp-header" data-cv-block data-cv-header>${inner}</header>`;
    }
    page += build(ctx, items.slice(head.length), true);

    const p = flow.page || {};
    const paper: "letter" | "a4" | undefined = p.widthPt ? (Math.abs(p.widthPt - 595) < 6 ? "a4" : "letter") : undefined;
    const ml = p.marginLeftPt ?? (unstyled ? 54 : 50), mr = p.marginRightPt ?? ml;
    const contentW = Math.max(200, (p.widthPt || 612) - ml - mr);
    const padTop = p.marginTopPt ?? (unstyled ? 44 : 36), padBottom = p.marginBottomPt ?? padTop;

    const css = [
        `/* Imported by IcedCoffee from a ${opts.format.toUpperCase()} file. Every .imp-* rule below was generated from the original's own
   measurements (pt), so the page reads like the source. Edit freely: this is an ordinary IcedCoffee source file. */`,
        `.cv-page {
  --cv-content-w: ${pt(contentW)};
  --cv-pad-top: ${pt(padTop)};
  --cv-pad-bottom: ${pt(padBottom)};
  font-family: ${ctx.base.family}; font-size: ${pt(size)}; line-height: ${ctx.base.lineHeight}; color: ${ctx.base.color}; background: #fff;
  -webkit-font-smoothing: antialiased;
}`,
        `.cv-page *, .cv-page *::before, .cv-page *::after { box-sizing: border-box; }
.cv-page p, .cv-page ul, .cv-page ol, .cv-page li { margin: 0; padding: 0; }
.cv-page p { min-height: 1em; overflow-wrap: break-word; }
.cv-page ul { list-style: disc outside; }
.cv-page ol { list-style: decimal outside; }
.cv-page li { margin-left: 14pt; break-inside: avoid; }
.cv-page a { color: inherit; text-decoration: underline; }
.cv-page [data-col-break] { break-before: column; }
.cv-page img { max-width: 100%; }
.cv-page .imp-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12pt; }
.cv-page .imp-row > .imp-l { flex: 1 1 auto; min-width: 0; }
.cv-page .imp-row > .imp-r { flex: none; text-align: right; white-space: nowrap; }
.cv-page .imp-media { display: flex; align-items: center; gap: 10pt; }
.cv-page .imp-media > img { flex: none; }
.cv-page .imp-media-text { flex: 1 1 auto; min-width: 0; }
.cv-page .imp-fig img { display: inline-block; vertical-align: top; }
.cv-page .imp-cols { display: flex; align-items: flex-start; justify-content: space-between; gap: 14pt; }
.cv-page .imp-col { flex: none; min-width: 0; }
.cv-page .imp-table { border-collapse: collapse; width: 100%; }
.cv-page .imp-table td { vertical-align: top; padding: 0; }
.cv-page .imp-abs { position: absolute; }`,
        ...ctx.css,
    ].join("\n");

    const pageHtml = `<div class="cv-page"${opts.kind === "letter" ? ' data-cv-kind="letter"' : ""} data-cv-imported="${opts.format}">\n${page}\n</div>`;
    const name = (flow.title || "").trim() || (personName ? `${personName} — ${opts.kind === "letter" ? "Cover Letter" : "Résumé"}` : opts.fallbackName);
    const rough = !flow.needsAi && (ctx.sections.length === 0 && items.length > 6 || !personName && opts.kind === "resume");
    if (ctx.columns) ctx.warnings.push("The original is laid out in columns. They came across side by side; pagination keeps each column set on one page.");
    return {
        text: fullHtml(name, css, pageHtml),
        name,
        report: { format: opts.format, regions: ctx.regions, sections: ctx.sections, entries: ctx.entries, images: ctx.images, tables: ctx.tables, columns: ctx.columns, paper, warnings: Array.from(new Set(ctx.warnings)), needsAi: flow.needsAi, rough },
    };
}
