// build.mjs — esbuild build for the standalone IcedCoffee.
//
// The source files under src/ are kept byte-identical to the site's originals (see src/README-ish
// comment at the top of use-infospector-look.ts) so they can be re-synced by copying. That means two
// of their imports point at paths that don't exist in this repo's layout:
//   - "@/components/ui/font-size-extension" / "font-weight-extension"  (a Next.js path alias)
//   - a long "../../../../public/labs/infospector/{lib,colorpicker}.js" relative import
// This plugin remaps both at resolve time instead of editing the source files.
//
// `remapImports` and `buildOptions` are exported so tests can bundle src/ with the exact same resolve
// rules the real build uses (see test/unit/_helpers.mjs) without duplicating this logic. Importing this
// module never triggers a build on its own — only running it directly (`node build.mjs`) does, guarded
// by the `import.meta.url` check at the bottom.
import fs from "node:fs";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('esbuild').Plugin} */
export const remapImports = {
    name: "remap-site-imports",
    setup(b) {
        b.onResolve({ filter: /@\/components\/ui\/(font-size|font-weight)-extension$/ }, (args) => {
            const m = args.path.match(/@\/components\/ui\/(font-size|font-weight)-extension$/);
            return { path: path.join(here, "src", "shared", `${m[1]}-extension.ts`) };
        });
        b.onResolve({ filter: /public\/labs\/infospector\/(lib|colorpicker)\.js$/ }, (args) => {
            const m = args.path.match(/public\/labs\/infospector\/(lib|colorpicker)\.js$/);
            return { path: path.join(here, "vendor", "infospector", `${m[1]}.js`) };
        });
    },
};

/**
 * The esbuild options the real build runs with. `outdir` defaults to dist/ but callers (tests) can
 * point it at a temp directory instead so they never overwrite the committed build.
 * @param {{ outdir?: string }} [opts]
 */
export function buildOptions({ outdir } = {}) {
    return {
        entryPoints: [path.join(here, "src", "standalone.tsx")],
        outdir: outdir || path.join(here, "dist"),
        entryNames: "icedcoffee",
        chunkNames: "chunks/[name]-[hash]",
        bundle: true,
        splitting: true,
        format: "esm",
        minify: true,
        sourcemap: false,
        target: "es2020",
        jsx: "automatic",
        loader: { ".css": "css" },
        define: { "process.env.NODE_ENV": '"production"' },
        // docx's browser code path base64-decodes with atob() and only falls back to Node's Buffer when
        // atob is unavailable (never true in a browser) — mark it external so esbuild doesn't need the
        // "buffer" package installed to resolve that dead branch.
        external: ["buffer"],
        plugins: [remapImports],
        logLevel: "info",
    };
}

export async function runBuild(opts) {
    const options = buildOptions(opts);
    // chunk names carry a content hash, so every build would otherwise leave the previous build's chunks behind —
    // and dist/ is committed and shipped. Start from an empty output folder.
    fs.rmSync(options.outdir, { recursive: true, force: true });
    return build(options);
}

const isMain = (() => {
    try {
        return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
})();

if (isMain) {
    await runBuild();
    console.log("Built dist/icedcoffee.js + dist/icedcoffee.css");
}
