import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectAutomationLoops,
  detectAutomationLoopsTool,
  singularize,
} from "../src/tools/detectAutomationLoops.js";
import {
  DataverseHttpError,
  type DataverseClient,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/create-update-delete-trigger";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface SuspectedLoop {
  severity: "high" | "medium";
  kind: "self-loop" | "cycle";
  flows: Array<{ id: string; name: string }>;
  tables: string[];
  evidence: string;
  recommendation: string;
}

interface LoopsResult {
  flowsScanned: number;
  flowsWithDataverseTrigger: number;
  suspectedLoops: SuspectedLoop[];
  truncated?: boolean;
  parseFailures?: number;
  hint?: string;
  note?: string;
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("input schema", () => {
  it("defaults maxFlows to 500 and enforces bounds", () => {
    const schema = detectAutomationLoopsTool.inputSchema;
    expect(schema.parse({})).toEqual({ maxFlows: 500 });
    expect(schema.parse({ maxFlows: 10 })).toEqual({ maxFlows: 10 });
    expect(schema.parse({ maxFlows: 1000 })).toEqual({ maxFlows: 1000 });
    expect(() => schema.parse({ maxFlows: 9 })).toThrow();
    expect(() => schema.parse({ maxFlows: 1001 })).toThrow();
    expect(() => schema.parse({ maxFlows: 50.5 })).toThrow();
  });
});

describe("singularize", () => {
  it("applies the two naive rules", () => {
    expect(singularize("accounts")).toBe("account");
    expect(singularize("opportunities")).toBe("opportunity");
    expect(singularize("contact")).toBe("contact");
    expect(singularize("Quotes")).toBe("quote");
  });
});

describe("detectAutomationLoops happy path", () => {
  it("queries activated cloud flows and reports self-loops and cycles sorted high to medium", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("automationLoops.flows.json"));

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    expect(get).toHaveBeenCalledTimes(1);
    const call = get.mock.calls[0] as unknown as [
      string,
      { select?: string[]; filter?: string; top?: number },
    ];
    expect(call[0]).toBe("workflows");
    expect(call[1].select).toEqual(["workflowid", "name", "clientdata"]);
    expect(call[1].filter).toBe("category eq 5 and type eq 1 and statecode eq 1");
    expect(call[1].top).toBe(500);

    expect(result.flowsScanned).toBe(9);
    // Broken flow fails to parse; the 8 remaining all have Dataverse triggers.
    expect(result.parseFailures).toBe(1);
    expect(result.flowsWithDataverseTrigger).toBe(8);
    expect(result.truncated).toBeUndefined();
    expect(result.hint).toBeUndefined();

    // Two self-loops + one 2-cycle + one 3-cycle, high first.
    expect(result.suspectedLoops).toHaveLength(4);
    expect(result.suspectedLoops.map((l) => l.severity)).toEqual([
      "high",
      "medium",
      "medium",
      "medium",
    ]);

    const high = result.suspectedLoops[0] as SuspectedLoop;
    expect(high.kind).toBe("self-loop");
    expect(high.flows).toEqual([
      { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "Auto-update accounts" },
    ]);
    expect(high.tables).toEqual(["account"]);
    expect(high.evidence).toContain(
      "triggers on account and writes to account without trigger filtering",
    );
    expect(high.recommendation).toContain("filtering attributes");
    expect(high.recommendation).toContain("what_runs_on_table");

    const mediumSelf = result.suspectedLoops.find(
      (l) => l.kind === "self-loop" && l.severity === "medium",
    ) as SuspectedLoop;
    expect(mediumSelf.flows[0]?.name).toBe("Sync quote totals");
    expect(mediumSelf.tables).toEqual(["quote"]);
    expect(mediumSelf.evidence).toContain("filtering attributes or conditions are set");

    const twoCycle = result.suspectedLoops.find(
      (l) => l.kind === "cycle" && l.flows.length === 2,
    ) as SuspectedLoop;
    expect(twoCycle.severity).toBe("medium");
    // Canonical order: lexicographically-smallest flow id first.
    expect(twoCycle.flows.map((f) => f.id)).toEqual([
      "bbbbbbbb-0000-0000-0000-000000000001",
      "bbbbbbbb-0000-0000-0000-000000000002",
    ]);
    expect(twoCycle.tables).toEqual(["contact", "opportunity"]);
    expect(twoCycle.evidence).toContain(
      '"Contact touch" triggers on contact and writes to opportunity',
    );
    expect(twoCycle.evidence).toContain(
      '"Opportunity touch" triggers on opportunity and writes to contact',
    );
    expect(twoCycle.recommendation).toContain("what_runs_on_table");

    const threeCycle = result.suspectedLoops.find(
      (l) => l.kind === "cycle" && l.flows.length === 3,
    ) as SuspectedLoop;
    expect(threeCycle.flows.map((f) => f.id)).toEqual([
      "cccccccc-0000-0000-0000-000000000001",
      "cccccccc-0000-0000-0000-000000000002",
      "cccccccc-0000-0000-0000-000000000003",
    ]);
    expect(threeCycle.tables).toEqual(["incident", "task", "email"]);
    expect(threeCycle.evidence).toContain("back to the start");
  });

  it("reports each cycle exactly once regardless of traversal start", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("automationLoops.flows.json"));

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    // A->B->A is discoverable starting from either flow, but the canonical
    // rotation dedupes it to a single finding; same for the 3-cycle.
    const cycles = result.suspectedLoops.filter((l) => l.kind === "cycle");
    expect(cycles).toHaveLength(2);
    expect(cycles.filter((l) => l.flows.length === 2)).toHaveLength(1);
    expect(cycles.filter((l) => l.flows.length === 3)).toHaveLength(1);
  });
});

describe("detectAutomationLoops empty and truncated results", () => {
  it("returns the no-loops hint plus a plugin-side note when nothing is suspected", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("automationLoops.noLoops.json"));

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    expect(result.flowsScanned).toBe(2);
    expect(result.flowsWithDataverseTrigger).toBe(2);
    expect(result.suspectedLoops).toEqual([]);
    expect(result.parseFailures).toBeUndefined();
    expect(result.hint).toBe("No suspected loops detected among scanned flows");
    expect(result.note).toContain("analyze_plugin_performance");
  });

  it("sets the truncated flag when the scan hits maxFlows rows", async () => {
    const { client, get } = makeFakeClient();
    const rows = Array.from({ length: 10 }, (_, i) => ({
      workflowid: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
      name: `Flow ${i}`,
      clientdata: JSON.stringify({
        properties: { definition: { triggers: {}, actions: {} } },
      }),
    }));
    get.mockResolvedValueOnce({ value: rows });

    const result = (await detectAutomationLoops(client, {
      maxFlows: 10,
    })) as LoopsResult;

    const call = get.mock.calls[0] as unknown as [string, { top?: number }];
    expect(call[1].top).toBe(10);
    expect(result.flowsScanned).toBe(10);
    expect(result.flowsWithDataverseTrigger).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.suspectedLoops).toEqual([]);
    expect(result.hint).toBe("No suspected loops detected among scanned flows");
  });
});

describe("detectAutomationLoops failure modes", () => {
  it("maps a 403 to an envelope with a privilege hint and docsUrl", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "automationLoops.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("read privilege on the Process");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
