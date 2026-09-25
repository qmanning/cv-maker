// src/import/markdown.ts — Markdown → FlowDoc. A CommonMark-ish reader sized for résumés: headings, paragraphs,
// emphasis, links, lists (nested, wrapped), quotes, rules, pipe tables, fenced code, a little inline HTML.
// Markdown has no look of its own, so no base style: the structurer gives it a clean default. See flow.ts.
import { FlowResult, esc, escAttr, styleAttr } from "./flow";

const decode = (data: ArrayBuffer | string): string =>
    (typeof data === "string" ? data : new TextDecoder("utf-8").decode(data)).replace(/^﻿/, "");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", rarr: "→", larr: "←", times: "×", deg: "°", eacute: "é", egrave: "è", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", ntilde: "ñ" };
const INLINE_TAGS: Record<string, string> = { b: "strong", strong: "strong", i: "em", em: "em", u: "u", s: "s", strike: "s", del: "s", sup: "sup", sub: "sub" };
const MONO = "font-family: monospace";
const QUOTE_INDENT = "18pt";

interface Ctx { refs: Map<string, { url: string }>; warnings: Set<string>; lostImages: number }

/* ---------------- inline ---------------- */

const LINK_TAIL = /^\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/;
const BARE = /(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]|www\.[^\s<>()]*[^\s<>().,;:!?'"*_~]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
const safeHref = (u: string): string => (/^\s*(javascript|vbscript|data):/i.test(u) ? "" : u);

/** Markdown inline text → FlowDoc inline HTML. Code, links, images, tags and escapes become opaque placeholders
 *  first, so the emphasis rules that run last can never reach inside a URL or a code span. */
function inline(src: string, ctx: Ctx, allowLinks = true): string {
    const slots: string[] = [];
    const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0001`;
    let s = "", i = 0;
    while (i < src.length) {
        const ch = src[i], rest = src.slice(i);
        let m: RegExpExecArray | null;
        if (ch === "\\") {
            if (src[i + 1] === "\n") { s += hold("<br>"); i += 2; continue; }
            if (/[!-/:-@[-`{-~]/.test(src[i + 1] ?? "")) { s += hold(esc(src[i + 1])); i += 2; continue; }
        }
        if (ch === "`" && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
            s += hold(`<span style="${MONO}">${esc(m[2].replace(/\n/g, " ").trim())}</span>`); i += m[0].length; continue;
        }
        if (ch === "!" && src[i + 1] === "[" && (m = /^!\[([^\]]*)\]/.exec(rest))) {
            const tail = LINK_TAIL.exec(rest.slice(m[0].length));
            if (tail) { s += hold(image(m[1], tail[1], ctx)); i += m[0].length + tail[0].length; continue; }
        }
        if (ch === "[" && allowLinks && (m = /^\[((?:[^\[\]]|\[[^\]]*\])*)\]/.exec(rest))) {
            const after = rest.slice(m[0].length), tail = LINK_TAIL.exec(after);
            let url: string | null = null, used = 0;
            if (tail) { url = tail[1]; used = tail[0].length; }
            else {
                const r = /^\[([^\]]*)\]/.exec(after), key = (r && r[1] ? r[1] : m[1]).toLowerCase().trim();
                if (ctx.refs.has(key)) { url = ctx.refs.get(key)!.url; used = r ? r[0].length : 0; }
            }
            if (url !== null) {
                const href = safeHref(url), body = inline(m[1], ctx, false);
                s += hold(href ? `<a href="${escAttr(href)}">${body}</a>` : body); i += m[0].length + used; continue;
            }
        }
        if (ch === "<") {
            if ((m = /^<((?:https?|mailto|tel):[^\s<>]+)>/i.exec(rest))) { s += hold(`<a href="${escAttr(m[1])}">${esc(m[1].replace(/^mailto:/i, ""))}</a>`); i += m[0].length; continue; }
            if ((m = /^<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/.exec(rest))) { s += hold(`<a href="mailto:${escAttr(m[1])}">${esc(m[1])}</a>`); i += m[0].length; continue; }
            if ((m = /^<!--[\s\S]*?-->/.exec(rest))) { i += m[0].length; continue; }
            if ((m = /^<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/i.exec(rest))) {
                const tag = m[2].toLowerCase();
                if (tag === "br") s += hold("<br>");
                else if (INLINE_TAGS[tag]) s += hold(m[1] ? `</${INLINE_TAGS[tag]}>` : `<${INLINE_TAGS[tag]}>`);
                // any other tag (span, div, font…) is dropped and its text kept
                i += m[0].length; continue;
            }
        }
        if (ch === "&" && (m = /^&(#\d+|#x[0-9a-f]+|[a-z]+);/i.exec(rest))) {
            const e = m[1];
            const v = e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()];
            if (v !== undefined) { s += hold(esc(v)); i += m[0].length; continue; }
        }
        s += ch; i++;
    }
    // bare addresses and URLs, in the text that is left
    if (allowLinks) s = s.replace(BARE, (u) => hold(`<a href="${escAttr(/@/.test(u) && !/^https?:/.test(u) ? "mailto:" + u : /^www\./.test(u) ? "https://" + u : u)}">${esc(u)}</a>`));
    // hard breaks: two trailing spaces; any other newline is a soft break (a space)
    s = s.replace(/ {2,}\n/g, () => hold("<br>")).replace(/[ \t]*\n[ \t]*/g, " ");
    s = esc(s);
    const emph = (re: RegExp, open: string, close: string) => { let prev; do { prev = s; s = s.replace(re, (_m, a: string, b: string) => `${a}${open}${b}${close}`); } while (s !== prev); };
    emph(/(^|[^*])\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>", "</em></strong>");
    emph(/(^|[^\w_])___(?=\S)([\s\S]*?\S)___(?![\w])/g, "<strong><em>", "</em></strong>");
    emph(/(^|[^*])\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>", "</strong>");
    emph(/(^|[^\w_])__(?=\S)([\s\S]*?\S)__(?![\w])/g, "<strong>", "</strong>");
    emph(/(^|[^*\\])\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, "<em>", "</em>");
    emph(/(^|[^\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/g, "<em>", "</em>");
    emph(/(^|[^~])~~(?=\S)([\s\S]*?\S)~~/g, "<s>", "</s>");
    // placeholders can nest (a link's text holds its own), so restore until none are left
    let prev: string;
    do { prev = s; s = s.replace(/\u0000(\d+)\u0001/g, (_m, n: string) => slots[Number(n)]); } while (s !== prev);
    return s;
}

function image(alt: string, url: string, ctx: Ctx): string {
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(url)) return `<img src="${escAttr(url)}" alt="${escAttr(alt)}">`;
    ctx.lostImages++;
    return esc(alt);
}

/* ---------------- blocks ---------------- */

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)(.*)$/;
const TABLE_SEP = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const indentOf = (l: string) => /^ */.exec(l)![0].length;
const blank = (l: string) => !l.trim();
const startsBlock = (l: string) => ATX.test(l) || HR.test(l) || FENCE.test(l) || /^ {0,3}>/.test(l) || ITEM.test(l);

function splitRow(line: string): string[] {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    const cells: string[] = []; let cur = "";
    for (let k = 0; k < t.length; k++) {
        if (t[k] === "\\" && t[k + 1] === "|") { cur += "|"; k++; continue; }
        if (t[k] === "|") { cells.push(cur.trim()); cur = ""; continue; }
        cur += t[k];
    }
    cells.push(cur.trim());
    return cells;
}

function blocks(lines: string[], ctx: Ctx, extra: Record<string, string> = {}): string {
    let out = "", i = 0;
    const blockStyle = (more: Record<string, string> = {}) => { const s = styleAttr({ ...extra, ...more }); return s ? ` style="${escAttr(s)}"` : ""; };
    while (i < lines.length) {
        const line = lines[i];
        if (blank(line)) { i++; continue; }
        let m: RegExpExecArray | null;
        if ((m = ATX.exec(line))) { out += `<h${m[1].length}${blockStyle()}>${inline(m[2] ?? "", ctx)}</h${m[1].length}>`; i++; continue; }
        if (HR.test(line)) { out += "<hr>"; i++; continue; }
        if ((m = FENCE.exec(line))) {
            const fence = m[1], body: string[] = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
            i++;
            out += `<p${blockStyle({ "font-family": "monospace" })}>${body.map(esc).join("<br>")}</p>`;
            continue;
        }
        if (/^ {0,3}>/.test(line)) {
            const inner: string[] = [];
            while (i < lines.length && !blank(lines[i]) && (/^ {0,3}>/.test(lines[i]) || !startsBlock(lines[i]))) inner.push(lines[i++].replace(/^ {0,3}> ?/, ""));
            out += blocks(inner, ctx, { ...extra, "margin-left": QUOTE_INDENT });
            continue;
        }
        if (ITEM.test(line)) { const r = list(lines, i, ctx, extra); out += r.html; i = r.next; continue; }
        if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
            const head = splitRow(line), aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
            const cell = (tag: string, text: string, k: number) => `<${tag}${aligns[k] ? ` style="text-align: ${aligns[k]}"` : ""}><p>${inline(text, ctx)}</p></${tag}>`;
            let html = `<table><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr>`;
            i += 2;
            while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
                const row = splitRow(lines[i++]);
                html += `<tr>${head.map((_, k) => cell("td", row[k] ?? "", k)).join("")}</tr>`;
            }
            out += html + "</table>";
            continue;
        }
        // a paragraph: lines until a blank or the start of another block; a setext underline makes it a heading
        const para: string[] = [line];
        i++;
        let heading = 0;
        while (i < lines.length && !blank(lines[i])) {
            if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { heading = 1; i++; break; }
            if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { heading = 2; i++; break; }
            if (startsBlock(lines[i]) || (lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) break;
            para.push(lines[i++]);
        }
        const text = para.map((l) => l.replace(/^[ \t]+/, "")).join("\n").replace(/[ \t\\]+$/, "");
        if (heading) { out += `<h${heading}${blockStyle()}>${inline(text, ctx)}</h${heading}>`; continue; }
        const html = inline(text, ctx);
        const lone = /^<img [^>]*>$/.exec(html);
        out += lone ? `<figure>${html}</figure>` : `<p${blockStyle()}>${html}</p>`;
    }
    return out;
}

/** one list starting at lines[start]: items, their wrapped lines, and lists nested inside them */
function list(lines: string[], start: number, ctx: Ctx, extra: Record<string, string>): { html: string; next: number } {
    const first = ITEM.exec(lines[start])!;
    const baseIndent = first[1].length, ordered = /\d/.test(first[2]), marker = first[2].slice(-1);
    const tag = ordered ? "ol" : "ul";
    const style = styleAttr({ ...extra, "list-style-type": ordered ? "decimal" : "" });
    let html = `<${tag}${style ? ` style="${escAttr(style)}"` : ""}>`;
    let i = start;
    while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        // a different bullet character, or numbers after bullets, starts a new list (as CommonMark does)
        if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered || (!ordered && m[2] !== marker)) break;
        const content = m[1].length + m[2].length + 1;
        const body: string[] = [m[3]];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
            const l = lines[i];
            if (blank(l)) {
                // a blank line ends the item unless what follows is indented into it
                let k = i + 1; while (k < lines.length && blank(lines[k])) k++;
                if (k < lines.length && indentOf(lines[k]) > baseIndent && !(ITEM.test(lines[k]) && indentOf(lines[k]) <= baseIndent)) { sawBlank = true; body.push(""); i++; continue; }
                break;
            }
            const ind = indentOf(l), sub = ITEM.exec(l);
            if (sub && ind <= baseIndent) break;           // the next item (or a shallower list)
            if (ind > baseIndent) { body.push(l.slice(Math.min(ind, content, Math.max(baseIndent + 2, 0)))); i++; continue; } // nested or continued; lenient about how far
            if (!sawBlank && !startsBlock(l)) { body.push(l.trim()); i++; continue; } // a lazy wrapped line
            break;
        }
        // the item's first paragraph is its inline content; nested lists follow it; later paragraphs join with a break
        const inner: string[] = [body[0]], nested: string[] = [];
        let k = 1;
        while (k < body.length && !ITEM.test(body[k]) && !(k > 0 && blank(body[k]))) inner.push(body[k++]);
        const restLines = body.slice(k);
        let text = inline(inner.map((l) => l.replace(/^\s+/, "")).join("\n").replace(/\s+$/, ""), ctx);
        let r = 0;
        while (r < restLines.length) {
            if (blank(restLines[r])) { r++; continue; }
            const trimmed = restLines.slice(r).map((l) => l.replace(/^ {0,4}/, ""));
            if (ITEM.test(restLines[r])) {
                const shift = indentOf(restLines[r]);
                const sub = restLines.slice(r).map((l) => (indentOf(l) >= shift ? l.slice(shift) : l.trim()));
                const res = list(sub, 0, ctx, {});
                nested.push(res.html); r += res.next;
            } else {
                const para: string[] = [];
                while (r < restLines.length && !blank(restLines[r]) && !ITEM.test(restLines[r])) para.push(trimmed[para.length]), r++;
                text += "<br>" + inline(para.join("\n"), ctx);
            }
        }
        html += `<li>${text}${nested.join("")}</li>`;
    }
    return { html: html + `</${tag}>`, next: i };
}

export async function markdownToFlow(data: ArrayBuffer | string, name: string): Promise<FlowResult> {
    let text = decode(data).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
    let title: string | undefined;
    // YAML front matter: the title is worth keeping, the rest is publishing metadata
    const fm = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
    if (fm) {
        const t = /^title:[ \t]*(.+)$/m.exec(fm[1]);
        if (t) title = t[1].trim().replace(/^(["'])(.*)\1$/, "$2");
        text = text.slice(fm[0].length);
    }
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    const ctx: Ctx = { refs: new Map(), warnings: new Set(), lostImages: 0 };
    // link reference definitions: [key]: url "title" — collected, then removed
    const lines = text.split("\n").filter((l) => {
        const m = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/.exec(l);
        if (m) { ctx.refs.set(m[1].toLowerCase().trim(), { url: m[2] }); return false; }
        return true;
    });
    const html = blocks(lines, ctx);
    const warnings = [...ctx.warnings];
    if (ctx.lostImages) warnings.push(`${ctx.lostImages} image${ctx.lostImages > 1 ? "s" : ""} pointed to a file path or web address that can't be read from here; the alt text was kept instead.`);
    void name;
    return { html, title, base: {}, warnings };
}
