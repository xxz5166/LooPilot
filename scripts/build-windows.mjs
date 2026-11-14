import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = path.join(root, "desktop-version.json");
const current = JSON.parse(fs.readFileSync(versionPath, "utf8"));
const label = `v0.${Number(current.build) || 1}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
fs.rmSync(path.join(root, "dist-electron"), { recursive: true, force: true });
fs.rmSync(path.join(root, "dist-recvt"), { recursive: true, force: true });
fs.rmSync(path.join(root, "electron", "renderer-dist"), { recursive: true, force: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" && /npm\.cmd$/i.test(command) });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(process.execPath, [path.join(root, "scripts", "fetch-node-runtime.mjs")]);
run(npm, ["run", "build:desktop"]);
run(process.execPath, [path.join(root, "scripts", "stage-electron-app.mjs")]);
process.env.DESKTOP_BUILD_LABEL = label;
run(npm, ["exec", "--", "electron-builder", "--projectDir", ".tmp/electron-app", "--config", "electron-builder.yml", "--win", "nsis", "portable", "--x64"]);
const next = { label: `v0.${(Number(current.build) || 1) + 1}`, build: (Number(current.build) || 1) + 1 };
fs.writeFileSync(versionPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(`Windows packages generated for ${label}; next build is v0.${next.build}.`);
