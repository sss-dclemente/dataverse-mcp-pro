import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";
import { isProLicensed, proUpgradeMessage } from "../licensing.js";
import {
  DataverseHttpError,
  escapeODataString,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const SOLUTION_LAYERS_DOCS_URL =
  "https://learn.microsoft.com/power-apps/maker/data-platform/solution-layers";

const inputSchema = z.object({
  componentType: z
    .string()
    .min(1)
    .describe(
      "Solution component type name exactly as the msdyn_componentlayer " +
        "virtual table expects it, e.g. 'Entity', 'Attribute', 'Workflow', " +
        "'SystemForm', 'SavedQuery', 'WebResource'.",
    ),
  componentId: z
    .string()
    .uuid()
    .describe(
      "GUID of the component itself (e.g. the formid of a SystemForm), " +
        "not the id of a solution.",
    ),
});

export type GetSolutionLayersInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

interface RawLayer {
  msdyn_componentlayerid: string;
  msdyn_name?: string | null;
  msdyn_solutionname?: string | null;
  msdyn_publishername?: string | null;
  msdyn_order?: number | null;
  msdyn_overwritetime?: string | null;
}

// msdyn_componentjson is deliberately absent: it holds the full serialized
// component definition and can be enormous. Never select or return it.
const LAYER_SELECT = [
  "msdyn_componentlayerid",
  "msdyn_name",
  "msdyn_solutionname",
  "msdyn_publishername",
  "msdyn_order",
  "msdyn_overwritetime",
];

interface Layer {
  rank: number;
  solution: string;
  publisher: string;
  overwriteTime?: string;
  isActiveLayer: boolean;
}

interface Finding {
  severity: "high" | "medium" | "low";
  issue: string;
  recommendation: string;
}

/** Dataverse reports "never overwritten" as a null or epoch/1900 sentinel. */
function normalizeOverwriteTime(
  value: string | null | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return value;
}

function toLayer(raw: RawLayer, rank: number): Layer {
  const overwriteTime = normalizeOverwriteTime(raw.msdyn_overwritetime);
  return {
    rank,
    solution: raw.msdyn_solutionname ?? "unknown",
    publisher: raw.msdyn_publishername ?? "unknown",
    ...(overwriteTime !== undefined ? { overwriteTime } : {}),
    isActiveLayer: raw.msdyn_solutionname === "Active",
  };
}

function analyzeLayers(layers: Layer[]): Finding[] {
  const findings: Finding[] = [];
  const top = layers[0];
  if (layers.length > 1 && top !== undefined && top.isActiveLayer) {
    findings.push({
      severity: "medium",
      issue:
        `Unmanaged 'Active' layer overrides ${layers.length - 1} managed layer(s)`,
      recommendation:
        "Remove the unmanaged layer (Solution Layers > Remove active customizations) " +
        "so managed solution updates reach this component",
    });
  }
  if (layers.length > 3) {
    findings.push({
      severity: "low",
      issue: `Deep layering: ${layers.length} layers on this component`,
      recommendation:
        "Many solutions customize this component, which makes the result depend on " +
        "solution upgrade order (upgrade-order fragility). Consolidate customizations " +
        "into fewer solutions where possible.",
    });
  }
  return findings;
}

export async function getSolutionLayers(
  client: Pick<DataverseClient, "get">,
  input: GetSolutionLayersInput,
): Promise<unknown> {
  const { componentType, componentId } = input;
  try {
    const res = await client.get<ListResponse<RawLayer>>(
      "msdyn_componentlayers",
      {
        select: LAYER_SELECT,
        // Unlike regular lookup columns, the msdyn_componentlayer virtual
        // table expects the componentid GUID in the QUOTED string form.
        filter:
          `msdyn_solutioncomponentname eq '${escapeODataString(componentType)}' ` +
          `and msdyn_componentid eq '${componentId}'`,
        orderby: "msdyn_order desc",
      },
    );

    // Defensive re-sort: rank 1 must be the winning (top) layer even if the
    // virtual table ignores $orderby.
    const sorted = [...res.value].sort(
      (a, b) => (b.msdyn_order ?? 0) - (a.msdyn_order ?? 0),
    );
    const layers = sorted.map((raw, index) => toLayer(raw, index + 1));
    const top = sorted[0];

    const result = {
      component: {
        type: componentType,
        id: componentId,
        name: top?.msdyn_name ?? null,
      },
      layerCount: layers.length,
      layers,
      findings: analyzeLayers(layers),
    };
    if (layers.length === 0) {
      return {
        ...result,
        hint:
          "No layers found — check the componentType spelling (e.g. Entity, " +
          "SystemForm) and that the id is the component's id, not the solution's",
      };
    }
    return result;
  } catch (err) {
    if (err instanceof DataverseHttpError) {
      if (err.status === 404) {
        return errorEnvelope(err.dataverseMessage ?? err.message, {
          hint:
            "The msdyn_componentlayer virtual table is not available in this " +
            "environment. It requires a modern Dataverse environment with the " +
            "solution-layers feature enabled.",
          docsUrl: SOLUTION_LAYERS_DOCS_URL,
        });
      }
      if (err.status === 400) {
        return errorEnvelope(err.dataverseMessage ?? err.message, {
          hint:
            "The msdyn_componentlayer virtual table only answers filtered queries: " +
            "it requires BOTH a componentType (msdyn_solutioncomponentname) and a " +
            "componentId (msdyn_componentid) equality filter, and the type must be " +
            "an exact component type name such as 'Entity', 'Attribute', " +
            "'Workflow', 'SystemForm', 'SavedQuery' or 'WebResource'.",
          docsUrl: SOLUTION_LAYERS_DOCS_URL,
        });
      }
      if (err.status === 403) {
        return errorEnvelope(err.dataverseMessage ?? err.message, {
          hint:
            "Reading solution layers requires customizer-level privileges. Ask an " +
            "admin to grant the System Customizer role or equivalent read " +
            "privileges on solution components.",
          docsUrl: SOLUTION_LAYERS_DOCS_URL,
        });
      }
    }
    return toErrorEnvelope(err);
  }
}

export const getSolutionLayersTool = defineTool({
  name: "get_solution_layers",
  description:
    "Show the solution layering of one Dataverse component — who overwrote my " +
    "form: lists every solution layer on the component from the winning (top) " +
    "layer down, flags an unmanaged 'Active' layer that blocks managed updates " +
    "and deep layer stacks. Requires the component type name (e.g. 'Entity', " +
    "'SystemForm', 'WebResource') and the component's GUID. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("get_solution_layers");
    try {
      return await getSolutionLayers(getDefaultClient(), input);
    } catch (err) {
      // getSolutionLayers traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
