// electron/build/stamp.mjs — every build says which build it is. Writes electron/build-info.json (shipped in the app):
// the version from package.json, a build stamp (MMDD.HHMM, local time) and the commit. Run by `npm run dist*`.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const d = new Date(), two = (n) => String(n).padStart(2, "0");
const git = (cmd) => { try { return execSync(cmd, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const info = { version, build: `${two(d.getMonth() + 1)}${two(d.getDate())}.${two(d.getHours())}${two(d.getMinutes())}`, commit: git("git rev-parse --short HEAD") + (git("git status --porcelain") ? "+" : ""), builtAt: d.toISOString() };
fs.writeFileSync(path.join(root, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
console.log(`Itera ${info.version} · build ${info.build} · ${info.commit}`);
export default info;
