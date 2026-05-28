export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  suggestion?: string;
}

export interface SetupReport {
  checks: CheckResult[];
  passed: number;
  warned: number;
  failed: number;
  ready: boolean;
}
