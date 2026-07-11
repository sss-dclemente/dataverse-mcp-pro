import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentFlow } from "../src/tools/documentFlow.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const FLOW_SELECT = [
  "workflowid",
  "name",
  "description",
  "statecode",
  "category",
  "type",
  "clientdata",
  "createdon",
  "modifiedon",
  "_ownerid_value",
];

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface TriggerDoc {
  name: string;
  type: string;
  kind?: string;
  recurrence?: { frequency: string; interval: number };
  operationId?: string;
  connectionReference?: string;
}

interface ActionDoc {
  name: string;
  type: string;
  depth: number;
  runAfter?: string[];
  operationId?: string;
  connectionReference?: string;
  expression?: string;
  note?: string;
}

interface ConnectorDoc {
  referenceName: string;
  apiName: string;
  connectionName?: string;
}

interface FlowDocResult {
  flow: {
    id: string | null;
    name: string;
    description?: string;
    state: string;
    createdon: string | null;
    modifiedon: string | null;
  };
  triggers: TriggerDoc[];
  actions: ActionDoc[];
  actionCount: number;
  connectors: ConnectorDoc[];
  actionsTruncated?: boolean;
  markdown: string;
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

describe("documentFlow input guard", () => {
  it("returns an error envelope and makes no request when both inputs are missing", async () => {
    const { client, get } = makeFakeClient();

    const result = (await documentFlow(client, {})) as Envelope;

    expect(result.error).toBe("Provide flowId or flowName");
    expect(result.hint).toBeDefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("documentFlow by flowId", () => {
  it("documents a Recurrence-triggered flow: triggers, flat pre-order actions, connectors, markdown", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("documentFlow.flow.recurrence.json"));

    const result = (await documentFlow(client, {
      flowId: "aaaaaaaa-1111-2222-3333-444444444444",
    })) as FlowDocResult;

    expect(get).toHaveBeenCalledTimes(1);
    const [path, query] = callArgs(get, 0);
    expect(path).toBe("workflows(aaaaaaaa-1111-2222-3333-444444444444)");
    expect(query.select).toEqual(FLOW_SELECT);

    expect(result.flow).toEqual({
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      name: "Daily Task Reminder",
      description: "Reminds owners about overdue tasks every morning.",
      state: "activated",
      createdon: "2026-05-01T08:00:00Z",
      modifiedon: "2026-07-01T09:30:00Z",
    });

    // Trigger with recurrence details.
    expect(result.triggers).toEqual([
      {
        name: "Recurrence_daily",
        type: "Recurrence",
        recurrence: { frequency: "Day", interval: 1 },
      },
    ]);

    // Flat pre-order list with correct depths.
    expect(result.actionCount).toBe(10);
    expect(result.actions.map((a) => [a.name, a.depth])).toEqual([
      ["List_overdue_tasks", 0],
      ["Process_tasks", 0],
      ["Compose_summary", 1],
      ["Check_count", 1],
      ["Send_reminder_email", 2],
      ["Log_nothing_due", 2],
      ["Route_by_priority", 0],
      ["Update_row_high", 1],
      ["Delay_low", 1],
      ["Terminate_done", 0],
    ]);

    const byName = new Map(result.actions.map((a) => [a.name, a]));

    // runAfter chains become arrays of predecessor names.
    expect(byName.get("List_overdue_tasks")?.runAfter).toBeUndefined();
    expect(byName.get("Process_tasks")?.runAfter).toEqual(["List_overdue_tasks"]);
    expect(byName.get("Check_count")?.runAfter).toEqual(["Compose_summary"]);
    expect(byName.get("Route_by_priority")?.runAfter).toEqual(["Process_tasks"]);
    expect(byName.get("Terminate_done")?.runAfter).toEqual(["Route_by_priority"]);

    // OpenApiConnection actions expose operationId + connection reference.
    const list = byName.get("List_overdue_tasks");
    expect(list?.type).toBe("OpenApiConnection");
    expect(list?.operationId).toBe("ListRecords");
    expect(list?.connectionReference).toBe("shared_commondataserviceforapps");
    expect(byName.get("Send_reminder_email")?.connectionReference).toBe(
      "shared_office365",
    );

    // If/Switch expressions are captured as trimmed JSON strings.
    const ifExpression = byName.get("Check_count")?.expression;
    expect(ifExpression).toBeDefined();
    expect(ifExpression).toContain("greater");
    expect((ifExpression ?? "").length).toBeLessThanOrEqual(200);
    expect(byName.get("Route_by_priority")?.expression).toContain("priority");

    // Connectors deduped by apiName: two cds references collapse into one.
    expect(result.connectors).toEqual([
      {
        referenceName: "shared_commondataserviceforapps",
        apiName: "shared_commondataserviceforapps",
        connectionName: "shared-commondataser-1234",
      },
      {
        referenceName: "shared_office365",
        apiName: "shared_office365",
        connectionName: "shared-office365-abcd",
      },
    ]);

    // Markdown document.
    expect(result.markdown).toContain("# Daily Task Reminder");
    expect(result.markdown).toContain(
      "Reminds owners about overdue tasks every morning.",
    );
    // Nested bullet (depth 2 -> four spaces of indent) with type in backticks.
    expect(result.markdown).toContain(
      "    - **Send_reminder_email** (`OpenApiConnection`)",
    );
    expect(result.markdown).toContain("after: List_overdue_tasks");
    // Connectors table row.
    expect(result.markdown).toContain(
      "| shared_office365 | shared_office365 | shared-office365-abcd |",
    );
    expect(result.actionsTruncated).toBeUndefined();
  });

  it("returns a 'Flow not found' envelope on 404", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new DataverseHttpError(404, "Does not exist"));

    const result = (await documentFlow(client, {
      flowId: "aaaaaaaa-0000-0000-0000-000000000000",
    })) as Envelope;

    expect(result.error).toBe("Flow not found");
    expect(result.hint).toContain("workflowid");
  });
});

describe("documentFlow by flowName", () => {
  it("retries with contains() and documents the OpenApiConnection-triggered flow", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce(loadFixture("documentFlow.flows.openapiByName.json"));

    const result = (await documentFlow(client, {
      flowName: "When Contact Created Notify",
    })) as FlowDocResult;

    expect(get).toHaveBeenCalledTimes(2);
    const [path1, query1] = callArgs(get, 0);
    expect(path1).toBe("workflows");
    expect(query1.select).toEqual(FLOW_SELECT);
    expect(query1.filter).toBe(
      "category eq 5 and type eq 1 and name eq 'When Contact Created Notify'",
    );
    expect(query1.top).toBe(1);
    const [path2, query2] = callArgs(get, 1);
    expect(path2).toBe("workflows");
    expect(query2.filter).toBe(
      "category eq 5 and type eq 1 and contains(name,'When Contact Created Notify')",
    );
    expect(query2.top).toBe(1);

    expect(result.flow.name).toBe("When Contact Created Notify");
    expect(result.flow.state).toBe("draft");
    // description null -> omitted entirely.
    expect("description" in result.flow).toBe(false);

    // OpenApiConnectionWebhook trigger: operationId + connectionName fallback.
    expect(result.triggers).toEqual([
      {
        name: "When_a_row_is_added",
        type: "OpenApiConnectionWebhook",
        operationId: "SubscribeWebhookTrigger",
        connectionReference: "shared_commondataserviceforapps",
      },
      { name: "Manual_button", type: "Request", kind: "Button" },
    ]);

    // host.connectionName fallback works for actions too.
    expect(result.actions.map((a) => a.name)).toEqual([
      "Get_full_row",
      "Notify_channel",
    ]);
    expect(result.actions[0]?.connectionReference).toBe(
      "shared_commondataserviceforapps",
    );

    // apiName falls back to entry.id when api.name is absent.
    expect(result.connectors).toEqual([
      {
        referenceName: "shared_commondataserviceforapps",
        apiName: "shared_commondataserviceforapps",
        connectionName: "cds-conn-1",
      },
      {
        referenceName: "shared_teams",
        apiName: "/providers/Microsoft.PowerApps/apis/shared_teams",
      },
    ]);
  });

  it("escapes quotes and returns an envelope when neither query matches", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: [] }).mockResolvedValueOnce({ value: [] });

    const result = (await documentFlow(client, {
      flowName: "O'Brien Flow",
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(2);
    expect(callArgs(get, 0)[1].filter).toBe(
      "category eq 5 and type eq 1 and name eq 'O''Brien Flow'",
    );
    expect(callArgs(get, 1)[1].filter).toBe(
      "category eq 5 and type eq 1 and contains(name,'O''Brien Flow')",
    );
    expect(result.error).toBe('Flow not found: "O\'Brien Flow"');
    expect(result.hint).toContain("category 5");
  });
});

describe("documentFlow caps", () => {
  it("stops descending at depth 5 and marks the capped container with a note", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("documentFlow.flow.deepNesting.json"));

    const result = (await documentFlow(client, {
      flowId: "cccccccc-1111-2222-3333-444444444444",
    })) as FlowDocResult;

    // Scope_0..Scope_5 emitted; Scope_6 (depth 6) is omitted.
    expect(result.actionCount).toBe(6);
    expect(result.actions.map((a) => a.depth)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.actions[5]).toEqual({
      name: "Scope_5",
      type: "Scope",
      depth: 5,
      note: "children omitted (depth cap)",
    });
    expect(result.actions.some((a) => a.depth > 5)).toBe(false);
    // Depth cap does not set the count-truncation flag.
    expect(result.actionsTruncated).toBeUndefined();
    expect(result.markdown).toContain("children omitted (depth cap)");
  });

  it("caps the flat list at 200 actions and sets actionsTruncated", async () => {
    const actions: Record<string, unknown> = {};
    for (let i = 0; i < 250; i += 1) {
      actions[`Compose_${i}`] = {
        type: "Compose",
        runAfter: i === 0 ? {} : { [`Compose_${i - 1}`]: ["Succeeded"] },
        inputs: i,
      };
    }
    const clientdata = JSON.stringify({
      schemaVersion: "1.0.0.0",
      properties: {
        connectionReferences: {},
        definition: {
          triggers: {
            Recurrence_hourly: {
              type: "Recurrence",
              recurrence: { frequency: "Hour", interval: 1 },
            },
          },
          actions,
        },
      },
    });
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({
      workflowid: "abababab-1111-2222-3333-444444444444",
      name: "Very Large Flow",
      description: null,
      statecode: 1,
      category: 5,
      type: 1,
      clientdata,
      createdon: "2026-01-01T00:00:00Z",
      modifiedon: "2026-01-02T00:00:00Z",
    });

    const result = (await documentFlow(client, {
      flowId: "abababab-1111-2222-3333-444444444444",
    })) as FlowDocResult;

    expect(result.actionCount).toBe(200);
    expect(result.actions).toHaveLength(200);
    expect(result.actionsTruncated).toBe(true);
    expect(result.actions[199]?.name).toBe("Compose_199");
    // Markdown honors its own 8000-char hard cap.
    expect(result.markdown.endsWith("…(truncated)")).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(
      8000 + "…(truncated)".length,
    );
  });
});

describe("documentFlow failure modes", () => {
  it("rejects workflows that are not cloud flows (category != 5)", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("documentFlow.flow.notCloudFlow.json"));

    const result = (await documentFlow(client, {
      flowId: "dddddddd-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toBe("Not a cloud flow");
    expect(result.hint).toContain("Classic workflows");
  });

  it("returns an envelope when clientdata is missing", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("documentFlow.flow.noClientData.json"));

    const result = (await documentFlow(client, {
      flowId: "eeeeeeee-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toBe("Flow definition unavailable");
    expect(result.hint).toContain("managed solution");
  });

  it("returns an envelope when clientdata is not valid JSON", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("documentFlow.flow.badClientData.json"));

    const result = (await documentFlow(client, {
      flowId: "ffffffff-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toBe("Flow definition could not be parsed");
    expect(result.hint).toContain("not valid JSON");
  });

  it("maps a 403 to an envelope with a Process-table privilege hint and docsUrl", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "documentFlow.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await documentFlow(client, {
      flowId: "aaaaaaaa-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("Process (workflow)");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await documentFlow(client, {
      flowName: "Daily Task Reminder",
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
