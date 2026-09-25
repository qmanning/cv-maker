# macOS icon packaging

The default `build.mac.icon` is `build/IcedCoffee.icon`. Electron-builder compiles
it using Xcode's `actool`, embeds `Assets.car`, and sets `CFBundleIconName` to `Icon`.
This avoids the gray backing macOS adds to the previous legacy-only icon.
A fallback `icon.icns` is also generated for older macOS versions.

The artwork is the approved `brand/icedcoffee-icon-source.png`, resized to 1024px.
`npm run icon` refreshes both `build/icon.png` (Windows/web artwork) and
`build/IcedCoffee.icon/Assets/Artwork.png`. No additional background or glass
effects are requested in the Icon Composer manifest.

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
