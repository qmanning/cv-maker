// Unit tests for server.mjs — the optional local export server. Spawns `node server.mjs <port>` as a
// child process against a random free port, waits for it to start listening, and always kills it in an
// `after` hook (even on failure) so no server is left running past this file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { repoRoot, getFreePort, nonLoopbackIPv4 } from "./_helpers.mjs";

let child;
let port;
let puppeteerResolvable = false;
try {
    // Node's CJS require.resolve doubles as "is this importable from the repo" for an ESM-consumable
    // package too — we only need to know whether it's installed, not to actually load it here.
    const { createRequire } = await import("node:module");
    createRequire(path.join(repoRoot, "server.mjs")).resolve("puppeteer");
    puppeteerResolvable = true;
} catch {
    puppeteerResolvable = false;
}

async function waitForListen(proc, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        let out = "";
        const onData = (chunk) => {
            out += chunk.toString();
            if (/export server: http/.test(out)) {
                cleanup();
                resolve();
            }
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onExit = (code) => {
            cleanup();
            reject(new Error(`server.mjs exited early with code ${code}; stdout: ${out}`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`server.mjs did not start listening within ${timeoutMs}ms; stdout so far: ${out}`));
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            proc.off("error", onError);
            proc.off("exit", onExit);
        }
        proc.stdout.on("data", onData);
        proc.once("error", onError);
        proc.once("exit", onExit);
    });
}

port = await getFreePort();
child = spawn(process.execPath, [path.join(repoRoot, "server.mjs"), String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
});
await waitForListen(child);

after(() => {
    if (child && !child.killed) child.kill();
});

const base = `http://127.0.0.1:${port}`;

test("GET / returns 200 with a JSON health payload", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.port, port);
});

test("the server is bound to 127.0.0.1 only, not every interface", { skip: !nonLoopbackIPv4() ? "no non-loopback interface on this machine" : false }, async () => {
    const host = nonLoopbackIPv4();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
        await fetch(`http://${host}:${port}/`, { signal: controller.signal });
        assert.fail("expected connecting via the non-loopback address to fail (server is bound to 127.0.0.1 only)");
    } catch (err) {
        assert.ok(err, "expected a connection error");
    } finally {
        clearTimeout(timer);
    }
});

test("OPTIONS preflight from an allowed localhost Origin echoes it in Access-Control-Allow-Origin", async () => {
    const res = await fetch(base + "/export", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.match(res.headers.get("access-control-allow-methods") || "", /POST/);
});

test("OPTIONS preflight from a disallowed Origin gets no Access-Control-Allow-Origin header", async () => {
    const res = await fetch(base + "/export", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
});

// Malformed JSON is the client's mistake, not the server's: 400 with the expected-shape message (this was a 500
// until the unit tests caught JSON.parse throwing past the validation branch).
test("POST /export with malformed JSON returns 400", async () => {
    const res = await fetch(base + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Expected/);
});

test("POST /export with missing required fields returns 400", async () => {
    const res = await fetch(base + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: "<p>x</p>" /* missing format/widthPt/heightPt */ }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /html, format, widthPt, heightPt|Expected/);
});

test("POST /export with a well-formed body: 501 telling you to install puppeteer (not installed here), or a real PDF if it is", async () => {
    const res = await fetch(base + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: "<p>hello</p>", format: "pdf", widthPt: 612, heightPt: 792 }),
    });
    if (!puppeteerResolvable) {
        assert.equal(res.status, 501, "puppeteer is not installed in this repo, so /export should refuse with 501");
        const body = await res.json();
        assert.match(body.error, /npm i puppeteer/);
        console.log("[server.test] branch taken: puppeteer NOT installed -> 501");
    } else {
        assert.equal(res.status, 200, "puppeteer IS installed, so /export should actually render a PDF");
        assert.equal(res.headers.get("content-type"), "application/pdf");
        const buf = Buffer.from(await res.arrayBuffer());
        assert.equal(buf.subarray(0, 4).toString("latin1"), "%PDF");
        console.log("[server.test] branch taken: puppeteer installed -> 200 real PDF");
    }
});

// An oversized body gets a real 413, not a dropped connection (readBody used to destroy the socket the response
// travels on — also caught by these tests). The server keeps draining the upload so the status can be delivered.
test("an oversized POST body is refused with 413", async () => {
    const bigHtml = "x".repeat(26 * 1024 * 1024); // > MAX_BODY (25MB)
    const res = await fetch(base + "/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: bigHtml, format: "pdf", widthPt: 612, heightPt: 792 }),
    });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /too large/i);
});
