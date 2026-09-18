/* Infospector — glass color picker.
   A single reusable popover (SV square + hue/alpha sliders, a switchable value
   readout — HEX / RGB / HSL / HSB / CSS — a copy button, a desktop-wide
   eyedropper where the browser offers one, and remembered swatches) that drives
   the plain <input type="color"> swatches already wired into the tool: on every
   change it writes the value back and fires the input's own events, so nothing
   downstream has to know the popover exists. Zero dependencies. */
import { parseRgb, hsbToHex, toHex, hslOf, formatColor, rgbOf } from './lib.js';

const RECENT_KEY = 'pt-cpick-recent';
const RECENT_MAX = 10;
const FMT_KEY = 'pt-cpick-fmt';   // the value format the user last chose (remembered)
const FMTS = ['hex', 'rgb', 'hsl', 'hsb', 'css'];
// which boxes each format shows; `wide` boxes (a single string) stretch, channels share evenly
const FIELD_SPECS = {
  hex: [{ k: 'hex', label: 'HEX', wide: true }],
  rgb: [{ k: 'r', label: 'R' }, { k: 'g', label: 'G' }, { k: 'b', label: 'B' }],
  hsl: [{ k: 'h', label: 'H' }, { k: 's', label: 'S' }, { k: 'l', label: 'L' }],
  hsb: [{ k: 'h', label: 'H' }, { k: 's', label: 'S' }, { k: 'b', label: 'B' }],
  css: [{ k: 'css', label: 'CSS', wide: true }],
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const h2 = (x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
const num = (s, max) => clamp(parseFloat(s) || 0, 0, max);
const byte = (s) => clamp(Math.round(parseFloat(s) || 0), 0, 255);
const pct = (s) => clamp(Math.round(parseFloat(s) || 0), 0, 100);

/* ---- color math (HSV is the picker's native space; the rest is derived) ----
   HSV is kept unrounded so a typed hex/RGB round-trips back to the same bytes;
   rounding happens only where a value is shown. */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}
const hsvToRgb = (h, s, v) => parseRgb(hsbToHex(h, s, v));
const hex8 = ({ r, g, b }, a) => '#' + h2(r) + h2(g) + h2(b) + (a < 1 ? h2(a * 255) : '');
// resolve any CSS color string (named colors included) via the browser, then the lib
function cssToRgb(v) {
  v = (v || '').trim(); if (!v) return null;
  try { const s = document.createElement('span').style; s.color = ''; s.color = v; if (s.color) return rgbOf(s.color); } catch (e) { /* fall through */ }
  return parseRgb(v);
}

/* ---- persisted bits ---- */
function getFmt() { try { const f = localStorage.getItem(FMT_KEY); return FMTS.includes(f) ? f : 'hex'; } catch (e) { return 'hex'; } }
function setFmt(f) { try { localStorage.setItem(FMT_KEY, f); } catch (e) { /* ignore */ } }
function getRecent() {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.slice(0, RECENT_MAX) : []; } catch (e) { return []; }
}
function pushRecent(hex) {
  try {
    const key = hex.toLowerCase();
    let a = getRecent().filter((c) => c.toLowerCase() !== key);
    a.unshift(hex); a = a.slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(a));
  } catch (e) { /* ignore */ }
}

/* ---- clipboard ----
   execCommand('copy') runs synchronously inside the click, so it works even where
   the async Clipboard API is blocked (embedded webviews, some sandboxed frames);
   the modern API is the fallback for the rare case execCommand is disabled. */
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

/* ---- the singleton popover ---- */
let pop = null;          // root element
let ui = null;           // cached child refs
let cur = { h: 0, s: 0, v: 0, a: 1 };   // current HSVA
let fmt = 'hex';         // active value format
let session = null;      // { anchor, alpha, onChange }
let onDocDown = null, onKeyDown = null;

const SVG = {
  // lucide "pipette"
  eyedropper: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12"/><path d="m18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z"/><path d="m2 22 .414-.414"/></svg>',
  // lucide "copy"
  copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  // lucide "check"
  check: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

function build() {
  pop = document.createElement('div');
  pop.id = 'pt-cpick';
  pop.className = 'pt-cpick';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Color picker');
  pop.hidden = true;
  pop.innerHTML = `
    <div class="pt-cp-sv" tabindex="0" aria-label="Saturation and brightness">
      <div class="pt-cp-sv-sat"></div><div class="pt-cp-sv-val"></div>
      <div class="pt-cp-sv-thumb"></div>
    </div>
    <div class="pt-cp-sliders">
      <input type="range" class="pt-cp-hue" min="0" max="360" step="1" aria-label="Hue" />
      <input type="range" class="pt-cp-alpha" min="0" max="100" step="1" aria-label="Opacity" />
    </div>
    <div class="pt-cp-fields">
      <button type="button" class="pt-cp-eyedrop" aria-label="Pick a color from the screen" data-tip="Pick a color from anywhere on screen">${SVG.eyedropper}</button>
      <select class="pt-fmt pt-cp-fmt" aria-label="Color format" data-tip="How the value reads — HEX, RGB, HSL, HSB, or any CSS color">
        <option value="hex">HEX</option><option value="rgb">RGB</option><option value="hsl">HSL</option><option value="hsb">HSB</option><option value="css">CSS</option>
      </select>
      <div class="pt-cp-boxes"></div>
      <button type="button" class="pt-cp-copy" aria-label="Copy color value" data-tip="Copy to clipboard">${SVG.copy}</button>
    </div>
    <div class="pt-cp-recent" hidden>
      <div class="pt-cp-recent-title">Recent</div>
      <div class="pt-cp-recent-row"></div>
    </div>`;
  document.body.appendChild(pop);

  ui = {
    sv: pop.querySelector('.pt-cp-sv'),
    svThumb: pop.querySelector('.pt-cp-sv-thumb'),
    hue: pop.querySelector('.pt-cp-hue'),
    alpha: pop.querySelector('.pt-cp-alpha'),
    eyedrop: pop.querySelector('.pt-cp-eyedrop'),
    fmtSel: pop.querySelector('.pt-cp-fmt'),
    boxes: pop.querySelector('.pt-cp-boxes'),
    copy: pop.querySelector('.pt-cp-copy'),
    recent: pop.querySelector('.pt-cp-recent'),
    recentRow: pop.querySelector('.pt-cp-recent-row'),
  };

  // native eyedropper (Chromium): samples a pixel from anywhere on the desktop.
  // Hidden where the browser has no such API — no web page can read pixels
  // outside itself in Firefox/Safari, so there is nothing honest to fall back to.
  if (!('EyeDropper' in window)) ui.eyedrop.hidden = true;

  wire();
}

// build the value boxes for the active format (+ an Opacity box when alpha's in play)
function buildBoxes() {
  ui.fmtSel.value = fmt;
  const specs = FIELD_SPECS[fmt].slice();
  let html = specs.map((s) => `<label class="pt-cp-f ${s.wide ? 'pt-cp-wide' : 'pt-cp-c'}"><span>${s.label}</span><input type="text" data-k="${s.k}" spellcheck="false" inputmode="${s.wide ? 'text' : 'numeric'}" aria-label="${s.label}" /></label>`).join('');
  if (session && session.alpha) html += '<label class="pt-cp-f pt-cp-a"><span>Opacity</span><input type="text" data-k="op" inputmode="numeric" aria-label="Opacity percent" /></label>';
  ui.boxes.innerHTML = html;
}

function wire() {
  // SV square drag
  let svDrag = false;
  const svAt = (e) => {
    const r = ui.sv.getBoundingClientRect();
    cur.s = clamp((e.clientX - r.left) / r.width, 0, 1) * 100;
    cur.v = (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * 100;
    render(); emit();
  };
  ui.sv.addEventListener('pointerdown', (e) => { svDrag = true; ui.sv.setPointerCapture(e.pointerId); svAt(e); e.preventDefault(); });
  ui.sv.addEventListener('pointermove', (e) => { if (svDrag) svAt(e); });
  ui.sv.addEventListener('pointerup', () => { if (svDrag) { svDrag = false; commit(); } });
  ui.sv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2; let hit = true;
    if (e.key === 'ArrowLeft') cur.s = clamp(cur.s - step, 0, 100);
    else if (e.key === 'ArrowRight') cur.s = clamp(cur.s + step, 0, 100);
    else if (e.key === 'ArrowUp') cur.v = clamp(cur.v + step, 0, 100);
    else if (e.key === 'ArrowDown') cur.v = clamp(cur.v - step, 0, 100);
    else hit = false;
    if (hit) { e.preventDefault(); render(); emit(); commit(); }
  });

  ui.hue.addEventListener('input', () => { cur.h = Number(ui.hue.value); render(); emit(); });
  ui.hue.addEventListener('change', commit);
  ui.alpha.addEventListener('input', () => { cur.a = Number(ui.alpha.value) / 100; render(); emit(); });
  ui.alpha.addEventListener('change', commit);

  ui.fmtSel.addEventListener('change', () => { fmt = ui.fmtSel.value; setFmt(fmt); buildBoxes(); render(); });
  // one delegated handler for whichever boxes are mounted
  ui.boxes.addEventListener('change', (e) => { if (e.target.matches('input[data-k]')) applyBoxes(); });

  ui.copy.addEventListener('click', () => {
    const text = formattedValue();
    if (legacyCopy(text)) { flashCopied(); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(flashCopied, () => { /* blocked — value stays on screen */ });
  });

  ui.eyedrop.addEventListener('click', async () => {
    try {
      const res = await new window.EyeDropper().open();   // sRGBHex from anywhere on screen
      const rgb = parseRgb(res.sRGBHex); if (rgb) { setFromRgb(rgb, cur.a); emit(); commit(); }
    } catch (e) { /* user hit Escape — no-op */ }
  });

  ui.recentRow.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-c]'); if (!sw) return;
    const rgb = parseRgb(sw.dataset.c); if (!rgb) return;
    setFromRgb(rgb, rgb.a != null ? rgb.a : cur.a); render(); emit(); commit();
  });
}

// read the mounted boxes, in the active format, back into the current color
function applyBoxes() {
  const g = (k) => { const i = ui.boxes.querySelector(`input[data-k="${k}"]`); return i ? i.value.trim() : ''; };
  if (fmt === 'hex') {
    const raw = g('hex').replace(/^#?/, '#'); const rgb = parseRgb(raw);
    if (!rgb) { render(); return; }
    const hasAlpha = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.test(raw);
    setFromRgb(rgb, hasAlpha ? rgb.a : cur.a);
  } else if (fmt === 'rgb') {
    setFromRgb({ r: byte(g('r')), g: byte(g('g')), b: byte(g('b')) }, cur.a);
  } else if (fmt === 'hsl') {
    const rgb = parseRgb(`hsl(${num(g('h'), 360)}, ${pct(g('s'))}%, ${pct(g('l'))}%)`);
    if (!rgb) { render(); return; }
    setFromRgb(rgb, cur.a);
  } else if (fmt === 'hsb') {
    cur = { h: num(g('h'), 360), s: pct(g('s')), v: pct(g('b')), a: cur.a };   // set HSV straight, so hue survives greys
  } else if (fmt === 'css') {
    const rgb = cssToRgb(g('css'));
    if (!rgb) { render(); return; }
    setFromRgb(rgb, rgb.a != null ? rgb.a : cur.a);
  }
  const op = g('op'); if (op !== '') cur.a = clamp(pct(op) / 100, 0, 1);
  render(); emit(); commit();
}

function setFromRgb(rgb, a) {
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  // keep the current hue when the color is a pure grey (its hue is otherwise meaningless and would snap to 0)
  cur = { h: rgb.r === rgb.g && rgb.g === rgb.b ? cur.h : hsv.h, s: hsv.s, v: hsv.v, a: clamp(a == null ? 1 : a, 0, 1) };
  render();
}

/* current color as {r,g,b}, hex, and alpha-aware string */
function rgbNow() { return hsvToRgb(cur.h, cur.s, cur.v); }
function hexNow() { const c = rgbNow(); return '#' + h2(c.r) + h2(c.g) + h2(c.b); }
function valueNow() { return cur.a < 1 ? hex8(rgbNow(), cur.a) : hexNow(); }
// the current color written in the active format — what Copy yields and what CSS mode shows
function formattedValue() {
  const v = valueNow();
  if (fmt === 'hex') return v.toUpperCase();
  if (fmt === 'css') return formatColor(v, 'rgb');
  return formatColor(v, fmt);   // rgb | hsl | hsb
}

function render() {
  if (!pop) return;
  const rgb = rgbNow(), hex = hexNow();
  const hueRgb = hsvToRgb(cur.h, 100, 100);
  ui.sv.style.setProperty('--hue', '#' + h2(hueRgb.r) + h2(hueRgb.g) + h2(hueRgb.b));
  ui.svThumb.style.left = cur.s + '%';
  ui.svThumb.style.top = (100 - cur.v) + '%';
  ui.svThumb.style.background = hex;
  ui.hue.value = String(Math.round(cur.h));
  ui.alpha.value = String(Math.round(cur.a * 100));
  ui.alpha.style.setProperty('--stop', hex);
  ui.hue.style.setProperty('--fill', (cur.h / 360 * 100) + '%');
  const set = (k, val) => { const i = ui.boxes.querySelector(`input[data-k="${k}"]`); if (i && document.activeElement !== i) i.value = val; };
  if (fmt === 'hex') set('hex', hex.toUpperCase());                                   // 6-digit; alpha rides the Opacity box
  else if (fmt === 'rgb') { set('r', rgb.r); set('g', rgb.g); set('b', rgb.b); }
  else if (fmt === 'hsl') { const c = hslOf(hex); set('h', c.h); set('s', c.s); set('l', c.l); }
  else if (fmt === 'hsb') { set('h', Math.round(cur.h)); set('s', Math.round(cur.s)); set('b', Math.round(cur.v)); }
  else if (fmt === 'css') set('css', formatColor(valueNow(), 'rgb'));
  set('op', Math.round(cur.a * 100) + '%');
}

let copiedTimer = null;
function flashCopied() {
  ui.copy.classList.add('pt-copied'); ui.copy.innerHTML = SVG.check;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { ui.copy.classList.remove('pt-copied'); ui.copy.innerHTML = SVG.copy; }, 1100);
}

function renderRecent() {
  const recent = getRecent();
  ui.recent.hidden = recent.length === 0;
  ui.recentRow.innerHTML = recent.map((c) => `<button type="button" class="pt-cp-sw" data-c="${c}" style="--sw:${c}" title="${c}" aria-label="${c}"></button>`).join('');
}

/* live-apply to the bound input, mirroring what the tool's own controls do */
function emit() { if (session && session.onChange) session.onChange(valueNow()); }
function commit() { if (session) pushRecent(hexNow()); }

function place() {
  if (!session || !session.anchor) return;
  const a = session.anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight, gap = 8, m = 8;
  let left = a.left, top = a.bottom + gap;
  if (top + h > window.innerHeight - m) top = Math.max(m, a.top - gap - h);   // flip above if it would overflow
  left = clamp(left, m, window.innerWidth - w - m);
  top = clamp(top, m, window.innerHeight - h - m);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
}

function open(anchor, initial, opts) {
  if (!pop) build();
  session = { anchor, onChange: opts.onChange, alpha: opts.alpha !== false };
  fmt = getFmt();
  ui.alpha.hidden = !session.alpha;
  ui.alpha.classList.toggle('pt-no-alpha', !session.alpha);
  buildBoxes();
  const rgb = parseRgb(initial) || { r: 0, g: 0, b: 0, a: 1 };
  setFromRgb(rgb, session.alpha && rgb.a != null ? rgb.a : 1);
  renderRecent();
  ui.copy.classList.remove('pt-copied'); ui.copy.innerHTML = SVG.copy;
  pop.hidden = false;
  place();
  requestAnimationFrame(() => { pop.classList.add('pt-open'); place(); });
  onDocDown = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  // Escape closes the picker first, ahead of any sheet/panel behind it (capture + stop)
  onKeyDown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
}

function close() {
  if (!pop || pop.hidden) return;
  pop.classList.remove('pt-open');
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
  const el = pop; setTimeout(() => { if (!el.classList.contains('pt-open')) el.hidden = true; }, 140);
  session = null;
}

/* Public: turn a plain <input type="color"> (optionally paired with a text field)
   into a trigger for the glass popover. `read` returns the input's current value;
   `write(value)` applies a new one. Alpha is offered only when `alpha` is true. */
export function attachColorPicker(swatch, { read, write, alpha = false } = {}) {
  read = read || (() => swatch.value);
  write = write || ((v) => { swatch.value = toHex(v); swatch.dispatchEvent(new Event('input', { bubbles: true })); });
  const openFor = (e) => {
    e.preventDefault();
    if (session && session.anchor === swatch) { close(); return; }
    open(swatch, read(), { alpha, onChange: write });
  };
  swatch.addEventListener('mousedown', openFor);          // beat the OS picker (it opens on mousedown)
  swatch.addEventListener('click', (e) => e.preventDefault());
  swatch.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openFor(e); });
}

export function closeColorPicker() { close(); }
