import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  whatRunsOnTable,
  whatRunsOnTableTool,
} from "../src/tools/whatRunsOnTable.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface PluginStepInfo {
  id: string;
  name: string;
  pluginType: string;
  message: string;
  stage: string;
  mode: string;
  rank: number;
  filteringAttributes: string | null;
}

interface CloudFlowInfo {
  id: string | null;
  name: string;
  uses: string[];
}

interface ProcessInfo {
  id: string | null;
  name: string;
}

interface MapResult {
  table: string;
  pluginSteps: PluginStepInfo[];
  cloudFlows: CloudFlowInfo[];
  classicWorkflows: ProcessInfo[];
  businessRules: ProcessInfo[];
  summary: {
    pluginSteps: number;
    cloudFlows: number;
    classicWorkflows: number;
    businessRules: number;
    total: number;
  };
  flowsScanTruncated?: boolean;
  sectionNotes?: string[];
  hint?: string;
}

interface Envelope {
  error: string;
  hint?: string;
  docsUrl?: string;
}

function makeFakeClient() {
  const get = vi.fn();
  return { client: { get } as unknown as Pick<DataverseClient, "get">, get };
}

type QueryArg = {
  select?: string[];
  filter?: string;
  expand?: string;
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("what_runs_on_table pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await whatRunsOnTableTool.handler({ table: "account" })) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("what_runs_on_table");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    vi.stubEnv("CLIENT_ID", "client-id");
    vi.stubEnv("CLIENT_SECRET", "client-secret");
    vi.stubEnv("TENANT_ID", "tenant-id");
    // Every network attempt fails, proving we got past the gate and into the
    // Dataverse call path, which degrades to an error envelope.
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network disabled in tests"));
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await whatRunsOnTableTool.handler({
      table: "account",
    })) as Envelope & { upgradeRequired?: boolean };

    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("network disabled in tests");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("what_runs_on_table input schema", () => {
  it("requires a non-empty table logical name", () => {
    expect(whatRunsOnTableTool.inputSchema.safeParse({}).success).toBe(false);
    expect(
      whatRunsOnTableTool.inputSchema.safeParse({ table: "" }).success,
    ).toBe(false);
    expect(
      whatRunsOnTableTool.inputSchema.safeParse({ table: "account" }).success,
    ).toBe(true);
  });

  it("trims and lowercases the table name before querying", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValue({ value: [] });

    const result = (await whatRunsOnTable(client, {
      table: "  Account ",
    })) as MapResult;

    expect(result.table).toBe("account");
    expect(callArgs(get, 0)[1].filter).toBe("primaryobjecttypecode eq 'account'");
    // Classic-workflow and business-rule scopes use the normalized name too.
    expect(callArgs(get, 2)[1].filter).toContain("primaryentity eq 'account'");
    expect(callArgs(get, 3)[1].filter).toContain("primaryentity eq 'account'");
  });
});

describe("whatRunsOnTable happy path", () => {
  it("maps plug-in steps, cloud flows, classic workflows and business rules", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("whatRunsOn.messageFilters.json"))
      .mockResolvedValueOnce(loadFixture("whatRunsOn.steps.json"))
      .mockResolvedValueOnce(loadFixture("whatRunsOn.flows.json"))
      .mockResolvedValueOnce(loadFixture("whatRunsOn.classicWorkflows.json"))
      .mockResolvedValueOnce(loadFixture("whatRunsOn.businessRules.json"));

    const result = (await whatRunsOnTable(client, {
      table: "account",
    })) as MapResult;

    expect(get).toHaveBeenCalledTimes(5);

    // 1. Message filters for the table.
    const [filtersPath, filtersQuery] = callArgs(get, 0);
    expect(filtersPath).toBe("sdkmessagefilters");
    expect(filtersQuery.select).toEqual(["sdkmessagefilterid"]);
    expect(filtersQuery.filter).toBe("primaryobjecttypecode eq 'account'");
    expect(filtersQuery.top).toBe(200);

    // 2. Active steps scoped by an or-chain over both filter ids.
    const [stepsPath, stepsQuery] = callArgs(get, 1);
    expect(stepsPath).toBe("sdkmessageprocessingsteps");
    expect(stepsQuery.filter).toBe(
      "statecode eq 0 and (" +
        "_sdkmessagefilterid_value eq 11111111-0000-0000-0000-000000000001 or " +
        "_sdkmessagefilterid_value eq 11111111-0000-0000-0000-000000000002)",
    );
    expect(stepsQuery.expand).toContain("sdkmessageid($select=name)");
    expect(stepsQuery.expand).toContain("plugintypeid($select=typename)");

    // 3. Cloud-flow definitions (scanned client-side).
    const [flowsPath, flowsQuery] = callArgs(get, 2);
    expect(flowsPath).toBe("workflows");
    expect(flowsQuery.filter).toBe("category eq 5 and type eq 1 and statecode eq 1");
    expect(flowsQuery.select).toContain("clientdata");
    expect(flowsQuery.top).toBe(500);

    // 4 + 5. Classic workflows and business rules scoped by primaryentity.
    expect(callArgs(get, 3)[1].filter).toBe(
      "category eq 0 and type eq 1 and statecode eq 1 and primaryentity eq 'account'",
    );
    expect(callArgs(get, 4)[1].filter).toBe(
      "category eq 2 and type eq 1 and statecode eq 1 and primaryentity eq 'account'",
    );

    // Steps come back sorted by stage then rank.
    expect(result.pluginSteps.map((s) => s.id)).toEqual([
      "22222222-0000-0000-0000-000000000003",
      "22222222-0000-0000-0000-000000000002",
      "22222222-0000-0000-0000-000000000001",
    ]);
    const [first, second, third] = result.pluginSteps as [
      PluginStepInfo,
      PluginStepInfo,
      PluginStepInfo,
    ];
    expect(first.message).toBe("Create");
    expect(first.stage).toBe("PreOperation");
    expect(first.mode).toBe("sync");
    expect(first.rank).toBe(1);
    expect(first.filteringAttributes).toBeNull(); // empty string normalized
    expect(first.pluginType).toBe("Contoso.Plugins.AccountPlugin");
    expect(second.filteringAttributes).toBe("name,telephone1");
    expect(third.stage).toBe("PostOperation");
    expect(third.mode).toBe("async");

    // Cloud flows: trigger match, action match via plural, and an
    // unparseable definition flagged as "unknown"; the contact flow is out.
    expect(result.cloudFlows).toHaveLength(3);
    const flowByName = new Map(result.cloudFlows.map((f) => [f.name, f]));
    expect(flowByName.get("Notify team on new account")?.uses).toEqual(["trigger"]);
    expect(flowByName.get("Nightly account cleanup")?.uses).toEqual(["action"]);
    expect(
      flowByName.get("Legacy account flow (corrupt definition)")?.uses,
    ).toEqual(["unknown"]);
    expect(flowByName.has("Contact janitor")).toBe(false);

    expect(result.classicWorkflows).toEqual([
      { id: "33333333-0000-0000-0000-000000000001", name: "Account escalation" },
    ]);
    expect(result.businessRules).toEqual([
      { id: "44444444-0000-0000-0000-000000000001", name: "Require main phone" },
    ]);

    expect(result.summary).toEqual({
      pluginSteps: 3,
      cloudFlows: 3,
      classicWorkflows: 1,
      businessRules: 1,
      total: 8,
    });
    expect(result.flowsScanTruncated).toBeUndefined();
    expect(result.sectionNotes).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it("returns a logical-name hint when no automation exists at all", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValue({ value: [] });

    const result = (await whatRunsOnTable(client, {
      table: "widget",
    })) as MapResult;

    // No filter ids -> no steps query; four queries total.
    expect(get).toHaveBeenCalledTimes(4);
    expect(result.pluginSteps).toEqual([]);
    expect(result.cloudFlows).toEqual([]);
    expect(result.classicWorkflows).toEqual([]);
    expect(result.businessRules).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.hint).toContain("No active automation found on 'widget'");
    expect(result.hint).toContain("logical name");
  });

  it("flags truncation when the cloud-flow scan hits its cap", async () => {
    const { client, get } = makeFakeClient();
    const manyFlows = {
      value: Array.from({ length: 500 }, (_, i) => ({
        workflowid: `66666666-0000-0000-0000-${String(i).padStart(12, "0")}`,
        name: `Flow ${i}`,
        clientdata: "{}",
      })),
    };
    get
      .mockResolvedValueOnce({ value: [] }) // message filters
      .mockResolvedValueOnce(manyFlows) // cloud flows
      .mockResolvedValueOnce({ value: [] }) // classic workflows
      .mockResolvedValueOnce({ value: [] }); // business rules

    const result = (await whatRunsOnTable(client, {
      table: "account",
    })) as MapResult;

    expect(result.flowsScanTruncated).toBe(true);
    expect(result.cloudFlows).toEqual([]);
  });
});

describe("whatRunsOnTable section isolation", () => {
  it("keeps plug-in steps and records a note when the flow scan fails", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("whatRunsOn.messageFilters.json"))
      .mockResolvedValueOnce(loadFixture("whatRunsOn.steps.json"))
      .mockRejectedValueOnce(new DataverseHttpError(500, "Internal server error"))
      .mockResolvedValueOnce(loadFixture("whatRunsOn.classicWorkflows.json"))
      .mockResolvedValueOnce({ value: [] });

    const result = (await whatRunsOnTable(client, {
      table: "account",
    })) as MapResult;

    // The failing section degrades to a note; everything else still lands.
    expect(result.pluginSteps).toHaveLength(3);
    expect(result.cloudFlows).toEqual([]);
    expect(result.classicWorkflows).toHaveLength(1);
    expect(result.sectionNotes).toHaveLength(1);
    expect(result.sectionNotes?.[0]).toContain("Cloud flows");
    expect(result.sectionNotes?.[0]).toContain("Internal server error");
    expect(result.summary).toEqual({
      pluginSteps: 3,
      cloudFlows: 0,
      classicWorkflows: 1,
      businessRules: 0,
      total: 4,
    });
    expect(result.hint).toBeUndefined();
  });
});

describe("whatRunsOnTable failure modes", () => {
  it("maps a 403 on the first query to an envelope with a privilege hint", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "whatRunsOn.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new DataverseHttpError(fixture.status, fixture.message));

    const result = (await whatRunsOnTable(client, {
      table: "account",
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("SdkMessageProcessingStep");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 400 about primaryobjecttypecode to a check-the-logical-name hint", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(
        400,
        "Invalid property 'primaryobjecttypecode' value: 'not_a_table'.",
      ),
    );

    const result = (await whatRunsOnTable(client, {
      table: "not_a_table",
    })) as Envelope;

    expect(result.error).toContain("primaryobjecttypecode");
    expect(result.hint).toContain("logical name");
    expect(result.hint).toContain("'not_a_table'");
  });

  it("wraps unexpected errors on the first query in a generic envelope", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await whatRunsOnTable(client, {
      table: "account",
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
