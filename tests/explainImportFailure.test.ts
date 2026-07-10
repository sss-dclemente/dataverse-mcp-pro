import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explainImportFailure,
  explainImportFailureTool,
} from "../src/tools/explainImportFailure.js";
import {
  DataverseHttpError,
  type DataverseClient,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/maker/data-platform/solutions-overview";

const JOB_SELECT = [
  "importjobid",
  "solutionname",
  "progress",
  "startedon",
  "completedon",
  "data",
  "createdon",
];

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

/** Load a job fixture, splicing in the result XML held in a sibling .xml file. */
function loadJob(jsonName: string, xmlName?: string): Record<string, unknown> {
  const job = loadFixture<Record<string, unknown>>(jsonName);
  if (xmlName !== undefined) {
    job["data"] = readFileSync(
      new URL(`./fixtures/${xmlName}`, import.meta.url),
      "utf8",
    );
  }
  return job;
}

interface FailedComponent {
  componentType: string;
  schemaName: string;
  errorCode: string;
  errorText: string;
  cause: string;
  advice?: string;
  providedBy?: string;
}

interface ExplainResult {
  importJobId: string;
  solutionName: string;
  progress: number;
  startedon: string | null;
  completedon: string | null;
  failedCount: number;
  warningCount: number;
  failedComponents: FailedComponent[];
  resolutionOrder: string[];
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

type QueryArg = {
  select?: string[];
  filter?: string;
  orderby?: string;
  top?: number;
};

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

describe("explain_import_failure pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await explainImportFailureTool.handler({})) as {
      upgradeRequired?: boolean;
      tool?: string;
      message?: string;
    };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("explain_import_failure");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    vi.stubEnv("DATAVERSE_URL", "https://org.crm.dynamics.com");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // No scope input: reaches the core function's input guard, not the gate.
    const result = (await explainImportFailureTool.handler({})) as Envelope & {
      upgradeRequired?: boolean;
    };

    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toBe("Provide importJobId or solutionName");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("explainImportFailure input guard", () => {
  it("returns an error envelope and makes no request when both inputs are missing", async () => {
    const { client, get } = makeFakeClient();

    const result = (await explainImportFailure(client, {})) as Envelope;

    expect(result.error).toBe("Provide importJobId or solutionName");
    expect(result.hint).toBeDefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("explainImportFailure by importJobId", () => {
  it("parses failures, maps causes, decodes entities and orders resolution steps", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadJob("importJob.failed.json", "importJob.failed.xml"));

    const result = (await explainImportFailure(client, {
      importJobId: "aaaaaaaa-1111-2222-3333-444444444444",
    })) as ExplainResult;

    expect(get).toHaveBeenCalledTimes(1);
    const [path, query] = callArgs(get, 0);
    expect(path).toBe("importjobs(aaaaaaaa-1111-2222-3333-444444444444)");
    expect(query.select).toEqual(JOB_SELECT);

    expect(result.importJobId).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(result.solutionName).toBe("ContosoSales");
    expect(result.progress).toBe(87.5);
    expect(result.failedCount).toBe(4);
    expect(result.warningCount).toBe(1);
    expect(result.hint).toBeUndefined();
    expect(result.failedComponents).toHaveLength(4);

    const [widget, gadgetId, webResource, step] = result.failedComponents as [
      FailedComponent,
      FailedComponent,
      FailedComponent,
      FailedComponent,
    ];

    // Missing dependency on an entity: providedBy extracted from errortext,
    // XML entities (&quot; &amp;) decoded.
    expect(widget.componentType).toBe("entity");
    expect(widget.schemaName).toBe("contoso_widget");
    expect(widget.errorCode).toBe("0x80048264");
    expect(widget.errorText).toContain('"contoso_gadget"');
    expect(widget.errorText).toContain('"Contoso Base" & must be installed');
    expect(widget.cause).toContain("missing dependency");
    expect(widget.providedBy).toBe("Contoso Base");
    expect(widget.advice).toContain("Import or update solution 'Contoso Base'");

    // Second missing dependency, same providing solution.
    expect(gadgetId.componentType).toBe("attribute");
    expect(gadgetId.schemaName).toBe("contoso_gadgetid");
    expect(gadgetId.errorCode).toBe("0x80048264");
    expect(gadgetId.providedBy).toBe("Contoso Base");

    // Unmanaged layer conflict (errorcode matched case-insensitively).
    expect(webResource.componentType).toBe("webresource");
    expect(webResource.schemaName).toBe("contoso_/scripts/main.js");
    expect(webResource.errorCode).toBe("0x8004f036");
    expect(webResource.cause).toContain("unmanaged customization layer");
    expect(webResource.advice).toContain("Remove the unmanaged layer");
    expect(webResource.providedBy).toBeUndefined();

    // Unknown code: cause falls back to (truncated) errortext, no advice.
    expect(step.componentType).toBe("sdkmessageprocessingstep");
    expect(step.schemaName).toBe("Contoso.Plugins.Step");
    expect(step.errorCode).toBe("0xdeadbeef");
    expect(step.errorText).toHaveLength(300);
    expect(step.cause).toBe(step.errorText);
    expect(step.advice).toBeUndefined();

    // Dependencies first, deduplicated (two 0x80048264 failures -> one step).
    expect(result.resolutionOrder).toHaveLength(3);
    expect(result.resolutionOrder[0]).toBe(
      "Import or update solution 'Contoso Base' which provides 'contoso_gadget'.",
    );
    expect(
      result.resolutionOrder.filter((s) => s.includes("Contoso Base")),
    ).toHaveLength(1);
    expect(result.resolutionOrder[1]).toContain(
      "Fix webresource 'contoso_/scripts/main.js'",
    );
    expect(result.resolutionOrder[2]).toContain(
      "Fix sdkmessageprocessingstep 'Contoso.Plugins.Step'",
    );
  });
});

describe("explainImportFailure by solutionName", () => {
  it("queries the latest import job with an escaped filter, orderby and top 1", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({
      value: [loadJob("importJob.failed.json", "importJob.failed.xml")],
    });

    const result = (await explainImportFailure(client, {
      solutionName: "O'Brien Solutions",
    })) as ExplainResult;

    expect(get).toHaveBeenCalledTimes(1);
    const [path, query] = callArgs(get, 0);
    expect(path).toBe("importjobs");
    expect(query.select).toEqual(JOB_SELECT);
    expect(query.filter).toBe("solutionname eq 'O''Brien Solutions'");
    expect(query.orderby).toBe("createdon desc");
    expect(query.top).toBe(1);

    expect(result.failedCount).toBe(4);
  });

  it("returns an error envelope when no import job exists for the solution", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: [] });

    const result = (await explainImportFailure(client, {
      solutionName: "never_imported",
    })) as Envelope;

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.error).toContain(
      'No import job found for solution "never_imported"',
    );
    expect(result.hint).toContain("unique name");
    expect(result.hint).toContain("purged");
  });
});

describe("explainImportFailure success and in-progress imports", () => {
  it("reports zero failures with a completed hint for a clean import at 100%", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(
      loadJob("importJob.success.json", "importJob.success.xml"),
    );

    const result = (await explainImportFailure(client, {
      importJobId: "bbbbbbbb-1111-2222-3333-444444444444",
    })) as ExplainResult;

    expect(result.failedCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.failedComponents).toEqual([]);
    expect(result.resolutionOrder).toEqual([]);
    expect(result.hint).toBe("Import completed without component failures.");
  });

  it("hints that the import may still be running when progress is below 100", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(
      loadJob("importJob.running.json", "importJob.success.xml"),
    );

    const result = (await explainImportFailure(client, {
      importJobId: "cccccccc-1111-2222-3333-444444444444",
    })) as ExplainResult;

    expect(result.failedCount).toBe(0);
    expect(result.hint).toContain("may still be running");
    expect(result.hint).toContain("42");
  });
});

describe("explainImportFailure failure modes", () => {
  it("maps a 404 on the job id to a not-found envelope", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new DataverseHttpError(404, "Not Found"));

    const result = (await explainImportFailure(client, {
      importJobId: "aaaaaaaa-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toContain("Import job not found");
    expect(result.hint).toContain("purged");
  });

  it("maps a 403 to an envelope with a privilege hint and docsUrl", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(
        403,
        "Principal user is missing prvReadImportJob privilege.",
      ),
    );

    const result = (await explainImportFailure(client, {
      importJobId: "aaaaaaaa-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toBe(
      "Principal user is missing prvReadImportJob privilege.",
    );
    expect(result.hint).toContain("ImportJob");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("returns an envelope when the job data contains no result nodes", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadJob("importJob.unparseable.json"));

    const result = (await explainImportFailure(client, {
      importJobId: "dddddddd-1111-2222-3333-444444444444",
    })) as Envelope;

    expect(result.error).toBe("Import job contains no parseable result data");
    expect(result.hint).toContain("still be running");
    expect(result.hint).toContain("10");
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await explainImportFailure(client, {
      solutionName: "ContosoSales",
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.docsUrl).toBeUndefined();
  });
});
