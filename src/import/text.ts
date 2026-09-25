// src/import/text.ts — plain text → FlowDoc. Plain text has no formatting, only layout habits: blank lines between
// paragraphs, bullets typed as characters, headings in CAPITALS or underlined, dates pushed right with spaces.
// We read those habits and nothing more; addresses and URLs stay plain text (the structurer links them).
import { FlowResult, esc, escAttr, pt, styleAttr } from "./flow";

/** bytes → text: a BOM wins; then strict UTF-8; then UTF-16 without a BOM (every other byte zero); then cp1252 */
function decode(data: ArrayBuffer | string): string {
    if (typeof data === "string") return data.replace(/^﻿/, "");
    const b = new Uint8Array(data);
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
    if (b.length >= 4) {
        let even = 0, odd = 0;
        const n = Math.min(b.length, 512) & ~1;
        for (let k = 0; k < n; k += 2) { if (b[k] === 0) even++; if (b[k + 1] === 0) odd++; }
        if (odd > n / 4 && even < n / 40) return new TextDecoder("utf-16le").decode(b);
        if (even > n / 4 && odd < n / 40) return new TextDecoder("utf-16be").decode(b);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
    catch { return cp1252(b); } // old Windows Notepad files
}

// cp1252 by table: some TextDecoder builds (Node's) read "windows-1252" as Latin-1 and lose the smart quotes
const HI = "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
function cp1252(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += x >= 0x80 && x <= 0x9f ? HI[x - 0x80] : String.fromCharCode(x);
    return s;
}

const BULLET = /^([ \t]*)([•\-*▪●◦–>·‣∙■□○➢o])[ \t]+(\S.*)$/;
const NUMBER = /^([ \t]*)(\d{1,2})[.)][ \t]+(\S.*)$/;
const RULE = /^[ \t]*([-_=*~#])(?:[ \t]*\1){2,}[ \t]*$/;
// a date range or a single date, as résumés write them on the right of a title line
const DATEISH = /\b(?:19|20)\d{2}\b|\b(?:present|current|now|today)\b/i;
const SPACE_PT = 6; // one leading space ≈ one character of a 10–11pt font

const widthOf = (s: string) => { let w = 0; for (const ch of s) { if (ch === " ") w++; else if (ch === "\t") w += 4 - (w % 4); else break; } return w; };
const tab = (kind = "") => `<span data-flow-tab="${kind}" data-flow-pos=""></span>`;
const withTabs = (s: string) => s.split("\t").map(esc).join(tab());

/** a line's text as inline HTML: "Title      2019 – 2023" puts the dates on a right tab */
function line(s: string): string {
    const t = s.trim();
    const seps = [...t.matchAll(/\t+| {2,}/g)];
    for (const m of seps) {
        const left = t.slice(0, m.index).trimEnd(), right = t.slice(m.index! + m[0].length);
        if (left && right.length <= 40 && DATEISH.test(right) && !/[.!?]$/.test(right)) return withTabs(left) + tab("right") + esc(right.replace(/\t/g, " "));
    }
    return withTabs(t.replace(/ {2,}/g, " "));
}

/** CAPITALS on a short line of their own: how plain-text résumés mark a section */
function capsHeading(t: string): boolean {
    const letters = t.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
    return letters.length >= 3 && letters === letters.toUpperCase() && t.length <= 50 && t.split(/\s+/).length <= 6
        && !/[.!?,;]$/.test(t) && (t.match(/\d/g) || []).length <= 4 && !/@|https?:|www\./i.test(t);
}

function bulletType(ch: string): string {
    if ("•●*-·∙".includes(ch)) return "disc";
    if ("◦○o".includes(ch)) return "circle";
    if ("▪■□".includes(ch)) return "square";
    return `'${ch} '`;
}

interface Item { indent: number; ordered: boolean; ch: string; lines: string[] }

export async function textToFlow(data: ArrayBuffer | string, name: string): Promise<FlowResult> {
    const text = decode(data).replace(/\r\n?/g, "\n").replace(/\f/g, "\n\n").replace(/ /g, " ");
    const lines = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
    // the file's wrap width: hard-wrapped prose fills most of it, an address block does not
    const lengths = lines.filter((l) => l.trim()).map((l) => l.length).sort((a, b) => a - b);
    const wrap = lengths.length ? lengths[Math.floor(lengths.length * 0.9)] : 0;

    let out = "";
    let para: string[] = [], items: Item[] = [], prevBlank = true, afterHeading = false;

    const flushPara = () => {
        if (!para.length) return;
        const indent = Math.min(...para.map(widthOf));
        const trimmed = para.map((l) => l.trim());
        // prose wrapped by the editor: every line but the last runs to near the wrap width
        const prose = trimmed.length > 1 && wrap >= 50 && trimmed.slice(0, -1).every((l) => l.length >= wrap * 0.6);
        let html = "";
        trimmed.forEach((l, k) => {
            if (k) html += prose ? (/\w-$/.test(trimmed[k - 1]) ? "" : " ") : "<br>";
            html += line(l);
        });
        const style = styleAttr({ "margin-left": indent ? pt(indent * SPACE_PT) : "" });
        out += `<p${style ? ` style="${escAttr(style)}"` : ""}>${html}</p>`;
        para = [];
    };
    const flushList = () => {
        if (!items.length) return;
        // indentation decides nesting: a deeper bullet opens a list inside the item before it
        const stack: { indent: number; tag: string; key: string }[] = [];
        for (const it of items) {
            const tag = it.ordered ? "ol" : "ul", key = tag + it.ch;
            while (stack.length && it.indent < stack[stack.length - 1].indent) { const e = stack.pop()!; out += `</li></${e.tag}>`; }
            const top = stack[stack.length - 1];
            if (top && it.indent === top.indent && top.key !== key) { stack.pop(); out += `</li></${top.tag}>`; }
            const cur = stack[stack.length - 1];
            if (cur && it.indent === cur.indent) out += "</li>";
            else {
                const style = styleAttr({ "list-style-type": it.ordered ? "decimal" : bulletType(it.ch), "margin-left": !stack.length && it.indent ? pt(it.indent * SPACE_PT) : "" });
                out += `<${tag} style="${escAttr(style)}">`;
                stack.push({ indent: it.indent, tag, key });
            }
            out += `<li>${it.lines.map(line).join(" ")}`;
        }
        while (stack.length) out += `</li></${stack.pop()!.tag}>`;
        items = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i], t = raw.trim();
        if (!t) { flushPara(); prevBlank = true; afterHeading = false; continue; }
        const wasHeading = afterHeading;
        afterHeading = false;
        if (RULE.test(raw)) {
            const ch = t[0];
            if (wasHeading && !prevBlank && (ch === "=" || ch === "-")) continue; // "SKILLS\n------": already a heading
            // "Experience\n==========": the underline makes the line above a heading
            if (!prevBlank && (ch === "=" || ch === "-") && para.length) {
                const head = para.pop()!.trim();
                flushPara(); flushList();
                out += `<h2>${line(head)}</h2>`;
                prevBlank = false; afterHeading = true; continue;
            } else { flushPara(); flushList(); out += "<hr>"; }
            prevBlank = false; continue;
        }
        const m = BULLET.exec(raw) || NUMBER.exec(raw);
        if (m) { // ("o" counts only when a space follows it: "o Designed…" is a bullet, "or" never is)
            flushPara();
            const ordered = /\d/.test(m[2]);
            items.push({ indent: widthOf(m[1]), ordered, ch: ordered ? "1" : m[2], lines: [m[3]] });
            prevBlank = false; continue;
        }
        if (items.length && !prevBlank) {
            // a wrapped bullet: hanging indent, or (unindented) the previous line ran long and this one carries on
            const last = items[items.length - 1], prev = lines[i - 1].trim();
            if (widthOf(raw) > last.indent || (prev.length >= wrap * 0.6 && wrap >= 50 && /^[a-z0-9(]/.test(t))) { last.lines.push(t); continue; }
        }
        flushList();
        if (capsHeading(t)) { flushPara(); out += `<h2>${line(t)}</h2>`; prevBlank = false; afterHeading = true; continue; }
        para.push(raw);
        prevBlank = false;
    }
    flushPara(); flushList();
    void name;
    return { html: out, base: {}, warnings: [] };
}
