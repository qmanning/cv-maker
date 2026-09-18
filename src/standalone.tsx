// src/standalone.tsx
// Standalone entry point: reads window.CV_MAKER (set by ../config.js), resolves every URL relative to
// the page the script is loaded from (so this folder can live at any path — "/", "/labs/cv-maker/",
// wherever), and mounts CvMaker into #cv-maker.
import { createRoot } from "react-dom/client";
import CvMaker from "./CvMaker";
import "./cv-maker.css";

type Config = { home?: string; exportServer?: string; backHref?: string };

declare global {
    interface Window {
        CV_MAKER?: Config;
    }
}

const cfg: Config = window.CV_MAKER || {};
const resolve = (p: string) => new URL(p, document.baseURI).href;

const el = document.getElementById("cv-maker");
if (el) {
    createRoot(el).render(
        <CvMaker
            templateUrl={resolve(cfg.home ?? "./templates/sample-resume.html")}
            exportUrl={cfg.exportServer || undefined}
            backHref={cfg.backHref || undefined}
            glassCssUrl={resolve("./vendor/infospector/host.css")}
            rasterizerUrl={resolve("./vendor/html-to-image.js")}
        />,
    );
}
