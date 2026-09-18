// src/components/labs/cv-maker/CvMaker.tsx
// CV Maker: a sheet of paper on an Infospector-style canvas. The résumé is a source HTML file
// (public/cv-maker/templates/…) whose [data-cv-edit] regions each become a TipTap editor mounted
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
    AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowUp, Bold, BookOpen, ChevronDown, Columns2, Copy, Download,
    Ellipsis, Eraser, FileCode2, FileImage, FileText, FileType2, ImageUp, Italic, Link2, List, Minus, Moon, RotateCcw,
    Save, SpellCheck, Sun, Upload, Trash2, Underline as UnderlineIcon, ALargeSmall, MoveVertical, MoveHorizontal,
} from "lucide-react";
import { FontSize } from "@/components/ui/font-size-extension";
import { FontWeight } from "@/components/ui/font-weight-extension";
import { BlockLineHeight, ColumnBreak, LetterSpacing } from "./cv-extensions";
import { attachColorPicker, toHex, useInfospectorLook } from "./use-infospector-look";
import { LookMenu } from "./LookMenu";
import { FOOTER_PT, GAP_PT, MIN_FIT, PAPERS, PT, type PaperId, type Source, fullHtml, pageBoxCss, parseSource, slugify } from "./cv-source";

const LOCAL_KEY = "cvm:doc", START_SIZE_KEY = "cvm:startsize", HOME_KEY = "cvm:home";
const stored = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const store = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } };
const ZOOMS = [1, 1.25, 1.5, 2];

// zoom: a fixed number, or a LIVE fit that tracks the window — "width" (the sheet fills the canvas width; null is the
// legacy spelling) or "height" (one sheet fills the canvas height; "browser" is its legacy spelling)
interface Settings { paper: PaperId; paginate: boolean; spellcheck: boolean; zoom: number | "width" | "height" | "browser" | null; fit: boolean }
interface SavedDoc extends Source { name: string; settings: Settings; savedAt: string }
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

/* ---------------- component ---------------- */

// Framework-agnostic on purpose (no router, no server assumptions): the same component runs inside this
// site and as the standalone drop-in (github.com/qmanning/cv-maker), configured only by these props.
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
}

export default function CvMaker({ templateUrl, exportUrl, backHref, glassCssUrl = "/labs/infospector/host.css", rasterizerUrl = "/labs/infospector/vendor/html-to-image.js" }: CvMakerProps) {
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
    const stateRef = useRef({ name, settings, source, scale }); stateRef.current = { name, settings, source, scale };
    const rafRef = useRef(0), saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const paper = PAPERS[settings.paper];
    const zoomMode = typeof settings.zoom === "number" ? "fixed" : settings.zoom === "height" || settings.zoom === "browser" ? "height" : "width";
    const zoom = typeof settings.zoom === "number" ? settings.zoom : fits[zoomMode === "height" ? "height" : "width"];
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
            const doc: SavedDoc = { name: n, css: src.css, html: serialize(), settings: s, savedAt: new Date().toISOString() };
            try { localStorage.setItem(LOCAL_KEY, JSON.stringify(doc)); } catch { /* ignore */ }
        }, 600);
    }, [schedule, serialize]);

    /* ---- boot: what this browser last had, else the source file (nothing is stored server-side) ---- */
    useEffect(() => {
        let dead = false;
        (async () => {
            let local: SavedDoc | null = null; try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { /* ignore */ }
            const startPaper = stored(START_SIZE_KEY), paperPatch = startPaper in PAPERS ? { paper: startPaper as PaperId } : {};
            if (local?.html) { setName(local.name || "Résumé"); setSettings({ ...DEFAULT_SETTINGS, ...(local.settings || {}), ...paperPatch }); setSource({ css: local.css, html: local.html }); return; }
            setSettings((st) => ({ ...st, ...paperPatch }));
            const parsed = parseSource(await fetchSource(templateUrl));
            if (dead) return;
            setName(parsed.name || "Résumé"); setSource({ css: parsed.css, html: parsed.html });
        })().catch(() => say("Could not load the source file"));
        return () => { dead = true; };
    }, [say, templateUrl]);

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
                onFocus: ({ editor }) => { setActive(editor as Editor); setLinkOpen(false); },
                onTransaction: () => setTick((t) => t + 1),
                onUpdate: () => touch(),
            });
        });
        editorsRef.current = editors;
        setActive(null); schedule();
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

    /* ---- save (⌘S) ---- */
    const save = useCallback(async () => {
        const { name: n, settings: s, source: src } = stateRef.current; if (!src) return;
        const doc = { name: n, css: src.css, html: serialize(), settings: s };
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...doc, savedAt: new Date().toISOString() })); setDirty(false); say("Saved in this browser · Export → Source HTML for a portable copy"); }
        catch { say("Could not save in this browser — export the Source HTML instead"); }
    }, [serialize, say]);
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
            if (e.key === "Escape") { setMenu(null); setImgPop(null); setLinkOpen(false); }
        };
        window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
    }, [save]);

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
    const loadSourceText = useCallback((text: string, fallbackName: string) => {
        const parsed = parseSource(text);
        setName(parsed.name || fallbackName); setSource({ css: parsed.css, html: parsed.html }); setDirty(true);
        say(parsed.regions ? `Loaded — ${parsed.regions} editable regions` : "Loaded, but it has no [data-cv-edit] regions — nothing is editable");
    }, [say]);
    const resetSource = useCallback(() => setConfirm({
        msg: "Replace the document with the original source file? Your edits to this document will be lost.", ok: "Replace",
        run: async () => loadSourceText(await fetchSource(templateUrl), "Résumé"),
    }), [loadSourceText, templateUrl]);

    /* ---- repeatable blocks (jobs): duplicate / move / delete ---- */
    const activeBlock = active ? (active.view.dom.closest("[data-cv-repeat]") as HTMLElement | null) : null;
    useEffect(() => { if (!activeBlock) return; activeBlock.classList.add("cvm-hot"); return () => activeBlock.classList.remove("cvm-hot"); }, [activeBlock]);
    const blockOp = useCallback((op: "dup" | "up" | "down" | "del") => {
        const host = hostRef.current, src = stateRef.current.source; if (!host || !activeBlock || !src) return;
        const idx = Array.from(host.querySelectorAll("[data-cv-repeat]")).indexOf(activeBlock);
        const tmp = document.createElement("div"); tmp.innerHTML = serialize();
        const el = tmp.querySelectorAll("[data-cv-repeat]")[idx]; if (!el) return;
        const same = (n: Element | null) => (n && n.getAttribute("data-cv-repeat") === el.getAttribute("data-cv-repeat") ? n : null);
        if (op === "dup") el.after(el.cloneNode(true));
        if (op === "del") el.remove();
        if (op === "up") { const prev = same(el.previousElementSibling); if (!prev) return; prev.before(el); }
        if (op === "down") { const next = same(el.nextElementSibling); if (!next) return; next.after(el); }
        setSource({ css: src.css, html: tmp.innerHTML }); setDirty(true);
    }, [activeBlock, serialize]);

    /* ---- images: click any <img> in the document to swap it ---- */
    const onHostClick = useCallback((e: React.MouseEvent) => {
        const img = (e.target as HTMLElement).closest("img");
        if (img && hostRef.current?.contains(img)) { const r = img.getBoundingClientRect(); setImgPop({ img, left: r.left, top: r.bottom + 8 }); }
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
            if (!t.closest(".cvm-paper, .pt-menu-pop, #pt-bar, #pt-ctx, #pt-confirm, .pt-cpick")) { setActive(null); (document.activeElement as HTMLElement | null)?.blur?.(); }
        };
        document.addEventListener("mousedown", down); return () => document.removeEventListener("mousedown", down);
    }, []);
    const [, setLayoutTick] = useState(0);
    useEffect(() => {
        const wrap = wrapRef.current; if (!wrap) return;
        const bump = () => { setLayoutTick((t) => t + 1); setImgPop(null); };
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
                    <button className="pt-omni-clear cvm-import" aria-label="Import a source HTML file" data-tip="Import a source HTML file" onClick={() => fileRef.current?.click()}><Upload /></button>
                </div>
                <button className="pt-rbtn" {...pill(settings.paginate)} aria-label="Pagination" data-tip={settings.paginate ? "Pagination on · pages + page numbers" : "Pagination off · one continuous page"} onClick={() => patch({ paginate: !settings.paginate })}><BookOpen /></button>
                <button className="pt-rbtn cvm-secondary" {...pill(settings.spellcheck)} aria-label="Spellcheck" data-tip={settings.spellcheck ? "Spellcheck on" : "Spellcheck off"} onClick={() => patch({ spellcheck: !settings.spellcheck })}><SpellCheck /></button>
                <button className="pt-rbtn cvm-secondary" aria-label="Toggle theme" data-tip={look.theme === "light" ? "Switch to dark mode" : "Switch to light mode"} onClick={() => look.setTheme(look.theme === "light" ? "dark" : "light")}>{look.theme === "light" ? <Sun /> : <Moon />}</button>
                <button className="pt-rbtn pt-badge-btn" aria-label="Save" data-tip="Save in this browser · ⌘S" onClick={save}><Save />{dirty && <span className="cvm-dirty" />}</button>
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
                snippet: () => [home && `window.CV_MAKER_HOME = ${JSON.stringify(home)};`, startSize !== "last" && `window.CV_MAKER_START_SIZE = ${JSON.stringify(startSize)};`].filter(Boolean).join("\n"),
            }} />}

            {/* canvas — Infospector's #pt-stagewrap + background patterns */}
            <main id="pt-stagewrap" ref={wrapRef} className={`cvm-wrap pt-bg-${look.bg.pattern}`}
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
            <input ref={fileRef} type="file" accept=".html,.htm,text/html" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) loadSourceText(await f.text(), f.name.replace(/\.html?$/i, "")); }} />
            <input ref={imgFileRef} type="file" accept="image/*" hidden onChange={onImgFile} />
        </div>
    );
}
