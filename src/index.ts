export { AcpClient, type AcpClientOptions } from "./acp/client.js";
export * from "./acp/types.js";
export { DebugLoopController, type ControllerOptions, type ControllerResult } from "./debug/controller.js";
export * from "./debug/types.js";
export { emitHtmlReport, REPORTS_DIR, reportFilePath } from "./report/emit.js";
export {
  ensureChromeDevToolsMcpConfig,
  acpMcpServersParam,
  CHROME_DEVTOOLS_MCP_ENTRY,
} from "./mcp/chrome.js";
export { runSetup, exitCodeForReport } from "./setup/run-setup.js";
export { runAllChecks } from "./setup/checks.js";
export type { CheckResult, SetupReport } from "./setup/types.js";
