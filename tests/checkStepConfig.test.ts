import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeStepConfig,
  checkStepConfig,
} from "../src/tools/checkStepConfig.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface StepSummary {
  id: string;
  name: string;
  pluginType: string;
  message: string;
  entity: string;
  stage: string;
  mode: string;
  rank: number;
  filteringAttributes: string | null;
}

interface Finding {
  severity: string;
  step: StepSummary;
  issue: string;
  recommendation: string;
}

interface AnalysisResult {
  stepsAnalyzed: number;
  findings: Finding[];
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

type QueryArg = { select?: string[]; filter?: string; expand?: string };

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

describe("check_step_config pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await checkStepConfig.handler({})) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("check_step_config");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // No scope input: reaches the core function's input guard, not the gate.
    const result = (await checkStepConfig.handler({})) as Envelope & {
      upgradeRequired?: boolean;
    };

    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("Provide pluginTypeName or solutionName");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("analyzeStepConfig input guard", () => {
  it("returns an error envelope and makes no request when both inputs are missing", async () => {
    const { client, get } = makeFakeClient();

    const result = (await analyzeStepConfig(client, {})) as Envelope;

    expect(result.error).toBe("Provide pluginTypeName or solutionName");
    expect(result.hint).toBeDefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("analyzeStepConfig by pluginTypeName", () => {
  it("detects all four finding types, sorted high to low", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("stepConfig.pluginTypes.json"))
      .mockResolvedValueOnce(loadFixture("stepConfig.steps.happy.json"));

    const result = (await analyzeStepConfig(client, {
      pluginTypeName: "Contoso.Plugins.AccountPlugin",
    })) as AnalysisResult;

    // Queries: exact typename match, then one steps request.
    expect(get).toHaveBeenCalledTimes(2);
    const [typesPath, typesQuery] = callArgs(get, 0);
    expect(typesPath).toBe("plugintypes");
    expect(typesQuery.select).toEqual(["plugintypeid", "typename"]);
    expect(typesQuery.filter).toBe("typename eq 'Contoso.Plugins.AccountPlugin'");

    const [stepsPath, stepsQuery] = callArgs(get, 1);
    expect(stepsPath).toBe("sdkmessageprocessingsteps");
    expect(stepsQuery.filter).toContain("statecode eq 0 and ");
    expect(stepsQuery.filter).toContain(
      "_plugintypeid_value eq 11111111-1111-1111-1111-111111111111",
    );
    expect(stepsQuery.expand).toContain("sdkmessageid($select=name)");
    expect(stepsQuery.expand).toContain(
      "sdkmessageprocessingstepid_sdkmessageprocessingstepimage",
    );

    // 6 active steps analyzed, 4 findings (the well-configured step is clean).
    expect(result.stepsAnalyzed).toBe(6);
    expect(result.findings).toHaveLength(4);
    expect(result.findings.map((f) => f.severity)).toEqual([
      "high",
      "medium",
      "medium",
      "low",
    ]);

    const [high, mediumVolume, mediumRank, low] = result.findings as [
      Finding,
      Finding,
      Finding,
      Finding,
    ];

    // 1. Update without filtering attributes.
    expect(high.issue).toContain("without filtering attributes");
    expect(high.step.message).toBe("Update");
    expect(high.step.entity).toBe("account");
    expect(high.step.stage).toBe("PostOperation");
    expect(high.step.mode).toBe("sync");
    expect(high.step.filteringAttributes).toBeNull();
    expect(high.recommendation).toContain("filtering attributes");

    // 2. Sync Create on a high-volume entity.
    expect(mediumVolume.issue).toContain("high-volume");
    expect(mediumVolume.step.message).toBe("Create");
    expect(mediumVolume.step.entity).toBe("annotation");
    expect(mediumVolume.step.stage).toBe("PreOperation");
    expect(mediumVolume.step.mode).toBe("sync");

    // 4. Rank collision naming both colliding steps.
    expect(mediumRank.issue).toContain("Rank collision");
    expect(mediumRank.issue).toContain("(rank 10, A)");
    expect(mediumRank.issue).toContain("(rank 10, B)");
    expect(mediumRank.step.rank).toBe(10);
    expect(mediumRank.recommendation).toContain("distinct ranks");

    // 3. Delete without a pre-image; entity falls back to "none".
    expect(low.issue).toContain("no pre-image");
    expect(low.step.message).toBe("Delete");
    expect(low.step.entity).toBe("none");
    expect(low.step.stage).toBe("PreValidation");
    expect(low.recommendation).toContain("PreImage");
  });

  it("falls back to contains() with escaped quotes and reports no match", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce({ value: [] });

    const result = (await analyzeStepConfig(client, {
      pluginTypeName: "O'Brien",
    })) as AnalysisResult;

    expect(get).toHaveBeenCalledTimes(2);
    expect(callArgs(get, 0)[1].filter).toBe("typename eq 'O''Brien'");
    expect(callArgs(get, 1)[1].filter).toBe("contains(typename,'O''Brien')");
    expect(result.stepsAnalyzed).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.hint).toContain("No plug-in type matching");
  });

  it("groups a rank collision into exactly one medium finding naming both steps", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("stepConfig.pluginTypes.json"))
      .mockResolvedValueOnce(loadFixture("stepConfig.steps.rankCollision.json"));

    const result = (await analyzeStepConfig(client, {
      pluginTypeName: "Contoso.Plugins.ContactPlugin",
    })) as AnalysisResult;

    expect(result.stepsAnalyzed).toBe(2);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0] as Finding;
    expect(finding.severity).toBe("medium");
    expect(finding.issue).toContain("Rank collision");
    expect(finding.issue).toContain(
      "Contoso.Plugins.ContactPlugin: Update of contact (first)",
    );
    expect(finding.issue).toContain(
      "Contoso.Plugins.ContactPlugin: Update of contact (second)",
    );
    expect([
      "bbbbbbbb-0000-0000-0000-000000000001",
      "bbbbbbbb-0000-0000-0000-000000000002",
    ]).toContain(finding.step.id);
  });
});

describe("analyzeStepConfig by solutionName", () => {
  it("resolves solution, components (type 92) and steps in chunks of 25 ids", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("stepConfig.solutions.json"))
      .mockResolvedValueOnce(loadFixture("stepConfig.solutionComponents.json"))
      .mockResolvedValueOnce(loadFixture("stepConfig.steps.solution.json"))
      .mockResolvedValueOnce({ value: [] });

    const result = (await analyzeStepConfig(client, {
      solutionName: "ContosoCore",
    })) as AnalysisResult;

    expect(get).toHaveBeenCalledTimes(4);

    const [solutionsPath, solutionsQuery] = callArgs(get, 0);
    expect(solutionsPath).toBe("solutions");
    expect(solutionsQuery.select).toEqual(["solutionid"]);
    expect(solutionsQuery.filter).toBe("uniquename eq 'ContosoCore'");

    const [componentsPath, componentsQuery] = callArgs(get, 1);
    expect(componentsPath).toBe("solutioncomponents");
    expect(componentsQuery.select).toEqual(["objectid"]);
    expect(componentsQuery.filter).toBe(
      "_solutionid_value eq 55555555-5555-5555-5555-555555555555 and componenttype eq 92",
    );

    // 27 component ids -> chunks of 25 + 2, both scoped to active steps.
    const chunk1 = callArgs(get, 2);
    const chunk2 = callArgs(get, 3);
    expect(chunk1[0]).toBe("sdkmessageprocessingsteps");
    expect(chunk2[0]).toBe("sdkmessageprocessingsteps");
    const countIds = (filter: string | undefined): number =>
      (filter?.match(/sdkmessageprocessingstepid eq /g) ?? []).length;
    expect(countIds(chunk1[1].filter)).toBe(25);
    expect(countIds(chunk2[1].filter)).toBe(2);
    expect(chunk1[1].filter).toContain("statecode eq 0 and ");
    expect(chunk1[1].filter).toContain(
      "sdkmessageprocessingstepid eq cccccccc-0000-0000-0000-000000000001",
    );
    expect(chunk2[1].filter).toContain(
      "sdkmessageprocessingstepid eq cccccccc-0000-0000-0000-000000000026",
    );
    expect(chunk2[1].filter).toContain(
      "sdkmessageprocessingstepid eq cccccccc-0000-0000-0000-000000000027",
    );

    // Results from all chunks are concatenated; both fixture steps are clean.
    expect(result.stepsAnalyzed).toBe(2);
    expect(result.findings).toEqual([]);
  });

  it("returns an error envelope for an unknown solution unique name", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: [] });

    const result = (await analyzeStepConfig(client, {
      solutionName: "does_not_exist",
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("Solution not found");
    expect(result.hint).toContain("unique name");
  });

  it("returns an empty analysis with a hint when the solution has no steps", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("stepConfig.solutions.json"))
      .mockResolvedValueOnce({ value: [] });

    const result = (await analyzeStepConfig(client, {
      solutionName: "ContosoCore",
    })) as AnalysisResult;

    expect(get).toHaveBeenCalledTimes(2);
    expect(result.stepsAnalyzed).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.hint).toContain("no plug-in steps");
  });
});

describe("analyzeStepConfig failure modes", () => {
  it("maps a 403 to an envelope with a privilege hint and docsUrl", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "stepConfig.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await analyzeStepConfig(client, {
      pluginTypeName: "Contoso.Plugins.AccountPlugin",
    })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("SdkMessageProcessingStep");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await analyzeStepConfig(client, {
      solutionName: "ContosoCore",
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
