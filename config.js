// config.js — optional defaults for Itera. Loaded as a classic script before dist/itera.js, so
// it just needs to set window.ITERA before that module runs. Every value is optional; uncomment
// and edit what you need, delete the rest. Paths are relative to this file's folder.
window.ITERA = {
    // the source HTML the editor starts from — your own résumé's markup (see templates/sample-resume.html
    // for the conventions: [data-cv-edit], .cv-flow, [data-cv-block], [data-cv-keep-next], [data-cv-repeat])
    // home: "./templates/sample-resume.html",

    // optional: point at a running `node server.mjs` for one-click PDF/PNG export in real headless Chrome.
    // Without this, PDF falls back to the browser's print dialog and PNG to an in-browser render — both
    // still work, no server required.
    // exportServer: "http://localhost:7332/export",

    // optional: show a back arrow in the toolbar that navigates here
    // backHref: "/",
};
