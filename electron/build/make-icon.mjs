// electron/build/make-icon.mjs — renders icon.svg → icon.png (1024², transparent) with Electron's own Chromium,
// so the repo needs no image tooling. electron-builder turns the PNG into .icns / .ico.   npx electron build/make-icon.mjs
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
app.dock?.hide();
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true, javascript: false } });
    const svg = fs.readFileSync(path.join(here, "icon.svg"), "utf8");
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`));
    await new Promise((r) => setTimeout(r, 300));
    const img = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 });
    fs.writeFileSync(path.join(here, "icon.png"), img.toPNG());
    app.exit(0);
});
