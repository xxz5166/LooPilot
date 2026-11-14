import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const main = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
const builder = packageJson.build;

test("desktop package keeps an independent Node runtime and both Windows targets", () => {
  assert.equal(packageJson.main, "dist-electron/main.js");
  assert.equal(builder.extraMetadata.main, "dist-electron/main.js");
  assert.equal(builder.executableName, "LooPilot-recvt");
  assert.doesNotMatch(JSON.stringify(builder), /desktop-panel/);
  assert.match(JSON.stringify(builder.extraResources), /runtime/);
  assert.equal(builder.nsis.artifactName, "LooPilot-Setup.exe");
  assert.equal(builder.portable.artifactName, "LooPilot-Portable.exe");
  assert.deepEqual(builder.win.target.map((item) => item.target), ["nsis", "portable"]);
  assert.match(main, /process\.resourcesPath, "runtime"/);
  assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE/);
});

test("desktop pairing QR payload excludes long-lived tokens", () => {
  assert.match(main, /type: "loopilot-pairing", version: 1, server, code: pairingCode/);
  assert.doesNotMatch(main, /payload.*authToken|payload.*token/);
});

test("renderer bridge is isolated and custom tunnel processes avoid shell execution", () => {
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /shell: false/);
  assert.match(main, /\$\{PORT\}/);
  assert.match(main, /safeStorage/);
  assert.match(main, /ipcMain\.handle\("test-tunnel"/);
  assert.match(main, /waitForTunnelHealth/);
  assert.match(main, /Shell 包装脚本/);
});
