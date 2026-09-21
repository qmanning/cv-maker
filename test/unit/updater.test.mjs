// Unit tests for electron/updater-core.mjs — the updater's trust decisions, without Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    const rel = { tag_name: "v0.2.0", html_url: "https://example/notes", assets: ["Itera-0.2.0-mac-arm64.zip", "Itera-0.2.0-mac-arm64.zip.sig", "Itera-0.2.0-mac-x64.zip", "Itera-0.2.0-mac-arm64.dmg"].map((name) => ({ name, size: 5, browser_download_url: "https://example/" + name })) };
    const a = pickAssets(rel, "darwin", "arm64");
    assert.equal(a.version, "0.2.0"); assert.match(a.url, /mac-arm64\.zip$/); assert.match(a.sigUrl, /mac-arm64\.zip\.sig$/);
    const x = pickAssets(rel, "darwin", "x64");
    assert.match(x.url, /mac-x64\.zip$/); assert.equal(x.sigUrl, "");          // unsigned → the updater must refuse it
    assert.equal(pickAssets({}, "darwin", "arm64").url, "");
});

test("verifyUpdate(): accepts the publisher's signature, refuses everything else", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "pem" }), priv = privateKey.export({ type: "pkcs8", format: "pem" });
    const data = Buffer.from("the new Itera"), sig = signUpdate(data, priv);
    assert.equal(verifyUpdate(data, sig, pub), true);
    assert.equal(verifyUpdate(Buffer.from("the new Itera, tampered"), sig, pub), false);
    assert.equal(verifyUpdate(data, sig), false);                                  // signed by someone who isn't Itera's publisher
    assert.equal(verifyUpdate(data, "", pub), false);
    assert.equal(verifyUpdate(data, "not base64 at all", pub), false);
    assert.equal(verifyUpdate(data, sig.slice(0, 20), pub), false);
    assert.match(UPDATE_PUBLIC_KEY, /BEGIN PUBLIC KEY/);
});
