import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const LOGS_DIR = path.join(os.homedir(), ".debug-agent", "logs");

export class RunLogWriter {
  readonly filePath: string;
  private stream: fs.WriteStream;

  constructor(label?: string) {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(LOGS_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const id = (label ?? randomUUID().slice(0, 8)).replace(/[^\w.-]/g, "_");
    this.filePath = path.join(dir, `${id}-${stamp}.log`);
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    this.line(`debug-agent run log`);
    if (label) this.line(`label=${label}`);
    this.line(`started=${new Date().toISOString()}`);
    this.line(`node=${process.version} platform=${process.platform}`);
    this.line("---");
  }

  line(message: string): void {
    const ts = new Date().toISOString();
    this.stream.write(`[${ts}] ${message}\n`);
  }

  section(title: string): void {
    this.line("");
    this.line(`=== ${title} ===`);
  }

  close(): void {
    this.stream.end();
  }
}
