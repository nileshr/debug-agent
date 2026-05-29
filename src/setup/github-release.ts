import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export interface GitHubReleaseInfo {
  version: string;
  tarballUrl: string;
  tarballName: string;
  htmlUrl: string;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubReleaseResponse {
  tag_name: string;
  html_url: string;
  assets: GitHubReleaseAsset[];
}

export async function fetchLatestGitHubRelease(
  repoSlug: string,
): Promise<GitHubReleaseInfo | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repoSlug}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "debug-agent",
      },
    },
  );
  if (!res.ok) return null;

  const data = (await res.json()) as GitHubReleaseResponse;
  const asset = data.assets.find((a) => a.name.endsWith(".tgz"));
  if (!asset) return null;

  return {
    version: data.tag_name.replace(/^v/, ""),
    tarballUrl: asset.browser_download_url,
    tarballName: asset.name,
    htmlUrl: data.html_url,
  };
}

export async function downloadReleaseTarball(
  tarballUrl: string,
  tarballName: string,
): Promise<string> {
  const res = await fetch(tarballUrl, {
    headers: { "User-Agent": "debug-agent" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download release asset (${res.status})`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-agent-upgrade-"));
  const dest = path.join(tmpDir, tarballName);
  await pipeline(res.body, fs.createWriteStream(dest));
  return dest;
}
