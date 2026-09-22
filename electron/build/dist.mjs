// electron/build/dist.mjs — stamp this build, then run electron-builder with the stamp in the artifact NAME,
// so every dogfood DMG has a unique, sortable filename (IcedCoffee-0.2.1-0921.1530-arm64.dmg). `npm run dist*`.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import info from "./stamp.mjs";

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // decodes spaces in the path
const r = spawnSync("npx", ["electron-builder", ...process.argv.slice(2)], {
    stdio: "inherit", cwd: electronDir, env: { ...process.env, ITERA_BUILD: info.build },
});
process.exit(r.status ?? 1);
