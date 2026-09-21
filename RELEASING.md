# Releasing Itera (desktop)

Installed copies of Itera update themselves from this repo's **published GitHub Releases**. A release is only
accepted by the app if its archive is signed with Itera's update key.

## One-time setup: the update-signing key
- The **public** half lives in `electron/updater-core.mjs` (`UPDATE_PUBLIC_KEY`).
- The **private** half must be a repository secret named **`ITERA_UPDATE_KEY`** (the whole PEM, including the
  `BEGIN/END PRIVATE KEY` lines): GitHub → Settings → Secrets and variables → Actions → New repository secret.
  Or, from a terminal: `gh secret set ITERA_UPDATE_KEY -R qmanning/itera < itera-update-private-key.pem`
- Keep a copy of the private key somewhere safe (a password manager). **If it is lost**, no installed copy can
  self-update any more: you would generate a new pair, ship the new public key in a release, and everyone has to
  install that release by hand once. **If it leaks**, do the same, promptly.
- Without the secret the workflow still builds, but nothing is signed, and installed copies only offer
  "Open the Download Page" for that release.

## Cutting a release
1. Bump `version` in `electron/package.json` (and `package.json`), move the CHANGELOG's *Unreleased* under the new version.
2. Merge to `main`, then tag it: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **desktop-release** workflow builds macOS (`.dmg` to install, `.zip` + `.zip.sig` for updates) and Windows,
   and attaches everything to a **draft** release.
4. Check the draft has, per Mac architecture: `Itera-<v>-mac-<arch>.dmg`, `.zip` and `.zip.sig`. Publish it.
   Installed copies see it on their next launch (they only look at the latest *published*, non-pre-release release).

## What the app does with it
`electron/updater.mjs`: asks `api.github.com/repos/qmanning/itera/releases/latest` once per launch (menu: *Itera ▸ Check
Automatically* switches that off; *Check for Updates…* asks now) → downloads the archive and its `.sig` → refuses it
unless the Ed25519 signature verifies → unpacks it next to the installed app, checks the bundle id, the version and
the code signature → swaps the bundles after quitting and reopens. macOS only for now; on Windows the dialog opens
the download page.

## Testing the updater without a release
Point a packaged copy at a feed on your own computer (only `127.0.0.1` / `localhost` is honoured):
`CVM_UPDATE_FEED=http://127.0.0.1:<port>/latest`, plus `CVM_UPDATE_AUTO=1` to accept without the dialog and
`CVM_INSTALL_DIR=<folder>` so the copy in that folder counts as "installed". The feed returns GitHub's release JSON shape.
