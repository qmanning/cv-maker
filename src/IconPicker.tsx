// src/components/labs/icedcoffee/IconPicker.tsx
// "Choose Icon": a typeahead over Lucide AND Tabler, merged and sorted by name (search "lucide" or "tabler"
// to narrow to one set). It sits next to the image — no dark overlay — so the colour reads against the real
// document background, and recolouring updates the icon on the page live. Loaded on demand (dynamic import)
// so neither icon set touches the main bundle until someone opens it.

"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { icons as lucideIcons, X } from "lucide-react";
import * as tabler from "@tabler/icons-react";
import { ColorRow } from "./LookMenu";
import type { ColorFmt } from "./use-infospector-look";

type Entry = { key: string; name: string; lib: "lucide" | "tabler"; Comp: ComponentType<{ color?: string }> };
const LUCIDE: Entry[] = Object.keys(lucideIcons).filter((n) => !n.endsWith("Icon"))
    .map((n) => ({ key: "l:" + n, name: n, lib: "lucide", Comp: lucideIcons[n as keyof typeof lucideIcons] as ComponentType<{ color?: string }> }));
const tablerMap = tabler as unknown as Record<string, ComponentType<{ color?: string }>>;
const TABLER: Entry[] = Object.keys(tabler).filter((n) => /^Icon[A-Z]/.test(n) && !n.endsWith("Filled") && typeof (tabler as unknown as Record<string, unknown>)[n] === "object")
    .map((n) => ({ key: "t:" + n, name: n.replace(/^Icon/, ""), lib: "tabler", Comp: tablerMap[n] }));
const ALL: Entry[] = [...LUCIDE, ...TABLER].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.lib.localeCompare(b.lib));
const CAP = 300;   // how many cells to render at once (a search narrows well below this)

// bake the picked colour into a standalone SVG data URI — currentColor won't resolve inside an <img>
function toDataUri(svg: SVGSVGElement, color: string): string {
    const el = svg.cloneNode(true) as SVGSVGElement;
    el.setAttribute("stroke", color);
    el.removeAttribute("color");
    el.setAttribute("width", "24"); el.setAttribute("height", "24");
    return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(el))));
}

export default function IconPicker({ at, color, fmt, onColor, onPick, onClose }: {
    at: { left: number; top: number }; color: string; fmt: ColorFmt; onColor: (css: string) => void; onPick: (dataUri: string, name: string) => void; onClose: () => void;
}) {
    const [q, setQ] = useState("");
    const [sel, setSel] = useState<Entry | null>(null);
    const hiddenRef = useRef<HTMLDivElement>(null);
    const list = useMemo(() => {
        const s = q.trim().toLowerCase();
        const pool = s === "lucide" ? LUCIDE : s === "tabler" ? TABLER : s ? ALL.filter((e) => e.name.toLowerCase().includes(s)) : ALL;
        return pool.slice(0, CAP);
    }, [q]);
    // place the chosen icon on the page in the current colour (recolouring afterwards is handled by the host,
    // which recolours whatever icon is on the target — so it works even for an icon placed earlier)
    useEffect(() => {
        if (!sel) return;
        const svg = hiddenRef.current?.querySelector("svg");
        if (svg) onPick(toDataUri(svg as SVGSVGElement, color), sel.name);
    }, [sel]);   // eslint-disable-line react-hooks/exhaustive-deps
    const Sel = sel?.Comp;
    return (
        <div className="cvm-iconpick-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="cvm-iconpick pt-menu-pop pt-open" role="dialog" aria-label="Choose an icon" style={{ left: at.left, top: at.top }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
                <div className="cvm-iconpick-head">
                    <input autoFocus className="cvm-iconpick-search" type="text" spellCheck={false} placeholder="Search icons… (or “lucide” / “tabler”)" aria-label="Search icons" value={q} onChange={(e) => setQ(e.target.value)} />
                    <button className="cvm-iconpick-x" aria-label="Done" data-tip="Done" onClick={onClose}><X /></button>
                </div>
                <div className="cvm-iconpick-color"><ColorRow label="Color" value={color} fmt={fmt} alpha={false} tip="The icon is an SVG — recolor it on the page" onPick={onColor} /></div>
                <div className="cvm-iconpick-div" />
                <div className="cvm-iconpick-grid">
                    {list.map((e) => {
                        const Ic = e.Comp;
                        return (
                            <button key={e.key} type="button" className={"cvm-iconpick-cell" + (sel?.key === e.key ? " cvm-on" : "")} title={e.name} aria-label={e.name} aria-pressed={sel?.key === e.key} onClick={() => setSel(e)}><Ic /></button>
                        );
                    })}
                    {list.length === 0 && <div className="cvm-iconpick-empty">No icons match “{q.trim()}”.</div>}
                </div>
                <div className="cvm-iconpick-foot">{sel ? `“${sel.name}” placed · recolor it or pick another` : q.trim() ? `${list.length} match` : `${ALL.length.toLocaleString()} icons · type to search`}</div>
                {/* hidden render of the selected icon, serialized with the chosen colour for the résumé */}
                <div ref={hiddenRef} aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}>{Sel && <Sel />}</div>
            </div>
        </div>
    );
}
