# Installing Itera — a checklist for AI assistants

You are setting up **Itera**, a prebuilt static tool (one folder of HTML/CSS/JS, plus a
committed `dist/`) that lets a person edit a résumé in place in the browser — click any text and
type — and export it as PDF, Word, PNG, or source HTML. Follow the steps in order. Ask the
questions in step 4 as a single batch; don't ask anything else unless a step fails.

## 0. Ground rules

- **Do not modify files in the `itera/` folder** except `config.js` and anything under
  `templates/`. Everything else — `index.html`, `dist/`, `vendor/`, `server.mjs` — is the tool;
  updates replace it wholesale.
- **Do not add build steps, bundler config, or dependencies.** `dist/` is already built and
  committed; the user never runs `npm` to use the tool. If the framework needs anything to serve a
  static folder, it's already doing it for images.
- **Never run `npm install` or `npm run build` inside the user's project for this tool.** Those
  commands are only for developing Itera itself, from a clone of its own repo.
- **Never put the user's real résumé into a public repo without asking.** If they want to use their
  own résumé as the starting template (step 5), ask first, and suggest adding that file's path to
  `.gitignore` if the project's repo is public.

## 1. Detect the framework and its static directory

Look at the project root and pick the first match:

| evidence | framework | static dir | URL prefix |
| --- | --- | --- | --- |
| `next.config.*` | Next.js | `public/` | `/` |
| `vite.config.*` | Vite (React/Vue/Svelte SPA) | `public/` | `/` |
| `astro.config.*` | Astro | `public/` | `/` |
| `svelte.config.*` + `src/routes` | SvelteKit | `static/` | `/` |
| `nuxt.config.*` | Nuxt | `public/` | `/` |
| `remix.config.*` / `app/root.tsx` | Remix | `public/` | `/` |
| `config/routes.rb` | Rails | `public/` | `/` |
| `artisan` | Laravel | `public/` | `/` |
| `manage.py` | Django | a dir in `STATICFILES_DIRS` | `/static/` |
| `hugo.toml` / `config.toml` + `content/` | Hugo | `static/` | `/` |
| `_config.yml` | Jekyll | root or `assets/` | `/` |
| `wp-config.php` | WordPress | `wp-content/` | `/wp-content/` |
| `index.html` at root, no framework | static site | project root | `/` |

If nothing matches, ask the user where static files are served from (one question). Unlike
Infospector, Itera does **not** need to share an origin with anything else — it doesn't frame
the user's pages — so it can live at any path your server serves, at any depth.

## 2. Copy the folder

Copy the whole `itera/` folder to `<static dir>/labs/itera/` (create `labs/`). Keep the
folder name `itera`. Result must contain at least: `index.html`, `config.js`, `brand/` (the favicon), `dist/itera.js`,
`dist/itera.css`, `dist/chunks/`, `templates/sample-resume.html`, `vendor/html-to-image.js`,
`vendor/infospector/host.css`, `vendor/infospector/lib.js`, `vendor/infospector/colorpicker.js`,
`README.md`, `LICENSE`.

Itera must be served over `http://` or `https://` — opening `index.html` via `file://` will not
work, because it fetches the template over `fetch()` and loads its bundle as an ES module.

If the project has a `.gitignore` rule that would exclude it (e.g. ignoring `public/labs`), tell
the user rather than editing the ignore file.

## 3. Verify it serves

Start the dev server (whatever the project already uses), then confirm, with a browser tool if you
have one, otherwise `curl -I`:

- `GET <origin>/labs/itera/index.html` → 200, `text/html`
- `GET <origin>/labs/itera/dist/itera.js` → 200, `application/javascript` (or `text/javascript`)
- `GET <origin>/labs/itera/dist/itera.css` → 200, `text/css`

If you have a browser tool: open `<origin>/labs/itera/`, wait for at least one
`[data-cv-edit][contenteditable="true"]` element to appear (the sample résumé has 21 editable
regions), and check the console for errors. A blank page or a stuck loading state almost always
means one of the checks above failed — recheck the folder copy before anything else.

## 4. Ask the user (one batch)

1. **Their own résumé** — do they want to start from their own résumé instead of the bundled
   sample (Mara Quill)? If yes, that's step 5 below — ask first, since it may mean their personal
   information lands in a repo.
2. **Paper size** — US Letter (default) or A4?
3. **One-click export** — do they want PDF/PNG to render via a local headless-Chrome server
   (`server.mjs` + `npm i puppeteer`), or is the browser's print dialog and in-browser PNG fine?
   (Default: skip the server — it works without it.)
4. **Back link** — should the toolbar show a back arrow to somewhere in this project (e.g. a labs
   index page)? (default: no arrow)

## 5. Optional: build a personal template

Only if the user answered yes to Q1 above, and only after they've confirmed it.

Checklist for turning their existing résumé into a Itera source file:

- One `.cv-page` root; everything else scoped under it; every size in `pt`.
- Wrap each editable block of prose (a summary, a job description) in
  `<div class="cv-flow" data-cv-edit>…</div>` if it should flow across columns, or plain
  `data-cv-edit` if it's a single block.
- Wrap each repeatable unit (a job) in `<div data-cv-repeat="job">…</div>` so the user can
  duplicate, reorder, or delete entries from the editor.
- Add `data-cv-block` to units that should never be split across a page break, and
  `data-cv-keep-next` to a heading that should stay with the block after it.
- Leave page size, page breaks, and page numbers out of the file entirely — the editor owns those.

Markup skeleton (mirrors `templates/sample-resume.html`):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Full Name — Résumé</title>
<style>
.cv-page {
  --cv-content-w: 562pt;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9pt; line-height: 1.15; color: #000; background: #fff;
}
/* … the rest of their design, scoped under .cv-page … */
</style>
</head>
<body>
<div class="cv-page">
  <div class="cv-header" data-cv-edit>…</div>
  <div class="cv-summary" data-cv-edit>…</div>
  <div data-cv-repeat="job" data-cv-block>
    <div class="cv-h2" data-cv-keep-next>Title — Company</div>
    <div class="cv-flow" data-cv-edit><p>…</p></div>
  </div>
</div>
</body>
</html>
```

Save it under `templates/` (e.g. `templates/my-resume.html`), then set it as the start-up template
in `config.js`'s `home` key (step 6). Load it once from the editor's **⋯ → Load source HTML…** menu
to confirm the regions are editable before wiring it up as the default.

## 6. Write config

Edit `<static dir>/labs/itera/config.js` only — it's already there with commented examples:

```js
window.ITERA = {
    home: "./templates/sample-resume.html",       // or the user's own file from step 5
    exportServer: "http://localhost:7332/export",  // only if Q3 = yes
    backHref: "/",                                  // only if Q4 = yes
};
```

If Q3 = yes, tell the user the command (don't run it yourself unless they ask):

```bash
cd <static dir>/labs/itera
npm i puppeteer
node server.mjs
```

## 7. Report back

Tell the user, in this order: the URL to open, what you set in `config.js` (from step 6), how to
export (PDF/DOCX/PNG from the toolbar, no server required unless they opted into one), and the
one-line reminder that Export → Source HTML is how they keep named variants — Itera only
autosaves one document per browser.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Blank page, nothing loads | Opened via `file://` instead of `http(s)://` — it must be served |
| 404 on `dist/chunks/*.js` | The folder was copied partially — re-copy the whole `itera/` folder, `dist/` included |
| Fonts look different from the design | Expected — fonts resolve to whatever the template's font stack finds on that machine; the sample uses Helvetica/Arial |
| PNG export fails with a script-load error | `vendor/html-to-image.js` is missing — re-copy the folder |
| Export server answers `501` | `puppeteer` isn't installed next to `server.mjs` — run `npm i puppeteer` there |
| Export server request blocked by CORS | The server only accepts `localhost` / `127.0.0.1` / `::1` origins — don't point `exportServer` at a non-localhost URL |

---

Made by [Q Manning](https://qmanning.com) · [Source on GitHub](https://github.com/qmanning/itera) · [See it live in the Labs](https://qmanning.com/labs/itera)
