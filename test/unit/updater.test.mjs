// Unit tests for electron/updater-core.mjs — the updater's trust decisions, without Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./_helpers.mjs";
import { newer, pickAssets, verifyUpdate, signUpdate, UPDATE_PUBLIC_KEY } from "../../electron/updater-core.mjs";

test("newer(): semver order, v-prefix, pre-releases, junk", () => {
    assert.equal(newer("0.2.0", "0.1.9"), true);
    assert.equal(newer("v1.0.0", "0.99.99"), true);
    assert.equal(newer("0.1.0", "0.1.0"), false);
    assert.equal(newer("0.1.0", "0.2.0"), false);
    assert.equal(newer("0.10.0", "0.9.0"), true);
    assert.equal(newer("1.0.0", "1.0.0-beta.1"), true);
    assert.equal(newer("1.0.0-beta.1", "1.0.0"), false);
    assert.equal(newer("latest", "0.1.0"), false);
    assert.equal(newer("", "0.1.0"), false);
});

test("pickAssets(): only this platform's archive and its signature", () => {
    const rel = { tag_name: "v0.2.0", html_url: "https://example/notes", assets: ["IcedCoffee-0.2.0-mac-arm64.zip", "IcedCoffee-0.2.0-mac-arm64.zip.sig", "IcedCoffee-0.2.0-mac-x64.zip", "IcedCoffee-0.2.0-mac-arm64.dmg"].map((name) => ({ name, size: 5, browser_download_url: "https://example/" + name })) };
    const a = pickAssets(rel, "darwin", "arm64");
    assert.equal(a.version, "0.2.0"); assert.match(a.url, /mac-arm64\.zip$/); assert.match(a.sigUrl, /mac-arm64\.zip\.sig$/);
    const x = pickAssets(rel, "darwin", "x64");
    assert.match(x.url, /mac-x64\.zip$/); assert.equal(x.sigUrl, "");          // unsigned → the updater must refuse it
    assert.equal(pickAssets({}, "darwin", "arm64").url, "");
});

test("verifyUpdate(): accepts the publisher's signature, refuses everything else", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "pem" }), priv = privateKey.export({ type: "pkcs8", format: "pem" });
    const data = Buffer.from("the new IcedCoffee"), sig = signUpdate(data, priv);
    assert.equal(verifyUpdate(data, sig, pub), true);
    assert.equal(verifyUpdate(Buffer.from("the new IcedCoffee, tampered"), sig, pub), false);
    assert.equal(verifyUpdate(data, sig), false);                                  // signed by someone who isn't IcedCoffee's publisher
    assert.equal(verifyUpdate(data, "", pub), false);
    assert.equal(verifyUpdate(data, "not base64 at all", pub), false);
    assert.equal(verifyUpdate(data, sig.slice(0, 20), pub), false);
    assert.match(UPDATE_PUBLIC_KEY, /BEGIN PUBLIC KEY/);
});

/* ---- the release names and the updater must agree, or the app can never update itself ----
   electron-builder expands `build.<platform>.artifactName` at packaging time. Two ways this has broken:
     • an `${env.X}` macro that the release workflow doesn't set — electron-builder THROWS
       (ERR_ELECTRON_BUILDER_ENV_NOT_DEFINED) and the whole platform's build fails;
     • a name that packages fine but that pickAssets() doesn't recognise — the app silently loses
       self-update and only ever offers the download page.
   So: no env macros in the committed patterns, and what they expand to is what pickAssets() looks for. */
const builderConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "electron", "package.json"), "utf8")).build;
/** the subset of electron-builder's macros these patterns are allowed to use */
const expand = (pattern, { version, arch, ext }) =>
    pattern.replace(/\$\{version\}/g, version).replace(/\$\{arch\}/g, arch).replace(/\$\{ext\}/g, ext);

test("artifactName patterns use no ${env.*} macro (the release workflow sets none, and electron-builder throws)", () => {
    for (const platform of ["mac", "win"]) {
        const pattern = builderConfig[platform]?.artifactName;
        assert.ok(pattern, `electron/package.json build.${platform}.artifactName is missing`);
        assert.doesNotMatch(pattern, /\$\{env\./, `build.${platform}.artifactName uses an \${env.*} macro: the release workflow runs electron-builder directly and sets no such variable, so this platform's build would fail`);
    }
});

test("what electron-builder names a release is exactly what pickAssets() looks for", () => {
    const version = "9.9.9";
    const cases = [
        { platform: "darwin", builderKey: "mac", arch: "arm64", ext: "zip" },
        { platform: "darwin", builderKey: "mac", arch: "x64", ext: "zip" },
        { platform: "win32", builderKey: "win", arch: "x64", ext: "exe" },
        { platform: "win32", builderKey: "win", arch: "arm64", ext: "exe" },
    ];
    for (const { platform, builderKey, arch, ext } of cases) {
        const built = expand(builderConfig[builderKey].artifactName, { version, arch, ext });
        const release = { tag_name: `v${version}`, assets: [built, built + ".sig"].map((name) => ({ name, size: 5, browser_download_url: "https://example/" + name })) };
        const picked = pickAssets(release, platform, arch);
        assert.equal(picked.name, built, `updater-core.pickAssets() wants "${picked.name}" but electron-builder produces "${built}" for ${platform}/${arch}`);
        assert.equal(picked.url, "https://example/" + built);
        assert.equal(picked.sigUrl, "https://example/" + built + ".sig");
    }
});
