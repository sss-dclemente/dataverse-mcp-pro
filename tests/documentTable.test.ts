import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentTable, documentTableTool } from "../src/tools/documentTable.js";
import {
  DataverseHttpError,
  type DataverseClient,
} from "../src/dataverse/client.js";

const METADATA_DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-metadata-web-api";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface ColumnDoc {
  logicalName: string;
  schemaName: string;
  type: string;
  displayName?: string;
  description?: string;
  required: string;
  isCustom: boolean;
}

interface DocumentResult {
  table: {
    logicalName: string;
    schemaName: string;
    displayName?: string;
    description?: string;
    isCustom: boolean;
    ownershipType: string;
    primaryId: string | null;
    primaryName: string | null;
  };
  columnCount: number;
  columns: ColumnDoc[];
  relationships: {
    oneToMany: Array<Record<string, string>>;
    manyToOne: Array<Record<string, string>>;
    manyToMany: Array<Record<string, string>>;
  };
  keys: Array<{ name: string; attributes: string[] }>;
  automation?: {
    pluginSteps?: {
      count: number;
      top: Array<{ name: string; message: string; stage: string; mode: string }>;
    };
    cloudFlows?: { count: number; names: string[] };
  };
  markdown: string;
  columnsTruncated?: boolean;
  sectionNotes?: string[];
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

type QueryArg = { select?: string[]; filter?: string; expand?: string; top?: number };

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

describe("document_table input schema", () => {
  it("requires table and defaults includeAutomation to true", () => {
    expect(documentTableTool.inputSchema.safeParse({}).success).toBe(false);
    const parsed = documentTableTool.inputSchema.parse({ table: "account" });
    expect(parsed.includeAutomation).toBe(true);
    expect(
      documentTableTool.inputSchema.safeParse({ table: "" }).success,
    ).toBe(false);
  });
});

describe("documentTable happy path", () => {
  it("documents metadata, relationships, keys and automation", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("documentTable.entity.json"))
      .mockResolvedValueOnce(loadFixture("documentTable.filters.json"))
      .mockResolvedValueOnce(loadFixture("documentTable.steps.json"))
      .mockResolvedValueOnce(loadFixture("documentTable.flows.json"));

    const result = (await documentTable(client, {
      table: "account",
      includeAutomation: true,
    })) as DocumentResult;

    // Query shapes: metadata, message filters, steps (single chunk), flows.
    expect(get).toHaveBeenCalledTimes(4);
    const [metaPath, metaQuery] = callArgs(get, 0);
    expect(metaPath).toBe("EntityDefinitions(LogicalName='account')");
    expect(metaQuery.select).toContain("OwnershipType");
    expect(metaQuery.expand).toContain("Attributes($select=");
    expect(metaQuery.expand).toContain("Keys($select=LogicalName,KeyAttributes)");

    const [filtersPath, filtersQuery] = callArgs(get, 1);
    expect(filtersPath).toBe("sdkmessagefilters");
    expect(filtersQuery.filter).toBe("primaryobjecttypecode eq 'account'");
    expect(filtersQuery.top).toBe(200);

    const [stepsPath, stepsQuery] = callArgs(get, 2);
    expect(stepsPath).toBe("sdkmessageprocessingsteps");
    expect(stepsQuery.filter).toContain("statecode eq 0 and ");
    expect(stepsQuery.filter).toContain(
      "_sdkmessagefilterid_value eq dddddddd-0000-0000-0000-000000000001",
    );
    expect(stepsQuery.expand).toBe("sdkmessageid($select=name)");

    const [flowsPath, flowsQuery] = callArgs(get, 3);
    expect(flowsPath).toBe("workflows");
    expect(flowsQuery.filter).toBe(
      "category eq 5 and type eq 1 and statecode eq 1",
    );

    // Table header: labels extracted from the metadata label objects.
    expect(result.table.logicalName).toBe("account");
    expect(result.table.displayName).toBe("Account");
    expect(result.table.description).toContain("customer");
    expect(result.table.isCustom).toBe(false);
    expect(result.table.ownershipType).toBe("UserOwned");
    expect(result.table.primaryId).toBe("accountid");
    expect(result.table.primaryName).toBe("name");

    // 8 attributes, the Virtual one (entityimage_url) excluded.
    expect(result.columnCount).toBe(7);
    expect(result.columns.map((c) => c.logicalName)).not.toContain(
      "entityimage_url",
    );
    expect(result.columnsTruncated).toBeUndefined();

    const name = result.columns.find((c) => c.logicalName === "name");
    expect(name?.displayName).toBe("Account Name");
    expect(name?.required).toBe("ApplicationRequired");
    expect(name?.isCustom).toBe(false);

    // UserLocalizedLabel is null on ownerid: falls back to LocalizedLabels[0].
    const owner = result.columns.find((c) => c.logicalName === "ownerid");
    expect(owner?.displayName).toBe("Owner");

    // DisplayName null entirely: displayName key omitted.
    const state = result.columns.find((c) => c.logicalName === "statecode");
    expect(state).toBeDefined();
    expect(state?.displayName).toBeUndefined();

    // Long descriptions are trimmed to 200 chars.
    const revenue = result.columns.find((c) => c.logicalName === "revenue");
    expect(revenue?.description).toHaveLength(200);

    const custom = result.columns.find((c) => c.logicalName === "new_riskscore");
    expect(custom?.isCustom).toBe(true);
    expect(custom?.required).toBe("Recommended");

    expect(result.relationships.oneToMany).toHaveLength(2);
    expect(result.relationships.oneToMany[0]).toEqual({
      schemaName: "contact_customer_accounts",
      referencedEntity: "account",
      referencingEntity: "contact",
      referencingAttribute: "parentcustomerid",
    });
    expect(result.relationships.manyToOne).toEqual([
      {
        schemaName: "account_primary_contact",
        referencedEntity: "contact",
        referencingAttribute: "primarycontactid",
      },
    ]);
    expect(result.relationships.manyToMany).toEqual([
      {
        schemaName: "accountleads_association",
        entity1LogicalName: "account",
        entity2LogicalName: "lead",
      },
    ]);
    expect(result.keys).toEqual([
      { name: "account_number_key", attributes: ["accountnumber"] },
    ]);

    // Automation: 2 active steps with message from the expand + stage label;
    // 2 of 3 flows match ("account" trigger + "accounts" plural), contact
    // flow excluded.
    expect(result.automation?.pluginSteps?.count).toBe(2);
    expect(result.automation?.pluginSteps?.top[0]).toEqual({
      name: "Contoso.Plugins.AccountPlugin: Update of account",
      message: "Update",
      stage: "PreOperation",
      mode: "sync",
    });
    expect(result.automation?.pluginSteps?.top[1]?.mode).toBe("async");
    expect(result.automation?.cloudFlows?.count).toBe(2);
    expect(result.automation?.cloudFlows?.names).toEqual([
      "When an account is created, notify sales",
      "Daily account revenue rollup",
    ]);
    expect(result.sectionNotes).toBeUndefined();

    // Markdown: title, header line, a column row and automation counts.
    expect(result.markdown).toContain("# Account");
    expect(result.markdown).toContain(
      "| name | String | ApplicationRequired | Account Name |",
    );
    expect(result.markdown).toContain("Active plug-in steps: 2");
    expect(result.markdown).toContain(
      "Active cloud flows referencing this table: 2",
    );
    expect(result.markdown).not.toContain("…(truncated)");
  });

  it("makes only the metadata request when includeAutomation is false", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("documentTable.entity.json"));

    const result = (await documentTable(client, {
      table: "account",
      includeAutomation: false,
    })) as DocumentResult;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.automation).toBeUndefined();
    expect(result.markdown).not.toContain("## Automation");
    expect(result.columnCount).toBe(7);
  });

  it("caps columns at 300 and notes the remainder in markdown", async () => {
    const attributes = Array.from({ length: 350 }, (_, i) => ({
      LogicalName: `new_field${i}`,
      SchemaName: `new_Field${i}`,
      AttributeType: "String",
      DisplayName: {
        UserLocalizedLabel: { Label: `Field ${i}` },
        LocalizedLabels: [{ Label: `Field ${i}` }],
      },
      Description: null,
      RequiredLevel: { Value: "None" },
      IsCustomAttribute: true,
    }));
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({
      LogicalName: "new_widget",
      SchemaName: "new_Widget",
      DisplayName: null,
      Description: null,
      PrimaryIdAttribute: "new_widgetid",
      PrimaryNameAttribute: "new_name",
      IsCustomEntity: true,
      OwnershipType: "UserOwned",
      Attributes: attributes,
      OneToManyRelationships: [],
      ManyToOneRelationships: [],
      ManyToManyRelationships: [],
      Keys: [],
    });

    const result = (await documentTable(client, {
      table: "new_widget",
      includeAutomation: false,
    })) as DocumentResult;

    expect(result.columnCount).toBe(350);
    expect(result.columns).toHaveLength(300);
    expect(result.columnsTruncated).toBe(true);
    // Markdown table shows 100 rows and notes the remaining 250 columns.
    expect(result.markdown).toContain("…and 250 more columns.");
  });
});

describe("documentTable automation isolation", () => {
  it("keeps the metadata document when the step query fails, noting the section", async () => {
    const { client, get } = makeFakeClient();
    get
      .mockResolvedValueOnce(loadFixture("documentTable.entity.json"))
      .mockResolvedValueOnce(loadFixture("documentTable.filters.json"))
      .mockRejectedValueOnce(
        new DataverseHttpError(403, "prvReadSdkMessageProcessingStep missing"),
      )
      .mockResolvedValueOnce(loadFixture("documentTable.flows.json"));

    const result = (await documentTable(client, {
      table: "account",
      includeAutomation: true,
    })) as DocumentResult;

    // Not an error envelope: the table document survives the failed section.
    expect((result as unknown as Envelope).error).toBeUndefined();
    expect(result.table.logicalName).toBe("account");
    expect(result.automation?.pluginSteps).toBeUndefined();
    expect(result.automation?.cloudFlows?.count).toBe(2);
    expect(result.sectionNotes).toHaveLength(1);
    expect(result.sectionNotes?.[0]).toContain("Plug-in step summary unavailable");
    expect(result.sectionNotes?.[0]).toContain(
      "prvReadSdkMessageProcessingStep missing",
    );
    expect(result.markdown).toContain("Plug-in step summary unavailable");
  });
});

describe("documentTable failure modes", () => {
  it("maps a 404 to a table-not-found envelope with a logical-name hint", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(
        404,
        "Could not find an entity with the specified logical name.",
      ),
    );

    const result = (await documentTable(client, {
      table: "Accounts",
      includeAutomation: true,
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toBe('Table not found: "Accounts"');
    expect(result.hint).toContain("singular and lowercase");
  });

  it("maps a 400 to an envelope hinting at metadata $expand limitations", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(400, "Could not find a property named 'Keys'."),
    );

    const result = (await documentTable(client, {
      table: "account",
      includeAutomation: true,
    })) as Envelope;

    expect(result.error).toBe("Could not find a property named 'Keys'.");
    expect(result.hint).toContain("$expand");
    expect(result.docsUrl).toBe(METADATA_DOCS_URL);
  });

  it("maps a 403 to an envelope with a privilege hint and docsUrl", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(403, "Principal user is missing read privilege"),
    );

    const result = (await documentTable(client, {
      table: "account",
      includeAutomation: true,
    })) as Envelope;

    expect(result.error).toBe("Principal user is missing read privilege");
    expect(result.hint).toContain("System Customizer");
    expect(result.docsUrl).toBe(METADATA_DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await documentTable(client, {
      table: "account",
      includeAutomation: true,
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.hint).toBeUndefined();
    expect(result.docsUrl).toBeUndefined();
  });
});
