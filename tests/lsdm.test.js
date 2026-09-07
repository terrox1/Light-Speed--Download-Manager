// LSDM smoke tests — run with `npm test`.
// Uses only Node's built-in `node:test` runner (no extra dependencies).

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

describe("LSDM smoke tests", () => {
  test("server.js exposes the required engine endpoint", () => {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    // The main work is a single engine() dispatcher that ping/HTTP/WebSocket funnel through.
    assert.match(
      src,
      /async function engine/,
      "engine() dispatcher should exist",
    );
    assert.match(src, /aria2\b/, "aria2 engine should be routed");
    assert.match(src, /\.m3u8|HLS/i, "HLS engine should be routed");
  });

  test("HLS engine includes AES-128 decryption", () => {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(src, /decipher/i, "HLS decryption uses a cipher decipher");
    assert.match(src, /AES-128/i, "AES-128 is referenced");
  });

  test("preload exposes a context-isolated bridge", () => {
    const src = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
    assert.match(src, /contextBridge/i, "contextBridge must be used");
    assert.match(src, /ipcRenderer/i, "ipcRenderer wiring must exist");
  });

  test("UI provides a feedback path for the user", () => {
    const html = fs.readFileSync(
      path.join(ROOT, "public", "index.html"),
      "utf8",
    );
    assert.match(html, /aria/i, "the dashboard drives the aria2 engine");
    assert.match(html, /<body/, "html body present");
  });
});

describe("startup hygiene", () => {
  test("server.js starts without throwing (smoke boot)", (t, done) => {
    const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let booted = false;
    child.stdout.on("data", (d) => {
      if (/listening|started/i.test(d.toString())) booted = true;
    });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill();
      done(booted ? undefined : new Error("server did not boot within 5s"));
    }, 5000);
    child.on("exit", () => clearTimeout(timer));
  });
});
