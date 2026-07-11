import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeFlowRuns,
  analyzeFlowRunsTool,
  type AnalyzeFlowRunsInput,
} from "../src/tools/analyzeFlowRuns.js";
import {
  DataverseHttpError,
  type DataverseClient,
  type QueryOptions,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const FLOW_A = "aaaaaaaa-0000-4000-8000-00000000000a"; // Order Sync — high failure rate
const FLOW_B = "bbbbbbbb-0000-4000-8000-00000000000b"; // Invoice Approval — failure streak
const FLOW_C = "cccccccc-0000-4000-8000-00000000000c"; // Nightly Data Export — slow p95
const FLOW_D = "dddddddd-0000-4000-8000-00000000000d"; // not in workflows fixture

// Full errormessage of flow B's TimeoutError run in the happy fixture (207
// chars) — the tool must excerpt the first 150.
const TIMEOUT_MESSAGE =
  "The operation timed out after 120 seconds while waiting for a response from " +
  "the downstream service. The request to https://api.contoso.com/v1/orders/export " +
  "did not complete within the allotted time window.";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

const happyFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "flowRunsAnalysis.happy.json",
);
const happyWorkflowsFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "flowRunsAnalysis.happyWorkflows.json",
);
const cleanFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "flowRunsAnalysis.clean.json",
);
const cleanWorkflowsFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "flowRunsAnalysis.cleanWorkflows.json",
);
const emptyFixture = loadFixture<{ value: unknown[] }>("flowRunsAnalysis.empty.json");

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
  flag: string;
  flowId: string;
  flowName: string;
  evidence: string;
  recommendation: string;
}

interface ResultShape {
  windowHours?: number;
  totalRuns?: number;
  flowsAnalyzed?: number;
  table?: FlowTableRow[];
  flags?: FlowFlag[];
  truncated?: boolean;
  error?: string;
  hint?: string;
  docsUrl?: string;
}

/** Fake client whose get() returns the given responses in call order. */
function sequencedClient(...responses: unknown[]) {
  const get = vi.fn(
    async (_path: string, _options?: QueryOptions): Promise<unknown> => undefined,
  );
  for (const response of responses) {
    get.mockResolvedValueOnce(response as never);
  }
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function throwingClient(err: unknown) {
  const get = vi.fn(async (_path: string, _options?: QueryOptions): Promise<unknown> => {
    throw err;
  });
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function callAt(get: ReturnType<typeof vi.fn>, index: number): [string, QueryOptions] {
  return get.mock.calls[index] as unknown as [string, QueryOptions];
}

function parseInput(raw: Record<string, unknown> = {}): AnalyzeFlowRunsInput {
  return analyzeFlowRunsTool.inputSchema.parse(raw);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("input schema", () => {
  it("defaults hoursBack to 72 and leaves flowId undefined", () => {
    const input = parseInput();
    expect(input.hoursBack).toBe(72);
    expect(input.flowId).toBeUndefined();
  });

  it("rejects hoursBack below 1, above 336 and non-integers", () => {
    const schema = analyzeFlowRunsTool.inputSchema;
    expect(schema.safeParse({ hoursBack: 0 }).success).toBe(false);
    expect(schema.safeParse({ hoursBack: 337 }).success).toBe(false);
    expect(schema.safeParse({ hoursBack: 1 }).success).toBe(true);
    expect(schema.safeParse({ hoursBack: 336 }).success).toBe(true);
    expect(schema.safeParse({ hoursBack: 12.5 }).success).toBe(false);
  });

  it("accepts a uuid flowId and rejects non-uuid strings", () => {
    const schema = analyzeFlowRunsTool.inputSchema;
    expect(schema.safeParse({ flowId: FLOW_A }).success).toBe(true);
    expect(schema.safeParse({ flowId: "not-a-guid" }).success).toBe(false);
    expect(schema.safeParse({ flowId: "" }).success).toBe(false);
  });
});

describe("query construction", () => {
  it("issues a GET on flowruns with the exact select, filter, orderby and top", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = sequencedClient(emptyFixture);
    await analyzeFlowRuns(client, parseInput());

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = callAt(get, 0);
    expect(path).toBe("flowruns");
    expect(options.select).toEqual([
      "name",
      "status",
      "starttime",
      "endtime",
      "duration",
      "errorcode",
      "errormessage",
      "_workflow_value",
    ]);
    // 72 hours back from the pinned clock.
    expect(options.filter).toBe("starttime ge 2026-07-07T12:00:00.000Z");
    expect(options.orderby).toBe("starttime desc");
    expect(options.top).toBe(5000);
  });

  it("appends an unquoted _workflow_value clause when flowId is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = sequencedClient(emptyFixture);
    await analyzeFlowRuns(client, parseInput({ hoursBack: 24, flowId: FLOW_A }));

    expect(get).toHaveBeenCalledTimes(1);
    const [, options] = callAt(get, 0);
    expect(options.filter).toBe(
      `starttime ge 2026-07-09T12:00:00.000Z and _workflow_value eq ${FLOW_A}`,
    );
    expect(options.orderby).toBe("starttime desc");
    expect(options.top).toBe(5000);
  });
});

describe("aggregation happy path", () => {
  it("builds the per-flow table sorted by failed desc, then runs desc", async () => {
    const { get, client } = sequencedClient(happyFixture, happyWorkflowsFixture);
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(result.windowHours).toBe(72);
    expect(result.totalRuns).toBe(17);
    expect(result.flowsAnalyzed).toBe(4);
    expect(result.truncated).toBeUndefined();
    expect("truncated" in (result as Record<string, unknown>)).toBe(false);
    expect(result.table).toHaveLength(4);

    // One flowruns page + one workflows name-resolution call (4 ids < 25).
    expect(get).toHaveBeenCalledTimes(2);
    const [wfPath, wfOptions] = callAt(get, 1);
    expect(wfPath).toBe("workflows");
    expect(wfOptions.select).toEqual(["workflowid", "name"]);
    // Distinct ids in encounter order (rows arrive starttime desc): C, B, A, D.
    expect(wfOptions.filter).toBe(
      `(workflowid eq ${FLOW_C} or workflowid eq ${FLOW_B} or ` +
        `workflowid eq ${FLOW_A} or workflowid eq ${FLOW_D})`,
    );

    // A and B tie on failed (3 each) → runs desc breaks the tie (6 > 4).
    expect(result.table?.map((r) => r.flowId)).toEqual([
      FLOW_A,
      FLOW_B,
      FLOW_C,
      FLOW_D,
    ]);

    const [flowA, flowB, flowC, flowD] = result.table as [
      FlowTableRow,
      FlowTableRow,
      FlowTableRow,
      FlowTableRow,
    ];

    // Flow A: 6 runs (3 S, 3 F), durations [12000,8000,11000,10000,15000,9000]
    // → sorted [8000,9000,10000,11000,12000,15000], n=6:
    // p50 index ceil(0.5*6)-1=2 → 10000; p95 index ceil(0.95*6)-1=5 → 15000;
    // avg 65000/6=10833.33 → 10833. All 3 failures share one error group.
    expect(flowA).toEqual({
      flowId: FLOW_A,
      flowName: "Order Sync",
      runs: 6,
      succeeded: 3,
      failed: 3,
      cancelled: 0,
      otherStatuses: 0,
      successRate: 50,
      p50DurationMs: 10000,
      p95DurationMs: 15000,
      avgDurationMs: 10833,
      maxDurationMs: 15000,
      lastRunAt: "2026-07-10T11:00:00Z",
      lastRunStatus: "Succeeded",
      errorGroups: [
        {
          errorCode: "ActionFailed",
          messageExcerpt:
            "Action 'Update_row' failed: The record was not found in table 'accounts'.",
          count: 3,
        },
      ],
    });

    // Flow B: 4 runs (F,F,F,S newest-first); one Failed run has duration null
    // and is dropped from the distribution → non-null [5000,4000,6000] sorted
    // [4000,5000,6000], n=3: p50 index ceil(1.5)-1=1 → 5000; p95 index
    // ceil(2.85)-1=2 → 6000; avg 15000/3=5000. Error groups sorted by count:
    // ConnectionAuthorizationFailed x2, TimeoutError x1 (message cut to 150).
    expect(flowB).toEqual({
      flowId: FLOW_B,
      flowName: "Invoice Approval",
      runs: 4,
      succeeded: 1,
      failed: 3,
      cancelled: 0,
      otherStatuses: 0,
      successRate: 25,
      p50DurationMs: 5000,
      p95DurationMs: 6000,
      avgDurationMs: 5000,
      maxDurationMs: 6000,
      lastRunAt: "2026-07-10T11:30:00Z",
      lastRunStatus: "Failed",
      errorGroups: [
        {
          errorCode: "ConnectionAuthorizationFailed",
          messageExcerpt:
            "The connection 'shared_office365' is not authorized. Please reauthorize.",
          count: 2,
        },
        {
          errorCode: "TimeoutError",
          messageExcerpt: TIMEOUT_MESSAGE.slice(0, 150),
          count: 1,
        },
      ],
    });
    const timeoutExcerpt = flowB.errorGroups[1]?.messageExcerpt ?? "";
    expect(timeoutExcerpt).toHaveLength(150);

    // Flow C: 5 runs (4 S, 1 Cancelled with null duration) → non-null
    // [320000,100000,90000,80000] sorted [80000,90000,100000,320000], n=4:
    // p50 index ceil(2)-1=1 → 90000; p95 index ceil(3.8)-1=3 → 320000;
    // avg 590000/4=147500. successRate 4/5 = 80 exactly → below the <80 gate.
    expect(flowC).toEqual({
      flowId: FLOW_C,
      flowName: "Nightly Data Export",
      runs: 5,
      succeeded: 4,
      failed: 0,
      cancelled: 1,
      otherStatuses: 0,
      successRate: 80,
      p50DurationMs: 90000,
      p95DurationMs: 320000,
      avgDurationMs: 147500,
      maxDurationMs: 320000,
      lastRunAt: "2026-07-10T12:00:00Z",
      lastRunStatus: "Succeeded",
      errorGroups: [],
    });

    // Flow D is missing from the workflows response → flowName "unknown".
    // Its Running run counts as otherStatuses with a null duration.
    expect(flowD).toEqual({
      flowId: FLOW_D,
      flowName: "unknown",
      runs: 2,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      otherStatuses: 1,
      successRate: 50,
      p50DurationMs: 3000,
      p95DurationMs: 3000,
      avgDurationMs: 3000,
      maxDurationMs: 3000,
      lastRunAt: "2026-07-10T05:30:00Z",
      lastRunStatus: "Running",
      errorGroups: [],
    });
  });

  it("raises high-failure-rate, failure-streak and slow-p95 flags in that order", async () => {
    const { client } = sequencedClient(happyFixture, happyWorkflowsFixture);
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(result.flags).toHaveLength(3);
    const [highFailure, streak, slow] = result.flags as [FlowFlag, FlowFlag, FlowFlag];

    expect(result.flags?.map((f) => f.flag)).toEqual([
      "high-failure-rate",
      "failure-streak",
      "slow-p95",
    ]);

    // Flow A: 50% over 6 runs. Flow B stays out (only 4 runs) and flow C
    // stays out (exactly 80%, the gate is strict less-than).
    expect(highFailure.flowId).toBe(FLOW_A);
    expect(highFailure.flowName).toBe("Order Sync");
    expect(highFailure.evidence).toBe(
      "success rate 50% over 6 runs (3 failed, 3 succeeded).",
    );
    expect(highFailure.recommendation).toContain("error group");
    expect(highFailure.recommendation).toContain("get_flow_runs");

    // Flow B: its 3 newest runs all Failed. Flow A's newest run succeeded,
    // so no streak there despite 3 total failures.
    expect(streak.flowId).toBe(FLOW_B);
    expect(streak.flowName).toBe("Invoice Approval");
    expect(streak.evidence).toBe("last 3 runs failed consecutively.");
    expect(streak.recommendation).toContain("expired connection");
    expect(streak.recommendation).toContain("flow edit");

    // Flow C: p95 320000 ms > 300000.
    expect(slow.flowId).toBe(FLOW_C);
    expect(slow.flowName).toBe("Nightly Data Export");
    expect(slow.evidence).toBe("p95 duration 320000 ms exceeds 5 minutes.");
    expect(slow.recommendation).toContain("pagination");
  });

  it("reports 0 durations for a flow whose runs all lack a duration", async () => {
    const flowId = "ffffffff-0000-4000-8000-00000000000f";
    const rows = ["Failed", "Failed", "Failed"].map((status, i) => ({
      name: `run-${i}`,
      status,
      starttime: `2026-07-10T0${3 - i}:00:00Z`,
      endtime: null,
      duration: null,
      errorcode: "Crash",
      errormessage: "boom",
      _workflow_value: flowId,
    }));
    const { client } = sequencedClient({ value: rows }, { value: [] });
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    const row = result.table?.[0] as FlowTableRow;
    expect(row.p50DurationMs).toBe(0);
    expect(row.p95DurationMs).toBe(0);
    expect(row.avgDurationMs).toBe(0);
    expect(row.maxDurationMs).toBe(0);
    // All 3 runs failed consecutively but runs < 5, so only the streak flag.
    expect(result.flags?.map((f) => f.flag)).toEqual(["failure-streak"]);
  });

  it("produces no flags for a clean, fast flow", async () => {
    const { client } = sequencedClient(cleanFixture, cleanWorkflowsFixture);
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(result.totalRuns).toBe(3);
    expect(result.flowsAnalyzed).toBe(1);
    expect(result.flags).toEqual([]);

    const row = result.table?.[0] as FlowTableRow;
    expect(row).toEqual({
      flowId: "eeeeeeee-0000-4000-8000-00000000000e",
      flowName: "Healthy Flow",
      runs: 3,
      succeeded: 3,
      failed: 0,
      cancelled: 0,
      otherStatuses: 0,
      successRate: 100,
      p50DurationMs: 2500,
      p95DurationMs: 3000,
      avgDurationMs: 2500,
      maxDurationMs: 3000,
      lastRunAt: "2026-07-10T10:00:00Z",
      lastRunStatus: "Succeeded",
      errorGroups: [],
    });
  });
});

describe("flow name resolution chunking", () => {
  it("splits the workflows or-chain into requests of at most 25 ids", async () => {
    const flowIds = Array.from(
      { length: 30 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const rows = flowIds.map((id, i) => ({
      name: `run-${i}`,
      status: "Succeeded",
      starttime: "2026-07-10T10:00:00Z",
      endtime: "2026-07-10T10:00:01Z",
      duration: 1000,
      errorcode: null,
      errormessage: null,
      _workflow_value: id,
    }));
    const { get, client } = sequencedClient(
      { value: rows },
      { value: [] },
      { value: [] },
    );
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(get).toHaveBeenCalledTimes(3);
    const [path1, options1] = callAt(get, 1);
    const [path2, options2] = callAt(get, 2);
    expect(path1).toBe("workflows");
    expect(path2).toBe("workflows");

    const firstChunk = flowIds.slice(0, 25);
    const secondChunk = flowIds.slice(25);
    expect(options1.filter).toBe(
      `(${firstChunk.map((id) => `workflowid eq ${id}`).join(" or ")})`,
    );
    expect(options2.filter).toBe(
      `(${secondChunk.map((id) => `workflowid eq ${id}`).join(" or ")})`,
    );

    // Neither chunk returned names → every flow falls back to "unknown".
    expect(result.flowsAnalyzed).toBe(30);
    expect(result.table?.every((r) => r.flowName === "unknown")).toBe(true);
  });
});

describe("empty result", () => {
  it("returns a zeroed payload with the solution-aware-flows hint and docsUrl", async () => {
    const { get, client } = sequencedClient(emptyFixture);
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    // No name-resolution call for an empty window.
    expect(get).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      windowHours: 72,
      totalRuns: 0,
      flowsAnalyzed: 0,
      table: [],
      flags: [],
      hint: "No cloud-flow runs found in the window. Dataverse run history covers solution-aware flows.",
      docsUrl: DOCS_URL,
    });
  });
});

describe("failure modes", () => {
  it("maps a 404 to an envelope hinting the flowrun virtual table may be unavailable", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        404,
        "Resource not found for the segment 'flowruns'.",
      ),
    );
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(result.error).toContain("flowruns");
    expect(result.hint).toContain("solution-aware");
    expect(result.docsUrl).toBe(DOCS_URL);
    expect(result.table).toBeUndefined();
  });

  it("maps a 403 to an envelope with the privilege hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        403,
        "Principal user (Id=00000000-0000-0000-0000-000000000001, type=8) is missing prvReadflowrun privilege",
      ),
    );
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(result.error).toContain("prvReadflowrun");
    expect(result.hint).toContain("read privilege");
    expect(result.docsUrl).toBe(DOCS_URL);
    expect(result.table).toBeUndefined();
  });

  it("maps any other error via toErrorEnvelope without letting it escape", async () => {
    const { client } = throwingClient(new Error("socket hang up"));
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;
    expect(result).toEqual({ error: "socket hang up" });
  });
});

describe("truncation", () => {
  it("marks the result truncated when the 5000-row page cap is hit", async () => {
    const flowId = "99999999-0000-4000-8000-000000000099";
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      name: `run-${i}`,
      status: "Succeeded",
      starttime: "2026-07-10T10:00:00Z",
      endtime: "2026-07-10T10:00:01Z",
      duration: 1000,
      errorcode: null,
      errormessage: null,
      _workflow_value: flowId,
    }));
    const { client } = sequencedClient(
      { value: rows },
      { value: [{ workflowid: flowId, name: "Bulk Flow" }] },
    );
    const result = (await analyzeFlowRuns(client, parseInput())) as ResultShape;

    expect(result.truncated).toBe(true);
    expect(result.totalRuns).toBe(5000);
    expect(result.flowsAnalyzed).toBe(1);
    expect(result.table?.[0]?.flowName).toBe("Bulk Flow");
    expect(result.flags).toEqual([]);
  });
});
