# CV Maker

**Your résumé is one HTML file. Open it, click any text, type — and export it as a real, ATS-readable document.**

CV Maker is an edit-in-place résumé editor that runs entirely in the browser. There's no form to fill in and no template gallery — your résumé shows up as a sheet of paper on a canvas, and every piece of copy is exactly where it'll be in the export, because you're editing the export. Click a line, it becomes a rich-text box with a floating format bar; click an image, swap it; done editing, export a PDF with real selectable text and live links, a Word file built for ATS parsing, a PNG, or the source HTML itself so you can keep variants.

- **Edit in place, not in a form.** Each `[data-cv-edit]` region in the template becomes a TipTap editor mounted directly on the template's own element — what you see while editing is what gets exported.
- **A format bar that follows you.** It appears just above the box you're editing (or below, if there's no room) with bold, italic, underline, font size in pt, weight, line height, letter spacing, a glass color picker, links, bullets, a horizontal rule, alignment, and clear formatting.
- **Job entries that flow.** A `.cv-flow` region's copy flows across two columns from one input, with an optional "start the next column here" break — so you type one job description and it lands where the design wants it.
- **Independent side-by-side columns** for skills or anything else that isn't one flowing story.
- **Add a row anywhere.** Hover between two blocks, click the **+**, and drop in a Content block, an Experience block, a Dual list, or a Divider — cloned from your document's own blocks, so it matches any template.
- **Move, duplicate, and delete any block** — click into it and a small tool pill appears beside it.
- **Swap any image** — click it, choose a file, and it's embedded straight into the document as a data URI. No uploads, no broken links later.
- **US Letter and A4**, switchable any time.
- **Fit to one page** scales the whole design down as a single unit (never below 80%) so every line still breaks exactly where it was designed to.
- **Pagination, your way.** On: real page breaks and centered page numbers once you're past one page. Off: one continuous page, no breaks.
- **Live zoom that tracks the window** — Fit width, Fit height, or a handful of fixed zoom levels.
- **Spellcheck toggle, light/dark theme**, and the same glass "look" system as Infospector (background pattern, colors, material and light — right-click the canvas).
- **Four export formats**: PDF (real text, real links), Word DOCX (native columns and tables, built for ATS parsing), PNG at 2×, and Source HTML — the one you reload to keep a variant.
- **Nothing leaves your browser.** Autosaves to `localStorage`. No server, no account, no analytics — unless you run the optional local export server yourself.

![CV Maker editing a résumé in place](docs/screenshots/editor.png)

## Quick start

1. Copy this whole folder into your project's static directory, e.g. `public/labs/cv-maker/`.
2. Start your dev server the way you normally do.
3. Open `/labs/cv-maker/` — you'll land on the sample résumé (Mara Quill), ready to edit.

### Let your AI assistant install it

Paste this into Claude, Cursor, or whatever you use, from your project root:

> Install CV Maker (a static résumé editor) from this folder into my project. Read `INSTALL.md`
> in the `cv-maker` folder and follow it exactly — it's written as a checklist for you.

It'll detect your framework's static directory, copy the folder to the right place, verify it
serves, and ask you a short batch of questions (your own résumé as the starting template? US
Letter or A4? one-click PDF via the optional local server?) before it finishes.

## How it works

A résumé here is a single, self-contained HTML file — inline `<style>`, one `.cv-page` root, no
external CSS. The editor understands a handful of conventions in that file (see the comment at the
top of `templates/sample-resume.html` for the authoritative list):

```css
.cv-page { --cv-content-w: 562pt; font-size: 9pt; line-height: 1.15; }  /* everything scoped, sizes in pt */
.cv-page [data-col-break] { break-before: column; }                     /* where the editor may split a flow */
```

```html
<div data-cv-repeat="job">
  <div data-cv-keep-next class="cv-h2">Senior Designer — Studio Name</div>
  <div class="cv-flow" data-cv-edit>
    <p>Led the redesign of the core product, cutting onboarding time in half…</p>
  </div>
</div>
```

- `[data-cv-edit]` — an editable rich-text region (paragraphs, bullets, links, rules).
- `.cv-flow` — a region whose copy flows across columns from one input.
- `[data-cv-block]` — a unit pagination keeps together on one page.
- `[data-cv-keep-next]` — and keeps with the block that follows it (section headings).
- `[data-cv-repeat]` — a block you can duplicate, move, or delete (jobs).

The page size, page breaks, and page numbers belong to the editor, not to the file — your template
never sets a page height or draws its own footer number.

![CV Maker's in-place format bar above an edited line](docs/screenshots/format-bar.png)

## Make your own template

1. Start from `templates/sample-resume.html` (the sample résumé, Mara Quill) and strip the content,
   keeping the structure and the conventions above.
2. Scope every rule under `.cv-page`, and use `pt` for every size — the editor's zoom and
   fit-to-page math assume it.
3. Mark your flowing sections (job descriptions, a long summary) with `.cv-flow` and
   `data-cv-edit`; mark repeatable sections (each job) with `data-cv-repeat`.
4. Load it from the toolbar (**⋯ → Load source HTML…**) to try it, then point `config.js`'s `home`
   at the file once you're happy.

What the editor owns: page size (US Letter / A4), page breaks, page numbers, zoom, and the overall
scale when fitting to one page. What your template owns: fonts, colors, spacing, and the actual
layout — columns, header, rules. The editor never rewrites your CSS; it only measures it.

## Exports

| Format | What you get | Needs a server? |
| --- | --- | --- |
| PDF | Real, selectable text and live links — ATS-readable | No — falls back to the browser's print dialog ("Save as PDF") |
| Word (DOCX) | Real paragraphs and bullets, native Word columns for flowing regions, borderless tables for side-by-side columns, hyperlinks, page-number footer | No — always renders in-browser |
| PNG (2×) | A flat image of the page, rasterized in-browser via `vendor/html-to-image.js` | No |
| Source HTML | The file itself, reloadable — how you keep variants | No |

A scan-line animation plays over the sheet while an export renders.

## Optional export server

Without a server, PDF export uses the browser's print dialog (still real text and links) and PNG
renders in-browser. If you'd rather get a one-click PDF or PNG straight out of headless Chrome:

```bash
npm i puppeteer      # not a dependency of this repo — install it yourself, next to server.mjs
node server.mjs       # http://127.0.0.1:7332
```

Then point `config.js` at it:

```js
window.CV_MAKER = {
    exportServer: "http://localhost:7332/export",
};
```

Without puppeteer installed, the server still starts and answers every `/export` request with
`501` and a message telling you to install it. Security properties: it binds to `127.0.0.1` only
(never all interfaces), its CORS allowlist only accepts `localhost` / `127.0.0.1` / `::1` origins,
and it renders your document with JavaScript disabled and all network requests blocked except
`data:`/`about:`/`blob:` — so nothing in your résumé can phone home during export.

## Configuration

Edit `config.js` (loaded as a classic script before the editor's own bundle):

| key | what |
| --- | --- |
| `home` | the source HTML the editor starts from (default: `templates/sample-resume.html`) |
| `exportServer` | a running `node server.mjs` endpoint for one-click PDF/PNG (see above) |
| `backHref` | shows a back arrow in the toolbar that navigates here |

Every key is optional — `window.CV_MAKER = {}` (or no `config.js` at all) is a valid install.

## The look

![The glass look menu and color picker](docs/screenshots/look-menu.png)

CV Maker wears [Infospector](https://github.com/qmanning/infospector)'s glass UI, vendored MIT
under `vendor/infospector/`, and shares its saved look through the same `pt:*` `localStorage` keys
— dial in a look in Infospector and it's the look here too, and vice versa. Right-click the canvas
for:

- **Background** — pattern (dots, grid, lines, none) and opacity.
- **Colors** — pattern, background, and accent, in HEX, RGB, HSL, or HSB.
- **Start-up** — paper size and the source page the editor opens with.
- **Material & Light** — radius, padding, blur, saturation, highlight, distance, opacity, backing,
  shine, shadow, and angle.

**Reset** returns to the shipped look; **Copy config** copies a snippet to paste into `config.js`
so every browser starts set up the same way; **Save** remembers it in this browser.

## Keyboard

| Keys | Does |
| --- | --- |
| `⌘S` / `Ctrl+S` | Save to this browser (`localStorage`) |
| `⌘B` / `Ctrl+B` | Bold |
| `⌘I` / `Ctrl+I` | Italic |
| `⌘U` / `Ctrl+U` | Underline |
| `Esc` | Closes any open menu, popover, or link editor |

## Privacy

Nothing is stored on or sent to a server. Your document autosaves to this browser's
`localStorage` only — export Source HTML to move it anywhere else, or hand a variant to someone
else as a file. The only network calls CV Maker ever makes on its own are to fetch the template
file it's pointed at; the optional export server (above) is one you run yourself, on your own
machine, and it blocks every outbound request during a render.

## Browser support & known limits

- **Chromium-based browsers recommended** (Chrome, Edge, Brave, Arc). CV Maker relies on CSS
  `zoom`, CSS multi-column layout, and the browser's print pipeline for PDF export; Safari and
  Firefox are untested.
- **DOCX can't be pixel-identical to the design.** It aims at a clean, ATS-readable structure —
  real paragraphs, native Word columns, borderless tables — not a visual clone of the PDF.
- **One document per browser.** CV Maker keeps a single autosaved document in `localStorage`; use
  Export → Source HTML to save named variants and Load source HTML to switch between them.
- **Fonts are whatever your template's font stack resolves to** on the machine viewing or
  exporting it. The sample template uses Helvetica/Arial, which every OS ships some version of.

## Developing

```bash
npm install
npm run build   # esbuild → dist/cv-maker.js + dist/cv-maker.css
npm test        # node --test, pure helpers in src/cv-source.ts
npm run serve   # static server on :7333, for local hacking against dist/
```

`src/` is kept byte-identical to how these files live in the author's own site, so they can be
re-synced by copying. That means two of their imports point at paths that don't exist in this
repo's layout — a Next.js `@/components/ui/…` alias, and a long relative import into
`public/labs/infospector/`. `build.mjs` remaps both at resolve time with an esbuild plugin instead
of editing the source files, so don't "fix" those imports; they're intentional.

`vendor/infospector/` is a verbatim copy of Infospector's `host.css`, `lib.js`, and
`colorpicker.js`. If Infospector changes upstream, re-copy those three files (and its `LICENSE`)
rather than editing them here — a comment at the top of `vendor/infospector/README.md` says the
same.

## Credits

- [Infospector](https://github.com/qmanning/infospector) — the glass UI CV Maker wears (MIT, same author).
- [TipTap](https://tiptap.dev) / [ProseMirror](https://prosemirror.net) — the rich-text editing underneath every region (MIT).
- [docx](https://github.com/dolanmiu/docx) — the DOCX export (MIT).
- [html-to-image](https://github.com/bubkoo/html-to-image) — the in-browser PNG fallback (MIT).
- [lucide](https://lucide.dev) — icons, via `lucide-react` (ISC).

## License

MIT © 2026 Q Manning. See [LICENSE](./LICENSE).

---

Made by [Q Manning](https://qmanning.com) · [Source on GitHub](https://github.com/qmanning/cv-maker) · [See it live in the Labs](https://qmanning.com/labs/cv-maker)
