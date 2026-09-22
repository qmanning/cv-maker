// src/standalone.tsx
// Standalone entry point: reads window.ICEDCOFFEE (set by ../config.js; the older window.ITERA and window.CV_MAKER names still work), resolves every URL relative to
// the page the script is loaded from (so this folder can live at any path — "/", "/labs/icedcoffee/",
// wherever), and mounts CvMaker into #icedcoffee (or #cv-maker, its old id).
import { createRoot } from "react-dom/client";
import CvMaker, { type CvFiles } from "./CvMaker";
import type { CvAssistant, CvRemote } from "./cv-assistant";
import "./cv-maker.css";

type Config = { home?: string; exportServer?: string; backHref?: string };

declare global {
    interface Window {
        ICEDCOFFEE?: Config;
        /** older names of the same thing */
        ITERA?: Config;
        CV_MAKER?: Config;
        /** set by a desktop shell's preload (electron/preload.cjs): real Open / Save instead of browser storage */
        cvMakerFiles?: CvFiles;
        /** set by the same preload: the person's own AI (their key never reaches this page) */
        cvMakerAssistant?: CvAssistant;
        /** and: an outside AI app (through the shell's MCP server) may drive the editor */
        cvMakerRemote?: CvRemote;
    }
}

const cfg: Config = window.ICEDCOFFEE || window.ITERA || window.CV_MAKER || {};
const resolve = (p: string) => new URL(p, document.baseURI).href;

const el = document.getElementById("icedcoffee") || document.getElementById("cv-maker");
// desktop shell (Electron): its preload sets cvMakerFiles. Mark it so the toolbar can host the window
// controls (hidden title bar) and stay draggable.
if (window.cvMakerFiles) document.documentElement.classList.add("cvm-desktop");
if (el) {
    createRoot(el).render(
        <CvMaker
            templateUrl={resolve(cfg.home ?? "./templates/sample-resume.html")}
            exportUrl={cfg.exportServer || undefined}
            backHref={cfg.backHref || undefined}
            glassCssUrl={resolve("./vendor/infospector/host.css")}
            rasterizerUrl={resolve("./vendor/html-to-image.js")}
            files={window.cvMakerFiles}
            assistant={window.cvMakerAssistant}
            remote={window.cvMakerRemote}
        />,
    );
}
