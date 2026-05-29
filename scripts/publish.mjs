#!/usr/bin/env node
/**
 * Tag and push a GitHub release. CI builds the tarball and uploads release assets.
 *
 *   npm run publish              # release current package.json version
 *   npm run publish -- --patch   # bump patch, commit, tag, push
 *   npm run publish -- --dry-run
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const bumpLevel = ["--patch", "--minor", "--major"].find((a) => process.argv.includes(a));

function run(cmd, args, { capture = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return capture ? (result.stdout ?? "").trim() : "";
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
}

function tagExists(tag) {
  const local = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (local.status === 0) return true;

  const remote = spawnSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return remote.status === 0 && Boolean(remote.stdout?.trim());
}

function assertCleanForRelease() {
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (!status) return;
  if (bumpLevel) return;
  console.error(
    "Working tree has uncommitted changes. Commit them first, or pass --patch/--minor/--major to bump.",
  );
  console.error(status);
  process.exit(1);
}

assertCleanForRelease();

if (bumpLevel) {
  const level = bumpLevel.slice(2);
  console.log(`Bumping ${level} version…`);
  if (!dryRun) {
    run("npm", ["version", level, "--no-git-tag-version"]);
  }
}

run("npm", ["run", "build"]);
run("npm", ["run", "smoke:version"]);

const version = readVersion();
const tag = `v${version}`;

if (tagExists(tag)) {
  console.error(`Tag ${tag} already exists locally or on origin.`);
  process.exit(1);
}

const slug = run("git", ["remote", "get-url", "origin"], { capture: true });
const repoMatch = slug.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
const repoUrl = repoMatch ? `https://github.com/${repoMatch[1]}` : slug;

if (dryRun) {
  console.log(`Dry run OK: would tag ${tag}, push branch + tag, then CI uploads release assets.`);
  process.exit(0);
}

if (bumpLevel) {
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `Bump version to ${version}.`]);
}

run("git", ["tag", tag]);
run("git", ["push"]);
run("git", ["push", "origin", tag]);

console.log(`\nPushed ${tag}. GitHub Actions will build and publish release assets.`);
console.log(`Actions: ${repoUrl}/actions`);
console.log(`Release: ${repoUrl}/releases/tag/${tag}`);
