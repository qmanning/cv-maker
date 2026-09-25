# Importing documents — Disconnected vs. AI-Connected features

**The rule:** everything that *can* be done with rules runs in the app, offline, with no AI. The person's own AI is only
offered for the jobs rules can't do, and the app always says which is which. Code: `src/import/`
(one converter per format → a shared "FlowDoc" → `structure.ts`, the rules that decide what each piece is).

Every import opens as a **new, unsaved document**. The Word file, PDF or other source on disk is only ever read, never
written over. **Save (⌘S)** makes it an IcedCoffee file.

---

## Disconnected features (no AI, no network, always available)

### Formats
| Format | How it's read | Formatting that comes across |
|---|---|---|
| **Word (.docx, .docm, .dotx)** | Its XML (styles, numbering, theme, relationships) | Style inheritance and theme fonts; font, size, colour, bold/italic/underline/strike, caps and small caps, letter-spacing, highlight; alignment, spacing, line height, indents, paragraph borders and shading; **tab stops, so dates on the right stay on the right**; bullet and numbered lists with nesting; tables (merged cells, widths, borders, shading; borderless layout tables stay side by side); inline and floating pictures; text boxes; section columns; page size and margins; links; a name block in the first-page header |
| **PDF** (with a text layer) | pdf.js, rebuilt from the positions of the text on the page | Lines reassembled into paragraphs; fonts, sizes, weights, colours; centred and right-aligned lines; dates at the right margin; bullets (typed, symbol-font or drawn dots) with wrapped lines; **sidebar and two-column layouts**; rules under headings; logos and photos (cropped from the page); links; running headers, footers and page numbers removed; page size and margins |
| **RTF** (Word, WordPad, TextEdit) | A full RTF parser | Code pages and Unicode; fonts, sizes, colours, bold/italic/underline/strike, highlight, caps, letter-spacing; alignment, indents, spacing, borders; tab stops; lists; tables; PNG/JPEG pictures; links; page size and margins |
| **HTML** (any résumé page, not just IcedCoffee's) | **Rendered offscreen**, then read back as drawn | Fonts, sizes, colours and weights as displayed; spacing measured from the layout; **columns detected from where boxes sit** (grid, flex, floats); "title … dates" rows; lists; tables; embedded pictures; rules and borders |
| **Markdown (.md)** | Built-in parser | Headings, bold/italic/strike, links, bullets and numbers (nested), quotes, rules, tables, embedded pictures; `Title \| 2021 – Present` puts dates on the right. Gets a clean default résumé look |
| **Plain text (.txt)** | Built-in parser (UTF-8/16, old Windows encodings) | Paragraphs (hard wraps joined), typed bullets and numbers, CAPITALISED or underlined headings, rules, indentation, `Title⟶2019 – 2023` dates on the right. Gets a clean default look |
| IcedCoffee's own HTML | Opens as it is | Everything (it is the native format) |

### What the rules work out (every format)
- **Header:** the name, and contact lines under it (email, phone, links). Kept as one block, so a cover letter can mirror it.
- **Section headings:** short lines set apart by capitals, bold, size or a rule, or that read like a section ("Experience", "Skills"…). A headline right under the name stays in the header.
- **Entries (jobs, degrees):** a line with a date range, or a bold title with a dates line under it. Each becomes a repeatable entry (duplicate, move, delete), with title and dates as separate editable pieces.
- **Everything editable:** text lands in editable regions. Spacing, borders, per-paragraph fonts, tables, columns and pictures live in a stylesheet generated from the source's own measurements, so editing can't break the look.
- **Links:** emails and web addresses typed as plain text become links.
- **Cover letters:** a greeting, a sign-off and no résumé sections means a letter. It goes to the Cover Letter tab.
- **A report after every import:** what was found (sections, entries, images, tables) and, in plain words, anything that couldn't come across.

### Where to import from
- **Import / Open button** and **⌘O**. The dialog shows every supported type.
- **Drag a file onto the window** (desktop).
- **Any connected AI app over MCP:** `open_document` with a file path imports it and reports what it found. The conversion itself is still rules, not AI.

---

## AI-Connected features (only with the person's own AI; the app says when one would help)

| Feature | When it's offered | What the AI does, and doesn't do |
|---|---|---|
| **Read a scanned PDF** ("Read it with AI") | A PDF with no text layer (pictures of pages). Without an AI the page images still come in, so the person sees their document, and the app says why it can't be edited | The AI **only reads** the page images and writes out the text (up to 8 pages). The same import rules then build the document. Needs a model that can see images: any Claude model, or a vision model on an OpenAI-compatible server |
| **Tidy with AI** | An import where the rules found little structure (no name found, no section headings in a long document) | Uses the normal edit operations to move and regroup content into name, sections, entries and bullets. **Told not to add, remove or reword anything.** The imported look stays, and it's one step Undo can reverse |
| **Reorganise from an AI app (MCP)** | `open_document` reports `rough: true` or `needs_you` | The outside AI (Claude Desktop, ChatGPT…) reads the result with `get_document` and can regroup it with `edit_document` |

With no AI connected, these show a **Connect your AI** button instead. Nothing is ever sent anywhere without the person clicking.

---

## Not supported yet (either mode)
- **Old Word .doc, Pages, OpenDocument (.odt), Google Docs shortcuts, Safari web archives.** The app names the format and says how to save it as .docx or HTML.
- **Word:** charts, SmartArt, embedded objects, EMF/WMF/TIFF pictures, decorative shapes, and text-box fills and outlines are left out, with a warning. Footers are dropped. List start numbers aren't kept.
- **PDF:**
  - Real tables come in as tab-separated lines. Three or more columns aren't recognised.
  - Rotated text isn't supported.
  - White text on a coloured banner comes in, but the banner doesn't.
  - Letter-spacing isn't kept.
  - Asian-language PDFs without text maps can't be read.
- **RTF:** WMF/EMF/PICT pictures are dropped. Floating shapes and text boxes go into the text flow. Nested tables are flattened.
- **Markdown / HTML:** pictures linked from the web or a file path can't be embedded; the alt text is kept, with a warning.

## Known approximations
- **Floating Word items:** those anchored to a paragraph are placed by estimate (with a warning). Page-anchored ones are exact.
- **PDF paragraphs:** in narrow columns, joining lines into paragraphs is a judgement call. Short separate lines can merge.
- **Columns without an explicit break** (Word sections) are split by estimate, with a warning.
- **Plain text:** heading and bullet detection is a best guess. A capitalised address line can read as a heading.
