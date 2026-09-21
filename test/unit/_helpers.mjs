// test/unit/_helpers.mjs — shared helpers for Itera's node:test unit suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { remapImports } from "../../build.mjs";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(here, "..", "..");

/** Reads a src/ TS file and transforms it (not bundled) to ESM JS with esbuild's transformSync. */
export function readSrc(relPath) {
    return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** Dynamic-imports a single TS file after transforming it (no bundling — for files with no imports
 * of their own besides ones already resolvable, e.g. cv-source.ts). */
export async function importTransformed(relPath) {
    const src = readSrc(relPath);
    const { code } = transformSync(src, { loader: "ts", format: "esm" });
    const modUrl = "data:text/javascript;base64," + Buffer.from(code, "utf8").toString("base64");
    return import(modUrl);
}

const bundleCommonOpts = (external) => ({
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2020",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"test"' },
    external: ["react", "react-dom", "react-dom/client", "buffer", ...external],
    plugins: [remapImports],
    logLevel: "silent",
});

/** Writes the bundled JS text to a temp .mjs file (needed because dynamic `import()` of a data: URL
 * can't resolve bare specifiers — Node has already bundled them away here, but the file still needs a
 * real path to import from), dynamic-imports it, then removes the temp file. */
async function importBundleText(text) {
    const tmpFile = path.join(os.tmpdir(), `itera-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(tmpFile, text, "utf8");
    try {
        return await import(pathToFileURL(tmpFile).href);
    } finally {
        fs.rm(tmpFile, () => {});
    }
}

/**
 * Bundles a TS/TSX entry point (relative to the repo root) into a standalone ESM module, using the
 * SAME resolve plugin build.mjs uses for the real build (so "@/components/ui/font-size-extension" and
 * the infospector vendor paths resolve identically), then dynamic-imports it. Returns the imported
 * module namespace.
 */
export async function bundleAndImport(entryRelPath, { external = [] } = {}) {
    const entry = path.join(repoRoot, entryRelPath);
    const result = await build({ entryPoints: [entry], ...bundleCommonOpts(external) });
    const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
    if (!jsFile) throw new Error(`bundleAndImport: no JS output for ${entryRelPath}`);
    return importBundleText(jsFile.text);
}

/**
 * Bundles an inline ESM source string (e.g. a small test-only "entry" that re-exports pieces of src/
 * alongside npm packages) using esbuild's `stdin` option — no temp source file needed on disk, only the
 * bundled output does (see importBundleText). `resolveDir` anchors relative imports written in
 * `source`; pass repoRoot so `import ".../src/cv-extensions"`-style relative paths work, or use an
 * absolute path directly in the source and it doesn't matter.
 */
export async function bundleSourceAndImport(source, { resolveDir = repoRoot, external = [] } = {}) {
    const result = await build({
        stdin: { contents: source, resolveDir, loader: "ts", sourcefile: "test-entry.ts" },
        ...bundleCommonOpts(external),
    });
    const jsFile = result.outputFiles.find((f) => !f.path.endsWith(".css"));
    if (!jsFile) throw new Error("bundleSourceAndImport: no JS output");
    return importBundleText(jsFile.text);
}

/** Installs a jsdom global environment (document, DOMParser, window, navigator) for tests that need
 * one — e.g. anything touching DOMParser or mounting a TipTap Editor. Call once per test file, before
 * importing code that touches `document` at call time (module-level DOM access would still run too
 * early — none of the code under test does that). Idempotent-ish: only fills in globals not already set. */
export function installJsdom() {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
    const set = (name, value) => {
        try {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
        } catch {
            /* some globals (e.g. Node 21+'s own `navigator`) are non-configurable getters; leave as-is */
        }
    };
    Object.getOwnPropertyNames(dom.window).forEach((prop) => {
        if (!(prop in globalThis)) set(prop, dom.window[prop]);
    });
    set("window", dom.window);
    set("document", dom.window.document);
    set("navigator", dom.window.navigator);
    set("DOMParser", dom.window.DOMParser);
    return dom;
}

/** Finds a free TCP port by binding to port 0 and reading it back. */
export async function getFreePort() {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** The machine's first non-loopback IPv4 address, or null if there isn't one (e.g. no network). */
export function nonLoopbackIPv4() {
    const nets = os.networkInterfaces();
    for (const ifaceList of Object.values(nets)) {
        for (const iface of ifaceList || []) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
    }
    return null;
}
