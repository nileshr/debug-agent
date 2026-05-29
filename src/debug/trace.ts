import readline from "node:readline";
import chalk from "chalk";
import type { TraceEntry, TraceKind } from "./types.js";

const MIN_MESSAGE_LEN = 12;
const MAX_DISPLAY_LEN = 96;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max = MAX_DISPLAY_LEN): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export class AgentTraceCollector {
  private phase = "";
  private textBuffer = "";
  private readonly entries: TraceEntry[] = [];

  setPhase(phase: string): void {
    this.flushTextBuffer();
    this.phase = phase;
    this.add("phase", `Started ${phase}`);
  }

  appendStreamChunk(chunk: string): void {
    this.textBuffer += chunk;

    let newlineAt = this.textBuffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = this.textBuffer.slice(0, newlineAt);
      this.textBuffer = this.textBuffer.slice(newlineAt + 1);
      this.pushLine(line);
      newlineAt = this.textBuffer.indexOf("\n");
    }

    if (this.textBuffer.includes("\n\n")) {
      const parts = this.textBuffer.split(/\n\n+/);
      this.textBuffer = parts.pop() ?? "";
      for (const part of parts) {
        this.pushLine(part);
      }
    }
  }

  flushTextBuffer(): void {
    if (this.textBuffer.trim()) {
      this.pushLine(this.textBuffer);
      this.textBuffer = "";
    }
  }

  add(kind: TraceKind, text: string): void {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return;

    const entry: TraceEntry = {
      ts: Date.now(),
      phase: this.phase,
      kind,
      text: normalized,
    };

    const prev = this.entries[this.entries.length - 1];
    if (
      prev &&
      prev.kind === entry.kind &&
      prev.phase === entry.phase &&
      prev.text === entry.text
    ) {
      return;
    }

    this.entries.push(entry);
  }

  getEntries(): TraceEntry[] {
    return [...this.entries];
  }

  getRecent(limit: number): TraceEntry[] {
    return this.entries.slice(-limit);
  }

  private pushLine(raw: string): void {
    const text = normalizeWhitespace(raw);
    if (text.length < MIN_MESSAGE_LEN) return;
    this.add("message", text);
  }
}

export class LiveTraceDisplay {
  private readonly maxLines: number;
  private phase = "";
  private lines: string[] = [];
  private renderedLines = 0;
  private enabled = false;

  constructor(maxLines = 5) {
    this.maxLines = maxLines;
  }

  beginPhase(phase: string): void {
    this.phase = phase;
    this.lines = [];
    this.enabled = true;
    this.erase();
  }

  endPhase(): void {
    this.enabled = false;
    this.erase();
    this.lines = [];
  }

  push(entry: TraceEntry): void {
    if (!this.enabled || entry.kind === "phase") return;

    const prefix =
      entry.kind === "tool"
        ? "⚙ "
        : entry.kind === "todo"
          ? "☐ "
          : entry.kind === "task"
            ? "↳ "
            : entry.kind === "plan"
              ? "◆ "
              : "";

    const line = truncate(`${prefix}${entry.text}`);
    if (!line || line.length < 8) return;

    const last = this.lines[this.lines.length - 1];
    if (last === line) return;

    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.render();
  }

  private render(): void {
    this.erase();
    if (!this.enabled || this.lines.length === 0) return;

    process.stderr.write(`${chalk.dim(`  agent · ${this.phase}`)}\n`);
    for (const line of this.lines) {
      process.stderr.write(`${chalk.dim("  │")} ${chalk.gray(line)}\n`);
    }
    this.renderedLines = this.lines.length + 1;
  }

  private erase(): void {
    if (this.renderedLines === 0) return;
    readline.moveCursor(process.stderr, 0, -this.renderedLines);
    readline.clearScreenDown(process.stderr);
    this.renderedLines = 0;
  }
}

export function traceKindLabel(kind: TraceKind): string {
  switch (kind) {
    case "message":
      return "message";
    case "tool":
      return "tool";
    case "todo":
      return "todo";
    case "task":
      return "task";
    case "plan":
      return "plan";
    case "phase":
      return "phase";
  }
}
