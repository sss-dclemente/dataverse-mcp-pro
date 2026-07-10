import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainTrace, explainTraceTool } from "../src/tools/explainTrace.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

const TRACE_ID = "aaaaaaaa-0000-4000-8000-00000000000f";
const CORR_ID = "cccccccc-1111-4222-8333-444444444444";
const STEP_ID = "dddddddd-1111-4222-8333-444444444444";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface Envelope {
  error: string;
  hint?: string;
  docsUrl?: string;
}

interface PipelineEntry {
  id: string | null;
  pluginType: string | null;
  messageName: string | null;
  primaryEntity: string | null;
  depth: number | null;
  mode: string;
  durationMs: number | null;
  failed: boolean;
  isFocus: boolean;
}

interface ExplainResult {
  summary: string;
  trace: {
    id: string | null;
    createdon: string | null;
    pluginType: string | null;
    messageName: string | null;
    primaryEntity: string | null;
    depth: number | null;
    mode: string;
    durationMs: number | null;
    correlationId: string | null;
  };
  exception: { type: string | null; message: string | null; frames: string[] } | null;
  stepConfig: {
    id: string;
    name: string;
    message: string;
    entity: string;
    stage: string;
    mode: string;
    rank: number | null;
    filteringAttributes: string | null;
    images: Array<{
      name: string | null;
      entityAlias: string | null;
      imageType: string;
      attributes: string | null;
    }>;
  } | null;
  stepConfigNote?: string;
  pipeline: PipelineEntry[];
  detectedPatterns: Array<{ pattern: string; evidence: string; likelyFix: string }>;
  rawExcerpt: string;
  messageBlockExcerpt?: string;
}

function makeFakeClient() {
  const get = vi.fn();
  return { client: { get } as unknown as Pick<DataverseClient, "get">, get };
}

type QueryArg = {
  select?: string[];
  filter?: string;
  expand?: string;
  orderby?: string;
  top?: number;
};

function callArgs(
  mock: ReturnType<typeof vi.fn>,
  index: number,
): [string, QueryArg] {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`no call at index ${index}`);
  return call as unknown as [string, QueryArg];
}

const TRACE_SELECT = [
  "plugintracelogid",
  "createdon",
  "typename",
  "messagename",
  "primaryentity",
  "depth",
  "mode",
  "performanceexecutionduration",
  "exceptiondetails",
  "messageblock",
  "correlationid",
  "pluginstepid",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("explain_trace pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await explainTraceTool.handler({})) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("explain_trace");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // No ids: reaches the core function's input guard, not the gate.
    const result = (await explainTraceTool.handler({})) as Envelope & {
      upgradeRequired?: boolean;
    };

    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("Provide traceId or correlationId");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("explainTrace input guard", () => {
  it("returns an error envelope and makes no request when both ids are missing", async () => {
    const { client, get } = makeFakeClient();

    const result = (await explainTrace(client, {})) as Envelope;

    expect(result.error).toBe("Provide traceId or correlationId");
    expect(result.hint).toBeDefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("explainTrace by traceId", () => {
  it("correlates trace, step config and pipeline into a root-cause payload", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("explainTrace.trace.sqlTimeout.json"))
      .mockResolvedValueOnce(loadFixture("explainTrace.step.json"))
      .mockResolvedValueOnce(loadFixture("explainTrace.pipeline.json"));

    const result = (await explainTrace(client, {
      traceId: TRACE_ID,
    })) as ExplainResult;

    expect(get).toHaveBeenCalledTimes(3);

    // 1. Focus trace by id, selecting the big fields too.
    const [tracePath, traceQuery] = callArgs(get, 0);
    expect(tracePath).toBe(`plugintracelogs(${TRACE_ID})`);
    expect(traceQuery.select).toEqual(TRACE_SELECT);

    // 2. Step config with message/filter/image expands.
    const [stepPath, stepQuery] = callArgs(get, 1);
    expect(stepPath).toBe(`sdkmessageprocessingsteps(${STEP_ID})`);
    expect(stepQuery.select).toEqual([
      "name",
      "stage",
      "mode",
      "rank",
      "filteringattributes",
    ]);
    expect(stepQuery.expand).toContain("sdkmessageid($select=name)");
    expect(stepQuery.expand).toContain(
      "sdkmessagefilterid($select=primaryobjecttypecode)",
    );
    expect(stepQuery.expand).toContain(
      "sdkmessageprocessingstepid_sdkmessageprocessingstepimage($select=name,entityalias,imagetype,attributes)",
    );

    // 3. Pipeline ordered shallow-to-deep and chronologically.
    const [pipelinePath, pipelineQuery] = callArgs(get, 2);
    expect(pipelinePath).toBe("plugintracelogs");
    expect(pipelineQuery.filter).toBe(`correlationid eq ${CORR_ID}`);
    expect(pipelineQuery.orderby).toBe("depth asc,createdon asc");
    expect(pipelineQuery.top).toBe(50);

    // Summary names the plug-in and the parsed exception type.
    expect(result.summary).toContain("MyCompany.Plugins.AccountPostUpdatePlugin");
    expect(result.summary).toContain("SqlException");
    expect(result.summary).toContain("1 of 4 traces in this correlation failed");

    // Trace facts.
    expect(result.trace.id).toBe(TRACE_ID);
    expect(result.trace.depth).toBe(3);
    expect(result.trace.mode).toBe("sync");
    expect(result.trace.durationMs).toBe(30125);
    expect(result.trace.correlationId).toBe(CORR_ID);

    // Exception parsed to the innermost type/message, plug-in frames only.
    expect(result.exception).not.toBeNull();
    expect(result.exception?.type).toContain("SqlException");
    expect(result.exception?.message).toMatch(/timeout/i);
    expect(result.exception?.frames.length).toBeGreaterThan(0);
    expect(
      result.exception?.frames.some((f) => f.includes("MyCompany.Plugins")),
    ).toBe(true);
    expect(
      result.exception?.frames.every((f) => !f.includes("Microsoft.Xrm")),
    ).toBe(true);

    // Step config mapped to labels.
    expect(result.stepConfig).not.toBeNull();
    expect(result.stepConfig?.id).toBe(STEP_ID);
    expect(result.stepConfig?.message).toBe("Update");
    expect(result.stepConfig?.entity).toBe("account");
    expect(result.stepConfig?.stage).toBe("PostOperation");
    expect(result.stepConfig?.mode).toBe("sync");
    expect(result.stepConfig?.rank).toBe(1);
    expect(result.stepConfig?.filteringAttributes).toBe("revenue,name");
    expect(result.stepConfig?.images).toHaveLength(1);
    expect(result.stepConfig?.images[0]?.imageType).toBe("PreImage");
    expect(result.stepConfig?.images[0]?.attributes).toBe("revenue,name,statecode");
    expect(result.stepConfigNote).toBeUndefined();

    // Pipeline flags: only the depth-3 focus trace failed.
    expect(result.pipeline).toHaveLength(4);
    expect(result.pipeline.map((t) => t.depth)).toEqual([1, 2, 2, 3]);
    expect(result.pipeline.map((t) => t.failed)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(result.pipeline.map((t) => t.isFocus)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(result.pipeline[3]?.id).toBe(TRACE_ID);

    // Pattern detection saw the SQL timeout.
    expect(result.detectedPatterns.map((p) => p.pattern)).toContain("sql-timeout");

    // Excerpts are hard-truncated.
    expect(result.rawExcerpt).toHaveLength(1500);
    expect(result.messageBlockExcerpt).toBeDefined();
    expect(result.messageBlockExcerpt?.length).toBeLessThanOrEqual(500);
  });

  it("notes a missing step registration (404) without failing the tool", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("explainTrace.trace.sqlTimeout.json"))
      .mockRejectedValueOnce(
        new DataverseHttpError(
          404,
          `sdkmessageprocessingstep With Id = ${STEP_ID} Does Not Exist`,
        ),
      )
      .mockResolvedValueOnce(loadFixture("explainTrace.pipeline.json"));

    const result = (await explainTrace(client, {
      traceId: TRACE_ID,
    })) as ExplainResult;

    expect(get).toHaveBeenCalledTimes(3);
    expect(result.stepConfig).toBeNull();
    expect(result.stepConfigNote).toBe(
      "step no longer exists (plug-in re-registered or removed)",
    );
    expect(result.summary).toContain("MyCompany.Plugins.AccountPostUpdatePlugin");
    expect(result.pipeline).toHaveLength(4);
  });

  it("skips the step lookup when the trace has no pluginstepid", async () => {
    const fixture = loadFixture<Record<string, unknown>>(
      "explainTrace.trace.sqlTimeout.json",
    );
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce({ ...fixture, pluginstepid: null })
      .mockResolvedValueOnce(loadFixture("explainTrace.pipeline.json"));

    const result = (await explainTrace(client, {
      traceId: TRACE_ID,
    })) as ExplainResult;

    // Only the trace and pipeline requests: no sdkmessageprocessingsteps call.
    expect(get).toHaveBeenCalledTimes(2);
    expect(callArgs(get, 1)[0]).toBe("plugintracelogs");
    expect(result.stepConfig).toBeNull();
    expect(result.stepConfigNote).toBe("trace does not reference a step");
  });
});

describe("explainTrace by correlationId", () => {
  it("queries the deepest failing trace and uses it as the focus", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("explainTrace.corr.focus.json"))
      .mockResolvedValueOnce(loadFixture("explainTrace.step.json"))
      .mockResolvedValueOnce(loadFixture("explainTrace.pipeline.json"));

    const result = (await explainTrace(client, {
      correlationId: CORR_ID,
    })) as ExplainResult;

    const [focusPath, focusQuery] = callArgs(get, 0);
    expect(focusPath).toBe("plugintracelogs");
    expect(focusQuery.select).toEqual(TRACE_SELECT);
    expect(focusQuery.filter).toBe(
      `correlationid eq ${CORR_ID} and exceptiondetails ne null`,
    );
    expect(focusQuery.orderby).toBe("depth desc,createdon desc");
    expect(focusQuery.top).toBe(1);

    expect(result.trace.id).toBe(TRACE_ID);
    expect(result.trace.depth).toBe(3);
    expect(result.stepConfig?.stage).toBe("PostOperation");
    expect(result.pipeline).toHaveLength(4);
  });

  it("prefers traceId when both ids are supplied", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("explainTrace.trace.sqlTimeout.json"))
      .mockResolvedValueOnce(loadFixture("explainTrace.step.json"))
      .mockResolvedValueOnce(loadFixture("explainTrace.pipeline.json"));

    await explainTrace(client, { traceId: TRACE_ID, correlationId: CORR_ID });

    expect(callArgs(get, 0)[0]).toBe(`plugintracelogs(${TRACE_ID})`);
  });

  it("returns an envelope when no trace in the correlation failed", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: [] });

    const result = (await explainTrace(client, {
      correlationId: CORR_ID,
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("No failing trace found for that correlationId");
    expect(result.hint).toContain("without an exception");
  });
});

describe("explainTrace failure modes", () => {
  it("maps a 404 on the trace itself to a 'Trace not found' envelope", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(
        404,
        `plugintracelog With Id = ${TRACE_ID} Does Not Exist`,
      ),
    );

    const result = (await explainTrace(client, {
      traceId: TRACE_ID,
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("Trace not found");
    expect(result.hint).toContain("purged");
    expect(result.hint).toContain("get_plugin_traces");
  });

  it("maps a 403 to an envelope with a privilege hint and docsUrl", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "explainTrace.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await explainTrace(client, {
      traceId: TRACE_ID,
    })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("prvReadPluginTraceLog");
    expect(result.hint).toContain("SdkMessageProcessingStep");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await explainTrace(client, {
      correlationId: CORR_ID,
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
