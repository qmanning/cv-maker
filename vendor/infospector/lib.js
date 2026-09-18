/*
 * Infospector — pure helpers (no DOM). Imported by host.js and unit-tested with `node --test`.
 * Anything that needs the browser (canvas color resolution, CSS.supports, location) is passed in.
 */

/* ---------------- stage shapes ---------------- */
// A plain rounded rectangle, whatever the shape. With rulers on, the top and left
// strips butt against three corners — top-left, top-right, bottom-left — so those
// square off; only the free bottom-right corner keeps its radius.
export function radiusCss(shape, s, rulers) {
  const r = Math.round(shape.r * s * 10) / 10;
  return rulers ? `0 0 ${r}px 0` : `${r}px`;
}
// tick spacing so minor ticks are ≥6px and labeled ticks ≥60px on screen, at any zoom
export function tickSteps(s) {
  const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const minor = steps.find((v) => v * s >= 6) || 2000;
  const major = steps.find((v) => v * s >= 60 && v % minor === 0) || minor * 10;
  return { minor, major };
}

/* ---------------- notes model ---------------- */
// note lifecycle: open (yellow) → noted by the assistant (purple) → done (green)
export const STATES = ['open', 'noted', 'done'];
export const STATE_COLORS = { open: '#ffd83d', noted: '#a259ff', done: '#46c17b' };
export const LEGACY_STATES = { reviewed: 'noted', working: 'noted', complete: 'done' };
export function normState(s) { return STATES.includes(s) ? s : (LEGACY_STATES[s] || 'open'); }
const defaultUid = (p) => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// v1 docs (flat notes[]) become v2 (targets[] each owning notes); old 4-state names collapse to 3
export function migrate(doc, uid = defaultUid) {
  let out = doc;
  if (!Array.isArray(doc.targets)) {
    out = { version: 2, pageKey: doc.pageKey, targets: [] };
    if (Array.isArray(doc.notes)) doc.notes.forEach((n) => {
      const selr = (n.anchor && n.anchor.selector) || (n.element && n.element.selectors && n.element.selectors[0]) || uid('sel');
      let t = out.targets.find((x) => x.anchor.selector === selr);
      if (!t) { t = { id: uid('t'), createdAt: n.createdAt, updatedAt: n.updatedAt, anchor: n.anchor || { selector: selr }, element: n.element || {}, ruler: false, modal: { x: null, y: null, open: false }, notes: [] }; out.targets.push(t); }
      t.notes.push({ id: n.id || uid('n'), text: n.text || '', state: n.state, createdAt: n.createdAt, updatedAt: n.updatedAt });
    });
  }
  out.targets.forEach((t) => t.notes.forEach((n) => { n.state = normState(n.state); }));
  return out;
}

/* ---------------- colors ---------------- */
let colorFallback = null;   // host installs a canvas-based resolver for named colors etc.
export function setColorFallback(fn) { colorFallback = fn; }
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) };
}
// parse #hex / rgb() / hsl() / hsb() without a browser; null if it isn't one of those
export function parseRgb(css) {
  const s = String(css || '').trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let h = m[1]; if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? +(parseInt(h.slice(6, 8), 16) / 255).toFixed(3) : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) { let a = 1; if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]; return { r: clamp255(+m[1]), g: clamp255(+m[2]), b: clamp255(+m[3]), a }; }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*[,\s]\s*([\d.]+)%?\s*[,\s]\s*([\d.]+)%?\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) { let a = 1; if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]; return Object.assign(hslToRgb(+m[1], +m[2], +m[3]), { a }); }
  m = /^hs[bv]\(\s*([\d.]+)[,\s]+([\d.]+)%?[,\s]+([\d.]+)%?\s*\)$/i.exec(s);
  if (m) return Object.assign(parseRgb(hsbToHex(+m[1], +m[2], +m[3])), { a: 1 });
  return null;
}
export function rgbOf(css) {
  return parseRgb(css) || (colorFallback && colorFallback(css)) || { r: 0, g: 0, b: 0, a: 1 };
}
const h2 = (x) => clamp255(x).toString(16).padStart(2, '0');
export function toHex(css) { const { r, g, b } = rgbOf(css); return '#' + h2(r) + h2(g) + h2(b); }
export function hsbToHex(h, s, b) {
  s /= 100; b /= 100; const k = (n) => (n + h / 60) % 6; const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
  return '#' + [f(5), f(3), f(1)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
// normalize a typed color: hsb() → hex, bare hex gets its '#'; anything else must pass `isValid`
export function parseColor(str, isValid = (s) => !!parseRgb(s)) {
  str = (str || '').trim(); if (!str) return null;
  const m = /^hs[bv]\(\s*([\d.]+)[,\s]+([\d.]+)%?[,\s]+([\d.]+)%?\s*\)$/i.exec(str);
  if (m) return hsbToHex(+m[1], +m[2], +m[3]);
  if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(str)) str = '#' + str;
  return isValid(str) ? str : null;
}
export function formatColor(css, fmt) {
  const { r, g, b, a } = rgbOf(css);
  if (fmt === 'rgb') return a < 1 ? `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})` : `rgb(${r}, ${g}, ${b})`;
  if (fmt === 'hsl' || fmt === 'hsb') {
    const rn = r / 255, gn = g / 255, bn = b / 255, max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
    let h = 0; if (d) { h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4; h = Math.round(h * 60); if (h < 0) h += 360; }
    if (fmt === 'hsb') return `hsb(${h}, ${Math.round((max ? d / max : 0) * 100)}, ${Math.round(max * 100)})`;
    const l = (max + min) / 2, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    return a < 1 ? `hsla(${h}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%, ${+a.toFixed(2)})` : `hsl(${h}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)`;
  }
  return a < 1 ? '#' + h2(r) + h2(g) + h2(b) + h2(a * 255) : '#' + h2(r) + h2(g) + h2(b);
}
export function hslOf(css) {
  const { r, g, b } = rgbOf(css); const rn = r / 255, gn = g / 255, bn = b / 255, max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0; if (d) { h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4; h = Math.round(h * 60); if (h < 0) h += 360; }
  const l = (max + min) / 2, s2 = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s: Math.round(s2 * 100), l: Math.round(l * 100) };
}
// a color picked in one theme keeps its hue in the other, re-lit for contrast
export function forTheme(css, pickedTheme, theme) {
  if (!css || !pickedTheme || pickedTheme === theme) return css;
  const { h, s: sat, l } = hslOf(css);
  return theme === 'dark' ? `hsl(${h}, ${Math.min(sat, 70)}%, ${Math.min(l, 14)}%)` : `hsl(${h}, ${Math.min(sat, 70)}%, ${Math.max(l, 90)}%)`;
}
// relative luminance (0 = black, 1 = white)
export function lumOf(css) {
  const { r, g, b } = rgbOf(css); const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
// sRGB mix of two colors (t = share of b), as hex
export function mixCss(a, b, t) {
  const A = rgbOf(a), B = rgbOf(b), ch = (x, y) => h2(x + (y - x) * t);
  return '#' + ch(A.r, B.r) + ch(A.g, B.g) + ch(A.b, B.b);
}
export const contrast = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/* ---------------- pages / URLs ---------------- */
export function isUrlish(v) { return /^https?:\/\//i.test(v) || v.startsWith('/'); }
export function shortUrl(u, origin) { try { const x = new URL(u); return x.origin === origin ? (x.pathname + x.search) || '/' : u; } catch (e) { return u; } }
export const humanize = (path) => { const seg = path.replace(/\/+$/, '').split('/').pop() || 'Home'; return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); };
// same-origin, page-like href → clean path, else null (assets, APIs, and the tool's own folder are not pages)
export function pagePath(href, { origin, base = '/' }) {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin || (base !== '/' && u.pathname.startsWith(base))) return null;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|txt|pdf|zip|mp4|webm|woff2?)$/i.test(u.pathname)) return null;
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/_next/')) return null;
    return u.pathname.replace(/\/{2,}/g, '/');
  } catch (e) { return null; }
}
// merged, de-duped page list: curated first (in order), then sitemap + learned links by path
export function mergePages(curated = [], sitemap = [], discovered = {}) {
  const out = new Map();
  curated.forEach((p) => { if (p && p.path && !out.has(p.path)) out.set(p.path, { title: p.title || humanize(p.path), path: p.path, type: p.type || 'page' }); });
  const rest = [];
  sitemap.forEach((p) => { if (!out.has(p.path)) rest.push({ title: humanize(p.path), path: p.path, type: 'sitemap' }); });
  Object.entries(discovered).forEach(([path, v]) => { if (!out.has(path) && !rest.some((r) => r.path === path)) rest.push({ title: (v && v.title) || humanize(path), path, type: 'link' }); });
  rest.sort((a, b) => a.path.localeCompare(b.path)).forEach((p) => out.set(p.path, p));
  return [...out.values()];
}
