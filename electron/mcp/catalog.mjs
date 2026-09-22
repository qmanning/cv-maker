// electron/mcp/catalog.mjs — WHAT Itera offers an AI app: the instructions, the tools, and how each tool maps onto the app.
// No dependencies, no I/O: it is loaded twice on purpose —
//   • by the running APP (mcp.mjs), which is the authority: it serves this catalogue over the local socket, so an AI app
//     always gets the tools of the Itera that is actually installed and running;
//   • by the stdio server (server.mjs) only as a fallback for when Itera isn't open yet.
// That split exists because AI apps keep the stdio server process alive for hours: after an update the file on disk is new
// but the process still holds the old script. Anything that lives here can change without that process being restarted.

export const INSTRUCTIONS = `Itera is a desktop editor for a résumé AND its cover letter; these tools act on what the person has open in it right now, and they watch the page change as you work.

Two documents: Itera holds a résumé and a cover letter side by side (two tabs, two files). Every document tool REQUIRES "document": "resume" or "cover_letter" — always name which one; the two are separate files and there is no default, so an edit can never land on the wrong one. Ids (b0, r0, i0 …) belong to ONE document: call get_document with the same "document" before editing it. The cover letter's header is a read-only copy of the résumé's header — change the name, contact details or headline on the résumé and the letter follows; the letter's own regions are its date, recipient, greeting, body and sign-off.

Always call get_document first (with the "document" you mean). It returns top-level blocks (b0, b1, …; kind "job" = an experience entry, "divider" = a rule) holding editable regions (r0, r1, …) whose "html" is the current content. Change a document only with edit_document: you send operations, the editor applies them as one step the person can undo, and the template's layout and CSS are never yours to touch.

HTML for a region: only p, ul, ol, li, strong, em, u, a (href) and br. A region with "list": true must stay exactly one list whose items are <li><p>…</p></li>. Match the shape of what is there (a title stays one short line, a dates line stays dates).

This is someone's real résumé. Work only from facts in the document or given by the person; never invent employers, titles, dates, numbers, degrees or skills. If you need information you do not have, ask the person instead of editing.

Files: each document is a file. list_documents shows the recent ones (one may be marked master: the person's base résumé) and which is open. To START a cover letter, call new_document with document "cover_letter". To tailor a résumé for a job, open_document the master, then save_document with save_as (e.g. "Acme — Product Designer") BEFORE editing, so the master is never changed; exports are named after the open file. open_document refuses while there are unsaved changes: save_document first, or ask the person. Never save over a document the person did not ask you to change.

Page and images: get_page_setup / set_page_setup read and change paper size, fit-to-one-page, pagination and zoom. list_images / replace_image swap a picture (a photo, a logo) for an image file on this computer. export_document writes a PDF, PNG, Word (docx) or Source HTML file to Downloads.

ATS keywords: when the person gives you a job ad, read it and call set_keywords with the 8 to 25 words and short phrases an applicant tracking system will screen for, spelled as the ad spells them (plus "job": the role and company). Itera shows them in a panel beside the page: which ones the résumé and the cover letter already use, how often, and the person can click one to see where. get_keywords returns the same counts to you, for both documents, so check it after editing. Only work a keyword in where it is TRUE of this person. A keyword they cannot honestly claim stays missing: say so instead of stuffing it.

Layout: a region with "columns": 2 flows its bullets across two columns, so an even number of bullets balances (three leaves a gap). Treat that as the default, not a rule: the person can ask for otherwise, and it only applies where "columns" is given. When two lists sit side by side, keep them comparable in length and in how much detail each item carries.

edit_document reports pages_before and pages_after. If your edit pushed a document onto another page, tighten what you just wrote (same facts, fewer words) and call edit_document again, unless the person asked for more pages. After editing, tell the person briefly what you changed. Ids are re-issued by every get_document, so call it again (with the same document) before a second round of edits.`;

const OP = {
    type: "object", additionalProperties: false, required: ["op", "target"],
    properties: {
        op: { type: "string", enum: ["set_text", "insert_block", "duplicate_block", "delete_block", "move_block"] },
        target: { type: "string", description: "set_text: a region id (r3). delete_block / duplicate_block / move_block: a block id (b2). insert_block: the block id to insert AFTER, or \"start\"." },
        html: { type: "string", description: "set_text: the region's new content." },
        kind: { type: "string", enum: ["content", "experience", "dual", "divider"], description: "insert_block: content = a paragraph; experience = a job entry (title, dates, bullets); dual = two lists side by side; divider = a rule." },
        fill: { type: "array", items: { type: "string" }, description: "insert_block / duplicate_block: HTML for the new block's regions, in order (an experience block is title, dates, bullets)." },
        to: { type: "string", description: "move_block: the block id to place it AFTER, or \"start\"." },
    },
};
const DOC = { document: { type: "string", enum: ["resume", "cover_letter"], description: "Which document to act on: the résumé or its cover letter. Always say which — the two are separate files." } };
const REQ_DOC = ["document"];   // every document tool must name its document, so an edit never lands on the wrong tab
export const TOOLS = [
    { name: "get_document", description: "Read a document open in Itera — the résumé or the cover letter (say which in `document`): its blocks and editable regions (with ids), the file name, how many pages it fills, and whether the editor is shrinking it to fit. Call this before editing that document. Ids belong to this document only.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC } }, annotations: { readOnlyHint: true, title: "Read the résumé or cover letter" } },
    { name: "edit_document", description: "Change one document — the résumé or the cover letter (say which in `document`). Operations apply in order as ONE undoable step; ids refer to that document as get_document last returned it, even after earlier operations in the same call. Returns applied / skipped and pages_before / pages_after. Batch all your changes into one call.", inputSchema: { type: "object", additionalProperties: false, required: ["document", "summary", "ops"], properties: { ...DOC, summary: { type: "string", description: "One short sentence shown to the person inside Itera, e.g. \"Tightened the Halcyon bullets.\"" }, ops: { type: "array", minItems: 1, items: OP } } }, annotations: { title: "Edit the résumé or cover letter", destructiveHint: false } },
    { name: "undo_last_edit", description: "Take back the most recent edit_document or replace_image on that document.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC } }, annotations: { title: "Undo the last edit" } },
    { name: "export_document", description: "Export one document — the résumé or the cover letter (say which in `document`) — to Downloads: pdf (real, selectable text), png, docx (Word, ATS-friendly) or html (re-loadable Source HTML). Named after that file. Returns the path.", inputSchema: { type: "object", additionalProperties: false, required: ["document", "format"], properties: { ...DOC, format: { type: "string", enum: ["pdf", "png", "docx", "html"] } } }, annotations: { title: "Export the résumé" } },
    { name: "list_documents", description: "For the résumé and for the cover letter: the recent files (name, path, which is pinned as the master), which file is open, whether it has unsaved changes — and which of the two is showing.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true, title: "List recent résumés" } },
    { name: "open_document", description: "Open a résumé in Itera — what the person does with the Import/Open button. Pass a name from list_documents (e.g. the master) or an absolute path to an .html file. The file itself says whether it is a résumé or a cover letter, and it opens in that tab. Refuses if that document has unsaved changes. Call get_document afterwards: ids are new.", inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", description: "A document name from list_documents, or an absolute file path." }, document: { type: "string", enum: ["resume", "cover_letter"], description: "Optional: look among these first when two files share a name." } } }, annotations: { title: "Open a résumé" } },
    { name: "save_document", description: "Save a document (say which in `document`) to its file. With save_as, save a COPY under that name instead (beside the current file; it becomes the open document and names future exports) — branch a tailored résumé off the master, or rename. Never overwrites a different existing file.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC, save_as: { type: "string", description: "A new document name, without a folder or extension, e.g. \"Acme — Product Designer\"." } } }, annotations: { title: "Save the résumé" } },
    { name: "get_page_setup", description: "Paper size, fit-to-one-page, pagination and zoom (shared by both documents), plus how many pages the document fills and the fit scale in effect.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC } }, annotations: { readOnlyHint: true, title: "Read the page setup" } },
    { name: "set_page_setup", description: "Change any of: paper (\"letter\" or \"a4\"), fit_to_one_page (scale the design down, never below 80%, to land on one sheet), paginate (pages + page numbers vs one continuous page), zoom (\"width\", \"height\", or a number: 1.25 = 125%; view only). Returns the resulting setup including pages.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC, paper: { type: "string", enum: ["letter", "a4"] }, fit_to_one_page: { type: "boolean" }, paginate: { type: "boolean" }, zoom: { anyOf: [{ type: "string", enum: ["width", "height"] }, { type: "number", minimum: 0.25, maximum: 4 }] } } }, annotations: { title: "Change the page setup" } },
    { name: "set_keywords", description: "Show the ATS keywords for a job in Itera's keyword panel (replaces the current list; one list covers the résumé and the cover letter). Returns how often each document uses each keyword, and which are missing from both.", inputSchema: { type: "object", additionalProperties: false, required: ["keywords"], properties: { keywords: { type: "array", maxItems: 60, items: { type: "string" }, description: "Words and short phrases the ad screens for, spelled as the ad spells them." }, job: { type: "string", description: "The role and company, shown above the list." } } }, annotations: { title: "Set the ATS keywords" } },
    { name: "get_keywords", description: "The ATS keyword list in Itera with, for each keyword, how many times the résumé and the cover letter use it right now.", inputSchema: { type: "object", additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true, title: "Read ATS keyword coverage" } },
    { name: "new_document", description: "Start a fresh résumé or cover letter from Itera's template (say which in `document`), like File ▸ New. Use this to begin a cover letter. Refuses if that document has unsaved changes. Returns the new document's blocks and region ids, so you can fill it in with ONE edit_document call — no need to get_document first.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC } }, annotations: { title: "Start a new résumé or cover letter" } },
    { name: "list_images", description: "Every image in the document (say which in `document`): id (i0, i1, …), alt text and pixel size. The letter's header images are copies of the résumé's — replace them on the résumé.", inputSchema: { type: "object", additionalProperties: false, required: REQ_DOC, properties: { ...DOC } }, annotations: { readOnlyHint: true, title: "List the résumé's images" } },
    { name: "replace_image", description: "Replace one image with an image file on this computer (png, jpg, gif, webp, svg; up to 8 MB). It is embedded in the résumé file. One undoable step (undo_last_edit).", inputSchema: { type: "object", additionalProperties: false, required: ["document", "image", "path"], properties: { ...DOC, image: { type: "string", description: "An id from list_images, e.g. i0." }, path: { type: "string", description: "Absolute path to the new image file." }, alt: { type: "string", description: "New alt text (optional)." } } }, annotations: { title: "Replace an image" } },
];


export const text = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }], ...(isError ? { isError: true } : {}) });

/** run one tool. `app(method, params)` is the transport to the editor: the socket (stdio server) or a direct call (the app itself). */
// tools that act on ONE document must name it, so an edit never lands on the wrong tab
const NEEDS_DOC = new Set(["get_document", "edit_document", "undo_last_edit", "export_document", "save_document", "get_page_setup", "set_page_setup", "new_document", "list_images", "replace_image"]);

export async function callTool(name, args, app) {
    const doc = args?.document;
    if (NEEDS_DOC.has(name) && doc !== "resume" && doc !== "cover_letter")
        return text(`${name} needs "document": "resume" or "cover_letter" — say which one this is for, so the edit never lands on the wrong tab.`, true);
    if (name === "get_document") return text(await app("describe", { document: doc }));
    if (name === "edit_document") {
        if (!Array.isArray(args?.ops) || !args.ops.length) return text("Send at least one operation in ops.", true);
        const out = await app("apply", { document: doc, ops: args.ops, summary: String(args.summary || "") });
        const spilled = out.pages_after > out.pages_before;
        return text({ ...out, note: spilled ? `It now runs to ${out.pages_after} pages (it was ${out.pages_before}). Unless the person wants that, tighten what you just wrote and call edit_document again.` : out.applied ? "Applied. The person can see it and has an Undo button in Itera." : "Nothing was applied; see skipped." });
    }
    if (name === "undo_last_edit") return text(await app("undo", { document: doc }));
    if (name === "export_document") return text(await app("export", { document: doc, format: args?.format }));
    if (name === "new_document") return text({ ...(await app("new", { document: doc })), note: "This document is blank from the template — fill it with one edit_document call using the ids above." });
    if (name === "list_documents") return text(await app("documents"));
    if (name === "open_document") return text({ ...(await app("open", { name: args?.name, document: doc })), note: "Call get_document (with the same document) now: this is a different document and the ids are new." });
    if (name === "save_document") return text(await app("save", { document: doc, save_as: args?.save_as }));
    if (name === "get_page_setup") return text(await app("page_get", { document: doc }));
    if (name === "set_page_setup") return text(await app("page_set", args || {}));
    if (name === "set_keywords") return text(await app("keywords_set", { keywords: args?.keywords, job: args?.job }));
    if (name === "get_keywords") return text(await app("keywords_get"));
    if (name === "list_images") return text(await app("images", { document: doc }));
    if (name === "replace_image") return text(await app("image_set", { document: doc, image: args?.image, path: args?.path, alt: args?.alt }));
    return text(`Unknown tool: ${name}`, true);
}

