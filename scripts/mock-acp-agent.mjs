#!/usr/bin/env node
/**
 * Mock ACP agent for end-to-end tests: a stdio JSON-RPC responder that replays
 * a scripted debugging session from a scenario file.
 *
 * Usage: node scripts/mock-acp-agent.mjs <scenario.json>
 *
 * Scenario format:
 * {
 *   "personality": "cursor",            // optional; affects advertised capabilities
 *   "rules": [
 *     {
 *       "match": "HYPOTHESIZE phase",   // case-insensitive substring of the prompt
 *       "chunks": ["text streamed back"],
 *       "files": [{"op": "write"|"append"|"delete", "path": "rel", "content": "..."}],
 *       "todos": [{"id": "T1", "content": "...", "status": "pending"}],
 *       "maxUses": 1                     // optional, default unlimited
 *     }
 *   ]
 * }
 *
 * Placeholders in chunks and file contents: {{runId}}, {{now}}, {{cwd}}.
 * runId is captured from prompt text ("Run ID: <id>" or "DEBUG-INSTRUMENT:<id>").
 *
 * Env:
 *   MOCK_ACP_LOG    — JSONL file receiving {method, params} for every request.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  process.stderr.write("mock-acp-agent: missing scenario path\n");
  process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const rules = (scenario.rules ?? []).map((r) => ({ ...r, uses: 0 }));

const state = {
  cwd: process.cwd(),
  runId: "",
  sessionId: `mock-${Math.random().toString(36).slice(2, 10)}`,
};

function log(method, params) {
  const file = process.env.MOCK_ACP_LOG;
  if (!file) return;
  fs.appendFileSync(file, JSON.stringify({ method, params }) + "\n");
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function fill(text) {
  return String(text)
    .replaceAll("{{runId}}", state.runId)
    .replaceAll("{{now}}", String(Date.now()))
    .replaceAll("{{cwd}}", state.cwd);
}

function captureRunId(prompt) {
  const m =
    prompt.match(/Run ID:\s*([A-Za-z0-9-]+)/) ??
    prompt.match(/DEBUG-INSTRUMENT:([A-Za-z0-9-]+)/);
  if (m) state.runId = m[1];
}

function applyFileOp(op) {
  const target = path.resolve(state.cwd, fill(op.path));
  if (op.op === "delete") {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = fill(op.content ?? "");
  if (op.op === "append") {
    fs.appendFileSync(target, content);
  } else {
    fs.writeFileSync(target, content);
  }
}

function handlePrompt(id, params) {
  const promptText = (params.prompt ?? [])
    .map((p) => p.text ?? "")
    .join("\n");
  captureRunId(promptText);

  const rule = rules.find(
    (r) =>
      (r.maxUses == null || r.uses < r.maxUses) &&
      promptText.toLowerCase().includes(String(r.match).toLowerCase()),
  );

  if (!rule) {
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "mock-acp-agent: no rule matched.\n" },
      },
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }

  rule.uses += 1;
  for (const op of rule.files ?? []) applyFileOp(op);

  if (rule.todos) {
    notify("cursor/update_todos", {
      toolCallId: "mock-todos",
      todos: rule.todos,
      merge: false,
    });
  }

  for (const chunk of rule.chunks ?? []) {
    notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: fill(chunk) },
      },
    });
  }

  respond(id, { stopReason: "end_turn" });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (!method) return; // response to one of our own requests
  log(method, params);

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cursor_login", name: "Cursor login" }],
      });
      break;
    case "authenticate":
      respond(id, {});
      break;
    case "session/new":
      state.cwd = params?.cwd ?? state.cwd;
      respond(id, {
        sessionId: state.sessionId,
        modes: {
          currentModeId: "agent",
          availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
        },
        models: {
          currentModelId: "mock-model",
          availableModels: [{ modelId: "mock-model", name: "Mock Model" }],
        },
      });
      break;
    case "session/load":
      state.cwd = params?.cwd ?? state.cwd;
      state.sessionId = params?.sessionId ?? state.sessionId;
      respond(id, {
        modes: {
          currentModeId: "agent",
          availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
        },
      });
      break;
    case "session/set_config_option":
    case "session/cancel":
      respond(id, {});
      break;
    case "session/prompt":
      handlePrompt(id, params ?? {});
      break;
    default:
      if (id != null) respond(id, {});
  }
});

rl.on("close", () => process.exit(0));
