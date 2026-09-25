// src/import/html.ts — somebody else's HTML résumé (not an IcedCoffee file) → FlowDoc.
//
// An IcedCoffee file is opened as it is. Any other page is RENDERED first — offscreen, in a shadow root so its
// stylesheet can't reach the app — and then read back the way it is actually drawn: the computed font, size,
// colour and weight of every run, and the boxes' geometry. Geometry is what finds the structure CSS hides: two
// blocks side by side are columns, a date pushed to the right edge of its line is "dates on the right", the gap
// above a block is its spacing whatever mix of margin and padding made it.
// Without a layout (tests under jsdom) it degrades to the declared styles and reading order.
import { scopeCss } from "../cv-source";
import { type FlowResult, esc, escAttr, hexColor, pt, styleAttr } from "./flow";

const PX = 0.75;   // CSS px → pt
const SCOPE = "imp-render";
const INLINE = /^(inline|inline-block|inline-flex|contents)$/;
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO"]);

type CS = CSSStyleDeclaration;
const n = (v: string) => parseFloat(v) || 0;
const ptv = (px: number) => pt(px * PX);

export async function htmlToFlow(text: string, name: string): Promise<FlowResult> {
    const src = new DOMParser().parseFromString(text, "text/html");
    const warnings: string[] = [];
    src.querySelectorAll("script, iframe, object, embed, link, meta, base").forEach((el) => el.remove());
    src.querySelectorAll("*").forEach((el) => Array.from(el.attributes).forEach((a) => { if (/^on/i.test(a.name)) el.removeAttribute(a.name); }));
    let remote = 0;
    src.querySelectorAll("img").forEach((img) => { if (!/^data:image\//i.test(img.getAttribute("src") || "")) { remote++; img.remove(); } });
    if (remote) warnings.push(`${remote} picture${remote > 1 ? "s were" : " was"} linked from elsewhere rather than stored in the file, so ${remote > 1 ? "they" : "it"} could not come across.`);
    const css = Array.from(src.querySelectorAll("style")).map((s) => s.textContent || "").join("\n").replace(/@import[^;]+;/g, "");

    // render: a fixed-width Letter page, offscreen, its CSS scoped to the render box (body/html rules land on it)
    const host = document.createElement("div");
    // off to the side, NOT visibility: hidden — that is inherited, and hidden() below would then skip everything
    host.style.cssText = "position: fixed; left: -12000px; top: 0; width: 816px; pointer-events: none;";
    const root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    const box = document.createElement("div"); box.className = SCOPE;
    const bodyStyle = src.body.getAttribute("style"); if (bodyStyle) box.setAttribute("style", bodyStyle);
    box.innerHTML = src.body.innerHTML;
    const style = document.createElement("style");
    style.textContent = `.${SCOPE} { display: block; margin: 0; padding: 8px; background: #fff; color: #000; font: 16px/normal "Times New Roman", serif; }\n${scopeCss(css, "." + SCOPE)}`;
    root.append(style, box);
    document.body.append(host);
    try {
        await document.fonts?.ready;
        return read(box, host, src.title.trim(), warnings, name);
    } finally { host.remove(); }
}

/** `page` is the 816px-wide sheet the source was drawn on: margins are measured from its edges */
function read(box: HTMLElement, page: HTMLElement, title: string, warnings: string[], name: string): FlowResult {
    const cs = (el: Element) => getComputedStyle(el);
    const laidOut = box.getBoundingClientRect().width > 0;
    const origin = page.getBoundingClientRect();
    const bs = cs(box);
    const base = { fontFamily: bs.fontFamily, fontSizePt: n(bs.fontSize) * PX, color: hexColor(bs.color) || "#000000", lineHeight: bs.lineHeight === "normal" ? 1.2 : Math.round((n(bs.lineHeight) / n(bs.fontSize)) * 100) / 100 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const track = (el: Element) => { if (!laidOut) return; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return; minX = Math.min(minX, r.left); maxX = Math.max(maxX, r.right); minY = Math.min(minY, r.top); maxY = Math.max(maxY, r.bottom); };

    const hidden = (el: Element, s: CS) => s.display === "none" || s.visibility === "hidden" || SKIP.has(el.tagName) || (laidOut && el.getBoundingClientRect().height === 0 && !el.querySelector("img"));
    const isInline = (node: Node): boolean => node.nodeType === 3 || node instanceof Element && (node.tagName === "BR" || INLINE.test(cs(node).display) && !Array.from(node.children).some((c) => !isInline(c) && !hidden(c, cs(c))));
    const hasText = (node: Node) => !!(node.textContent || "").trim() || node instanceof Element && !!node.querySelector("img");

    /** the style a block carries (only what flow.ts allows), measured, not declared */
    const blockStyle = (el: Element, s: CS, leftOf: number, gapAbove: number | null) => {
        const border = (side: "top" | "bottom") => n(s.getPropertyValue(`border-${side}-width`)) > 0 && s.getPropertyValue(`border-${side}-style`) !== "none" ? `${ptv(n(s.getPropertyValue(`border-${side}-width`)))} ${s.getPropertyValue(`border-${side}-style`)} ${hexColor(s.getPropertyValue(`border-${side}-color`)) || "#000000"}` : "";
        const r = laidOut ? el.getBoundingClientRect() : null;
        return styleAttr({
            "text-align": /^(center|right|justify|end)$/.test(s.textAlign) ? s.textAlign.replace("end", "right") : "",
            "margin-top": gapAbove !== null ? (gapAbove > 0.5 ? ptv(gapAbove) : "") : n(s.marginTop) ? ptv(n(s.marginTop)) : "",
            "margin-bottom": gapAbove === null && n(s.marginBottom) ? ptv(n(s.marginBottom)) : "",
            "margin-left": r ? (r.left + n(s.paddingLeft) - leftOf > 0.5 ? ptv(r.left + n(s.paddingLeft) - leftOf) : "") : n(s.marginLeft) + n(s.paddingLeft) ? ptv(n(s.marginLeft) + n(s.paddingLeft)) : "",
            "text-indent": n(s.textIndent) ? ptv(n(s.textIndent)) : "",
            "line-height": s.lineHeight === "normal" ? "" : String(Math.round((n(s.lineHeight) / n(s.fontSize)) * 100) / 100),
            "font-family": s.fontFamily, "font-size": ptv(n(s.fontSize)), color: hexColor(s.color),
            "font-weight": Number(s.fontWeight) >= 600 || s.fontWeight === "bold" ? "700" : "",
            "font-style": s.fontStyle === "italic" ? "italic" : "",
            "text-transform": s.textTransform !== "none" ? s.textTransform : "",
            "letter-spacing": s.letterSpacing !== "normal" && n(s.letterSpacing) ? ptv(n(s.letterSpacing)) : "",
            "background-color": hexColor(s.backgroundColor),
            "border-top": border("top"), "border-bottom": border("bottom"),
            "padding-bottom": border("bottom") && n(s.paddingBottom) ? ptv(n(s.paddingBottom)) : "",
        });
    };

    /** inline content: runs whose computed look differs from the block's become marks / spans */
    const runs = (nodes: Node[], block: CS): string => nodes.map((node) => {
        if (node.nodeType === 3) return esc((node.textContent || "").replace(/\s+/g, " "));
        if (!(node instanceof Element)) return "";
        const s = cs(node); if (hidden(node, s) && node.tagName !== "BR") return "";
        if (node.tagName === "BR") return "<br>";
        if (node.tagName === "IMG") return img(node as HTMLImageElement);
        let inner = runs(Array.from(node.childNodes), s);
        const diff = styleAttr({
            color: hexColor(s.color) !== hexColor(block.color) ? hexColor(s.color) : "",
            "font-size": Math.abs(n(s.fontSize) - n(block.fontSize)) > 0.4 ? ptv(n(s.fontSize)) : "",
            "font-family": s.fontFamily !== block.fontFamily ? s.fontFamily : "",
            "letter-spacing": s.letterSpacing !== block.letterSpacing && n(s.letterSpacing) ? ptv(n(s.letterSpacing)) : "",
            "text-transform": s.textTransform !== block.textTransform ? s.textTransform : "",
            "background-color": hexColor(s.backgroundColor),
        });
        if (diff) inner = `<span style="${escAttr(diff)}">${inner}</span>`;
        const bold = (w: string) => Number(w) >= 600 || w === "bold";
        if (bold(s.fontWeight) && !bold(block.fontWeight)) inner = `<strong>${inner}</strong>`;
        if (s.fontStyle === "italic" && block.fontStyle !== "italic") inner = `<em>${inner}</em>`;
        if (s.textDecorationLine.includes("underline") && !block.textDecorationLine.includes("underline") && node.tagName !== "A") inner = `<u>${inner}</u>`;
        if (s.textDecorationLine.includes("line-through") && !block.textDecorationLine.includes("line-through")) inner = `<s>${inner}</s>`;
        if (node.tagName === "A" && /^(https?:|mailto:|tel:)/i.test(node.getAttribute("href") || "")) inner = `<a href="${escAttr(node.getAttribute("href")!)}">${inner}</a>`;
        return inner;
    }).join("");

    const img = (el: HTMLImageElement) => {
        const r = laidOut ? el.getBoundingClientRect() : { width: el.width || n(el.getAttribute("width") || ""), height: el.height || n(el.getAttribute("height") || "") };
        return `<img src="${escAttr(el.getAttribute("src") || "")}" alt="${escAttr(el.alt || "")}" style="${styleAttr({ width: r.width ? ptv(r.width) : "", height: r.height ? ptv(r.height) : "" })}">`;
    };

    let lastBottom: number | null = null;
    const gap = (el: Element) => { if (!laidOut) return null; const r = el.getBoundingClientRect(); const g = lastBottom === null ? 0 : r.top - lastBottom; lastBottom = r.bottom; return g; };

    /** a container whose visible children sit side by side (flex / grid / floats / inline-blocks) */
    const sideBySide = (kids: Element[]) => {
        if (!laidOut || kids.length < 2) return false;
        const rs = kids.map((k) => k.getBoundingClientRect());
        return rs.every((r, i) => i === 0 || r.left >= rs[i - 1].right - 2 && r.top < rs[i - 1].bottom && r.bottom > rs[i - 1].top);
    };

    const blocks = (container: Element, leftOf: number): string => {
        let out = "", inlineRun: Node[] = [];
        const flushInline = () => {
            if (inlineRun.some(hasText)) {
                const s = cs(container); track(container);
                out += `<p style="${escAttr(blockStyle(container, s, leftOf, gap(container)))}">${runs(inlineRun, s).trim()}</p>`;
            }
            inlineRun = [];
        };
        for (const node of Array.from(container.childNodes)) {
            if (isInline(node) && !(node instanceof HTMLImageElement && laidOut && cs(node).display === "block")) { inlineRun.push(node); continue; }
            flushInline();
            if (!(node instanceof Element)) continue;
            out += block(node, leftOf);
        }
        flushInline();
        return out;
    };

    const block = (el: Element, leftOf: number): string => {
        const s = cs(el); if (hidden(el, s) || !hasText(el) && el.tagName !== "HR") return "";
        const tag = el.tagName;
        if (tag === "HR") { gap(el); return `<hr style="${escAttr(`border-top: ${ptv(Math.max(1, n(s.borderTopWidth) || n(s.height)))} solid ${hexColor(s.borderTopColor) || hexColor(s.backgroundColor) || "#000000"}`)}">`; }
        if (tag === "IMG") { track(el); gap(el); return `<figure>${img(el as HTMLImageElement)}</figure>`; }
        if (tag === "UL" || tag === "OL") {
            track(el);
            const g = gap(el);
            const items = Array.from(el.children).filter((li) => li.tagName === "LI" && !hidden(li, cs(li))).map((li) => {
                const ls = cs(li), nested = Array.from(li.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
                const own = Array.from(li.childNodes).filter((c) => !nested.includes(c as Element));
                return `<li>${runs(own, ls).trim()}</li>${nested.map((l) => block(l, leftOf)).join("")}`;
            });
            if (laidOut) lastBottom = el.getBoundingClientRect().bottom;
            return `<${tag.toLowerCase()} style="${escAttr(blockStyle(el, s, leftOf, g) + (s.listStyleType !== "disc" && s.listStyleType !== "decimal" ? `; list-style-type: ${s.listStyleType}` : ""))}">${items.join("")}</${tag.toLowerCase()}>`;
        }
        if (tag === "TABLE") {
            track(el); gap(el);
            const rows = Array.from((el as HTMLTableElement).rows).map((tr) => `<tr>${Array.from(tr.cells).map((td) => {
                const ts = cs(td), r = laidOut ? td.getBoundingClientRect() : null;
                const saved = lastBottom; lastBottom = null;
                const inner = blocks(td, r ? r.left + n(ts.paddingLeft) : 0);
                lastBottom = saved;
                const span = (a: string) => ((td as HTMLTableCellElement)[a === "colspan" ? "colSpan" : "rowSpan"] > 1 ? ` ${a}="${(td as HTMLTableCellElement)[a === "colspan" ? "colSpan" : "rowSpan"]}"` : "");
                return `<td${span("colspan")}${span("rowspan")} style="${escAttr(styleAttr({ width: r ? ptv(r.width) : "", "vertical-align": ts.verticalAlign === "middle" ? "middle" : ts.verticalAlign === "bottom" ? "bottom" : "top", "background-color": hexColor(ts.backgroundColor) }))}">${inner}</td>`;
            }).join("")}</tr>`);
            if (laidOut) lastBottom = el.getBoundingClientRect().bottom;
            return `<table>${rows.join("")}</table>`;
        }
        const kids = Array.from(el.children).filter((c) => !hidden(c, cs(c)) && hasText(c));
        if (sideBySide(kids)) {
            const r = el.getBoundingClientRect(), rs = kids.map((k) => k.getBoundingClientRect());
            const short = kids.every((k) => (k.textContent || "").trim().length < 120 && k.getBoundingClientRect().height < n(cs(k).fontSize) * 3.2);
            // "Senior Designer, Acme ………… 2019 – 2023": two short pieces, the last one flush right → one line with a right tab
            if (short && kids.length <= 3 && Math.abs(rs[rs.length - 1].right - (r.right - n(s.paddingRight))) < 4) {
                const g = gap(el); track(el);
                const left = kids.slice(0, -1).map((k) => runs([k], s)).join(" · ");
                return `<p style="${escAttr(blockStyle(el, s, leftOf, g))}">${left}<span data-flow-tab="right" data-flow-pos="${Math.round((r.right - leftOf) * PX)}"></span>${runs([kids[kids.length - 1]], s)}</p>`;
            }
            // anything else side by side is columns: a sidebar and a main column, three skill lists…
            const g = gap(el);
            const cols = kids.map((k, i) => { lastBottom = null; const inner = blocks(k, rs[i].left); return `<div data-flow-col style="width: ${ptv(rs[i].width)}">${inner}</div>`; });
            lastBottom = r.bottom;
            void g;
            return `<div data-flow-cols>${cols.join("")}</div>`;
        }
        if (/^H[1-6]$/.test(tag) || Array.from(el.childNodes).every((c) => isInline(c))) {
            track(el);
            const t = /^H[1-6]$/.test(tag) ? tag.toLowerCase() : "p";
            return `<${t} style="${escAttr(blockStyle(el, s, leftOf, gap(el)))}">${runs(Array.from(el.childNodes), s).trim()}</${t}>`;
        }
        // a plain container: its borders belong to the block under/over them (a rule under a header)
        let out = blocks(el, leftOf);
        const bb = n(s.borderBottomWidth) > 0 && s.borderBottomStyle !== "none";
        if (bb) out += `<hr style="border-top: ${ptv(n(s.borderBottomWidth))} ${s.borderBottomStyle} ${hexColor(s.borderBottomColor) || "#000000"}">`;
        return out;
    };

    const html = blocks(box, laidOut ? box.getBoundingClientRect().left + n(bs.paddingLeft) : 0);
    const sheet = laidOut && Number.isFinite(minX) ? {
        widthPt: 612,
        marginLeftPt: Math.max(18, (minX - origin.left) * PX), marginRightPt: Math.max(18, (origin.right - maxX) * PX),
        marginTopPt: Math.max(18, (minY - origin.top) * PX), marginBottomPt: 36,
    } : undefined;
    return { html, title: title || name, base, page: sheet, warnings };
}
