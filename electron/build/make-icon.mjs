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
    fs.writeFileSync(path.join(here, "icon.png"), icon.resize({ width: 1024, height: 1024, quality: "best" }).toPNG());
    // drawn at 2× (CSS zoom) so the Retina background is sharp; the 1× file is that, halved
    const bg = fs.readFileSync(path.join(here, "dmg-background.html"), "utf8").replace("<html>", '<html style="zoom: 2">');
    await shot("data:text/html;charset=utf-8," + encodeURIComponent(bg), 1320, 960, [["background@2x.png", 1320], ["background.png", 660]], false);
    app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
