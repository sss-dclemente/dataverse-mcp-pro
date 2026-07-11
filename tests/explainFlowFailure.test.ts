import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explainFlowFailure,
  explainFlowFailureTool,
  type ExplainFlowFailureInput,
} from "../src/tools/explainFlowFailure.js";
import {
  detectFlowFailurePatterns,
  FLOW_FAILURE_PATTERN_RULES,
} from "../src/tools/flowFailurePatterns.js";
import {
  DataverseHttpError,
  type DataverseClient,
  type QueryOptions,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const FLOW_ID = "11111111-0000-4000-8000-000000000011";
const RUN_NAME = "08585287500499200907519834647CU12";

const RUN_SELECT = [
  "name",
  "status",
  "starttime",
  "endtime",
  "duration",
  "triggertype",
  "errorcode",
  "errormessage",
  "_workflow_value",
];

const FLOW_SELECT = ["workflowid", "name", "clientdata", "statecode"];

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

const authRunFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "explainFlowFailure.run.authFailure.json",
);
const succeededRunFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "explainFlowFailure.run.succeeded.json",
);
const flowFixture = loadFixture<Record<string, unknown>>(
  "explainFlowFailure.flow.json",
);
const flowBadClientDataFixture = loadFixture<Record<string, unknown>>(
  "explainFlowFailure.flow.badClientData.json",
);
const workflowsByNameFixture = loadFixture<{ value: Array<Record<string, unknown>> }>(
  "explainFlowFailure.workflows.byName.json",
);
const emptyRunsFixture = loadFixture<{ value: unknown[] }>(
  "explainFlowFailure.runs.empty.json",
);

const AUTH_ERROR_MESSAGE = authRunFixture.value[0]?.["errormessage"] as string;

interface ActionSummary {
  name: string;
  operationId?: string;
}

interface ResultShape {
  summary?: string;
  run?: {
    runName: string | null;
    status: string | null;
    startTime: string | null;
    endTime: string | null;
    durationMs?: number;
    triggerType: string | null;
    errorCode?: string;
    errorMessageExcerpt?: string;
  };
  flow?: { id: string | null; name: string | null; state: string } | null;
  statusNote?: string;
  failedActionGuess?: {
    name: string;
    foundInDefinition: boolean;
    operationId?: string;
  };
  actions?: ActionSummary[];
  actionsTruncated?: boolean;
  definitionNote?: string;
  detectedPatterns?: Array<{ pattern: string; evidence: string; likelyFix: string }>;
  rawErrorExcerpt?: string;
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

function parseInput(raw: Record<string, unknown> = {}): ExplainFlowFailureInput {
  return explainFlowFailureTool.inputSchema.parse(raw);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("explain_flow_failure pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await explainFlowFailureTool.handler(parseInput())) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("explain_flow_failure");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    vi.stubEnv("CLIENT_ID", "client");
    vi.stubEnv("CLIENT_SECRET", "secret");
    vi.stubEnv("TENANT_ID", "tenant");
    const fetchSpy = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await explainFlowFailureTool.handler(
      parseInput({ runName: RUN_NAME }),
    )) as ResultShape & { upgradeRequired?: boolean };

    // Past the gate: the client was built and attempted a token request,
    // whose failure came back as an error envelope, not an exception.
    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("boom");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("is exposed as the tool explain_flow_failure", () => {
    expect(explainFlowFailureTool.name).toBe("explain_flow_failure");
    expect(explainFlowFailureTool.description).toContain("Pro tier");
  });
});

describe("input schema and guard", () => {
  it("accepts each identifier alone and rejects malformed values", () => {
    const schema = explainFlowFailureTool.inputSchema;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ runName: RUN_NAME }).success).toBe(true);
    expect(schema.safeParse({ flowId: FLOW_ID }).success).toBe(true);
    expect(schema.safeParse({ flowName: "Invoice Approval" }).success).toBe(true);
    expect(schema.safeParse({ runName: "" }).success).toBe(false);
    expect(schema.safeParse({ flowId: "not-a-guid" }).success).toBe(false);
    expect(schema.safeParse({ flowName: "" }).success).toBe(false);
  });

  it("returns an envelope when no identifier is provided, without calling Dataverse", async () => {
    const { get, client } = sequencedClient();
    const result = (await explainFlowFailure(client, parseInput())) as ResultShape;

    expect(result.error).toBe("Provide runName, flowId or flowName");
    expect(result.hint).toContain("runName");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("runName happy path (expired connection)", () => {
  it("resolves the run by name, analyzes the failure and detects connection-auth", async () => {
    const { get, client } = sequencedClient(authRunFixture, flowFixture);
    const result = (await explainFlowFailure(
      client,
      parseInput({ runName: RUN_NAME }),
    )) as ResultShape;

    // Query 1: exact run lookup in flowruns.
    expect(get).toHaveBeenCalledTimes(2);
    const [runPath, runOptions] = callAt(get, 0);
    expect(runPath).toBe("flowruns");
    expect(runOptions.select).toEqual(RUN_SELECT);
    expect(runOptions.filter).toBe(`name eq '${RUN_NAME}'`);
    expect(runOptions.top).toBe(1);

    // Query 2: the flow record referenced by the run.
    const [flowPath, flowOptions] = callAt(get, 1);
    expect(flowPath).toBe(`workflows(${FLOW_ID})`);
    expect(flowOptions.select).toEqual(FLOW_SELECT);

    expect(result.run).toEqual({
      runName: RUN_NAME,
      status: "Failed",
      startTime: "2026-07-10T11:30:00Z",
      endTime: "2026-07-10T11:30:04Z",
      durationMs: 4000,
      triggerType: "OpenApiConnectionWebhook",
      errorCode: "ConnectionAuthorizationFailed",
      errorMessageExcerpt: AUTH_ERROR_MESSAGE.slice(0, 500),
    });
    // The fixture message is longer than the excerpt cap, proving truncation.
    expect(AUTH_ERROR_MESSAGE.length).toBeGreaterThan(500);
    expect(result.run?.errorMessageExcerpt).toHaveLength(500);

    expect(result.flow).toEqual({
      id: FLOW_ID,
      name: "Invoice Approval",
      state: "activated",
    });

    // Actions flattened from clientdata, including nested If branches.
    expect(result.actions).toEqual([
      { name: "Get_invoice_row", operationId: "GetItem" },
      { name: "Condition" },
      { name: "Send_approval_email", operationId: "SendEmailV2" },
      { name: "Update_status", operationId: "UpdateRecord" },
    ]);
    expect(result.actionsTruncated).toBeUndefined();
    expect(result.definitionNote).toBeUndefined();
    expect(result.statusNote).toBeUndefined();

    // The error message names the failing action, which exists in the definition.
    expect(result.failedActionGuess).toEqual({
      name: "Send_approval_email",
      foundInDefinition: true,
      operationId: "SendEmailV2",
    });

    expect(result.detectedPatterns?.map((p) => p.pattern)).toEqual([
      "connection-auth",
    ]);
    expect(result.detectedPatterns?.[0]?.likelyFix).toContain("Reconnect");

    expect(result.summary).toContain('"Invoice Approval"');
    expect(result.summary).toContain("failed");
    expect(result.summary).toContain("Send_approval_email");
    expect(result.summary).toContain("connection-auth");

    expect(result.rawErrorExcerpt).toBe(
      `ConnectionAuthorizationFailed: ${AUTH_ERROR_MESSAGE}`.slice(0, 500),
    );
  });

  it("notes a non-Failed status but still analyzes the run", async () => {
    const { client } = sequencedClient(succeededRunFixture, flowFixture);
    const result = (await explainFlowFailure(
      client,
      parseInput({ runName: RUN_NAME }),
    )) as ResultShape;

    expect(result.statusNote).toBe(
      'Run status is "Succeeded", not "Failed" — analyzed anyway.',
    );
    expect(result.run?.status).toBe("Succeeded");
    expect(result.run?.errorCode).toBeUndefined();
    expect(result.failedActionGuess).toBeUndefined();
    expect(result.actions).toHaveLength(4);
    expect(result.detectedPatterns).toEqual([]);
    expect(result.rawErrorExcerpt).toBe("");
    expect(result.summary).toContain("ended with status Succeeded");
  });
});

describe("flowName → latest failed run path", () => {
  it("resolves the flow by contains() fallback, then picks the newest Failed run", async () => {
    const { get, client } = sequencedClient(
      { value: [] }, // exact name match — no hit
      workflowsByNameFixture, // contains() fallback
      authRunFixture, // latest Failed run
      flowFixture, // flow record
    );
    const result = (await explainFlowFailure(
      client,
      parseInput({ flowName: "Invoice Approval" }),
    )) as ResultShape;

    expect(get).toHaveBeenCalledTimes(4);
    const [exactPath, exactOptions] = callAt(get, 0);
    expect(exactPath).toBe("workflows");
    expect(exactOptions.select).toEqual(["workflowid", "name"]);
    expect(exactOptions.filter).toBe(
      "category eq 5 and type eq 1 and name eq 'Invoice Approval'",
    );
    expect(exactOptions.top).toBe(1);

    const [, fuzzyOptions] = callAt(get, 1);
    expect(fuzzyOptions.filter).toBe(
      "category eq 5 and type eq 1 and contains(name,'Invoice Approval')",
    );

    const [runsPath, runsOptions] = callAt(get, 2);
    expect(runsPath).toBe("flowruns");
    expect(runsOptions.select).toEqual(RUN_SELECT);
    expect(runsOptions.filter).toBe(
      `_workflow_value eq ${FLOW_ID} and status eq 'Failed'`,
    );
    expect(runsOptions.orderby).toBe("starttime desc");
    expect(runsOptions.top).toBe(1);

    const [flowPath] = callAt(get, 3);
    expect(flowPath).toBe(`workflows(${FLOW_ID})`);

    expect(result.run?.runName).toBe(RUN_NAME);
    expect(result.detectedPatterns?.map((p) => p.pattern)).toEqual([
      "connection-auth",
    ]);
  });

  it("returns an envelope when no cloud flow matches the name", async () => {
    const { get, client } = sequencedClient({ value: [] }, { value: [] });
    const result = (await explainFlowFailure(
      client,
      parseInput({ flowName: "Nope" }),
    )) as ResultShape;

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.error).toBe('No cloud flow found matching "Nope".');
    expect(result.hint).toContain("flowId");
  });
});

describe("run resolution envelopes", () => {
  it("returns an envelope when the runName does not exist", async () => {
    const { get, client } = sequencedClient(emptyRunsFixture);
    const result = (await explainFlowFailure(
      client,
      parseInput({ runName: "no-such-run" }),
    )) as ResultShape;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toBe('Flow run not found: "no-such-run"');
    expect(result.hint).toContain("get_flow_runs");
  });

  it("returns an envelope when the flow has no Failed runs", async () => {
    const { get, client } = sequencedClient(emptyRunsFixture);
    const result = (await explainFlowFailure(
      client,
      parseInput({ flowId: FLOW_ID }),
    )) as ResultShape;

    expect(get).toHaveBeenCalledTimes(1);
    const [, options] = callAt(get, 0);
    expect(options.filter).toBe(
      `_workflow_value eq ${FLOW_ID} and status eq 'Failed'`,
    );
    expect(result.error).toBe("No failed runs found for this flow");
    expect(result.hint).toContain("get_flow_runs");
  });
});

describe("pattern rules", () => {
  const SAMPLES: Record<string, string> = {
    "connection-auth":
      "The response was 401 InvalidAuthenticationToken from the service.",
    throttling: "TooManyRequests: retry after some delay.",
    timeout: "The downstream call ended with GatewayTimeout.",
    permission: "AccessDenied to the target record.",
    expression: "InvalidTemplate. Unable to process template language operations.",
    "apply-to-each-limits": "Enable pagination to retrieve more records.",
    "dataverse-plugin-error": "ISV code aborted the operation.",
  };

  it("each rule fires on crafted text with its own fix and evidence", () => {
    expect(FLOW_FAILURE_PATTERN_RULES.map((r) => r.pattern)).toEqual(
      Object.keys(SAMPLES),
    );
    for (const rule of FLOW_FAILURE_PATTERN_RULES) {
      const sample = SAMPLES[rule.pattern] ?? "";
      const detected = detectFlowFailurePatterns({ text: sample });
      expect(detected.map((d) => d.pattern)).toEqual([rule.pattern]);
      expect(detected[0]?.likelyFix).toBe(rule.likelyFix);
      expect(detected[0]?.evidence.length).toBeGreaterThan(0);
      expect(detected[0]?.evidence.length).toBeLessThanOrEqual(200);
    }
  });

  it("dataverse-plugin-error points at explain_trace for the correlated plug-in trace", () => {
    const detected = detectFlowFailurePatterns({
      text: "BusinessProcessError\nThe plugin threw an exception.",
    });
    expect(detected.map((d) => d.pattern)).toEqual(["dataverse-plugin-error"]);
    expect(detected[0]?.likelyFix).toContain("explain_trace");
  });
});

describe("definition tolerance", () => {
  it("tolerates unparsable clientdata: empty actions, note, and an unmatched guess", async () => {
    const { client } = sequencedClient(authRunFixture, flowBadClientDataFixture);
    const result = (await explainFlowFailure(
      client,
      parseInput({ runName: RUN_NAME }),
    )) as ResultShape;

    expect(result.actions).toEqual([]);
    expect(result.definitionNote).toBe(
      "flow definition could not be parsed (invalid clientdata JSON)",
    );
    // The flow row itself is still reported.
    expect(result.flow).toEqual({
      id: FLOW_ID,
      name: "Invoice Approval",
      state: "activated",
    });
    // The guessed action cannot be cross-checked against a definition.
    expect(result.failedActionGuess).toEqual({
      name: "Send_approval_email",
      foundInDefinition: false,
    });
    expect(result.detectedPatterns?.map((p) => p.pattern)).toEqual([
      "connection-auth",
    ]);
  });
});

describe("failure modes", () => {
  it("maps a 404 to an envelope hinting the flowrun virtual table may be unavailable", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(404, "Resource not found for the segment 'flowruns'."),
    );
    const result = (await explainFlowFailure(
      client,
      parseInput({ runName: RUN_NAME }),
    )) as ResultShape;

    expect(result.error).toContain("flowruns");
    expect(result.hint).toContain("solution-aware");
    expect(result.docsUrl).toBe(DOCS_URL);
    expect(result.run).toBeUndefined();
  });

  it("maps a 403 to an envelope with the privilege hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        403,
        "Principal user (Id=00000000-0000-0000-0000-000000000001, type=8) is missing prvReadflowrun privilege",
      ),
    );
    const result = (await explainFlowFailure(
      client,
      parseInput({ flowId: FLOW_ID }),
    )) as ResultShape;

    expect(result.error).toContain("prvReadflowrun");
    expect(result.hint).toContain("read privilege");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps any other error via toErrorEnvelope without letting it escape", async () => {
    const { client } = throwingClient(new Error("socket hang up"));
    const result = (await explainFlowFailure(
      client,
      parseInput({ runName: RUN_NAME }),
    )) as ResultShape;
    expect(result).toEqual({ error: "socket hang up" });
  });
});
