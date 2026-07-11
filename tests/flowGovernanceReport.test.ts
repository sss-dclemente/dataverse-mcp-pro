import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flowGovernanceReport,
  flowGovernanceReportTool,
} from "../src/tools/flowGovernanceReport.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/overview-solution-flows";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface RawWorkflow {
  workflowid: string;
  name: string;
  statecode: number;
  statuscode: number;
  createdon: string;
  modifiedon: string;
  _ownerid_value: string | null;
  ismanaged: boolean;
}

interface Finding {
  severity: string;
  flow?: { id: string; name: string };
  owner?: string;
  issue: string;
  recommendation: string;
}

interface OwnerRow {
  owner: string;
  isDisabled?: boolean;
  flows: number;
  activated: number;
}

interface Report {
  totalFlows: number;
  activated: number;
  draft: number;
  suspended: number;
  managed: number;
  findings: Finding[];
  ownerTable: OwnerRow[];
  truncated?: boolean;
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

type QueryArg = { select?: string[]; filter?: string; top?: number };

function callArgs(
  mock: ReturnType<typeof vi.fn>,
  index: number,
): [string, QueryArg] {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`no call at index ${index}`);
  return call as unknown as [string, QueryArg];
}

const DEFAULT_INPUT = { staleDraftDays: 90, ownerConcentrationThreshold: 20 };

function makeFlow(overrides: Partial<RawWorkflow> & { workflowid: string }): RawWorkflow {
  return {
    name: `Flow ${overrides.workflowid}`,
    statecode: 1,
    statuscode: 2,
    createdon: "2026-01-01T00:00:00Z",
    modifiedon: "2026-06-01T00:00:00Z",
    _ownerid_value: null,
    ismanaged: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("flow_governance_report pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await flowGovernanceReportTool.handler(DEFAULT_INPUT)) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("flow_governance_report");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    vi.stubEnv("CLIENT_ID", "client-id");
    vi.stubEnv("CLIENT_SECRET", "client-secret");
    vi.stubEnv("TENANT_ID", "tenant-id");
    // The first outbound call (token acquisition) fails, proving the gate was
    // passed and the Dataverse pipeline was reached, without real network.
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await flowGovernanceReportTool.handler(DEFAULT_INPUT)) as Envelope & {
      upgradeRequired?: boolean;
    };

    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("network down");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("flow_governance_report input schema", () => {
  it("applies defaults and enforces bounds", () => {
    expect(flowGovernanceReportTool.inputSchema.parse({})).toEqual({
      staleDraftDays: 90,
      ownerConcentrationThreshold: 20,
    });
    expect(
      flowGovernanceReportTool.inputSchema.parse({
        staleDraftDays: 7,
        ownerConcentrationThreshold: 200,
      }),
    ).toEqual({ staleDraftDays: 7, ownerConcentrationThreshold: 200 });

    expect(() =>
      flowGovernanceReportTool.inputSchema.parse({ staleDraftDays: 6 }),
    ).toThrow();
    expect(() =>
      flowGovernanceReportTool.inputSchema.parse({ staleDraftDays: 366 }),
    ).toThrow();
    expect(() =>
      flowGovernanceReportTool.inputSchema.parse({ staleDraftDays: 90.5 }),
    ).toThrow();
    expect(() =>
      flowGovernanceReportTool.inputSchema.parse({ ownerConcentrationThreshold: 4 }),
    ).toThrow();
    expect(() =>
      flowGovernanceReportTool.inputSchema.parse({ ownerConcentrationThreshold: 201 }),
    ).toThrow();
  });
});

describe("flowGovernanceReport happy path", () => {
  it("produces all four finding types, sorted high to low", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));

    const workflows = loadFixture<{ value: RawWorkflow[] }>(
      "flowGovernance.workflows.happy.json",
    );
    // Owner-concentration: Bob Busy owns 20 activated flows, generated here.
    const busyOwnerId = "dddddddd-0000-0000-0000-000000000003";
    for (let i = 0; i < 20; i += 1) {
      workflows.value.push(
        makeFlow({
          workflowid: `aaaaaaaa-0000-0000-0000-${String(100 + i).padStart(12, "0")}`,
          _ownerid_value: busyOwnerId,
        }),
      );
    }

    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(workflows)
      .mockResolvedValueOnce(loadFixture("flowGovernance.systemusers.happy.json"));

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Report;

    expect(get).toHaveBeenCalledTimes(2);
    const [flowsPath, flowsQuery] = callArgs(get, 0);
    expect(flowsPath).toBe("workflows");
    expect(flowsQuery.select).toEqual([
      "workflowid",
      "name",
      "statecode",
      "statuscode",
      "createdon",
      "modifiedon",
      "_ownerid_value",
      "ismanaged",
    ]);
    expect(flowsQuery.filter).toBe("category eq 5 and type eq 1");
    expect(flowsQuery.top).toBe(1000);

    const [usersPath, usersQuery] = callArgs(get, 1);
    expect(usersPath).toBe("systemusers");
    expect(usersQuery.select).toEqual(["systemuserid", "fullname", "isdisabled"]);
    // 3 distinct owner ids -> a single or-chained lookup, GUIDs unquoted.
    expect(usersQuery.filter?.match(/systemuserid eq /g)).toHaveLength(3);
    expect(usersQuery.filter).toContain(
      "systemuserid eq dddddddd-0000-0000-0000-000000000001",
    );

    expect(result.totalFlows).toBe(23);
    expect(result.activated).toBe(21);
    expect(result.draft).toBe(1);
    expect(result.suspended).toBe(1);
    expect(result.managed).toBe(1);
    expect(result.truncated).toBeUndefined();

    expect(result.findings.map((f) => f.severity)).toEqual([
      "high",
      "medium",
      "low",
      "low",
    ]);
    const [high, medium, staleLow, concentrationLow] = result.findings as [
      Finding,
      Finding,
      Finding,
      Finding,
    ];

    // 1. Activated flow owned by a disabled user.
    expect(high.issue).toContain("disabled user");
    expect(high.flow).toEqual({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      name: "Send welcome email",
    });
    expect(high.owner).toBe("Dana Departed");
    expect(high.recommendation).toContain("Reassign");

    // 2. Suspended flow, exposing both raw codes.
    expect(medium.issue).toContain("suspended");
    expect(medium.issue).toContain("statecode 2");
    expect(medium.issue).toContain("statuscode 2");
    expect(medium.flow?.name).toBe("Sync invoices to ERP");
    expect(medium.recommendation).toContain("resume");

    // 3. Stale draft: modified 2026-03-23, 100 days before the fake "now".
    expect(staleLow.issue).toContain("Draft flow last modified");
    expect(staleLow.issue).toContain("90 days");
    expect(staleLow.flow?.name).toBe("Old approval prototype");

    // 4. Owner concentration at the default threshold of 20.
    expect(concentrationLow.owner).toBe("Bob Busy");
    expect(concentrationLow.issue).toContain("owns 20 of 23");
    expect(concentrationLow.flow).toBeUndefined();
    expect(concentrationLow.recommendation).toContain("service account");

    expect(result.ownerTable).toEqual([
      { owner: "Bob Busy", isDisabled: false, flows: 20, activated: 20 },
      { owner: "Ana Active", isDisabled: false, flows: 2, activated: 0 },
      { owner: "Dana Departed", isDisabled: true, flows: 1, activated: 1 },
    ]);
  });
});

describe("flowGovernanceReport state mapping", () => {
  it("maps statecode 0/1/2, falls back to statuscode, and passes unknown codes through", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));

    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("flowGovernance.workflows.states.json"));

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Report;

    // All owners are null -> no systemusers lookup at all.
    expect(get).toHaveBeenCalledTimes(1);

    expect(result.totalFlows).toBe(5);
    expect(result.activated).toBe(1);
    expect(result.draft).toBe(1);
    // statecode 2 plus the statuscode-fallback flow (statecode 7, statuscode 2).
    expect(result.suspended).toBe(2);
    expect(result.managed).toBe(1);

    const suspendedFindings = result.findings.filter((f) =>
      f.issue.includes("suspended"),
    );
    expect(suspendedFindings).toHaveLength(2);
    const fallback = suspendedFindings.find((f) =>
      f.flow?.name.includes("statuscode fallback"),
    );
    expect(fallback?.issue).toContain("statecode 7");
    expect(fallback?.issue).toContain("statuscode 2");

    // The unknown-state flow (statecode 9, statuscode 9) is counted in
    // totalFlows only and produces no finding.
    expect(result.findings).toHaveLength(2);

    // Ownerless flows are grouped as "team or unknown" without isDisabled.
    expect(result.ownerTable).toEqual([
      { owner: "team or unknown", flows: 5, activated: 1 },
    ]);
  });

  it("tolerates a team-owned flow: no disabled-owner finding, owner reported as unknown", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("flowGovernance.workflows.teamOwner.json"))
      .mockResolvedValueOnce({ value: [] });

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Report;

    expect(get).toHaveBeenCalledTimes(2);
    const [usersPath, usersQuery] = callArgs(get, 1);
    expect(usersPath).toBe("systemusers");
    expect(usersQuery.filter).toBe(
      "systemuserid eq eeeeeeee-0000-0000-0000-000000000099",
    );

    expect(result.totalFlows).toBe(1);
    expect(result.activated).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.ownerTable).toEqual([
      { owner: "team or unknown", flows: 1, activated: 1 },
    ]);
    const row = result.ownerTable[0] as OwnerRow;
    expect("isDisabled" in row).toBe(false);
  });
});

describe("flowGovernanceReport owner table", () => {
  it("chunks owner lookups by 25 and returns the table sorted by flows desc, capped at 25 rows", async () => {
    // 30 owners: owner k (0..9) owns 10-k flows, owners 10..29 own 1 each.
    const ownerId = (k: number): string =>
      `00000000-0000-0000-0000-${String(k).padStart(12, "0")}`;
    const flows: RawWorkflow[] = [];
    for (let k = 0; k < 30; k += 1) {
      const count = k < 10 ? 10 - k : 1;
      for (let j = 0; j < count; j += 1) {
        flows.push(
          makeFlow({
            workflowid: `ffffffff-0000-0000-${String(k).padStart(4, "0")}-${String(j).padStart(12, "0")}`,
            _ownerid_value: ownerId(k),
          }),
        );
      }
    }

    const { client, get } = makeFakeClient();
    get.mockImplementation(async (path: string, query?: QueryArg) => {
      if (path === "workflows") return { value: flows };
      const ids = [
        ...(query?.filter ?? "").matchAll(/systemuserid eq ([0-9a-f-]+)/g),
      ].map((m) => m[1] as string);
      return {
        value: ids.map((id) => ({
          systemuserid: id,
          fullname: `User ${Number(id.slice(-12))}`,
          isdisabled: false,
        })),
      };
    });

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Report;

    // 30 distinct owners -> chunks of 25 + 5.
    expect(get).toHaveBeenCalledTimes(3);
    const countIds = (filter: string | undefined): number =>
      (filter?.match(/systemuserid eq /g) ?? []).length;
    expect(callArgs(get, 1)[0]).toBe("systemusers");
    expect(countIds(callArgs(get, 1)[1].filter)).toBe(25);
    expect(countIds(callArgs(get, 2)[1].filter)).toBe(5);

    expect(result.totalFlows).toBe(75);
    // Nobody reaches the concentration threshold of 20.
    expect(result.findings).toEqual([]);

    expect(result.ownerTable).toHaveLength(25);
    expect(result.ownerTable[0]).toEqual({
      owner: "User 0",
      isDisabled: false,
      flows: 10,
      activated: 10,
    });
    const counts = result.ownerTable.map((row) => row.flows);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});

describe("flowGovernanceReport edge cases and failures", () => {
  it("returns zeroed counts and a hint when the org has no solution cloud flows", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: [] });

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Report;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.totalFlows).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.ownerTable).toEqual([]);
    expect(result.hint).toContain("No solution cloud flows found (category 5)");
  });

  it("flags truncation at the 1000-row page limit", async () => {
    const buildFlows = (n: number): RawWorkflow[] =>
      Array.from({ length: n }, (_, i) =>
        makeFlow({
          workflowid: `abababab-0000-0000-0000-${String(i).padStart(12, "0")}`,
        }),
      );

    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: buildFlows(1000) });
    const truncatedResult = (await flowGovernanceReport(
      client,
      DEFAULT_INPUT,
    )) as Report;
    expect(truncatedResult.totalFlows).toBe(1000);
    expect(truncatedResult.truncated).toBe(true);

    get.mockResolvedValueOnce({ value: buildFlows(999) });
    const fullResult = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Report;
    expect(fullResult.totalFlows).toBe(999);
    expect(fullResult.truncated).toBeUndefined();
  });

  it("maps a 403 to an envelope with a Process (workflow) privilege hint", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "flowGovernance.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("Process (workflow)");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await flowGovernanceReport(client, DEFAULT_INPUT)) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.hint).toBeUndefined();
    expect(result.docsUrl).toBeUndefined();
  });
});
