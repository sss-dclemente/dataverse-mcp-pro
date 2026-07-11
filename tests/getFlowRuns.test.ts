import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFlowRuns,
  queryFlowRuns,
  type FlowRunsInput,
} from "../src/tools/getFlowRuns.js";
import {
  DataverseHttpError,
  type DataverseClient,
  type QueryOptions,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const happyFixture = JSON.parse(
  readFileSync(new URL("./fixtures/flowRuns.happy.json", import.meta.url), "utf8"),
) as { value: Array<Record<string, unknown>> };
const emptyFixture = JSON.parse(
  readFileSync(new URL("./fixtures/flowRuns.empty.json", import.meta.url), "utf8"),
) as { value: unknown[] };
const workflowsFixture = JSON.parse(
  readFileSync(new URL("./fixtures/flowRuns.workflows.json", import.meta.url), "utf8"),
) as { value: Array<Record<string, unknown>> };

interface ResultShape {
  count?: number;
  windowHours?: number;
  runs?: Array<Record<string, unknown>>;
  error?: string;
  hint?: string;
  docsUrl?: string;
}

function sequencedClient(...results: unknown[]) {
  const get = vi.fn(
    async (_path: string, _options?: QueryOptions): Promise<unknown> => undefined,
  );
  for (const result of results) get.mockResolvedValueOnce(result);
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

function parseInput(raw: Record<string, unknown> = {}): FlowRunsInput {
  return getFlowRuns.inputSchema.parse(raw);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("input schema", () => {
  it("applies defaults: hoursBack 24, top 25, all filters optional", () => {
    const input = parseInput();
    expect(input.hoursBack).toBe(24);
    expect(input.top).toBe(25);
    expect(input.flowId).toBeUndefined();
    expect(input.flowName).toBeUndefined();
    expect(input.status).toBeUndefined();
  });

  it("rejects hoursBack above 168 and below 1", () => {
    expect(getFlowRuns.inputSchema.safeParse({ hoursBack: 169 }).success).toBe(false);
    expect(getFlowRuns.inputSchema.safeParse({ hoursBack: 0 }).success).toBe(false);
    expect(getFlowRuns.inputSchema.safeParse({ hoursBack: 168 }).success).toBe(true);
  });

  it("rejects top above 100 and below 1", () => {
    expect(getFlowRuns.inputSchema.safeParse({ top: 101 }).success).toBe(false);
    expect(getFlowRuns.inputSchema.safeParse({ top: 0 }).success).toBe(false);
    expect(getFlowRuns.inputSchema.safeParse({ top: 100 }).success).toBe(true);
  });

  it("rejects a non-uuid flowId and accepts a valid one", () => {
    expect(getFlowRuns.inputSchema.safeParse({ flowId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(
      getFlowRuns.inputSchema.safeParse({
        flowId: "aaaaaaaa-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("accepts only the four lowercase status values", () => {
    for (const status of ["succeeded", "failed", "cancelled", "running"]) {
      expect(getFlowRuns.inputSchema.safeParse({ status }).success).toBe(true);
    }
    expect(getFlowRuns.inputSchema.safeParse({ status: "Succeeded" }).success).toBe(
      false,
    );
    expect(getFlowRuns.inputSchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  it("is exposed as the tool get_flow_runs", () => {
    expect(getFlowRuns.name).toBe("get_flow_runs");
    expect(getFlowRuns.description.toLowerCase()).toContain("free tier");
  });
});

describe("happy path with flowName resolution", () => {
  it("resolves the flow via workflows (escaped exact match), then queries flowruns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = sequencedClient(workflowsFixture, happyFixture);
    const result = (await queryFlowRuns(
      client,
      parseInput({ flowName: "O'Brien Order Sync", status: "succeeded", top: 50 }),
    )) as ResultShape;

    expect(get).toHaveBeenCalledTimes(2);

    const [workflowsPath, workflowsOptions] = callAt(get, 0);
    expect(workflowsPath).toBe("workflows");
    expect(workflowsOptions.select).toEqual(["workflowid", "name"]);
    // category 5 = modern cloud flow, type 1 = definition; single quote doubled.
    expect(workflowsOptions.filter).toBe(
      "category eq 5 and type eq 1 and name eq 'O''Brien Order Sync'",
    );

    const [runsPath, runsOptions] = callAt(get, 1);
    expect(runsPath).toBe("flowruns");
    expect(runsOptions.select).toEqual([
      "name",
      "status",
      "starttime",
      "endtime",
      "duration",
      "triggertype",
      "errorcode",
      "errormessage",
      "_workflow_value",
    ]);
    expect(runsOptions.orderby).toBe("starttime desc");
    expect(runsOptions.top).toBe(50);
    const parts = (runsOptions.filter ?? "").split(" and ");
    expect(parts).toEqual([
      "starttime ge 2026-07-09T12:00:00.000Z",
      "status eq 'Succeeded'",
      "(_workflow_value eq aaaaaaaa-1111-4111-8111-111111111111 or " +
        "_workflow_value eq bbbbbbbb-2222-4222-8222-222222222222)",
    ]);
    // Lookup GUID literals must not be quoted.
    expect(runsOptions.filter).not.toContain("_workflow_value eq '");

    expect(result.count).toBe(3);
    expect(result.windowHours).toBe(24);
    expect(result.hint).toBeUndefined();
  });

  it("maps runs: error truncation to 300 chars, null duration omitted", async () => {
    const { client } = sequencedClient(workflowsFixture, happyFixture);
    const result = (await queryFlowRuns(
      client,
      parseInput({ flowName: "O'Brien Order Sync" }),
    )) as ResultShape;

    const [failed, succeeded, running] = result.runs as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    const rawError = happyFixture.value[0]?.["errormessage"] as string;
    expect(rawError.length).toBeGreaterThan(300);
    expect(failed).toMatchObject({
      runName: "08585287700727607973207791544CU21",
      flowId: "aaaaaaaa-1111-4111-8111-111111111111",
      status: "Failed",
      startTime: "2026-07-10T11:30:02Z",
      endTime: "2026-07-10T11:30:14Z",
      durationMs: 12345,
      triggerType: "Automated",
      errorCode: "WorkflowActionFailed",
    });
    expect(failed.errorMessage).toBe(rawError.slice(0, 300));
    expect((failed.errorMessage as string).length).toBe(300);

    // No error fields on non-failed runs.
    expect("errorCode" in succeeded).toBe(false);
    expect("errorMessage" in succeeded).toBe(false);
    expect(succeeded.durationMs).toBe(4200);

    // Null duration is omitted, null endtime is kept as null.
    expect("durationMs" in running).toBe(false);
    expect(running.endTime).toBeNull();
    expect(running.status).toBe("Running");

    // Raw Dataverse field names never appear in the output.
    for (const run of result.runs ?? []) {
      expect("errormessage" in run).toBe(false);
      expect("_workflow_value" in run).toBe(false);
      expect("starttime" in run).toBe(false);
    }
  });
});

describe("all-flows and flowId paths", () => {
  it("queries flowruns directly when neither flowId nor flowName is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = sequencedClient(happyFixture);
    await queryFlowRuns(client, parseInput({ hoursBack: 48 }));

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = callAt(get, 0);
    expect(path).toBe("flowruns");
    expect(options.filter).toBe("starttime ge 2026-07-08T12:00:00.000Z");
    expect(options.filter).not.toContain("_workflow_value");
  });

  it("uses flowId as-is without any workflows lookup", async () => {
    const { get, client } = sequencedClient(happyFixture);
    await queryFlowRuns(
      client,
      parseInput({ flowId: "aaaaaaaa-1111-4111-8111-111111111111" }),
    );

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = callAt(get, 0);
    expect(path).toBe("flowruns");
    expect(options.filter).toContain(
      "(_workflow_value eq aaaaaaaa-1111-4111-8111-111111111111)",
    );
  });
});

describe("flow not found", () => {
  it("retries with contains() and returns an envelope when both lookups are empty", async () => {
    const { get, client } = sequencedClient(emptyFixture, emptyFixture);
    const result = (await queryFlowRuns(
      client,
      parseInput({ flowName: "Ghost Flow" }),
    )) as ResultShape;

    // Two workflows lookups, no flowruns query.
    expect(get).toHaveBeenCalledTimes(2);
    const [, exactOptions] = callAt(get, 0);
    expect(exactOptions.filter).toBe(
      "category eq 5 and type eq 1 and name eq 'Ghost Flow'",
    );
    const [retryPath, retryOptions] = callAt(get, 1);
    expect(retryPath).toBe("workflows");
    expect(retryOptions.filter).toBe(
      "category eq 5 and type eq 1 and contains(name,'Ghost Flow')",
    );

    expect(result.error).toContain('No cloud flow found matching "Ghost Flow"');
    expect(result.hint).toContain("flowId");
    expect(result.runs).toBeUndefined();
  });
});

describe("failure modes", () => {
  it("maps a 404 to the virtual-table-not-available hint with docsUrl", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(404, "Resource not found for the segment 'flowruns'."),
    );
    const result = (await queryFlowRuns(client, parseInput())) as ResultShape;

    expect(result.error).toContain("flowruns");
    expect(result.hint).toContain("flowrun virtual table");
    expect(result.hint).toContain("solution-aware");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 400 that reports the entity as not found to the same virtual-table hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        400,
        "The entity with a name = 'flowrun' was not found in the MetadataCache.",
      ),
    );
    const result = (await queryFlowRuns(client, parseInput())) as ResultShape;

    expect(result.hint).toContain("flowrun virtual table");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps any other 400 to the limited-OData-filtering hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        400,
        "The query specified in the URI is not valid. A binary operator with incompatible types was detected.",
      ),
    );
    const result = (await queryFlowRuns(client, parseInput())) as ResultShape;

    expect(result.error).toContain("not valid");
    expect(result.hint).toContain("limited OData filtering");
    expect(result.hint).toContain("flowId");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 403 to an envelope with the read-privilege hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        403,
        "Principal user is missing prvReadWorkflow privilege",
      ),
    );
    const result = (await queryFlowRuns(client, parseInput())) as ResultShape;

    expect(result.error).toContain("prvReadWorkflow");
    expect(result.hint).toContain("read privilege");
    expect(result.hint).toContain("workflow");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps any other error via toErrorEnvelope without letting it escape", async () => {
    const { client } = throwingClient(new Error("socket hang up"));
    const result = (await queryFlowRuns(client, parseInput())) as ResultShape;
    expect(result).toEqual({ error: "socket hang up" });
  });
});

describe("empty result", () => {
  it("returns count 0 with the solution-aware hint", async () => {
    const { client } = sequencedClient(emptyFixture);
    const result = (await queryFlowRuns(client, parseInput())) as ResultShape;

    expect(result.count).toBe(0);
    expect(result.windowHours).toBe(24);
    expect(result.runs).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.hint).toBe(
      "No runs in the window. Note that Dataverse run history covers solution-aware cloud flows.",
    );
  });
});
