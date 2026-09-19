// src/components/labs/cv-maker/use-infospector-look.ts
// CV Maker wears Infospector's UI: it loads Infospector's own host.css, uses its color helpers
// (lib.js) and reads/writes the same pt:* localStorage keys — so a look dialed in there (theme,
// background, accent, glass) is the look here, and vice versa. Only the wiring is re-done in React;
// it mirrors applyBg()/applyGlass() in public/labs/infospector/host.js.

import { useCallback, useEffect, useState } from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ES module shipped with Infospector
import * as lib from "../../../../public/labs/infospector/lib.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ES module shipped with Infospector
import { attachColorPicker as attach, closeColorPicker as closePicker } from "../../../../public/labs/infospector/colorpicker.js";

const THEME_KEY = "pt:theme", BG_KEY = "pt:bg", GLASS_KEY = "pt:glass", FMT_KEY = "pt:colorfmt", DEFAULTS_KEY = "pt:defaults";

export type Theme = "dark" | "light";
export type Pattern = "dots" | "grid" | "lines" | "none";
export interface BgState {
    pattern: Pattern; opacity: number;
    patternColor: string | null; groundColor: string | null;
    patternTheme: Theme | null; groundTheme: Theme | null; accent: string | null;
}
export interface GlassState {
    blur: number | null; sat: number | null; light: number | null; dark: number | null;
    tint: number | null; color: string | null; colorTheme: Theme | null; backing: number | null;
    shine: number | null; shade: number | null; lightAngle: number | null; radius: number | null; pad: number | null;
}
export type ColorFmt = "hex" | "rgb" | "hsl" | "hsb";

const BG_BASE: BgState = { pattern: "dots", opacity: 50, patternColor: null, groundColor: null, patternTheme: null, groundTheme: null, accent: null };
const GLASS_BASE: GlassState = { blur: null, sat: null, light: null, dark: null, tint: null, color: null, colorTheme: null, backing: null, shine: null, shade: null, lightAngle: null, radius: null, pad: null };
// CV Maker's defaults differ from Infospector's in two dials: its chrome floats over a white sheet of small type, so it
// needs a heavier blur and backing to stay legible (Infospector: blur 8, backing 35 over a dark canvas). They apply only
// while a dial is untouched — a look the user has set (in either tool: the saved look is shared) always wins.
const GLASS_DEFAULTS = { blur: 44, sat: 150, tint: 14, color: "#bbbbbc", backing: 56, shine: 0, shade: 0, lightAngle: 145, radius: 40, pad: 8 };
const ROOT_PROPS = ["--pt-pattern-opacity", "--pt-pattern", "--pt-ground", "--pt-ground-2", "--pt-accent", "--pt-accent-ink", "--glass-blur", "--saturation", "--glass-reflex-light", "--glass-reflex-dark", "--glass-tint", "--glass-tint-2", "--c-glass", "--glass-backing-color", "--glass-backing", "--glass-shine", "--glass-shade", "--glass-light-angle", "--glass-radius", "--glass-pad", "--pt-text", "--pt-text-dim", "--pt-text-faint"];

function read<T>(key: string, base: T): T {
    try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v && typeof v === "object" ? { ...base, ...v } : base; } catch { return base; }
}
function write(key: string, v: unknown) { try { localStorage.setItem(key, typeof v === "string" ? v : JSON.stringify(v)); } catch { /* ignore */ } }

// "Save" in the menu stores the current look as this browser's defaults (pt:defaults, shared with
// Infospector); the live look (pt:bg / pt:glass) layers on top of them, exactly as in host.js
function userDefaults(): { bg: BgState; glass: GlassState } {
    let mine: { bg?: Partial<BgState>; glass?: Partial<GlassState> } = {};
    try { mine = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || "{}") || {}; } catch { /* ignore */ }
    return { bg: { ...BG_BASE, ...(mine.bg || {}) }, glass: { ...GLASS_BASE, ...(mine.glass || {}) } };
}

// Infospector's glass color picker, attached to a plain <input type="color"> swatch
// Attach ONCE per swatch. React (Strict Mode, re-attached refs) can run this twice for the same element, and a
// second set of handlers makes the picker toggle itself shut the instant it opens — visible, but disconnected.
const attached = new WeakSet<HTMLInputElement>();
export const attachColorPicker = (swatch: HTMLInputElement, opts: { read: () => string; write: (v: string) => void; alpha?: boolean }): void => {
    if (attached.has(swatch)) return;
    attached.add(swatch); attach(swatch, opts);
};
export const closeColorPicker = (): void => closePicker();

export const parseColor = (s: string): string | null => lib.parseColor(s);
export const formatColor = (css: string, fmt: ColorFmt): string => lib.formatColor(css, fmt);
export const toHex = (css: string): string => lib.toHex(css);

export interface Effective { pattern: string; ground: string; accent: string; tint: string; blur: number; sat: number; light: number; dark: number; tintPct: number; backing: number; shine: number; shade: number; lightAngle: number; radius: number; pad: number; }

export function useInfospectorLook(hostCssUrl: string) {
    const [ready, setReady] = useState(false);
    const [theme, setThemeState] = useState<Theme>("dark");
    const [bg, setBgState] = useState<BgState>(BG_BASE);
    const [glass, setGlassState] = useState<GlassState>(GLASS_BASE);
    const [fmt, setFmtState] = useState<ColorFmt>("hex");
    const [effective, setEffective] = useState<Effective | null>(null);

    // mount: Infospector's stylesheet + theme attribute; unmount: leave the admin as we found it
    useEffect(() => {
        const root = document.documentElement;
        const t: Theme = (() => { try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; } })();
        root.setAttribute("data-pt-theme", t);
        const d = userDefaults();
        setThemeState(t); setBgState(read(BG_KEY, d.bg)); setGlassState(read(GLASS_KEY, d.glass));
        try { setFmtState((localStorage.getItem(FMT_KEY) as ColorFmt) || "hex"); } catch { /* ignore */ }
        const link = document.createElement("link");
        link.rel = "stylesheet"; link.href = hostCssUrl;
        link.onload = () => setReady(true); link.onerror = () => setReady(true);
        document.head.appendChild(link);
        return () => {
            link.remove(); root.removeAttribute("data-pt-theme");
            ROOT_PROPS.forEach((p) => root.style.removeProperty(p));
        };
    }, [hostCssUrl]);

    // apply (host.js applyBg + applyGlass + updateUiInk)
    useEffect(() => {
        if (!ready) return;
        const root = document.documentElement.style;
        const set = (name: string, v: string | number | null | undefined) => (v == null ? root.removeProperty(name) : root.setProperty(name, String(v)));
        set("--pt-pattern-opacity", bg.opacity / 100);
        set("--pt-pattern", bg.patternColor ? lib.forTheme(bg.patternColor, bg.patternTheme, theme) : null);
        if (bg.groundColor) {
            const gnd = lib.forTheme(bg.groundColor, bg.groundTheme, theme);
            set("--pt-ground", gnd);
            set("--pt-ground-2", lib.lumOf(gnd) > 0.4 ? lib.mixCss(gnd, "#000000", 0.05) : lib.mixCss(gnd, "#ffffff", 0.06));
        } else { set("--pt-ground", null); set("--pt-ground-2", null); }
        set("--pt-accent", bg.accent);
        const cs = () => getComputedStyle(document.documentElement);
        const accent = cs().getPropertyValue("--pt-accent").trim();
        set("--pt-accent-ink", lib.contrast("#ffffff", accent) >= 3 ? "#ffffff" : "#111111");

        const g = glass;
        set("--glass-blur", (g.blur ?? GLASS_DEFAULTS.blur) + "px");
        set("--saturation", g.sat == null ? null : g.sat + "%");
        set("--glass-reflex-light", g.light); set("--glass-reflex-dark", g.dark);
        set("--glass-tint", g.tint == null ? null : g.tint + "%");
        set("--glass-tint-2", g.tint == null ? null : Math.min(100, g.tint + 22) + "%");
        // directional light + the concentric geometry: one Radius and one Padding drive every nested corner in host.css
        set("--glass-shine", g.shine); set("--glass-shade", g.shade); set("--glass-light-angle", g.lightAngle);
        set("--glass-radius", g.radius == null ? null : g.radius + "px"); set("--glass-pad", g.pad == null ? null : g.pad + "px");
        set("--c-glass", g.color ? lib.forTheme(g.color, g.colorTheme, theme) : null);
        const tint = cs().getPropertyValue("--c-glass").trim() || GLASS_DEFAULTS.color;
        const backing = g.backing == null ? GLASS_DEFAULTS.backing : g.backing;
        const tintPct = g.tint == null ? GLASS_DEFAULTS.tint : g.tint;
        set("--glass-backing-color", tint); set("--glass-backing", backing + "%");
        // UI ink: black or white, whichever reads better on the estimated glass surface
        root.removeProperty("--pt-text");
        const ground = cs().getPropertyValue("--pt-ground").trim() || "#0b0c10";
        const surface = lib.mixCss(lib.mixCss(ground, tint, tintPct / 100), tint, backing / 100);
        const white = lib.contrast("#ffffff", surface) >= lib.contrast("#000000", surface);
        const ink = (a: number) => (white ? `rgba(255, 255, 255, ${a})` : `rgba(0, 0, 0, ${a})`);
        set("--pt-text", ink(1)); set("--pt-text-dim", ink(0.9)); set("--pt-text-faint", ink(0.65));

        const c = cs(), num = (p: string, d: number) => { const n = parseFloat(c.getPropertyValue(p)); return Number.isFinite(n) ? n : d; };
        setEffective({
            pattern: c.getPropertyValue("--pt-pattern").trim(), ground, accent, tint,
            blur: g.blur ?? GLASS_DEFAULTS.blur, sat: g.sat ?? num("--saturation", GLASS_DEFAULTS.sat),
            light: g.light ?? num("--glass-reflex-light", 0.3), dark: g.dark ?? num("--glass-reflex-dark", 2),
            tintPct, backing,
            shine: g.shine ?? GLASS_DEFAULTS.shine, shade: g.shade ?? GLASS_DEFAULTS.shade, lightAngle: g.lightAngle ?? GLASS_DEFAULTS.lightAngle,
            radius: g.radius ?? GLASS_DEFAULTS.radius, pad: g.pad ?? GLASS_DEFAULTS.pad,
        });
    }, [ready, theme, bg, glass]);

    const setTheme = useCallback((t: Theme) => { document.documentElement.setAttribute("data-pt-theme", t); write(THEME_KEY, t); setThemeState(t); }, []);
    const setBg = useCallback((patch: Partial<BgState>) => setBgState((b) => { const n = { ...b, ...patch }; write(BG_KEY, n); return n; }), []);
    const setGlass = useCallback((patch: Partial<GlassState>) => setGlassState((g) => { const n = { ...g, ...patch }; write(GLASS_KEY, n); return n; }), []);
    const setFmt = useCallback((f: ColorFmt) => { write(FMT_KEY, f); setFmtState(f); }, []);
    // Reset = the shipped look; the browser-saved defaults are cleared too so the old look doesn't return next time
    const reset = useCallback(() => { try { localStorage.removeItem(DEFAULTS_KEY); } catch { /* ignore */ } write(BG_KEY, BG_BASE); write(GLASS_KEY, GLASS_BASE); setBgState(BG_BASE); setGlassState(GLASS_BASE); }, []);
    const saveAsDefaults = useCallback((): boolean => { try { localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ glass, bg })); return true; } catch { return false; } }, [glass, bg]);
    const configSnippet = useCallback(() => "window.INFOSPECTOR_DEFAULTS = " + JSON.stringify({ glass, bg }, null, 2) + ";", [glass, bg]);

    return { ready, theme, setTheme, bg, setBg, glass, setGlass, fmt, setFmt, effective, reset, saveAsDefaults, configSnippet };
}
