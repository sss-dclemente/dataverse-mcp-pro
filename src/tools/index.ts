import type { AnyToolDefinition } from "./types.js";
import { ping } from "./ping.js";
import { getPluginTraces } from "./getPluginTraces.js";
import { getFailedAsyncJobs } from "./getFailedAsyncJobs.js";
import { checkStepConfig } from "./checkStepConfig.js";
import { explainTraceTool } from "./explainTrace.js";
import { explainImportFailureTool } from "./explainImportFailure.js";
import { analyzePluginPerformanceTool } from "./analyzePluginPerformance.js";

/** All tools exposed by the server. Add new tool modules here. */
export const tools: AnyToolDefinition[] = [
  ping,
  getPluginTraces,
  getFailedAsyncJobs,
  checkStepConfig,
  explainTraceTool,
  explainImportFailureTool,
  analyzePluginPerformanceTool,
];
