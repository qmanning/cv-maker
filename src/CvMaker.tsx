// src/components/labs/icedcoffee/CvMaker.tsx
// IcedCoffee: a sheet of paper on an Infospector-style canvas. The résumé is a source HTML file
// (public/icedcoffee/templates/…) whose [data-cv-edit] regions each become a TipTap editor mounted
// directly ON the template's own element — so what you edit is exactly what gets exported.

"use client";

import "./cv-maker.css";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { TextAlign } from "@tiptap/extension-text-align";
import {
    AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowUp, Bold, BookOpen, BriefcaseBusiness, Plus, Text, Columns2, Copy, Download,
    Eraser, FileCode2, FileImage, FileText, FileType2, ImageUp, Italic, Link2, List, Minus, Moon, RotateCcw,
    Save, SpellCheck, Sun, Upload, Trash2, Underline as UnderlineIcon, ALargeSmall, MoveVertical, MoveHorizontal,
    Sparkles, Bot, Shapes, LifeBuoy, SendHorizontal, Undo2, Check, Settings2, X, Star, RefreshCw, FileUser, ChevronLeft, Files, GripVertical, ScanSearch, CircleCheck, CircleDashed,
} from "lucide-react";
import { FontSize } from "@/components/ui/font-size-extension";
import { FontWeight } from "@/components/ui/font-weight-extension";
import { BlockLineHeight, ColumnBreak, LetterSpacing } from "./cv-extensions";
import { BLOCK_KINDS, UNIT, insertBlock, topBlocks, type BlockKind } from "./cv-blocks";
import { attachColorPicker, toHex, useInfospectorLook } from "./use-infospector-look";
import { LookMenu } from "./LookMenu";
import { applyOps, describeDocument, type CvAssistant, type CvRemote, type CvRemoteHandlers, type CvRemoteStatus, type RemotePage } from "./cv-assistant";
import { coverage, findRanges, normalizeKeywords, pageText, type KeywordUse } from "./cv-keywords";
import { FOOTER_PT, GAP_PT, MIN_FIT, PAPERS, PT, type DocKind, type PaperId, type Source, docKind, fullHtml, letterCss, migrateCss, mirrorHeader, pageBoxCss, parseSource, slugify, stepZoom } from "./cv-source";

const LOCAL_KEY = "cvm:doc", LETTER_KEY = "cvm:letter", KW_KEY = "cvm:keywords", KW_POS_KEY = "cvm:kw-pos", KW_SIZE_KEY = "cvm:kw-size", START_SIZE_KEY = "cvm:startsize", HOME_KEY = "cvm:home", VIEW_ZOOM_KEY = "cvm:viewzoom";
const stored = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const store = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } };
// the viewer remembers the last size the person set (across documents and sessions); null = fit to width
const readViewZoom = (): number | "width" | "height" => { const s = stored(VIEW_ZOOM_KEY); if (s === "width" || s === "height") return s; const n = parseFloat(s); return Number.isFinite(n) && n > 0 ? n : 1; };   // default 100%, not fit-width
const ZOOMS = [1, 1.25, 1.5, 2];

// zoom: a fixed number, or a LIVE fit that tracks the window — "width" (the sheet fills the canvas width; null is the
// legacy spelling) or "height" (one sheet fills the canvas height; "browser" is its legacy spelling)
interface Settings { paper: PaperId; paginate: boolean; spellcheck: boolean; zoom: number | "width" | "height" | "browser" | null; fit: boolean }
interface SavedDoc extends Source { name: string; settings: Settings; savedAt: string; unsaved?: boolean }

/** one entry in the shell's recent-documents list, for the omni bar's typeahead */
export interface RecentDoc { path: string; name: string; pinned?: boolean }

/** A desktop shell's file system, when there is one: the document is then a real Source HTML file on disk.
 *  Without it (every web build) the document lives in this browser — autosave + Import / Export → Source HTML. */
export interface CvFiles {
    /** the file that is open right now, read fresh from disk — null when there is none */
    current(kind?: DocKind): Promise<{ text: string; name: string } | null>;
    /** write the Source HTML to the open file; asks where when there is none, or when `as` is set.
     *  Resolves to the file's name, or null if the person cancelled. */
    save(html: string, opts: { as?: boolean; suggested: string; kind?: DocKind }): Promise<string | null>;
    /** show the shell's Open dialog — the chosen file arrives through onOpen */
    open(kind?: DocKind): void;
    /** the shell hands over a document: File → Open, a recent or dropped file, a reload after it changed on disk */
    onOpen(handler: (doc: { text: string; name: string; note?: string; kind?: DocKind }) => void): () => void;
    /** the shell's own File menu asks for a save (its ⌘S / ⇧⌘S never reach the page as key presses) */
    onCommand(handler: (command: "save" | "saveAs" | "saveAll") => void): () => void;
    /** unsaved edits? — the shell's title bar and close guard */
    setDirty(dirty: boolean, kind?: DocKind): void;
    /** which tab is showing — the shell's title bar, File menu and Save follow it */
    setActive?(kind: DocKind): void;
    /** the last documents opened, newest first (a pinned "master" sorts to the top) — the omni typeahead */
    recent?(kind?: DocKind): Promise<RecentDoc[]>;
    /** open a specific recent file by path — the chosen file arrives back through onOpen */
    openPath?(path: string): void;
    /** pin (or unpin) a file as the master, so it heads the list and is the default document */
    pin?(path: string, pinned: boolean): void;
    /** save a copy under a new name, beside the open file (else in Documents) — no dialog; rejects if that name is taken.
     *  Resolves to the new file's name, which becomes the open document. */
    saveAs?(html: string, name: string, kind?: DocKind): Promise<string>;
    /** the recent list changed (an open, a save, a pin) — refresh the typeahead */
    onRecent?(handler: (list: RecentDoc[]) => void): () => void;
    /** the shell's own Save panel for an export finished (saved or cancelled) — the scan runs until then */
    onDownload?(handler: (state: string) => void): () => void;
    /** shell chrome the brand menu drives: check for updates, open a URL outside the app, name this build */
    checkUpdates?(): void;
    version?(): Promise<string>;
    openExternal?(url: string): void;
}

/** the IcedCoffee mark, for the toolbar: the same iced-coffee cup as public/icedcoffee/brand/icedcoffee-glyph.svg
 *  (the source of truth). Takes currentColor so it sits with the other toolbar icons. */
function IcedCoffeeGlyph(props: { className?: string }) {
    return (
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg" className={props.className} aria-hidden="true">
            <path d="M8 12.9341H25M20.5854 2L17.7835 12.4567M8.80952 12.9341L11.5238 29H21.4762L24.1905 12.9341C23.8889 10.7064 21.9286 6.25099 16.5 6.25099C11.0714 6.25099 9.11111 10.7064 8.80952 12.9341ZM14.2381 23.4361L15.8052 24.3908L14.9004 26.0444L13.3333 25.0897L14.2381 23.4361ZM17.8571 20.1114L19.605 19.6172L20.0733 21.4615L18.3255 21.9558L17.8571 20.1114ZM13.3333 17.6426L13.8017 15.7983L15.5495 16.2925L15.0812 18.1368L13.3333 17.6426Z" />
        </svg>
    );
}
/** Q Manning's own logo mark, for the attribution button — takes currentColor so it matches the label. */
function QLogo(props: { className?: string }) {
    return (
        <svg viewBox="0 0 40 41" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={props.className} aria-hidden="true">
            <path d="M19.4828 4.74833C17.0018 4.74624 14.5581 5.35074 12.3651 6.50902C10.1721 7.66731 8.29652 9.34413 6.90222 11.393C5.50792 13.4419 4.63731 15.8005 4.36646 18.2628C4.09561 20.7251 4.43274 23.2161 5.34843 25.5183C6.26411 27.8205 7.73048 29.8638 9.61943 31.4697C11.5084 33.0756 13.7624 34.1952 16.1847 34.7308C18.6069 35.2664 21.1237 35.2017 23.5151 34.5422C25.9065 33.8827 28.0998 32.6486 29.9034 30.9477L26.3954 27.4451C26.3099 27.3595 26.2619 27.2435 26.262 27.1226C26.2622 27.0017 26.3104 26.8857 26.3962 26.8003C26.4819 26.7149 26.5981 26.6671 26.7192 26.6672C26.8403 26.6673 26.9564 26.7155 27.0419 26.8011L30.5408 30.3022C32.5732 28.1466 33.929 25.4441 34.441 22.5281C34.953 19.6121 34.5989 16.6103 33.4222 13.893C32.2455 11.1756 30.2978 8.8617 27.8194 7.23667C25.3409 5.61165 22.4402 4.74662 19.4752 4.74833H19.4828ZM30.2837 24.0048C30.247 24.0988 30.1874 24.1822 30.1104 24.2475C30.0333 24.3127 29.9411 24.3578 29.8423 24.3786C29.7434 24.3994 29.6409 24.3953 29.544 24.3666C29.4471 24.3379 29.3589 24.2857 29.2873 24.2144L27.1484 22.0789C27.0343 21.9653 26.8798 21.9014 26.7187 21.9014C26.5575 21.9014 26.403 21.9653 26.2889 22.0789L21.5547 26.8041C21.4982 26.8606 21.4533 26.9276 21.4227 27.0013C21.392 27.0751 21.3763 27.1541 21.3763 27.234C21.3763 27.3138 21.392 27.3929 21.4227 27.4666C21.4533 27.5404 21.4982 27.6074 21.5547 27.6638L23.6739 29.7797C23.7466 29.8522 23.7997 29.9419 23.8283 30.0405C23.8569 30.139 23.86 30.2432 23.8374 30.3433C23.8148 30.4434 23.7671 30.5361 23.6989 30.6129C23.6306 30.6896 23.5441 30.7478 23.4472 30.7821C20.966 31.6948 18.2468 31.7325 15.7412 30.889C13.2356 30.0455 11.0945 28.3715 9.67337 26.1452C8.25227 23.9188 7.63676 21.274 7.92909 18.6501C8.22142 16.0263 9.404 13.5812 11.2804 11.7211C13.1568 9.86094 15.6141 8.69771 18.2441 8.42459C20.874 8.15147 23.5185 8.7849 25.7381 10.2197C27.9577 11.6544 29.6189 13.8042 30.4458 16.3118C31.2727 18.8195 31.2155 21.5341 30.2837 24.0048Z" />
            <path d="M39.822 34.7389L36.0661 30.9887C35.9694 30.8922 35.9081 30.7659 35.8921 30.6304C35.8761 30.4948 35.9063 30.3578 35.9778 30.2414C37.169 28.3357 38.0194 26.2378 38.4909 24.0413C40.747 13.5944 33.845 3.04568 23.3605 0.899486C18.3231 -0.129812 13.0825 0.871968 8.78209 3.68623C4.48173 6.50049 1.47074 10.8988 0.406197 15.9213C-1.7616 26.1374 4.98367 36.6268 15.1883 38.9158C20.1637 40.0381 25.3816 39.1596 29.7133 36.4704C29.8297 36.4 29.9663 36.3705 30.1015 36.3867C30.2366 36.403 30.3624 36.464 30.4587 36.56L34.2284 40.3223C34.3424 40.4359 34.497 40.4997 34.6581 40.4997C34.8193 40.4997 34.9738 40.4359 35.0879 40.3223L39.822 35.597C39.9358 35.4831 39.9997 35.3288 39.9997 35.168C39.9997 35.0071 39.9358 34.8528 39.822 34.7389ZM35.7146 36.1059C35.6722 36.1483 35.6219 36.1821 35.5664 36.2051C35.5109 36.228 35.4514 36.2399 35.3914 36.2399C35.3313 36.2399 35.2718 36.228 35.2164 36.2051C35.1609 36.1821 35.1105 36.1483 35.0681 36.1059L30.55 31.5948C27.4757 34.495 23.3816 36.0706 19.153 35.9809C14.9245 35.8911 10.9012 34.1433 7.95311 31.1152C5.00505 28.0871 3.36913 24.0221 3.3991 19.7993C3.42906 15.5764 5.12248 11.535 8.11322 8.54894C11.104 5.56286 15.1517 3.87206 19.3811 3.84214C23.6105 3.81223 27.6818 5.44559 30.7146 8.38906C33.7474 11.3325 35.4981 15.3496 35.5879 19.5716C35.6778 23.7936 34.0998 27.8813 31.195 30.9507L35.7146 35.4619C35.799 35.5474 35.8461 35.6626 35.8458 35.7827C35.8456 35.9027 35.7979 36.0177 35.7131 36.1028L35.7146 36.1059Z" />
        </svg>
    );
}
// first-run tour: each step reveals one more toolbar control (REVEAL) and points a coach-mark at it.
// "Choose Icon" picker: its own chunk (the Lucide set is large), so it only loads when someone opens it
const IconPicker = lazy(() => import("./IconPicker"));
const TOUR_KEY = "ic:onboarded";
const REVEAL: Record<string, number> = { glyph: 1, omni: 2, size: 3, paginate: 4, spell: 5, save: 6, export: 7, seg: 8 };
type TourStep = { at: string; title: string; body: string; side?: "letter" | "brandMenu" | "bgOptions"; place?: "right" };
const TOUR: TourStep[] = [
    { at: '[data-tour="glyph"]', title: "Enjoy some IcedCoffee!", body: "IcedCoffee is an AI-enabled résumé and CV tool. Point your AI at a job posting and it rewrites the wording and terms of your résumé to match it." },
    { at: '[data-tour="omni"]', title: "Your document", body: "Edit the sample résumé, or open your own — every IcedCoffee document is a plain .html file. Once you've saved a few, reopen recent ones right here." },
    { at: '[data-tour="size"]', title: "Size & zoom", body: "IcedCoffee edits at full width by default. Change the paper size or fit here, or press ⌘/Ctrl with + or − to zoom in and out. It remembers the size you set and reopens every document there." },
    { at: '[data-tour="paginate"]', title: "Pagination", body: "Switch between real pages — with page numbers, so you see exactly where each one ends — and one continuous sheet. (Turn on “Fit to one page” under Size to shrink the design onto a single page.)" },
    { at: '[data-tour="spell"]', title: "Spellcheck", body: "Turn the browser's spellcheck on or off for the whole document: red squiggles under unrecognized words while you write, off for a clean view." },
    { at: '[data-tour="save"]', title: "Save", body: "Save your work with ⌘S. Every résumé and cover letter is a plain .html file that's yours — “Save As” branches a copy so your master stays untouched." },
    { at: '[data-tour="export"]', title: "Export", body: "Export a PDF with real, selectable text, a Word (.docx) for applicant-tracking systems, a PNG, or the source HTML — for the résumé, the cover letter, or both at once." },
    { at: '[data-tour="seg"]', title: "Résumé & cover letter", body: "Switch between your résumé and its cover letter here. Let's take a look at the cover letter…" },
    { at: '[data-tour="seg"]', title: "Two separate files", body: "The cover letter is its own file. But its header — your name, contact details and headline — mirrors the résumé, so you set those once on the résumé and the letter follows.", side: "letter" },
    { at: ".cvm-brand-menu", title: "The IcedCoffee menu", body: "Appearance, ATS keywords, updates and more all live in this menu.", side: "brandMenu", place: "right" },
    { at: "#pt-ctx", title: "Make it yours", body: "Background · colors · appearance is where the coffee theme is set — recolor the canvas, the frosted glass and the accent to anything you like.", side: "bgOptions", place: "right" },
];

// two documents share the editor — a résumé and its cover letter — one per tab, each with its own file / autosave slot
const keyOf = (kind: DocKind) => (kind === "letter" ? LETTER_KEY : LOCAL_KEY);
const KIND_LABEL: Record<DocKind, string> = { resume: "Résumé", letter: "Cover Letter" };
interface Slot { source: Source; name: string; fileName: string; dirty: boolean; undo: Source[] }
const DEFAULT_SETTINGS: Settings = { paper: "letter", paginate: true, spellcheck: true, zoom: null, fit: true };

function download(blob: Blob, filename: string) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// the start-up source file (Start-up → Page), falling back to the bundled one if it can't be fetched
async function fetchSource(templateUrl: string): Promise<string> {
    const home = stored(HOME_KEY);
    if (home) { try { const r = await fetch(home, { cache: "no-store" }); if (r.ok) return await r.text(); } catch { /* fall through */ } }
    return (await fetch(templateUrl, { cache: "no-store" })).text();
}

// PNG with no server: lay the export HTML out in an off-screen iframe and let html-to-image (the build Infospector
// ships) draw it at 2×. Columns, fonts and the fit-to-page zoom all survive because the browser itself renders it.
// html-to-image draws by cloning the DOM into an <svg><foreignObject> and copying each node's COMPUTED style
// onto the clone. For a block the browser has fragmented across a CSS multi-column container (.cv-flow), the
// computed width/height is that of ONE FRAGMENT — 372px, not the 749px element. Baking that back on as an
// explicit size makes the clone re-fragment inside the foreignObject and spill a THIRD column off the page.
// Overriding it on the live document doesn't help: getComputedStyle still reports the used fragment size. So
// the override has to land in the clone, where a stylesheet beats the copied inline styles (they carry no
// !important) and the flow lays out from the real CSS again. Electron exports don't go through any of this —
// they screenshot a real page — which is why this only ever showed up in the browser.
const UNBAKE_FRAGMENTS = ".cv-flow, .cv-flow * { width: auto !important; height: auto !important; }";
const SVG_DATA_PREFIX = "data:image/svg+xml;charset=utf-8,";

async function rasterize(html: string, widthPt: number, heightPt: number, libUrl: string): Promise<Blob> {
    type Lib = { toSvg: (node: HTMLElement, opts: Record<string, unknown>) => Promise<string> };
    const w = window as unknown as { htmlToImage?: Lib };
    if (!w.htmlToImage) await new Promise<void>((res, rej) => { const sc = document.createElement("script"); sc.src = libUrl; sc.onload = () => res(); sc.onerror = () => rej(new Error("PNG export needs html-to-image.js (or an export server)")); document.head.appendChild(sc); });
    const frame = document.createElement("iframe"), wPx = Math.round(widthPt * PT), hPx = Math.round(heightPt * PT);
    frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${wPx}px;height:${hPx}px;border:0;visibility:hidden`;
    frame.srcdoc = html;
    await new Promise<void>((res) => { frame.onload = () => res(); document.body.appendChild(frame); });
    try {
        const doc = frame.contentDocument!; await doc.fonts?.ready;
        const hFull = Math.max(hPx, doc.documentElement.scrollHeight);
        const svgUrl = await w.htmlToImage!.toSvg(doc.documentElement, { pixelRatio: 2, width: wPx, height: hFull, backgroundColor: "#ffffff" });
        return await drawSvg(unbake(svgUrl), wPx, hFull);
    } finally { frame.remove(); }
}

/** put UNBAKE_FRAGMENTS inside the cloned document. If the data URL isn't the shape we expect, leave it alone. */
function unbake(svgUrl: string): string {
    if (!svgUrl.startsWith(SVG_DATA_PREFIX)) return svgUrl;
    try {
        const svg = new DOMParser().parseFromString(decodeURIComponent(svgUrl.slice(SVG_DATA_PREFIX.length)), "image/svg+xml");
        const root = svg.querySelector("foreignObject > *");
        if (!root || svg.querySelector("parsererror")) return svgUrl;
        const style = svg.createElementNS("http://www.w3.org/1999/xhtml", "style");
        style.textContent = UNBAKE_FRAGMENTS;
        (root.querySelector("head") || root).appendChild(style);
        return SVG_DATA_PREFIX + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    } catch { return svgUrl; }
}

/** the step html-to-image's toBlob would have done for us: the SVG onto a 2× canvas, then PNG bytes */
async function drawSvg(svgUrl: string, wPx: number, hPx: number): Promise<Blob> {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("PNG export failed")); img.src = svgUrl; });
    const canvas = document.createElement("canvas");
    canvas.width = wPx * 2; canvas.height = hPx * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("PNG export failed");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("PNG export failed");
    return blob;
}

// Inserted rows ([data-cv-added]) always get breathing room: at least MIN_GAP_PT of space to the block above and
// below, measured on the laid-out page and topped up with inline margins (so it persists in the saved source).
// Two entries of the same repeating kind (job next to job) keep the template's own rhythm instead.
const MIN_GAP_PT = 12, DIVIDER_GAP_PT = 7;   // a divider carries 5pt of its own padding: 7 + 5 = the same 12
function normalizeGaps(page: HTMLElement, pageWPt: number): void {
    const rect = page.getBoundingClientRect(); if (!rect.width) return;
    const zoomK = parseFloat(getComputedStyle(page).zoom) || 1, pxPerOwnPt = (rect.width / pageWPt) * zoomK;   // screen px per pt in the page's own units
    const added = topBlocks(page).filter((b) => b.hasAttribute("data-cv-added"));
    for (const b of added) { b.style.marginTop = ""; b.style.marginBottom = ""; }
    const sameRun = (a: Element, b: Element | null) => !!b && a.hasAttribute("data-cv-repeat") && a.getAttribute("data-cv-repeat") === b.getAttribute("data-cv-repeat");
    for (const b of added) {
        const min = b.classList.contains("cv-divider") ? DIVIDER_GAP_PT : MIN_GAP_PT;
        for (const side of ["Top", "Bottom"] as const) {
            const other = side === "Top" ? b.previousElementSibling : b.nextElementSibling;
            if (!other || other.classList.contains("cvm-spacer") || sameRun(b, other)) continue;
            for (let pass = 0; pass < 3; pass++) {             // margins collapse, so top up and re-measure
                const gap = (side === "Top" ? b.getBoundingClientRect().top - other.getBoundingClientRect().bottom : other.getBoundingClientRect().top - b.getBoundingClientRect().bottom) / pxPerOwnPt;
                if (gap >= min - 0.25) break;
                const cur = parseFloat(getComputedStyle(b)[`margin${side}`]) / PT || 0;
                b.style[`margin${side}`] = (cur + (min - gap)).toFixed(2) + "pt";
            }
        }
    }
}

/* ---------------- component ---------------- */

// Framework-agnostic on purpose (no router, no server assumptions): the same component runs inside this
// site and as the standalone drop-in (github.com/qmanning/icedcoffee), configured only by these props.
export interface CvMakerProps {
    /** the source HTML the editor starts from (Start-up → Page in the menu overrides it per browser) */
    templateUrl: string;
    /** the cover letter a new letter starts from; defaults to sample-cover-letter.html beside templateUrl */
    letterTemplateUrl?: string;
    /** POST endpoint that renders PDF/PNG in headless Chrome. Omit it — or let it fail — and PDF falls back to the
     *  browser's print dialog and PNG to an in-browser render, so the tool works with no server at all. */
    exportUrl?: string;
    /** where the back arrow goes; no arrow when omitted */
    backHref?: string;
    /** Infospector's stylesheet (the glass chrome) and its html-to-image build (the in-browser PNG fallback) */
    glassCssUrl?: string;
    rasterizerUrl?: string;
    /** a desktop shell's real files (see CvFiles); omitted on the web */
    files?: CvFiles;
    /** a desktop shell's bridge to the person's own AI (see cv-assistant.ts); omitted on the web — no prompt bar */
    assistant?: CvAssistant;
    /** a desktop shell that lets an outside AI app drive the editor (its MCP server); omitted on the web */
    remote?: CvRemote;
}

export default function CvMaker({ templateUrl, letterTemplateUrl, exportUrl, backHref, glassCssUrl = "/labs/infospector/host.css", rasterizerUrl = "/labs/infospector/vendor/html-to-image.js", files, assistant, remote }: CvMakerProps) {
    const look = useInfospectorLook(glassCssUrl);
    const [source, setSource] = useState<Source | null>(null);
    const [name, setName] = useState("Résumé");
    const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, zoom: readViewZoom() }));
    const [pages, setPages] = useState(1);
    const [scale, setScale] = useState(1);
    const [contentPt, setContentPt] = useState(0);
    const [active, setActive] = useState<Editor | null>(null);
    const [, setTick] = useState(0);
    const [dirty, setDirty] = useState(false);
    const [menu, setMenu] = useState<{ id: "size" | "export" | "more" | "brand"; left?: number; right?: number; top: number } | null>(null);
    const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
    const [imgPop, setImgPop] = useState<{ img: HTMLImageElement; left: number; top: number } | null>(null);
    const [iconFor, setIconFor] = useState<HTMLImageElement | null>(null);   // "Choose Icon" target
    const [iconAt, setIconAt] = useState({ left: 0, top: 0 });
    const [iconColor, setIconColor] = useState("#111111");
    const openIconPicker = (img: HTMLImageElement) => {
        const r = img.getBoundingClientRect(), W = 300, H = 400;
        let left = r.right + 10; if (left + W > window.innerWidth - 8) left = Math.max(8, r.left - W - 10);
        const top = Math.max(8, Math.min(r.top, window.innerHeight - H - 8));
        setIconAt({ left, top }); setImgPop(null); setIconFor(img);
    };
    // live: recolour whatever SVG icon is on the target image (works for one placed this session or earlier)
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [confirm, setConfirm] = useState<{ msg: string; ok: string; run: () => void } | null>(null);
    const [toast, setToast] = useState("");
    const [busy, setBusy] = useState("");
    const [fits, setFits] = useState({ width: 1.25, height: 0.7 });
    const [startSize, setStartSize] = useState(() => stored(START_SIZE_KEY) || "last");   // "last" | a paper id
    const [home, setHome] = useState(() => stored(HOME_KEY));                          // start-up source file; "" = the bundled one
    // desktop only: the open file's identity (basename, no extension) drives the export filename and the omni bar's label
    const [fileName, setFileName] = useState("");
    // which of the two documents is on the sheet; the other waits in its slot (null = not loaded yet)
    const [tab, setTab] = useState<DocKind>("resume");
    const slots = useRef<Record<DocKind, Slot | null>>({ resume: null, letter: null });
    const [exportKind, setExportKind] = useState<"pdf" | "png" | "docx" | "html" | null>(null);
    // ATS keywords: what a job ad is screened for (from the person, or their AI reading the ad) — one list for both documents
    const [kw, setKw] = useState<{ job: string; keywords: string[] }>(() => { try { const v = JSON.parse(stored(KW_KEY) || "null"); return { job: typeof v?.job === "string" ? v.job : "", keywords: normalizeKeywords(v?.keywords) }; } catch { return { job: "", keywords: [] }; } });
    const [kwOpen, setKwOpen] = useState(false), [kwActive, setKwActive] = useState<string | null>(null), [kwDraft, setKwDraft] = useState("");
    const [kwPos, setKwPos] = useState<{ x: number; y: number } | null>(() => { try { const v = JSON.parse(stored(KW_POS_KEY) || "null"); return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? v : null; } catch { return null; } });
    const [kwSize, setKwSize] = useState<{ w: number; h: number } | null>(() => { try { const v = JSON.parse(stored(KW_SIZE_KEY) || "null"); return v && Number.isFinite(v.w) && Number.isFinite(v.h) ? v : null; } catch { return null; } });
    const kwRef = useRef<HTMLDivElement>(null);
    // first-run tour: 0 = off, 1..TOUR.length = the current step. Starts on the first visit — or any time
    // the URL carries ?tour (so it can be replayed without clearing anything).
    const [tour, setTour] = useState(() => { try { const q = new URLSearchParams(window.location.search); if (q.has("smoke")) return 0; if (q.has("tour")) return 1; } catch { /* ignore */ } return stored(TOUR_KEY) ? 0 : 1; });
    const [coach, setCoach] = useState<{ left: number; top: number; arrow: number; right: boolean } | null>(null);
    const [kwUses, setKwUses] = useState<KeywordUse[]>([]), [kwRev, setKwRev] = useState(0);
    const kwCount = useRef(0); kwCount.current = kw.keywords.length;
    // desktop only: the recent-documents typeahead that lives in the omni bar
    const hasRecents = !!files?.recent;
    const [recents, setRecents] = useState<RecentDoc[]>([]);
    const [omniOpen, setOmniOpen] = useState(false);
    const [omniQuery, setOmniQuery] = useState("");
    const [omniIdx, setOmniIdx] = useState(0);

    const wrapRef = useRef<HTMLElement>(null), hostRef = useRef<HTMLDivElement>(null), paperRef = useRef<HTMLDivElement>(null);
    const editorsRef = useRef<Editor[]>([]), tipRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null), imgFileRef = useRef<HTMLInputElement>(null), omniRef = useRef<HTMLDivElement>(null);
    const stateRef = useRef({ name, fileName, settings, source, scale, pages, tab, dirty, contentPt, kwJob: kw.job, keywords: kw.keywords }); stateRef.current = { name, fileName, settings, source, scale, pages, tab, dirty, contentPt, kwJob: kw.job, keywords: kw.keywords };
    const shellSaving = useRef(0), shellSavingTimer = useRef(0), exporting = useRef(false);
    const rafRef = useRef(0), saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const paper = PAPERS[settings.paper];
    const zoomMode = typeof settings.zoom === "number" ? "fixed" : settings.zoom === "height" || settings.zoom === "browser" ? "height" : "width";
    const zoom = typeof settings.zoom === "number" ? settings.zoom : fits[zoomMode === "height" ? "height" : "width"];
    const zoomRef = useRef(zoom); zoomRef.current = zoom;
    const say = useCallback((msg: string) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 2600); }, []);

    /* ---- serialize: the clean document, straight from the editors ---- */
    const serialize = useCallback((opts: { breaks?: boolean } = {}): string => {
        const live = hostRef.current?.querySelector(".cv-page"); if (!live) return stateRef.current.source?.html || "";
        const clone = live.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[data-cv-edit]").forEach((el, i) => {
            const ed = editorsRef.current[i]; if (ed) el.innerHTML = ed.getHTML();
            ["contenteditable", "translate", "tabindex", "spellcheck", "role", "aria-multiline", "aria-label"].forEach((a) => el.removeAttribute(a));
            el.classList.remove("ProseMirror", "tiptap", "ProseMirror-focused");
        });
        clone.querySelectorAll(".cvm-hot").forEach((el) => el.classList.remove("cvm-hot"));
        clone.querySelectorAll(".cvm-spacer").forEach((el) => { if (opts.breaks) { const b = document.createElement("div"); b.className = "cvm-pagebreak"; el.replaceWith(b); } else el.remove(); });
        clone.style.removeProperty("min-height"); if (!clone.getAttribute("style")) clone.removeAttribute("style");
        return clone.outerHTML;
    }, []);

    /* ---- pagination: push blocks that would straddle a page edge onto the next sheet ---- */
    const paginate = useCallback(() => {
        const page = hostRef.current?.querySelector<HTMLElement>(".cv-page"); if (!page) return;
        const { settings: s, scale: sc } = stateRef.current, p = PAPERS[s.paper];
        page.querySelectorAll(".cvm-spacer").forEach((n) => n.remove());
        page.style.minHeight = "";
        const k = page.getBoundingClientRect().width / p.w;                       // screen px per pt (includes zoom)
        const at = (el: Element, edge: "top" | "bottom") => (el.getBoundingClientRect()[edge] - page.getBoundingClientRect().top) / k;
        const cs = getComputedStyle(page), padTop = (parseFloat(cs.paddingTop) / PT) * sc;
        // fit to one page: the natural height (in the page's own units) doesn't depend on the scale, so one pass settles it
        const natural = page.getBoundingClientRect().height / k / sc;
        const want = s.fit && natural > p.h ? Math.max(MIN_FIT, Math.floor((p.h / natural) * 1000) / 1000) : 1;
        if (Math.abs(want - sc) > 0.0005) { setScale(want); return; }               // re-runs once the new scale is applied
        const h = natural * sc;
        // everything fits on one sheet: no breaks, and no footer reserve — a one-page résumé carries no page number
        if (!s.paginate || h <= p.h + 0.5) { setContentPt(h); setPages(1); page.style.minHeight = (p.h / sc).toFixed(2) + "pt"; return; }
        const stride = p.h + GAP_PT, usable = p.h - padTop - FOOTER_PT;
        const blocks = Array.from(page.querySelectorAll<HTMLElement>("[data-cv-block]")).filter((b) => b.parentElement === page);
        let lastBottom = padTop;
        for (let i = 0; i < blocks.length; i++) {
            let end = i; while (blocks[end].hasAttribute("data-cv-keep-next") && end + 1 < blocks.length) end++;
            const top = at(blocks[i], "top"), bottom = at(blocks[end], "bottom"), pi = Math.floor(top / stride);
            const limit = pi * stride + p.h - FOOTER_PT;
            if (bottom > limit + 0.25 && bottom - top <= usable && top > pi * stride + padTop + 0.5) {
                const spacer = document.createElement("div"); spacer.className = "cvm-spacer"; spacer.contentEditable = "false";
                spacer.style.height = (((pi + 1) * stride + padTop - top) / sc).toFixed(2) + "pt";
                page.insertBefore(spacer, blocks[i]);
            }
            lastBottom = at(blocks[end], "bottom"); i = end;
        }
        const n = Math.max(1, Math.floor((lastBottom - 0.5) / stride) + 1);
        page.style.minHeight = ((n * p.h + (n - 1) * GAP_PT) / sc).toFixed(2) + "pt";
        setPages(n); setContentPt(lastBottom);
    }, []);
    // a timer, not rAF: rAF never fires while the tab is hidden, which would leave the page count stale
    const schedule = useCallback(() => { window.clearTimeout(rafRef.current); rafRef.current = window.setTimeout(paginate, 30); }, [paginate]);
    // run pagination to a fixed point before an export — fit-to-one-page needs a pass to set the scale and another to
    // paginate at it, so a render/export right after an edit could otherwise bake in scale 1 + 2 pages before it settles
    const settleLayout = useCallback(async () => {
        for (let i = 0; i < 10; i++) {
            const p0 = stateRef.current.pages, s0 = stateRef.current.scale;
            paginate();
            await new Promise((r) => window.setTimeout(r, 50));   // let setScale/setPages apply and the sheet re-lay-out
            if (stateRef.current.pages === p0 && Math.abs(stateRef.current.scale - s0) < 0.001) return;
        }
    }, [paginate]);

    /* ---- local autosave ---- */
    const touch = useCallback(() => {
        setDirty(true); schedule(); if (kwCount.current) setKwRev((r) => r + 1);
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            const { name: n, settings: s, source: src, tab: t } = stateRef.current; if (!src) return;
            const doc: SavedDoc = { name: n, css: src.css, html: serialize(), settings: s, savedAt: new Date().toISOString(), unsaved: true };
            try { localStorage.setItem(keyOf(t), JSON.stringify(doc)); } catch { /* ignore */ }
        }, 600);
    }, [schedule, serialize]);
    // live: recolour whatever SVG icon is on the target image (works for one placed this session or earlier)
    const recolorIcon = useCallback((css: string) => {
        setIconColor(css);
        const img = iconFor;
        if (img && /^data:image\/svg\+xml;base64,/i.test(img.src)) {
            try {
                const svg = decodeURIComponent(escape(atob(img.src.split(",")[1]))).replace(/stroke="[^"]*"/, `stroke="${css}"`);
                img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
                touch();
            } catch { /* ignore */ }
        }
    }, [iconFor, touch]);

    /* ---- boot: what this browser last had, else the source file (nothing is stored server-side) ---- */
    useEffect(() => {
        let dead = false;
        (async () => {
            let local: SavedDoc | null = null; try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { /* ignore */ }
            const startPaper = stored(START_SIZE_KEY), paperPatch = startPaper in PAPERS ? { paper: startPaper as PaperId } : {};
            // with real files, the file on disk is the document — unless this browser still holds edits that never reached it
            const onDisk = files && !(local?.html && local.unsaved) ? await files.current().catch(() => null) : null;
            if (dead) return;
            if (onDisk) {
                const parsed = parseSource(onDisk.text);
                setName(parsed.name || onDisk.name); setFileName(onDisk.name.replace(/\.html?$/i, "")); setSettings({ ...DEFAULT_SETTINGS, ...(local?.settings || {}), ...paperPatch, zoom: readViewZoom() }); setSource({ css: parsed.css, html: parsed.html }); return;
            }
            if (files && local?.html && local.unsaved) { setDirty(true); say("Restored edits that were never saved to a file"); }
            if (local?.html) { setName(local.name || "Résumé"); setSettings({ ...DEFAULT_SETTINGS, ...(local.settings || {}), ...paperPatch, zoom: readViewZoom() }); setSource({ css: migrateCss(local.css), html: local.html }); return; }   // autosave skips parseSource, so migrate here too
            setSettings((st) => ({ ...st, ...paperPatch, zoom: readViewZoom() }));
            const parsed = parseSource(await fetchSource(templateUrl));
            if (dead) return;
            setName(parsed.name || "Résumé"); setSource({ css: parsed.css, html: parsed.html });
        })().catch(() => say("Could not load the source file"));
        return () => { dead = true; };
    }, [say, templateUrl, files]);

    /* ---- mount the document: one editor per [data-cv-edit], ON the template's element ---- */
    useEffect(() => {
        const host = hostRef.current; if (!host || !source) return;
        host.innerHTML = source.html;
        const extensions = [
            StarterKit.configure({ heading: false, codeBlock: false, code: false, blockquote: false, trailingNode: false, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } } }),
            TextStyle, Color, FontSize, FontWeight, LetterSpacing, BlockLineHeight, ColumnBreak, TextAlign.configure({ types: ["paragraph"] }),
        ];
        const editors = Array.from(host.querySelectorAll<HTMLElement>("[data-cv-edit]")).map((el) => {
            const content = el.innerHTML; el.innerHTML = "";
            return new Editor({
                element: { mount: el } as unknown as Element, extensions, content, injectCSS: false,
                editorProps: { attributes: { spellcheck: String(stateRef.current.settings.spellcheck) } },
                onFocus: ({ editor }) => { setActive(editor as Editor); setPicked(null); setLinkOpen(false); },
                onTransaction: () => setTick((t) => t + 1),
                onUpdate: () => touch(),
            });
        });
        editorsRef.current = editors;
        const mounted = host.querySelector<HTMLElement>(".cv-page"); if (mounted) normalizeGaps(mounted, PAPERS[stateRef.current.settings.paper].w);
        setActive(null); setPicked(null); schedule();
        // an object that was just moved / pasted / duplicated stays selected (its element is new: the page was re-mounted)
        if (pickAfter.current != null) { const el = host.querySelectorAll<HTMLElement>(UNIT)[pickAfter.current]; pickAfter.current = null; if (el) window.setTimeout(() => setPicked(el), 0); }
        // a block that was just inserted gets the caret, with its placeholder selected — type to replace it
        if (focusBlock.current != null) {
            const page = host.querySelector(".cv-page"), block = page ? topBlocks(page)[focusBlock.current] : null; focusBlock.current = null;
            const first = block && editors.find((e) => block.contains(e.view.dom));
            if (first) window.setTimeout(() => { if (!first.isDestroyed) { first.commands.focus(); first.commands.selectAll(); block!.scrollIntoView({ block: "nearest", behavior: "smooth" }); } }, 40);
        }
        document.fonts?.ready.then(schedule);
        return () => { editors.forEach((e) => e.destroy()); editorsRef.current = []; };
    }, [source, schedule, touch]);

    useEffect(() => { schedule(); }, [settings.paper, settings.paginate, settings.fit, scale, schedule]);
    useEffect(() => { editorsRef.current.forEach((e) => e.view.dom.setAttribute("spellcheck", String(settings.spellcheck))); }, [settings.spellcheck, source]);
    useLayoutEffect(() => {
        // both fits are recomputed on every resize, so a fitted sheet scales with the window in real time
        const wrap = wrapRef.current; if (!wrap) return;
        const fit = () => {
            const p = PAPERS[settings.paper], clamp = (v: number) => Math.max(0.25, Math.min(3, Math.floor(v * 200) / 200));
            const byW = (wrap.clientWidth - 56 - 32) / (p.w * PT), byH = (wrap.clientHeight - 80 - 44) / (p.h * PT);   // canvas padding: 28px sides, 80 top, 44 bottom
            setFits((f) => { const n = { width: clamp(byW), height: clamp(byH) }; return n.width === f.width && n.height === f.height ? f : n; });
        };
        fit();
        const ro = new ResizeObserver(fit); ro.observe(wrap); window.addEventListener("resize", fit);
        return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
    }, [settings.paper, look.ready]);
    const patch = useCallback((p: Partial<Settings>) => { setSettings((s) => ({ ...s, ...p })); setDirty(true); }, []);
    // remember the size the person is viewing at, so every document reopens at it (null = fit to width)
    useEffect(() => { store(VIEW_ZOOM_KEY, settings.zoom == null || settings.zoom === "browser" ? "" : String(settings.zoom)); }, [settings.zoom]);

    const zoomBy = useCallback((dir: 1 | -1 | 0) => {
        if (dir === 0) { patch({ zoom: "width" }); return say("Fit width"); }
        const next = stepZoom(zoomRef.current, dir); patch({ zoom: next }); say(`${Math.round(next * 100)}%`);
    }, [patch, say]);

    /* ---- save (⌘S) ---- */
    const save = useCallback(async (as = false) => {
        const { name: n, settings: s, source: src, tab: t } = stateRef.current; if (!src) return;
        const doc = { name: n, css: src.css, html: serialize(), settings: s };
        if (files) {
            // a real file: the Source HTML goes to disk; this browser keeps a copy only as a safety net
            try {
                const file = await files.save(fullHtml(n, src.css, doc.html), { as, suggested: slugify(stateRef.current.fileName || n) + ".html", kind: t });
                if (!file) return;
                clearTimeout(saveTimer.current);
                try { localStorage.setItem(keyOf(t), JSON.stringify({ ...doc, savedAt: new Date().toISOString(), unsaved: false })); } catch { /* ignore */ }
                setFileName(file.replace(/\.html?$/i, ""));   // the saved file is now this document's identity
                void files.recent?.(t).then(setRecents).catch(() => {});
                setDirty(false); say(`Saved — ${file}`);
            } catch (e) { say(e instanceof Error ? e.message : "Could not save the file"); }
            return;
        }
        try { localStorage.setItem(keyOf(t), JSON.stringify({ ...doc, savedAt: new Date().toISOString() })); setDirty(false); say("Saved in this browser · Export → Source HTML for a portable copy"); }
        catch { say("Could not save in this browser — export the Source HTML instead"); }
    }, [serialize, say, files]);
    useEffect(() => { files?.setDirty(dirty, tab); }, [files, dirty, tab]);
    useEffect(() => { files?.setActive?.(tab); }, [files, tab]);
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(!!files && e.shiftKey); }
            if (e.key === "Escape") { setMenu(null); setImgPop(null); setLinkOpen(false); }
            // ⌘+ / ⌘− / ⌘0 zoom the SHEET (the % in the toolbar), not the whole interface the way a browser's zoom would
            if ((e.metaKey || e.ctrlKey) && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) { e.preventDefault(); zoomBy(e.key === "0" ? 0 : e.key === "-" || e.key === "_" ? -1 : 1); }
        };
        window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
    }, [save, files, zoomBy]);
    // a desktop shell's View menu asks for the same thing (its accelerators never reach the page as key presses)
    useEffect(() => {
        const on = { "cvm:zoom-in": () => zoomBy(1), "cvm:zoom-out": () => zoomBy(-1), "cvm:zoom-fit": () => zoomBy(0) } as const;
        (Object.keys(on) as (keyof typeof on)[]).forEach((n) => window.addEventListener(n, on[n]));
        return () => (Object.keys(on) as (keyof typeof on)[]).forEach((n) => window.removeEventListener(n, on[n]));
    }, [zoomBy]);
    // "saveAll" is the shell's close guard: the document on the sheet saves as usual, the one waiting in its slot straight from the slot
    const saveAllRef = useRef<() => Promise<void>>(async () => {});
    useEffect(() => files?.onCommand((command) => (command === "saveAll" ? void saveAllRef.current() : void save(command === "saveAs"))), [files, save]);

    /* ---- export ---- */
    const exportHtml = useCallback(() => {
        const { settings: s, source: src, name: n, scale: sc } = stateRef.current, p = PAPERS[s.paper];
        let body = serialize({ breaks: s.paginate }), heightPt: number = p.h;
        const pages = stateRef.current.pages, contentPt = stateRef.current.contentPt, paged = s.paginate && pages > 1;
        if (s.paginate) {
            const nos = !paged ? "" : Array.from({ length: pages }, (_, i) => `<div class="cvm-pageno" style="top: ${(i + 1) * p.h - 19}pt; zoom: ${(1 / sc).toFixed(4)}">${i + 1}</div>`).join("");
            body = body.replace(/<\/div>\s*$/, nos + "</div>");
        } else heightPt = Math.max(p.h, Math.ceil(contentPt) + 1);
        const css = `@page { size: ${p.w}pt ${heightPt}pt; margin: 0; }\nhtml, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n${pageBoxCss(p.w, sc)}\n${paged ? `.cv-page { min-height: ${((pages * p.h - 1) / sc).toFixed(2)}pt; }` : ""}`;
        // printToPDF ignores CSS zoom, so fit-to-one-page is lost in the PDF. Report the scale and let the renderer apply
        // it via printToPDF's own `scale` (single page only; multi-page keeps its manual layout). Print measures a touch
        // taller than the screen, so when the content nearly fills the page, shrink a hair more to keep it on one sheet.
        const fit = s.paginate && pages === 1 ? Math.min(sc, (heightPt - 6) * sc / Math.max(1, contentPt)) : 1;
        return { html: fullHtml(n, src?.css || "", body, css), widthPt: p.w, heightPt, fit };
    }, [serialize]);

    const printFallback = useCallback((html: string) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
        frame.srcdoc = html; frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60000); };
        document.body.appendChild(frame);
    }, []);

    // one document → one file, named after it (a letter that doesn't say so gets "-cover-letter", so the pair never collide)
    const exportActive = useCallback(async (kind: "pdf" | "png" | "docx" | "html") => {
        await settleLayout();
        const st = stateRef.current, base = slugify(st.fileName || st.name), file = st.tab === "letter" && !/cover|letter/.test(base) ? base + "-cover-letter" : base;
        // in a desktop shell the file isn't "exported" until its Save panel is done — and that panel can be slow to appear
        const dl = (blob: Blob, filename: string) => { if (files?.onDownload) shellSaving.current++; download(blob, filename); };
        if (kind === "html") return dl(new Blob([fullHtml(st.name, st.source?.css || "", serialize())], { type: "text/html" }), file + ".html");
        if (kind === "docx") {
            const { exportDocx } = await import("./export-docx");
            const page = hostRef.current!.querySelector<HTMLElement>(".cv-page")!, p = PAPERS[st.settings.paper];
            return dl(await exportDocx(page, { pageWPt: p.w, pageHPt: p.h, paginate: st.settings.paginate, name: st.name }), file + ".docx");
        }
        const payload = exportHtml();
        // headless Chrome when there's an export server; otherwise (none configured, unreachable, or it declines)
        // the browser does it itself: print dialog for PDF (still real text + links), html-to-image for PNG
        let r: Response | null = null;
        if (exportUrl) { try { r = await fetch(exportUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, format: kind, scale: 2 }) }); } catch { r = null; } }
        if (r?.ok) return dl(await r.blob(), `${file}.${kind}`);
        if (r && ![404, 405, 501].includes(r.status)) throw new Error((await r.json().catch(() => ({}))).error || "Export failed");
        if (kind === "pdf") { say("Choose “Save as PDF” in the print dialog"); return printFallback(payload.html); }
        dl(await rasterize(payload.html, payload.widthPt, payload.heightPt, rasterizerUrl), `${file}.png`);
    }, [exportHtml, exportUrl, settleLayout, printFallback, rasterizerUrl, say, serialize, files]);

    // Export → a format → Résumé / Cover Letter / All. A document is rendered from the live sheet, so exporting the one
    // that isn't showing means showing it for a moment; the person ends up back on the tab they were on.
    const switchTabRef = useRef<(to: DocKind) => Promise<void>>(async () => {});
    const runExport = useCallback(async (kind: "pdf" | "png" | "docx" | "html", which: DocKind | "all" = stateRef.current.tab) => {
        setMenu(null); setExportKind(null);
        const home = stateRef.current.tab, began = Date.now();
        const order: DocKind[] = which === "all" ? [home, home === "resume" ? "letter" : "resume"] : [which];
        exporting.current = true;
        try {
            setBusy(kind.toUpperCase());
            for (const [i, t] of order.entries()) {
                if (stateRef.current.tab !== t) { await switchTabRef.current(t); await new Promise((r) => window.setTimeout(r, 900)); }   // mount + paginate
                if (i) await new Promise((r) => window.setTimeout(r, 350));   // browsers drop a second download fired in the same breath
                await exportActive(kind);
            }
        } catch (e) { say(e instanceof Error ? e.message : "Export failed"); }
        finally {
            exporting.current = false;   // release the guard BEFORE the (async) switch back, so a Save/Cancel that lands now can stop the scan
            if (stateRef.current.tab !== home) await switchTabRef.current(home);
            // the scan stays up at least one sweep — and, in a shell, until its Save panel is done (files:download) or a short cap
            if (shellSaving.current > 0) { window.clearTimeout(shellSavingTimer.current); shellSavingTimer.current = window.setTimeout(() => { shellSaving.current = 0; setBusy(""); }, 15000); }
            else window.setTimeout(() => setBusy(""), Math.max(0, 900 - (Date.now() - began)));
        }
    }, [exportActive, say]);
    const stopShellScan = useCallback(() => { if (shellSaving.current <= 0 || exporting.current) return; shellSaving.current = 0; window.clearTimeout(shellSavingTimer.current); setBusy(""); }, []);
    // the shell reports every download's end — completed OR cancelled — so a cancelled Save panel stops the scan at once
    useEffect(() => files?.onDownload?.((state) => {
        if (shellSaving.current <= 0) return;
        if (state === "cancelled" || state === "interrupted") { shellSaving.current = 0; if (!exporting.current) { window.clearTimeout(shellSavingTimer.current); setBusy(""); } return; }
        if (--shellSaving.current > 0 || exporting.current) return;
        window.clearTimeout(shellSavingTimer.current); setBusy("");
    }), [files]);
    // backstop: when the window regains focus after a Save/print panel closes, drop any lingering scan
    useEffect(() => {
        if (!files?.onDownload) return;
        window.addEventListener("focus", stopShellScan);
        return () => window.removeEventListener("focus", stopShellScan);
    }, [files, stopShellScan]);

    /* ---- two documents, one sheet: the résumé and its cover letter ---- */
    const letterUrl = letterTemplateUrl || templateUrl.replace(/[^/]*$/, "sample-cover-letter.html");
    // what is on the sheet right now, as a slot (so the other document can take the sheet)
    const stash = useCallback(() => {
        const st = stateRef.current; if (!st.source) return;
        slots.current[st.tab] = { source: { css: st.source.css, html: serialize() }, name: st.name, fileName: st.fileName, dirty: st.dirty, undo: remoteUndo.current };
    }, [serialize]);
    // put a slot on the sheet. A letter takes its header (and the styles that draw it) from the résumé, every time.
    const show = useCallback((kind: DocKind, slot: Slot) => {
        const resume = slots.current.resume;
        const source = kind === "letter" && resume ? { css: letterCss(resume.source.css, slot.source.css), html: mirrorHeader(slot.source.html, resume.source.html) } : slot.source;
        slots.current[kind] = { ...slot, source };
        hist.current = [];   // structural undo belongs to the document that was on the sheet
        remoteUndo.current = slot.undo; setAiReply(null); setActive(null); setPicked(null); setImgPop(null); setOmniOpen(false); setOmniQuery("");
        setTab(kind); setName(slot.name); setFileName(slot.fileName); setSource(source); setDirty(slot.dirty);
    }, []);
    // a document that hasn't been on the sheet yet: unsaved edits this browser holds → the file on disk → this browser's copy → the template
    const loadSlot = useCallback(async (kind: DocKind): Promise<Slot> => {
        let local: SavedDoc | null = null; try { local = JSON.parse(localStorage.getItem(keyOf(kind)) || "null"); } catch { /* ignore */ }
        const fresh = (src: Source, n: string, f = "", d = false): Slot => ({ source: src, name: n, fileName: f, dirty: d, undo: [] });
        const onDisk = files && !(local?.html && local.unsaved) ? await files.current(kind).catch(() => null) : null;
        if (onDisk) { const parsed = parseSource(onDisk.text); return fresh({ css: parsed.css, html: parsed.html }, parsed.name || onDisk.name, onDisk.name.replace(/\.html?$/i, "")); }
        if (local?.html) return fresh({ css: migrateCss(local.css), html: local.html }, local.name || KIND_LABEL[kind], "", !!(files && local.unsaved));
        const parsed = parseSource(await (await fetch(kind === "letter" ? letterUrl : templateUrl, { cache: "no-store" })).text());
        return fresh({ css: parsed.css, html: parsed.html }, parsed.name || KIND_LABEL[kind]);
    }, [files, letterUrl, templateUrl]);
    const switchTab = useCallback(async (to: DocKind) => {
        if (to === stateRef.current.tab || !stateRef.current.source) return;
        stash();
        try { show(to, slots.current[to] || await loadSlot(to)); }
        catch { say(`Could not load the ${KIND_LABEL[to].toLowerCase()}`); }
    }, [stash, show, loadSlot, say]);
    switchTabRef.current = switchTab;
    saveAllRef.current = async () => {
        if (stateRef.current.dirty) await save();
        const other: DocKind = stateRef.current.tab === "resume" ? "letter" : "resume", slot = slots.current[other];
        if (!files || !slot?.dirty) return;
        try {
            const file = await files.save(fullHtml(slot.name, slot.source.css, slot.source.html), { suggested: slugify(slot.fileName || slot.name) + ".html", kind: other });
            if (!file) return;
            slots.current[other] = { ...slot, dirty: false, fileName: file.replace(/\.html?$/i, "") }; files.setDirty(false, other);
            try { localStorage.setItem(keyOf(other), JSON.stringify({ name: slot.name, css: slot.source.css, html: slot.source.html, settings: stateRef.current.settings, savedAt: new Date().toISOString(), unsaved: false })); } catch { /* ignore */ }
        } catch (e) { say(e instanceof Error ? e.message : "Could not save the file"); }
    };

    // what a model is told about the document also says which regions flow in columns (read off the live page; ids are in document order on both sides)
    const withColumns = useCallback(<T extends { blocks: { regions: { id: string; columns?: number }[] }[]; other: { id: string; columns?: number }[] }>(doc: T): T => {
        const live = Array.from(hostRef.current?.querySelectorAll<HTMLElement>(".cv-page [data-cv-edit]") || []);
        const mark = (r: { id: string; columns?: number }) => { const el = live[Number(r.id.slice(1))], n = el ? parseInt(getComputedStyle(el).columnCount, 10) : NaN; if (n > 1) r.columns = n; };
        doc.blocks.forEach((b) => b.regions.forEach(mark)); doc.other.forEach(mark);
        return doc;
    }, []);

    /* ---- ATS keywords: which of the ad's words each document already uses, and where ---- */
    // both documents' words: the one on the sheet as it is being typed, the other from its slot. A letter's header is the résumé's words.
    const kwTexts = useCallback(() => {
        const st = stateRef.current, other: DocKind = st.tab === "resume" ? "letter" : "resume", slot = slots.current[other];
        const live = st.source ? pageText(serialize(), { skipMirror: st.tab === "letter" }) : "", waiting = slot ? pageText(slot.source.html, { skipMirror: other === "letter" }) : "";
        return st.tab === "resume" ? { resume: live, letter: waiting } : { resume: waiting, letter: live };
    }, [serialize]);
    const kwCoverage = useCallback((list: string[]) => { const t = kwTexts(); return coverage(list, t.resume, t.letter); }, [kwTexts]);
    const applyKeywords = useCallback((list: unknown, job?: string) => {
        const next = { job: typeof job === "string" ? job.trim().slice(0, 120) : stateRef.current.kwJob, keywords: normalizeKeywords(list) };
        setKw(next); store(KW_KEY, next.keywords.length || next.job ? JSON.stringify(next) : ""); setKwActive(null);
        return next;
    }, []);
    // recount a beat after typing stops (and whenever the sheet changes hands)
    useEffect(() => {
        if (!kw.keywords.length) { setKwUses([]); return; }
        const t = window.setTimeout(() => setKwUses(kwCoverage(kw.keywords)), 250);
        return () => window.clearTimeout(t);
    }, [kw.keywords, kwRev, source, tab, kwCoverage]);
    // click a keyword → every place the document on the sheet uses it lights up. Drawn with the CSS Custom Highlight API:
    // ranges only, so the markup the editors own is never touched.
    useEffect(() => {
        type HL = { highlights?: { set(name: string, h: unknown): void; delete(name: string): void } };
        const reg = (CSS as unknown as HL).highlights, Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
        const page = hostRef.current?.querySelector(".cv-page");
        if (!reg || !Ctor) return;
        if (!kwActive || !page) { reg.delete("cvm-kw"); return; }
        const t = window.setTimeout(() => {
            const ranges = findRanges(page, kwActive, { skipMirror: stateRef.current.tab === "letter" });
            if (ranges.length) reg.set("cvm-kw", new Ctor(...ranges)); else reg.delete("cvm-kw");
        }, 60);
        return () => { window.clearTimeout(t); reg.delete("cvm-kw"); };
    }, [kwActive, kwRev, source, tab]);
    const pickKeyword = useCallback((term: string) => {
        setKwActive((cur) => (cur === term ? null : term));
        const page = hostRef.current?.querySelector(".cv-page"); if (!page) return;
        const first = findRanges(page, term, { skipMirror: stateRef.current.tab === "letter" })[0];
        (first?.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, []);
    useEffect(() => {
        const el = kwRef.current; if (!el || !kwOpen || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => { const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight); setKwSize((cur) => (cur && cur.w === w && cur.h === h ? cur : (store(KW_SIZE_KEY, JSON.stringify({ w, h })), { w, h }))); });
        ro.observe(el); return () => ro.disconnect();
    }, [kwOpen]);
    const dragKw = (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(), dx = e.clientX - box.left, dy = e.clientY - box.top;
        const move = (ev: PointerEvent) => setKwPos({ x: Math.max(8, Math.min(window.innerWidth - 120, ev.clientX - dx)), y: Math.max(8, Math.min(window.innerHeight - 60, ev.clientY - dy)) });
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setKwPos((pos) => { if (pos) store(KW_POS_KEY, JSON.stringify(pos)); return pos; }); };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); e.preventDefault();
    };

    /* ---- source file: load / reset ---- */
    const loadSourceText = useCallback((text: string, fallbackName: string, opened?: { note?: string }) => {
        const parsed = parseSource(text), kind = docKind(parsed.html);
        // a cover letter opened from the résumé tab (or the other way round) goes to ITS tab, and the sheet follows
        if (kind !== stateRef.current.tab) stash();
        // a real file gives the document its identity; a reset/import leaves it to the printed name
        show(kind, { source: { css: parsed.css, html: parsed.html }, name: parsed.name || fallbackName, fileName: opened ? fallbackName : "", dirty: !opened, undo: [] });
        if (opened) {   // it IS the file on disk: nothing unsaved, and the safety-net copy must not outvote it on the next start
            clearTimeout(saveTimer.current);
            try { localStorage.setItem(keyOf(kind), JSON.stringify({ name: parsed.name || fallbackName, css: parsed.css, html: parsed.html, settings: stateRef.current.settings, savedAt: new Date().toISOString(), unsaved: false })); } catch { /* ignore */ }
        }
        if (opened?.note) return say(opened.note);
        say(parsed.regions ? `Loaded — ${parsed.regions} editable regions` : "Loaded, but it has no [data-cv-edit] regions — nothing is editable");
    }, [say, stash, show]);
    useEffect(() => files?.onOpen((doc) => loadSourceText(doc.text, doc.name.replace(/\.html?$/i, ""), { note: doc.note })), [files, loadSourceText]);
    const resetSource = useCallback(() => setConfirm({
        msg: "Replace the document with the original source file? Your edits to this document will be lost.", ok: "Replace",
        run: async () => (stateRef.current.tab === "letter" ? loadSourceText(await (await fetch(letterUrl, { cache: "no-store" })).text(), KIND_LABEL.letter) : loadSourceText(await fetchSource(templateUrl), KIND_LABEL.resume)),
    }), [loadSourceText, templateUrl, letterUrl]);

    /* ---- omni bar: a recent-documents typeahead (desktop shells only) ---- */
    // keep the list fresh: load once, then follow the shell (an open, a save, a pin all re-emit it)
    useEffect(() => {
        if (!files?.recent) return;
        let dead = false;
        const refresh = () => void files.recent!(tab).then((l) => { if (!dead) setRecents(l); }).catch(() => {});
        refresh();
        const off = files.onRecent?.(refresh);   // each tab has its own list; whatever changed, ask again for this one
        return () => { dead = true; off?.(); };
    }, [files, tab]);
    // click away closes the dropdown
    useEffect(() => {
        if (!omniOpen) return;
        const away = (e: PointerEvent) => { if (!omniRef.current?.contains(e.target as Node)) setOmniOpen(false); };
        window.addEventListener("pointerdown", away);
        return () => window.removeEventListener("pointerdown", away);
    }, [omniOpen]);
    const omniList = useMemo(() => {
        const q = omniQuery.trim().toLowerCase();
        return (q ? recents.filter((r) => r.name.toLowerCase().includes(q)) : recents).slice(0, 10);
    }, [recents, omniQuery]);
    const chooseRecent = useCallback((path: string) => { setOmniOpen(false); setOmniQuery(""); files?.openPath?.(path); }, [files]);
    const togglePin = useCallback((r: RecentDoc) => { files?.pin?.(r.path, !r.pinned); void files?.recent?.(stateRef.current.tab).then(setRecents).catch(() => {}); }, [files]);
    // type a name no document has and the list offers to save this one under it — that is how a document is renamed / branched
    const omniNewName = useMemo(() => {
        const q = omniQuery.trim(); if (!q || !files?.saveAs) return "";
        const taken = (n: string) => n.toLowerCase() === q.toLowerCase();
        return taken(fileName) || recents.some((r) => taken(r.name)) ? "" : q;
    }, [omniQuery, files, fileName, recents]);
    const saveAsName = useCallback(async (raw: string) => {
        const wanted = raw.trim(), { name: n, source: src } = stateRef.current;
        if (!wanted || !src || !files?.saveAs) return;
        setOmniOpen(false); setOmniQuery("");
        try { remoteRef.current?.markSaved(await files.saveAs(fullHtml(n, src.css, serialize()), wanted, stateRef.current.tab)); }
        catch (e) { say(e instanceof Error ? e.message : "Could not save the file"); }
    }, [files, serialize, say]);
    const omniRows = omniList.length + (omniNewName ? 1 : 0);
    const omniKey = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setOmniIdx((i) => Math.min(i + 1, omniRows - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setOmniIdx((i) => Math.max(i - 1, 0)); }
        else if (e.key === "Enter") {
            e.preventDefault(); (e.target as HTMLInputElement).blur();
            const r = omniList[omniIdx];
            if (r) chooseRecent(r.path); else if (omniNewName) void saveAsName(omniNewName); else if (omniList[0]) chooseRecent(omniList[0].path);
        }
        else if (e.key === "Escape") { setOmniOpen(false); (e.target as HTMLInputElement).blur(); }
    };

    /* ---- brand menu (the IcedCoffee mark, far left): quick shell actions ---- */
    const BRAND_HOME = "https://qmanning.com/labs/icedcoffee";
    const [appVersion, setAppVersion] = useState("");
    // the hosted web build has no shell — the AI, real files and updates live only in the desktop app; offer it here instead of hiding it
    const isWebBuild = !files && !assistant && !remote;
    const [getApp, setGetApp] = useState(false);
    const [ctaHidden, setCtaHidden] = useState(() => stored("cvm:cta") === "hidden");
    useEffect(() => { let dead = false; void files?.version?.().then((v) => { if (!dead) setAppVersion(v); }).catch(() => {}); return () => { dead = true; }; }, [files]);
    const visitHomepage = () => { setMenu(null); if (files?.openExternal) files.openExternal(BRAND_HOME); else window.open(BRAND_HOME, "_blank", "noopener"); };
    const checkUpdates = () => { setMenu(null); files?.checkUpdates?.(); };

    /* ---- ask your AI (desktop shells only): words in → operations out → applied as ONE undoable step ---- */
    const [ask, setAsk] = useState(""), [askFocus, setAskFocus] = useState(false);
    const [aiBusy, setAiBusy] = useState(""), [aiStatus, setAiStatus] = useState<{ ready: boolean; label: string } | null>(null);
    const [aiReply, setAiReply] = useState<{ message: string; undo: Source | null; note: string } | null>(null);
    const askRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (!assistant) return;
        assistant.status().then(setAiStatus).catch(() => setAiStatus({ ready: false, label: "" }));
        return assistant.onStatus(setAiStatus);
    }, [assistant]);
    useEffect(() => {
        if (!assistant) return;
        const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); askRef.current?.focus(); } };
        window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
    }, [assistant]);
    const runAssistant = useCallback(async (words: string) => {
        const prompt = words.trim(); if (!assistant || !prompt || aiBusy) return;
        if (!aiStatus?.ready) return assistant.configure();
        const first = stateRef.current.source; if (!first) return;
        const undo: Source = { css: first.css, html: serialize() }, pagesBefore = stateRef.current.pages;
        setAiReply(null); setAsk("");
        try {
            let request = prompt, message = "", applied = 0; const skipped: string[] = [];
            // up to two automatic follow-ups when an edit spills onto another page: the editor can SEE the layout, the model can't
            for (let round = 0; round < 3; round++) {
                setAiBusy(round ? "Tightening to fit the page…" : "Thinking…");
                const { settings: st, name: n, scale: sc, pages: pg, source: src } = stateRef.current; if (!src) break;
                const html = round ? serialize() : undo.html;
                const res = await assistant.run({ prompt: request, document: withColumns(describeDocument(html, { name: n, paper: PAPERS[st.paper].name, pages: st.paginate ? pg : 1, fitScale: Math.round(sc * 100) / 100 })), keywords: stateRef.current.keywords });
                if (!round) message = res.message;
                if (!round && Array.isArray(res.keywords) && res.keywords.length) { applyKeywords(res.keywords, res.job); setKwOpen(true); }
                if (!res.ops?.length) break;
                const out = applyOps(html, res.ops); applied += out.applied; skipped.push(...out.skipped);
                if (!out.applied) break;
                setSource({ css: src.css, html: out.html }); setDirty(true);
                await new Promise((r) => window.setTimeout(r, 700));   // remount + paginate
                const now = stateRef.current.pages;
                if (!stateRef.current.settings.paginate || now <= pagesBefore) break;
                request = `Your last edit made the résumé run to ${now} pages; it was ${pagesBefore}. Tighten the wording of what you just wrote — same facts, fewer words — so it fits ${pagesBefore} page${pagesBefore > 1 ? "s" : ""} again. Change nothing else.`;
            }
            const over = stateRef.current.settings.paginate && stateRef.current.pages > pagesBefore;
            setAiReply({ message: message || (applied ? "Done." : "Nothing to change."), undo: applied ? undo : null, note: [applied ? `${applied} change${applied > 1 ? "s" : ""}` : "", over ? `now ${stateRef.current.pages} pages` : "", skipped.length ? `${skipped.length} skipped` : ""].filter(Boolean).join(" · ") });
            if (applied) touch();
        } catch (e) { setAiReply({ message: e instanceof Error ? e.message : "Your AI could not be reached.", undo: null, note: "" }); setAsk(prompt); }
        finally { setAiBusy(""); }
    }, [assistant, aiBusy, aiStatus, serialize, touch, applyKeywords, withColumns]);
    // every entry is a whole copy of the document, and a résumé with a photo embedded as a data URI can be megabytes —
    // so the history is bounded by SIZE as well as by count (the newest step always survives)
    const trimUndo = (stack: Source[]) => { let bytes = stack.reduce((n, e) => n + e.html.length + e.css.length, 0); while (stack.length > 1 && (stack.length > 30 || bytes > 24_000_000)) { const gone = stack.shift()!; bytes -= gone.html.length + gone.css.length; } };
    const remoteUndo = useRef<Source[]>([]);   // edits made from outside (see the remote handlers below)
    const undoAssistant = useCallback(() => { if (aiReply?.undo) { setSource(aiReply.undo); setDirty(true); touch(); say("Undone"); remoteUndo.current.pop(); } setAiReply(null); }, [aiReply, say, touch]);

    /* ---- an outside AI app drives the editor (the shell's MCP server): same operations, same one-step undo, no key anywhere ---- */
    const remoteRef = useRef<CvRemoteHandlers | null>(null);
    const describeNow = useCallback(() => {
        const { settings: st, name: n, scale: sc, pages: pg } = stateRef.current;
        return { ...withColumns(describeDocument(serialize(), { name: n, paper: PAPERS[st.paper].name, pages: st.paginate ? pg : 1, fitScale: Math.round(sc * 100) / 100 })), document: stateRef.current.tab };
    }, [serialize, withColumns]);
    const settle = () => new Promise<void>((r) => window.setTimeout(r, 700));   // remount + paginate, so the caller learns what the change did
    const pageNow = (): RemotePage => {
        const { settings: st, pages: pg, scale: sc } = stateRef.current;
        return {
            paper: st.paper, paperLabel: `${PAPERS[st.paper].name} (${PAPERS[st.paper].label})`, papers: Object.keys(PAPERS), fit: st.fit, paginate: st.paginate,
            zoom: typeof st.zoom === "number" ? st.zoom : st.zoom === "height" || st.zoom === "browser" ? "height" : "width", zoomPercent: Math.round(zoomRef.current * 100),
            pages: st.paginate ? pg : 1, fitScale: Math.round(sc * 100) / 100,
        };
    };
    remoteRef.current = {
        showDocument: async (kind) => { if (kind && kind !== stateRef.current.tab) { await switchTabRef.current(kind); await settle(); } return stateRef.current.tab; },
        describe: describeNow,
        apply: async (ops, message, by) => {
            const src = stateRef.current.source; if (!src) throw new Error("No document is open.");
            const before: Source = { css: src.css, html: serialize() }, pagesBefore = stateRef.current.pages;
            const out = applyOps(before.html, ops);
            if (out.applied) {
                remoteUndo.current.push(before); trimUndo(remoteUndo.current);
                setSource({ css: src.css, html: out.html }); setDirty(true);
                await new Promise((r) => window.setTimeout(r, 700));   // remount + paginate, so the caller learns whether it still fits
                touch();
            }
            const pagesAfter = stateRef.current.pages;
            setAiReply({ message: message || (out.applied ? `${by} made a change.` : `${by} asked for a change the editor couldn't make.`), undo: out.applied ? before : null, note: [by, out.applied ? `${out.applied} change${out.applied > 1 ? "s" : ""}` : "", pagesAfter > pagesBefore ? `now ${pagesAfter} pages` : "", out.skipped.length ? `${out.skipped.length} skipped` : ""].filter(Boolean).join(" · ") });
            return { applied: out.applied, skipped: out.skipped, pagesBefore, pagesAfter, fitScale: Math.round(stateRef.current.scale * 100) / 100 };
        },
        undo: () => { const last = remoteUndo.current.pop(); if (!last) return false; setSource(last); setDirty(true); touch(); setAiReply(null); say("Undone"); return true; },
        exportPayload: async () => { await settleLayout(); return { ...exportHtml(), name: slugify(stateRef.current.fileName || stateRef.current.name) }; },
        exportFile: async (kind) => {
            const { name: n, fileName: f, source: src, settings: st } = stateRef.current, base = slugify(f || n);
            if (!src) throw new Error("No document is open.");
            if (kind === "html") return { name: base + ".html", data: fullHtml(n, src.css, serialize()), base64: false };
            paginate();
            const { exportDocx } = await import("./export-docx");
            const page = hostRef.current!.querySelector<HTMLElement>(".cv-page")!, p = PAPERS[st.paper];
            const bytes = new Uint8Array(await (await exportDocx(page, { pageWPt: p.w, pageHPt: p.h, paginate: st.paginate, name: n })).arrayBuffer());
            let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return { name: base + ".docx", data: btoa(bin), base64: true };
        },
        getPage: () => pageNow(),
        setPage: async (p) => {
            const next: Partial<Settings> = {};
            if (p.paper !== undefined) { if (!(p.paper in PAPERS)) throw new Error(`Unknown paper "${p.paper}". Use one of: ${Object.keys(PAPERS).join(", ")}.`); next.paper = p.paper as PaperId; }
            if (typeof p.fit === "boolean") next.fit = p.fit;
            if (typeof p.paginate === "boolean") next.paginate = p.paginate;
            if (p.zoom !== undefined) {
                if (p.zoom === "width" || p.zoom === "height") next.zoom = p.zoom;
                else if (typeof p.zoom === "number" && Number.isFinite(p.zoom)) next.zoom = Math.min(4, Math.max(0.25, p.zoom));
                else throw new Error('zoom is "width", "height", or a number such as 1.25 (= 125%).');
            }
            if (Object.keys(next).length) { patch(next); await settle(); }
            return pageNow();
        },
        listImages: () => Array.from(hostRef.current?.querySelectorAll<HTMLImageElement>(".cv-page img") || []).map((img, i) => {
            const src = img.getAttribute("src") || "", embedded = src.startsWith("data:");
            return { id: "i" + i, alt: img.alt || "", width: img.naturalWidth, height: img.naturalHeight, kilobytes: embedded ? Math.round((src.length * 0.75) / 1024) : 0, embedded };
        }),
        setImage: async (id, dataUri, alt, by) => {
            const src = stateRef.current.source; if (!src) throw new Error("No document is open.");
            if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(dataUri)) throw new Error("That isn't an image the editor can embed.");
            const before: Source = { css: src.css, html: serialize() }, pagesBefore = stateRef.current.pages;
            const doc = new DOMParser().parseFromString(before.html, "text/html");   // inert: nothing loads or runs while it is edited
            const img = /^i\d+$/.test(id) ? doc.querySelectorAll(".cv-page img")[Number(id.slice(1))] : null;
            if (!img) throw new Error(`There is no image ${id}. Call list_images for the ids.`);
            img.setAttribute("src", dataUri); if (alt !== null) img.setAttribute("alt", alt);
            remoteUndo.current.push(before); trimUndo(remoteUndo.current);
            setSource({ css: src.css, html: doc.body.innerHTML }); setDirty(true);
            await settle(); touch();
            setAiReply({ message: `${by} replaced an image.`, undo: before, note: by });
            return { replaced: true, pagesBefore, pagesAfter: stateRef.current.pages };
        },
        setKeywords: (list, job) => { const next = applyKeywords(list, job ?? undefined); setKwOpen(true); setKwRev((r) => r + 1); return { job: next.job, keywords: kwCoverage(next.keywords) }; },
        getKeywords: () => ({ job: stateRef.current.kwJob, keywords: kwCoverage(stateRef.current.keywords) }),
        sourceHtml: () => {
            const { name: n, fileName: f, source: src } = stateRef.current; if (!src) throw new Error("No document is open.");
            return { html: fullHtml(n, src.css, serialize()), suggested: slugify(f || n) };
        },
        markSaved: (file) => {
            const { name: n, settings: s, source: src } = stateRef.current;
            clearTimeout(saveTimer.current);
            if (src) { try { localStorage.setItem(keyOf(stateRef.current.tab), JSON.stringify({ name: n, css: src.css, html: serialize(), settings: s, savedAt: new Date().toISOString(), unsaved: false })); } catch { /* ignore */ } }
            setFileName(file.replace(/\.html?$/i, "")); setDirty(false); say(`Saved — ${file}`);
        },
    };
    // the pill under the page: it knows whether an outside AI app is connected, and it can be sent away for good —
    // connecting is never required, and the shell's AI menu is always there
    const [remoteStatus, setRemoteStatus] = useState<CvRemoteStatus | null>(null);
    const [pillHidden, setPillHidden] = useState(() => stored("cvm:ai-pill") === "hidden");
    useEffect(() => {
        if (!remote?.status) return;
        remote.status().then(setRemoteStatus).catch(() => setRemoteStatus(null));
        return remote.onStatus?.(setRemoteStatus);
    }, [remote]);
    const hidePill = useCallback(() => { setPillHidden(true); store("cvm:ai-pill", "hidden"); say("Hidden. It's still under the AI menu."); }, [say]);
    const openConnect = useCallback(() => (remote?.configure ?? assistant?.configure)?.(), [assistant, remote]);

    useEffect(() => remote?.serve({
        showDocument: (kind) => remoteRef.current!.showDocument(kind),
        describe: () => remoteRef.current!.describe(),
        apply: (ops, message, by) => remoteRef.current!.apply(ops, message, by),
        undo: () => remoteRef.current!.undo(),
        exportPayload: () => remoteRef.current!.exportPayload(),
        exportFile: (kind) => remoteRef.current!.exportFile(kind),
        getPage: () => remoteRef.current!.getPage(),
        setPage: (p) => remoteRef.current!.setPage(p),
        listImages: () => remoteRef.current!.listImages(),
        setImage: (id, dataUri, alt, by) => remoteRef.current!.setImage(id, dataUri, alt, by),
        setKeywords: (list, job) => remoteRef.current!.setKeywords(list, job),
        getKeywords: () => remoteRef.current!.getKeywords(),
        sourceHtml: () => remoteRef.current!.sourceHtml(),
        markSaved: (file) => remoteRef.current!.markSaved(file),
    }), [remote]);

    /* ---- rows: move / duplicate / delete whichever block holds the caret (a job, the summary, a dual list…) ---- */
    // a block with no text (a divider) is picked by clicking it; otherwise the row is wherever the caret is
    const [picked, setPicked] = useState<HTMLElement | null>(null);
    const activeBlock = active ? (active.view.dom.closest(UNIT) as HTMLElement | null) : picked;
    useEffect(() => { if (!activeBlock) return; activeBlock.classList.add("cvm-hot"); return () => activeBlock.classList.remove("cvm-hot"); }, [activeBlock]);
    // OBJECTS. Text is edited in place; a block is also an object you can select (Esc from its text, ⌥-click, or click its
    // margin), and then copy / cut / paste / duplicate / delete / move or drag — Infospector's blue box marks it. Every
    // structural change goes through restructure(): it works on a detached copy and leaves one undo step (⌘Z while an object is selected).
    const hist = useRef<Source[]>([]), clip = useRef(""), pickAfter = useRef<number | null>(null);
    const fixedUnit = (el: Element | null) => !!el?.hasAttribute("data-cv-mirror");   // a letter's header belongs to the résumé
    const restructure = useCallback((fn: (units: HTMLElement[], root: HTMLElement) => HTMLElement | null | void) => {
        const src = stateRef.current.source; if (!src) return;
        const before: Source = { css: src.css, html: serialize() };
        const root = document.createElement("div"); root.innerHTML = before.html;
        const keep = fn(Array.from(root.querySelectorAll<HTMLElement>(UNIT)), root);
        if (keep === null) return;
        hist.current.push(before); trimUndo(hist.current);
        pickAfter.current = keep ? Array.from(root.querySelectorAll(UNIT)).indexOf(keep) : null;
        setSource({ css: src.css, html: root.innerHTML }); setDirty(true);
    }, [serialize]);
    const unitIndex = (el: Element) => Array.from(hostRef.current?.querySelectorAll(UNIT) || []).indexOf(el);
    const pickObject = useCallback((el: HTMLElement | null) => { (document.activeElement as HTMLElement | null)?.blur?.(); window.getSelection()?.removeAllRanges(); setActive(null); setPicked(el); }, []);
    const blockOp = useCallback((op: "dup" | "up" | "down" | "del" | "copy" | "cut" | "paste") => {
        const idx = activeBlock ? unitIndex(activeBlock) : -1;
        if (op !== "paste" && (idx < 0 || fixedUnit(activeBlock))) return;
        if (op === "copy" || op === "cut") {
            const root = document.createElement("div"); root.innerHTML = serialize();
            const el = root.querySelectorAll<HTMLElement>(UNIT)[idx]; if (!el) return;
            clip.current = el.outerHTML; void navigator.clipboard?.writeText(el.innerText || el.textContent || "").catch(() => {});
            say(op === "copy" ? "Copied · ⌘V pastes it after the selected block" : "Cut");
            if (op === "copy") return;
        }
        if (op === "paste" && !clip.current) return;
        restructure((units, root) => {
            const el = units[idx], row = (n: Element | null) => (n instanceof HTMLElement && n.matches(UNIT) && !fixedUnit(n) ? n : null);
            if (op === "paste") {
                const box = document.createElement("div"); box.innerHTML = clip.current; const fresh = box.firstElementChild as HTMLElement | null; if (!fresh) return null;
                // after the selected object when it sits where this kind of object lives; otherwise at the end of the page
                const page = root.querySelector(".cv-page"); if (el) el.after(fresh); else if (page) page.append(fresh); else return null;
                return fresh;
            }
            if (!el) return null;
            if (op === "dup") { const copy = el.cloneNode(true) as HTMLElement; el.after(copy); return copy; }
            if (op === "del" || op === "cut") { const next = row(el.nextElementSibling) || row(el.previousElementSibling); el.remove(); return next || undefined; }
            if (op === "up") { const prev = row(el.previousElementSibling); if (!prev) return null; prev.before(el); return el; }
            if (op === "down") { const next = row(el.nextElementSibling); if (!next) return null; next.after(el); return el; }
        });
    }, [activeBlock, serialize, restructure, say]);
    const undoStructure = useCallback(() => { const last = hist.current.pop(); if (!last) return say("Nothing to undo"); setSource(last); setDirty(true); say("Undone"); }, [say]);

    // the selection box follows its object (scrolling, zoom, re-layout) for as long as one is selected
    const [selRect, setSelRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    useEffect(() => {
        if (!picked || active) { setSelRect(null); return; }
        let raf = 0, last = "";
        const tick = () => {
            if (!picked.isConnected) { setPicked(null); return; }
            const r = picked.getBoundingClientRect(), key = [r.left, r.top, r.width, r.height].map((n) => n.toFixed(1)).join();
            if (key !== last) { last = key; setSelRect({ left: r.left, top: r.top, width: r.width, height: r.height }); }
            raf = requestAnimationFrame(tick);
        };
        tick(); return () => cancelAnimationFrame(raf);
    }, [picked, active]);

    // keys: Esc lifts you from a block's text to the block; with a block selected — ⌘C ⌘X ⌘V ⌘D ⌫ ↑ ↓ ⌘Z, ⏎ back into its text
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null, mod = e.metaKey || e.ctrlKey;
            if (e.key === "Escape" && active && !menu && !linkOpen) { const unit = active.view.dom.closest<HTMLElement>(UNIT); if (unit) { e.preventDefault(); pickObject(unit); } return; }
            if (!picked || active || t?.closest("input, textarea, select, [contenteditable=true]")) return;
            const k = e.key.toLowerCase(), run = (op: Parameters<typeof blockOp>[0]) => { e.preventDefault(); blockOp(op); };
            if (e.key === "Escape") { e.preventDefault(); setPicked(null); }
            else if (mod && k === "c") run("copy"); else if (mod && k === "x") run("cut"); else if (mod && k === "v") run("paste"); else if (mod && k === "d") run("dup");
            else if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); undoStructure(); }
            else if (e.key === "Backspace" || e.key === "Delete") { run("del"); say("Deleted · ⌘Z brings it back"); }
            else if (e.key === "ArrowUp") run("up"); else if (e.key === "ArrowDown") run("down");
            else if (e.key === "Enter") { const ed = editorsRef.current.find((x) => picked.contains(x.view.dom)); if (ed) { e.preventDefault(); ed.commands.focus("end"); } }
        };
        window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true);
    }, [active, picked, menu, linkOpen, blockOp, pickObject, undoStructure, say]);

    // drag a selected object by its tab (or the grip in the side pill): a line shows where it will land among its siblings
    const [dropLine, setDropLine] = useState<{ left: number; width: number; y: number } | null>(null);
    const startDrag = useCallback((e: React.PointerEvent, el: HTMLElement | null) => {
        if (!el || fixedUnit(el) || e.button !== 0) return;
        e.preventDefault(); pickObject(el);
        const sibs = Array.from(el.parentElement?.children || []).filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches(UNIT) && !fixedUnit(c));
        let slot = -1, moved = false; const y0 = e.clientY;
        const move = (ev: PointerEvent) => {
            if (!moved && Math.abs(ev.clientY - y0) < 4) return; moved = true;
            const rects = sibs.map((x) => x.getBoundingClientRect());
            slot = rects.findIndex((r) => ev.clientY < r.top + r.height / 2); if (slot < 0) slot = sibs.length;
            const ref = rects[Math.min(slot, rects.length - 1)], y = slot < rects.length ? ref.top - 3 : ref.bottom + 3;
            setDropLine({ left: ref.left, width: ref.width, y }); document.body.style.cursor = "grabbing";
        };
        const up = () => {
            window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; setDropLine(null);
            const from = sibs.indexOf(el); if (!moved || slot < 0 || slot === from || slot === from + 1) return;
            const me = unitIndex(el), before = slot < sibs.length ? unitIndex(sibs[slot]) : -1, lastSib = unitIndex(sibs[sibs.length - 1]);
            restructure((units) => { const node = units[me]; if (!node) return null; if (before >= 0) units[before].before(node); else units[lastSib].after(node); return node; });
        };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    }, [pickObject, restructure]);
    const unitLabel = (el: HTMLElement) => (fixedUnit(el) ? "Header · from the résumé" : el.getAttribute("data-cv-repeat") === "job" ? "Experience entry" : el.tagName === "HEADER" ? "Header" : el.querySelector("hr, .cv-divider") || el.matches("hr, .cv-divider") ? "Divider" : "Block");

    /* ---- the "+" between rows: hover a gap, pick a kind, a new block lands there ---- */
    const [insertAt, setInsertAt] = useState<{ after: number; y: number; left: number; width: number } | null>(null);
    const [insertMenu, setInsertMenu] = useState(false);
    const focusBlock = useRef<number | null>(null), insertHold = useRef(false);
    const onCanvasMove = useCallback((e: React.MouseEvent) => {
        if (insertMenu || e.buttons) return;                                     // menu open, or a drag-select in progress
        const page = hostRef.current?.querySelector(".cv-page"); if (!page) return;
        const pr = page.getBoundingClientRect(), blocks = topBlocks(page);
        let hit: { after: number; y: number } | null = null;
        if (e.clientX >= pr.left - 24 && e.clientX <= pr.right + 24) {
            for (let i = 0; i < blocks.length; i++) {
                const bottom = blocks[i].getBoundingClientRect().bottom, nextTop = blocks[i + 1]?.getBoundingClientRect().top ?? bottom + 24;
                const y = bottom + Math.max(2, Math.min(nextTop - bottom, 16)) / 2;   // mid-gap (a page break's long gap counts as a short one)
                if (Math.abs(e.clientY - y) <= 9) { hit = { after: i, y }; break; }
            }
        }
        setInsertAt((cur) => (hit ? (cur && cur.after === hit.after && Math.abs(cur.y - hit.y) < 1 ? cur : { ...hit, left: pr.left, width: pr.width }) : insertHold.current ? cur : null));
    }, [insertMenu]);
    const addBlock = useCallback((kind: BlockKind) => {
        const src = stateRef.current.source, at = insertAt; if (!src || !at) return;
        const tmp = document.createElement("div"); tmp.innerHTML = serialize();
        const page = tmp.querySelector(".cv-page"); if (!page) return;
        focusBlock.current = insertBlock(page, at.after, kind);
        setInsertMenu(false); setInsertAt(null); insertHold.current = false;
        setSource({ css: src.css, html: tmp.innerHTML }); setDirty(true);
    }, [insertAt, serialize]);

    /* ---- images: click any <img> in the document to swap it ---- */
    const onHostClick = useCallback((e: React.MouseEvent) => {
        // ⌘/Ctrl-click a link: a plain click edits its text, so opening it is a deliberate gesture — and it asks first, showing where it goes
        const link = (e.metaKey || e.ctrlKey) ? (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]") : null;
        if (link && hostRef.current?.contains(link)) {
            const href = link.getAttribute("href") || "";
            e.preventDefault();
            if (!/^(https?:|mailto:)/i.test(href)) { say("That link doesn't go anywhere a browser can open"); return; }
            setConfirm({ msg: `Open this link in your browser?\n${href.length > 90 ? href.slice(0, 88) + "…" : href}`, ok: "Open", run: () => { if (files?.openExternal) files.openExternal(href); else window.open(href, "_blank", "noopener"); } });
            return;
        }
        const target = e.target as HTMLElement, unit = target.closest<HTMLElement>(UNIT);
        if (unit && hostRef.current?.contains(unit) && (e.altKey || !target.closest("[data-cv-edit], img, a"))) { e.preventDefault(); pickObject(unit); return; }
        const img = (e.target as HTMLElement).closest("img");
        if (img && hostRef.current?.contains(img)) { const r = img.getBoundingClientRect(); setImgPop({ img, left: r.left, top: r.bottom + 8 }); }
        const rule = (e.target as HTMLElement).closest<HTMLElement>(".cv-divider");
        if (rule && hostRef.current?.contains(rule)) { (document.activeElement as HTMLElement | null)?.blur?.(); setActive(null); setPicked(rule); }
    }, [files, say, pickObject]);
    // the selected image's live rect, so its resize box follows scrolling / zoom / re-layout
    const [imgRect, setImgRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    useEffect(() => {
        if (!imgPop) { setImgRect(null); return; }
        let raf = 0, last = "";
        const tick = () => {
            if (!imgPop.img.isConnected) { setImgPop(null); return; }
            const r = imgPop.img.getBoundingClientRect(), key = [r.left, r.top, r.width, r.height].map((n) => n.toFixed(1)).join();
            if (key !== last) { last = key; setImgRect({ left: r.left, top: r.top, width: r.width, height: r.height }); }
            raf = requestAnimationFrame(tick);
        };
        tick(); return () => cancelAnimationFrame(raf);
    }, [imgPop]);
    // drag a corner to resize: width is stored in pt (zoom-independent, so it exports at the same size), height stays auto
    const resizeImg = (e: React.PointerEvent, corner: string) => {
        const img = imgPop?.img, page = hostRef.current?.querySelector<HTMLElement>(".cv-page"); if (!img || !page) return;
        e.preventDefault(); e.stopPropagation();
        const start = img.getBoundingClientRect(), west = corner.includes("w");
        const k = page.getBoundingClientRect().width / PAPERS[stateRef.current.settings.paper].w;   // screen px per pt (includes zoom)
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => {
            const w = Math.max(16, start.width + (ev.clientX - x0) * (west ? -1 : 1));   // screen px
            img.style.width = (w / k).toFixed(1) + "pt"; img.style.height = "auto"; img.removeAttribute("width"); img.removeAttribute("height");
            document.body.style.cursor = corner.length === 2 ? corner + "-resize" : corner + "-resize";
        };
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.cursor = ""; touch(); };
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    };
    const onImgFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0], img = imgPop?.img; e.target.value = ""; if (!f || !img) return;
        const reader = new FileReader();
        reader.onload = () => { img.src = String(reader.result); img.onload = () => touch(); setImgPop(null); touch(); };
        reader.readAsDataURL(f);
    }, [imgPop, touch]);

    /* ---- chrome plumbing: tooltips, outside-click, layout follow ---- */
    useEffect(() => {
        const tip = tipRef.current; if (!tip) return;
        const over = (e: MouseEvent) => {
            const t = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
            if (!t || !t.dataset.tip) { tip.hidden = true; return; }
            tip.textContent = t.dataset.tip; tip.hidden = false;
            const r = t.getBoundingClientRect(), w = tip.offsetWidth;
            tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
            tip.style.top = (r.bottom + 8 + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8) + "px";
        };
        const hide = () => { tip.hidden = true; };
        document.addEventListener("mouseover", over); document.addEventListener("mousedown", hide);
        return () => { document.removeEventListener("mouseover", over); document.removeEventListener("mousedown", hide); };
    }, [look.ready]);
    useEffect(() => {
        const down = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            if (!t.closest(".pt-menu-pop, .pt-dim-pop, #pt-bar, .pt-cpick")) { setMenu(null); setImgPop(null); }
            if (!t.closest(".cvm-insert, .cvm-insert-menu")) { setInsertMenu(false); insertHold.current = false; }
            if (!t.closest(".cvm-paper, .pt-menu-pop, #pt-bar, #pt-ctx, #pt-confirm, .pt-cpick")) { setActive(null); setPicked(null); (document.activeElement as HTMLElement | null)?.blur?.(); }
        };
        document.addEventListener("mousedown", down); return () => document.removeEventListener("mousedown", down);
    }, []);
    const [, setLayoutTick] = useState(0);
    useEffect(() => {
        const wrap = wrapRef.current; if (!wrap) return;
        const bump = () => { setLayoutTick((t) => t + 1); setImgPop(null); setInsertAt(null); setInsertMenu(false); };
        wrap.addEventListener("scroll", bump, { passive: true }); window.addEventListener("resize", bump);
        return () => { wrap.removeEventListener("scroll", bump); window.removeEventListener("resize", bump); };
    }, [look.ready]);

    const openMenu = (id: "size" | "export" | "more" | "brand", e: React.MouseEvent, align: "left" | "right") => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setExportKind(null);
        setMenu((m) => (m?.id === id ? null : { id, top: r.bottom + 8, ...(align === "left" ? { left: r.left } : { right: window.innerWidth - r.right }) }));
    };

    /* ---- first-run tour ---- */
    const shown = (k: string) => !tour || tour >= (REVEAL[k] || 0);
    const endTour = useCallback(() => { setTour(0); setMenu(null); setCtx(null); store(TOUR_KEY, "1"); }, []);
    const startTour = useCallback(() => { setMenu(null); setCtx(null); void switchTab("resume"); setTour(1); }, [switchTab]);
    // each step's side-effect: switch tab, or open the IcedCoffee menu / the Background panel for the last two steps
    useEffect(() => {
        if (!tour) return;
        const step = TOUR[tour - 1];
        if (!step) { endTour(); return; }
        if (step.side === "letter") void switchTab("letter");
        else if (step.side === "brandMenu") {
            setCtx(null); void switchTab("resume");
            const g = document.querySelector('[data-tour="glyph"]') as HTMLElement | null;
            if (g) { const r = g.getBoundingClientRect(); setMenu({ id: "brand", top: r.bottom + 8, left: r.left }); }
        } else if (step.side === "bgOptions") {
            setMenu(null);
            const g = document.querySelector('[data-tour="glyph"]') as HTMLElement | null;
            const r = g?.getBoundingClientRect();
            setCtx({ x: (r?.left ?? 40) + 6, y: (r?.bottom ?? 56) + 8 });
        } else { setMenu(null); setCtx(null); }
    }, [tour]);   // eslint-disable-line react-hooks/exhaustive-deps
    // keep the coach-mark pinned under its target as the toolbar widens / menus open
    useLayoutEffect(() => {
        if (!tour) { setCoach(null); return; }
        const step = TOUR[tour - 1];
        const place = () => {
            const el = step && document.querySelector(step.at) as HTMLElement | null;
            if (!el) { setCoach(null); return; }
            const r = el.getBoundingClientRect(), W = 330;
            if (step.place === "right") {   // beside the menu it's describing, so it never covers it: try right, then left, then below
                if (r.right + 14 + W <= window.innerWidth - 12) setCoach({ left: r.right + 14, top: Math.max(12, Math.min(r.top, window.innerHeight - 220)), arrow: 0, right: true });
                else if (r.left - 14 - W >= 12) setCoach({ left: r.left - 14 - W, top: Math.max(12, Math.min(r.top, window.innerHeight - 220)), arrow: 0, right: true });
                else setCoach({ left: Math.max(12, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 12)), top: r.bottom + 12, arrow: 0, right: true });
            } else {
                const left = Math.max(12, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 12));
                setCoach({ left, top: r.bottom + 30, arrow: Math.max(20, Math.min(W - 20, r.left + r.width / 2 - left)), right: false });
            }
        };
        place();
        const id = window.setInterval(place, 150);
        window.addEventListener("resize", place);
        return () => { window.clearInterval(id); window.removeEventListener("resize", place); };
    }, [tour]);

    /* ---- format bar state, read from what's actually rendered at the caret ---- */
    const fmt = useMemo(() => {
        if (!active || active.isDestroyed) return null;
        try {
            const { from } = active.state.selection, at = active.view.domAtPos(from);
            const el = (at.node.nodeType === 3 ? at.node.parentElement : (at.node as HTMLElement)) || active.view.dom;
            const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight), ls = parseFloat(cs.letterSpacing);
            const rgb = cs.color.match(/\d+/g)?.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("") || "000000";
            return { size: +(fs / PT).toFixed(2), weight: String(Math.round((parseInt(cs.fontWeight, 10) || 400) / 100) * 100), line: Number.isFinite(lh) ? +(lh / fs).toFixed(2) : "", spacing: Number.isFinite(ls) ? +(ls / PT).toFixed(2) : 0, color: "#" + rgb };
        } catch { return null; }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, active?.state]);

    // a bare caret means "this paragraph": widen the selection for inline marks, then put it back
    const mark = useCallback((fn: (e: Editor) => void) => {
        const ed = active; if (!ed) return;
        const { from, to, empty, $from } = ed.state.selection;
        if (empty) { ed.commands.setTextSelection({ from: $from.start(), to: $from.end() }); fn(ed); ed.commands.setTextSelection({ from, to }); } else fn(ed);
    }, [active]);
    // text color uses Infospector's glass picker (not the OS dialog); refs keep its callbacks current
    const colorLive = useRef<{ read: () => string; write: (v: string) => void }>({ read: () => "#000000", write: () => {} });
    colorLive.current = { read: () => fmt?.color || "#000000", write: (v) => mark((ed) => ed.commands.setColor(toHex(v))) };
    const colorRef = useCallback((node: HTMLInputElement | null) => { if (node) attachColorPicker(node, { read: () => colorLive.current.read(), write: (v) => colorLive.current.write(v) }); }, []);
    const num = (v: string, lo: number, hi: number) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
    const keep = (e: React.MouseEvent) => e.preventDefault();   // toolbar clicks must not steal the editor's selection
    const openLink = () => { if (!active) return; setLinkUrl(active.getAttributes("link").href || ""); setLinkOpen((o) => !o); };
    const applyLink = () => {
        if (!active) return; const href = linkUrl.trim();
        if (href) active.chain().focus().extendMarkRange("link").setLink({ href: /^(https?:|mailto:|tel:|#|\/)/i.test(href) ? href : "https://" + href }).run();
        else active.chain().focus().extendMarkRange("link").unsetLink().run();
        setLinkOpen(false);
    };

    // the format bar sits IN PLACE: just above the box being edited (below it when there's no room above),
    // centered on it and kept on-screen. Runs after every render, so it follows typing, scrolling and zoom.
    const fmtRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const bar = fmtRef.current; if (!bar || !active || active.isDestroyed) return;
        const box = active.view.dom.getBoundingClientRect(), w = bar.offsetWidth, h = bar.offsetHeight, gap = 10, m = 12, floor = 72;   // floor: clear of the top bar
        let top = box.top - h - gap;
        if (top < floor) { const below = box.bottom + gap; top = below + h <= window.innerHeight - m ? below : floor; }
        top = Math.max(floor, Math.min(top, window.innerHeight - h - m));
        const left = Math.max(m, Math.min(box.left + box.width / 2 - w / 2, window.innerWidth - w - m));
        bar.style.left = Math.round(left) + "px"; bar.style.top = Math.round(top) + "px";
    });

    const blockRect = activeBlock?.getBoundingClientRect(), paperRect = paperRef.current?.getBoundingClientRect();
    const stride = paper.h + GAP_PT;
    const overflowMarks = !settings.paginate && contentPt > paper.h + 1 ? Array.from({ length: Math.floor((contentPt - 1) / paper.h) }, (_, i) => (i + 1) * paper.h) : [];
    const pill = (on: boolean) => ({ "aria-pressed": on } as const);

    return (
        <div className={"cvm-root" + (tour === 1 ? " cvm-tour-cover" : "")} data-ready={look.ready}>
            {/* desktop shell: a transparent strip where the OS title bar would be, so the frameless window
                can be dragged (the toolbar's own controls stay clickable). Transparent, so it always shows
                the chosen background through it and never clashes. CSS activates it only under .cvm-desktop. */}
            <div className="cvm-titlebar" aria-hidden="true" />
            {source && <style>{`${source.css}\n${pageBoxCss(paper.w, scale)}`}</style>}
            {/* where the picked ATS keyword is used: highlighter yellow via the CSS Custom Highlight API (ranges only — no markup is touched) */}
            <style>{"::highlight(cvm-kw) { background-color: #ffe14d; color: #000; }"}</style>

            {/* main bar — Infospector's #pt-bar */}
            <div id="pt-bar" className={"cvm-bar" + (tour ? " cvm-bar-tour" : "")}>
                {backHref && <button className="pt-rbtn" aria-label="Back" data-tip="Back" onClick={() => { window.location.href = backHref; }}><ArrowLeft /></button>}
                <button className="cvm-brand" data-tour="glyph" aria-label="IcedCoffee menu" aria-haspopup="menu" data-tip="IcedCoffee" onClick={(e) => openMenu("brand", e, "left")}><IcedCoffeeGlyph className="cvm-brand-glyph" /></button>
                {shown("size") && <div className="pt-dim" data-tour="size">
                    <div className="pt-dim-trigger">
                        <button className="pt-dim-val" aria-haspopup="true" data-tip="Paper size and zoom" onClick={(e) => openMenu("size", e, "left")}>{paper.label}<span className="pt-dim-scale" style={{ color: "var(--pt-text-faint)" }}>· {Math.round(zoom * 100)}%</span></button>
                        <button className="pt-chev" aria-label="Choose a size" onClick={(e) => openMenu("size", e, "left")}>▾</button>
                    </div>
                </div>}
                {shown("omni") && <div ref={omniRef} data-tour="omni" className={"pt-omni" + (hasRecents ? " cvm-omni-recent" : "") + ((hasRecents ? (omniOpen ? omniQuery : fileName) : name) ? " pt-has-value" : "")}>
                    <span className="pt-omni-icon"><FileText /></span>
                    {hasRecents ? (
                        <input type="text" spellCheck={false} aria-label="Open a recent document" placeholder={fileName || (tab === "letter" ? "Untitled — search recent cover letters" : "Untitled — search recent documents")}
                            value={omniOpen ? omniQuery : fileName}
                            onFocus={() => { setOmniOpen(true); setOmniQuery(""); setOmniIdx(0); void files?.recent?.(tab).then(setRecents).catch(() => {}); }}
                            onChange={(e) => { setOmniOpen(true); setOmniQuery(e.target.value); setOmniIdx(0); }}
                            onKeyDown={omniKey} />
                    ) : (
                        <input type="text" value={name} spellCheck={false} aria-label="Document name" placeholder="Document name" onChange={(e) => { setName(e.target.value); setDirty(true); }} />
                    )}
                    <button className="pt-omni-clear cvm-import" aria-label={files ? `Open a ${KIND_LABEL[tab].toLowerCase()} file` : "Import a source HTML file"} data-tip={files ? `Open a ${KIND_LABEL[tab].toLowerCase()} file · ⌘O` : "Import a source HTML file"} onClick={() => (files ? files.open(tab) : fileRef.current?.click())}><Upload /></button>
                    {hasRecents && omniOpen && (
                        <div className="pt-omni-results pt-open" role="listbox">
                            {omniRows === 0 ? (
                                <div className="pt-omni-empty">{recents.length ? "No document matches." : "No recent documents yet — open or save one."}</div>
                            ) : omniList.map((r, i) => (
                                <div key={r.path} role="option" aria-selected={i === omniIdx} className={"pt-omni-item cvm-omni-item" + (i === omniIdx ? " pt-active" : "")}
                                    onMouseEnter={() => setOmniIdx(i)} onMouseDown={(e) => { e.preventDefault(); chooseRecent(r.path); }}>
                                    <span className="pt-oi-title">{r.name}</span>
                                    {r.pinned && <span className="pt-oi-badge">Master</span>}
                                    <button className={"cvm-omni-pin" + (r.pinned ? " pt-active" : "")} aria-label={r.pinned ? "Unpin master" : "Pin as master"} data-tip={r.pinned ? "Unpin master" : "Pin as master"}
                                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(r); }}><Star /></button>
                                </div>
                            ))}
                            {omniNewName && (
                                <div role="option" aria-selected={omniIdx === omniList.length} className={"pt-omni-item cvm-omni-item" + (omniIdx === omniList.length ? " pt-active" : "")}
                                    onMouseEnter={() => setOmniIdx(omniList.length)} onMouseDown={(e) => { e.preventDefault(); void saveAsName(omniNewName); }}>
                                    <Save /><span className="pt-oi-title">Save as “{omniNewName}”</span><span className="pt-oi-badge">{fileName ? "new copy" : "new file"}</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>}
                {shown("paginate") && <button className="pt-rbtn" data-tour="paginate" {...pill(settings.paginate)} aria-label="Pagination" data-tip={settings.paginate ? "Pagination on · pages + page numbers" : "Pagination off · one continuous page"} onClick={() => patch({ paginate: !settings.paginate })}><BookOpen /></button>}
                {shown("spell") && <button className="pt-rbtn cvm-secondary" data-tour="spell" {...pill(settings.spellcheck)} aria-label="Spellcheck" data-tip={settings.spellcheck ? "Spellcheck on" : "Spellcheck off"} onClick={() => patch({ spellcheck: !settings.spellcheck })}><SpellCheck /></button>}
                {shown("save") && <button className="pt-rbtn pt-badge-btn" data-tour="save" aria-label="Save" data-tip={files ? "Save · ⌘S   Save As · ⇧⌘S" : "Save in this browser · ⌘S"} onClick={() => save()}><Save />{dirty && <span className="cvm-dirty" />}</button>}
                {shown("export") && <button className="pt-rbtn pt-badge-btn" data-tour="export" aria-haspopup="true" aria-label="Export" data-tip={busy ? `Exporting ${busy}…` : "Export"} onClick={(e) => openMenu("export", e, "right")}><Download /></button>}
                {shown("seg") && <div className="cvm-seg" data-tour="seg" role="tablist" aria-label="Document">
                    <button role="tab" aria-selected={tab === "resume"} aria-label="Résumé" data-tip="Résumé" className={tab === "resume" ? "cvm-on" : ""} onClick={() => void switchTab("resume")}><FileUser /></button>
                    <button role="tab" aria-selected={tab === "letter"} aria-label="Cover Letter" data-tip="Cover Letter" className={tab === "letter" ? "cvm-on" : ""} onClick={() => void switchTab("letter")}><FileText /></button>
                </div>}
            </div>

            {/* format bar */}
            {active && fmt && (
                <div ref={fmtRef} className="pt-menu-pop pt-open cvm-fmt" onMouseDown={(e) => { if (!(e.target as HTMLElement).closest("input, select")) keep(e); }}>
                    <button className="cvm-fbtn" {...pill(active.isActive("bold"))} data-tip="Bold · ⌘B" onClick={() => active.chain().focus().toggleBold().run()}><Bold /></button>
                    <button className="cvm-fbtn" {...pill(active.isActive("italic"))} data-tip="Italic · ⌘I" onClick={() => active.chain().focus().toggleItalic().run()}><Italic /></button>
                    <button className="cvm-fbtn" {...pill(active.isActive("underline"))} data-tip="Underline · ⌘U" onClick={() => active.chain().focus().toggleUnderline().run()}><UnderlineIcon /></button>
                    <span className="cvm-fsep" />
                    <label className="cvm-field" data-tip="Font size (pt)"><ALargeSmall /><input type="number" min={4} max={72} step={0.5} value={fmt.size} onChange={(e) => { const v = num(e.target.value, 4, 72); if (v != null) mark((ed) => ed.commands.setFontSize(v + "pt")); }} /></label>
                    <label className="cvm-field" data-tip="Font weight"><select value={fmt.weight} onChange={(e) => mark((ed) => ed.commands.setFontWeight(e.target.value))}>{[["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                    <label className="cvm-field" data-tip="Line height (× font size) — whole paragraph"><MoveVertical /><input type="number" min={0.8} max={3} step={0.05} value={fmt.line} placeholder="auto" onChange={(e) => { const v = num(e.target.value, 0.8, 3); if (v != null) active.commands.setBlockLineHeight(String(v)); }} /></label>
                    <label className="cvm-field" data-tip="Letter spacing (pt)"><MoveHorizontal /><input type="number" min={-2} max={10} step={0.02} value={fmt.spacing} onChange={(e) => { const v = num(e.target.value, -2, 10); if (v != null) mark((ed) => ed.commands.setLetterSpacing(v + "pt")); }} /></label>
                    <label className="cvm-field" data-tip="Text color" style={{ paddingLeft: 4 }}><input ref={colorRef} type="color" value={fmt.color} onChange={(e) => mark((ed) => ed.commands.setColor(e.target.value))} /></label>
                    <span className="cvm-fsep" />
                    <button className="cvm-fbtn" {...pill(active.isActive("link") || linkOpen)} data-tip="Link · ⌘K" onClick={openLink}><Link2 /></button>
                    <button className="cvm-fbtn" {...pill(active.isActive("bulletList"))} data-tip="Bullets" onClick={() => active.chain().focus().toggleBulletList().run()}><List /></button>
                    <button className="cvm-fbtn" data-tip="Insert a rule (horizontal line)" onClick={() => active.chain().focus().setHorizontalRule().run()}><Minus /></button>
                    <button className="cvm-fbtn" {...pill(!!(active.getAttributes("listItem").colBreak || active.getAttributes("paragraph").colBreak))} data-tip="Start the next column here" onClick={() => active.chain().focus().toggleColumnBreak().run()}><Columns2 /></button>
                    <span className="cvm-fsep" />
                    <button className="cvm-fbtn" {...pill(active.isActive({ textAlign: "left" }))} data-tip="Align left" onClick={() => active.chain().focus().setTextAlign("left").run()}><AlignLeft /></button>
                    <button className="cvm-fbtn" {...pill(active.isActive({ textAlign: "center" }))} data-tip="Align center" onClick={() => active.chain().focus().setTextAlign("center").run()}><AlignCenter /></button>
                    <button className="cvm-fbtn" {...pill(active.isActive({ textAlign: "right" }))} data-tip="Align right" onClick={() => active.chain().focus().setTextAlign("right").run()}><AlignRight /></button>
                    <button className="cvm-fbtn" data-tip="Clear formatting" onClick={() => mark((ed) => { ed.chain().unsetAllMarks().run(); ed.commands.unsetBlockLineHeight(); ed.commands.unsetTextAlign(); })}><Eraser /></button>
                    {linkOpen && (
                        <div className="cvm-link">
                            <input autoFocus type="text" value={linkUrl} placeholder="https://…  (empty removes the link)" spellCheck={false} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } }} />
                            <button className="pt-mini pt-primary" style={{ display: "inline-flex" }} onClick={applyLink}>Apply</button>
                        </div>
                    )}
                </div>
            )}

            {/* menus */}
            {menu?.id === "size" && (
                <div className="pt-dim-pop pt-open" role="menu" style={{ left: menu.left, top: menu.top, minWidth: 250 }}>
                    {(Object.keys(PAPERS) as PaperId[]).map((id) => (
                        <div key={id} className={"pt-dim-row" + (settings.paper === id ? " pt-active" : "")} onClick={() => { patch({ paper: id }); setMenu(null); }}><span className="pt-dim-num">{PAPERS[id].label}</span><span className="pt-dim-name">{PAPERS[id].name}</span></div>
                    ))}
                    <div className="pt-dim-div" />
                    <div className={"pt-dim-row" + (settings.fit ? " pt-active" : "")} data-tip="Scale the whole design down (never below 80%) so it lands on a single sheet" onClick={() => { patch({ fit: !settings.fit }); setMenu(null); }}><span className="pt-dim-num">Fit to one page</span><span className="pt-dim-name">{settings.fit ? (scale < 1 ? `on · ${Math.round(scale * 100)}%` : "on") : "off"}</span></div>
                    <div className="pt-dim-div" />
                    <div className={"pt-dim-row" + (zoomMode === "width" ? " pt-active" : "")} data-tip="The sheet fills the window's width — and keeps fitting as you resize" onClick={() => { patch({ zoom: "width" }); setMenu(null); }}><span className="pt-dim-num">Fit width</span><span className="pt-dim-name">{Math.round(fits.width * 100)}%</span></div>
                    <div className={"pt-dim-row" + (zoomMode === "height" ? " pt-active" : "")} data-tip="One sheet fills the window's height — and keeps fitting as you resize" onClick={() => { patch({ zoom: "height" }); setMenu(null); }}><span className="pt-dim-num">Fit height</span><span className="pt-dim-name">{Math.round(fits.height * 100)}%</span></div>
                    {ZOOMS.map((z) => (
                        <div key={z} className={"pt-dim-row" + (settings.zoom === z ? " pt-active" : "")} onClick={() => { patch({ zoom: z }); setMenu(null); }}><span className="pt-dim-num">{z * 100}%</span></div>
                    ))}
                </div>
            )}
            {menu?.id === "export" && (
                <div className="pt-menu-pop pt-open" role="menu" style={{ right: menu.right, top: menu.top, minWidth: 230 }}>
                    {!exportKind ? (
                        <>
                            <button className="pt-menu-item cvm-row" aria-haspopup="menu" onClick={() => setExportKind("pdf")}><FileType2 />PDF<span className="cvm-hint">real text · links ›</span></button>
                            <button className="pt-menu-item cvm-row" aria-haspopup="menu" onClick={() => setExportKind("docx")}><FileText />Word (DOCX)<span className="cvm-hint">ATS-friendly ›</span></button>
                            <button className="pt-menu-item cvm-row" aria-haspopup="menu" onClick={() => setExportKind("png")}><FileImage />PNG<span className="cvm-hint">2× ›</span></button>
                            <div className="pt-menu-div" />
                            <button className="pt-menu-item cvm-row" aria-haspopup="menu" onClick={() => setExportKind("html")}><FileCode2 />Source HTML<span className="cvm-hint">re-loadable ›</span></button>
                        </>
                    ) : (
                        <>
                            <button className="pt-menu-item cvm-row cvm-back" onClick={() => setExportKind(null)}><ChevronLeft />{{ pdf: "PDF", docx: "Word (DOCX)", png: "PNG", html: "Source HTML" }[exportKind]}</button>
                            <div className="pt-menu-div" />
                            <button className="pt-menu-item cvm-row" onClick={() => runExport(exportKind, "resume")}><FileUser />Résumé{tab === "resume" && <span className="cvm-hint">this tab</span>}</button>
                            <button className="pt-menu-item cvm-row" onClick={() => runExport(exportKind, "letter")}><FileText />Cover Letter{tab === "letter" && <span className="cvm-hint">this tab</span>}</button>
                            <button className="pt-menu-item cvm-row" onClick={() => runExport(exportKind, "all")}><Files />All<span className="cvm-hint">two files</span></button>
                        </>
                    )}
                </div>
            )}
            {menu?.id === "brand" && (
                <div className="pt-menu-pop pt-open cvm-brand-menu" role="menu" style={{ left: menu.left, top: menu.top, minWidth: 220 }}>
                    <div className="pt-ctx-title">Appearance</div>
                    <button className="pt-menu-item cvm-row" onClick={() => look.setTheme(look.theme === "light" ? "dark" : "light")}>{look.theme === "light" ? <Sun /> : <Moon />}{look.theme === "light" ? "Light mode" : "Dark mode"}<span className="cvm-hint">switch to {look.theme === "light" ? "dark" : "light"}</span></button>
                    <button className="pt-menu-item cvm-row" onClick={(e) => { setMenu(null); setCtx({ x: e.clientX, y: e.clientY }); }}><Settings2 />Background · colors · appearance…</button>
                    {/* on narrow windows spellcheck leaves the bar (so nothing is ever pushed off-screen) and lives here */}
                    <button className="pt-menu-item cvm-row cvm-narrow-only" onClick={() => patch({ spellcheck: !settings.spellcheck })}><SpellCheck />Spellcheck<span className="cvm-hint">{settings.spellcheck ? "on" : "off"}</span></button>
                    <div className="pt-menu-div" />
                    <div className="pt-ctx-title">Window</div>
                    <button className="pt-menu-item cvm-row" onClick={() => { setMenu(null); setKwOpen((o) => !o); }}><ScanSearch />ATS keywords<span className="cvm-hint">{kw.keywords.length ? `${kwUses.filter((u) => u[tab] > 0).length} of ${kw.keywords.length} used` : kwOpen ? "hide" : "none yet"}</span></button>
                    <button className="pt-menu-item cvm-row" onClick={() => startTour()}><Sparkles />Take the tour again</button>
                    <button className="pt-menu-item cvm-row" onClick={() => { setMenu(null); if (remote?.configure || assistant?.configure) openConnect(); else setGetApp(true); }}><LifeBuoy />Help · connect your AI</button>
                    <div className="pt-menu-div" />
                    <div className="pt-ctx-title">Document</div>
                    <button className="pt-menu-item cvm-row pt-danger" onClick={() => { setMenu(null); resetSource(); }}><RotateCcw />Reset to original source</button>
                    <div className="pt-menu-div" />
                    {files?.checkUpdates && <button className="pt-menu-item cvm-row" onClick={checkUpdates}><IcedCoffeeGlyph className="cvm-menu-glyph" />Check for Updates…{appVersion && <span className="cvm-hint">{appVersion}</span>}</button>}
                    {isWebBuild && <button className="pt-menu-item cvm-row" onClick={() => { setMenu(null); setGetApp(true); }}><Download />Get the Mac app<span className="cvm-hint">free</span></button>}
                    {/* credit: the tool says who made it and where it lives — never the exported résumé, which is the user's */}
                    <button className="pt-menu-item cvm-credit" onClick={visitHomepage} data-tip="qmanning.com ↗"><span className="cvm-credit-in">Made by <QLogo className="cvm-qlogo" /></span></button>
                </div>
            )}
            {kwOpen && (() => {
                const used = kwUses.filter((u) => u[tab] > 0).length, other: DocKind = tab === "resume" ? "letter" : "resume";
                const add = () => { const next = normalizeKeywords([...kw.keywords, ...kwDraft.split(",")]); if (next.length !== kw.keywords.length) applyKeywords(next); setKwDraft(""); };
                return (
                    <div ref={kwRef} className="pt-menu-pop pt-open cvm-kw" role="dialog" aria-label="ATS keywords" style={{ ...(kwPos ? { left: kwPos.x, top: kwPos.y } : { right: 20, top: 92 }), ...(kwSize ? { width: kwSize.w, height: kwSize.h } : {}) }} onMouseDown={(e) => { if (!(e.target as HTMLElement).closest("input")) keep(e); }}>
                        <div className="cvm-kw-head" onPointerDown={dragKw}>
                            <ScanSearch /><b>ATS keywords</b>
                            {kw.keywords.length > 0 && <span className="cvm-kw-tally" data-tip={`Used in the ${KIND_LABEL[tab].toLowerCase()}`}>{used}/{kw.keywords.length}</span>}
                            <button className="cvm-kw-x" aria-label="Close" data-tip="Close · reopen from the IcedCoffee menu" onClick={() => { setKwOpen(false); setKwActive(null); }}><X /></button>
                        </div>
                        {kw.job && <div className="cvm-kw-job">{kw.job}</div>}
                        <div className="cvm-kw-add">
                            <input type="text" value={kwDraft} spellCheck={false} placeholder="Add a keyword…" aria-label="Add a keyword" onChange={(e) => setKwDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
                            {kw.keywords.length > 0 && <button className="cvm-kw-clear" onClick={() => applyKeywords([], "")}>Clear</button>}
                        </div>
                        {kw.keywords.length === 0 ? (
                            <p className="cvm-kw-empty">{remote || assistant ? "Give your AI a job ad and ask it for the keywords an ATS will screen for — they land here. Or add your own above." : "Add the words a job ad is screened for, and see where your documents already use them."}</p>
                        ) : (
                            <div className="cvm-kw-list" role="listbox" aria-label="Keywords">
                                {kw.keywords.map((term) => {
                                    const u = kwUses.find((x) => x.keyword === term), n = u ? u[tab] : 0, elsewhere = u ? u[other] : 0;
                                    return (
                                        <div key={term} role="option" aria-selected={kwActive === term} className={"cvm-kw-row" + (n ? " cvm-used" : "") + (kwActive === term ? " pt-active" : "")} data-tip={n ? "Show where it's used" : elsewhere ? `Not in the ${KIND_LABEL[tab].toLowerCase()} — used in the ${KIND_LABEL[other].toLowerCase()}` : "Not used yet"} onClick={() => (n ? pickKeyword(term) : setKwActive(null))}>
                                            {n ? <CircleCheck /> : <CircleDashed />}
                                            <span className="cvm-kw-term">{term}</span>
                                            {elsewhere > 0 && <span className="cvm-kw-else">{other === "letter" ? "letter" : "résumé"} ×{elsewhere}</span>}
                                            {n > 1 && <span className="cvm-kw-n">×{n}</span>}
                                            <button className="cvm-kw-del" aria-label={`Remove ${term}`} onClick={(e) => { e.stopPropagation(); applyKeywords(kw.keywords.filter((k) => k !== term)); }}><X /></button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })()}
            {picked && !active && selRect && (
                <div className={"cvm-selbox" + (fixedUnit(picked) ? " cvm-fixed" : "")} style={{ left: selRect.left, top: selRect.top, width: selRect.width, height: selRect.height }} aria-hidden="true">
                    <div className="cvm-seltab" onPointerDown={(e) => startDrag(e, picked)} data-tip={fixedUnit(picked) ? undefined : "Drag to move · ⌘C ⌘V ⌘D ⌫ ↑ ↓"}>{!fixedUnit(picked) && <GripVertical />}{unitLabel(picked)}</div>
                    {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => <i key={h} className={"cvm-h cvm-h-" + h} />)}
                </div>
            )}
            {dropLine && <div className="cvm-insert-line cvm-drop-line" style={{ left: dropLine.left, width: dropLine.width, top: dropLine.y }} />}
            {activeBlock && blockRect && paperRect && (
                <div className="pt-menu-pop pt-open cvm-blocktools" style={{ left: Math.max(8, paperRect.left - 52), top: Math.max(124, Math.min(window.innerHeight - 170, blockRect.top)) }} onMouseDown={keep}>
                    <button className="cvm-fbtn cvm-grip" data-tip="Drag to move · click to select" onPointerDown={(e) => startDrag(e, activeBlock)}><GripVertical /></button>
                    <button className="cvm-fbtn" data-tip="Move up" onClick={() => blockOp("up")}><ArrowUp /></button>
                    <button className="cvm-fbtn" data-tip="Move down" onClick={() => blockOp("down")}><ArrowDown /></button>
                    <button className="cvm-fbtn" data-tip="Duplicate this entry" onClick={() => blockOp("dup")}><Copy /></button>
                    <button className="cvm-fbtn" data-tip="Delete this entry" onClick={() => setConfirm({ msg: "Delete this entry?", ok: "Delete", run: () => blockOp("del") })}><Trash2 /></button>
                </div>
            )}
            {insertAt && !busy && (
                <>
                    <div className="cvm-insert-line" style={{ left: insertAt.left, width: insertAt.width, top: insertAt.y }} />
                    <button className="pt-rbtn cvm-insert" aria-label="Add a block here" aria-haspopup="menu" aria-expanded={insertMenu} data-tip={insertMenu ? undefined : "Add a block here"}
                        style={{ left: insertAt.left + insertAt.width / 2, top: insertAt.y }} onMouseDown={keep}
                        onMouseEnter={() => { insertHold.current = true; }} onMouseLeave={() => { insertHold.current = insertMenu; }}
                        onClick={() => { setInsertMenu((o) => !o); insertHold.current = true; }}><Plus /></button>
                    {insertMenu && (
                        <div className="pt-menu-pop pt-open cvm-insert-menu" role="menu" style={{ left: insertAt.left + insertAt.width / 2, top: insertAt.y + 22 }} onMouseDown={keep}>
                            {BLOCK_KINDS.map((k) => (
                                <button key={k.kind} className="pt-menu-item cvm-row" role="menuitem" onClick={() => addBlock(k.kind)}>
                                    {k.kind === "content" ? <Text /> : k.kind === "experience" ? <BriefcaseBusiness /> : k.kind === "dual" ? <Columns2 /> : <Minus />}{k.label}<span className="cvm-hint">{k.hint}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </>
            )}
            {imgPop && imgRect && (
                <div className="cvm-imgbox" style={{ left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height }} aria-hidden="true">
                    {["nw", "ne", "se", "sw"].map((c) => <i key={c} className={"cvm-h cvm-h-" + c} style={{ pointerEvents: "auto", cursor: c + "-resize" }} onPointerDown={(e) => resizeImg(e, c)} />)}
                </div>
            )}
            {imgPop && (
                <div className="pt-menu-pop pt-open cvm-imgpop" style={{ left: imgPop.left, top: imgPop.top }}>
                    <button className="pt-menu-item cvm-row" onClick={() => imgFileRef.current?.click()}><ImageUp />Change image…</button>
                    <button className="pt-menu-item cvm-row" onClick={() => openIconPicker(imgPop.img)}><Shapes />Choose Icon and Color…</button>
                    <button className="pt-menu-item cvm-row" onClick={() => { const img = imgPop.img; img.style.removeProperty("width"); img.style.removeProperty("height"); touch(); setImgPop(null); }}><RotateCcw />Reset size</button>
                </div>
            )}
            {iconFor && (
                <Suspense fallback={null}>
                    <IconPicker at={iconAt} color={iconColor} fmt={look.fmt} onColor={recolorIcon}
                        onPick={(uri) => { iconFor.src = uri; touch(); }}
                        onClose={() => setIconFor(null)} />
                </Suspense>
            )}
            {ctx && <LookMenu look={look} at={ctx} say={say} onClose={() => setCtx(null)} startup={{
                size: startSize, page: home, defaultPage: templateUrl,
                sizes: [{ value: "last", label: "Last used" }, ...(Object.keys(PAPERS) as PaperId[]).map((id) => ({ value: id, label: `${PAPERS[id].label} · ${PAPERS[id].name}` }))],
                setSize: (v) => { setStartSize(v); store(START_SIZE_KEY, v === "last" ? "" : v); },
                setPage: (v) => { setHome(v); store(HOME_KEY, v); },
                snippet: () => [home && `window.ITERA_HOME = ${JSON.stringify(home)};`, startSize !== "last" && `window.ITERA_START_SIZE = ${JSON.stringify(startSize)};`].filter(Boolean).join("\n"),
            }} />}

            {/* canvas — Infospector's #pt-stagewrap + background patterns */}
            <main id="pt-stagewrap" ref={wrapRef} className={`cvm-wrap pt-bg-${look.bg.pattern}`} onMouseMove={onCanvasMove} onMouseLeave={() => { if (!insertHold.current && !insertMenu) setInsertAt(null); }}
                onContextMenu={(e) => { if (!(e.target as HTMLElement).closest(".cvm-paper")) { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); } }}>
                <div className="cvm-paper" ref={paperRef} style={{ ["--cvm-page-w" as string]: paper.w + "pt", zoom }}>
                    <div className="cvm-sheets">
                        {settings.paginate
                            ? Array.from({ length: pages }, (_, i) => <div key={i} className="cvm-sheet" style={{ top: i * stride + "pt", height: paper.h + "pt" }}>{pages > 1 && <div className="cvm-pageno">{i + 1}</div>}</div>)
                            : <div className="cvm-sheet" style={{ top: 0, bottom: 0 }} />}
                        {overflowMarks.map((y, i) => <div key={y} className="cvm-overflow" style={{ top: y + "pt" }}><span>page {i + 1} ends</span></div>)}
                    </div>
                    <div className="cvm-host" ref={hostRef} onClick={onHostClick}
                        onMouseDownCapture={(e) => {   // ⌥-press selects the OBJECT under the pointer: caught before the text editor can take the press (and the caret) for itself
                            const unit = e.altKey && e.button === 0 ? (e.target as HTMLElement).closest<HTMLElement>(UNIT) : null;
                            if (unit && hostRef.current?.contains(unit)) { e.preventDefault(); e.stopPropagation(); pickObject(unit); }
                        }} />
                    {/* export in progress: each sheet dims and Infospector's scan line sweeps it until the file is ready */}
                    <div className={"cvm-scans" + (busy ? " cvm-scanning" : "")} aria-hidden="true">
                        {settings.paginate
                            ? Array.from({ length: pages }, (_, i) => <div key={i} className="cvm-scan" style={{ top: i * stride + "pt", height: paper.h + "pt" }} />)
                            : <div className="cvm-scan" style={{ top: 0, bottom: 0 }} />}
                    </div>
                </div>
            </main>

            <div className="cvm-status">{scale < 1 ? `fit to one page · ${Math.round(scale * 100)}% · ` : ""}{settings.paginate ? `${pages} page${pages > 1 ? "s" : ""}` : `continuous · ${(contentPt / paper.h).toFixed(2)} pages long`} · {paper.name}</div>
            <div id="pt-tip" ref={tipRef} role="tooltip" hidden />
            <div id="pt-toast" className={toast ? "pt-show" : undefined}>{toast}</div>
            {tour > 0 && (
                <>
                    {/* stray clicks shouldn't derail the walk-through — Next / Skip drive it */}
                    <div className="cvm-tour-scrim" onMouseDown={(e) => e.preventDefault()} />
                    {coach && (() => { const step = TOUR[tour - 1], last = tour >= TOUR.length; return (
                        <div className="cvm-coach" style={{ left: coach.left, top: coach.top }} role="dialog" aria-label={step.title}>
                            {!coach.right && <span className="cvm-coach-arrow" style={{ left: coach.arrow }} />}
                            <div className="cvm-coach-step">{tour} of {TOUR.length}</div>
                            <h4>{step.title}</h4>
                            <p>{step.body}</p>
                            <div className="cvm-coach-actions">
                                <button className="cvm-coach-skip" onClick={endTour}>Skip</button>
                                <button className="pt-mini pt-primary" onClick={() => (last ? endTour() : setTour((t) => t + 1))}>{last ? "Done" : "Next"}</button>
                            </div>
                        </div>
                    ); })()}
                </>
            )}
            {getApp && (
                <div className="pt-confirm cvm-getapp" onMouseDown={(e) => { if (e.target === e.currentTarget) setGetApp(false); }}>
                    <div className="pt-confirm-card cvm-getapp-card" role="dialog" aria-label="Get IcedCoffee for Mac">
                        <div className="cvm-getapp-mark"><IcedCoffeeGlyph className="cvm-brand-glyph" /></div>
                        <h3>IcedCoffee for Mac</h3>
                        <p className="cvm-getapp-free">Free · open source</p>
                        <p className="cvm-getapp-body">Everything here, plus what the browser leaves out: your own AI editing the page as you ask (Claude, ChatGPT — no API key), your résumé as a real file you open and save, a cover letter that shares your header, and updates that arrive on their own.</p>
                        <div className="cvm-getapp-actions">
                            <button className="pt-mini" onClick={() => setGetApp(false)}>Not now</button>
                            <button className="pt-mini pt-primary" onClick={() => { setGetApp(false); if (files?.openExternal) files.openExternal(BRAND_HOME); else window.open(BRAND_HOME, "_blank", "noopener"); }}><Download />Download for Mac</button>
                        </div>
                    </div>
                </div>
            )}
            {confirm && (
                <div id="pt-confirm" role="alertdialog" aria-modal="true">
                    <div className="pt-confirm-card"><p style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{confirm.msg}</p>
                        <div className="pt-ctx-actions"><button className="pt-mini" onClick={() => setConfirm(null)}>Cancel</button><button className="pt-mini pt-danger" onClick={() => { const run = confirm.run; setConfirm(null); run(); }}>{confirm.ok}</button></div>
                    </div>
                </div>
            )}
            {isWebBuild && !ctaHidden && (
                <div className="cvm-ask-wrap">
                    <div className="cvm-getapp-cta">
                        <button type="button" className="cvm-getapp-cta-main" onClick={() => setGetApp(true)}>
                            <Bot /><b>Edit by asking your AI</b><span>Claude, ChatGPT and others drive IcedCoffee — in the free Mac app</span>
                        </button>
                        <button type="button" className="cvm-getapp-x" aria-label="Dismiss" data-tip="Dismiss" onClick={() => { setCtaHidden(true); store("cvm:cta", "hidden"); }}><X /></button>
                    </div>
                </div>
            )}
            {(assistant || remote) && (
                <div className="cvm-ask-wrap">
                    {aiReply && (
                        <div className="cvm-ask-reply" role="status">
                            <p>{aiReply.message}</p>
                            <div className="cvm-ask-actions">
                                {aiReply.note && <span className="cvm-hint">{aiReply.note}</span>}
                                {aiReply.undo && <button className="pt-rbtn cvm-ask-btn" onClick={undoAssistant}><Undo2 />Undo</button>}
                                <button className="pt-rbtn cvm-ask-btn" onClick={() => setAiReply(null)}><Check />{aiReply.undo ? "Keep" : "OK"}</button>
                            </div>
                        </div>
                    )}
                    {!aiReply && askFocus && !ask && aiStatus?.ready && !aiBusy && (
                        <div className="cvm-ask-chips">
                            {["Tighten the wording so it fits on one page", "Tailor this résumé to the job description I paste below:\n\n", "Fix typos and make every bullet start with a strong verb"].map((c) => (
                                <button key={c} className="cvm-ask-chip" onMouseDown={(e) => { e.preventDefault(); setAsk(c); askRef.current?.focus(); }}>{c.split(":")[0].replace(" I paste below", "…")}</button>
                            ))}
                        </div>
                    )}
{aiStatus?.ready ? (
                    <form className={"cvm-ask" + (aiBusy ? " cvm-ask-busy" : "")} onSubmit={(e) => { e.preventDefault(); runAssistant(ask); }}>
                            <button type="button" className="pt-rbtn" aria-label="AI settings" data-tip={aiStatus?.ready ? `Your AI: ${aiStatus.label} · change…` : "Connect your AI"} onClick={openConnect}>{aiStatus?.ready ? <Bot /> : <Settings2 />}</button>
                            <textarea ref={askRef} rows={1} value={aiBusy || ask} readOnly={!!aiBusy} aria-label="Ask your AI to change this résumé"
                                placeholder={aiStatus?.ready ? "Ask your AI to change this résumé…  ⌘K" : "Connect your own AI to edit by asking — your key stays on this computer"}
                                onFocus={() => { setAskFocus(true); if (aiStatus && !aiStatus.ready) { askRef.current?.blur(); openConnect(); } }} onBlur={() => setAskFocus(false)}
                                onChange={(e) => setAsk(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAssistant(ask); } if (e.key === "Escape") askRef.current?.blur(); }} />
                            <button type="submit" className="pt-rbtn cvm-ask-send" aria-label="Send" disabled={!!aiBusy || !ask.trim()}><SendHorizontal /></button>
                        </form>
                    ) : (
                        pillHidden ? null : (
                            <div className={"cvm-ask-connect" + (remoteStatus?.live ? " cvm-live" : "")}>
                                {remoteStatus && (remoteStatus.live > 0 || remoteStatus.apps.length > 0) ? (
                                    <button type="button" className="cvm-ask-connect-main" onClick={openConnect} data-tip="Connections…">
                                        <i className="cvm-dot" /><b>{remoteStatus.live > 0 ? `${remoteStatus.apps[0] || "Your AI app"} is connected right now` : `${remoteStatus.apps.join(" and ")} connected`}</b>
                                        <span>{remoteStatus.live > 0 ? "changes it makes appear here, with Undo" : "ask it to change this résumé"}</span>
                                    </button>
                                ) : (
                                    <button type="button" className="cvm-ask-connect-main" onClick={openConnect}><Bot /><b>Connect your AI</b><span>Claude Desktop, ChatGPT and others · no API key needed</span></button>
                                )}
                                <button type="button" className="cvm-ask-connect-x" aria-label="Hide this" data-tip="Hide this — it stays under the AI menu" onClick={hidePill}><X /></button>
                            </div>
                        )
                    )}
                </div>
            )}
            <input ref={fileRef} type="file" accept=".html,.htm,text/html" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadSourceText(await f.text(), f.name.replace(/\.html?$/i, "")); }} />
            <input ref={imgFileRef} type="file" accept="image/*" hidden onChange={onImgFile} />
        </div>
    );
}
