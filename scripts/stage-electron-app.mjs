import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".tmp", "electron-app");
const coreRuntime = path.join(root, ".tmp", "core-runtime");
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(coreRuntime, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(coreRuntime, { recursive: true });
fs.cpSync(path.join(root, "dist-electron"), path.join(stage, "dist-electron"), { recursive: true });
fs.cpSync(path.join(root, "electron", "renderer-dist"), path.join(stage, "renderer-dist"), { recursive: true });
fs.writeFileSync(path.join(coreRuntime, "package.json"), `${JSON.stringify({ private: true, dependencies: { express: "^5.1.0", chokidar: "^4.0.3", qrcode: "^1.5.4", ws: "^8.18.0" } }, null, 2)}\n`, "utf8");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const install = spawnSync(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock"], { cwd: coreRuntime, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
if (install.status !== 0) throw new Error("Failed to stage LooPilot production dependencies");
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ name: "loopilot", version: "0.1.0", productName: "LooPilot-recvt", main: "dist-electron/main.js", private: true, build: { electronVersion: "39.8.10" } }, null, 2)}\n`, "utf8");
const absolute = (value) => path.resolve(root, value).replaceAll("\\", "/");
fs.writeFileSync(path.join(stage, "electron-builder.yml"), `appId: com.huangbwww.loopilot.ele\nproductName: LooPilot-ele\nasar: true\nelectronDist: ${absolute("node_modules/electron/dist")}\nfiles:\n  - dist-electron/**/*\n  - renderer-dist/**/*\n  - package.json\nextraResources:\n  - from: ${absolute("server")}\n    to: loopilot/server\n  - from: ${absolute("bin")}\n    to: loopilot/bin\n  - from: ${absolute("build")}\n    to: loopilot/build\n  - from: ${absolute("public")}\n    to: loopilot/public\n  - from: ${absolute("package.json")}\n    to: loopilot/package.json\n  - from: ${absolute("desktop-version.json")}\n    to: loopilot/desktop-version.json\n  - from: ${absolute("node_modules")}\n    to: loopilot/node_modules\n  - from: ${absolute("runtime")}\n    to: runtime\n    filter: [node.exe]\ndirectories:\n  output: ${absolute("dist-electron")}\nwin:\n  target:\n    - target: nsis\n      arch: [x64]\n    - target: portable\n      arch: [x64]\nnsis:\n  artifactName: LooPilot-Setup.exe\nportable:\n  artifactName: LooPilot-Portable.exe\n`, "utf8");
const stagedBuilderPath = path.join(stage, "electron-builder.yml");
const stagedBuilder = fs.readFileSync(stagedBuilderPath, "utf8")
  .replaceAll("LooPilot-ele", "LooPilot-recvt")
  .replace("productName: LooPilot-recvt", "productName: LooPilot-recvt\nexecutableName: LooPilot-recvt")
  .replace(`output: ${absolute("dist-electron")}`, `output: ${absolute("dist-recvt")}`);
fs.writeFileSync(stagedBuilderPath, stagedBuilder, "utf8");
const builderConfigPath = stagedBuilderPath;
const builderConfig = fs.readFileSync(builderConfigPath, "utf8").replace(`from: ${absolute("node_modules")}`, `from: ${absolute(".tmp/core-runtime/node_modules")}`);
fs.writeFileSync(builderConfigPath, `${builderConfig}electronVersion: 39.8.10\n`, "utf8");
console.log(`Electron app staged at ${stage}`);
