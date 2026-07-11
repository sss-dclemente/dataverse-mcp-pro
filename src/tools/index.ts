import type { AnyToolDefinition } from "./types.js";
import { ping } from "./ping.js";
import { getPluginTraces } from "./getPluginTraces.js";
import { getFailedAsyncJobs } from "./getFailedAsyncJobs.js";
import { checkStepConfig } from "./checkStepConfig.js";
import { getFlowRuns } from "./getFlowRuns.js";
import { documentFlowTool } from "./documentFlow.js";
import { analyzeFlowRunsTool } from "./analyzeFlowRuns.js";
import { explainFlowFailureTool } from "./explainFlowFailure.js";
import { checkFlowConnectionsTool } from "./checkFlowConnections.js";
import { flowGovernanceReportTool } from "./flowGovernanceReport.js";
import { whatRunsOnTableTool } from "./whatRunsOnTable.js";
import { detectAutomationLoopsTool } from "./detectAutomationLoops.js";
import { documentTableTool } from "./documentTable.js";
import { getOrgAutomationSettings } from "./getOrgAutomationSettings.js";
import { findStuckJobs } from "./findStuckJobs.js";
import { getSolutionLayersTool } from "./getSolutionLayers.js";
import { modernizationReportTool } from "./modernizationReport.js";
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
  getFlowRuns,
  documentFlowTool,
  analyzeFlowRunsTool,
  explainFlowFailureTool,
  checkFlowConnectionsTool,
  flowGovernanceReportTool,
  whatRunsOnTableTool,
  detectAutomationLoopsTool,
  documentTableTool,
  getOrgAutomationSettings,
  findStuckJobs,
  getSolutionLayersTool,
  modernizationReportTool,
];
