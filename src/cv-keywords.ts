// src/components/labs/itera/cv-keywords.ts
// ATS keywords: the words a job ad is screened for, and where the résumé / cover letter already use them.
// Pure text work — the list comes from the person or their AI (it reads the ad; Itera never does), and
// nothing here edits the document: hits are reported as counts and as DOM Ranges for the CSS Custom
// Highlight API, so marking them never touches the markup the editors own.

export const MAX_KEYWORDS = 60;

/** tidy a list from anywhere: strings only, trimmed, inner whitespace collapsed, no duplicates (case-insensitive), capped */
export function normalizeKeywords(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>(), out: string[] = [];
    for (const raw of list) {
        if (typeof raw !== "string") continue;
        const term = raw.replace(/\s+/g, " ").trim().slice(0, 80), key = term.toLowerCase();
        if (!term || seen.has(key)) continue;
        seen.add(key); out.push(term);
        if (out.length >= MAX_KEYWORDS) break;
    }
    return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** a whole word or phrase, any case, any run of whitespace between its words ("design  systems" matches "Design\nSystems");
 *  "whole" means not glued to a letter or digit on either side — so "AI" is not found inside "maintain", but "C++" and "Node.js" work */
export const keywordRegex = (term: string): RegExp =>
    new RegExp(`(?<![\\p{L}\\p{N}])${term.trim().split(/\s+/).map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}])`, "giu");

export const countIn = (text: string, term: string): number => (term.trim() ? (text.match(keywordRegex(term)) || []).length : 0);

/** the text of a document's page as a reader sees it (block boundaries become spaces, so words never fuse) */
export function pageText(pageHtml: string, opts: { skipMirror?: boolean } = {}): string {
    const doc = new DOMParser().parseFromString(pageHtml, "text/html");
    if (opts.skipMirror) doc.querySelectorAll("[data-cv-mirror]").forEach((n) => n.remove());   // a letter's header is the résumé's words, not its own
    return textOf(doc.body).text;
}

interface Piece { node: Text; start: number }
const BLOCKS = new Set(["P", "LI", "DIV", "SECTION", "HEADER", "UL", "OL", "BR", "H1", "H2", "H3", "H4", "TR", "TD"]);
/** every text node under `root`, joined into one string, remembering where each node starts in it */
function textOf(root: Node, skip?: (el: Element) => boolean): { text: string; pieces: Piece[] } {
    let text = ""; const pieces: Piece[] = [];
    const walk = (node: Node) => {
        if (node.nodeType === 3) { pieces.push({ node: node as Text, start: text.length }); text += node.nodeValue || ""; return; }
        if (node.nodeType !== 1) return;
        const el = node as Element;
        if (skip?.(el)) return;
        const block = BLOCKS.has(el.tagName);
        if (block && text && !/\s$/.test(text)) text += " ";
        el.childNodes.forEach(walk);
        if (block && text && !/\s$/.test(text)) text += " ";
    };
    walk(root);
    return { text, pieces };
}

/** where `term` occurs under `root`, as Ranges — a hit may run across nodes ("<strong>Design</strong> systems") */
export function findRanges(root: Element, term: string, opts: { skipMirror?: boolean } = {}): Range[] {
    if (!term.trim()) return [];
    const { text, pieces } = textOf(root, opts.skipMirror ? (el) => el.hasAttribute("data-cv-mirror") : undefined);
    const at = (offset: number, end: boolean): [Text, number] | null => {
        for (let i = pieces.length - 1; i >= 0; i--) {
            const p = pieces[i], len = (p.node.nodeValue || "").length;
            if (offset > p.start || (!end && offset === p.start)) { if (offset - p.start <= len) return [p.node, offset - p.start]; }
        }
        return null;
    };
    const out: Range[] = [];
    for (const m of text.matchAll(keywordRegex(term))) {
        const a = at(m.index!, false), b = at(m.index! + m[0].length, true);
        if (!a || !b) continue;
        const r = root.ownerDocument.createRange();
        try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); out.push(r); } catch { /* a node went away mid-walk */ }
    }
    return out;
}

export interface KeywordUse { keyword: string; resume: number; letter: number }
/** how often each keyword appears in each document's text */
export const coverage = (keywords: string[], resumeText: string, letterText: string): KeywordUse[] =>
    keywords.map((keyword) => ({ keyword, resume: countIn(resumeText, keyword), letter: countIn(letterText, keyword) }));
