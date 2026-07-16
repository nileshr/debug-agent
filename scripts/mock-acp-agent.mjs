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

/**
 * Personalities:
 *  - "cursor" (default): cursor_login auth, session/set_config_option for
 *    mode/model, todos via cursor/update_todos, no auth gate.
 *  - "standard": advertises authMethods [api_key], REJECTS session/new until
 *    authenticate is called, supports session/set_mode + session/set_model,
 *    rejects session/set_config_option, sends plan via standard ACP
 *    session/update {sessionUpdate: "plan"}.
 */
const personality = scenario.personality ?? "cursor";

const state = {
  cwd: process.cwd(),
  runId: "",
  sessionId: `mock-${Math.random().toString(36).slice(2, 10)}`,
  authenticated: false,
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

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
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
    if (personality === "standard") {
      notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: rule.todos.map((t) => ({
            content: t.content,
            status: t.status === "cancelled" ? "pending" : t.status,
            priority: "medium",
          })),
        },
      });
    } else {
      notify("cursor/update_todos", {
        toolCallId: "mock-todos",
        todos: rule.todos,
        merge: false,
      });
    }
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

  const isStandard = personality === "standard";
  const modes = isStandard
    ? {
        currentModeId: "default",
        availableModes: [{ id: "default" }, { id: "plan" }, { id: "acceptEdits" }],
      }
    : {
        currentModeId: "agent",
        availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }],
      };

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: isStandard
          ? [{ id: "api_key", name: "API key" }]
          : [{ id: "cursor_login", name: "Cursor login" }],
      });
      break;
    case "authenticate":
      state.authenticated = true;
      respond(id, {});
      break;
    case "session/new":
      if (isStandard && !state.authenticated) {
        respondError(id, -32000, "authentication required");
        break;
      }
      state.cwd = params?.cwd ?? state.cwd;
      respond(id, {
        sessionId: state.sessionId,
        modes,
        models: {
          currentModelId: "mock-model",
          availableModels: [{ modelId: "mock-model", name: "Mock Model" }],
        },
      });
      break;
    case "session/load":
      if (isStandard && !state.authenticated) {
        respondError(id, -32000, "authentication required");
        break;
      }
      state.cwd = params?.cwd ?? state.cwd;
      state.sessionId = params?.sessionId ?? state.sessionId;
      respond(id, { modes });
      break;
    case "session/set_config_option":
      if (isStandard) {
        respondError(id, -32601, "method not supported");
        break;
      }
      respond(id, {});
      break;
    case "session/set_mode":
    case "session/set_model":
      if (!isStandard) {
        respondError(id, -32601, "method not supported");
        break;
      }
      respond(id, {});
      break;
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
