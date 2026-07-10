import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";
import { isProLicensed, proUpgradeMessage } from "../licensing.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

const EMPTY_RESULT_HINT =
  "No plug-in traces in the window. Plug-in trace logging may be disabled.";

// Dataverse serves at most 5000 rows per page; we deliberately stay within a
// single page and report truncation instead of paging.
const PAGE_CAP = 5000;

const SLOW_SYNC_P95_MS = 2000;
const DEEP_CASCADE_MIN_DEPTH = 4;
const N_PLUS_ONE_MIN_COUNT = 4; // "more than 3" firings per correlation
const MAX_DISTINCT_ENTITIES = 5;

const inputSchema = z.object({
  hoursBack: z
    .number()
    .int()
    .min(1)
    .max(336)
    .default(72)
    .describe("How many hours of plug-in traces to analyze, 1–336 (default 72)."),
});

export type AnalyzePluginPerformanceInput = z.infer<typeof inputSchema>;

const SELECT_FIELDS = [
  "typename",
  "messagename",
  "primaryentity",
  "depth",
  "mode",
  "performanceexecutionduration",
  "correlationid",
  "createdon",
];

interface RawPerfTrace {
  typename?: string | null;
  messagename?: string | null;
  primaryentity?: string | null;
  depth?: number | null;
  mode?: number | null;
  performanceexecutionduration?: number | null;
  correlationid?: string | null;
  createdon?: string;
}

interface TableRow {
  pluginType: string;
  messageName: string;
  executions: number;
  p50DurationMs: number;
  p95DurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  maxDepth: number;
  avgDepth: number;
  syncExecutions: number;
  asyncExecutions: number;
  entities?: string[];
}

interface PerfFlag {
  flag: "slow-sync" | "deep-cascade" | "n-plus-one";
  pluginType: string;
  messageName: string;
  evidence: string;
  recommendation: string;
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.max(0, Math.ceil(q * sortedAsc.length) - 1);
  return sortedAsc[index] ?? 0;
}

interface GroupAccumulator {
  pluginType: string;
  messageName: string;
  durations: number[];
  depthSum: number;
  maxDepth: number;
  sync: number;
  async: number;
  entities: Set<string>;
}

function buildTable(rows: RawPerfTrace[]): TableRow[] {
  const groups = new Map<string, GroupAccumulator>();
  for (const row of rows) {
    const pluginType = row.typename ?? "unknown";
    const messageName = row.messagename ?? "unknown";
    const key = `${pluginType}|${messageName}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        pluginType,
        messageName,
        durations: [],
        depthSum: 0,
        maxDepth: 0,
        sync: 0,
        async: 0,
        entities: new Set<string>(),
      };
      groups.set(key, group);
    }
    // Missing duration means the platform recorded no measurement; count it as 0
    // rather than dropping the execution from the distribution.
    group.durations.push(row.performanceexecutionduration ?? 0);
    const depth = row.depth ?? 0;
    group.depthSum += depth;
    if (depth > group.maxDepth) group.maxDepth = depth;
    if (row.mode === 1) group.async += 1;
    else group.sync += 1;
    if (typeof row.primaryentity === "string" && row.primaryentity !== "") {
      group.entities.add(row.primaryentity);
    }
  }

  const table: TableRow[] = [];
  for (const group of groups.values()) {
    const sorted = [...group.durations].sort((a, b) => a - b);
    const n = sorted.length;
    const total = sorted.reduce((sum, d) => sum + d, 0);
    const entities = [...group.entities].slice(0, MAX_DISTINCT_ENTITIES);
    table.push({
      pluginType: group.pluginType,
      messageName: group.messageName,
      executions: n,
      p50DurationMs: percentile(sorted, 0.5),
      p95DurationMs: percentile(sorted, 0.95),
      avgDurationMs: n === 0 ? 0 : Math.round(total / n),
      maxDurationMs: sorted[n - 1] ?? 0,
      maxDepth: group.maxDepth,
      avgDepth: n === 0 ? 0 : Math.round((group.depthSum / n) * 10) / 10,
      syncExecutions: group.sync,
      asyncExecutions: group.async,
      ...(entities.length > 0 ? { entities } : {}),
    });
  }
  table.sort((a, b) => b.p95DurationMs - a.p95DurationMs);
  return table;
}

interface NPlusOneOffender {
  pluginType: string;
  messageName: string;
  count: number;
  correlationId: string;
}

/** Worst same-typename firing count within a single correlation, per typename. */
function findNPlusOneOffenders(rows: RawPerfTrace[]): NPlusOneOffender[] {
  const perCorrelation = new Map<
    string,
    { typename: string; correlationId: string; count: number }
  >();
  const messageCounts = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const typename = row.typename ?? "unknown";
    const messageName = row.messagename ?? "unknown";
    const perMessage = messageCounts.get(typename) ?? new Map<string, number>();
    perMessage.set(messageName, (perMessage.get(messageName) ?? 0) + 1);
    messageCounts.set(typename, perMessage);

    const correlationId = row.correlationid;
    if (correlationId === undefined || correlationId === null) continue;
    const key = `${correlationId}|${typename}`;
    const entry = perCorrelation.get(key);
    if (entry === undefined) {
      perCorrelation.set(key, { typename, correlationId, count: 1 });
    } else {
      entry.count += 1;
    }
  }

  const worstPerType = new Map<
    string,
    { correlationId: string; count: number }
  >();
  for (const entry of perCorrelation.values()) {
    const current = worstPerType.get(entry.typename);
    if (current === undefined || entry.count > current.count) {
      worstPerType.set(entry.typename, {
        correlationId: entry.correlationId,
        count: entry.count,
      });
    }
  }

  const offenders: NPlusOneOffender[] = [];
  for (const [typename, worst] of worstPerType) {
    if (worst.count < N_PLUS_ONE_MIN_COUNT) continue;
    let topMessage = "unknown";
    let topMessageCount = -1;
    for (const [message, count] of messageCounts.get(typename) ?? []) {
      if (count > topMessageCount) {
        topMessage = message;
        topMessageCount = count;
      }
    }
    offenders.push({
      pluginType: typename,
      messageName: topMessage,
      count: worst.count,
      correlationId: worst.correlationId,
    });
  }
  offenders.sort((a, b) => b.count - a.count);
  return offenders;
}

function buildFlags(table: TableRow[], rows: RawPerfTrace[]): PerfFlag[] {
  const slowSync: PerfFlag[] = table
    .filter((g) => g.p95DurationMs > SLOW_SYNC_P95_MS && g.syncExecutions > 0)
    .sort((a, b) => b.p95DurationMs - a.p95DurationMs)
    .map((g) => ({
      flag: "slow-sync" as const,
      pluginType: g.pluginType,
      messageName: g.messageName,
      evidence:
        `p95 duration ${g.p95DurationMs} ms with ${g.syncExecutions} ` +
        "synchronous execution(s) blocking the calling operation.",
      recommendation:
        "Move heavy work to an asynchronous step, trim the queries the plug-in " +
        "runs, or narrow the step's scope with filtering attributes so it fires " +
        "less often.",
    }));

  const deepCascade: PerfFlag[] = table
    .filter((g) => g.maxDepth >= DEEP_CASCADE_MIN_DEPTH)
    .sort((a, b) => b.maxDepth - a.maxDepth)
    .map((g) => ({
      flag: "deep-cascade" as const,
      pluginType: g.pluginType,
      messageName: g.messageName,
      evidence: `maxDepth ${g.maxDepth} indicates nested pipeline executions.`,
      recommendation:
        "Check for plug-in chains/cascades (update loops between plug-ins) and " +
        "add depth guards (context.Depth checks) to break re-entrant loops.",
    }));

  const nPlusOne: PerfFlag[] = findNPlusOneOffenders(rows).map((o) => ({
    flag: "n-plus-one" as const,
    pluginType: o.pluginType,
    messageName: o.messageName,
    evidence: `fired ${o.count} times in one correlation (correlationId ${o.correlationId}).`,
    recommendation:
      "Batch the work with ExecuteMultiple, cache repeated lookups, or move " +
      "per-record logic to a single bulk operation.",
  }));

  return [...slowSync, ...deepCascade, ...nPlusOne];
}

export async function analyzePluginPerformance(
  client: Pick<DataverseClient, "get">,
  input: AnalyzePluginPerformanceInput,
): Promise<unknown> {
  try {
    const cutoff = new Date(Date.now() - input.hoursBack * 3_600_000).toISOString();
    const response = await client.get<{ value: RawPerfTrace[] }>("plugintracelogs", {
      select: SELECT_FIELDS,
      filter: `createdon ge ${cutoff}`,
      orderby: "createdon desc",
      top: PAGE_CAP,
    });

    const rows = response.value ?? [];
    if (rows.length === 0) {
      // Success payload (not an error): empty usually means tracing is off.
      return {
        windowHours: input.hoursBack,
        totalExecutions: 0,
        analyzedPlugins: 0,
        table: [],
        flags: [],
        hint: EMPTY_RESULT_HINT,
        docsUrl: DOCS_URL,
      };
    }

    const table = buildTable(rows);
    const flags = buildFlags(table, rows);
    return {
      windowHours: input.hoursBack,
      totalExecutions: rows.length,
      analyzedPlugins: table.length,
      table,
      flags,
      ...(rows.length === PAGE_CAP ? { truncated: true } : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading plug-in trace logs requires the prvReadPluginTraceLog privilege. " +
          "Use a user with the System Administrator or System Customizer role, or add " +
          "that privilege to the connecting principal's security role.",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const analyzePluginPerformanceTool = defineTool({
  name: "analyze_plugin_performance",
  description:
    "Aggregates Dataverse plug-in trace logs (plugintracelogs) over a time window " +
    "into a per-plugin/message performance table (p50/p95/avg/max duration, depth, " +
    "sync vs async split) and flags anti-patterns: slow synchronous steps, deep " +
    "cascades, and N+1 firing within one correlation. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("analyze_plugin_performance");
    try {
      return await analyzePluginPerformance(getDefaultClient(), input);
    } catch (err) {
      // analyzePluginPerformance traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
