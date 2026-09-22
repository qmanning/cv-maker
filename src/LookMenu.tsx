// src/components/labs/icedcoffee/LookMenu.tsx
// The right-click menu — Infospector's #pt-ctx and its "Material & Light" flyout (#pt-ap-pop): same
// markup, classes and order (styled by its host.css), same glass color picker on every swatch,
// driven by the shared look state. If Infospector's index.html changes this menu, mirror it here.

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Grip, Grid3x3, Slash, Ban, RotateCcw, X, ChevronRight } from "lucide-react";
import { attachColorPicker, closeColorPicker, formatColor, parseColor, toHex, type ColorFmt, type Pattern, type useInfospectorLook } from "./use-infospector-look";

type Look = ReturnType<typeof useInfospectorLook>;
export interface Startup { size: string; page: string; sizes: { value: string; label: string }[]; defaultPage: string; setSize: (v: string) => void; setPage: (v: string) => void; snippet: () => string }

const PATTERNS: { id: Pattern; label: string; icon: React.ReactNode }[] = [
    { id: "dots", label: "Dots", icon: <Grip /> },
    { id: "grid", label: "Grid", icon: <Grid3x3 /> },
    { id: "lines", label: "Diagonal lines", icon: <Slash /> },
    { id: "none", label: "None", icon: <Ban /> },
];

// a swatch + free-text value; the swatch opens Infospector's glass picker instead of the OS dialog
export function ColorRow({ label, value, fmt, tip, alpha = true, onPick }: { label: string; value: string; fmt: ColorFmt; tip?: string; alpha?: boolean; onPick: (css: string) => void }) {
    const [text, setText] = useState(""), [bad, setBad] = useState(false), editing = useRef(false);
    const swatch = useRef<HTMLInputElement>(null), live = useRef({ value, onPick }); live.current = { value, onPick };
    useEffect(() => { if (!editing.current) { setText(formatColor(value, fmt)); setBad(false); } }, [value, fmt]);
    useEffect(() => { if (swatch.current) attachColorPicker(swatch.current, { alpha, read: () => live.current.value, write: (v) => live.current.onPick(v) }); }, [alpha]);
    return (
        <label className="pt-ctx-color" data-tip={tip}>
            <span>{label}</span>
            <input ref={swatch} type="color" value={toHex(value)} aria-label={`${label} color`} onChange={(e) => onPick(e.target.value)} />
            <input type="text" spellCheck={false} placeholder="#hex · hsl() · hsb()" aria-label={`${label} color value`} className={bad ? "pt-invalid" : undefined} value={text}
                onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; setText(formatColor(value, fmt)); setBad(false); }}
                onChange={(e) => { setText(e.target.value); const c = parseColor(e.target.value); setBad(!c); if (c) onPick(c); }} />
        </label>
    );
}

function Range({ label, tip, min, max, step, value, unit, onChange }: { label: string; tip?: string; min: number; max: number; step: number; value: number; unit: string; onChange: (v: number) => void }) {
    const fill = (Math.max(0, Math.min(1, (value - min) / (max - min))) * 100).toFixed(1) + "%";
    return (
        <label className="pt-ctx-range" data-tip={tip}>
            <span>{label}</span>
            <input type="range" min={min} max={max} step={step} value={value} style={{ ["--fill" as string]: fill }} onChange={(e) => onChange(Number(e.target.value))} />
            <output>{(Number.isInteger(value) ? value : value.toFixed(1)) + unit}</output>
        </label>
    );
}

export function LookMenu({ look, at, startup, say, onClose }: { look: Look; at: { x: number; y: number }; startup: Startup; say: (msg: string) => void; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null), apRef = useRef<HTMLDivElement>(null), subRef = useRef<HTMLButtonElement>(null);
    const [pos, setPos] = useState(at), [apOpen, setApOpen] = useState(false), [apPos, setApPos] = useState({ left: 0, top: 0 });
    const [page, setPage] = useState(startup.page);
    const { bg, setBg, setGlass, fmt, setFmt, effective: fx, theme } = look;
    const hasFx = !!fx;
    const close = () => { closeColorPicker(); onClose(); };
    const closeRef = useRef(close); closeRef.current = close;

    useLayoutEffect(() => {
        const el = ref.current; if (!el) return;
        setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - el.offsetWidth - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - el.offsetHeight - 8)) });
    }, [at, hasFx]);
    // the flyout lands on whichever side of the panel has room, lined up with its trigger, never off-screen (host.js placeApPop)
    useLayoutEffect(() => {
        const pop = apRef.current, ctx = ref.current, sub = subRef.current; if (!apOpen || !pop || !ctx || !sub) return;
        const c = ctx.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 6, m = 8;
        const roomRight = window.innerWidth - c.right - gap - m, roomLeft = c.left - gap - m;
        let left = pw <= roomRight ? c.right + gap : pw <= roomLeft ? c.left - gap - pw : roomRight >= roomLeft ? window.innerWidth - pw - m : m;
        left = Math.max(m, Math.min(left, window.innerWidth - pw - m));
        const top = Math.max(m, Math.min(Math.min(sub.getBoundingClientRect().top, c.top), window.innerHeight - ph - m));
        setApPos({ left, top });
    }, [apOpen, pos]);
    useEffect(() => {
        const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("#pt-ctx, .pt-ap-pop, .pt-cpick")) closeRef.current(); };
        const key = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
        document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
        return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
    }, []);

    const copyConfig = async () => {
        const text = [startup.snippet(), look.configSnippet()].filter(Boolean).join("\n");
        try { await navigator.clipboard.writeText(text); say("Config copied"); } catch { say("Could not copy"); }
        close();
    };

    if (!fx) return null;
    const idx = Math.max(0, PATTERNS.findIndex((p) => p.id === bg.pattern));
    return (
        <>
            <div id="pt-ctx" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
                <button type="button" id="pt-ctx-close" aria-label="Close" data-tip="Close" onClick={close}><X /></button>
                <div className="pt-ctx-title">Background</div>
                <div className="pt-seg" role="radiogroup" aria-label="Background pattern" style={{ ["--i" as string]: idx }}>
                    <span className="pt-seg-ind" />
                    {PATTERNS.map((p) => (
                        <button key={p.id} type="button" role="radio" aria-checked={bg.pattern === p.id} aria-label={p.label} data-tip={p.label} onClick={() => setBg({ pattern: p.id })}>{p.icon}</button>
                    ))}
                </div>
                <Range label="Opacity" min={0} max={100} step={5} value={bg.opacity} unit="%" onChange={(v) => setBg({ opacity: v })} />
                <div className="pt-menu-div" />
                <div className="pt-ctx-title pt-ctx-title-row"><span>Colors</span>
                    <select className="pt-fmt" aria-label="Color format" data-tip="How colors are written in the fields" value={fmt} onChange={(e) => setFmt(e.target.value as ColorFmt)}>
                        <option value="hex">HEX</option><option value="rgb">RGB</option><option value="hsl">HSL</option><option value="hsb">HSB</option>
                    </select>
                </div>
                <ColorRow label="Pattern" value={fx.pattern} fmt={fmt} onPick={(c) => setBg({ patternColor: c, patternTheme: theme })} />
                <ColorRow label="Background" value={fx.ground} fmt={fmt} onPick={(c) => setBg({ groundColor: c, groundTheme: theme })} />
                <ColorRow label="Accent" value={fx.accent} fmt={fmt} alpha={false} tip="Highlights: focus rings, selection, buttons" onPick={(c) => setBg({ accent: toHex(c) })} />
                <div className="pt-menu-div" />
                <div className="pt-ctx-title">Start-up</div>
                <label className="pt-ctx-color" data-tip="The paper IcedCoffee opens with">
                    <span>Size</span>
                    <select className="pt-fmt pt-start-select" aria-label="Start-up size" value={startup.size} onChange={(e) => { startup.setSize(e.target.value); say("Start-up size saved"); }}>
                        {startup.sizes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </label>
                <label className="pt-ctx-color" data-tip="The source HTML file IcedCoffee starts from (a path on this site, or a full URL)">
                    <span>Page</span>
                    <input type="text" spellCheck={false} placeholder={startup.defaultPage} aria-label="Start-up source file" value={page} onChange={(e) => setPage(e.target.value)}
                        onBlur={() => { const v = page.trim(); if (v !== startup.page) { startup.setPage(v); say(v ? "Start-up source saved" : "Start-up source cleared"); } }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                </label>
                <div className="pt-menu-div" />
                <button type="button" ref={subRef} className="pt-ctx-sub" aria-haspopup="menu" aria-expanded={apOpen} onClick={() => setApOpen((o) => !o)}>Material &amp; Light<span className="pt-ctx-sub-caret" aria-hidden="true"><ChevronRight style={{ width: 15, height: 15 }} /></span></button>
            </div>

            {apOpen && (
                <div ref={apRef} className="pt-menu-pop pt-ap-pop pt-open" role="menu" aria-label="Material & Light" style={apPos}>
                    <div className="pt-ctx-title">Material &amp; Light</div>
                    <Range label="Radius" tip="How round the glass panels are (the toolbar keeps its own shape)" min={0} max={60} step={1} value={fx.radius} unit="px" onChange={(v) => setGlass({ radius: v })} />
                    <Range label="Padding" tip="Padding inside the toolbar and menus — the inner corners stay concentric" min={0} max={20} step={1} value={fx.pad} unit="px" onChange={(v) => setGlass({ pad: v })} />
                    <Range label="Blur" min={0} max={100} step={1} value={fx.blur} unit="px" onChange={(v) => setGlass({ blur: v })} />
                    <Range label="Saturation" min={100} max={250} step={5} value={fx.sat} unit="%" onChange={(v) => setGlass({ sat: v })} />
                    <Range label="Highlight" min={0} max={2} step={0.1} value={fx.light} unit="×" onChange={(v) => setGlass({ light: v })} />
                    <Range label="Distance" tip="How far the glass's drop shadow spreads" min={0} max={3} step={0.1} value={fx.dark} unit="×" onChange={(v) => setGlass({ dark: v })} />
                    <Range label="Opacity" min={0} max={100} step={1} value={fx.tintPct} unit="%" onChange={(v) => setGlass({ tint: v })} />
                    <Range label="Backing" tip="A solid layer of the tint color under the glass — text flips dark/light to stay legible" min={0} max={100} step={5} value={fx.backing} unit="%" onChange={(v) => setGlass({ backing: v })} />
                    <Range label="Shine" tip="A light the angle points across the glass, from the lit side" min={0} max={100} step={1} value={fx.shine} unit="%" onChange={(v) => setGlass({ shine: v })} />
                    <Range label="Shadow" tip="A darkness on the far side of the glass, opposite the shine" min={0} max={100} step={1} value={fx.shade} unit="%" onChange={(v) => setGlass({ shade: v })} />
                    <Range label="Angle" tip="Where the light comes from. 0° is straight above." min={0} max={360} step={1} value={fx.lightAngle} unit="°" onChange={(v) => setGlass({ lightAngle: v })} />
                    <ColorRow label="Tint color" value={fx.tint} fmt={fmt} onPick={(c) => setGlass({ color: c, colorTheme: theme })} />
                    <div className="pt-ctx-actions">
                        <button className="pt-mini pt-icon-btn" aria-label="Reset to Default" data-tip="Reset to Default" onClick={() => { look.reset(); say("Reset to defaults"); }}><RotateCcw /></button>
                        <button className="pt-mini" data-tip="Copy a config snippet of this look and start-up" onClick={copyConfig}>Copy config</button>
                        <button className="pt-mini pt-primary" data-tip="Save this look as your defaults (this browser — shared with Infospector)" onClick={() => say(look.saveAsDefaults() ? "Saved as your defaults" : "Could not save")}>Save</button>
                    </div>
                </div>
            )}
        </>
    );
}
