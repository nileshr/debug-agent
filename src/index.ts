export { AcpClient, type AcpClientOptions } from "./acp/client.js";
export * from "./acp/types.js";
export { DebugLoopController, type ControllerOptions, type ControllerResult } from "./debug/controller.js";
export * from "./debug/types.js";
export { emitHtmlReport, REPORTS_DIR, reportFilePath } from "./report/emit.js";
export {
  ensureChromeDevToolsMcpConfig,
  ensureBrowserMcpConfig,
  acpMcpServersParam,
  CHROME_DEVTOOLS_MCP_ENTRY,
  PLAYWRIGHT_MCP_ENTRY,
  browserMcpLabel,
} from "./mcp/browser.js";
export {
  resolveAgentConfig,
  modelForPhase,
  needsInteractiveConfig,
} from "./config/resolve.js";
export { DEFAULT_AGENT_CONFIG } from "./config/defaults.js";
export { GLOBAL_CONFIG_PATH } from "./config/paths.js";
export {
  REPO_DEBUG_AGENT_DIR,
  repoDebugAgentDir,
  repoConfigPath,
  debugLogPath,
  debugRunsDir,
  debugRunLedgerPath,
} from "./debug/repo-paths.js";
export {
  loadGlobalConfig,
  loadRepoConfig,
  saveGlobalConfig,
  saveRepoConfig,
} from "./config/store.js";
export type { AgentConfig, BrowserMcp, ResolvedAgentConfig } from "./config/types.js";
export { runSetup, exitCodeForReport } from "./setup/run-setup.js";
export { runAllChecks } from "./setup/checks.js";
export { runUpgrade, exitCodeForUpgrade, detectInstallKind } from "./setup/upgrade.js";
export type { UpgradeOptions, UpgradeResult, InstallKind } from "./setup/upgrade.js";
export { resolveVerifyTarget, readPackageScripts } from "./debug/verify-target.js";
export {
  getRunStore,
  closeRunStore,
  STATE_DB_PATH,
  type RunListRow,
  type LoadedRun,
} from "./debug/run-store.js";
export type { VerifyTarget } from "./debug/verify-target.js";
export { getVersion, getPackageRoot, readPackageInfo, getRepositorySlug } from "./version.js";
export type { CheckResult, SetupReport } from "./setup/types.js";
