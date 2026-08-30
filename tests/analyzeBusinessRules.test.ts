import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeBusinessRules,
  analyzeBusinessRulesTool,
} from "../src/tools/analyzeBusinessRules.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-business-rules-recommendations-apply-logic-form";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface RuleInfo {
  id: string;
  name: string;
  state: string;
  scope: string;
  formId: string | null;
  isManaged: boolean;
  lastModified: string | null;
  actions: string[];
  fieldsReferenced: string[];
  verdict: string;
  actionsUnknown?: true;
}

interface Finding {
  severity: string;
  flag: string;
  issue: string;
  recommendation: string;
  evidence: Record<string, number>;
}

interface AnalysisResult {
  table: string;
  summary: {
    total: number;
    activated: number;
    inactive: number;
    entityScoped: number;
    formScoped: number;
    portable: number;
    partial: number;
    formOnly: number;
    unclassified: number;
  };
  rules: RuleInfo[];
  findings: Finding[];
  pluginProposal?: {
    messages: string[];
    stage: string;
    mode: string;
    filteringAttributes: string[];
    replaces: string[];
    partiallyReplaces: Array<{ rule: string; formOnlyActionsThatMustStay: string[] }>;
    staysDeclarative: Array<{ rule: string; reason: string }>;
    note: string;
  };
  truncated?: boolean;
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

type QueryArg = { select?: string[]; filter?: string; top?: number };

function callArgs(
  mock: ReturnType<typeof vi.fn>,
  index: number,
): [string, QueryArg] {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`no call at index ${index}`);
  return call as unknown as [string, QueryArg];
}

/** Columns fixture then rules fixture — the tool's two queries, in order. */
function mockOrg(get: ReturnType<typeof vi.fn>, rulesFixture: string): void {
  get
    .mockResolvedValueOnce(loadFixture("businessRules.columns.json"))
    .mockResolvedValueOnce(loadFixture(rulesFixture));
}

function ruleNamed(result: AnalysisResult, name: string): RuleInfo {
  const rule = result.rules.find((r) => r.name === name);
  if (rule === undefined) throw new Error(`no rule named ${name}`);
  return rule;
}

function flags(result: AnalysisResult): string[] {
  return result.findings.map((f) => f.flag);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("analyze_business_rules input schema", () => {
  it("requires a non-empty table logical name", () => {
    expect(analyzeBusinessRulesTool.inputSchema.safeParse({}).success).toBe(false);
    expect(
      analyzeBusinessRulesTool.inputSchema.safeParse({ table: "" }).success,
    ).toBe(false);
    expect(
      analyzeBusinessRulesTool.inputSchema.safeParse({ table: "account" }).success,
    ).toBe(true);
  });

  it("trims and lowercases the table name before querying", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.empty.json");

    const result = (await analyzeBusinessRules(client, {
      table: "  Account ",
    })) as AnalysisResult;

    expect(result.table).toBe("account");
    expect(callArgs(get, 0)[0]).toBe("EntityDefinitions(LogicalName='account')/Attributes");
    expect(callArgs(get, 1)[1].filter).toContain("primaryentity eq 'account'");
  });
});

describe("analyzeBusinessRules queries", () => {
  it("selects business rule definitions of both states, capped at 200", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.mixed.json");

    await analyzeBusinessRules(client, { table: "account" });

    const [path, query] = callArgs(get, 1);
    expect(path).toBe("workflows");
    // category 2 = business rule, type 1 = definition.
    expect(query.filter).toContain("category eq 2");
    expect(query.filter).toContain("type eq 1");
    // Draft rules are the point — never filter to statecode eq 1 here.
    expect(query.filter).not.toContain("statecode");
    expect(query.top).toBe(200);
    // processtriggerscope is the trigger scope; `scope` is ownership and must
    // not be used for it.
    expect(query.select).toContain("processtriggerscope");
    expect(query.select).not.toContain("scope");
  });
});

describe("analyzeBusinessRules classification", () => {
  it("classifies portable, form-only, partial and draft rules", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.mixed.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(result.summary).toEqual({
      total: 4,
      activated: 3,
      inactive: 1,
      entityScoped: 1,
      formScoped: 2,
      portable: 1,
      partial: 1,
      formOnly: 1,
      unclassified: 0,
    });

    const portable = ruleNamed(result, "Credit limit default");
    expect(portable.verdict).toBe("portable");
    expect(portable.actions).toEqual(["Set Default Value"]);
    expect(portable.scope).toBe("entity");
    expect(portable.fieldsReferenced).toEqual(["creditlimit"]);

    const formOnly = ruleNamed(result, "Hide phone for on-hold accounts");
    expect(formOnly.verdict).toBe("form-only");
    expect(formOnly.actions).toEqual(["Set Visibility"]);
    expect(formOnly.scope).toBe("form");
    expect(formOnly.formId).toBe("ffff0000-0000-0000-0000-0000000000f1");

    const partial = ruleNamed(result, "Credit hold enforcement");
    expect(partial.verdict).toBe("partial");
    expect(partial.actions).toEqual(["Set Field Value", "Set Business Required"]);
    expect(partial.isManaged).toBe(true);

    expect(ruleNamed(result, "Old credit limit rule").state).toBe("draft");
  });

  it("reads actions out of xaml when clientdata is absent", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.xamlOnly.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    const rule = ruleNamed(result, "Server side validation");
    expect(rule.actions).toEqual(["Show Error Message"]);
    expect(rule.verdict).toBe("portable");
    expect(rule.fieldsReferenced).toEqual(["creditlimit"]);
  });

  it("keeps an unrecognisable rule, marking it unknown rather than dropping it", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.unparseable.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(result.rules).toHaveLength(1);
    const rule = ruleNamed(result, "Opaque rule");
    expect(rule.verdict).toBe("unknown");
    expect(rule.actionsUnknown).toBe(true);
    expect(rule.actions).toEqual([]);
    // Scope still resolves — it comes from the column, not the definition.
    expect(rule.scope).toBe("entity");
    expect(flags(result)).toContain("unclassified-rules");
    expect(result.pluginProposal).toBeUndefined();
  });
});

describe("analyzeBusinessRules findings", () => {
  it("flags a column contested by more than one activated rule", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.mixed.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    const overlap = result.findings.find((f) => f.flag === "overlapping-fields");
    expect(overlap).toBeDefined();
    // creditlimit is written by the activated portable rule and the activated
    // partial rule; the draft rule must not count towards the overlap.
    expect(overlap?.issue).toContain("creditlimit (2 rules)");
    expect(overlap?.evidence["contestedColumns"]).toBe(1);
  });

  it("flags form-scoped data logic, mixed rules and drafts", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.mixed.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(flags(result)).toEqual(
      expect.arrayContaining([
        "form-scope-only",
        "mixed-verdict-rule",
        "draft-rules",
      ]),
    );
    // Severity ordering high -> low is a guarantee of the output.
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const ranks = result.findings.map((f) => rank[f.severity] ?? -1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("analyzeBusinessRules plug-in proposal", () => {
  it("proposes one step covering the portable and partial rules", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.mixed.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    const proposal = result.pluginProposal;
    expect(proposal).toBeDefined();
    expect(proposal?.messages).toEqual(["Create", "Update"]);
    expect(proposal?.stage).toBe("PreOperation");
    expect(proposal?.mode).toBe("sync");
    expect(proposal?.filteringAttributes).toEqual(["creditlimit", "industrycode"]);
    expect(proposal?.replaces).toEqual(["Credit limit default"]);
    expect(proposal?.partiallyReplaces).toEqual([
      {
        rule: "Credit hold enforcement",
        formOnlyActionsThatMustStay: ["Set Business Required"],
      },
    ]);
    expect(proposal?.staysDeclarative[0]?.rule).toBe(
      "Hide phone for on-hold accounts",
    );
    // A managed rule cannot simply be deactivated — the note has to say so.
    expect(proposal?.note).toContain("managed");
  });

  it("proposes nothing when every rule is form-only, and says why", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.formOnly.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(result.summary.formOnly).toBe(2);
    expect(result.pluginProposal).toBeUndefined();
    expect(result.hint).toContain("a plug-in cannot do");
    // An all-form-only table is a successful run, not an error.
    expect((result as unknown as Envelope).error).toBeUndefined();
  });
});

describe("analyzeBusinessRules empty and degraded results", () => {
  it("returns a hint, not an error, when the table has no business rules", async () => {
    const { client, get } = makeFakeClient();
    mockOrg(get, "businessRules.empty.json");

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(result.rules).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.hint).toContain("No business rules");
    expect((result as unknown as Envelope).error).toBeUndefined();
  });

  it("notes when no columns came back, so fields could not be resolved", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("businessRules.columns.empty.json"))
      .mockResolvedValueOnce(loadFixture("businessRules.mixed.json"));

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(result.sectionNotes?.[0]).toContain("no fields could be resolved");
    expect(ruleNamed(result, "Credit limit default").fieldsReferenced).toEqual([]);
    // Classification does not depend on column resolution.
    expect(ruleNamed(result, "Credit limit default").verdict).toBe("portable");
  });

  it("reports truncation when the rule cap is hit", async () => {
    const { client, get } = makeFakeClient();
    const rule = loadFixture<{ value: unknown[] }>("businessRules.mixed.json")
      .value[0];
    get
      .mockResolvedValueOnce(loadFixture("businessRules.columns.json"))
      .mockResolvedValueOnce({ value: Array.from({ length: 200 }, () => rule) });

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as AnalysisResult;

    expect(result.truncated).toBe(true);
  });
});

describe("analyzeBusinessRules error mapping", () => {
  it("maps 403 to the privilege envelope", async () => {
    const { client, get } = makeFakeClient();
    const fixture = loadFixture<{ status: number; message: string }>(
      "businessRules.error403.json",
    );
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as Envelope;

    expect(result.error).toContain("prvReadWorkflow");
    expect(result.hint).toContain("System Customizer");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps an unknown table to a logical-name hint rather than an empty result", async () => {
    const { client, get } = makeFakeClient();
    const fixture = loadFixture<{ status: number; message: string }>(
      "businessRules.error404.json",
    );
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await analyzeBusinessRules(client, {
      table: "accounts",
    })) as Envelope;

    expect(result.hint).toContain("singular");
    expect(result.hint).toContain("accounts");
    // The rule query must not run once the table is known to be wrong.
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("maps a 403 on the rule query itself", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("businessRules.columns.json"))
      .mockRejectedValueOnce(
        new DataverseHttpError(403, "missing prvReadWorkflow privilege."),
      );

    const result = (await analyzeBusinessRules(client, {
      table: "account",
    })) as Envelope;

    expect(result.hint).toContain("System Customizer");
  });
});
