# Changelog

All notable changes to IcedCoffee. Format: [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Pull requests add their entry under **Unreleased**; a release moves it under a version.

## [Unreleased]

### Changed
- **CV Maker → Itera → IcedCoffee.** The repo is `qmanning/icedcoffee` (GitHub redirects the old addresses), the page is qmanning.com/labs/icedcoffee (old ones redirect), the built files are `dist/icedcoffee.js` / `dist/icedcoffee.css`, the config global is `window.ICEDCOFFEE` and the mount point `#icedcoffee` — **`window.ITERA` / `window.CV_MAKER` and `#cv-maker` still work**, so an existing install keeps running after you copy the new files in. The desktop app is *IcedCoffee.app*; its MCP server is `icedcoffee` (tools are `mcp__icedcoffee__*`), and connecting removes the old entries from Claude's and ChatGPT's settings. Nothing about your résumé files changes: templates still use `data-cv-*`, and a cover letter written before the rename still opens (its marker is read as both `/* icedcoffee:letter` and the old `/* itera:letter`).
- **A coffee theme, on by default.** The canvas, glass chrome and accent ship warm and brown (`#251200` ground, `#482201` glass tint, faint white dots). Every Material & Light dial now applies on a fresh load and on Reset — the tint colour, radius, padding, shine, shadow and angle no longer fall back to Infospector's cool-gray host defaults. Placeholders and the frosted bars (AI prompt, connect, get-app, coach-marks) source the theme too, and the custom surfaces use host.css's real backing/reflex stack instead of a faked tint.
- **The document opens at 100%** (actual size) instead of fit-to-width; it then remembers the last size you set and reopens there.
- **The mark is an iced-coffee cup** (was two overlapping sheets). `brand/icedcoffee-glyph.svg` (stroke, `currentColor`) and `brand/icedcoffee-icon.svg` (white cup on a brown `#A44400 → #502202` gradient) are the source files; the app icon, installer, welcome and Connect windows and favicon derive from them. The window has no opaque OS title bar — its own background fills to the top and a transparent strip keeps it draggable.

### Added
- **Import Word, PDF, RTF, HTML, Markdown and plain text — formatting kept, no AI.** Open (⌘O), the Import button, drag-and-drop and MCP's `open_document` now take `.docx`, `.pdf`, `.rtf`, `.md`, `.txt` and anybody's HTML résumé. Each format has its own converter (`src/import/`); one set of rules then finds the name and contact lines, section headings, and dated entries (title and dates as their own regions, dates kept on the right) and rebuilds the look — fonts, sizes, colours, spacing, bullets, tables, columns, pictures, page margins — as a stylesheet generated from the source's measurements. Imports open as a **new unsaved document**; the source file is never written. Only two things use the person's AI, and only when offered: reading a **scanned PDF** (the AI transcribes; the same rules build the page) and **Tidy with AI** for an import with little structure (regroups, never rewords). See `docs/import-and-ai-features.md`. Runs of text now keep their own font, highlight and capitals through editing.
- **A first-run tour.** Eleven progressive coach-marks reveal the toolbar control by control, then walk through the cover-letter tab and the appearance menu. Replayable from *IcedCoffee ▸ Take the tour again* or `?tour`; skipped under automation.
- **Choose an icon and colour for any image.** The image popup's *Choose Icon and Color…* opens a typeahead over **Lucide + Tabler** (~6,800 icons, merged and sorted by name; search "lucide"/"tabler" to narrow), with the shared colour picker — it drops the icon in as a recoloured SVG and recolours it live on the page. Loaded on demand so the icon sets stay out of the main bundle.
- **Help, and a paste-to-your-AI prompt.** *IcedCoffee ▸ Help · connect your AI* and the macOS *Help ▸ Connect your AI…* both open the connect screen, which now leads with a one-click **“Copy & paste to your AI”**: a plain-language message that tells any robot what IcedCoffee is, how to connect, and how to help — no config to explain.
- **A cover letter beside the résumé.** A two-segment picker at the right of the bar switches the sheet between them. Two documents, two files — and one header: the letter's is copied from the résumé's (read-only) every time the letter takes the sheet. Default letter: `templates/sample-cover-letter.html`. **Export → a format → Résumé / Cover Letter / All.** Desktop: each tab has its own open file, recents and pinned master; *File ▸ New Cover Letter*.
- **The document bar is a recent-files typeahead (desktop).** Click the name to see your last documents, type to filter, ↑/↓/⏎ to open; star one as the **master** (top of the list, and what opens by default). Type a name no document has → **Save as “…”** — that is how you rename or branch a copy.
- **ATS keywords panel.** A floating, draggable, closable panel (IcedCoffee menu ▸ ATS keywords): each keyword used / not yet, ×N, and whether the other document has it; click to highlight every hit on the sheet. Your AI fills it from a job ad (`set_keywords` over MCP, or the built-in assistant), or add words yourself. It is told to use a keyword only where it is true of you.
- **The model knows which regions are two-column** (`columns: 2`) and prefers an even number of bullets there — a baseline, not a rule.
- **MCP: fourteen document-explicit tools.** The core three are `get_document` / `edit_document` / `export_document` (renamed from `*_resume`), plus `new_document`, `list_documents`, `open_document`, `save_document` (`save_as` branches a copy, never over another file), `get_page_setup` / `set_page_setup`, `list_images` / `replace_image`, `set_keywords` / `get_keywords`, `undo_last_edit`. Every single-document tool **requires** `document: "resume" | "cover_letter"` — enforced at runtime, so an edit can never land on the wrong tab. `export_document` writes pdf/png/docx/html. `open_document` refuses over unsaved changes.
- **The IcedCoffee mark is a menu**: light/dark mode, appearance, ATS keywords, Take the tour again, Help · connect your AI, reset to original source, Check for Updates (with the cup glyph), and a full-width **Made by Q** credit (the page background as its fill, the Q logo + label in the adaptive ink). The “…” button is gone; Export is its icon.

### Fixed
- **macOS: no more gray plate around the app icon.** The icon ships as an Icon Composer package (`electron/build/IcedCoffee.icon`, compiled by Xcode's `actool` into `Assets.car`) instead of only a legacy `.icns`, which macOS 26+ draws on a gray backing. The acrylic artwork now runs edge to edge so macOS draws its own rim, rather than clipping the tile's baked-in bevel. `npm run icon` derives the Windows icon and favicon from Apple's own render of the package. Building needs full Xcode 26+.
- **PNG export on the web spilled a third column off the page.** The browser build (no export server) rasterises with html-to-image, which clones the document into an `<svg><foreignObject>` and copies each node's *computed* style onto the clone. For a list the browser has fragmented across a `.cv-flow` column, that computed width is one **fragment** (372px), not the element (749px) — baked back on as an explicit size it re-fragmented and pushed a third column past the sheet edge, clipped. `rasterize` now injects an override into the clone (a stylesheet beats the copied inline styles) and draws the SVG itself. The desktop app was never affected: it screenshots a real page.
- **A list column no longer starts lower than the one beside it.** Item spacing was `li + li { margin-top }`; the item landing at the top of column 2 kept that margin, so the columns didn't line up — most visible where a manual column break left a single bullet up there, which read as vertically centred. Spacing now rides on `margin-bottom`, which a column break can't strand. Documents saved before this fix carry their own copy of the old rule and are **migrated as they are opened**, so existing résumés pick it up too.
- **DOCX:** flowing two-column regions were Word *section* columns, which Quick Look, Pages, TextEdit and many ATS parsers show as one column with an empty square at every section break. They are now borderless tables, split where the columns break on screen.
- **Exports are named after the open file**, not the name printed on the résumé (tailoring the sample no longer exports `mara-quill.pdf`).
- **Desktop: slow Open / Save panels.** Both now start in a local folder (the document's, the last export's, or Downloads) instead of wherever macOS was last — which could be a network volume. The export scan keeps running until the Save panel is done.
- **Desktop: Settings… and Check for Updates… in the File menu** (and **IcedCoffee ▸ Settings… ⌘,** on a Mac). Settings is one window: connect your AI app, the API key option (Advanced), and Updates (check automatically, check now, your version). **AI ▸ API Key (Advanced)…** jumps straight to the key section.
- **Desktop: IcedCoffee updates itself.** On launch it asks GitHub for the latest published release; if there is one it offers **Update and Reopen** — download, verify the Ed25519 signature against the publisher's key built into the app (anything else is thrown away), check the bundle, swap it in, reopen. No second macOS warning, because files the app downloads aren't flagged as "from the internet". *IcedCoffee ▸ Check for Updates…*, and *Check Automatically* to switch it off. macOS for now; Windows opens the download page. See `RELEASING.md`.
- **⌘+ / ⌘− / ⌘0** (Ctrl on Windows) zoom the sheet by its %, stepping from wherever it is now; ⌘0 returns to fit-width. In every build; the desktop app also lists them under **View**.
- **A desktop app (early).** `electron/` wraps this same prebuilt folder in Electron — nothing in the editor changes. **PDF** and **PNG** become one click with no export server and no print dialog: the app's own Chromium renders them (real, selectable text; exact page size), with JavaScript off and the network refused, exactly like `server.mjs`. `npm run smoke` drives both exports and, when puppeteer is around, checks the PDF against puppeteer's run by run. Not packaged or signed yet — run it from source: `cd electron && npm install && npm start`.
- **Desktop: installers.** `npm run dist` builds macOS `.dmg`s (Apple Silicon and Intel, ad-hoc signed), `npm run dist:win` a Windows installer; a `v*` tag builds both on GitHub into a draft release. The builds are unsigned — the README's *First launch* section walks through the one-time approval. The app has its own icon and offers itself under *Open With* for `.html` files (it never takes over as the default).
- **Desktop: connect the AI app you already use — no API key.** IcedCoffee runs a local MCP server (`get_resume`, `edit_resume`, `undo_last_edit`, `export_resume`). **AI ▸ Connect Your AI…** connects **Claude Desktop** or **the ChatGPT desktop app / Codex** in one click (it writes the one settings entry, with a backup, and can remove it), and offers copy-paste settings for Claude Code, Cursor, VS Code, LM Studio. Edits arrive on the sheet as one undoable step, labelled with the app that made them; the model is told when an edit spills onto another page. Nothing leaves the computer on IcedCoffee's account: the AI app talks to it over a socket only your user can open.
- **Security:** model-written HTML is now parsed in an inert document before the allowlist runs (an `<img onerror>` could otherwise fire first).
- **Desktop: a prompt bar inside the app (Advanced).** For people who would rather type in IcedCoffee: a prompt bar under the page (⌘K) sends your words and the résumé to the model **you** connect — Claude (Anthropic API key), or any OpenAI-compatible service: OpenAI, Gemini, OpenRouter, or a local model via Ollama / LM Studio — and applies what comes back as **one undoable step**. The model answers with operations on blocks and text regions, never raw markup, so the design can't break; its HTML passes an allowlist; and if an edit spills onto another page the editor has it tighten up. Keys are encrypted with the OS keychain, stay in the app's main process, and go only to the provider you chose. For embedders: `CvMaker` takes an optional `assistant` prop (`CvAssistant`); without it there is no prompt bar.
- **Desktop: a welcome sheet** on first launch (and under **Help ▸ Welcome to IcedCoffee**): what the app is for — your résumé as a real page with your own AI beside it — then *Connect my AI…* (no API key) or *Look around first*. The macOS installer window now carries the first-launch steps and a shortcut straight to **Privacy & Security**.
- **Desktop: your résumé is a real file.** Open / Open Recent / drop a file on the window, **Save** and **Save As**, an edited dot in the title bar, a prompt before closing with unsaved work, and the last file re-opens on launch. The app **watches the open file**: when another program edits it (an AI assistant, another editor) the sheet reloads on its own — or asks, if you have unsaved edits. For embedders: `CvMaker` takes an optional `files` prop (the `CvFiles` contract); without it, nothing changes — the document lives in the browser as before.
- **Add a row anywhere.** Hover the gap between two blocks and a **+** appears on a hairline showing where the new block will land. Click it and choose **Content block** (a paragraph, like the summary), **Experience block** (title, dates, bullets that flow across two columns), **Dual list** (two lists side by side) or **Divider** (a rule between sections — click it to select it, then move or delete it). The new block copies the shape of the matching block already in your document — so it works with any template — arrives with placeholder copy, and takes the caret with that copy selected, ready to type over. Templates can name their prototypes with `data-cv-kind="content|experience|dual"`.
- Inserted blocks always get **consistent breathing room**: the editor keeps at least 12pt between a new block and its neighbours (re-checked whenever rows move), so a list dropped above a paragraph never ends up butted against it. Two jobs in a row keep the template's own rhythm.
- The move / duplicate / delete tools now work on **any** block that holds the caret (the summary, a dual list…), not only on jobs.
- The **⋯** menu now ends with a credit: **IcedCoffee by Q Manning**, linking to qmanning.com/labs/icedcoffee. (The credit lives in the tool only — never in an exported résumé, which is yours.)

### Fixed
- Export file names keep accented letters' base letter: "Mara Quill — Résumé" now exports as `mara-quill-resume.pdf`, not `mara-quill-r-sum.pdf`.

### Changed
- IcedCoffee's glass now defaults to **Blur 44px** and **Backing 56%** (Infospector's own defaults are 8px / 35%): the chrome floats over a white sheet of small type, so it needs the heavier glass to stay legible. The defaults only apply while those dials are untouched — a look you've set, in either tool, still wins.

## [0.1.0] — 2026-09-18

### Added
- First working version: an edit-in-place résumé editor. Your résumé is one HTML file; open it and
  it appears as a sheet of paper on a canvas, with every `[data-cv-edit]` region mounted as its own
  rich-text editor directly on the template's own markup.
- A floating **format bar** that follows the box you're editing — bold, italic, underline, font
  size in pt, weight, line height, letter spacing, text color via a glass color picker, links,
  bullets, a horizontal rule, alignment, and clear formatting.
- **Flowing job entries**: a `.cv-flow` region's copy flows across two columns from one input, with
  an optional "start the next column here" break.
- **Independent side-by-side columns** for skills or other non-flowing content.
- **Duplicate, move, and delete** repeatable entries (`[data-cv-repeat]`, e.g. jobs).
- **Change any image** in place — click it, pick a file, and it's embedded as a data URI.
- **US Letter and A4** page sizes.
- **Fit to one page**: scales the whole design as a single unit (never below 80%) so every line
  still breaks where it was designed to.
- **Pagination toggle** — on: real page breaks and centered page numbers past one page; off: one
  continuous page.
- **Live zoom**: Fit width and Fit height track the window as you resize, plus fixed zoom levels.
- **Spellcheck toggle** and **light/dark theme**.
- **Four exports**: PDF (real selectable text, live links, ATS-readable), Word DOCX (real
  paragraphs and bullets, native Word columns for flowing regions, borderless tables for side-by-
  side columns, hyperlinks, page-number footer), PNG at 2×, and Source HTML (reloadable, for
  keeping variants). A scan-line animation plays over the sheet while an export renders.
- **Import a source HTML** file from the toolbar to switch documents.
- Wears [Infospector](https://github.com/qmanning/infospector)'s glass UI and shares its saved
  look (background pattern, colors, and material & light) through the same `pt:*` `localStorage`
  keys — right-click the canvas for Background, Colors, Start-up, and Material & Light.
- **Autosaves to `localStorage`.** Nothing is stored on or sent to a server, except to your own
  optional local export server.
- Optional local **export server** (`server.mjs`) for one-click PDF/PNG in real headless Chrome —
  binds to `127.0.0.1` only, allowlists localhost origins for CORS, and renders with JavaScript
  disabled and all network requests blocked. Needs `npm i puppeteer` installed alongside it; without
  it, the server still starts and answers every request with a clear `501`.
- Ships prebuilt (`dist/` is committed) as one folder of static files — no build step for users, any
  URL depth, no framework requirement.

[Unreleased]: https://github.com/qmanning/icedcoffee/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qmanning/icedcoffee/releases/tag/v0.1.0

---

Made by [Q Manning](https://qmanning.com) · [Source on GitHub](https://github.com/qmanning/icedcoffee) · [See it live in the Labs](https://qmanning.com/labs/icedcoffee)
