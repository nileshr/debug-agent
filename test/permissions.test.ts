import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePermission,
  decidePermissionAbstract,
  selectPermissionOption,
} from "../src/runtime/permissions.js";
import { resolveAcpPreset, ACP_PRESETS } from "../src/runtime/acp/presets.js";

const policy = { repoPath: "/repo" };

test("abstract policy: browser MCP allowed always, out-of-repo rejected", () => {
  assert.equal(
    decidePermissionAbstract({ toolName: "mcp_playwright_click" }, policy),
    "allow_always",
  );
  assert.equal(
    decidePermissionAbstract({ toolName: "edit", path: "/etc/passwd" } as never, policy),
    "reject",
  );
  assert.equal(
    decidePermissionAbstract({ toolName: "edit", path: "/repo/src/a.ts" } as never, policy),
    "allow",
  );
});

test("option mapping prefers ACP spec kind", () => {
  const options = [
    { optionId: "opt-1", kind: "allow_always" },
    { optionId: "opt-2", kind: "allow_once" },
    { optionId: "opt-3", kind: "reject_once" },
  ];
  assert.deepEqual(selectPermissionOption(options, "allow"), {
    outcome: "selected",
    optionId: "opt-2",
  });
  assert.deepEqual(selectPermissionOption(options, "allow_always"), {
    outcome: "selected",
    optionId: "opt-1",
  });
  assert.deepEqual(selectPermissionOption(options, "reject"), {
    outcome: "selected",
    optionId: "opt-3",
  });
});

test("option mapping falls back to fuzzy optionId (Cursor shape)", () => {
  const cursorOptions = [
    { optionId: "allow-once" },
    { optionId: "allow-always" },
    { optionId: "reject-once" },
  ];
  assert.deepEqual(selectPermissionOption(cursorOptions, "allow"), {
    outcome: "selected",
    optionId: "allow-once",
  });
  assert.deepEqual(selectPermissionOption(cursorOptions, "reject"), {
    outcome: "selected",
    optionId: "reject-once",
  });
});

test("option mapping with no advertised options uses legacy literals", () => {
  assert.deepEqual(selectPermissionOption([], "allow_always"), {
    outcome: "selected",
    optionId: "allow-always",
  });
});

test("combined decidePermission stays Cursor-compatible", () => {
  const decision = decidePermission(
    {
      toolName: "shell",
      options: [{ optionId: "allow-once" }, { optionId: "allow-always" }],
    },
    policy,
  );
  assert.deepEqual(decision, { outcome: "selected", optionId: "allow-once" });
});

test("presets: custom requires a command; overrides apply", () => {
  assert.throws(() => resolveAcpPreset("custom"));
  const custom = resolveAcpPreset("custom", { command: "my-agent", args: ["--acp"] });
  assert.equal(custom.command, "my-agent");
  assert.deepEqual(custom.args, ["--acp"]);
  assert.equal(ACP_PRESETS.cursor.configTransport, "cursor_config_option");
  assert.equal(ACP_PRESETS.claude.configTransport, "acp");
});
