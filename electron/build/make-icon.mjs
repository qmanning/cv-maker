// electron/build/make-icon.mjs — the app icon's one source is build/IcedCoffee.icon (Icon Composer: a gradient fill
// and the cup as a glass layer, see ICON-PACKAGING.md). macOS 26+ draws that package itself — its own mask, glass,
// dark / clear / tinted looks — so nothing here touches it. This script only makes what other places need from it:
//   IcedCoffee.icon → Apple's own flattened render (Xcode's actool) → build/icon.png (Windows .ico, older macOS)
//                                                                   → brand/icedcoffee-icon.png (the favicon)
//   dmg-background.html → background.png + background@2x.png (the installer window, drawn with Electron's Chromium)
//   npm run icon            (needs full Xcode 26+, as `npm run dist` does)
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

/** compile the Icon Composer package the way the build does, and take Apple's 1024² render out of the fallback .icns */
function flatten() {
    const developerDir = process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer";
    if (!fs.existsSync(path.join(developerDir, "usr/bin/actool"))) throw new Error("npm run icon needs full Xcode 26 or newer (it compiles build/IcedCoffee.icon with actool).");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "icedcoffee-icon-"));
    const run = (cmd, args) => { const r = spawnSync(cmd, args, { env: { ...process.env, DEVELOPER_DIR: developerDir }, encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`); };
    fs.cpSync(path.join(here, "IcedCoffee.icon"), path.join(work, "Icon.icon"), { recursive: true });
    run("xcrun", ["actool", path.join(work, "Icon.icon"), "--compile", work, "--app-icon", "Icon", "--include-all-app-icons", "--output-partial-info-plist", path.join(work, "partial.plist"),
        "--enable-on-demand-resources", "NO", "--development-region", "en", "--target-device", "mac", "--platform", "macosx", "--minimum-deployment-target", "11.0"]);
    run("sips", ["-s", "format", "png", path.join(work, "Icon.icns"), "--out", path.join(work, "icon.png")]);
    run("sips", ["-z", "1024", "1024", path.join(work, "icon.png")]);
    const png = fs.readFileSync(path.join(work, "icon.png"));
    fs.rmSync(work, { recursive: true, force: true });
    return png;
}

app.whenReady().then(async () => {
    const png = flatten();
    fs.writeFileSync(path.join(here, "icon.png"), png);
    fs.writeFileSync(path.resolve(here, "../../brand/icedcoffee-icon.png"), png);
    // drawn at 2× (CSS zoom) so the Retina background is sharp; the 1× file is that, halved
    const bg = fs.readFileSync(path.join(here, "dmg-background.html"), "utf8").replace("<html>", '<html style="zoom: 2">');
    await shot("data:text/html;charset=utf-8," + encodeURIComponent(bg), 1320, 960, [["background@2x.png", 1320], ["background.png", 660]], false);
    app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
