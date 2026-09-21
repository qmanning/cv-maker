#!/usr/bin/env node
// electron/build/sign-update.mjs — writes <file>.sig (Ed25519, base64) next to each file given, using the private key in
// $ITERA_UPDATE_KEY (PEM) or the file named by $ITERA_UPDATE_KEY_FILE. Run by the release workflow; the app's updater
// refuses any download whose .sig doesn't verify against the public key in ../updater-core.mjs.
import fs from "node:fs";
import { signUpdate, verifyUpdate } from "../updater-core.mjs";
const pem = process.env.ITERA_UPDATE_KEY || (process.env.ITERA_UPDATE_KEY_FILE ? fs.readFileSync(process.env.ITERA_UPDATE_KEY_FILE, "utf8") : "");
if (!pem.trim()) { console.error("::warning::sign-update: no ITERA_UPDATE_KEY secret. Nothing was signed, so installed copies will only offer the download page for this release instead of updating themselves."); process.exit(0); }
for (const file of process.argv.slice(2)) {
    const data = fs.readFileSync(file), sig = signUpdate(data, pem);
    if (!verifyUpdate(data, sig)) { console.error(`sign-update: ${file}: signed with a key that doesn't match the app's public key`); process.exit(1); }
    fs.writeFileSync(file + ".sig", sig + "\n"); console.log(`signed ${file}`);
}
