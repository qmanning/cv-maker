# Changelog

All notable changes to CV Maker. Format: [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Pull requests add their entry under **Unreleased**; a release moves it under a version.

## [Unreleased]

### Added
- **Add a row anywhere.** Hover the gap between two blocks and a **+** appears on a hairline showing where the new block will land. Click it and choose **Content block** (a paragraph, like the summary), **Experience block** (title, dates, bullets that flow across two columns) or **Dual list** (two lists side by side). The new block copies the shape of the matching block already in your document — so it works with any template — arrives with placeholder copy, and takes the caret with that copy selected, ready to type over. Templates can name their prototypes with `data-cv-kind="content|experience|dual"`.
- The move / duplicate / delete tools now work on **any** block that holds the caret (the summary, a dual list…), not only on jobs.

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
