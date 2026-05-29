import { AcpClient } from "../acp/client.js";
import { acpMcpServersParam } from "../mcp/browser.js";
import { resolveSpawnCwd } from "../util/cwd.js";
import { CURATED_MODEL_CHOICES } from "./defaults.js";

export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * Merge curated defaults with models exposed by ACP session/new (when probe succeeds).
 */
export async function fetchModelChoices(
  cwd: string,
): Promise<ModelChoice[]> {
  const byId = new Map<string, ModelChoice>();
  for (const c of CURATED_MODEL_CHOICES) {
    byId.set(c.id, c);
  }

  const client = new AcpClient({
    requestTimeoutMs: 25_000,
    spawnCwd: resolveSpawnCwd(cwd),
  });
  try {
    await client.start();
    await client.initialize();
    await client.authenticate();
    const session = await client.sessionNew({
      cwd,
      mcpServers: acpMcpServersParam(),
    });
    for (const m of session.models?.availableModels ?? []) {
      if (!m.modelId || byId.has(m.modelId)) continue;
      byId.set(m.modelId, {
        id: m.modelId,
        label: m.name ? `${m.name} (${m.modelId})` : m.modelId,
      });
    }
  } catch {
    // Offline or auth failure — curated list only
  } finally {
    await client.stop();
  }

  return [...byId.values()];
}
