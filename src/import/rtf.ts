// src/import/rtf.ts — RTF → FlowDoc. A real tokenizer + group-state parser (no library): Word, WordPad,
// TextEdit/Cocoa (textutil) and Google Docs RTF all come through the same rules. See flow.ts for the contract.
//
// RTF is a stream of groups `{…}`, control words `\word-12 `, control symbols `\'e9 \~ \*` and text. Formatting
// is STATE: every `{` pushes a copy of the character + paragraph state, every `}` pops it, and control words
// mutate the top. Text is emitted into whatever destination the group belongs to (body text, font table,
// field instruction, picture hex…). We describe what the page looks like; structure.ts decides what it means.
import { FlowResult, FlowPage, esc, escAttr, pt, styleAttr, dataUri, imageMime } from "./flow";

/* ---------------- state ---------------- */

interface CharState {
    f: number; fs: number; // font index, size in pt
    b: boolean; i: boolean; ul: boolean; strike: boolean; sup: boolean; sub: boolean; caps: boolean; v: boolean;
    cf: number; cb: number; spacing: number; // colour indexes (0 = auto), letter-spacing in pt
    href: string; uc: number;
}
interface Border { style: string; w: number; cf: number; sp: number }
interface TabStop { pos: number; kind: string } // twips
interface ParState {
    align: string; li: number; ri: number; fi: number; sb: number; sa: number; sl: number; slmult: boolean;
    tabs: TabStop[]; tabKind: string; bt: Border | null; bb: Border | null; bg: number;
    intbl: boolean; ls: number; ilvl: number; s: number; outline: number;
}
type Dest = "text" | "skip" | "fonttbl" | "colortbl" | "stylesheet" | "style" | "info" | "title" | "listtable" | "leveltext"
    | "listoverridetable" | "listtext" | "fldinst" | "pict" | "shpinst" | "defchp" | "defpap" | "upr";
interface Group {
    c: CharState; p: ParState; dest: Dest; fresh: boolean; star: boolean;
    onClose?: () => void;
}

type Run =
    | { t: "text"; s: string; c: CharState }
    | { t: "tab"; c: CharState }
    | { t: "br"; c: CharState }
    | { t: "img"; src: string; w: number; h: number; c: CharState };
interface Para { runs: Run[]; p: ParState; c: CharState; list: { ls: number; ilvl: number; text: string } | null; extraTop: number }
interface CellDef { x: number; borders: Record<string, Border>; bg: number; valign: string; merge: string; vmerge: string }
interface Row { cells: Para[][]; defs: CellDef[]; left: number }
type Item = { kind: "p"; para: Para } | { kind: "table"; rows: Row[] };
interface Sink { items: Item[]; runs: Run[]; listText: string | null; rows: Row[]; row: Para[][]; cell: Para[] }

const defaultChar = (): CharState => ({ f: -1, fs: 12, b: false, i: false, ul: false, strike: false, sup: false, sub: false, caps: false, v: false, cf: 0, cb: 0, spacing: 0, href: "", uc: 1 });
const defaultPar = (): ParState => ({ align: "", li: 0, ri: 0, fi: 0, sb: 0, sa: 0, sl: 0, slmult: false, tabs: [], tabKind: "", bt: null, bb: null, bg: 0, intbl: false, ls: 0, ilvl: 0, s: 0, outline: -1 });
const newSink = (): Sink => ({ items: [], runs: [], listText: null, rows: [], row: [], cell: [] });

/* ---------------- code pages ---------------- */

// cp1252's 0x80–0x9F block (the only part that differs from Latin-1); undefined slots stay as the byte.
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
const CHARSET_CP: Record<number, number> = { 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
const CP_LABEL: Record<number, string> = { 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5", 10000: "macintosh", 874: "windows-874" };
// Symbol / Wingdings glyphs a résumé actually uses as bullets (Word writes them as bytes or U+F0xx).
const SYMBOL: Record<number, string> = { 0xb7: "•", 0xa7: "▪", 0x6c: "●", 0x6e: "■", 0x71: "❑", 0x76: "❖", 0xd8: "➢", 0xfc: "✓", 0xe0: "→", 0xae: "→", 0x2d: "–", 0x6f: "○" };
const symbolChar = (code: number): string => SYMBOL[code] ?? String.fromCharCode(code);

const decoders = new Map<number, ((b: number[]) => string) | null>();
function decoderFor(cp: number): (b: number[]) => string {
    let d = decoders.get(cp);
    if (d) return d;
    if (cp !== 1252) {
        try {
            const td = new TextDecoder(CP_LABEL[cp] ?? `windows-${cp}`);
            d = (b) => td.decode(new Uint8Array(b));
        } catch { d = null; } // an encoding this runtime lacks: read it as 1252 rather than fail the import
    }
    if (!d) d = (b) => b.map((x) => (x >= 0x80 && x <= 0x9f ? CP1252[x - 0x80] : String.fromCharCode(x))).join("");
    decoders.set(cp, d);
    return d;
}

/* ---------------- fonts ---------------- */

interface Font { name: string; family: string; charset: number; weight: number; italic: boolean; symbol: boolean }
const WEIGHTS: Record<string, number> = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, book: 400, regular: 400, roman: 400, normal: 400, medium: 500, semibold: 600, demibold: 600, demi: 600, bold: 700, extrabold: 800, ultrabold: 800, heavy: 900, black: 900 };
const GENERIC: Record<string, string> = { froman: "serif", fswiss: "sans-serif", fmodern: "monospace", fscript: "cursive", fdecor: "fantasy" };

/** "HelveticaNeue-Medium" → Helvetica Neue / 500; "TimesNewRomanPS-BoldItalicMT" → Times New Roman / 700 italic.
 *  Cocoa writes PostScript names; the family name is what a stylesheet can actually ask for. */
function cleanFont(raw: string): { name: string; weight: number; italic: boolean } {
    let name = raw.trim().replace(/;$/, "").trim(), weight = 400, italic = false;
    if (/\s/.test(name)) return { name, weight, italic }; // Word writes real family names already ("Calibri Light")
    const dash = name.lastIndexOf("-");
    if (dash > 0) {
        const style = name.slice(dash + 1).replace(/(PSMT|MT|PS)$/, "");
        const m = /^([A-Za-z]*?)(Italic|Oblique|It)?$/.exec(style);
        if (m && (m[1] === "" || WEIGHTS[m[1].toLowerCase()] !== undefined)) {
            weight = m[1] ? WEIGHTS[m[1].toLowerCase()] : 400; italic = !!m[2];
            name = name.slice(0, dash);
        }
    }
    name = name.replace(/(PSMT|MT|PS)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
    return { name, weight, italic };
}

/* ---------------- control-word tables ---------------- */

const SPECIAL: Record<string, string> = { emdash: "—", endash: "–", bullet: "•", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", emspace: " ", enspace: " ", qmspace: " ", zwj: "‍", zwnj: "‌", zwbo: "​", ltrmark: "", rtlmark: "" };
// destinations whose text is never body text (non-starred ones must be listed; starred unknowns are skipped anyway)
const SKIP = new Set(("filetbl revtbl rsidtbl author operator subject keywords comment doccomm company category manager hlinkbase " +
    "generator xe tc tcn txe rxe bkmkstart bkmkend annotation atnid atnauthor atntime atnref atndate atnicn nonshppict objdata " +
    "objclass objname objalias objsect objtime private template docvar userprops fchars lchars pn pntxta pntxtb ftnsep ftnsepc ftncn " +
    "aftnsep aftnsepc aftncn mmathPr themedata colorschememapping latentstyles datastore xmlnstbl pgdsctbl listpicture wgrffmtfilter " +
    "fontemb fontfile falt panose levelnumbers listname nesttableprops expandedcolortbl levelmarker background pgdsc passwordhash " +
    "protusertbl ffdeftext ffformat ffhelptext ffstattext ffentrymcr ffexitmcr ffname formfield blipuid picprop " +
    "shptxt shpgrp do dptxbxtext mhtmltag htmltag").split(" "));
const HEADERS = new Set(["header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf"]);
const BORDER_STYLES: Record<string, string> = { brdrs: "solid", brdrth: "solid", brdrsh: "solid", brdrhair: "solid", brdrdb: "double", brdrtriple: "double", brdrdot: "dotted", brdrdash: "dashed", brdrdashsm: "dashed", brdrdashd: "dashed", brdrdashdd: "dotted", brdrwavy: "solid", brdrengrave: "solid", brdremboss: "solid", brdroutset: "solid", brdrinset: "solid" };
const NFC: Record<number, string> = { 0: "decimal", 1: "upper-roman", 2: "lower-roman", 3: "upper-alpha", 4: "lower-alpha", 22: "decimal-leading-zero" };

/* ---------------- the converter ---------------- */

export async function rtfToFlow(data: ArrayBuffer, name: string): Promise<FlowResult> {
    const bytes = new Uint8Array(data);
    const warnings: string[] = [];
    const warn = (s: string) => { if (!warnings.includes(s)) warnings.push(s); };
    if (!/^\s*\{\\rtf/.test(String.fromCharCode(...bytes.subarray(0, 16)))) {
        return { html: "", warnings: [`${name} does not look like an RTF file.`] };
    }

    let ansiCp = 1252;
    const fonts = new Map<number, Font>();
    const colors: string[] = [];
    const styles = new Map<number, string>();
    const lists = new Map<number, { nfc: number; text: string }[]>(); // listid → levels
    const overrides = new Map<number, number>(); // ls → listid
    const page: FlowPage = {};
    let title = "", deff = -1;
    let defC = defaultChar(), defP = defaultPar();
    let rowDefs: CellDef[] = [], pendingCell: CellDef = newCellDef(), trleft = 0;
    let borderTarget: "t" | "b" | "cell-t" | "cell-b" | "cell-l" | "cell-r" | "" = "";
    const counts = { badPict: 0, footnote: 0, shape: 0, nested: false, cols: false };
    const headers = new Map<string, Sink>();
    let skipShprslt = false;

    const sinks: Sink[] = [newSink()];
    const sink = () => sinks[sinks.length - 1];
    const fields: { inst: string }[] = [];
    let curFont: Font | null = null, curColor: number[] = [-1, -1, -1];
    let curList: { id: number; levels: { nfc: number; text: string }[] } | null = null;
    let curOverride = { listid: 0, ls: 0 };
    let curPict: { kind: string; hex: string; bin: Uint8Array | null; picw: number; pich: number; gw: number; gh: number; sx: number; sy: number } | null = null;
    let styleRec: { s: number; name: string } | null = null;

    const stack: Group[] = [{ c: defaultChar(), p: defaultPar(), dest: "text", fresh: false, star: false }];
    const top = () => stack[stack.length - 1];

    function newCellDef(): CellDef { return { x: 0, borders: {}, bg: 0, valign: "", merge: "", vmerge: "" }; }

    /* ---- text emission ---- */
    let pending: number[] = [];
    let ucSkip = 0;
    const fontOf = (f: number) => fonts.get(f);
    function flush() {
        if (!pending.length) return;
        const b = pending; pending = [];
        const font = fontOf(top().c.f);
        if (font?.symbol) return emit(b.map(symbolChar).join(""));
        const cp = font && CHARSET_CP[font.charset] ? CHARSET_CP[font.charset] : ansiCp;
        emit(b.every((x) => x < 0x80) ? String.fromCharCode(...b) : decoderFor(cp)(b));
    }
    function emit(s: string) {
        const g = top();
        if (/[-]/.test(s)) s = s.replace(/[-]/g, (ch) => symbolChar(ch.charCodeAt(0) - 0xf000));
        switch (g.dest) {
            case "text": return addText(s);
            case "fonttbl":
                if (!curFont) return;
                for (const ch of s) {
                    if (ch === ";") { const f = cleanFont(curFont.name); Object.assign(curFont, f); curFont = null; return; }
                    curFont.name += ch;
                }
                return;
            case "colortbl":
                for (const ch of s) if (ch === ";") {
                    colors.push(curColor[0] < 0 ? "" : "#" + curColor.map((n) => Math.max(0, n).toString(16).padStart(2, "0")).join(""));
                    curColor = [-1, -1, -1];
                }
                return;
            case "title": title += s; return;
            case "style": if (styleRec) styleRec.name += s; return;
            case "leveltext": { const lv = curList?.levels[curList.levels.length - 1]; if (lv) lv.text += s; return; }
            case "listtext": sink().listText = (sink().listText ?? "") + s; return;
            case "fldinst": if (fields.length) fields[fields.length - 1].inst += s; return;
            case "pict": if (curPict) curPict.hex += s; return;
        }
    }
    const sameChar = (a: CharState, b: CharState) => {
        for (const k in a) if (a[k as keyof CharState] !== b[k as keyof CharState]) return false;
        return true;
    };
    function addText(s: string) {
        const c = top().c;
        if (c.v || !s) return;
        const runs = sink().runs, last = runs[runs.length - 1];
        if (last && last.t === "text" && sameChar(last.c, c)) last.s += s;
        else runs.push({ t: "text", s, c: { ...c } });
    }
    const addRun = (r: Run) => { if (top().dest === "text" && !top().c.v) sink().runs.push(r); };

    /* ---- paragraphs, cells, rows ---- */
    function endPara(inCell = false) {
        const s = sink(), g = top();
        const para: Para = { runs: s.runs, p: { ...g.p }, c: { ...g.c }, list: null, extraTop: 0 };
        const listText = s.listText;
        if (g.p.ls > 0 || listText !== null) para.list = { ls: g.p.ls, ilvl: g.p.ilvl, text: (listText ?? "").trim() };
        s.runs = []; s.listText = null;
        if (inCell || g.p.intbl) { s.cell.push(para); return; }
        flushTable(s);
        s.items.push({ kind: "p", para });
    }
    function endCell() { const s = sink(); endPara(true); s.row.push(s.cell); s.cell = []; }
    function endRow() {
        const s = sink();
        if (s.runs.length) endCell();
        s.rows.push({ cells: s.row, defs: rowDefs.map((d) => ({ ...d })), left: trleft });
        s.row = []; s.cell = [];
    }
    function flushTable(s: Sink) {
        if (s.row.length || s.cell.length) { if (s.cell.length) { s.row.push(s.cell); s.cell = []; } s.rows.push({ cells: s.row, defs: rowDefs.map((d) => ({ ...d })), left: trleft }); s.row = []; }
        if (s.rows.length) { s.items.push({ kind: "table", rows: s.rows }); s.rows = []; }
    }

    /* ---- destinations ---- */
    function openDest(word: string, param: number | null): boolean {
        const g = top();
        if (g.dest === "skip") return true; // nothing inside a skipped group comes back to life
        const set = (d: Dest) => { g.dest = d; return true; };
        switch (word) {
            case "fonttbl": return set("fonttbl");
            case "colortbl": return set("colortbl");
            case "stylesheet": return set("stylesheet");
            case "info": return set("info");
            case "listtable": return set("listtable");
            case "listoverridetable": return set("listoverridetable");
            case "listtext": case "pntext": sink().listText = sink().listText ?? ""; return set("listtext");
            // Word's document defaults: what \plain and \pard reset to
            case "defchp": g.onClose = () => { defC = { ...top().c, href: "" }; }; return set("defchp");
            case "defpap": g.onClose = () => { defP = { ...top().p }; }; return set("defpap");
            case "upr": return set("upr");
            case "ud": if (stack[stack.length - 2]?.dest === "upr") { g.dest = stack[stack.length - 3]?.dest ?? "text"; return true; } return false;
            case "field": { const f = { inst: "" }; fields.push(f); g.onClose = () => { fields.pop(); }; return false; }
            case "fldinst": return set("fldinst");
            case "fldrslt": {
                const inst = fields[fields.length - 1]?.inst ?? "";
                const m = /HYPERLINK\s+(?:\\[a-z]\s+)*"([^"]*)"/i.exec(inst) || /HYPERLINK\s+(?!\\)(\S+)/i.exec(inst);
                if (m && !/^\s*javascript:/i.test(m[1]) && !/HYPERLINK\s+\\l/i.test(inst)) g.c.href = m[1];
                return set("text");
            }
            case "pict": {
                curPict = { kind: "", hex: "", bin: null, picw: 0, pich: 0, gw: 0, gh: 0, sx: 100, sy: 100 };
                const fromShape = g.dest === "shpinst";
                g.onClose = () => finishPict(fromShape);
                return set("pict");
            }
            case "shppict": return true; // Word's modern picture wrapper: read what is inside (the \nonshppict twin is skipped)
            case "shp": counts.shape++; return false;
            case "shpinst": return set("shpinst");
            case "shprslt": if (skipShprslt) { skipShprslt = false; return set("skip"); } return set("text");
            case "footnote": counts.footnote++; return set("skip");
        }
        if (HEADERS.has(word)) {
            const s = newSink(); sinks.push(s);
            g.onClose = () => { flushOpen(s); sinks.pop(); if (!headers.has(word)) headers.set(word, s); };
            return set("text");
        }
        if (SKIP.has(word) || g.star) return set("skip");
        if (g.dest === "info") return set(word === "title" ? "title" : "skip");
        return false;
    }
    function flushOpen(s: Sink) {
        if (s.runs.length || s.listText !== null) { sinks.push(s); endPara(); sinks.pop(); }
        flushTable(s);
    }
    function finishPict(fromShape: boolean) {
        const p = curPict; curPict = null;
        if (!p) return;
        if (p.kind !== "png" && p.kind !== "jpeg") { counts.badPict++; return; }
        let img = p.bin;
        if (!img) {
            const hex = p.hex.replace(/[^0-9a-f]/gi, "");
            img = new Uint8Array(hex.length >> 1);
            for (let k = 0; k < img.length; k++) img[k] = parseInt(hex.substr(k * 2, 2), 16);
        }
        if (!img.length) return;
        const w = (p.gw ? p.gw / 20 : p.picw * 0.75) * p.sx / 100, h = (p.gh ? p.gh / 20 : p.pich * 0.75) * p.sy / 100;
        const src = dataUri(img, imageMime(img, p.kind === "png" ? "image/png" : "image/jpeg"));
        // a picture found inside a shape's properties; the shape's \shprslt repeats it as a WMF we would only drop
        if (fromShape) skipShprslt = true;
        sink().runs.push({ t: "img", src, w, h, c: { ...top().c } });
    }

    /* ---- control words ---- */
    function border(word: string, param: number | null) {
        const g = top();
        const tgt = borderTarget;
        if (!tgt) return;
        const get = (): Border => {
            if (tgt === "t") return (g.p.bt ??= { style: "solid", w: 10, cf: 0, sp: 0 });
            if (tgt === "b") return (g.p.bb ??= { style: "solid", w: 10, cf: 0, sp: 0 });
            const side = tgt.slice(5);
            return (pendingCell.borders[side] ??= { style: "solid", w: 10, cf: 0, sp: 0 });
        };
        if (word === "brdrnone" || word === "brdrnil" || word === "brdrtbl") {
            if (tgt === "t") g.p.bt = null; else if (tgt === "b") g.p.bb = null; else delete pendingCell.borders[tgt.slice(5)];
        } else if (BORDER_STYLES[word]) get().style = BORDER_STYLES[word];
        else if (word === "brdrw") get().w = param ?? 10;
        else if (word === "brdrcf") get().cf = param ?? 0;
        else if (word === "brsp") get().sp = param ?? 0;
    }

    function controlWord(word: string, param: number | null) {
        const g = top();
        if (g.fresh) { g.fresh = false; if (openDest(word, param)) return; }
        else if (g.star) { g.star = false; }
        const d = g.dest;
        if (d === "skip" || d === "upr") return;
        const c = g.c, p = g.p, on = param === null || param !== 0, n = param ?? 0;

        // destination-specific words first: a \f in the font table names a font, it does not select one
        if (d === "fonttbl") {
            if (word === "f") { curFont = { name: "", family: "", charset: 0, weight: 400, italic: false, symbol: false }; fonts.set(n, curFont); return; }
            if (curFont && GENERIC[word]) { curFont.family = GENERIC[word]; return; }
            if (curFont && word === "fcharset") { curFont.charset = n; curFont.symbol = n === 2; return; }
            return;
        }
        if (d === "colortbl") {
            if (word === "red") curColor[0] = n; else if (word === "green") curColor[1] = n; else if (word === "blue") curColor[2] = n;
            if (curColor[0] >= 0 || curColor[1] >= 0 || curColor[2] >= 0) curColor = curColor.map((x) => Math.max(0, x));
            return;
        }
        if (d === "listtable") {
            if (word === "list") { curList = { id: 0, levels: [] }; return; }
            if (word === "listid" && curList) { curList.id = n; lists.set(n, curList.levels); return; }
            if (word === "listlevel" && curList) { curList.levels.push({ nfc: 0, text: "" }); return; }
            if ((word === "levelnfc" || word === "levelnfcn") && curList?.levels.length) { curList.levels[curList.levels.length - 1].nfc = n; return; }
            if (word === "leveltext") { g.dest = "leveltext"; return; }
            return;
        }
        if (d === "listoverridetable") {
            if (word === "listoverride") curOverride = { listid: 0, ls: 0 };
            else if (word === "listid") curOverride.listid = n;
            else if (word === "ls") { curOverride.ls = n; overrides.set(n, curOverride.listid); }
            return;
        }
        if (d === "pict" && curPict) {
            switch (word) {
                case "pngblip": curPict.kind = "png"; return;
                case "jpegblip": curPict.kind = "jpeg"; return;
                case "emfblip": case "wmetafile": case "macpict": case "pmmetafile": case "dibitmap": case "wbitmap": curPict.kind = word; return;
                case "picw": curPict.picw = n; return;
                case "pich": curPict.pich = n; return;
                case "picwgoal": curPict.gw = n; return;
                case "pichgoal": curPict.gh = n; return;
                case "picscalex": curPict.sx = n || 100; return;
                case "picscaley": curPict.sy = n || 100; return;
            }
            return;
        }
        if (d === "style" && styleRec && word === "s") { styleRec.s = n; return; }
        if (d === "shpinst" || d === "stylesheet" || d === "info") return;

        switch (word) {
            // document
            case "ansicpg": ansiCp = n || 1252; return;
            case "mac": ansiCp = 10000; return;
            case "pc": case "pca": ansiCp = 1252; return; // DOS code pages: close enough for the ASCII a résumé uses
            case "deff": deff = n; return;
            case "paperw": case "pgwsxn": page.widthPt ??= n / 20; return;
            case "paperh": case "pghsxn": page.heightPt ??= n / 20; return;
            case "margl": case "marglsxn": page.marginLeftPt ??= n / 20; return;
            case "margr": case "margrsxn": page.marginRightPt ??= n / 20; return;
            case "margt": case "margtsxn": page.marginTopPt ??= n / 20; return;
            case "margb": case "margbsxn": page.marginBottomPt ??= n / 20; return;
            case "cols": if (n > 1) counts.cols = true; return;
            // character
            case "plain": g.c = { ...defC, f: defC.f >= 0 ? defC.f : deff, href: c.href, uc: c.uc }; return;
            case "b": c.b = on; return;
            case "i": c.i = on; return;
            case "ul": case "ulw": case "uld": case "uldb": case "ulth": case "uldash": case "uldashd": case "uldashdd": case "ulwave": case "ulhwave": case "ululdbwave": case "ulthd": case "ulthdash": case "ulldash": case "ulthldash": case "ulthdashd": case "ulthdashdd":
                c.ul = on; return;
            case "ulnone": c.ul = false; return;
            case "strike": case "striked": c.strike = on; return;
            case "fs": c.fs = n ? n / 2 : 12; return;
            case "fsmilli": if (n) c.fs = n / 1000; return; // Cocoa: the exact size in thousandths of a point
            case "f": c.f = n; return;
            case "cf": c.cf = n; return;
            case "cb": case "highlight": case "chcbpat": c.cb = n; return;
            case "caps": case "scaps": c.caps = on; return;
            case "super": c.sup = on; c.sub = false; return;
            case "sub": c.sub = on; c.sup = false; return;
            case "nosupersub": c.sup = c.sub = false; return;
            case "v": c.v = on; return;
            case "expndtw": c.spacing = n / 20; return;
            case "expnd": c.spacing = n / 4; return;
            case "uc": c.uc = n; return;
            // paragraph
            case "pard": g.p = { ...defP, tabs: [...defP.tabs] }; borderTarget = ""; return;
            case "s": p.s = n; return;
            case "outlinelevel": p.outline = n; return;
            case "ql": p.align = ""; return;
            case "qr": p.align = "right"; return;
            case "qc": p.align = "center"; return;
            case "qj": case "qd": p.align = "justify"; return;
            case "li": case "lin": p.li = n; return;
            case "ri": case "rin": p.ri = n; return;
            case "fi": p.fi = n; return;
            case "sb": p.sb = n; return;
            case "sa": p.sa = n; return;
            case "sl": p.sl = n; return;
            case "slmult": p.slmult = n === 1; return;
            case "tqr": p.tabKind = "right"; return;
            case "tqc": p.tabKind = "center"; return;
            case "tqdec": p.tabKind = "decimal"; return;
            case "tx": case "tb": p.tabs = [...p.tabs, { pos: n, kind: p.tabKind || "left" }]; p.tabKind = ""; return;
            case "intbl": p.intbl = true; return;
            case "itap": if (n > 1) counts.nested = true; if (n >= 1) p.intbl = true; return;
            case "ls": p.ls = n; return;
            case "ilvl": p.ilvl = n; return;
            case "pnlvlblt": case "pnlvlbody": return;
            case "cbpat": p.bg = n; return;
            case "brdrt": borderTarget = "t"; return;
            case "brdrb": borderTarget = "b"; return;
            case "box": borderTarget = "b"; p.bt = { style: "solid", w: 10, cf: 0, sp: 0 }; return;
            case "brdrl": case "brdrr": case "brdrbtw": case "brdrbar": case "trbrdrt": case "trbrdrb": case "trbrdrl": case "trbrdrr": case "trbrdrh": case "trbrdrv": borderTarget = ""; return;
            // tables
            case "trowd": rowDefs = []; pendingCell = newCellDef(); trleft = 0; borderTarget = ""; return;
            case "trleft": trleft = n; return;
            case "clbrdrt": borderTarget = "cell-t"; return;
            case "clbrdrb": borderTarget = "cell-b"; return;
            case "clbrdrl": borderTarget = "cell-l"; return;
            case "clbrdrr": borderTarget = "cell-r"; return;
            case "clcbpat": pendingCell.bg = n; return;
            case "clvertalt": pendingCell.valign = "top"; return;
            case "clvertalc": pendingCell.valign = "middle"; return;
            case "clvertalb": pendingCell.valign = "bottom"; return;
            case "clmgf": pendingCell.merge = "first"; return;
            case "clmrg": pendingCell.merge = "cont"; return;
            case "clvmgf": pendingCell.vmerge = "first"; return;
            case "clvmrg": pendingCell.vmerge = "cont"; return;
            case "cellx": pendingCell.x = n; rowDefs.push(pendingCell); pendingCell = newCellDef(); borderTarget = ""; return;
            case "cell": case "nestcell": if (d === "text") endCell(); return;
            case "row": case "nestrow": if (d === "text") endRow(); return;
            // breaks and special characters
            case "par": if (d === "text") endPara(); return;
            case "sect": if (d === "text" && (sink().runs.length || sink().listText !== null)) endPara(); return;
            case "line": addRun({ t: "br", c: { ...c } }); return;
            case "tab": if (d === "text") addRun({ t: "tab", c: { ...c } }); else emit("\t"); return;
            case "page": case "column": case "softline": case "softpage": return;
        }
        if (BORDER_STYLES[word] || word.startsWith("brdr") || word === "brsp") return border(word, param);
        if (word in SPECIAL) emit(SPECIAL[word]);
    }

    function controlSymbol(ch: string) {
        const g = top();
        if (ch === "*") { g.star = true; return; }
        if (g.fresh) { g.fresh = false; if (g.star) { g.dest = "skip"; return; } }
        if (g.dest === "skip") return;
        switch (ch) {
            case "\\": case "{": case "}": emit(ch); return;
            case "~": emit(" "); return;
            case "_": emit("‑"); return;
            case "-": return; // optional hyphen
            case "\n": case "\r": if (g.dest === "text") endPara(); return; // Cocoa writes "\<newline>" for \par
            case "\t": controlWord("tab", null); return;
        }
    }

    /* ---- the tokenizer loop ---- */
    const n = bytes.length;
    let i = 0;
    const isAlpha = (b: number) => (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a);
    while (i < n) {
        const ch = bytes[i];
        if (ch === 0x7b) { // {
            flush(); ucSkip = 0;
            const t = top();
            const child: Group = { c: { ...t.c }, p: { ...t.p }, dest: t.dest === "stylesheet" ? "style" : t.dest, fresh: true, star: false };
            if (t.dest === "stylesheet") { const rec = { s: 0, name: "" }; styleRec = rec; child.onClose = () => { const nm = rec.name.replace(/;.*$/, "").trim(); if (nm && !styles.has(rec.s)) styles.set(rec.s, nm); }; }
            stack.push(child); i++; continue;
        }
        if (ch === 0x7d) { // }
            flush(); ucSkip = 0;
            if (stack.length > 1) { top().onClose?.(); stack.pop(); } // onClose runs while its group is still on top
            i++; continue;
        }
        if (ch === 0x5c) { // backslash
            const nx = bytes[i + 1];
            if (nx !== undefined && isAlpha(nx)) {
                let j = i + 1;
                while (j < n && isAlpha(bytes[j])) j++;
                const word = String.fromCharCode(...bytes.subarray(i + 1, j));
                let param: number | null = null;
                let k = j;
                if (bytes[k] === 0x2d || (bytes[k] >= 0x30 && bytes[k] <= 0x39)) {
                    let neg = false; if (bytes[k] === 0x2d) { neg = true; k++; }
                    let v = 0, digits = 0;
                    while (k < n && bytes[k] >= 0x30 && bytes[k] <= 0x39) { v = v * 10 + bytes[k] - 0x30; k++; digits++; }
                    if (digits) param = neg ? -v : v; else k = j;
                }
                if (bytes[k] === 0x20) k++; // the delimiting space belongs to the control word
                i = k;
                if (word === "bin") {
                    flush();
                    const len = Math.max(0, param ?? 0);
                    const pic = curPict as { bin: Uint8Array | null } | null; // (assigned in closures; TS narrows it to null here)
                    if (top().dest === "pict" && pic) pic.bin = bytes.slice(i, i + len);
                    i += len; continue;
                }
                if (word === "u") {
                    flush();
                    const g = top();
                    if (g.fresh) { g.fresh = false; if (g.star) { g.dest = "skip"; continue; } }
                    if (g.dest !== "skip") emit(String.fromCharCode(((param ?? 0) + 65536) % 65536));
                    ucSkip = g.c.uc;
                    continue;
                }
                if (ucSkip > 0) { ucSkip--; continue; }
                flush();
                controlWord(word, param);
                continue;
            }
            if (nx === 0x27) { // \'hh
                const hex = parseInt(String.fromCharCode(bytes[i + 2], bytes[i + 3]), 16);
                i += 4;
                if (ucSkip > 0) { ucSkip--; continue; }
                const g = top();
                if (g.fresh) { g.fresh = false; if (g.star) { g.dest = "skip"; continue; } }
                if (g.dest !== "skip" && !Number.isNaN(hex)) pending.push(hex);
                continue;
            }
            i += 2;
            if (nx === undefined) continue;
            if (ucSkip > 0 && nx !== 0x2a) { ucSkip--; continue; }
            flush();
            controlSymbol(String.fromCharCode(nx));
            continue;
        }
        if (ch === 0x0d || ch === 0x0a) { i++; continue; }
        if (ucSkip > 0) { ucSkip--; i++; continue; }
        const g = top();
        if (g.fresh) { g.fresh = false; if (g.star) g.dest = "skip"; }
        if (g.dest !== "skip") {
            if (ch === 0x09) { flush(); if (g.dest === "text") addRun({ t: "tab", c: { ...g.c } }); else emit("\t"); } // Cocoa writes literal tabs
            else pending.push(ch);
        }
        i++;
    }
    flush();
    while (stack.length > 1) { top().onClose?.(); stack.pop(); }
    flushOpen(sinks[0]);

    /* ---------------- rendering ---------------- */

    const defFont = defC.f >= 0 ? defC.f : deff >= 0 ? deff : fonts.has(0) ? 0 : -1;
    const fontCss = (f: number): string => {
        const font = fonts.get(f < 0 ? defFont : f);
        if (!font || font.symbol || !font.name) return "";
        const nm = /^[A-Za-z0-9-]+$/.test(font.name) ? font.name : `'${font.name.replace(/'/g, "")}'`;
        return font.family ? `${nm}, ${font.family}` : nm;
    };
    const colorOf = (k: number) => colors[k] || "";
    // Cocoa gives every paragraph a white text background (\cb of #ffffff) that only repaints the paper colour
    const bgOf = (k: number) => { const v = colors[k] || ""; return v === "#ffffff" ? "" : v; };
    const weightOf = (c: CharState) => { const fw = fonts.get(c.f < 0 ? defFont : c.f)?.weight ?? 400; return c.b ? Math.max(700, fw) : fw; };
    const italicOf = (c: CharState) => c.i || !!fonts.get(c.f < 0 ? defFont : c.f)?.italic;
    interface Look { font: string; size: number; color: string; weight: number; italic: boolean; caps: boolean; spacing: number; bg: string }
    const look = (c: CharState): Look => ({ font: fontCss(c.f), size: c.fs, color: colorOf(c.cf), weight: weightOf(c), italic: italicOf(c), caps: c.caps, spacing: c.spacing, bg: bgOf(c.cb) });
    const baseLook = look({ ...defC, f: defFont });
    const baseLine = defP.sl > 0 && defP.slmult ? Math.round(defP.sl / 240 * 100) / 100 : undefined;

    function dominant(para: Para): Look {
        const tally = new Map<string, { n: number; l: Look }>();
        for (const r of para.runs) if (r.t === "text") {
            const w = r.s.replace(/\s/g, "").length; if (!w) continue;
            const l = look(r.c), k = JSON.stringify({ ...l, bg: "" });
            const e = tally.get(k); if (e) e.n += w; else tally.set(k, { n: w, l });
        }
        let best: { n: number; l: Look } | null = null;
        for (const e of tally.values()) if (!best || e.n > best.n) best = e;
        return best ? { ...best.l, bg: "" } : { ...look(para.c), bg: "" };
    }
    const borderCss = (b: Border | null) => (b && b.style !== "none" ? `${pt(Math.max(0.25, b.w / 20))} ${b.style} ${colorOf(b.cf) || "#000000"}` : "");
    const weightCss = (w: number) => (w === 700 ? "bold" : w === 400 ? "normal" : String(w));

    function lineHeight(p: ParState): string | number {
        if (!p.sl) return "";
        if (p.slmult) { const v = Math.round(Math.abs(p.sl) / 240 * 100) / 100; return v === baseLine ? "" : v; }
        return pt(Math.abs(p.sl) / 20); // "at least" / "exactly" N twips
    }
    function blockStyle(para: Para, d: Look, list: boolean): string {
        const p = para.p;
        return styleAttr({
            "text-align": p.align,
            "margin-top": p.sb || para.extraTop ? pt(p.sb / 20 + para.extraTop) : "",
            "margin-bottom": p.sa ? pt(p.sa / 20) : "",
            "margin-left": !list && p.li ? pt(p.li / 20) : "",
            "margin-right": p.ri ? pt(p.ri / 20) : "",
            "text-indent": !list && p.fi ? pt(p.fi / 20) : "",
            "line-height": lineHeight(p),
            "font-family": d.font !== baseLook.font ? d.font : "",
            "font-size": d.size !== baseLook.size ? pt(d.size) : "",
            color: d.color,
            "font-weight": d.weight !== 400 ? weightCss(d.weight) : "",
            "font-style": d.italic ? "italic" : "",
            "text-transform": d.caps ? "uppercase" : "",
            "letter-spacing": d.spacing ? pt(d.spacing) : "",
            "background-color": bgOf(p.bg),
            "border-top": borderCss(p.bt), "padding-top": p.bt?.sp ? pt(p.bt.sp / 20) : "",
            "border-bottom": borderCss(p.bb), "padding-bottom": p.bb?.sp ? pt(p.bb.sp / 20) : "",
        });
    }
    const attr = (style: string) => (style ? ` style="${escAttr(style)}"` : "");

    function inline(para: Para, d: Look, list: boolean): string {
        // tab stops: the Nth tab on a line jumps to the Nth stop past where the line starts
        const p = para.p;
        const stopsFrom = (start: number) => [...p.tabs].sort((a, b) => a.pos - b.pos).filter((t) => t.pos > start);
        let stops = stopsFrom(list ? p.li : p.li + p.fi), si = 0;
        const runs = [...para.runs];
        // trim the paragraph's outer whitespace (RTF writers leave a space before \par)
        const firstText = runs.findIndex((r) => r.t !== "text" || r.s.trim());
        if (firstText > 0) runs.splice(0, firstText);
        if (runs[0]?.t === "text") runs[0] = { ...runs[0], s: runs[0].s.replace(/^\s+/, "") };
        while (runs.length && runs[runs.length - 1].t === "text" && !(runs[runs.length - 1] as { s: string }).s.trim()) runs.pop();
        const last = runs[runs.length - 1];
        if (last?.t === "text") runs[runs.length - 1] = { ...last, s: last.s.replace(/\s+$/, "") };

        const pieces: { href: string; open: string; close: string; body: string; merge: boolean }[] = [];
        for (const r of runs) {
            if (r.t === "br") { stops = stopsFrom(p.li); si = 0; pieces.push({ href: r.c.href, open: "", close: "", body: "<br>", merge: false }); continue; }
            if (r.t === "tab") {
                const st = stops[si++];
                pieces.push({ href: r.c.href, open: "", close: "", body: `<span data-flow-tab="${st ? st.kind : ""}" data-flow-pos="${st ? Math.round(st.pos / 20 * 100) / 100 : ""}"></span>`, merge: false });
                continue;
            }
            if (r.t === "img") { pieces.push({ href: r.c.href, open: "", close: "", body: `<img src="${escAttr(r.src)}" style="${escAttr(styleAttr({ width: r.w ? pt(r.w) : "", height: r.h ? pt(r.h) : "" }))}">`, merge: false }); continue; }
            const l = look(r.c), span: Record<string, string> = {}, tags: string[] = [];
            if (l.font !== d.font && l.font) span["font-family"] = l.font;
            if (l.size !== d.size) span["font-size"] = pt(l.size);
            if (l.color !== d.color) span.color = l.color || "#000000";
            if (l.bg) span["background-color"] = l.bg;
            if (l.caps !== d.caps) span["text-transform"] = l.caps ? "uppercase" : "none";
            if (l.spacing !== d.spacing) span["letter-spacing"] = pt(l.spacing);
            if (l.weight !== d.weight) { if (l.weight === 700 && d.weight === 400) tags.push("strong"); else span["font-weight"] = weightCss(l.weight); }
            if (l.italic !== d.italic) { if (l.italic) tags.push("em"); else span["font-style"] = "normal"; }
            if (r.c.ul) tags.push("u");
            if (r.c.strike) tags.push("s");
            if (r.c.sup) tags.push("sup"); else if (r.c.sub) tags.push("sub");
            const sp = styleAttr(span);
            const open = (sp ? `<span style="${escAttr(sp)}">` : "") + tags.map((t) => `<${t}>`).join("");
            const close = [...tags].reverse().map((t) => `</${t}>`).join("") + (sp ? "</span>" : "");
            pieces.push({ href: r.c.href, open, close, body: esc(r.s), merge: true });
        }
        let out = "", k = 0;
        while (k < pieces.length) {
            const href = pieces[k].href;
            let seg = "";
            while (k < pieces.length && pieces[k].href === href) {
                const pc = pieces[k]; let body = pc.body;
                while (pc.merge && pieces[k + 1]?.merge && pieces[k + 1].href === href && pieces[k + 1].open === pc.open) body += pieces[++k].body;
                seg += pc.open + body + pc.close; k++;
            }
            out += href ? `<a href="${escAttr(href)}">${seg}</a>` : seg;
        }
        return out;
    }

    const isEmpty = (para: Para) => !para.runs.some((r) => (r.t === "text" ? r.s.trim() : r.t === "img" || r.t === "tab"));
    const onlyImage = (para: Para) => { const real = para.runs.filter((r) => r.t !== "text" || r.s.trim()); return real.length === 1 && real[0].t === "img"; };

    function listKind(para: Para): { tag: string; type: string } {
        const L = para.list!;
        const levels = lists.get(overrides.get(L.ls) ?? -1);
        const lv = levels?.[L.ilvl] ?? levels?.[0];
        if (lv) {
            if (lv.nfc !== 23 && lv.nfc !== 255 && NFC[lv.nfc]) return { tag: "ol", type: NFC[lv.nfc] };
            if (lv.nfc === 255) return { tag: "ul", type: "none" };
            return { tag: "ul", type: bulletType(lv.text.replace(/^[\x00-\x1f]/, "").replace(/[\x00-\x1f]/g, "").trim() || L.text) };
        }
        const t = L.text;
        if (/^\(?\d+[.)]?$/.test(t)) return { tag: "ol", type: "decimal" };
        if (/^\(?[ivxlc]+[.)]$/.test(t)) return { tag: "ol", type: "lower-roman" };
        if (/^\(?[IVXLC]+[.)]$/.test(t)) return { tag: "ol", type: "upper-roman" };
        if (/^\(?[a-z][.)]$/.test(t)) return { tag: "ol", type: "lower-alpha" };
        if (/^\(?[A-Z][.)]$/.test(t)) return { tag: "ol", type: "upper-alpha" };
        return { tag: "ul", type: bulletType(t) };
    }
    function bulletType(ch: string): string {
        const c = [...ch.trim()][0] ?? "";
        if (!c || "•·●∙".includes(c)) return "disc";
        if ("◦○o".includes(c)) return "circle";
        if ("▪■◼▫□".includes(c)) return "square";
        return `'${c.replace(/'/g, "")} '`;
    }
    const headingLevel = (p: ParState): number => {
        const m = /^heading\s*([1-6])$/i.exec(styles.get(p.s) ?? "");
        if (m) return Number(m[1]);
        return p.outline >= 0 && p.outline <= 5 ? p.outline + 1 : 0;
    };

    function renderParas(paras: Para[]): string {
        let out = "";
        const open: { key: string; tag: string; liOpen: boolean; li: number }[] = [];
        const closeTo = (depth: number) => { while (open.length > depth) { const e = open.pop()!; out += (e.liOpen ? "</li>" : "") + `</${e.tag}>`; } };
        for (const para of paras) {
            const d = dominant(para);
            if (!para.list) {
                closeTo(0);
                if (onlyImage(para)) {
                    const img = para.runs.find((r) => r.t === "img") as Extract<Run, { t: "img" }>;
                    const inner = `<img src="${escAttr(img.src)}" style="${escAttr(styleAttr({ width: img.w ? pt(img.w) : "", height: img.h ? pt(img.h) : "" }))}">`;
                    out += `<figure${attr(styleAttr({ "text-align": para.p.align || "left" }))}>${img.c.href ? `<a href="${escAttr(img.c.href)}">${inner}</a>` : inner}</figure>`;
                    continue;
                }
                if (isEmpty(para) && (para.p.bb || para.p.bt)) { // a blank paragraph drawn as a line is a rule
                    out += `<hr${attr(styleAttr({ "border-top": borderCss(para.p.bb || para.p.bt), "margin-top": para.extraTop || para.p.sb ? pt(para.p.sb / 20 + para.extraTop) : "", "margin-bottom": para.p.sa ? pt(para.p.sa / 20) : "" }))}>`;
                    continue;
                }
                const h = headingLevel(para.p), tag = h ? `h${h}` : "p";
                out += `<${tag}${attr(blockStyle(para, d, false))}>${inline(para, d, false)}</${tag}>`;
                continue;
            }
            const { tag, type } = listKind(para);
            let L = Math.max(0, para.list.ilvl);
            if (L > open.length) L = open.length;
            const key = `${para.list.ls}|${tag}|${type}`;
            closeTo(L + 1);
            if (open.length === L + 1 && open[L].key !== key) closeTo(L);
            if (open.length === L + 1) { if (open[L].liOpen) out += "</li>"; }
            else {
                // the list's indent is where its text starts (\li), measured from the enclosing list's text
                const indent = para.p.li / 20 - (L ? open[L - 1].li : 0);
                out += `<${tag}${attr(styleAttr({ "list-style-type": type, "margin-left": indent > 0 ? pt(indent) : "" }))}>`;
                open.push({ key, tag, liOpen: false, li: para.p.li / 20 });
            }
            out += `<li${attr(blockStyle(para, d, true))}>${inline(para, d, true)}`;
            open[L].liOpen = true;
        }
        closeTo(0);
        return out;
    }

    function renderTable(rows: Row[]): string {
        let out = "<table>";
        const vspan = new Map<string, { n: number; set: (n: number) => void }>();
        const rowHtml: string[][] = [];
        rows.forEach((row) => {
            const cells: string[] = [];
            let prevX = row.left;
            for (let c = 0; c < row.cells.length; c++) {
                const def = row.defs[c] ?? newCellDef();
                if (def.merge === "cont") { prevX = def.x; continue; }
                let span = 1, x = def.x;
                while (row.defs[c + span]?.merge === "cont" && def.merge === "first") { x = row.defs[c + span].x; span++; }
                const key = String(x);
                if (def.vmerge === "cont" && vspan.has(key)) { const v = vspan.get(key)!; v.set(++v.n); prevX = x; c += span - 1; continue; }
                const idx = cells.length;
                const st = styleAttr({
                    width: x > prevX ? pt((x - prevX) / 20) : "",
                    "vertical-align": def.valign,
                    "background-color": bgOf(def.bg),
                    "border-top": borderCss(def.borders.t ?? null), "border-bottom": borderCss(def.borders.b ?? null),
                    "border-left": borderCss(def.borders.l ?? null), "border-right": borderCss(def.borders.r ?? null),
                });
                const content = renderParas(row.cells[c].filter((p) => !isEmpty(p) || p.list));
                cells.push(`<td${span > 1 ? ` colspan="${span}"` : ""}${attr(st)}>${content}</td>`);
                if (def.vmerge === "first") {
                    const holder = cells;
                    vspan.set(key, { n: 1, set: (rs) => { holder[idx] = holder[idx].replace(/^<td( rowspan="\d+")?/, `<td rowspan="${rs}"`); } });
                } else vspan.delete(key);
                prevX = x; c += span - 1;
            }
            rowHtml.push(cells);
        });
        for (const r of rowHtml) out += `<tr>${r.join("")}</tr>`;
        return out + "</table>";
    }

    function renderSink(s: Sink): string {
        // blank paragraphs are spacing: fold their height into the next block's top margin
        let out = "", run: Para[] = [], extra = 0, started = false;
        const flushRun = () => { if (run.length) out += renderParas(run); run = []; };
        for (const it of s.items) {
            if (it.kind === "table") { flushRun(); out += renderTable(it.rows); started = true; extra = 0; continue; }
            const para = it.para;
            if (isEmpty(para) && !para.list && !para.p.bb && !para.p.bt) {
                if (started) { const lh = para.p.sl && !para.p.slmult ? Math.abs(para.p.sl) / 20 : para.c.fs * 1.2 * (para.p.sl && para.p.slmult ? para.p.sl / 240 : 1); extra += lh + (para.p.sb + para.p.sa) / 20; }
                continue;
            }
            para.extraTop = Math.round(extra * 100) / 100; extra = 0; started = true;
            run.push(para);
        }
        flushRun();
        return out;
    }

    const hasText = (s: Sink) => s.items.some((it) => it.kind === "table" || !isEmpty(it.para));
    let html = renderSink(sinks[0]);
    const hdrKey = ["headerf", "header", "headerr"].find((k) => headers.has(k) && hasText(headers.get(k)!));
    if (hdrKey) {
        html = renderSink(headers.get(hdrKey)!) + html;
        warn("The page header was placed at the top of the document; it will not repeat on every page.");
    }
    if (["footer", "footerr", "footerf", "footerl"].some((k) => headers.has(k) && hasText(headers.get(k)!))) warn("The page footer was left out.");
    if (counts.badPict) warn(`${counts.badPict} picture${counts.badPict > 1 ? "s" : ""} in a format IcedCoffee can't show (WMF, EMF or PICT) ${counts.badPict > 1 ? "were" : "was"} left out.`);
    if (counts.footnote) warn(`${counts.footnote} footnote${counts.footnote > 1 ? "s were" : " was"} left out.`);
    if (counts.shape) warn("Floating shapes or text boxes were placed in the text flow where they sit in the file.");
    if (counts.nested) warn("A table inside a table was flattened into its outer table.");
    if (counts.cols) warn("A multi-column section was imported as a single column.");

    const base: FlowResult["base"] = {};
    if (baseLook.font) base.fontFamily = baseLook.font;
    base.fontSizePt = baseLook.size;
    if (baseLine) base.lineHeight = baseLine;
    return { html, title: title.trim() || undefined, page: Object.keys(page).length ? page : undefined, base, warnings };
}
