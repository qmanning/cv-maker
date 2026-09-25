# macOS icon packaging

The default `build.mac.icon` is `build/IcedCoffee.icon`. Electron-builder compiles
it using Xcode's `actool`, embeds `Assets.car`, and sets `CFBundleIconName` to `Icon`.
This avoids the gray backing macOS adds to the previous legacy-only icon.
A fallback `icon.icns` is also generated for older macOS versions.

`build/IcedCoffee.icon` is the one source. Its `Assets/Artwork.png` is the acrylic
texture **edge to edge**: `brand/icedcoffee-icon-source.png` (2048²) with its baked
tile edge cropped away (1648² from 200,200) and resized to 1024². macOS applies its
own rounded mask and rim, so the artwork must not carry a tile shape, corners or
transparency of its own — a baked tile is what produced the clipped bevel (and, as
a legacy `.icns`, the gray backing plate). No glass, shadow or specular effects are
requested in the manifest.

Edit the package in Icon Composer (`/Applications/Xcode.app/Contents/Applications/`):
it has per-appearance (Default / Dark / Clear / Tinted) controls for fill, opacity,
translucency, blur, shadow and specular. Then run `npm run icon`: it compiles the
package with `actool` and writes Apple's flattened render to `build/icon.png`
(Windows, older macOS) and `brand/icedcoffee-icon.png` (the favicon).

## Building

Full Xcode 26 or newer must be installed and its first-launch setup completed.
Run `npm run dist:test` from `electron/`. The build wrapper uses Xcode.app when
available without changing the global developer-tool selection. An explicit
`DEVELOPER_DIR` takes precedence. CI invoking electron-builder directly must
have full Xcode selected, or set `DEVELOPER_DIR` itself.

## Verification

Compiled successfully with Xcode 27. The packaged app contains `Assets.car`,
`CFBundleIconName=Icon`, and its fallback ICNS. Rendering the packaged app through
macOS NSWorkspace shows the approved gold artwork without the gray backing.
The application signature and Apple Silicon DMG checksum were verified.
Older macOS fallback appearance has not been tested on an older OS.

Source artwork equality alone is insufficient: inspect the system-rendered icon
after changing this package. macOS applies its own mask and icon appearance.
