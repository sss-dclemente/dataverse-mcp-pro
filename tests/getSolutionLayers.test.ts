import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSolutionLayers,
  getSolutionLayersTool,
} from "../src/tools/getSolutionLayers.js";
import { DataverseHttpError, type DataverseClient } from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/maker/data-platform/solution-layers";

const FORM_ID = "12345678-1234-1234-1234-123456789abc";

function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

interface Layer {
  rank: number;
  solution: string;
  publisher: string;
  overwriteTime?: string;
  isActiveLayer: boolean;
}

interface Finding {
  severity: string;
  issue: string;
  recommendation: string;
}

interface LayersResult {
  component: { type: string; id: string; name: string | null };
  layerCount: number;
  layers: Layer[];
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

type QueryArg = { select?: string[]; filter?: string; orderby?: string };

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

describe("get_solution_layers pro gate", () => {
  it("returns the upgrade message and never touches Dataverse when unlicensed", async () => {
    vi.stubEnv("LICENSE_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await getSolutionLayersTool.handler({
      componentType: "SystemForm",
      componentId: FORM_ID,
    })) as { upgradeRequired?: boolean; tool?: string; message?: string };

    expect(result.upgradeRequired).toBe(true);
    expect(result.tool).toBe("get_solution_layers");
    expect(result.message).toContain("Pro");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("proceeds past the gate when LICENSE_KEY is set", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    // No DATAVERSE_URL: client construction fails after the gate, proving the
    // gate was passed without any network traffic.
    vi.stubEnv("DATAVERSE_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = (await getSolutionLayersTool.handler({
      componentType: "SystemForm",
      componentId: FORM_ID,
    })) as Envelope & { upgradeRequired?: boolean };

    expect(result.upgradeRequired).toBeUndefined();
    expect(result.error).toContain("DATAVERSE_URL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("get_solution_layers input schema", () => {
  it("requires both componentType and componentId", () => {
    const schema = getSolutionLayersTool.inputSchema;
    expect(
      schema.safeParse({ componentType: "SystemForm", componentId: FORM_ID })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ componentType: "SystemForm" }).success).toBe(false);
    expect(schema.safeParse({ componentId: FORM_ID }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("rejects a componentId that is not a uuid and an empty componentType", () => {
    const schema = getSolutionLayersTool.inputSchema;
    expect(
      schema.safeParse({ componentType: "SystemForm", componentId: "not-a-guid" })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ componentType: "", componentId: FORM_ID }).success,
    ).toBe(false);
  });
});

describe("getSolutionLayers happy path", () => {
  it("ranks layers top-first, flags the Active layer and builds the medium finding", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("solutionLayers.happy.json"));

    const result = (await getSolutionLayers(client, {
      componentType: "SystemForm",
      componentId: FORM_ID,
    })) as LayersResult;

    expect(get).toHaveBeenCalledTimes(1);
    const [path, query] = callArgs(get, 0);
    expect(path).toBe("msdyn_componentlayers");
    // The virtual table expects the guid in quoted form and both equality filters.
    expect(query.filter).toBe(
      `msdyn_solutioncomponentname eq 'SystemForm' and msdyn_componentid eq '${FORM_ID}'`,
    );
    expect(query.orderby).toBe("msdyn_order desc");
    expect(query.select).toEqual([
      "msdyn_componentlayerid",
      "msdyn_name",
      "msdyn_solutionname",
      "msdyn_publishername",
      "msdyn_order",
      "msdyn_overwritetime",
    ]);
    // msdyn_componentjson is huge and must never be requested.
    expect(query.select).not.toContain("msdyn_componentjson");

    expect(result.component).toEqual({
      type: "SystemForm",
      id: FORM_ID,
      name: "Account Main Form",
    });
    expect(result.layerCount).toBe(3);
    expect(result.layers.map((l) => l.rank)).toEqual([1, 2, 3]);
    expect(result.layers.map((l) => l.solution)).toEqual([
      "Active",
      "ContosoSales",
      "ContosoBase",
    ]);
    expect(result.layers.map((l) => l.isActiveLayer)).toEqual([
      true,
      false,
      false,
    ]);
    expect(result.layers[0]?.publisher).toBe("Default Publisher");
    // Real overwrite times pass through; the 1900 sentinel is dropped.
    expect(result.layers[0]?.overwriteTime).toBe("2026-05-14T09:30:00Z");
    expect(result.layers[1]?.overwriteTime).toBe("2026-02-01T12:00:00Z");
    expect(result.layers[2]?.overwriteTime).toBeUndefined();

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0] as Finding;
    expect(finding.severity).toBe("medium");
    expect(finding.issue).toBe(
      "Unmanaged 'Active' layer overrides 2 managed layer(s)",
    );
    expect(finding.recommendation).toContain("Remove the unmanaged layer");
    expect(result.hint).toBeUndefined();
  });
});

describe("getSolutionLayers layering findings", () => {
  it("flags deep layering (> 3 layers) without an Active-layer finding", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("solutionLayers.deep.json"));

    const result = (await getSolutionLayers(client, {
      componentType: "Entity",
      componentId: FORM_ID,
    })) as LayersResult;

    expect(result.layerCount).toBe(5);
    expect(result.layers.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.layers.every((l) => !l.isActiveLayer)).toBe(true);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0] as Finding;
    expect(finding.severity).toBe("low");
    expect(finding.issue).toContain("Deep layering");
    expect(finding.recommendation).toContain("upgrade-order fragility");
    // null overwritetime is omitted, not emitted as null.
    expect(result.layers[4]?.overwriteTime).toBeUndefined();
  });

  it("returns no findings for a single-layer component", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce(loadFixture("solutionLayers.single.json"));

    const result = (await getSolutionLayers(client, {
      componentType: "WebResource",
      componentId: FORM_ID,
    })) as LayersResult;

    expect(result.layerCount).toBe(1);
    expect(result.layers[0]?.rank).toBe(1);
    expect(result.layers[0]?.isActiveLayer).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.hint).toBeUndefined();
  });

  it("returns a spelling hint (and escapes the type name) when no layers are found", async () => {
    const { client, get } = makeFakeClient();
    get.mockResolvedValueOnce({ value: [] });

    const result = (await getSolutionLayers(client, {
      componentType: "System'Form",
      componentId: FORM_ID,
    })) as LayersResult;

    expect(callArgs(get, 0)[1].filter).toBe(
      `msdyn_solutioncomponentname eq 'System''Form' and msdyn_componentid eq '${FORM_ID}'`,
    );
    expect(result.layerCount).toBe(0);
    expect(result.layers).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.component.name).toBeNull();
    expect(result.hint).toContain("check the componentType spelling");
  });
});

describe("getSolutionLayers failure modes", () => {
  it("maps a 404 to an envelope hinting the virtual table is unavailable", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(
        404,
        "Resource not found for the segment 'msdyn_componentlayers'.",
      ),
    );

    const result = (await getSolutionLayers(client, {
      componentType: "SystemForm",
      componentId: FORM_ID,
    })) as Envelope;

    expect(result.error).toContain("msdyn_componentlayers");
    expect(result.hint).toContain(
      "msdyn_componentlayer virtual table is not available",
    );
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 400 to an envelope explaining the required equality filters", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(
        400,
        "The query specified is not valid for the msdyn_componentlayer entity.",
      ),
    );

    const result = (await getSolutionLayers(client, {
      componentType: "Form",
      componentId: FORM_ID,
    })) as Envelope;

    expect(result.error).toContain("not valid");
    expect(result.hint).toContain("BOTH");
    expect(result.hint).toContain("msdyn_solutioncomponentname");
    expect(result.hint).toContain("msdyn_componentid");
    expect(result.hint).toContain("exact component type name");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("maps a 403 to an envelope with a customizer-privilege hint", async () => {
    const fixture = loadFixture<{ status: number; message: string }>(
      "solutionLayers.error403.json",
    );
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(
      new DataverseHttpError(fixture.status, fixture.message),
    );

    const result = (await getSolutionLayers(client, {
      componentType: "SystemForm",
      componentId: FORM_ID,
    })) as Envelope;

    expect(result.error).toBe(fixture.message);
    expect(result.hint).toContain("System Customizer");
    expect(result.docsUrl).toBe(DOCS_URL);
  });

  it("wraps unexpected errors in a generic envelope instead of throwing", async () => {
    const { client, get } = makeFakeClient();
    get.mockRejectedValueOnce(new Error("socket hang up"));

    const result = (await getSolutionLayers(client, {
      componentType: "SystemForm",
      componentId: FORM_ID,
    })) as Envelope;

    expect(result.error).toBe("socket hang up");
    expect(result.hint).toBeUndefined();
    expect(result.docsUrl).toBeUndefined();
  });
});
