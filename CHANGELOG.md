# Changelog

All notable changes to CV Maker. Format: [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Pull requests add their entry under **Unreleased**; a release moves it under a version.

## [Unreleased]

### Added
- **A desktop app (early).** `electron/` wraps this same prebuilt folder in Electron — nothing in the editor changes. **PDF** and **PNG** become one click with no export server and no print dialog: the app's own Chromium renders them (real, selectable text; exact page size), with JavaScript off and the network refused, exactly like `server.mjs`. `npm run smoke` drives both exports and, when puppeteer is around, checks the PDF against puppeteer's run by run. Not packaged or signed yet — run it from source: `cd electron && npm install && npm start`.
- **Desktop: your résumé is a real file.** Open / Open Recent / drop a file on the window, **Save** and **Save As**, an edited dot in the title bar, a prompt before closing with unsaved work, and the last file re-opens on launch. The app **watches the open file**: when another program edits it (an AI assistant, another editor) the sheet reloads on its own — or asks, if you have unsaved edits. For embedders: `CvMaker` takes an optional `files` prop (the `CvFiles` contract); without it, nothing changes — the document lives in the browser as before.
- **Add a row anywhere.** Hover the gap between two blocks and a **+** appears on a hairline showing where the new block will land. Click it and choose **Content block** (a paragraph, like the summary), **Experience block** (title, dates, bullets that flow across two columns), **Dual list** (two lists side by side) or **Divider** (a rule between sections — click it to select it, then move or delete it). The new block copies the shape of the matching block already in your document — so it works with any template — arrives with placeholder copy, and takes the caret with that copy selected, ready to type over. Templates can name their prototypes with `data-cv-kind="content|experience|dual"`.
- Inserted blocks always get **consistent breathing room**: the editor keeps at least 12pt between a new block and its neighbours (re-checked whenever rows move), so a list dropped above a paragraph never ends up butted against it. Two jobs in a row keep the template's own rhythm.
- The move / duplicate / delete tools now work on **any** block that holds the caret (the summary, a dual list…), not only on jobs.
- The **⋯** menu now ends with a credit: **CV Maker by Q Manning**, linking to qmanning.com/labs/cv-maker. (The credit lives in the tool only — never in an exported résumé, which is yours.)

### Fixed
- Export file names keep accented letters' base letter: "Mara Quill — Résumé" now exports as `mara-quill-resume.pdf`, not `mara-quill-r-sum.pdf`.

### Changed
- CV Maker's glass now defaults to **Blur 44px** and **Backing 56%** (Infospector's own defaults are 8px / 35%): the chrome floats over a white sheet of small type, so it needs the heavier glass to stay legible. The defaults only apply while those dials are untouched — a look you've set, in either tool, still wins.

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

[Unreleased]: https://github.com/qmanning/cv-maker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qmanning/cv-maker/releases/tag/v0.1.0

---

Made by [Q Manning](https://qmanning.com) · [Source on GitHub](https://github.com/qmanning/cv-maker) · [See it live in the Labs](https://qmanning.com/labs/cv-maker)
