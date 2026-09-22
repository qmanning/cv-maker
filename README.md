<img src="brand/icedcoffee-icon.svg" width="72" height="72" alt="IcedCoffee" />

# IcedCoffee

**Your résumé is one HTML file. Open it, click any text, type — and export it as a real, ATS-readable document.**

IcedCoffee is an edit-in-place résumé editor that runs entirely in the browser. There's no form to fill in and no template gallery — your résumé shows up as a sheet of paper on a canvas, and every piece of copy is exactly where it'll be in the export, because you're editing the export. Click a line, it becomes a rich-text box with a floating format bar; click an image, swap it; done editing, export a PDF with real selectable text and live links, a Word file built for ATS parsing, a PNG, or the source HTML itself so you can keep variants.

- **Edit in place, not in a form.** Each `[data-cv-edit]` region in the template becomes a TipTap editor mounted directly on the template's own element — what you see while editing is what gets exported.
- **A format bar that follows you.** It appears just above the box you're editing (or below, if there's no room) with bold, italic, underline, font size in pt, weight, line height, letter spacing, a glass color picker, links, bullets, a horizontal rule, alignment, and clear formatting.
- **Job entries that flow.** A `.cv-flow` region's copy flows across two columns from one input, with an optional "start the next column here" break — so you type one job description and it lands where the design wants it.
- **Independent side-by-side columns** for skills or anything else that isn't one flowing story.
- **Add a row anywhere.** Hover between two blocks, click the **+**, and drop in a Content block, an Experience block, a Dual list, or a Divider — cloned from your document's own blocks, so it matches any template.
- **Move, duplicate, and delete any block** — click into it and a small tool pill appears beside it.
- **Swap any image** — click it, choose a file, and it's embedded straight into the document as a data URI. No uploads, no broken links later.
- **A cover letter beside the résumé.** The picker at the right of the bar switches the sheet between the two. They are two documents (two files), and the letter's header *is* the résumé's: change your phone number or headline on the résumé and the letter follows. A default letter ships in `templates/sample-cover-letter.html`.
- **ATS keywords panel.** The words a job ad is screened for, each marked used / not yet, with a ×N count and a note when only the other document uses it. Click one and every hit on the page lights up (CSS Custom Highlight — the document's markup is never touched). Add them yourself, or have your AI read the ad. IcedCoffee menu ▸ ATS keywords.
- **US Letter and A4**, switchable any time.
- **Fit to one page** scales the whole design down as a single unit (never below 80%) so every line still breaks exactly where it was designed to.
- **Pagination, your way.** On: real page breaks and centered page numbers once you're past one page. Off: one continuous page, no breaks.
- **Live zoom that tracks the window** — Fit width, Fit height, or a handful of fixed zoom levels.
- **Spellcheck toggle, light/dark theme**, and the same glass "look" system as Infospector (background pattern, colors, material and light — right-click the canvas).
- **Four export formats**: PDF (real text, real links), Word DOCX (real paragraphs, bullets and tables, built for ATS parsing), PNG at 2×, and Source HTML — the one you reload to keep a variant. Pick a format, then **Résumé**, **Cover Letter** or **All**.
- **Nothing leaves your browser.** Autosaves to `localStorage`. No server, no account, no analytics — unless you run the optional local export server yourself.

![IcedCoffee editing a résumé in place](docs/screenshots/editor.png)

## Quick start

1. Copy this whole folder into your project's static directory, e.g. `public/labs/icedcoffee/`.
2. Start your dev server the way you normally do.
3. Open `/labs/icedcoffee/` — you'll land on the sample résumé (Mara Quill), ready to edit.

### Let your AI assistant install it

Paste this into Claude, Cursor, or whatever you use, from your project root:

> Install IcedCoffee (a static résumé editor) from this folder into my project. Read `INSTALL.md`
> in the `icedcoffee` folder and follow it exactly — it's written as a checklist for you.

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

![IcedCoffee's in-place format bar above an edited line](docs/screenshots/format-bar.png)

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

![An export in progress: the sheet dims and a scan line sweeps it until the file is ready](docs/screenshots/export.png)

| Format | What you get | Needs a server? |
| --- | --- | --- |
| PDF | Real, selectable text and live links — ATS-readable | No — falls back to the browser's print dialog ("Save as PDF") |
| Word (DOCX) | Real paragraphs and bullets, borderless tables for anything side by side (flowing columns are split where they break on screen — Word's own section columns show up as one column and stray squares in Quick Look, Pages and many ATS parsers), hyperlinks, page-number footer | No — always renders in-browser |
| PNG (2×) | A flat image of the page, rasterized in-browser via `vendor/html-to-image.js` | No |
| Source HTML | The file itself, reloadable — how you keep variants | No |

Choose a format, then what to export: **Résumé**, **Cover Letter**, or **All** (two files; a letter whose name doesn't say so gets `-cover-letter`). Files are named after the open document. A scan-line animation plays over the sheet until the export is done — in the desktop app, until its Save panel has come and gone.

## Résumé + cover letter

The two-segment picker at the far right of the bar switches between the résumé and its cover letter. Everything in the bar — the document name, Open/Import, Save, Export — acts on the tab that is showing, and a file opened from the wrong tab lands in its own (a letter marks itself with `data-cv-kind="letter"`).

- **Two files.** Each is a plain `.html` you own. In the desktop app each tab has its own open file, recent list and pinned master; on the web each has its own autosave slot.
- **One header.** The letter's `<header data-cv-mirror="header">` is filled from the résumé's header (its `[data-cv-header]`, else the page's first `<header>`) every time the letter takes the sheet — read-only, with the résumé's styles put in front of the letter's own (everything after the `/* icedcoffee:letter` marker in its `<style>`). The file keeps a snapshot, so it still stands alone.
- **Your own letter template** needs only that header slot plus `[data-cv-block][data-cv-edit]` regions for the date, recipient, greeting, body and sign-off.

## Optional export server

Without a server, PDF export uses the browser's print dialog (still real text and links) and PNG
renders in-browser. If you'd rather get a one-click PDF or PNG straight out of headless Chrome:

```bash
npm i puppeteer      # not a dependency of this repo — install it yourself, next to server.mjs
node server.mjs       # http://127.0.0.1:7332
```

Then point `config.js` at it:

```js
window.ITERA = {
    exportServer: "http://localhost:7332/export",
};
```

Without puppeteer installed, the server still starts and answers every `/export` request with
`501` and a message telling you to install it. Security properties: it binds to `127.0.0.1` only
(never all interfaces), its CORS allowlist only accepts `localhost` / `127.0.0.1` / `::1` origins,
and it renders your document with JavaScript disabled and all network requests blocked except
`data:`/`about:`/`blob:` — so nothing in your résumé can phone home during export.

## Desktop app (early)

`electron/` runs this same folder as a desktop app. Nothing in the editor knows it's there: the shell
serves the folder on its own `app://` origin and answers the editor's existing export-server option
itself, so **PDF and PNG are one click — no `server.mjs`, no puppeteer, no print dialog.**

**Download** an installer from [Releases](https://github.com/qmanning/icedcoffee/releases) — macOS
(`…-mac-arm64.dmg` for Apple Silicon, `…-mac-x64.dmg` for Intel) or Windows — **or run it from source:**

```bash
cd electron
npm install
npm start
```

### First launch (the builds are unsigned)

IcedCoffee is free and I don't pay Apple or Microsoft for a signing certificate, so your computer will
ask you to vouch for the app once. If you'd rather not, use the [web version](https://qmanning.com/labs/icedcoffee/demo)
or run it from source (above) — same editor, and neither shows a warning.

- **macOS** — open the disk image and **double-click IcedCoffee right there** (don't drag it anywhere; the window
  with the steps needs to stay in front of you). macOS says *"Apple could not verify “IcedCoffee” is free of
  malware that may harm your Mac or compromise your privacy."* Click **Done** (not *Move to Trash*; the dialog
  offers nothing else), then double-click **Open Privacy & Security** in that same window — or open **System
  Settings → Privacy & Security** yourself — scroll to the bottom, click **Open Anyway**, and confirm. IcedCoffee
  starts and offers to **install itself in Applications**: say yes. It copies itself there, reopens from
  Applications, and macOS doesn't ask again; eject the disk image. (If macOS says the app *"is damaged"*
  instead, run `xattr -cr` on the app in Terminal and open it again.)
- **Windows** — on *"Windows protected your PC"*, click **More info → Run anyway**.

Build the installers yourself with `npm run dist` (macOS) or `npm run dist:win`; pushing a `v*` tag
makes GitHub build both and attach them to a draft release. **Updates:** once installed, IcedCoffee checks this repo's Releases when it starts and offers to update itself —
it downloads the new version, verifies it is signed by IcedCoffee's publisher, installs it and reopens, with no second
macOS warning. *File ▸ Check for Updates…* asks now; *Settings ▸ Updates ▸ Check automatically* turns the check off. That check is the
only network request IcedCoffee makes on its own. (Windows: the dialog opens the download page for now.) See `RELEASING.md`.

Exports render in a throwaway window with JavaScript off and every network request refused, the same
posture as `server.mjs`. `npm run smoke` launches the app hidden, exports a PDF and a PNG through the
real UI, and — if puppeteer is resolvable (or `CVM_PUPPETEER_FROM=/path/with/node_modules`) — compares
the PDF with puppeteer's, text run by text run. The builds are **not** code-signed or notarized (see *First
launch* above); updates are signed separately, with IcedCoffee's own key, and verified before they install.

**Connect the AI app you already use — no API key.** This is what the desktop app is for. IcedCoffee runs a
small [MCP](https://modelcontextprotocol.io) server, so your own AI app can read the résumé that's open and
change it while you watch: *"Tailor my résumé to this job description." "Tighten it to one page."* Every
change lands on the sheet as one step with **Undo** beside it.

- **One click to connect** (File ▸ Settings…, or AI ▸ Connect Your AI…): **Claude Desktop**, and **the ChatGPT desktop app / Codex
  CLI / Codex IDE extension** (they share `~/.codex/config.toml`). IcedCoffee adds one entry to the app's
  settings file, keeps a backup next to it, and can remove it again. For **Claude Code, Cursor, VS Code,
  LM Studio** and anything else that speaks MCP there is a *Copy the settings* button.
- **No keys, no account, no network.** The AI app starts `electron/mcp/server.mjs` (dependency-free, run by
  IcedCoffee's own binary, so nobody needs Node) and that talks to the running app over a local socket only
  your user account can open. IcedCoffee itself never calls an AI service in this mode.
- **Thirteen tools**, each taking `document: "resume" | "cover_letter"` (IcedCoffee shows that one and acts on it): `get_resume`, `edit_resume`, `undo_last_edit`, `export_resume` (PDF / PNG / DOCX / HTML to Downloads), `list_documents`, `open_document`, `save_document` (`save_as` branches a copy beside the open file — tailor a copy, never the master), `get_page_setup` / `set_page_setup` (paper, fit to one page, pagination, zoom), `list_images` / `replace_image`, and `set_keywords` / `get_keywords` (the ATS panel: the AI reads the ad, IcedCoffee counts both documents).
- **Layout hints, not rules.** Regions that flow in two columns are described with `columns: 2`, and the model is told an even number of bullets balances there — a default the person can override, and only where the template has such regions.
- **It never discards your work.** `open_document` refuses while that document has unsaved changes, and `save_as` never overwrites another file.
- **The design can't break.** The model never rewrites the file. It sees the résumé as addressable blocks
  and regions and answers with operations (set this text, add / duplicate / move / delete that block);
  the editor applies them, and every scrap of model-written HTML is parsed inertly and passed through an
  allowlist first (`src/cv-assistant.ts`). New blocks are cloned from your template's own.
- **It can see the page; the model can't.** `edit_resume` reports pages before and after, and tells the
  model to tighten up when an edit spills onto another page.
- It is told not to invent facts: if it needs something it doesn't have ("add my last job"), it asks.
- **Advanced — a prompt bar inside IcedCoffee.** If you'd rather type requests in the app, the same window
  lets you add a pay-as-you-go API key (Claude, OpenAI, Gemini, OpenRouter) or a local model (Ollama,
  LM Studio). The key is encrypted with the OS keychain, stays in the main process, and goes only to the
  provider you chose.

The web and drop-in builds don't show the prompt bar: there, point your own assistant at the `.html` file.

**Your résumé is a real file.** In the desktop app the document is one Source HTML file on disk —
**File → Open / Open Recent**, drop a file on the window, **Save** (⌘S) and **Save As** (⇧⌘S), an
edited dot in the title bar, and a prompt before closing with unsaved work. The app watches the open
file, so when something else edits it — your AI assistant, another editor — the sheet reloads by
itself (and asks first if you have unsaved edits of your own). That means the workflow you'd use in a
project works here too: point your assistant at the `.html` file and watch the page change.

## Configuration

Edit `config.js` (loaded as a classic script before the editor's own bundle):

| key | what |
| --- | --- |
| `home` | the source HTML the editor starts from (default: `templates/sample-resume.html`) |
| `exportServer` | a running `node server.mjs` endpoint for one-click PDF/PNG (see above) |
| `backHref` | shows a back arrow in the toolbar that navigates here |

Every key is optional — `window.ITERA = {}` (or no `config.js` at all) is a valid install.

## The look

![The glass look menu and color picker](docs/screenshots/look-menu.png)

IcedCoffee wears [Infospector](https://github.com/qmanning/infospector)'s glass UI, vendored MIT
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
| `⌘S` / `Ctrl+S` | Save — to the file on disk in the desktop app, to this browser (`localStorage`) on the web |
| `⇧⌘S` / `Ctrl+Shift+S` | Save As (desktop app) |
| `⌘+` / `⌘−` / `⌘0` | Zoom the sheet in / out / fit to width |
| `⌘B` / `Ctrl+B` | Bold |
| `⌘I` / `Ctrl+I` | Italic |
| `⌘U` / `Ctrl+U` | Underline |
| `Esc` | Closes any open menu, popover, or link editor |

## Privacy

**The web version** stores nothing on a server and sends nothing to one. Your document autosaves to this
browser's `localStorage` only — export Source HTML to move it anywhere else, or hand a variant to someone
else as a file. The only network calls it makes on its own are to fetch the template file it's pointed at;
the optional export server (above) is one you run yourself, on your own machine, and it blocks every
outbound request during a render.

**The desktop app** keeps your documents as ordinary files on your disk. It makes exactly two kinds of
network request, both of which you control:

- the **update check** against this repo's Releases, once a few seconds after launch — switch it off under
  *Settings ▸ Updates*;
- **"Ask your AI"**, if — and only if — you configure a provider yourself. Your prompt and the document's
  text are then sent to that provider, and nowhere else. Your API key is encrypted with your operating
  system's keychain, stays in the app's main process, and never reaches the editor page.

Connecting your own AI app over **MCP** instead involves no key and no network: the AI app talks to
IcedCoffee over a local socket only your user account can open. Note that a connected AI app can, through
those tools, open any `.html` file and embed any image file you point it at — the same reach you would give
it over your own files.

## Browser support & known limits

- **Chromium-based browsers recommended** (Chrome, Edge, Brave, Arc). IcedCoffee relies on CSS
  `zoom`, CSS multi-column layout, and the browser's print pipeline for PDF export; Safari and
  Firefox are untested.
- **DOCX can't be pixel-identical to the design.** It aims at a clean, ATS-readable structure —
  real paragraphs, native Word columns, borderless tables — not a visual clone of the PDF.
- **One document per browser.** IcedCoffee keeps a single autosaved document in `localStorage`; use
  Export → Source HTML to save named variants and Load source HTML to switch between them.
- **Fonts are whatever your template's font stack resolves to** on the machine viewing or
  exporting it. The sample template uses Helvetica/Arial, which every OS ships some version of.

## Developing

```bash
npm install
npm run build      # esbuild → dist/icedcoffee.js + dist/icedcoffee.css
npm test           # node --test: the src/ helpers, the export server, the templates, the updater,
                   #   and a check that the committed dist/ really is a build of the current src/
npm run typecheck  # tsc --noEmit
npm run serve      # static server on :7333, for local hacking against dist/
```

**`dist/` is committed** — that's the whole "one prebuilt folder, no build" premise, so it is what people
actually run. Rebuild it and commit the result in the same change as any edit under `src/`; `npm test`
fails if the two have drifted.

`src/` is kept byte-identical to how these files live in the author's own site, so they can be
re-synced by copying. That means two of their imports point at paths that don't exist in this
repo's layout — a Next.js `@/components/ui/…` alias, and a long relative import into
`public/labs/infospector/`. `build.mjs` remaps both at resolve time with an esbuild plugin instead
of editing the source files, so don't "fix" those imports; they're intentional.

`vendor/infospector/` is a verbatim copy of Infospector's `host.css`, `lib.js`, and
`colorpicker.js`. If Infospector changes upstream, re-copy those three files (and its `LICENSE`)
rather than editing them here — a comment at the top of `vendor/infospector/README.md` says the
same.

Pull requests are welcome — [CONTRIBUTING.md](./CONTRIBUTING.md) covers the two things that trip people
up (the committed `dist/`, and why some imports look wrong). Found a security problem? Please report it
privately: [SECURITY.md](./SECURITY.md).

## Credits

- [Infospector](https://github.com/qmanning/infospector) — the glass UI IcedCoffee wears (MIT, same author).
- [TipTap](https://tiptap.dev) / [ProseMirror](https://prosemirror.net) — the rich-text editing underneath every region (MIT).
- [docx](https://github.com/dolanmiu/docx) — the DOCX export (MIT).
- [html-to-image](https://github.com/bubkoo/html-to-image) — the in-browser PNG fallback (MIT).
- [lucide](https://lucide.dev) — icons, via `lucide-react` (ISC).

## License

MIT © 2026 Q Manning. See [LICENSE](./LICENSE).

---

Made by [Q Manning](https://qmanning.com) · [Source on GitHub](https://github.com/qmanning/icedcoffee) · [See it live in the Labs](https://qmanning.com/labs/icedcoffee)
