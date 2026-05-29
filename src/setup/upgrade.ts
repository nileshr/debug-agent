import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import {
  downloadReleaseTarball,
  fetchLatestGitHubRelease,
} from "./github-release.js";
import { getPackageRoot, getRepositorySlug, getVersion } from "../version.js";

const execFileAsync = promisify(execFile);

export type InstallKind = "global-npm" | "git" | "local-dev" | "unknown";

export interface UpgradeOptions {
  /** Only print whether an update exists */
  check?: boolean;
  /** Reinstall even when versions match */
  force?: boolean;
}

export interface UpgradeResult {
  currentVersion: string;
  latestVersion: string | null;
  installKind: InstallKind;
  upgraded: boolean;
  message: string;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function getGlobalNpmRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function detectInstallKind(
  packageRoot: string,
  executablePath: string,
): Promise<InstallKind> {
  if (fs.existsSync(path.join(packageRoot, ".git"))) {
    return "git";
  }

  const globalRoot = await getGlobalNpmRoot();
  if (globalRoot) {
    const normalizedExec = path.resolve(executablePath);
    const normalizedRoot = path.resolve(packageRoot);
    if (
      normalizedExec.startsWith(globalRoot + path.sep) ||
      normalizedRoot.startsWith(globalRoot + path.sep)
    ) {
      return "global-npm";
    }
  }

  if (
    packageRoot.includes(`${path.sep}node_modules${path.sep}`) ||
    executablePath.includes(`${path.sep}node_modules${path.sep}`)
  ) {
    return "global-npm";
  }

  if (fs.existsSync(path.join(packageRoot, "src", "cli.ts"))) {
    return "local-dev";
  }

  return "unknown";
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

async function upgradeGlobalFromRelease(
  release: NonNullable<Awaited<ReturnType<typeof fetchLatestGitHubRelease>>>,
): Promise<{ ok: boolean; message: string }> {
  console.log(chalk.dim(`Downloading ${release.tarballName}…\n`));
  try {
    const tarballPath = await downloadReleaseTarball(
      release.tarballUrl,
      release.tarballName,
    );
    console.log(chalk.dim(`Running: npm install -g ${tarballPath}\n`));
    const result = await runCommand("npm", ["install", "-g", tarballPath], process.cwd());
    if (result.code === 0) {
      return {
        ok: true,
        message: `Installed ${release.version} from GitHub release.`,
      };
    }
    return {
      ok: false,
      message: `npm install failed:\n${result.stderr || result.stdout}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Download failed: ${msg}` };
  }
}

async function upgradeGitClone(packageRoot: string): Promise<{ ok: boolean; message: string }> {
  console.log(chalk.dim(`Upgrading git checkout at ${packageRoot}\n`));

  const pull = await runCommand("git", ["pull", "--ff-only"], packageRoot);
  if (pull.code !== 0) {
    return {
      ok: false,
      message: `git pull failed:\n${pull.stderr || pull.stdout}`,
    };
  }

  const install = await runCommand("npm", ["install"], packageRoot);
  if (install.code !== 0) {
    return {
      ok: false,
      message: `npm install failed:\n${install.stderr || install.stdout}`,
    };
  }

  const build = await runCommand("npm", ["run", "build"], packageRoot);
  if (build.code !== 0) {
    return {
      ok: false,
      message: `npm run build failed:\n${build.stderr || build.stdout}`,
    };
  }

  return {
    ok: true,
    message:
      "Git checkout updated and rebuilt. If you use `npm link`, re-run it from this directory.",
  };
}

async function upgradeLocalDev(packageRoot: string): Promise<{ ok: boolean; message: string }> {
  const install = await runCommand("npm", ["install"], packageRoot);
  if (install.code !== 0) {
    return { ok: false, message: install.stderr || install.stdout };
  }
  const build = await runCommand("npm", ["run", "build"], packageRoot);
  if (build.code !== 0) {
    return { ok: false, message: build.stderr || build.stdout };
  }
  return {
    ok: true,
    message: "Local checkout rebuilt. Re-run `npm link` if this CLI is linked globally.",
  };
}

export async function runUpgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const currentVersion = getVersion();
  const packageRoot = getPackageRoot();
  const executablePath = process.argv[1] ?? "";
  const installKind = await detectInstallKind(packageRoot, executablePath);
  const repoSlug = getRepositorySlug();
  const latestRelease = repoSlug ? await fetchLatestGitHubRelease(repoSlug) : null;
  const latestVersion = latestRelease?.version ?? null;

  console.log(chalk.bold("debug-agent upgrade\n"));
  console.log(`  Current:  ${currentVersion}`);
  console.log(
    `  GitHub:   ${latestVersion ?? chalk.yellow("(no release or unreachable)")}${
      latestRelease ? chalk.dim(` — ${latestRelease.htmlUrl}`) : ""
    }`,
  );
  console.log(`  Install:  ${installKind}`);
  console.log(`  Root:     ${packageRoot}\n`);

  if (latestVersion && compareVersions(currentVersion, latestVersion) >= 0 && !options.force) {
    const msg =
      latestVersion === currentVersion
        ? "Already on the latest GitHub release."
        : "Current version is newer than GitHub release (local/dev build?).";
    console.log(chalk.green(msg));
    if (options.check) {
      return {
        currentVersion,
        latestVersion,
        installKind,
        upgraded: false,
        message: msg,
      };
    }
    if (!options.force) {
      console.log(chalk.dim("Use --force to reinstall anyway.\n"));
      return {
        currentVersion,
        latestVersion,
        installKind,
        upgraded: false,
        message: msg,
      };
    }
  }

  if (options.check) {
    const needs =
      latestVersion != null && compareVersions(currentVersion, latestVersion) < 0;
    const msg = needs
      ? `Update available: ${currentVersion} → ${latestVersion}`
      : "No GitHub update detected.";
    console.log(needs ? chalk.yellow(msg) : chalk.green(msg));
    return {
      currentVersion,
      latestVersion,
      installKind,
      upgraded: false,
      message: msg,
    };
  }

  let result: { ok: boolean; message: string };

  switch (installKind) {
    case "global-npm":
      if (!latestRelease && !options.force) {
        result = {
          ok: false,
          message: [
            "No GitHub release found.",
            repoSlug
              ? `Check https://github.com/${repoSlug}/releases`
              : "Add a `repository` field to package.json.",
            "Or install manually:",
            `  npm install -g ./debug-agent-${currentVersion}.tgz`,
          ].join("\n"),
        };
        break;
      }
      if (!latestRelease) {
        result = {
          ok: false,
          message: "No GitHub release to install. Publish a release first.",
        };
        break;
      }
      result = await upgradeGlobalFromRelease(latestRelease);
      break;
    case "git":
      result = await upgradeGitClone(packageRoot);
      break;
    case "local-dev":
      result = await upgradeLocalDev(packageRoot);
      break;
    default:
      result = {
        ok: false,
        message: [
          "Could not detect install method. Try one of:",
          repoSlug
            ? `  debug upgrade   (after global install from GitHub release)`
            : undefined,
          `  npm install -g ./debug-agent-${currentVersion}.tgz`,
          "  git pull && npm install && npm run build  (from clone)",
        ]
          .filter(Boolean)
          .join("\n"),
      };
  }

  if (result.ok) {
    console.log(chalk.green(result.message));
    const newVer = getVersion();
    if (newVer !== currentVersion) {
      console.log(chalk.dim(`Version is now ${newVer}`));
    }
    console.log(chalk.dim("Run `debug setup` to verify the environment.\n"));
  } else {
    console.log(chalk.red(result.message));
  }

  return {
    currentVersion,
    latestVersion,
    installKind,
    upgraded: result.ok,
    message: result.message,
  };
}

export function exitCodeForUpgrade(
  result: UpgradeResult,
  options?: { check?: boolean },
): number {
  if (options?.check) return 0;
  if (result.upgraded) return 0;
  if (
    result.message.includes("Already on") ||
    result.message.includes("No GitHub update")
  ) {
    return 0;
  }
  return 1;
}
