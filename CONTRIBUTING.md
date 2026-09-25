# Contributing

Thanks for looking. IcedCoffee is a small, opinionated project — a résumé is one HTML file you own, and
the editor is a prebuilt folder you can drop on any static host. Changes that keep that true are easy to
land; changes that add a build step, a server, or a dependency on someone else's service are a hard sell.

## Getting set up

```bash
npm install
npm test           # 88 tests, a couple of seconds
npm run serve      # http://localhost:7333 — the web version, against dist/
```

For the desktop app:

```bash
cd electron
npm install
npm start
```

Node 20 or newer, for both.

## The two things that trip people up

**`dist/` is committed, and it is what ships.** "One prebuilt folder, no build" is the point of the
project: people download the folder and open `index.html`. So any change under `src/` needs
`npm run build` run and `dist/` committed *in the same change*. `npm test` compares the committed build
against a fresh one byte for byte and fails if they've drifted.

**`src/` is kept byte-identical to the author's own site**, so files can be re-synced by copying. Two of
its imports therefore point at paths that don't exist in this repo — a Next.js `@/components/ui/…` alias
and a long relative path into `public/labs/infospector/`. `build.mjs` remaps both at resolve time.
Don't "fix" those imports. Likewise `vendor/infospector/` is a verbatim copy; re-copy it from upstream
rather than editing it here.

## Before you open a pull request

```bash
npm run typecheck   # tsc --noEmit, must be clean
npm test            # must be green
npm run build       # and commit dist/ if src/ changed
```

CI runs the same three on every push and pull request.

If you touched the desktop app, `cd electron && npm run smoke` drives the real UI end to end — export,
save, file watching, the AI prompt bar, and the MCP tools — and writes its evidence to `electron/.smoke/`.
It needs a display and takes a minute or two.

## House style

The code is dense on purpose and the comments carry the reasoning — *why* this posture, not *what* the
line does. Match the surrounding file: same comment density, same naming, same idiom. If a change needs
a paragraph of explanation, that paragraph belongs above the code.

Tests are `node:test` with no framework. A bug fix should come with the test that would have caught it.

## Security

Please don't report security problems as issues — see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree your work is published under this project's [MIT licence](LICENSE).
