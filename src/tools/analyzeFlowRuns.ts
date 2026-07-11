import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const EMPTY_RESULT_HINT =
  "No cloud-flow runs found in the window. Dataverse run history covers solution-aware flows.";

// Dataverse serves at most 5000 rows per page; we deliberately stay within a
// single page and report truncation instead of paging.
const PAGE_CAP = 5000;

// Keep the workflows name-resolution $filter or-chain short enough to stay
// well under URL length limits.
const WORKFLOW_CHUNK_SIZE = 25;

const HIGH_FAILURE_MAX_SUCCESS_RATE = 80; // percent, exclusive
const HIGH_FAILURE_MIN_RUNS = 5;
const FAILURE_STREAK_MIN = 3;
const SLOW_P95_MS = 300_000; // 5 minutes
const ERROR_GROUP_TOP_N = 3;
const ERROR_MESSAGE_EXCERPT_LEN = 150;

const inputSchema = z.object({
  hoursBack: z
    .number()
    .int()
    .min(1)
    .max(336)
    .default(72)
    .describe("How many hours of cloud-flow run history to analyze, 1–336 (default 72)."),
  flowId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional workflow (cloud flow) id to scope the analysis to a single flow."),
});

export type AnalyzeFlowRunsInput = z.infer<typeof inputSchema>;

const SELECT_FIELDS = [
  "name",
  "status",
  "starttime",
  "endtime",
  "duration",
  "errorcode",
  "errormessage",
  "_workflow_value",
];

interface RawFlowRun {
  name?: string | null;
  status?: string | null;
  starttime?: string | null;
  endtime?: string | null;
  duration?: number | null;
  errorcode?: string | null;
  errormessage?: string | null;
  _workflow_value?: string | null;
}

interface ErrorGroup {
  errorCode: string;
  messageExcerpt: string;
  count: number;
}

interface FlowTableRow {
  flowId: string;
  flowName: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  otherStatuses: number;
  successRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  lastRunAt: string | null;
  lastRunStatus: string;
  errorGroups: ErrorGroup[];
}

interface FlowFlag {
  flag: "high-failure-rate" | "failure-streak" | "slow-p95";
  flowId: string;
  flowName: string;
  evidence: string;
  recommendation: string;
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.max(0, Math.ceil(q * sortedAsc.length) - 1);
  return sortedAsc[index] ?? 0;
}

interface FlowAccumulator {
  flowId: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  otherStatuses: number;
  durations: number[]; // non-null only; all-null flows report 0 percentiles
  lastRunAt: string | null;
  lastRunAtMs: number;
  lastRunStatus: string;
  // Statuses in arrival order — Dataverse returns starttime desc, so index 0
  // is the flow's most recent run. Used for failure-streak detection.
  statusesNewestFirst: string[];
  errorGroups: Map<string, ErrorGroup>;
}

function accumulate(rows: RawFlowRun[]): Map<string, FlowAccumulator> {
  const flows = new Map<string, FlowAccumulator>();
  for (const row of rows) {
    const flowId = row._workflow_value ?? "unknown";
    let flow = flows.get(flowId);
    if (flow === undefined) {
      flow = {
        flowId,
        runs: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        otherStatuses: 0,
        durations: [],
        lastRunAt: null,
        lastRunAtMs: Number.NEGATIVE_INFINITY,
        lastRunStatus: "unknown",
        statusesNewestFirst: [],
        errorGroups: new Map<string, ErrorGroup>(),
      };
      flows.set(flowId, flow);
    }

    const status = row.status ?? "unknown";
    flow.runs += 1;
    if (status === "Succeeded") flow.succeeded += 1;
    else if (status === "Failed") flow.failed += 1;
    else if (status === "Cancelled") flow.cancelled += 1;
    else flow.otherStatuses += 1;
    flow.statusesNewestFirst.push(status);

    if (typeof row.duration === "number") flow.durations.push(row.duration);

    if (typeof row.starttime === "string") {
      const startMs = Date.parse(row.starttime);
      if (Number.isFinite(startMs) && startMs > flow.lastRunAtMs) {
        flow.lastRunAtMs = startMs;
        flow.lastRunAt = row.starttime;
        flow.lastRunStatus = status;
      }
    }

    if (status === "Failed") {
      const errorCode = row.errorcode ?? "unknown";
      const messageExcerpt = (row.errormessage ?? "").slice(0, ERROR_MESSAGE_EXCERPT_LEN);
      const key = `${errorCode}|${messageExcerpt}`;
      const group = flow.errorGroups.get(key);
      if (group === undefined) {
        flow.errorGroups.set(key, { errorCode, messageExcerpt, count: 1 });
      } else {
        group.count += 1;
      }
    }
  }
  return flows;
}

function toTableRow(flow: FlowAccumulator, flowName: string): FlowTableRow {
  const sorted = [...flow.durations].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((sum, d) => sum + d, 0);
  const errorGroups = [...flow.errorGroups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, ERROR_GROUP_TOP_N);
  return {
    flowId: flow.flowId,
    flowName,
    runs: flow.runs,
    succeeded: flow.succeeded,
    failed: flow.failed,
    cancelled: flow.cancelled,
    otherStatuses: flow.otherStatuses,
    successRate:
      flow.runs === 0 ? 0 : Math.round((flow.succeeded / flow.runs) * 1000) / 10,
    p50DurationMs: percentile(sorted, 0.5),
    p95DurationMs: percentile(sorted, 0.95),
    avgDurationMs: n === 0 ? 0 : Math.round(total / n),
    maxDurationMs: sorted[n - 1] ?? 0,
    lastRunAt: flow.lastRunAt,
    lastRunStatus: flow.lastRunStatus,
    errorGroups,
  };
}

/** Length of the consecutive-Failed run at the newest end of the history. */
function failureStreak(flow: FlowAccumulator): number {
  let streak = 0;
  for (const status of flow.statusesNewestFirst) {
    if (status !== "Failed") break;
    streak += 1;
  }
  return streak;
}

function buildFlags(
  table: FlowTableRow[],
  flows: Map<string, FlowAccumulator>,
): FlowFlag[] {
  const highFailure: FlowFlag[] = table
    .filter(
      (r) =>
        r.successRate < HIGH_FAILURE_MAX_SUCCESS_RATE && r.runs >= HIGH_FAILURE_MIN_RUNS,
    )
    .sort((a, b) => a.successRate - b.successRate)
    .map((r) => ({
      flag: "high-failure-rate" as const,
      flowId: r.flowId,
      flowName: r.flowName,
      evidence:
        `success rate ${r.successRate}% over ${r.runs} runs ` +
        `(${r.failed} failed, ${r.succeeded} succeeded).`,
      recommendation:
        "Inspect the top error group and pinpoint the failing action via run " +
        "history (get_flow_runs / FlowAgent).",
    }));

  const streaks = table
    .map((r) => {
      const flow = flows.get(r.flowId);
      return { row: r, streak: flow === undefined ? 0 : failureStreak(flow) };
    })
    .filter((s) => s.streak >= FAILURE_STREAK_MIN)
    .sort((a, b) => b.streak - a.streak);
  const failureStreaks: FlowFlag[] = streaks.map((s) => ({
    flag: "failure-streak" as const,
    flowId: s.row.flowId,
    flowName: s.row.flowName,
    evidence: `last ${s.streak} runs failed consecutively.`,
    recommendation:
      "Check for an expired connection or a recent flow edit — streaks usually " +
      "mean a systemic break, not data-dependent errors.",
  }));

  const slowP95: FlowFlag[] = table
    .filter((r) => r.p95DurationMs > SLOW_P95_MS)
    .sort((a, b) => b.p95DurationMs - a.p95DurationMs)
    .map((r) => ({
      flag: "slow-p95" as const,
      flowId: r.flowId,
      flowName: r.flowName,
      evidence: `p95 duration ${r.p95DurationMs} ms exceeds 5 minutes.`,
      recommendation:
        "Check for loops over large datasets, chatty connector calls, or " +
        "missing pagination/concurrency settings.",
    }));

  return [...highFailure, ...failureStreaks, ...slowP95];
}

async function resolveFlowNames(
  client: Pick<DataverseClient, "get">,
  flowIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let i = 0; i < flowIds.length; i += WORKFLOW_CHUNK_SIZE) {
    const chunk = flowIds.slice(i, i + WORKFLOW_CHUNK_SIZE);
    const response = await client.get<{
      value: Array<{ workflowid?: string; name?: string | null }>;
    }>("workflows", {
      select: ["workflowid", "name"],
      filter: `(${chunk.map((id) => `workflowid eq ${id}`).join(" or ")})`,
    });
    for (const workflow of response.value ?? []) {
      if (typeof workflow.workflowid === "string") {
        names.set(workflow.workflowid, workflow.name ?? "unknown");
      }
    }
  }
  return names;
}

export async function analyzeFlowRuns(
  client: Pick<DataverseClient, "get">,
  input: AnalyzeFlowRunsInput,
): Promise<unknown> {
  try {
    const cutoff = new Date(Date.now() - input.hoursBack * 3_600_000).toISOString();
    const filter =
      input.flowId === undefined
        ? `starttime ge ${cutoff}`
        : `starttime ge ${cutoff} and _workflow_value eq ${input.flowId}`;
    const response = await client.get<{ value: RawFlowRun[] }>("flowruns", {
      select: SELECT_FIELDS,
      filter,
      orderby: "starttime desc",
      top: PAGE_CAP,
    });

    const rows = response.value ?? [];
    if (rows.length === 0) {
      // Success payload (not an error): Dataverse only records runs for
      // solution-aware flows, so an empty window is often expected.
      return {
        windowHours: input.hoursBack,
        totalRuns: 0,
        flowsAnalyzed: 0,
        table: [],
        flags: [],
        hint: EMPTY_RESULT_HINT,
        docsUrl: DOCS_URL,
      };
    }

    const flows = accumulate(rows);
    const knownIds = [...flows.keys()].filter((id) => id !== "unknown");
    const names = await resolveFlowNames(client, knownIds);

    const table = [...flows.values()].map((flow) =>
      toTableRow(flow, names.get(flow.flowId) ?? "unknown"),
    );
    table.sort((a, b) => b.failed - a.failed || b.runs - a.runs);

    const flags = buildFlags(table, flows);
    return {
      windowHours: input.hoursBack,
      totalRuns: rows.length,
      flowsAnalyzed: table.length,
      table,
      flags,
      ...(rows.length === PAGE_CAP ? { truncated: true } : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 404) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "The flowrun table was not found. Cloud-flow run history in Dataverse " +
          "is a virtual table that only covers solution-aware flows and may not " +
          "be enabled in this environment.",
        docsUrl: DOCS_URL,
      });
    }
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading cloud-flow run history requires read privilege on the " +
          "flowrun table. Use a user with the System Administrator role, or " +
          "grant the connecting principal read access to Flow Run records.",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const analyzeFlowRunsTool = defineTool({
  name: "analyze_flow_runs",
  description:
    "Aggregates Power Automate cloud-flow run history (Dataverse flowruns) over " +
    "a time window into a per-flow reliability/performance table (success rate, " +
    "p50/p95/avg/max duration, last run, top error groups) and flags problems: " +
    "high failure rates, consecutive-failure streaks, and slow p95 runtimes. " +
    "Optionally scoped to one flow.",
  inputSchema,
  handler: async (input) => {
    try {
      return await analyzeFlowRuns(getDefaultClient(), input);
    } catch (err) {
      // analyzeFlowRuns traps its own errors; this covers client construction
      // failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
