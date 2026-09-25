// electron/export.mjs — PDF/PNG export inside the desktop app. Same contract as ../server.mjs
// ({ html, format: 'pdf'|'png', widthPt, heightPt, scale? } → bytes) and the same posture: the export
// HTML renders in a throwaway window with JavaScript OFF and every network request refused. The
// difference is the engine — Electron's own Chromium instead of a puppeteer download.
import { BrowserWindow, session } from "electron";

const PT_TO_PX = 96 / 72;
export const EXPORT_SCHEME = "cvx";   // serves the pending export HTML to the throwaway window (data: URLs cap out around 2MB)
const PARTITION = "cvm-export";       // no "persist:" prefix → in-memory, shares nothing with the editor window

const pending = new Map();
let seq = 0, ready = false;

function exportSession() {
    const ses = session.fromPartition(PARTITION);
    if (ready) return ses;
    ready = true;
    ses.protocol.handle(EXPORT_SCHEME, (req) => {
        const html = pending.get(new URL(req.url).pathname.slice(1));
        return html == null ? new Response("", { status: 404 }) : new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    });
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(data|about|blob|cvx):/i.test(d.url) }));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    return ses;
}

export function validExportBody(body) {
    return !!body && typeof body.html === "string" && ["pdf", "png"].includes(body.format) && body.widthPt > 0 && body.heightPt > 0;
}

export async function renderExport(body) {
    const width = Math.round(body.widthPt * PT_TO_PX), height = Math.round(body.heightPt * PT_TO_PX);
    const scale = Math.min(4, Math.max(1, body.scale || 2));
    const id = String(++seq);
    pending.set(id, body.html);
    // offscreen for PNG: a hidden window doesn't paint, an offscreen one does
    const win = new BrowserWindow({
        show: false, width, height, useContentSize: true,
        webPreferences: { session: exportSession(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: body.format === "png" },
    });
    try {
        await win.loadURL(`${EXPORT_SCHEME}://doc/${id}`);
        if (body.format === "pdf") {
            const pdf = await win.webContents.printToPDF({
                pageSize: { width: body.widthPt / 72, height: body.heightPt / 72 },   // inches
                printBackground: true,
                preferCSSPageSize: true,
                margins: { marginType: "none" },
                scale: Math.min(2, Math.max(0.1, body.fit || 1)),   // fit-to-one-page: printToPDF honours scale, CSS zoom it ignores
            });
            return { buffer: pdf, contentType: "application/pdf" };
        }
        // PNG the way puppeteer does it (full page, device scale factor) — over the DevTools protocol, since the page has no JS to ask
        const dbg = win.webContents.debugger;
        dbg.attach("1.3");
        try {
            await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
            const { cssContentSize } = await dbg.sendCommand("Page.getLayoutMetrics");
            const shot = await dbg.sendCommand("Page.captureScreenshot", {
                format: "png", captureBeyondViewport: true,
                clip: { x: 0, y: 0, width: Math.max(width, Math.ceil(cssContentSize.width)), height: Math.max(height, Math.ceil(cssContentSize.height)), scale: 1 },
            });
            return { buffer: Buffer.from(shot.data, "base64"), contentType: "image/png" };
        } finally { try { dbg.detach(); } catch { /* already gone */ } }
    } finally {
        pending.delete(id);
        if (!win.isDestroyed()) win.destroy();
    }
}
