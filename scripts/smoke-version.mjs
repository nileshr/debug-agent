#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const expected = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version;
const semverRe = /^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/;

for (const flag of ["-v", "-V", "--version"]) {
  const result = spawnSync(process.execPath, [cli, flag], { encoding: "utf8" });
  const out = (result.stdout ?? "").trim();
  if (result.status !== 0) {
    console.error(`FAIL: debug ${flag} exit ${result.status}`, result.stderr ?? "");
    process.exit(1);
  }
  if (!semverRe.test(out)) {
    console.error(`FAIL: debug ${flag} output is not semver: ${JSON.stringify(out)}`);
    process.exit(1);
  }
  if (out !== expected) {
    console.error(`FAIL: debug ${flag} expected ${expected}, got ${out}`);
    process.exit(1);
  }
}

console.log("Smoke OK: version flags (-v, -V, --version) =>", expected);
