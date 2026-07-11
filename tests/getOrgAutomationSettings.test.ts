import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  getOrgAutomationSettings,
  queryOrgAutomationSettings,
} from "../src/tools/getOrgAutomationSettings.js";
import {
  DataverseHttpError,
  type DataverseClient,
  type QueryOptions,
} from "../src/dataverse/client.js";

const TRACING_DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const allOnFixture = loadFixture("orgSettings.allOn.json");
const tracingOffFixture = loadFixture("orgSettings.tracingOff.json");
const exceptionFixture = loadFixture("orgSettings.exception.json");
const missingColumnsFixture = loadFixture("orgSettings.missingColumns.json");
const emptyFixture = loadFixture("orgSettings.empty.json");

interface ResultShape {
  organization?: string | null;
  pluginTraceLog?: { setting: string; hint: string; docsUrl?: string };
  auditing?: {
    enabled?: boolean;
    retentionDays?: number;
    readAuditEnabled?: boolean;
    userAccessAuditEnabled?: boolean;
    hint?: string;
  };
  hints?: string[];
  error?: string;
  hint?: string;
  docsUrl?: string;
}

function fakeClient(result: unknown) {
  const get = vi.fn(
    async (_path: string, _options?: QueryOptions): Promise<unknown> => result,
  );
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function throwingClient(err: unknown) {
  const get = vi.fn(async (_path: string, _options?: QueryOptions): Promise<unknown> => {
    throw err;
  });
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

describe("input schema", () => {
  it("accepts an empty object and defines no parameters", () => {
    expect(getOrgAutomationSettings.inputSchema.safeParse({}).success).toBe(true);
    expect(Object.keys(getOrgAutomationSettings.inputSchema.shape)).toEqual([]);
  });

  it("is exposed as the free tool get_org_automation_settings", () => {
    expect(getOrgAutomationSettings.name).toBe("get_org_automation_settings");
    expect(getOrgAutomationSettings.description.toLowerCase()).toContain("free tier");
  });
});

describe("happy path (everything on)", () => {
  it("queries organizations with the expected select and $top 1, and maps the full shape", async () => {
    const { get, client } = fakeClient(allOnFixture);
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = get.mock.calls[0] as unknown as [string, QueryOptions];
    expect(path).toBe("organizations");
    expect(options.select).toEqual([
      "organizationid",
      "name",
      "plugintracelogsetting",
      "isauditenabled",
      "auditretentionperiodv2",
      "isreadauditenabled",
      "isuseraccessauditenabled",
    ]);
    expect(options.top).toBe(1);
    expect(options.filter).toBeUndefined();

    expect(result.error).toBeUndefined();
    expect(result.organization).toBe("Contoso Production");
    expect(result.pluginTraceLog?.setting).toBe("all");
    expect(result.pluginTraceLog?.hint).toContain("storage");
    expect(result.auditing).toMatchObject({
      enabled: true,
      retentionDays: 30,
      readAuditEnabled: true,
      userAccessAuditEnabled: true,
    });
    expect(result.auditing?.hint).toBeUndefined();
    expect(result.hints).toEqual([result.pluginTraceLog?.hint]);
  });
});

describe("tracing off", () => {
  it('maps setting "off", surfaces the enable hint with docsUrl, and aggregates hints', async () => {
    const { client } = fakeClient(tracingOffFixture);
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;

    expect(result.pluginTraceLog?.setting).toBe("off");
    const hint = result.pluginTraceLog?.hint ?? "";
    expect(hint).toContain("get_plugin_traces");
    expect(hint).toContain("explain_trace");
    expect(hint).toContain("analyze_plugin_performance");
    expect(hint).toContain("Settings > Administration > System Settings > Customization");
    expect(result.pluginTraceLog?.docsUrl).toBe(TRACING_DOCS_URL);

    // Auditing is off too: field-change history hint present.
    expect(result.auditing?.enabled).toBe(false);
    expect(result.auditing?.hint).toContain("field-change history");

    expect(result.hints).toContain(hint);
    expect(result.hints).toContain(result.auditing?.hint);
    expect(result.hints).toHaveLength(2);
  });
});

describe("setting value mapping", () => {
  it('maps 1 to "exception" and notes that only failing executions are captured', async () => {
    const { client } = fakeClient(exceptionFixture);
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;

    expect(result.pluginTraceLog?.setting).toBe("exception");
    expect(result.pluginTraceLog?.hint).toContain("only failing executions");
    expect(result.pluginTraceLog?.docsUrl).toBeUndefined();
    // auditretentionperiodv2 is null in the fixture: retentionDays omitted.
    expect(result.auditing?.enabled).toBe(true);
    expect(result.auditing).not.toHaveProperty("retentionDays");
  });

  it("maps an unknown numeric setting to its numeric string", async () => {
    const { client } = fakeClient({
      value: [{ name: "Weird Org", plugintracelogsetting: 7, isauditenabled: true }],
    });
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;
    expect(result.pluginTraceLog?.setting).toBe("7");
    expect(result.pluginTraceLog?.hint).toContain("7");
  });
});

describe("missing optional columns (older orgs)", () => {
  it("omits absent sections/fields instead of crashing", async () => {
    const { client } = fakeClient(missingColumnsFixture);
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;

    expect(result.error).toBeUndefined();
    expect(result.organization).toBe("Contoso Legacy");
    // plugintracelogsetting absent from the row: whole section omitted.
    expect(result).not.toHaveProperty("pluginTraceLog");
    expect(result.auditing).toEqual({ enabled: true });
    expect(result.hints).toEqual([]);
  });
});

describe("failure modes", () => {
  it("returns an envelope when the organizations query yields no rows", async () => {
    const { client } = fakeClient(emptyFixture);
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;

    expect(result.error).toBe("Organization record not readable");
    expect(result.hint).toContain("Organization table");
    expect(result.docsUrl).toBeDefined();
    expect(result.pluginTraceLog).toBeUndefined();
  });

  it("maps a 403 to an envelope with the read-privilege hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        403,
        "Principal user (Id=00000000-0000-0000-0000-000000000001, type=8) is missing prvReadOrganization privilege",
      ),
    );
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;

    expect(result.error).toContain("prvReadOrganization");
    expect(result.hint).toContain("Organization table");
    expect(result.hint).toContain("basic user role");
    expect(result.docsUrl).toBeDefined();
  });

  it("maps any other error via toErrorEnvelope without letting it escape", async () => {
    const { client } = throwingClient(new Error("socket hang up"));
    const result = (await queryOrgAutomationSettings(client)) as ResultShape;
    expect(result).toEqual({ error: "socket hang up" });
  });
});
