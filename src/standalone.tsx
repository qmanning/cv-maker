// src/standalone.tsx
// Standalone entry point: reads window.ITERA (set by ../config.js; window.CV_MAKER, the tool's name until September 2026, still works), resolves every URL relative to
// the page the script is loaded from (so this folder can live at any path — "/", "/labs/itera/",
// wherever), and mounts CvMaker into #itera (or #cv-maker, its old id).
import { createRoot } from "react-dom/client";
import CvMaker, { type CvFiles } from "./CvMaker";
import type { CvAssistant, CvRemote } from "./cv-assistant";
import "./cv-maker.css";

type Config = { home?: string; exportServer?: string; backHref?: string };

declare global {
    interface Window {
        ITERA?: Config;
        /** the old name of the same thing */
        CV_MAKER?: Config;
        /** set by a desktop shell's preload (electron/preload.cjs): real Open / Save instead of browser storage */
        cvMakerFiles?: CvFiles;
        /** set by the same preload: the person's own AI (their key never reaches this page) */
        cvMakerAssistant?: CvAssistant;
        /** and: an outside AI app (through the shell's MCP server) may drive the editor */
        cvMakerRemote?: CvRemote;
    }
}

const cfg: Config = window.ITERA || window.CV_MAKER || {};
const resolve = (p: string) => new URL(p, document.baseURI).href;

const el = document.getElementById("itera") || document.getElementById("cv-maker");
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
