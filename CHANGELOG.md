# Changelog

All notable changes to Itera. Format: [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Pull requests add their entry under **Unreleased**; a release moves it under a version.

## [Unreleased]

### Changed
- **CV Maker is now Itera** — Latin for "do it again": another pass, another version for another job. The repo is `qmanning/itera` (GitHub redirects the old address), the page is qmanning.com/labs/itera (the old one redirects), the built files are `dist/itera.js` / `dist/itera.css`, the config global is `window.ITERA` and the mount point `#itera` — **`window.CV_MAKER` and `#cv-maker` still work**, so an existing install keeps running after you copy the new files in. The desktop app is *Itera.app*; its MCP server is `itera`, and connecting removes the old `cv-maker` entry from Claude's and ChatGPT's settings. Nothing about your résumé files changes: templates still use `data-cv-*`.

### Added
- **A cover letter beside the résumé.** A two-segment picker at the right of the bar switches the sheet between them. Two documents, two files — and one header: the letter's is copied from the résumé's (read-only) every time the letter takes the sheet. Default letter: `templates/sample-cover-letter.html`. **Export → a format → Résumé / Cover Letter / All.** Desktop: each tab has its own open file, recents and pinned master; *File ▸ New Cover Letter*.
- **The document bar is a recent-files typeahead (desktop).** Click the name to see your last documents, type to filter, ↑/↓/⏎ to open; star one as the **master** (top of the list, and what opens by default). Type a name no document has → **Save as “…”** — that is how you rename or branch a copy.
- **MCP: eleven tools, both documents.** New: `list_documents`, `open_document`, `save_document` (`save_as` branches a copy, never over another file), `get_page_setup` / `set_page_setup`, `list_images` / `replace_image`, and `export_resume` gains `docx` + `html`. Every tool takes `document: "resume" | "cover_letter"`. `open_document` refuses over unsaved changes.
- **The Itera mark is a menu**: light/dark mode, appearance, reset to original source, Check for Updates, the credit. The “…” button is gone; Export is its icon.

### Fixed
- **DOCX:** flowing two-column regions were Word *section* columns, which Quick Look, Pages, TextEdit and many ATS parsers show as one column with an empty square at every section break. They are now borderless tables, split where the columns break on screen.
- **Exports are named after the open file**, not the name printed on the résumé (tailoring the sample no longer exports `mara-quill.pdf`).
- **Desktop: slow Open / Save panels.** Both now start in a local folder (the document's, the last export's, or Downloads) instead of wherever macOS was last — which could be a network volume. The export scan keeps running until the Save panel is done.
- **Desktop: Settings… and Check for Updates… in the File menu** (and **Itera ▸ Settings… ⌘,** on a Mac). Settings is one window: connect your AI app, the API key option (Advanced), and Updates (check automatically, check now, your version). **AI ▸ API Key (Advanced)…** jumps straight to the key section.
- **Desktop: Itera updates itself.** On launch it asks GitHub for the latest published release; if there is one it offers **Update and Reopen** — download, verify the Ed25519 signature against the publisher's key built into the app (anything else is thrown away), check the bundle, swap it in, reopen. No second macOS warning, because files the app downloads aren't flagged as "from the internet". *Itera ▸ Check for Updates…*, and *Check Automatically* to switch it off. macOS for now; Windows opens the download page. See `RELEASING.md`.
- **Itera has a mark**: two overlapping sheets with the overlap filled — a version, and the next one. `brand/itera-glyph.svg` and `brand/itera-icon.svg` (white on Itera blue `#004DFF`) are the source files; the desktop app icon, the installer, the welcome and Connect windows and the favicon are derived from them.
- **⌘+ / ⌘− / ⌘0** (Ctrl on Windows) zoom the sheet by its %, stepping from wherever it is now; ⌘0 returns to fit-width. In every build; the desktop app also lists them under **View**.
- **A desktop app (early).** `electron/` wraps this same prebuilt folder in Electron — nothing in the editor changes. **PDF** and **PNG** become one click with no export server and no print dialog: the app's own Chromium renders them (real, selectable text; exact page size), with JavaScript off and the network refused, exactly like `server.mjs`. `npm run smoke` drives both exports and, when puppeteer is around, checks the PDF against puppeteer's run by run. Not packaged or signed yet — run it from source: `cd electron && npm install && npm start`.
- **Desktop: installers.** `npm run dist` builds macOS `.dmg`s (Apple Silicon and Intel, ad-hoc signed), `npm run dist:win` a Windows installer; a `v*` tag builds both on GitHub into a draft release. The builds are unsigned — the README's *First launch* section walks through the one-time approval. The app has its own icon and offers itself under *Open With* for `.html` files (it never takes over as the default).
- **Desktop: connect the AI app you already use — no API key.** Itera runs a local MCP server (`get_resume`, `edit_resume`, `undo_last_edit`, `export_resume`). **AI ▸ Connect Your AI…** connects **Claude Desktop** or **the ChatGPT desktop app / Codex** in one click (it writes the one settings entry, with a backup, and can remove it), and offers copy-paste settings for Claude Code, Cursor, VS Code, LM Studio. Edits arrive on the sheet as one undoable step, labelled with the app that made them; the model is told when an edit spills onto another page. Nothing leaves the computer on Itera's account: the AI app talks to it over a socket only your user can open.
- **Security:** model-written HTML is now parsed in an inert document before the allowlist runs (an `<img onerror>` could otherwise fire first).
- **Desktop: a prompt bar inside the app (Advanced).** For people who would rather type in Itera: a prompt bar under the page (⌘K) sends your words and the résumé to the model **you** connect — Claude (Anthropic API key), or any OpenAI-compatible service: OpenAI, Gemini, OpenRouter, or a local model via Ollama / LM Studio — and applies what comes back as **one undoable step**. The model answers with operations on blocks and text regions, never raw markup, so the design can't break; its HTML passes an allowlist; and if an edit spills onto another page the editor has it tighten up. Keys are encrypted with the OS keychain, stay in the app's main process, and go only to the provider you chose. For embedders: `CvMaker` takes an optional `assistant` prop (`CvAssistant`); without it there is no prompt bar.
- **Desktop: a welcome sheet** on first launch (and under **Help ▸ Welcome to Itera**): what the app is for — your résumé as a real page with your own AI beside it — then *Connect my AI…* (no API key) or *Look around first*. The macOS installer window now carries the first-launch steps and a shortcut straight to **Privacy & Security**.
- **Desktop: your résumé is a real file.** Open / Open Recent / drop a file on the window, **Save** and **Save As**, an edited dot in the title bar, a prompt before closing with unsaved work, and the last file re-opens on launch. The app **watches the open file**: when another program edits it (an AI assistant, another editor) the sheet reloads on its own — or asks, if you have unsaved edits. For embedders: `CvMaker` takes an optional `files` prop (the `CvFiles` contract); without it, nothing changes — the document lives in the browser as before.
- **Add a row anywhere.** Hover the gap between two blocks and a **+** appears on a hairline showing where the new block will land. Click it and choose **Content block** (a paragraph, like the summary), **Experience block** (title, dates, bullets that flow across two columns), **Dual list** (two lists side by side) or **Divider** (a rule between sections — click it to select it, then move or delete it). The new block copies the shape of the matching block already in your document — so it works with any template — arrives with placeholder copy, and takes the caret with that copy selected, ready to type over. Templates can name their prototypes with `data-cv-kind="content|experience|dual"`.
- Inserted blocks always get **consistent breathing room**: the editor keeps at least 12pt between a new block and its neighbours (re-checked whenever rows move), so a list dropped above a paragraph never ends up butted against it. Two jobs in a row keep the template's own rhythm.
- The move / duplicate / delete tools now work on **any** block that holds the caret (the summary, a dual list…), not only on jobs.
- The **⋯** menu now ends with a credit: **Itera by Q Manning**, linking to qmanning.com/labs/itera. (The credit lives in the tool only — never in an exported résumé, which is yours.)

### Fixed
- Export file names keep accented letters' base letter: "Mara Quill — Résumé" now exports as `mara-quill-resume.pdf`, not `mara-quill-r-sum.pdf`.

### Changed
- Itera's glass now defaults to **Blur 44px** and **Backing 56%** (Infospector's own defaults are 8px / 35%): the chrome floats over a white sheet of small type, so it needs the heavier glass to stay legible. The defaults only apply while those dials are untouched — a look you've set, in either tool, still wins.

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

[Unreleased]: https://github.com/qmanning/itera/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qmanning/itera/releases/tag/v0.1.0

---

Made by [Q Manning](https://qmanning.com) · [Source on GitHub](https://github.com/qmanning/itera) · [See it live in the Labs](https://qmanning.com/labs/itera)
