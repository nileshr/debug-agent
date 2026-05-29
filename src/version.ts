import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
}

interface PackageJson extends PackageInfo {
  repository?: string | { type?: string; url?: string };
}

let cached: PackageInfo | null = null;

/** Directory containing package.json (project root when installed). */
export function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/version.js → package root is one level up
  return path.resolve(here, "..");
}

export function readPackageInfo(): PackageInfo {
  if (cached) return cached;
  const pkgPath = path.join(getPackageRoot(), "package.json");
  const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageInfo;
  cached = {
    name: raw.name,
    version: raw.version,
    description: raw.description,
  };
  return cached;
}

export function getVersion(): string {
  return readPackageInfo().version;
}

/** e.g. `nileshr/debug-agent` from package.json `repository` or git remote. */
export function getRepositorySlug(): string | null {
  const pkgPath = path.join(getPackageRoot(), "package.json");
  const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
  const repo = raw.repository;
  const url =
    typeof repo === "string"
      ? repo
      : typeof repo?.url === "string"
        ? repo.url
        : null;
  if (url) {
    const match = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/i);
    if (match) return match[1]!;
  }
  return null;
}
