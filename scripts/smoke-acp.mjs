import { AcpClient } from "../dist/acp/client.js";
import { acpMcpServersParam } from "../dist/mcp/chrome.js";

const client = new AcpClient({ requestTimeoutMs: 30_000 });

try {
  await client.start();
  const init = await client.initialize();
  console.log("initialize OK, auth methods:", init.authMethods?.length ?? 0);

  await client.authenticate();

  const session = await client.sessionNew({
    cwd: process.cwd(),
    mcpServers: acpMcpServersParam(),
  });

  const modes = session.modes?.availableModes?.map((m) => m.id) ?? [];
  console.log("session/new OK:", session.sessionId);
  console.log("availableModes:", modes.join(", "));
  console.log(
    modes.includes("debug")
      ? "WARN: debug mode present (unexpected)"
      : "OK: no debug mode (emulation required)",
  );
} finally {
  await client.stop();
}
