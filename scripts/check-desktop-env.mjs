import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ["server/index.mjs", "bin/loopilot.mjs", "public/manifest.webmanifest", "build/index.html"];
const missing = required.filter((item) => !fs.existsSync(path.join(root, item)));
const runtime = path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
const checks = [
  ["platform", process.platform === "win32" && os.arch() === "x64", `${process.platform}/${os.arch()}`],
  ["core", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "server/build/public/bin"],
  ["runtime", fs.existsSync(runtime), fs.existsSync(runtime) ? runtime : "runtime/node.exe is missing; run fetch-node-runtime"],
  ["package", fs.existsSync(path.join(root, "package-lock.json")), "package-lock.json"]
];
for (const [name, ok, detail] of checks) console.log(`${ok ? "OK  " : "WARN"} ${name}: ${detail}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmVersion = spawnSync(npm, ["--version"], { cwd: root, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
console.log(`${npmVersion.status === 0 ? "OK  " : "WARN"} npm: ${(npmVersion.stdout || "not available").trim()}`);
if (missing.length) process.exitCode = 1;
