import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFlowConnections,
  checkFlowConnectionsTool,
} from "../src/tools/checkFlowConnections.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface Subject {
  type: string;
  id: string;
  name: string;
  logicalName?: string;
  owner: string;
}

interface Finding {
  severity: string;
  kind: string;
  subject: Subject;
  issue: string;
  recommendation: string;
  affectedFlows?: Array<{ id: string; name: string }>;
}

interface AuditResult {
  connectionReferences: number;
  flowsScanned: number;
  flowsTruncated?: boolean;
  findings: Finding[];
  summary: {
    unbound: number;
    ownerDisabled: number;
    ownerMismatch: number;
    unused: number;
  };
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("check_flow_connections pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await checkFlowConnectionsTool.handler({ top: 200 })) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("check_flow_connections");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    vi.stubEnv("CLIENT_ID", "app-id");
    vi.stubEnv("CLIENT_SECRET", "app-secret");
    vi.stubEnv("TENANT_ID", "tenant-id");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network disabled in test"));
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await checkFlowConnectionsTool.handler({ top: 200 })) as Envelope & {
      upgradeRequired?: boolean;
    };

    // Past the gate: the tool attempted a (blocked) Dataverse call and wrapped
    // the failure in an error envelope instead of an upgrade message.
    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("network disabled in test");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("checkFlowConnections happy path", () => {
  it("detects all four finding types, sorted high to low, with affected flows", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("flowConnections.refs.happy.json"))
      .mockResolvedValueOnce(loadFixture("flowConnections.flows.happy.json"))
      .mockResolvedValueOnce(loadFixture("flowConnections.users.happy.json"));

    const result = (await checkFlowConnections(client, { top: 200 })) as AuditResult;

    expect(get).toHaveBeenCalledTimes(3);
    const [refsPath, refsQuery] = callArgs(get, 0);
    expect(refsPath).toBe("connectionreferences");
    expect(refsQuery.select).toEqual([
      "connectionreferenceid",
      "connectionreferencedisplayname",
      "connectionreferencelogicalname",
      "connectorid",
      "connectionid",
      "statecode",
      "_ownerid_value",
      "modifiedon",
    ]);
    expect(refsQuery.top).toBe(500);

    const [flowsPath, flowsQuery] = callArgs(get, 1);
    expect(flowsPath).toBe("workflows");
    expect(flowsQuery.select).toEqual([
      "workflowid",
      "name",
      "clientdata",
      "_ownerid_value",
    ]);
    expect(flowsQuery.filter).toBe("category eq 5 and type eq 1 and statecode eq 1");
    expect(flowsQuery.top).toBe(200);

    const [usersPath, usersQuery] = callArgs(get, 2);
    expect(usersPath).toBe("systemusers");
    expect(usersQuery.select).toEqual(["systemuserid", "fullname", "isdisabled"]);
    expect(usersQuery.filter).toBe(
      "(systemuserid eq 11111111-0000-0000-0000-000000000001 or " +
        "systemuserid eq 11111111-0000-0000-0000-000000000002 or " +
        "systemuserid eq 11111111-0000-0000-0000-000000000003)",
    );

    expect(result.connectionReferences).toBe(2);
    expect(result.flowsScanned).toBe(2);
    expect(result.flowsTruncated).toBeUndefined();
    expect(result.findings).toHaveLength(4);
    expect(result.findings.map((f) => f.severity)).toEqual([
      "high",
      "medium",
      "medium",
      "low",
    ]);
    expect(result.findings.map((f) => f.kind)).toEqual([
      "unbound-connection-reference",
      "owner-mismatch",
      "owner-disabled",
      "unused-connection-reference",
    ]);

    const [unbound, mismatch, disabled, unused] = result.findings as [
      Finding,
      Finding,
      Finding,
      Finding,
    ];

    // 1. Unbound reference used by two active flows.
    expect(unbound.subject.type).toBe("connectionReference");
    expect(unbound.subject.id).toBe("aaaaaaaa-0000-0000-0000-000000000001");
    expect(unbound.subject.logicalName).toBe("contoso_sharedcommondataservice_1a2b3");
    expect(unbound.subject.owner).toBe("Ana Silva");
    expect(unbound.issue).toContain("no connection bound");
    expect(unbound.recommendation).toContain("Bind the connection reference");
    expect(unbound.affectedFlows).toEqual([
      { id: "bbbbbbbb-0000-0000-0000-000000000001", name: "Notify sales team" },
      { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "Escalate overdue cases" },
    ]);

    // 2. Owner mismatch: ref owned by Ana, "Escalate overdue cases" owned by Carla.
    expect(mismatch.subject.id).toBe("aaaaaaaa-0000-0000-0000-000000000001");
    expect(mismatch.issue).toContain("owned by someone else");
    expect(mismatch.recommendation).toContain("service-account");
    expect(mismatch.affectedFlows).toEqual([
      { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "Escalate overdue cases" },
    ]);

    // 3. Reference owned by a disabled user.
    expect(disabled.subject.id).toBe("aaaaaaaa-0000-0000-0000-000000000002");
    expect(disabled.subject.owner).toBe("Bruno Costa");
    expect(disabled.issue).toContain("disabled user");
    expect(disabled.recommendation).toContain("Reassign");

    // 4. Bound reference used by no scanned flow.
    expect(unused.subject.id).toBe("aaaaaaaa-0000-0000-0000-000000000002");
    expect(unused.issue).toContain("not used by any of the 2 scanned");
    expect(unused.issue).not.toContain("capped");

    expect(result.summary).toEqual({
      unbound: 1,
      ownerDisabled: 1,
      ownerMismatch: 1,
      unused: 1,
    });
  });
});

describe("checkFlowConnections owner resolution", () => {
  it("chunks systemusers lookups into or-chains of 25 ids", async () => {
    const { client, get } = makeFakeClient();
    const refs = Array.from({ length: 30 }, (_, i) => ({
      connectionreferenceid: `aaaaaaaa-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
      connectionreferencedisplayname: `Ref ${i + 1}`,
      connectionreferencelogicalname: `contoso_ref_${i + 1}`,
      connectionid: "cccccccc-0000-0000-0000-000000000001",
      _ownerid_value: `dddddddd-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    }));
    get
      .mockResolvedValueOnce({ value: refs })
      .mockResolvedValueOnce({ value: [] }) // no flows
      .mockResolvedValueOnce({ value: [] }) // users chunk 1
      .mockResolvedValueOnce({ value: [] }); // users chunk 2

    const result = (await checkFlowConnections(client, { top: 200 })) as AuditResult;

    expect(get).toHaveBeenCalledTimes(4);
    const chunk1 = callArgs(get, 2);
    const chunk2 = callArgs(get, 3);
    expect(chunk1[0]).toBe("systemusers");
    expect(chunk2[0]).toBe("systemusers");
    const countIds = (filter: string | undefined): number =>
      (filter?.match(/systemuserid eq /g) ?? []).length;
    expect(countIds(chunk1[1].filter)).toBe(25);
    expect(countIds(chunk2[1].filter)).toBe(5);
    expect(chunk1[1].filter).toContain(
      "systemuserid eq dddddddd-0000-0000-0000-000000000001",
    );
    expect(chunk2[1].filter).toContain(
      "systemuserid eq dddddddd-0000-0000-0000-000000000030",
    );

    // All 30 refs are bound and unused; unresolved owners cause no owner findings.
    expect(result.summary).toEqual({
      unbound: 0,
      ownerDisabled: 0,
      ownerMismatch: 0,
      unused: 30,
    });
    expect(result.findings.every((f) => f.severity === "low")).toBe(true);
  });

  it("tolerates team-owned refs: unresolved owner ids get the fallback label", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce({
        value: [
          {
            connectionreferenceid: "aaaaaaaa-0000-0000-0000-000000000009",
            connectionreferencedisplayname: "SharePoint (team-owned)",
            connectionreferencelogicalname: "contoso_sharepoint_team1",
            connectionid: null,
            _ownerid_value: "99999999-0000-0000-0000-000000000001", // a team id
          },
        ],
      })
      .mockResolvedValueOnce({
        value: [
          {
            workflowid: "bbbbbbbb-0000-0000-0000-000000000009",
            name: "Archive documents",
            clientdata: '{"connectionReferenceLogicalName":"contoso_sharepoint_team1"}',
            _ownerid_value: "11111111-0000-0000-0000-000000000001",
          },
        ],
      })
      // Only the flow owner resolves; the team id is absent from systemusers.
      .mockResolvedValueOnce({
        value: [
          {
            systemuserid: "11111111-0000-0000-0000-000000000001",
            fullname: "Ana Silva",
            isdisabled: false,
          },
        ],
      });

    const result = (await checkFlowConnections(client, { top: 200 })) as AuditResult;

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0] as Finding;
    expect(finding.kind).toBe("unbound-connection-reference");
    expect(finding.subject.owner).toBe("team or unknown");
    // Mismatch is skipped when the ref owner cannot be resolved.
    expect(result.summary.ownerMismatch).toBe(0);
    expect(result.summary.ownerDisabled).toBe(0);
  });
});

describe("checkFlowConnections empty and truncated scans", () => {
  it("returns a hint and makes no further requests when there are no refs", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("flowConnections.refs.empty.json"));

    const result = (await checkFlowConnections(client, { top: 200 })) as AuditResult;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.connectionReferences).toBe(0);
    expect(result.flowsScanned).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.summary).toEqual({
      unbound: 0,
      ownerDisabled: 0,
      ownerMismatch: 0,
      unused: 0,
    });
    expect(result.hint).toContain("No connection references found");
    expect(result.hint).toContain("directly-bound connections");
  });

  it("sets flowsTruncated and notes the scan cap on unused findings", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce({
        value: [
          {
            connectionreferenceid: "aaaaaaaa-0000-0000-0000-000000000007",
            connectionreferencedisplayname: "SQL Server (legacy)",
            connectionreferencelogicalname: "contoso_sql_legacy1",
            connectionid: "cccccccc-0000-0000-0000-000000000007",
            _ownerid_value: null,
          },
        ],
      })
      // Exactly `top` flows returned, none using the ref.
      .mockResolvedValueOnce({
        value: [
          { workflowid: "bbbbbbbb-0000-0000-0000-000000000011", name: "Flow A", clientdata: "{}", _ownerid_value: null },
          { workflowid: "bbbbbbbb-0000-0000-0000-000000000012", name: "Flow B", clientdata: "{}", _ownerid_value: null },
        ],
      });

    const result = (await checkFlowConnections(client, { top: 2 })) as AuditResult;

    // No owner ids anywhere, so no systemusers request is made.
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.flowsScanned).toBe(2);
    expect(result.flowsTruncated).toBe(true);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0] as Finding;
    expect(finding.kind).toBe("unused-connection-reference");
    expect(finding.issue).toContain("Scan capped at 2 flows");
    expect(result.summary.unused).toBe(1);
  });
});

describe("checkFlowConnections input schema", () => {
  it("applies the default top and rejects out-of-bounds values", () => {
    expect(checkFlowConnectionsTool.inputSchema.parse({})).toEqual({ top: 200 });
    expect(checkFlowConnectionsTool.inputSchema.safeParse({ top: 501 }).success).toBe(
      false,
    );
    expect(checkFlowConnectionsTool.inputSchema.safeParse({ top: 0 }).success).toBe(
      false,
    );
    expect(checkFlowConnectionsTool.inputSchema.safeParse({ top: 2.5 }).success).toBe(
      false,
    );
  });
});

describe("checkFlowConnections failure modes", () => {
  it("maps entity-not-found to a solution-aware hint with docsUrl", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "flowConnections.error404.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await checkFlowConnections(client, { top: 200 })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("solution-aware");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 403 to an envelope with a privilege hint and docsUrl", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "flowConnections.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await checkFlowConnections(client, { top: 200 })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("read privilege");
    expect(result.hint).toContain("connectionreference");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await checkFlowConnections(client, { top: 200 })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
