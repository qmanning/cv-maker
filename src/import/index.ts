// src/import/index.ts — "open this file" for anything that isn't already an IcedCoffee document.
// Picks the converter by extension (each one is its own lazily loaded chunk: a Markdown import never downloads
// pdf.js), then hands its FlowDoc to the structurer. Rules only — nothing here talks to an AI. When the rules
// can't do the job the report says so (`needsAi`, `rough`) and the editor offers the person's AI, if they have one.
import { type FlowResult, type ImportFormat, formatOf } from "./flow";
import { type ImportReport, structure } from "./structure";

export type { ImportReport } from "./structure";
export { formatOf, IMPORT_EXTENSIONS } from "./flow";

export interface Imported {
    /** a complete Source HTML file */
    text: string;
    name: string;
    kind: "resume" | "letter";
    /** null when the file already was an IcedCoffee document and was opened as it is */
    report: ImportReport | null;
}

/** what the Open dialog and the file picker accept */
export const ACCEPT = ".html,.htm,.xhtml,.docx,.docm,.dotx,.rtf,.pdf,.md,.markdown,.mdown,.mkd,.txt,.text";

/** formats people will try that have no reader here, and what to do instead */
const ELSEWHERE: Record<string, string> = {
    doc: "an older Word format (.doc). Open it in Word, Pages or Google Docs and save it as .docx, then import that.",
    pages: "a Pages document. In Pages choose File ▸ Export To ▸ Word…, then import the .docx.",
    odt: "an OpenDocument file. Save it as .docx from LibreOffice or Google Docs, then import that.",
    gdoc: "a shortcut to a Google Doc. In Google Docs choose File ▸ Download ▸ Microsoft Word (.docx), then import that.",
    webarchive: "a Safari web archive. Save the page as HTML (Page Source) instead, then import that.",
};

const decode = (data: ArrayBuffer | Uint8Array | string): string => (typeof data === "string" ? data : new TextDecoder("utf-8").decode(data));
const bytes = (data: ArrayBuffer | Uint8Array | string): ArrayBuffer => {
    if (typeof data === "string") return new TextEncoder().encode(data).buffer as ArrayBuffer;
    if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return data;
};

/** an IcedCoffee file (its own template or one saved from here) opens exactly as it is */
export const isNative = (html: string): boolean => /\bdata-cv-edit\b/.test(html);

/** a cover letter reads like one: a greeting, a sign-off, and no résumé sections */
const looksLikeLetter = (html: string, report: ImportReport): boolean => {
    const text = html.replace(/<[^>]+>/g, " ");
    return report.sections.length <= 1 && report.entries === 0 && /\bDear\b[^.\n]{0,80}[,:]/i.test(text) && /\b(Sincerely|Best regards|Kind regards|Warm regards|Regards|Best wishes|Respectfully|Thank you for your (time|consideration))\b/i.test(text);
};

export async function importDocument(file: { name: string; data: ArrayBuffer | Uint8Array | string }): Promise<Imported> {
    const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || ["", ""])[1].toLowerCase();
    const format: ImportFormat | null = formatOf(file.name);
    const base = file.name.replace(/\.[a-z0-9]+$/i, "");
    if (!format) throw new Error(ELSEWHERE[ext] ? `That is ${ELSEWHERE[ext]}` : `IcedCoffee can't read .${ext || "?"} files. It imports Word (.docx), PDF, RTF, HTML, Markdown and plain text.`);

    let flow: FlowResult;
    switch (format) {
        case "html": {
            const text = decode(file.data);
            if (isNative(text)) return { text, name: base, kind: /data-cv-kind="letter"|data-cv-mirror="header"/.test(text) ? "letter" : "resume", report: null };
            flow = await (await import("./html")).htmlToFlow(text, base);
            break;
        }
        case "docx": flow = await (await import("./docx")).docxToFlow(bytes(file.data), base); break;
        case "rtf": flow = await (await import("./rtf")).rtfToFlow(bytes(file.data), base); break;
        case "pdf": flow = await (await import("./pdf")).pdfToFlow(bytes(file.data), base); break;
        case "md": flow = await (await import("./markdown")).markdownToFlow(bytes(file.data), base); break;
        case "txt": flow = await (await import("./text")).textToFlow(bytes(file.data), base); break;
    }
    // first as a résumé; a letter is re-read as one (no entries, and its header is its own)
    let out = structure(flow, { kind: "resume", format, fallbackName: base });
    let kind: "resume" | "letter" = "resume";
    if (looksLikeLetter(flow.html, out.report)) { kind = "letter"; out = structure(flow, { kind, format, fallbackName: base }); }
    return { text: out.text, name: out.name, kind, report: out.report };
}

/** one plain sentence for the toast: what came across */
export function describeImport(report: ImportReport, fileName: string): string {
    const bits = [
        report.sections.length ? `${report.sections.length} section${report.sections.length > 1 ? "s" : ""}` : "",
        report.entries ? `${report.entries} entr${report.entries > 1 ? "ies" : "y"}` : "",
        report.images ? `${report.images} image${report.images > 1 ? "s" : ""}` : "",
        report.tables ? `${report.tables} table${report.tables > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    return `Imported ${fileName}${bits.length ? ` — ${bits.join(", ")}` : ""}. Save (⌘S) to keep it as an IcedCoffee file.`;
}

/** what the person's own AI is asked when the rules found little structure. It edits with the same operations as
 *  always (so the imported look stays), only reorganising — never inventing. */
export const TIDY_PROMPT = "This résumé was just imported from another file and IcedCoffee's automatic import couldn't fully work out its structure. Reorganise it without changing any facts or wording: put the name and contact details at the top, give each section a heading, make each job or degree its own experience entry (title, dates, bullets), and turn lists of achievements into bullets. Don't add, remove or reword anything.";
