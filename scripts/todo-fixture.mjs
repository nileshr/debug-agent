#!/usr/bin/env node
/**
 * Dev-only harness for the todo fixture: reset, serve, run debug-agent, accept.
 *
 * Usage:
 *   node scripts/todo-fixture.mjs reset
 *   node scripts/todo-fixture.mjs serve
 *   node scripts/todo-fixture.mjs run one <bugId> [--no-open]
 *   node scripts/todo-fixture.mjs run all [--interactive|--auto] [--no-open]
 *   node scripts/todo-fixture.mjs accept [--unit-only|--e2e-only]
 *   node scripts/todo-fixture.mjs list
 *
 * Env:
 *   DEBUG_BIN — override debugger binary (default: local dist/cli.js)
 *   FIXTURE_WORKDIR — override workdir path
 *   FIXTURE_URL — app URL (default from bugs.json)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "todo-fixture");
const SEED_DIR = path.join(FIXTURE_ROOT, "seed");
const MAINTAINER_DIR = path.join(FIXTURE_ROOT, "maintainer");
const BUGS_PATH = path.join(FIXTURE_ROOT, "bugs.json");
const DEFAULT_WORKDIR = path.join(REPO_ROOT, ".tmp", "todo-fixture-workdir");
const RUNS_DIR = path.join(FIXTURE_ROOT, ".runs");

const manifest = JSON.parse(fs.readFileSync(BUGS_PATH, "utf8"));
const FIXTURE_URL = process.env.FIXTURE_URL ?? manifest.url;
const WORKDIR = path.resolve(process.env.FIXTURE_WORKDIR ?? DEFAULT_WORKDIR);

function usage(exitCode = 1) {
  console.log(`Usage:
  node scripts/todo-fixture.mjs reset [--force]
  node scripts/todo-fixture.mjs serve
  node scripts/todo-fixture.mjs list
  node scripts/todo-fixture.mjs run one <bugId> [--no-open] [--skip-build]
  node scripts/todo-fixture.mjs run all [--interactive|--auto] [--no-open] [--skip-build]
  node scripts/todo-fixture.mjs accept [--unit-only|--e2e-only]

Env: DEBUG_BIN, FIXTURE_WORKDIR, FIXTURE_URL`);
  process.exit(exitCode);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function resetWorkdir({ force = false } = {}) {
  if (fs.existsSync(WORKDIR) && !force) {
    console.log(`Workdir exists: ${WORKDIR}`);
    console.log("Pass --force to recreate from seed.");
    return;
  }

  console.log(`Resetting workdir: ${WORKDIR}`);
  removeDir(WORKDIR);
  copyDir(SEED_DIR, WORKDIR);

  // Clear any stale debug artifacts if present
  removeDir(path.join(WORKDIR, ".debug-agent"));

  console.log("Installing fixture dependencies...");
  run("npm", ["install"], { cwd: WORKDIR });

  // Disposable git baseline for diff tracking during debug runs
  run("git", ["init"], { cwd: WORKDIR });
  run("git", ["add", "-A"], { cwd: WORKDIR });
  run("git", ["commit", "-m", "fixture baseline (broken seed)"], {
    cwd: WORKDIR,
    env: {
      GIT_AUTHOR_NAME: "todo-fixture",
      GIT_AUTHOR_EMAIL: "fixture@local",
      GIT_COMMITTER_NAME: "todo-fixture",
      GIT_COMMITTER_EMAIL: "fixture@local",
    },
  });

  console.log("Reset complete.");
}

function getDebugBin(skipBuild) {
  if (process.env.DEBUG_BIN) {
    return process.env.DEBUG_BIN;
  }
  if (!skipBuild) {
    console.log("Building debug-agent...");
    run("npm", ["run", "build"], { cwd: REPO_ROOT });
  }
  return path.join(REPO_ROOT, "dist", "cli.js");
}

function startDevServer() {
  return spawn("npm", ["run", "dev"], {
    cwd: WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopDevServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(undefined);
    }, 5000);
  });
}

function getBug(id) {
  const bug = manifest.bugs.find((b) => b.id === id);
  if (!bug) {
    throw new Error(`Unknown bug id: ${id}. Known: ${manifest.bugs.map((b) => b.id).join(", ")}`);
  }
  return bug;
}

function sortedBugs() {
  return [...manifest.bugs].sort((a, b) => a.order - b.order);
}

async function runDebugOnce(bug, { noOpen = false, skipBuild = false } = {}) {
  const debugBin = getDebugBin(skipBuild);
  skipBuild = true; // only build once per harness invocation

  console.log(`\n--- Running debug for bug: ${bug.id} (${bug.category}) ---`);
  console.log(`Symptom: ${bug.symptom}\n`);

  const server = startDevServer();
  let exitCode = 1;

  try {
    await waitForUrl(FIXTURE_URL);
    const args = [
      WORKDIR,
      "--bug",
      bug.symptom,
      "--url",
      FIXTURE_URL,
      "--no-report",
    ];
    if (noOpen) args.push("--no-open");

    const result = spawnSync("node", [debugBin, ...args], {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
    exitCode = result.status ?? 1;
  } finally {
    await stopDevServer(server);
  }

  const runRecord = {
    bugId: bug.id,
    exitCode,
    finishedAt: new Date().toISOString(),
    workdir: WORKDIR,
  };
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RUNS_DIR, `${bug.id}-${Date.now()}.json`),
    JSON.stringify(runRecord, null, 2),
  );

  return exitCode;
}

async function promptContinue(label) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${label} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

async function cmdRun(args) {
  if (args.length < 2) usage();

  const mode = args[0];
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const noOpen = flags.has("--no-open");
  let skipBuild = flags.has("--skip-build");
  const interactive = flags.has("--interactive");
  const auto = flags.has("--auto");

  if (mode === "one") {
    const bugId = positional[1];
    if (!bugId) usage();
    resetWorkdir({ force: true });
    const bug = getBug(bugId);
    const code = await runDebugOnce(bug, { noOpen, skipBuild });
    skipBuild = true;
    process.exit(code === 0 ? 0 : 2);
  }

  if (mode === "all") {
    if (interactive && auto) {
      console.error("Use either --interactive or --auto, not both.");
      process.exit(1);
    }
    const batchMode = interactive ? "interactive" : auto ? "auto" : "interactive";

    resetWorkdir({ force: true });
    const bugs = sortedBugs();
    let skipBuildFlag = skipBuild;
    let failures = 0;

    for (let i = 0; i < bugs.length; i++) {
      const bug = bugs[i];
      if (batchMode === "interactive" && i > 0) {
        const ok = await promptContinue(`Run bug ${bug.id}?`);
        if (!ok) {
          console.log("Stopped by user.");
          break;
        }
      }

      const code = await runDebugOnce(bug, { noOpen, skipBuild: skipBuildFlag });
      skipBuildFlag = true;
      if (code !== 0) {
        failures += 1;
        console.error(`Bug ${bug.id} finished with exit ${code}`);
        if (batchMode === "interactive") {
          const cont = await promptContinue("Continue to next bug anyway?");
          if (!cont) break;
        }
      }
    }

    process.exit(failures === 0 ? 0 : 2);
  }

  usage();
}

function cmdServe() {
  if (!fs.existsSync(WORKDIR)) {
    console.error("Workdir missing. Run: npm run fixture:reset");
    process.exit(1);
  }
  console.log(`Serving ${WORKDIR} at ${FIXTURE_URL}`);
  run("npm", ["run", "dev"], { cwd: WORKDIR });
}

function cmdAccept(flags) {
  if (!fs.existsSync(WORKDIR)) {
    console.error("Workdir missing. Run: npm run fixture:reset");
    process.exit(1);
  }

  if (!fs.existsSync(path.join(MAINTAINER_DIR, "node_modules"))) {
    console.log("Installing maintainer test dependencies...");
    run("npm", ["install"], { cwd: MAINTAINER_DIR });
  }

  const env = {
    FIXTURE_WORKDIR: WORKDIR,
    FIXTURE_URL,
    FIXTURE_SKIP_WEBSERVER: flags.has("--e2e-only") ? "" : "1",
  };

  if (!flags.has("--e2e-only")) {
    console.log("Running unit acceptance tests...");
    run("npm", ["run", "test:unit"], { cwd: MAINTAINER_DIR, env });
  }

  if (!flags.has("--unit-only")) {
    console.log("Running browser acceptance tests...");
    run("npm", ["run", "test:e2e"], {
      cwd: MAINTAINER_DIR,
      env: { ...env, FIXTURE_SKIP_WEBSERVER: undefined },
    });
  }
}

function cmdList() {
  console.log(`Fixture URL: ${FIXTURE_URL}`);
  console.log(`Workdir: ${WORKDIR}\n`);
  for (const bug of sortedBugs()) {
    console.log(`${bug.order}. ${bug.id} [${bug.category}]`);
    console.log(`   ${bug.symptom}\n`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  switch (command) {
    case "reset":
      resetWorkdir({ force: rest.includes("--force") });
      break;
    case "serve":
      cmdServe();
      break;
    case "list":
      cmdList();
      break;
    case "run":
      await cmdRun(rest);
      break;
    case "accept":
      cmdAccept(new Set(rest));
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
