import fs from "node:fs";
import path from "node:path";
import type { VerifyMode } from "./types.js";

export type { VerifyMode };

export interface VerifyTarget {
  mode: VerifyMode;
  /** Set when mode is browser. */
  url?: string;
}

const VITE_CONFIG_NAMES = ["vite.config.ts", "vite.config.js", "vite.config.mjs"] as const;

function inferViteUrl(repoPath: string): string | undefined {
  for (const name of VITE_CONFIG_NAMES) {
    const configPath = path.join(repoPath, name);
    if (!fs.existsSync(configPath)) continue;

    const text = fs.readFileSync(configPath, "utf8");
    const portMatch = text.match(/port\s*:\s*(\d+)/);
    return portMatch ? `http://localhost:${portMatch[1]}` : "http://localhost:5173";
  }
  return undefined;
}

/** Browser when --url or vite.config; otherwise CLI (shell verification). */
export function resolveVerifyTarget(
  repoPath: string,
  explicitUrl?: string,
): VerifyTarget {
  const trimmed = explicitUrl?.trim();
  if (trimmed) {
    return { mode: "browser", url: trimmed };
  }

  const viteUrl = inferViteUrl(repoPath);
  if (viteUrl) {
    return { mode: "browser", url: viteUrl };
  }

  return { mode: "cli" };
}

export function readPackageScripts(repoPath: string): Record<string, string> | undefined {
  const pkgPath = path.join(repoPath, "package.json");
  if (!fs.existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts;
  } catch {
    return undefined;
  }
}
