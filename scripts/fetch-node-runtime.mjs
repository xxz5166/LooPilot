import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(root, "runtime");
const version = process.env.LOOPILOT_NODE_VERSION || "v22.14.0";
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("当前 Windows EXE 构建只支持 win32/x64");
fs.mkdirSync(runtimeDir, { recursive: true });
const target = path.join(runtimeDir, "node.exe");
if (fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) {
  console.log(`Node.js Runtime already exists: ${target}`);
  process.exit(0);
}
const zip = path.join(os.tmpdir(), `loopilot-${version}-win-x64.zip`);
const url = `https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Node.js Runtime download failed: HTTP ${response.status}`);
const buffer = Buffer.from(await response.arrayBuffer());
const actual = crypto.createHash("sha256").update(buffer).digest("hex");
const sumsResponse = await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`);
if (!sumsResponse.ok) throw new Error("Node.js Runtime checksum list is unavailable");
const sums = await sumsResponse.text();
const fileName = `node-${version}-win-x64.zip`;
const expected = sums.split(/\r?\n/).find((line) => line.endsWith(`  ${fileName}`))?.split(/\s+/)[0];
if (!expected || actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`Node.js Runtime SHA-256 mismatch: ${actual}`);
fs.writeFileSync(zip, buffer);
const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopilot-node-runtime-"));
const extracted = spawnSync("tar.exe", ["-xf", zip, "-C", extractDir], { windowsHide: true, stdio: "inherit" });
if (extracted.status !== 0) throw new Error("tar.exe could not extract Node.js Runtime");
const source = path.join(extractDir, `node-${version}-win-x64`, "node.exe");
if (!fs.existsSync(source)) throw new Error("Node.js archive does not contain node.exe");
fs.copyFileSync(source, target);
fs.rmSync(extractDir, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
console.log(`Node.js Runtime verified and installed: ${target}`);
