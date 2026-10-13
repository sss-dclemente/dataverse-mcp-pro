import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectAutomationLoops,
  detectAutomationLoopsTool,
  LOOP_MAX_RESPONSE_BYTES,
  LOOP_REQUEST_TIMEOUT_MS,
  singularize,
} from "../src/tools/detectAutomationLoops.js";
import {
  DataverseHttpError,
  DataverseTimeoutError,
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
  timedOut?: boolean;
  flowsListed?: number;
  skippedOversized?: number;
  parseFailures?: number;
  hint?: string;
  note?: string;
}

interface Envelope {
  error: string;
  hint?: string;
  docsUrl?: string;
}

interface ListedFlow {
  workflowid?: string;
  name?: string | null;
  clientdata?: string | null;
}

function serveFlows(
  get: ReturnType<typeof vi.fn>,
  body: { value: ListedFlow[] },
  extra: Record<string, unknown> = {},
): void {
  get.mockImplementation(async (path: string) => {
    if (path === "workflows") {
      return {
        ...extra,
        value: body.value.map((row) => ({
          workflowid: row.workflowid,
          name: row.name,
        })),
      };
    }
    const id = /^workflows\(([0-9a-f-]{36})\)$/i.exec(path)?.[1];
    const row = body.value.find((item) => item.workflowid === id);
    return { clientdata: row?.clientdata ?? null };
  });
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
    const fixture = loadFixture<{ value: ListedFlow[] }>("automationLoops.flows.json");
    serveFlows(get, fixture);

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    expect(get).toHaveBeenCalledTimes(1 + fixture.value.length);
    const calls = get.mock.calls as unknown as Array<
      [
        string,
        {
          select?: string[];
          filter?: string;
          top?: number;
          timeoutMs?: number;
          maxBytes?: number;
        },
      ]
    >;
    expect(calls[0]?.[0]).toBe("workflows");
    expect(calls[0]?.[1].select).toEqual(["workflowid", "name"]);
    expect(calls[0]?.[1].filter).toBe("category eq 5 and type eq 1 and statecode eq 1");
    expect(calls[0]?.[1].top).toBe(500);
    expect(calls[0]?.[1].timeoutMs).toBe(LOOP_REQUEST_TIMEOUT_MS);
    expect(calls[0]?.[1].maxBytes).toBeUndefined();
    expect(calls[1]?.[0]).toBe("workflows(aaaaaaaa-0000-0000-0000-000000000001)");
    expect(calls[1]?.[1].select).toEqual(["clientdata"]);
    expect(calls[1]?.[1].timeoutMs).toBe(LOOP_REQUEST_TIMEOUT_MS);
    expect(calls[1]?.[1].maxBytes).toBe(LOOP_MAX_RESPONSE_BYTES);

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
    serveFlows(get, loadFixture("automationLoops.flows.json"));

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
    serveFlows(get, loadFixture("automationLoops.noLoops.json"));

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
    serveFlows(get, { value: rows });

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

  it("maps a list-query timeout to an envelope instead of hanging", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new DataverseTimeoutError(LOOP_REQUEST_TIMEOUT_MS));

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as Envelope;

    expect(result.error).toContain(`${LOOP_REQUEST_TIMEOUT_MS}ms`);
    expect(result.hint).toContain("workflowid and name only");
    expect(result.hint).toContain("840s");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 403 on a definition read to the privilege envelope", async () => {
    const { client, get } = makeFakeClient();
    get.mockImplementation(async (path: string) => {
      if (path === "workflows") {
        return {
          value: [
            {
              workflowid: "aaaaaaaa-0000-0000-0000-000000000001",
              name: "Auto-update accounts",
            },
          ],
        };
      }
      throw new DataverseHttpError(403, "missing prvReadWorkflow");
    });

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as Envelope;

    expect(result.error).toBe("missing prvReadWorkflow");
    expect(result.hint).toContain("read privilege on the Process");
    expect(result.docsUrl).toBe(DOCS_URL);
  });
});

describe("detectAutomationLoops time and size guards", () => {
  const accountId = "aaaaaaaa-0000-0000-0000-000000000001";

  function selfLoopClientData(): string {
    const fixture = loadFixture<{ value: ListedFlow[] }>("automationLoops.flows.json");
    const row = fixture.value.find((item) => item.workflowid === accountId);
    if (row?.clientdata === undefined || row.clientdata === null) {
      throw new Error("fixture missing the account self-loop");
    }
    return row.clientdata;
  }

  it("does not follow @odata.nextLink and flags the unread page", async () => {
    const { client, get } = makeFakeClient();
    const next =
      "https://org.crm.dynamics.com/api/data/v9.2/workflows?$skiptoken=more";
    serveFlows(
      get,
      {
        value: [
          {
            workflowid: accountId,
            name: "Auto-update accounts",
            clientdata: selfLoopClientData(),
          },
        ],
      },
      { "@odata.nextLink": next },
    );

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    const paths = get.mock.calls.map((call) => String(call[0]));
    expect(paths).toEqual(["workflows", `workflows(${accountId})`]);
    expect(paths.some((path) => path.includes("skiptoken"))).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.suspectedLoops).toHaveLength(1);
  });

  it("skips a definition over the character cap without reporting a loop inside it", async () => {
    const { client, get } = makeFakeClient();
    const clientdata = selfLoopClientData();
    serveFlows(get, {
      value: [{ workflowid: accountId, name: "Auto-update accounts", clientdata }],
    });

    const result = (await detectAutomationLoops(
      client,
      { maxFlows: 500 },
      { maxClientDataChars: clientdata.length - 1 },
    )) as LoopsResult;

    expect(result.flowsScanned).toBe(1);
    expect(result.skippedOversized).toBe(1);
    expect(result.suspectedLoops).toEqual([]);
    expect(result.hint).toContain("size guard");
    expect(result.hint).not.toContain("No suspected loops detected");
    expect(result.note).toBeUndefined();
    expect(result.timedOut).toBeUndefined();
  });

  it("drops a flow whose action walk exceeds the node cap", async () => {
    const { client, get } = makeFakeClient();
    const actions: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      actions[`Update_${i}`] = {
        type: "OpenApiConnection",
        inputs: {
          host: { operationId: "UpdateRecord" },
          parameters: { entityName: "accounts" },
        },
      };
    }
    const clientdata = JSON.stringify({
      properties: {
        definition: {
          triggers: {
            When: {
              type: "OpenApiConnectionWebhook",
              inputs: { parameters: { entityname: "account" } },
            },
          },
          actions,
        },
      },
    });
    serveFlows(get, {
      value: [{ workflowid: accountId, name: "Wide flow", clientdata }],
    });

    const guarded = (await detectAutomationLoops(
      client,
      { maxFlows: 500 },
      { maxWalkNodes: 1 },
    )) as LoopsResult;
    expect(guarded.skippedOversized).toBe(1);
    expect(guarded.suspectedLoops).toEqual([]);

    const allowed = (await detectAutomationLoops(
      client,
      { maxFlows: 500 },
      { maxWalkNodes: 10 },
    )) as LoopsResult;
    expect(allowed.skippedOversized).toBeUndefined();
    expect(allowed.suspectedLoops.map((loop) => loop.kind)).toEqual(["self-loop"]);
  });

  it("stops before later definitions once the scan budget is spent", async () => {
    const { client, get } = makeFakeClient();
    const fixture = loadFixture<{ value: ListedFlow[] }>("automationLoops.flows.json");
    let reads = 0;
    get.mockImplementation(async (path: string) => {
      if (path === "workflows") {
        return {
          value: fixture.value.map((row) => ({
            workflowid: row.workflowid,
            name: row.name,
          })),
        };
      }
      reads += 1;
      const id = /^workflows\(([0-9a-f-]{36})\)$/i.exec(path)?.[1];
      const row = fixture.value.find((item) => item.workflowid === id);
      return { clientdata: row?.clientdata ?? null };
    });

    let current = 0;
    const result = (await detectAutomationLoops(
      client,
      { maxFlows: 500 },
      {
        budgetMs: 1_000,
        now: () => {
          const value = current;
          if (reads >= 1) current = 5_000;
          return value;
        },
      },
    )) as LoopsResult;

    expect(result.timedOut).toBe(true);
    expect(result.flowsListed).toBe(fixture.value.length);
    expect(result.flowsScanned).toBe(1);
    expect(result.suspectedLoops.map((loop) => loop.kind)).toContain("self-loop");
    expect(result.hint).toContain("deadline");
    expect(reads).toBe(1);
  });

  it("skips cycle search when the budget expires after definitions are read", async () => {
    const { client, get } = makeFakeClient();
    const fixture = loadFixture<{ value: ListedFlow[] }>("automationLoops.flows.json");
    const cycleFlows = fixture.value.filter((row) =>
      row.workflowid?.startsWith("bbbbbbbb-"),
    );
    serveFlows(get, { value: cycleFlows });

    // now() is called for the deadline, the list timeout, and then per flow
    // (loop check, request timeout, one walk step). The call that gates cycle
    // search is the next one; from there the clock is past the budget.
    let calls = 0;
    const result = (await detectAutomationLoops(
      client,
      { maxFlows: 500 },
      {
        budgetMs: 1_000,
        now: () => {
          calls += 1;
          return calls >= 9 ? 5_000 : 0;
        },
      },
    )) as LoopsResult;

    expect(result.timedOut).toBe(true);
    expect(result.flowsScanned).toBe(2);
    expect(result.suspectedLoops.filter((loop) => loop.kind === "cycle")).toEqual([]);
  });

  it("returns a partial result when a definition read times out", async () => {
    const { client, get } = makeFakeClient();
    get.mockImplementation(async (path: string) => {
      if (path === "workflows") {
        return {
          value: [
            { workflowid: accountId, name: "Auto-update accounts" },
            {
              workflowid: "bbbbbbbb-0000-0000-0000-000000000001",
              name: "Contact touch",
            },
          ],
        };
      }
      throw new DataverseTimeoutError(LOOP_REQUEST_TIMEOUT_MS);
    });

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    expect(result.timedOut).toBe(true);
    expect(result.flowsScanned).toBe(0);
    expect(result.flowsListed).toBe(2);
    expect(result.suspectedLoops).toEqual([]);
    expect(result.hint).toContain("deadline");
    expect(result.note).toBeUndefined();
  });

  it("counts an id that is not a GUID as a parse failure and does not request it", async () => {
    const { client, get } = makeFakeClient();
    get.mockImplementation(async (path: string) => {
      if (path === "workflows") {
        return { value: [{ workflowid: "not-a-guid", name: "Bad id" }] };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = (await detectAutomationLoops(client, {
      maxFlows: 500,
    })) as LoopsResult;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.parseFailures).toBe(1);
    expect(result.flowsScanned).toBe(1);
    expect(result.suspectedLoops).toEqual([]);
  });
});
