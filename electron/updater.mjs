// electron/updater.mjs — Itera updates itself. Electron's own macOS updater needs an Apple-signed app; this doesn't:
//   1. ask GitHub for the latest published release (the only network request Itera ever makes on its own; it can be switched off)
//   2. download this platform's archive + its detached signature, and REFUSE it unless the signature verifies against
//      the publisher's public key baked into updater-core.mjs (the release workflow signs with the private half)
//   3. unpack it beside the installed app, check it really is Itera at that version with an intact code signature,
//      then swap the bundles once this process has exited, and reopen.
// A file the app downloads itself carries no "downloaded from the internet" flag, so macOS doesn't stop the person again.
import { app, dialog, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newer, pickAssets, verifyUpdate } from "./updater-core.mjs";

const FEED = "https://api.github.com/repos/qmanning/itera/releases/latest";
const MAX_BYTES = 600 * 1024 * 1024;

export function setupUpdater({ editorWindow, installedCopy, runningFromInstall }) {
    const prefsFile = () => path.join(app.getPath("userData"), "updates.json");
    let prefs = { auto: true, skipped: "" }, busy = false;
    try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), "utf8")) }; } catch { /* defaults */ }
    const savePrefs = () => { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch { /* not worth a dialog */ } };

    // tests point the app at a feed on this computer; nothing else is honoured
    const feed = () => { const f = process.env.CVM_UPDATE_FEED || ""; try { return f && ["127.0.0.1", "localhost"].includes(new URL(f).hostname) ? f : FEED; } catch { return FEED; } };
    const auto = !!process.env.CVM_UPDATE_AUTO;                        // tests: answer "Update" without a dialog
    const win = () => { const w = editorWindow(); return w && !w.isDestroyed() ? w : undefined; };
    const ask = (options) => dialog.showMessageBoxSync(win(), { noLink: true, ...options });
    const canSelfUpdate = () => process.platform === "darwin" && app.isPackaged && runningFromInstall();

    async function latest() {
        const res = await fetch(feed(), { headers: { accept: "application/vnd.github+json", "user-agent": `Itera/${app.getVersion()}` }, signal: AbortSignal.timeout(15000) });
        if (res.status === 404) return null;                           // no release published yet
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        return pickAssets(await res.json(), process.platform, process.arch);
    }

    // straight to disk: a release archive is ~130 MB, and collecting it in memory first would briefly hold it twice
    async function downloadTo(file, url, onProgress) {
        const res = await fetch(url, { headers: { "user-agent": `Itera/${app.getVersion()}`, accept: "application/octet-stream" }, signal: AbortSignal.timeout(20 * 60 * 1000) });
        if (!res.ok || !res.body) throw new Error(`the download failed (${res.status})`);
        const total = Number(res.headers.get("content-length")) || 0, out = fs.createWriteStream(file); let got = 0;
        try {
            for await (const chunk of res.body) {
                got += chunk.length; if (got > MAX_BYTES) throw new Error("the download is implausibly large");
                if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
                onProgress?.(total ? got / total : 2);
            }
        } finally { await new Promise((r) => out.end(r)); }
    }

    async function install(update) {
        const { dest } = installedCopy(), parent = path.dirname(dest), w = win();
        const stage = fs.mkdtempSync(path.join(parent, ".itera-update-"));
        try {
            w?.setProgressBar(2);
            const zip = path.join(stage, "update.zip"), sigFile = path.join(stage, "update.zip.sig");
            await Promise.all([downloadTo(zip, update.url, (p) => w?.setProgressBar(p)), downloadTo(sigFile, update.sigUrl)]);
            if (fs.statSync(sigFile).size > 4096 || !verifyUpdate(fs.readFileSync(zip), fs.readFileSync(sigFile, "utf8"))) throw new Error("the download isn't signed by Itera's publisher, so it was thrown away");
            fs.rmSync(sigFile);
            const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) throw new Error((r.stderr || r.error?.message || cmd + " failed").trim().split("\n")[0]); return r.stdout.trim(); };
            run("/usr/bin/ditto", ["-x", "-k", zip, stage]); fs.rmSync(zip);
            const fresh = path.join(stage, path.basename(dest));
            if (!fs.existsSync(fresh)) throw new Error("the update didn't contain " + path.basename(dest));
            const plist = path.join(fresh, "Contents", "Info.plist");
            if (run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist]) !== "com.qmanning.itera") throw new Error("the update isn't Itera");
            if (run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]) !== update.version) throw new Error("the update isn't the version it claims to be");
            run("/usr/bin/codesign", ["--verify", "--deep", "--strict", fresh]);
            // the swap happens after this process is gone: a small shell script waits for our pid, moves the bundles, reopens
            const script = path.join(stage, "swap.sh"), old = path.join(stage, "previous.app");
            const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            fs.writeFileSync(script, ["#!/bin/sh", `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
                `mv ${q(dest)} ${q(old)} && mv ${q(fresh)} ${q(dest)} || { mv ${q(old)} ${q(dest)} 2>/dev/null; exit 1; }`,
                process.env.CVM_UPDATE_NO_RELAUNCH ? ":" : `/usr/bin/open -n ${q(dest)}`, `rm -rf ${q(stage)}`, ""].join("\n"), { mode: 0o755 });
            spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
            setTimeout(() => app.exit(0), 200);                        // unsaved edits are in the autosave and come back marked unsaved
            return true;
        } catch (e) { fs.rmSync(stage, { recursive: true, force: true }); throw e; }
        finally { w?.setProgressBar(-1); }
    }

    async function check({ manual = false } = {}) {
        if (busy) return; busy = true;
        try {
            const update = await latest();
            if (!update || !newer(update.version, app.getVersion())) { if (manual) ask({ type: "info", message: "Itera is up to date.", detail: `You have version ${app.getVersion()}.`, buttons: ["OK"] }); return { available: "" }; }
            if (!manual && prefs.skipped === update.version) return { available: update.version, skipped: true };
            const selfUpdate = canSelfUpdate() && !!update.url && !!update.sigUrl;
            const buttons = selfUpdate ? ["Update and Reopen", "Later", "Release Notes", "Skip This Version"] : ["Open the Download Page", "Later", "Skip This Version"];
            const choice = auto ? 0 : ask({ type: "info", buttons, defaultId: 0, cancelId: 1, message: `Itera ${update.version} is available.`,
                detail: `You have ${app.getVersion()}. ` + (selfUpdate ? "Itera will download it, check that it really comes from Itera's publisher, install it and reopen. Edits you haven't saved are kept." : "Get it from the download page and install it over this one.") });
            const picked = buttons[choice];
            if (picked === "Skip This Version") { prefs.skipped = update.version; savePrefs(); }
            if (picked === "Release Notes" || picked === "Open the Download Page") shell.openExternal(update.notesUrl || "https://github.com/qmanning/itera/releases/latest");
            if (picked === "Update and Reopen") await install(update);
            return { available: update.version };
        } catch (e) {
            console.log("[update] " + (e?.message || e));
            if (manual && !auto) ask({ type: "warning", message: "Itera couldn't update.", detail: String(e?.message || e) + "\n\nNothing was changed. You can get the latest version from github.com/qmanning/itera/releases.", buttons: ["OK"] });
            return { error: String(e?.message || e) };
        } finally { busy = false; }
    }

    return {
        check,
        auto: () => prefs.auto,
        setAuto: (v) => { prefs.auto = !!v; savePrefs(); },
        /** once per launch, a few seconds in, unless the person switched it off */
        start() { if (prefs.auto && (app.isPackaged || process.env.CVM_UPDATE_FEED)) setTimeout(() => check().catch(() => {}), process.env.CVM_UPDATE_FEED ? 1500 : 6000); },
    };
}
