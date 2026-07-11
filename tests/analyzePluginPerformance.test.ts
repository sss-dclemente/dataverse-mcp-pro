import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzePluginPerformance,
  analyzePluginPerformanceTool,
  type AnalyzePluginPerformanceInput,
} from "../src/tools/analyzePluginPerformance.js";
import {
  DataverseHttpError,
  type DataverseClient,
  type QueryOptions,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

const happyFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "pluginPerf.happy.json",
);
const cleanFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "pluginPerf.clean.json",
);
const emptyFixture = loadFixture<{ value: unknown[] }>("pluginPerf.empty.json");

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
  flag: string;
  pluginType: string;
  messageName: string;
  evidence: string;
  recommendation: string;
}

interface ResultShape {
  windowHours?: number;
  totalExecutions?: number;
  analyzedPlugins?: number;
  table?: TableRow[];
  flags?: PerfFlag[];
  truncated?: boolean;
  error?: string;
  hint?: string;
  docsUrl?: string;
}

function fakeClient(result: unknown) {
  const get = vi.fn(
    async (_path: string, _options?: QueryOptions): Promise<unknown> => result,
  );
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function throwingClient(err: unknown) {
  const get = vi.fn(async (_path: string, _options?: QueryOptions): Promise<unknown> => {
    throw err;
  });
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function firstCall(get: ReturnType<typeof vi.fn>): [string, QueryOptions] {
  return get.mock.calls[0] as unknown as [string, QueryOptions];
}

function parseInput(raw: Record<string, unknown> = {}): AnalyzePluginPerformanceInput {
  return analyzePluginPerformanceTool.inputSchema.parse(raw);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("input schema", () => {
  it("defaults hoursBack to 72", () => {
    expect(parseInput().hoursBack).toBe(72);
  });

  it("rejects hoursBack below 1 and above 336", () => {
    const schema = analyzePluginPerformanceTool.inputSchema;
    expect(schema.safeParse({ hoursBack: 0 }).success).toBe(false);
    expect(schema.safeParse({ hoursBack: 337 }).success).toBe(false);
    expect(schema.safeParse({ hoursBack: 1 }).success).toBe(true);
    expect(schema.safeParse({ hoursBack: 336 }).success).toBe(true);
    expect(schema.safeParse({ hoursBack: 12.5 }).success).toBe(false);
  });
});

describe("query construction", () => {
  it("issues a single GET on plugintracelogs with the exact filter, orderby and top", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = fakeClient(emptyFixture);
    await analyzePluginPerformance(client, parseInput());

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = firstCall(get);
    expect(path).toBe("plugintracelogs");
    expect(options.select).toEqual([
      "typename",
      "messagename",
      "primaryentity",
      "depth",
      "mode",
      "performanceexecutionduration",
      "correlationid",
      "createdon",
    ]);
    // 72 hours back from the pinned clock.
    expect(options.filter).toBe("createdon ge 2026-07-07T12:00:00.000Z");
    expect(options.orderby).toBe("createdon desc");
    expect(options.top).toBe(5000);
  });

  it("honors a custom hoursBack in the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = fakeClient(emptyFixture);
    await analyzePluginPerformance(client, parseInput({ hoursBack: 24 }));

    const [, options] = firstCall(get);
    expect(options.filter).toBe("createdon ge 2026-07-09T12:00:00.000Z");
  });
});

describe("aggregation happy path", () => {
  it("builds the per-group table with nearest-rank percentiles, sorted by p95 desc", async () => {
    const { client } = fakeClient(happyFixture);
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;

    expect(result.windowHours).toBe(72);
    expect(result.totalExecutions).toBe(17);
    expect(result.analyzedPlugins).toBe(3);
    expect(result.truncated).toBeUndefined();
    expect("truncated" in (result as Record<string, unknown>)).toBe(false);
    expect(result.table).toHaveLength(3);

    const [slow, cascade, chatty] = result.table as [TableRow, TableRow, TableRow];

    // Sorted by p95 desc: 2600 > 300 > 90.
    expect(result.table?.map((r) => r.p95DurationMs)).toEqual([2600, 300, 90]);

    // Group A: 8 sync Updates, durations 400..2600.
    // n=8: p50 index ceil(4)-1=3 -> 1200; p95 index ceil(7.6)-1=7 -> 2600.
    expect(slow).toEqual({
      pluginType: "Contoso.Plugins.OrderTotalsPlugin",
      messageName: "Update",
      executions: 8,
      p50DurationMs: 1200,
      p95DurationMs: 2600,
      avgDurationMs: 1375,
      maxDurationMs: 2600,
      maxDepth: 1,
      avgDepth: 1,
      syncExecutions: 8,
      asyncExecutions: 0,
      entities: ["salesorder"],
    });

    // Group B: durations [100, null, 300, 200]; null counts as 0.
    // Sorted [0,100,200,300], n=4: p50 index ceil(2)-1=1 -> 100; p95 index ceil(3.8)-1=3 -> 300.
    expect(cascade).toEqual({
      pluginType: "Contoso.Plugins.CascadePlugin",
      messageName: "Update",
      executions: 4,
      p50DurationMs: 100,
      p95DurationMs: 300,
      avgDurationMs: 150,
      maxDurationMs: 300,
      maxDepth: 5,
      avgDepth: 3.5,
      syncExecutions: 2,
      asyncExecutions: 2,
      entities: ["contact"],
    });

    // Group C: 5 async Creates 50..90 in one correlation.
    // n=5: p50 index ceil(2.5)-1=2 -> 70; p95 index ceil(4.75)-1=4 -> 90.
    expect(chatty).toEqual({
      pluginType: "Contoso.Plugins.ContactEnrichmentPlugin",
      messageName: "Create",
      executions: 5,
      p50DurationMs: 70,
      p95DurationMs: 90,
      avgDurationMs: 70,
      maxDurationMs: 90,
      maxDepth: 1,
      avgDepth: 1,
      syncExecutions: 0,
      asyncExecutions: 5,
      entities: ["contact"],
    });
  });

  it("raises slow-sync, deep-cascade and n-plus-one flags in that order", async () => {
    const { client } = fakeClient(happyFixture);
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;

    expect(result.flags).toHaveLength(3);
    const [slowSync, deepCascade, nPlusOne] = result.flags as [
      PerfFlag,
      PerfFlag,
      PerfFlag,
    ];

    expect(result.flags?.map((f) => f.flag)).toEqual([
      "slow-sync",
      "deep-cascade",
      "n-plus-one",
    ]);

    expect(slowSync.pluginType).toBe("Contoso.Plugins.OrderTotalsPlugin");
    expect(slowSync.messageName).toBe("Update");
    expect(slowSync.evidence).toContain("2600");
    expect(slowSync.evidence).toContain("8");
    expect(slowSync.recommendation).toContain("asynchronous");
    expect(slowSync.recommendation).toContain("filtering attributes");

    expect(deepCascade.pluginType).toBe("Contoso.Plugins.CascadePlugin");
    expect(deepCascade.messageName).toBe("Update");
    expect(deepCascade.evidence).toContain("maxDepth 5");
    expect(deepCascade.recommendation).toContain("depth guards");

    expect(nPlusOne.pluginType).toBe("Contoso.Plugins.ContactEnrichmentPlugin");
    expect(nPlusOne.messageName).toBe("Create");
    expect(nPlusOne.evidence).toBe(
      "fired 5 times in one correlation (correlationId cccccccc-0000-4000-8000-000000000001).",
    );
    expect(nPlusOne.recommendation).toContain("ExecuteMultiple");
  });

  it("produces no flags for a fast, shallow, async-only group", async () => {
    const { client } = fakeClient(cleanFixture);
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;

    expect(result.totalExecutions).toBe(3);
    expect(result.analyzedPlugins).toBe(1);
    expect(result.flags).toEqual([]);

    const row = result.table?.[0] as TableRow;
    expect(row).toEqual({
      pluginType: "Contoso.Plugins.AuditLogger",
      messageName: "Delete",
      executions: 3,
      p50DurationMs: 20,
      p95DurationMs: 30,
      avgDurationMs: 20,
      maxDurationMs: 30,
      maxDepth: 1,
      avgDepth: 1,
      syncExecutions: 0,
      asyncExecutions: 3,
      entities: ["account"],
    });
  });
});

describe("empty result", () => {
  it("returns a zeroed payload with a tracing-may-be-disabled hint and docsUrl", async () => {
    const { client } = fakeClient(emptyFixture);
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;

    expect(result).toEqual({
      windowHours: 72,
      totalExecutions: 0,
      analyzedPlugins: 0,
      table: [],
      flags: [],
      hint: "No plug-in traces in the window. Plug-in trace logging may be disabled.",
      docsUrl: DOCS_URL,
    });
  });
});

describe("failure modes", () => {
  it("maps a 403 to an envelope with the privilege hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        403,
        "Principal user (Id=00000000-0000-0000-0000-000000000001, type=8) is missing prvReadPluginTraceLog privilege",
      ),
    );
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;

    expect(result.error).toContain("prvReadPluginTraceLog");
    expect(result.hint).toContain("prvReadPluginTraceLog");
    expect(result.docsUrl).toBe(DOCS_URL);
    expect(result.table).toBeUndefined();
  });

  it("maps any other error via toErrorEnvelope without letting it escape", async () => {
    const { client } = throwingClient(new Error("socket hang up"));
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;
    expect(result).toEqual({ error: "socket hang up" });
  });
});

describe("truncation", () => {
  it("marks the result truncated when the 5000-row page cap is hit", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      typename: "Contoso.Plugins.BulkPlugin",
      messagename: "Update",
      primaryentity: "account",
      depth: 1,
      mode: 1,
      performanceexecutionduration: 10,
      correlationid: null,
      createdon: "2026-07-10T11:00:00Z",
      index: i,
    }));
    const { client } = fakeClient({ value: rows });
    const result = (await analyzePluginPerformance(client, parseInput())) as ResultShape;

    expect(result.truncated).toBe(true);
    expect(result.totalExecutions).toBe(5000);
    expect(result.analyzedPlugins).toBe(1);
    // Null correlation ids are skipped by the n-plus-one detector.
    expect(result.flags).toEqual([]);
  });
});
