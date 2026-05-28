import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FinalReport } from "../debug/types.js";
import { renderReportHtml } from "./template.js";

const execFileAsync = promisify(execFile);

export const REPORTS_DIR = path.join(
  os.homedir(),
  ".debug-agent",
  "reports",
);

export interface EmitReportOptions {
  open?: boolean;
}

export function reportFilePath(runId: string): string {
  return path.join(REPORTS_DIR, `run-${runId}.html`);
}

export function fileUrlForPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return `file://${resolved}`;
}

export async function emitHtmlReport(
  report: FinalReport,
  options: EmitReportOptions = {},
): Promise<string> {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const outPath = reportFilePath(report.runId);
  const html = renderReportHtml(report);
  fs.writeFileSync(outPath, html, "utf8");

  const url = fileUrlForPath(outPath);
  console.log(`\nReport: ${url}`);
  console.log(`Saved:  ${outPath}`);

  if (options.open !== false) {
    await openInBrowser(outPath);
  } else {
    console.log("Open the file:// link above in your browser (or run with --open).");
  }

  return outPath;
}

async function openInBrowser(filePath: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await execFileAsync("open", [filePath]);
    } else if (platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", filePath]);
    } else {
      await execFileAsync("xdg-open", [filePath]);
    }
  } catch (err) {
    console.warn("Could not auto-open report:", (err as Error).message);
  }
}
