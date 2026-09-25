// electron/build/dist.mjs — stamp this build, then run electron-builder with the stamp in the artifact NAME,
// so every dogfood DMG has a unique, sortable filename (IcedCoffee-0.2.1-0921.1530-arm64.dmg). `npm run dist*`.
//
// The stamp is a LOCAL convenience only, applied here as a command-line override. package.json keeps the
// canonical RELEASE names (IcedCoffee-<version>-mac-<arch>.zip), which is what the updater's pickAssets()
// looks for and what the release workflow — which calls electron-builder directly, without this script —
// therefore produces. See test/unit/updater.test.mjs: the two are pinned together.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import info from "./stamp.mjs";

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // decodes spaces in the path
// NOT a template literal: ${version} / ${arch} / ${ext} are electron-builder's own macros and must reach it intact
const stamped = "IcedCoffee-${version}-" + info.build + "-${arch}.${ext}";
const r = spawnSync("npx", [
    "electron-builder",
    `--config.mac.artifactName=${stamped}`,
    `--config.win.artifactName=${stamped}`,
    ...process.argv.slice(2),
], { stdio: "inherit", cwd: electronDir });
process.exit(r.status ?? 1);
