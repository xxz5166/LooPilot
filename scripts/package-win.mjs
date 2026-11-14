import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "dist");
const stageDir = path.join(root, ".tmp", "package-win");
fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
for (const entry of ["bin", "server", "build", "public", "node_modules", "package.json"]) {
  const source = path.join(root, entry);
  const target = path.join(stageDir, entry);
  fs.cpSync(source, target, { recursive: true });
}
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, [
  "--yes",
  "caxa",
  "--input",
  stageDir,
  "--output",
  path.join("dist", "LooPilot.exe"),
  "--",
  "{{caxa}}/node_modules/.bin/node",
  "{{caxa}}/bin/loopilot.mjs"
], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
