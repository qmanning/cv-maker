// electron/updater-core.mjs — the parts of the updater that need no Electron, so plain `node --test` can cover them:
// which version is newer, which release files are ours, and whether a download is really from Itera's publisher.
import crypto from "node:crypto";

// The PUBLIC half of Itera's update-signing key (Ed25519). The private half signs every release in CI
// (secret ITERA_UPDATE_KEY) and never lives in this repo. An update whose signature this key doesn't verify is refused.
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/Ib2aUzxIsFblaf0O0ikSMRlFvYwgQe36i3XyukKO2E=
-----END PUBLIC KEY-----`;

const parse = (v) => { const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || "").trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || "" } : null; };
/** is version `a` newer than `b`? (semver order; a pre-release is older than its release; anything unparseable is never newer) */
export function newer(a, b) {
    const x = parse(a), y = parse(b); if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i];
    if (x.pre === y.pre) return false;
    return !x.pre || (!!y.pre && x.pre > y.pre);
}

/** from a GitHub release: the update archive for this platform + arch, and its detached signature */
export function pickAssets(release, platform, arch) {
    const version = String(release?.tag_name || "").replace(/^v/, "");
    const want = platform === "darwin" ? `Itera-${version}-mac-${arch}.zip` : platform === "win32" ? `Itera-${version}-win-${arch}.exe` : "";
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const file = assets.find((a) => a?.name === want), sig = assets.find((a) => a?.name === want + ".sig");
    return { version, name: want, url: file?.browser_download_url || "", sigUrl: sig?.browser_download_url || "", size: file?.size || 0, notesUrl: release?.html_url || "" };
}

/** true only if `signatureBase64` is a valid Ed25519 signature of `data` by the holder of `publicKeyPem` */
export function verifyUpdate(data, signatureBase64, publicKeyPem = UPDATE_PUBLIC_KEY) {
    try {
        const sig = Buffer.from(String(signatureBase64 || "").trim(), "base64");
        return sig.length === 64 && crypto.verify(null, data, crypto.createPublicKey(publicKeyPem), sig);
    } catch { return false; }
}
export const signUpdate = (data, privateKeyPem) => crypto.sign(null, data, crypto.createPrivateKey(privateKeyPem)).toString("base64");
