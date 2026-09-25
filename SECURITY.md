# Security

IcedCoffee edits a document that is, by its nature, full of personal information, and the desktop app
holds an API key and can install its own updates. Reports are welcome.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Use GitHub's private reporting:

**[Report a vulnerability](https://github.com/qmanning/icedcoffee/security/advisories/new)**

Include what you did, what happened, and which build (*IcedCoffee ▸ About* shows the version and build
stamp; the web version's is in the brand menu). A proof of concept helps but isn't required.

Expect an acknowledgement within a week. This is a one-person project with no bounty programme — what
you get is credit in the release notes, unless you'd rather not be named.

## What's in scope

- The desktop app: the `app://` protocol handler, the preload bridges, the IPC surface, the MCP server
  and its local socket, the updater, and the export renderer.
- The web version: anything that makes an opened source file able to run code, reach the network, or
  read another origin.
- The release pipeline: the update signing key's use, and anything that would let an unsigned or
  substituted build install itself.

## What isn't

- **The builds are unsigned.** IcedCoffee ships without an Apple or Microsoft code-signing certificate,
  so your OS warns on first launch. That's a known, documented trade-off, not a vulnerability — see
  *Desktop app ▸ First launch* in the README. Updates are signed separately with IcedCoffee's own
  Ed25519 key and refused if that signature doesn't verify.
- **A connected AI app is trusted.** Once you connect an AI app over MCP, its tools can open any
  `.html` file and embed any image file on your computer, and edit and save your documents. That is the
  feature. Connect only AI apps you'd trust with those files anyway.
- **An API key you configure is sent to the provider you chose.** It's encrypted at rest with your OS
  keychain and stays in the main process, but the point of it is to make requests.
- Anything that needs an attacker to already be running code as your user account, or to set the app's
  environment variables.

## Where the security-relevant code lives

| Area | File |
| --- | --- |
| Window/CSP setup, `app://` allowlist, export endpoint | `electron/main.mjs` |
| The renderer's entire bridge to the shell | `electron/preload.cjs` |
| File open/save, IPC sender checks, `openExternal` filter | `electron/files.mjs` |
| API key storage and provider calls | `electron/assistant.mjs`, `electron/assistant/*` |
| MCP socket, config writers | `electron/mcp.mjs`, `electron/mcp/*` |
| Update signature verification | `electron/updater-core.mjs`, `electron/updater.mjs` |
| Sanitising an opened source file | `src/cv-source.ts` (`parseSource`) |
| Sanitising model-written HTML | `src/cv-assistant.ts` (`cleanHtml`) |
