import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modernizationReport,
  modernizationReportTool,
} from "../src/tools/modernizationReport.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/replace-workflows-with-flows";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface RawProcess {
  workflowid: string;
  name?: string;
  statecode: number;
  mode?: number;
  primaryentity?: string;
  modifiedon?: string;
}

interface ProcessItem {
  id: string;
  name: string;
  primaryEntity: string | null;
  mode?: string;
  lastModified: string | null;
}

interface Finding {
  severity: string;
  flag: string;
  issue: string;
  recommendation: string;
  evidence: Record<string, number>;
}

interface Report {
  categories: {
    classicWorkflows: {
      total: number;
      active: number;
      syncActive: number;
      asyncActive: number;
      items: ProcessItem[];
    };
    dialogs: { total: number; active: number; items: ProcessItem[] };
    businessRules: { total: number; active: number; items: ProcessItem[] };
    businessProcessFlows: { total: number; active: number };
  };
  findings: Finding[];
  sectionNotes?: string[];
  truncationNotes?: string[];
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

function makeClassicDrafts(count: number): RawProcess[] {
  return Array.from({ length: count }, (_, i) => ({
    workflowid: `aaaa0000-0000-0000-0000-1000000000${String(i).padStart(2, "0")}`,
    name: `Draft workflow ${i + 1}`,
    statecode: 0,
    mode: 0,
    primaryentity: "account",
    modifiedon: "2023-01-01T00:00:00Z",
  }));
}

const EMPTY = { value: [] };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("modernization_report enterprise gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await modernizationReportTool.handler({ top: 25 })) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("modernization_report");
    expect(result.message).toContain("Enterprise");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not unlock for a Pro-tier license (Enterprise required)", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("LICENSE_TIER", "pro");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await modernizationReportTool.handler({ top: 25 })) as {
      upgradeRequired?: boolean;
      requiredTier?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.requiredTier).toBe("enterprise");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate to Dataverse when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("LICENSE_TIER", "enterprise");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    vi.stubEnv("CLIENT_ID", "client-id");
    vi.stubEnv("CLIENT_SECRET", "client-secret");
    vi.stubEnv("TENANT_ID", "tenant-id");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await modernizationReportTool.handler({ top: 25 })) as Envelope & {
      upgradeRequired?: boolean;
    };

    // The gate was passed: the tool attempted a token request and degraded
    // the network failure into an error envelope instead of throwing.
    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("network down");
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("modernization_report input schema", () => {
  it("applies the default and enforces bounds and integrality", () => {
    const schema = modernizationReportTool.inputSchema;
    expect(schema.parse({})).toEqual({ top: 25 });
    expect(schema.parse({ top: 5 })).toEqual({ top: 5 });
    expect(schema.parse({ top: 100 })).toEqual({ top: 100 });
    expect(() => schema.parse({ top: 4 })).toThrow();
    expect(() => schema.parse({ top: 101 })).toThrow();
    expect(() => schema.parse({ top: 10.5 })).toThrow();
  });
});

describe("modernizationReport happy path", () => {
  it("queries the four categories, counts, labels modes and orders findings", async () => {
    const { client, get } = makeFakeClient();
    const classicFixture = loadFixture<{ value: RawProcess[] }>(
      "modernization.classic.json",
    );
    get
      .mockResolvedValueOnce({
        value: [...classicFixture.value, ...makeClassicDrafts(11)],
      })
      .mockResolvedValueOnce(loadFixture("modernization.dialogs.json"))
      .mockResolvedValueOnce(loadFixture("modernization.businessRules.json"))
      .mockResolvedValueOnce(loadFixture("modernization.bpfs.json"));

    const result = (await modernizationReport(client, { top: 25 })) as Report;

    // One workflows query per category with the documented filters.
    expect(get).toHaveBeenCalledTimes(4);
    const [classicPath, classicQuery] = callArgs(get, 0);
    expect(classicPath).toBe("workflows");
    expect(classicQuery.filter).toBe("category eq 0 and type eq 1");
    expect(classicQuery.select).toEqual([
      "workflowid",
      "name",
      "statecode",
      "mode",
      "primaryentity",
      "modifiedon",
    ]);
    expect(classicQuery.top).toBe(500);

    const [dialogsPath, dialogsQuery] = callArgs(get, 1);
    expect(dialogsPath).toBe("workflows");
    expect(dialogsQuery.filter).toBe("category eq 1 and type eq 1");
    expect(dialogsQuery.select).toEqual([
      "workflowid",
      "name",
      "statecode",
      "primaryentity",
      "modifiedon",
    ]);
    expect(dialogsQuery.top).toBe(500);

    const [rulesPath, rulesQuery] = callArgs(get, 2);
    expect(rulesPath).toBe("workflows");
    expect(rulesQuery.filter).toBe("category eq 2 and type eq 1");

    const [bpfPath, bpfQuery] = callArgs(get, 3);
    expect(bpfPath).toBe("workflows");
    expect(bpfQuery.filter).toBe("category eq 4 and type eq 1");

    // Counts per category.
    const { classicWorkflows, dialogs, businessRules, businessProcessFlows } =
      result.categories;
    expect(classicWorkflows.total).toBe(14);
    expect(classicWorkflows.active).toBe(3);
    expect(classicWorkflows.syncActive).toBe(1);
    expect(classicWorkflows.asyncActive).toBe(2);
    expect(dialogs.total).toBe(2);
    expect(dialogs.active).toBe(1);
    expect(businessRules.total).toBe(30);
    expect(businessRules.active).toBe(30);
    expect(businessProcessFlows.total).toBe(2);
    expect(businessProcessFlows.active).toBe(2);

    // Classic items: active only, sorted by modifiedon desc, mode labeled.
    expect(classicWorkflows.items.map((i) => i.name)).toEqual([
      "Sync account owner (real-time)",
      "Escalate overdue cases",
      "Send welcome email",
    ]);
    expect(classicWorkflows.items.map((i) => i.mode)).toEqual([
      "real-time (sync)",
      "background (async)",
      "background (async)",
    ]);
    expect(classicWorkflows.items[0]).toEqual({
      id: "aaaa0000-0000-0000-0000-000000000002",
      name: "Sync account owner (real-time)",
      primaryEntity: "account",
      mode: "real-time (sync)",
      lastModified: "2026-06-01T12:00:00Z",
    });

    // Dialog items exclude the draft and carry no mode field.
    expect(dialogs.items).toHaveLength(1);
    const dialogItem = dialogs.items[0] as ProcessItem;
    expect(dialogItem.name).toBe("Case triage dialog");
    expect("mode" in dialogItem).toBe(false);

    // 30 active business rules are capped at top (25), newest first.
    expect(businessRules.items).toHaveLength(25);
    expect((businessRules.items[0] as ProcessItem).name).toBe("Business rule 30");
    expect((businessRules.items[24] as ProcessItem).name).toBe("Business rule 06");

    // Findings ordered high → low with the expected flags and evidence.
    expect(result.findings.map((f) => f.flag)).toEqual([
      "active-dialogs",
      "active-classic-workflows",
      "classic-workflow-drafts",
      "business-rules-inventory",
    ]);
    expect(result.findings.map((f) => f.severity)).toEqual([
      "high",
      "medium",
      "low",
      "low",
    ]);
    const [high, medium, drafts, rules] = result.findings as [
      Finding,
      Finding,
      Finding,
      Finding,
    ];
    expect(high.issue).toContain("removed");
    expect(high.evidence).toEqual({ activeDialogs: 1 });
    expect(medium.evidence).toEqual({
      activeClassicWorkflows: 3,
      syncActive: 1,
      asyncActive: 2,
    });
    expect(medium.recommendation).toContain("cloud flows");
    expect(drafts.evidence).toEqual({ draftClassicWorkflows: 11 });
    expect(rules.evidence).toEqual({ activeBusinessRules: 30 });

    expect(result.sectionNotes).toBeUndefined();
    expect(result.truncationNotes).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it("returns the modern hint when every category is empty", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("modernization.empty.json"))
      .mockResolvedValueOnce(loadFixture("modernization.empty.json"))
      .mockResolvedValueOnce(loadFixture("modernization.empty.json"))
      .mockResolvedValueOnce(loadFixture("modernization.empty.json"));

    const result = (await modernizationReport(client, { top: 25 })) as Report;

    expect(get).toHaveBeenCalledTimes(4);
    expect(result.categories.classicWorkflows).toEqual({
      total: 0,
      active: 0,
      syncActive: 0,
      asyncActive: 0,
      items: [],
    });
    expect(result.categories.dialogs).toEqual({ total: 0, active: 0, items: [] });
    expect(result.categories.businessRules).toEqual({
      total: 0,
      active: 0,
      items: [],
    });
    expect(result.categories.businessProcessFlows).toEqual({ total: 0, active: 0 });
    expect(result.findings).toEqual([]);
    expect(result.hint).toBe(
      "No legacy automation found — this environment is already modern.",
    );
  });

  it("adds a truncation note when a category hits the 500-row cap", async () => {
    const { client, get } = makeFakeClient();
    const rows: RawProcess[] = Array.from({ length: 500 }, (_, i) => ({
      workflowid: `aaaa0000-0000-0000-0000-2${String(i).padStart(11, "0")}`,
      name: `Workflow ${i}`,
      statecode: 0,
      mode: 0,
      primaryentity: "account",
      modifiedon: "2024-01-01T00:00:00Z",
    }));
    get
      .mockResolvedValueOnce({ value: rows })
      .mockResolvedValueOnce(EMPTY)
      .mockResolvedValueOnce(EMPTY)
      .mockResolvedValueOnce(EMPTY);

    const result = (await modernizationReport(client, { top: 25 })) as Report;

    expect(result.categories.classicWorkflows.total).toBe(500);
    expect(result.categories.classicWorkflows.active).toBe(0);
    expect(result.truncationNotes).toEqual([
      "classicWorkflows: only the first 500 rows were scanned; totals may undercount.",
    ]);
    // 500 drafts trip the cleanup finding; nothing is active.
    expect(result.findings.map((f) => f.flag)).toEqual(["classic-workflow-drafts"]);
    expect(result.hint).toBeUndefined();
  });
});

describe("modernizationReport failure isolation", () => {
  it("degrades a failed dialogs query to a sectionNote and keeps other categories", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("modernization.classic.json"))
      .mockRejectedValueOnce(new Error("dialogs exploded"))
      .mockResolvedValueOnce(loadFixture("modernization.businessRules.json"))
      .mockResolvedValueOnce(loadFixture("modernization.bpfs.json"));

    const result = (await modernizationReport(client, { top: 25 })) as Report;

    expect(get).toHaveBeenCalledTimes(4);
    expect(result.sectionNotes).toEqual([
      "dialogs: query failed — dialogs exploded",
    ]);
    expect(result.categories.dialogs).toEqual({ total: 0, active: 0, items: [] });
    expect(result.categories.classicWorkflows.active).toBe(3);
    expect(result.categories.businessRules.active).toBe(30);
    expect(result.categories.businessProcessFlows.total).toBe(2);
    // Findings from the surviving categories are still produced; no dialog finding.
    expect(result.findings.map((f) => f.flag)).toEqual([
      "active-classic-workflows",
      "business-rules-inventory",
    ]);
    expect(result.hint).toBeUndefined();
  });

  it("maps a 403 on the first query to an envelope with a privilege hint", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "modernization.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new DataverseHttpError(fixture.status, fixture.message));

    const result = (await modernizationReport(client, { top: 25 })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("read privilege on the Process (workflow) table");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps an unexpected error on the first query in a generic envelope", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await modernizationReport(client, { top: 25 })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
