// electron/build/make-icon.mjs — renders the build artwork with Electron's own Chromium, so the repo needs
// no image tooling:  brand/iced-coffee-icon-yellow-1.png → icon.png (1024²; electron-builder makes .icns / .ico)
//                    dmg-background.html → background.png + background@2x.png (the installer window)
//   npm run icon
import { app, BrowserWindow, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
app.dock?.hide();
app.on("window-all-closed", () => {});   // stay alive between shots (the default is to quit)

async function shot(url, width, height, outputs, transparent) {
    const win = new BrowserWindow({ show: false, width, height, useContentSize: true, transparent, frame: false, webPreferences: { offscreen: true, javascript: false } });
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    for (const [file, w] of outputs) fs.writeFileSync(path.join(here, file), img.resize({ width: w, quality: "best" }).toPNG());
    win.destroy();
}

app.whenReady().then(async () => {
    const source = path.resolve(here, "../../brand/iced-coffee-icon-yellow-1.png");
    const icon = nativeImage.createFromPath(source);
    const size = icon.getSize();
    if (icon.isEmpty() || size.width !== size.height) throw new Error("The app icon must be a square PNG: " + source);
    // Preserve every visible shadow pixel; remove the empty border in the smallest square.
    const pixels = icon.toBitmap();
    let left = size.width, top = size.height, right = -1, bottom = -1;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        if (!pixels[(y * size.width + x) * 4 + 3]) continue;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    if (right < left) throw new Error("The icon is transparent");
    const edge = Math.max(right - left + 1, bottom - top + 1);
    const x = Math.max(0, Math.min(size.width - edge, Math.floor((left + right + 1 - edge) / 2)));
    const y = Math.max(0, Math.min(size.height - edge, Math.floor((top + bottom + 1 - edge) / 2)));
    const png = icon.crop({ x, y, width: edge, height: edge }).resize({ width: 1024, height: 1024, quality: "best" }).toPNG();
    fs.writeFileSync(path.join(here, "icon.png"), png);
    // Keep the modern macOS package on the exact same artwork as the legacy icon.
    const composerAssets = path.join(here, "IcedCoffee.icon", "Assets");
    fs.mkdirSync(composerAssets, { recursive: true });
    fs.writeFileSync(path.join(composerAssets, "Artwork.png"), png);
    fs.writeFileSync(path.resolve(here, "../../brand/icedcoffee-icon.png"), png);
    console.log(`Cropped ${size.width} to ${edge} square at ${x},${y}`);
    // drawn at 2× (CSS zoom) so the Retina background is sharp; the 1× file is that, halved
    const bg = fs.readFileSync(path.join(here, "dmg-background.html"), "utf8").replace("<html>", '<html style="zoom: 2">');
    await shot("data:text/html;charset=utf-8," + encodeURIComponent(bg), 1320, 960, [["background@2x.png", 1320], ["background.png", 660]], false);
    app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
