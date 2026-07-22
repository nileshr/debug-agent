import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import type { Phase } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Shipped defaults (copied to dist/prompt-templates on build). */
export function bundledPromptsDir(): string {
  const fromDist = path.join(__dirname, "..", "prompt-templates");
  if (fs.existsSync(fromDist)) return fromDist;
  return path.join(__dirname, "..", "..", "prompt-templates");
}

export const USER_PROMPTS_DIR = path.join(os.homedir(), ".debug-agent", "prompts");

export function repoPromptsDir(repoPath: string): string {
  return path.join(repoPath, ".debug-agent", "prompts");
}

const PHASE_TEMPLATE_FILES: Partial<Record<Phase, string>> = {
  hypothesize: "hypothesize.md",
  instrument: "instrument.md",
  reproduce: "reproduce.md",
  analyze: "analyze.md",
  apply_fix: "apply_fix.md",
  verify: "verify.md",
  mark_fixed: "mark_fixed.md",
  review: "review.md",
  apply_review: "apply_review.md",
  re_verify: "re_verify.md",
  summarize: "summarize.md",
  explore: "explore.md",
};

/**
 * Resolve any template stem (e.g. "orchestrate") through the same 3-tier
 * override chain used for step prompts.
 */
export function resolveTemplateFile(
  stem: string,
  repoPath: string,
): { text: string; source: string } | null {
  const fileName = `${stem}.md`;
  const candidates = [
    { path: path.join(repoPromptsDir(repoPath), fileName), label: "repo" },
    { path: path.join(USER_PROMPTS_DIR, fileName), label: "user" },
    { path: path.join(bundledPromptsDir(), fileName), label: "bundled" },
  ];
  for (const c of candidates) {
    const text = readIfExists(c.path);
    if (text?.trim()) {
      return { text, source: `${c.label}:${c.path}` };
    }
  }
  return null;
}

function readIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Resolve prompt template: repo override → user override → bundled default.
 */
export function resolvePromptTemplate(
  phase: Phase,
  repoPath: string,
): { text: string; source: string } | null {
  const fileName = PHASE_TEMPLATE_FILES[phase];
  if (!fileName) return null;

  const candidates = [
    { path: path.join(repoPromptsDir(repoPath), fileName), label: "repo" },
    { path: path.join(USER_PROMPTS_DIR, fileName), label: "user" },
    { path: path.join(bundledPromptsDir(), fileName), label: "bundled" },
  ];

  for (const c of candidates) {
    const text = readIfExists(c.path);
    if (text?.trim()) {
      return { text, source: `${c.label}:${c.path}` };
    }
  }
  return null;
}

/** Replace `{{key}}` placeholders in a template. Unknown keys become empty string. */
export function renderPromptTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
