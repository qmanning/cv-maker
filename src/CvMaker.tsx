// src/components/labs/itera/CvMaker.tsx
// Itera: a sheet of paper on an Infospector-style canvas. The résumé is a source HTML file
// (public/itera/templates/…) whose [data-cv-edit] regions each become a TipTap editor mounted
// directly ON the template's own element — so what you edit is exactly what gets exported.

"use client";

import "./cv-maker.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { TextAlign } from "@tiptap/extension-text-align";
import {
    AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowUp, Bold, BookOpen, BriefcaseBusiness, Plus, Text, ChevronDown, Columns2, Copy, Download,
    Ellipsis, Eraser, FileCode2, FileImage, FileText, FileType2, ImageUp, Italic, Link2, List, Minus, Moon, RotateCcw,
    Save, SpellCheck, Sun, Upload, Trash2, Underline as UnderlineIcon, ALargeSmall, MoveVertical, MoveHorizontal,
    Sparkles, SendHorizontal, Undo2, Check, Settings2, X,
} from "lucide-react";
import { FontSize } from "@/components/ui/font-size-extension";
import { FontWeight } from "@/components/ui/font-weight-extension";
import { BlockLineHeight, ColumnBreak, LetterSpacing } from "./cv-extensions";
import { BLOCK_KINDS, UNIT, insertBlock, topBlocks, type BlockKind } from "./cv-blocks";
import { attachColorPicker, toHex, useInfospectorLook } from "./use-infospector-look";
import { LookMenu } from "./LookMenu";
import { applyOps, describeDocument, type CvAssistant, type CvRemote, type CvRemoteHandlers, type CvRemoteStatus } from "./cv-assistant";
import { FOOTER_PT, GAP_PT, MIN_FIT, PAPERS, PT, type PaperId, type Source, fullHtml, pageBoxCss, parseSource, slugify, stepZoom } from "./cv-source";

const LOCAL_KEY = "cvm:doc", START_SIZE_KEY = "cvm:startsize", HOME_KEY = "cvm:home";
const stored = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const store = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } };
const ZOOMS = [1, 1.25, 1.5, 2];

// zoom: a fixed number, or a LIVE fit that tracks the window — "width" (the sheet fills the canvas width; null is the
// legacy spelling) or "height" (one sheet fills the canvas height; "browser" is its legacy spelling)
interface Settings { paper: PaperId; paginate: boolean; spellcheck: boolean; zoom: number | "width" | "height" | "browser" | null; fit: boolean }
interface SavedDoc extends Source { name: string; settings: Settings; savedAt: string; unsaved?: boolean }

/** A desktop shell's file system, when there is one: the document is then a real Source HTML file on disk.
 *  Without it (every web build) the document lives in this browser — autosave + Import / Export → Source HTML. */
export interface CvFiles {
    /** the file that is open right now, read fresh from disk — null when there is none */
    current(): Promise<{ text: string; name: string } | null>;
    /** write the Source HTML to the open file; asks where when there is none, or when `as` is set.
     *  Resolves to the file's name, or null if the person cancelled. */
    save(html: string, opts: { as?: boolean; suggested: string }): Promise<string | null>;
    /** show the shell's Open dialog — the chosen file arrives through onOpen */
    open(): void;
    /** the shell hands over a document: File → Open, a recent or dropped file, a reload after it changed on disk */
    onOpen(handler: (doc: { text: string; name: string; note?: string }) => void): () => void;
    /** the shell's own File menu asks for a save (its ⌘S / ⇧⌘S never reach the page as key presses) */
    onCommand(handler: (command: "save" | "saveAs") => void): () => void;
    /** unsaved edits? — the shell's title bar and close guard */
    setDirty(dirty: boolean): void;
}
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
async function rasterize(html: string, widthPt: number, heightPt: number, libUrl: string): Promise<Blob> {
    type Lib = { toBlob: (node: HTMLElement, opts: Record<string, unknown>) => Promise<Blob | null> };
    const w = window as unknown as { htmlToImage?: Lib };
    if (!w.htmlToImage) await new Promise<void>((res, rej) => { const sc = document.createElement("script"); sc.src = libUrl; sc.onload = () => res(); sc.onerror = () => rej(new Error("PNG export needs html-to-image.js (or an export server)")); document.head.appendChild(sc); });
    const frame = document.createElement("iframe"), wPx = Math.round(widthPt * PT), hPx = Math.round(heightPt * PT);
    frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${wPx}px;height:${hPx}px;border:0;visibility:hidden`;
    frame.srcdoc = html;
    await new Promise<void>((res) => { frame.onload = () => res(); document.body.appendChild(frame); });
    try {
        const doc = frame.contentDocument!; await doc.fonts?.ready;
        const blob = await w.htmlToImage!.toBlob(doc.documentElement, { pixelRatio: 2, width: wPx, height: Math.max(hPx, doc.documentElement.scrollHeight), backgroundColor: "#ffffff" });
        if (!blob) throw new Error("PNG export failed");
        return blob;
    } finally { frame.remove(); }
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
// site and as the standalone drop-in (github.com/qmanning/itera), configured only by these props.
export interface CvMakerProps {
    /** the source HTML the editor starts from (Start-up → Page in the menu overrides it per browser) */
    templateUrl: string;
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

export default function CvMaker({ templateUrl, exportUrl, backHref, glassCssUrl = "/labs/infospector/host.css", rasterizerUrl = "/labs/infospector/vendor/html-to-image.js", files, assistant, remote }: CvMakerProps) {
    const look = useInfospectorLook(glassCssUrl);
    const [source, setSource] = useState<Source | null>(null);
    const [name, setName] = useState("Résumé");
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [pages, setPages] = useState(1);
    const [scale, setScale] = useState(1);
    const [contentPt, setContentPt] = useState(0);
    const [active, setActive] = useState<Editor | null>(null);
    const [, setTick] = useState(0);
    const [dirty, setDirty] = useState(false);
    const [menu, setMenu] = useState<{ id: "size" | "export" | "more"; left?: number; right?: number; top: number } | null>(null);
    const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
    const [imgPop, setImgPop] = useState<{ img: HTMLImageElement; left: number; top: number } | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [confirm, setConfirm] = useState<{ msg: string; ok: string; run: () => void } | null>(null);
    const [toast, setToast] = useState("");
    const [busy, setBusy] = useState("");
    const [fits, setFits] = useState({ width: 1.25, height: 0.7 });
    const [startSize, setStartSize] = useState(() => stored(START_SIZE_KEY) || "last");   // "last" | a paper id
    const [home, setHome] = useState(() => stored(HOME_KEY));                          // start-up source file; "" = the bundled one

    const wrapRef = useRef<HTMLElement>(null), hostRef = useRef<HTMLDivElement>(null), paperRef = useRef<HTMLDivElement>(null);
    const editorsRef = useRef<Editor[]>([]), tipRef = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null), imgFileRef = useRef<HTMLInputElement>(null);
    const stateRef = useRef({ name, settings, source, scale, pages }); stateRef.current = { name, settings, source, scale, pages };
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

    /* ---- local autosave ---- */
    const touch = useCallback(() => {
        setDirty(true); schedule();
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            const { name: n, settings: s, source: src } = stateRef.current; if (!src) return;
            const doc: SavedDoc = { name: n, css: src.css, html: serialize(), settings: s, savedAt: new Date().toISOString(), unsaved: true };
            try { localStorage.setItem(LOCAL_KEY, JSON.stringify(doc)); } catch { /* ignore */ }
        }, 600);
    }, [schedule, serialize]);

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
                setName(parsed.name || onDisk.name); setSettings({ ...DEFAULT_SETTINGS, ...(local?.settings || {}), ...paperPatch }); setSource({ css: parsed.css, html: parsed.html }); return;
            }
            if (files && local?.html && local.unsaved) { setDirty(true); say("Restored edits that were never saved to a file"); }
            if (local?.html) { setName(local.name || "Résumé"); setSettings({ ...DEFAULT_SETTINGS, ...(local.settings || {}), ...paperPatch }); setSource({ css: local.css, html: local.html }); return; }
            setSettings((st) => ({ ...st, ...paperPatch }));
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

    const zoomBy = useCallback((dir: 1 | -1 | 0) => {
        if (dir === 0) { patch({ zoom: "width" }); return say("Fit width"); }
        const next = stepZoom(zoomRef.current, dir); patch({ zoom: next }); say(`${Math.round(next * 100)}%`);
    }, [patch, say]);

    /* ---- save (⌘S) ---- */
    const save = useCallback(async (as = false) => {
        const { name: n, settings: s, source: src } = stateRef.current; if (!src) return;
        const doc = { name: n, css: src.css, html: serialize(), settings: s };
        if (files) {
            // a real file: the Source HTML goes to disk; this browser keeps a copy only as a safety net
            try {
                const file = await files.save(fullHtml(n, src.css, doc.html), { as, suggested: slugify(n) + ".html" });
                if (!file) return;
                clearTimeout(saveTimer.current);
                try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...doc, savedAt: new Date().toISOString(), unsaved: false })); } catch { /* ignore */ }
                setDirty(false); say(`Saved — ${file}`);
            } catch (e) { say(e instanceof Error ? e.message : "Could not save the file"); }
            return;
        }
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...doc, savedAt: new Date().toISOString() })); setDirty(false); say("Saved in this browser · Export → Source HTML for a portable copy"); }
        catch { say("Could not save in this browser — export the Source HTML instead"); }
    }, [serialize, say, files]);
    useEffect(() => { files?.setDirty(dirty); }, [files, dirty]);
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
    useEffect(() => files?.onCommand((command) => save(command === "saveAs")), [files, save]);

    /* ---- export ---- */
    const exportHtml = useCallback(() => {
        const { settings: s, source: src, name: n, scale: sc } = stateRef.current, p = PAPERS[s.paper];
        let body = serialize({ breaks: s.paginate }), heightPt: number = p.h;
        const paged = s.paginate && pages > 1;
        if (s.paginate) {
            const nos = !paged ? "" : Array.from({ length: pages }, (_, i) => `<div class="cvm-pageno" style="top: ${(i + 1) * p.h - 19}pt; zoom: ${(1 / sc).toFixed(4)}">${i + 1}</div>`).join("");
            body = body.replace(/<\/div>\s*$/, nos + "</div>");
        } else heightPt = Math.max(p.h, Math.ceil(contentPt) + 1);
        const css = `@page { size: ${p.w}pt ${heightPt}pt; margin: 0; }\nhtml, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n${pageBoxCss(p.w, sc)}\n${paged ? `.cv-page { min-height: ${((pages * p.h - 1) / sc).toFixed(2)}pt; }` : ""}`;
        return { html: fullHtml(n, src?.css || "", body, css), widthPt: p.w, heightPt };
    }, [serialize, pages, contentPt]);

    const printFallback = useCallback((html: string) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
        frame.srcdoc = html; frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60000); };
        document.body.appendChild(frame);
    }, []);

    const runExport = useCallback(async (kind: "pdf" | "png" | "docx" | "html") => {
        setMenu(null); paginate();
        const file = slugify(stateRef.current.name), began = Date.now();
        try {
            setBusy(kind.toUpperCase());
            if (kind === "html") return download(new Blob([fullHtml(stateRef.current.name, stateRef.current.source?.css || "", serialize())], { type: "text/html" }), file + ".html");
            if (kind === "docx") {
                const { exportDocx } = await import("./export-docx");
                const page = hostRef.current!.querySelector<HTMLElement>(".cv-page")!, p = PAPERS[stateRef.current.settings.paper];
                return download(await exportDocx(page, { pageWPt: p.w, pageHPt: p.h, paginate: stateRef.current.settings.paginate, name: stateRef.current.name }), file + ".docx");
            }
            const payload = exportHtml();
            // headless Chrome when there's an export server; otherwise (none configured, unreachable, or it declines)
            // the browser does it itself: print dialog for PDF (still real text + links), html-to-image for PNG
            let r: Response | null = null;
            if (exportUrl) { try { r = await fetch(exportUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, format: kind, scale: 2 }) }); } catch { r = null; } }
            if (r?.ok) return download(await r.blob(), `${file}.${kind}`);
            if (r && ![404, 405, 501].includes(r.status)) throw new Error((await r.json().catch(() => ({}))).error || "Export failed");
            if (kind === "pdf") { say("Choose “Save as PDF” in the print dialog"); return printFallback(payload.html); }
            download(await rasterize(payload.html, payload.widthPt, payload.heightPt, rasterizerUrl), `${file}.png`);
        } catch (e) { say(e instanceof Error ? e.message : "Export failed"); }
        finally { window.setTimeout(() => setBusy(""), Math.max(0, 900 - (Date.now() - began))); }   // the scan stays up at least one sweep
    }, [exportHtml, exportUrl, paginate, printFallback, rasterizerUrl, say, serialize]);

    /* ---- source file: load / reset ---- */
    const loadSourceText = useCallback((text: string, fallbackName: string, opened?: { note?: string }) => {
        const parsed = parseSource(text);
        setName(parsed.name || fallbackName); setSource({ css: parsed.css, html: parsed.html }); setDirty(!opened);
        if (opened) {   // it IS the file on disk: nothing unsaved, and the safety-net copy must not outvote it on the next start
            clearTimeout(saveTimer.current);
            try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ name: parsed.name || fallbackName, css: parsed.css, html: parsed.html, settings: stateRef.current.settings, savedAt: new Date().toISOString(), unsaved: false })); } catch { /* ignore */ }
        }
        if (opened?.note) return say(opened.note);
        say(parsed.regions ? `Loaded — ${parsed.regions} editable regions` : "Loaded, but it has no [data-cv-edit] regions — nothing is editable");
    }, [say]);
    useEffect(() => files?.onOpen((doc) => loadSourceText(doc.text, doc.name.replace(/\.html?$/i, ""), { note: doc.note })), [files, loadSourceText]);
    const resetSource = useCallback(() => setConfirm({
        msg: "Replace the document with the original source file? Your edits to this document will be lost.", ok: "Replace",
        run: async () => loadSourceText(await fetchSource(templateUrl), "Résumé"),
    }), [loadSourceText, templateUrl]);

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
                const res = await assistant.run({ prompt: request, document: describeDocument(html, { name: n, paper: PAPERS[st.paper].name, pages: st.paginate ? pg : 1, fitScale: Math.round(sc * 100) / 100 }) });
                if (!round) message = res.message;
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
    }, [assistant, aiBusy, aiStatus, serialize, touch]);
    // every entry is a whole copy of the document, and a résumé with a photo embedded as a data URI can be megabytes —
    // so the history is bounded by SIZE as well as by count (the newest step always survives)
    const trimUndo = (stack: Source[]) => { let bytes = stack.reduce((n, e) => n + e.html.length + e.css.length, 0); while (stack.length > 1 && (stack.length > 30 || bytes > 24_000_000)) { const gone = stack.shift()!; bytes -= gone.html.length + gone.css.length; } };
    const remoteUndo = useRef<Source[]>([]);   // edits made from outside (see the remote handlers below)
    const undoAssistant = useCallback(() => { if (aiReply?.undo) { setSource(aiReply.undo); setDirty(true); touch(); say("Undone"); remoteUndo.current.pop(); } setAiReply(null); }, [aiReply, say, touch]);

    /* ---- an outside AI app drives the editor (the shell's MCP server): same operations, same one-step undo, no key anywhere ---- */
    const remoteRef = useRef<CvRemoteHandlers | null>(null);
    const describeNow = useCallback(() => {
        const { settings: st, name: n, scale: sc, pages: pg } = stateRef.current;
        return describeDocument(serialize(), { name: n, paper: PAPERS[st.paper].name, pages: st.paginate ? pg : 1, fitScale: Math.round(sc * 100) / 100 });
    }, [serialize]);
    remoteRef.current = {
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
        exportPayload: () => ({ ...exportHtml(), name: slugify(stateRef.current.name) }),
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
        describe: () => remoteRef.current!.describe(),
        apply: (ops, message, by) => remoteRef.current!.apply(ops, message, by),
        undo: () => remoteRef.current!.undo(),
        exportPayload: () => remoteRef.current!.exportPayload(),
    }), [remote]);

    /* ---- rows: move / duplicate / delete whichever block holds the caret (a job, the summary, a dual list…) ---- */
    // a block with no text (a divider) is picked by clicking it; otherwise the row is wherever the caret is
    const [picked, setPicked] = useState<HTMLElement | null>(null);
    const activeBlock = active ? (active.view.dom.closest(UNIT) as HTMLElement | null) : picked;
    useEffect(() => { if (!activeBlock) return; activeBlock.classList.add("cvm-hot"); return () => activeBlock.classList.remove("cvm-hot"); }, [activeBlock]);
    const blockOp = useCallback((op: "dup" | "up" | "down" | "del") => {
        const host = hostRef.current, src = stateRef.current.source; if (!host || !activeBlock || !src) return;
        const idx = Array.from(host.querySelectorAll(UNIT)).indexOf(activeBlock);
        const tmp = document.createElement("div"); tmp.innerHTML = serialize();
        const el = tmp.querySelectorAll(UNIT)[idx]; if (!el) return;
        const row = (n: Element | null) => (n && n.matches(UNIT) ? n : null);
        if (op === "dup") el.after(el.cloneNode(true));
        if (op === "del") el.remove();
        if (op === "up") { const prev = row(el.previousElementSibling); if (!prev) return; prev.before(el); }
        if (op === "down") { const next = row(el.nextElementSibling); if (!next) return; next.after(el); }
        setSource({ css: src.css, html: tmp.innerHTML }); setDirty(true);
    }, [activeBlock, serialize]);

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
        const img = (e.target as HTMLElement).closest("img");
        if (img && hostRef.current?.contains(img)) { const r = img.getBoundingClientRect(); setImgPop({ img, left: r.left, top: r.bottom + 8 }); }
        const rule = (e.target as HTMLElement).closest<HTMLElement>(".cv-divider");
        if (rule && hostRef.current?.contains(rule)) { (document.activeElement as HTMLElement | null)?.blur?.(); setActive(null); setPicked(rule); }
    }, []);
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

    const openMenu = (id: "size" | "export" | "more", e: React.MouseEvent, align: "left" | "right") => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu((m) => (m?.id === id ? null : { id, top: r.bottom + 8, ...(align === "left" ? { left: r.left } : { right: window.innerWidth - r.right }) }));
    };

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
        <div className="cvm-root" data-ready={look.ready}>
            {source && <style>{`${source.css}\n${pageBoxCss(paper.w, scale)}`}</style>}

            {/* main bar — Infospector's #pt-bar */}
            <div id="pt-bar" className="cvm-bar">
                {backHref && <button className="pt-rbtn" aria-label="Back" data-tip="Back" onClick={() => { window.location.href = backHref; }}><ArrowLeft /></button>}
                <div className="pt-dim">
                    <div className="pt-dim-trigger">
                        <button className="pt-dim-val" aria-haspopup="true" data-tip="Paper size and zoom" onClick={(e) => openMenu("size", e, "left")}>{paper.label}<span className="pt-dim-scale" style={{ color: "var(--pt-text-faint)" }}>· {Math.round(zoom * 100)}%</span></button>
                        <button className="pt-chev" aria-label="Choose a size" onClick={(e) => openMenu("size", e, "left")}>▾</button>
                    </div>
                </div>
                <div className="pt-omni">
                    <span className="pt-omni-icon"><FileText /></span>
                    <input type="text" value={name} spellCheck={false} aria-label="Document name" placeholder="Document name" onChange={(e) => { setName(e.target.value); setDirty(true); }} />
                    <button className="pt-omni-clear cvm-import" aria-label={files ? "Open a résumé file" : "Import a source HTML file"} data-tip={files ? "Open a résumé file · ⌘O" : "Import a source HTML file"} onClick={() => (files ? files.open() : fileRef.current?.click())}><Upload /></button>
                </div>
                <button className="pt-rbtn" {...pill(settings.paginate)} aria-label="Pagination" data-tip={settings.paginate ? "Pagination on · pages + page numbers" : "Pagination off · one continuous page"} onClick={() => patch({ paginate: !settings.paginate })}><BookOpen /></button>
                <button className="pt-rbtn cvm-secondary" {...pill(settings.spellcheck)} aria-label="Spellcheck" data-tip={settings.spellcheck ? "Spellcheck on" : "Spellcheck off"} onClick={() => patch({ spellcheck: !settings.spellcheck })}><SpellCheck /></button>
                <button className="pt-rbtn cvm-secondary" aria-label="Toggle theme" data-tip={look.theme === "light" ? "Switch to dark mode" : "Switch to light mode"} onClick={() => look.setTheme(look.theme === "light" ? "dark" : "light")}>{look.theme === "light" ? <Sun /> : <Moon />}</button>
                <button className="pt-rbtn pt-badge-btn" aria-label="Save" data-tip={files ? "Save · ⌘S   Save As · ⇧⌘S" : "Save in this browser · ⌘S"} onClick={() => save()}><Save />{dirty && <span className="cvm-dirty" />}</button>
                <button className="pt-rbtn pt-badge-btn" aria-haspopup="true" data-tip="Export" onClick={(e) => openMenu("export", e, "right")}><Download /><span className="cvm-label">{busy ? `${busy}…` : "Export"}</span><ChevronDown style={{ width: 13, height: 13 }} /></button>
                <button className="pt-rbtn" aria-label="More" aria-haspopup="true" data-tip="Source file · more" onClick={(e) => openMenu("more", e, "right")}><Ellipsis /></button>
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
                    <button className="pt-menu-item cvm-row" onClick={() => runExport("pdf")}><FileType2 />PDF<span className="cvm-hint">real text · links</span></button>
                    <button className="pt-menu-item cvm-row" onClick={() => runExport("docx")}><FileText />Word (DOCX)<span className="cvm-hint">ATS-friendly</span></button>
                    <button className="pt-menu-item cvm-row" onClick={() => runExport("png")}><FileImage />PNG<span className="cvm-hint">2×</span></button>
                    <div className="pt-menu-div" />
                    <button className="pt-menu-item cvm-row" onClick={() => runExport("html")}><FileCode2 />Source HTML<span className="cvm-hint">re-loadable</span></button>
                </div>
            )}
            {menu?.id === "more" && (
                <div className="pt-menu-pop pt-open" role="menu" style={{ right: menu.right, top: menu.top, minWidth: 230 }}>
                    <div className="pt-ctx-title">Source file</div>
                    <button className="pt-menu-item cvm-row" onClick={() => { setMenu(null); runExport("html"); }}><Download />Download source HTML</button>
                    <button className="pt-menu-item cvm-row pt-danger" onClick={() => { setMenu(null); resetSource(); }}><RotateCcw />Reset to original source</button>
                    <div className="pt-menu-div" />
                    {/* on narrow windows these two leave the bar (so nothing is ever pushed off-screen) and live here */}
                    <button className="pt-menu-item cvm-row cvm-narrow-only" onClick={() => patch({ spellcheck: !settings.spellcheck })}><SpellCheck />Spellcheck<span className="cvm-hint">{settings.spellcheck ? "on" : "off"}</span></button>
                    <button className="pt-menu-item cvm-row cvm-narrow-only" onClick={() => look.setTheme(look.theme === "light" ? "dark" : "light")}>{look.theme === "light" ? <Sun /> : <Moon />}Theme<span className="cvm-hint">{look.theme}</span></button>
                    <button className="pt-menu-item cvm-row" onClick={(e) => { setMenu(null); setCtx({ x: e.clientX - 240, y: e.clientY }); }}><Sun />Background · colors · appearance…</button>
                    <div className="pt-menu-div" />
                    {/* credit: the tool says who made it and where it lives — never the exported résumé, which is the user's */}
                    <a className="pt-menu-item cvm-row cvm-credit" href="https://qmanning.com/labs/itera" target="_blank" rel="noopener" onClick={() => setMenu(null)}>
                        <span>Itera <span className="cvm-hint" style={{ marginLeft: 4 }}>by Q Manning</span></span><span className="cvm-hint">qmanning.com ↗</span>
                    </a>
                </div>
            )}
            {activeBlock && blockRect && paperRect && (
                <div className="pt-menu-pop pt-open cvm-blocktools" style={{ left: Math.max(8, paperRect.left - 52), top: Math.max(124, Math.min(window.innerHeight - 170, blockRect.top)) }} onMouseDown={keep}>
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
            {imgPop && (
                <div className="pt-menu-pop pt-open cvm-imgpop" style={{ left: imgPop.left, top: imgPop.top }}>
                    <button className="pt-menu-item cvm-row" onClick={() => imgFileRef.current?.click()}><ImageUp />Change image…</button>
                </div>
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
                    <div className="cvm-host" ref={hostRef} onClick={onHostClick} />
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
            {confirm && (
                <div id="pt-confirm" role="alertdialog" aria-modal="true">
                    <div className="pt-confirm-card"><p>{confirm.msg}</p>
                        <div className="pt-ctx-actions"><button className="pt-mini" onClick={() => setConfirm(null)}>Cancel</button><button className="pt-mini pt-danger" onClick={() => { const run = confirm.run; setConfirm(null); run(); }}>{confirm.ok}</button></div>
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
                            <button type="button" className="pt-rbtn" aria-label="AI settings" data-tip={aiStatus?.ready ? `Your AI: ${aiStatus.label} · change…` : "Connect your AI"} onClick={openConnect}>{aiStatus?.ready ? <Sparkles /> : <Settings2 />}</button>
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
                                    <button type="button" className="cvm-ask-connect-main" onClick={openConnect}><Sparkles /><b>Connect your AI</b><span>Claude Desktop, ChatGPT and others · no API key needed</span></button>
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
