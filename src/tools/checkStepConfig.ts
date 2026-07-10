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

const BEST_PRACTICES_DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/";

// solutioncomponents.componenttype 92 = SDK Message Processing Step.
const STEP_COMPONENT_TYPE = 92;
// Keep OData $filter clauses well below URL-length limits when expanding a
// solution's step ids into `id eq guid or ...` chains.
const STEP_ID_CHUNK_SIZE = 25;

// Entities where synchronous Create/Update plug-ins hurt org-wide throughput.
const HIGH_VOLUME_ENTITIES = new Set(["activitypointer", "annotation"]);

const inputSchema = z.object({
  pluginTypeName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Plug-in type name to analyze, e.g. 'Contoso.Plugins.AccountPlugin'. " +
        "Matched exactly first, then as a substring.",
    ),
  solutionName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Unique name (uniquename, not display name) of a solution whose SDK " +
        "message processing steps should be analyzed.",
    ),
});

export type CheckStepConfigInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

interface RawStepImage {
  imagetype: number;
  name?: string | null;
  entityalias?: string | null;
  attributes?: string | null;
}

interface RawStep {
  sdkmessageprocessingstepid: string;
  name?: string | null;
  stage: number;
  mode: number;
  rank: number;
  filteringattributes?: string | null;
  statecode: number;
  sdkmessageid?: { name?: string | null } | null;
  sdkmessagefilterid?: { primaryobjecttypecode?: string | null } | null;
  plugintypeid?: { typename?: string | null } | null;
  sdkmessageprocessingstepid_sdkmessageprocessingstepimage?: RawStepImage[];
}

interface StepSummary {
  id: string;
  name: string;
  pluginType: string;
  message: string;
  entity: string;
  stage: string;
  mode: "sync" | "async";
  rank: number;
  filteringAttributes: string | null;
}

interface Finding {
  severity: "high" | "medium" | "low";
  step: StepSummary;
  issue: string;
  recommendation: string;
}

function stageLabel(stage: number): string {
  switch (stage) {
    case 10:
      return "PreValidation";
    case 20:
      return "PreOperation";
    case 40:
      return "PostOperation";
    default:
      return String(stage);
  }
}

function toStepSummary(raw: RawStep): StepSummary {
  const filtering = raw.filteringattributes ?? null;
  return {
    id: raw.sdkmessageprocessingstepid,
    name: raw.name ?? "(unnamed step)",
    pluginType: raw.plugintypeid?.typename ?? "unknown",
    message: raw.sdkmessageid?.name ?? "unknown",
    entity: raw.sdkmessagefilterid?.primaryobjecttypecode ?? "none",
    stage: stageLabel(raw.stage),
    mode: raw.mode === 1 ? "async" : "sync",
    rank: raw.rank,
    filteringAttributes:
      filtering !== null && filtering.trim() !== "" ? filtering : null,
  };
}

function analyzeSteps(rawSteps: RawStep[]): Finding[] {
  const findings: Finding[] = [];
  const summaries = rawSteps.map((raw) => ({ raw, step: toStepSummary(raw) }));

  for (const { raw, step } of summaries) {
    const message = step.message.toLowerCase();

    if (message === "update" && step.filteringAttributes === null) {
      findings.push({
        severity: "high",
        step,
        issue:
          "Update step without filtering attributes fires on every column change.",
        recommendation:
          "Set filtering attributes so the step only runs when the columns it cares about change.",
      });
    }

    if (
      step.mode === "sync" &&
      (message === "create" || message === "update") &&
      HIGH_VOLUME_ENTITIES.has(step.entity)
    ) {
      findings.push({
        severity: "medium",
        step,
        issue:
          `Synchronous ${step.message} step on high-volume entity ` +
          `"${step.entity}" adds latency to every ${message} in the org.`,
        recommendation:
          "Register the step asynchronously, or narrow its scope so high-volume operations are not slowed down.",
      });
    }

    if (message === "update" || message === "delete") {
      // imagetype: 0 = PreImage, 1 = PostImage, 2 = Both.
      const images =
        raw.sdkmessageprocessingstepid_sdkmessageprocessingstepimage ?? [];
      const hasPreImage = images.some(
        (img) => img.imagetype === 0 || img.imagetype === 2,
      );
      if (!hasPreImage) {
        findings.push({
          severity: "low",
          step,
          issue: `${step.message} step has no pre-image registered; comparing old vs new values requires one.`,
          recommendation:
            "Register a PreImage containing only the attributes the plug-in actually needs.",
        });
      }
    }
  }

  // Rank collisions: same message + entity + stage + rank means execution
  // order between the steps is not deterministic.
  const rankGroups = new Map<string, StepSummary[]>();
  for (const { step } of summaries) {
    const key = `${step.message}|${step.entity}|${step.stage}|${step.rank}`;
    const group = rankGroups.get(key);
    if (group === undefined) rankGroups.set(key, [step]);
    else group.push(step);
  }
  for (const group of rankGroups.values()) {
    const first = group[0];
    if (group.length < 2 || first === undefined) continue;
    findings.push({
      severity: "medium",
      step: first,
      issue:
        `Rank collision: steps ${group.map((s) => `"${s.name}"`).join(", ")} ` +
        `share message "${first.message}", entity "${first.entity}", stage ` +
        `${first.stage} and rank ${first.rank}; their relative execution order is not guaranteed.`,
      recommendation:
        "Assign distinct ranks to these steps for deterministic execution ordering.",
    });
  }

  const severityOrder: Record<Finding["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return findings;
}

const STEP_SELECT = [
  "sdkmessageprocessingstepid",
  "name",
  "stage",
  "mode",
  "rank",
  "filteringattributes",
  "statecode",
];

const STEP_EXPAND =
  "sdkmessageid($select=name)," +
  "sdkmessagefilterid($select=primaryobjecttypecode)," +
  "plugintypeid($select=typename)," +
  "sdkmessageprocessingstepid_sdkmessageprocessingstepimage($select=imagetype,name,entityalias,attributes)";

async function fetchActiveSteps(
  client: Pick<DataverseClient, "get">,
  scopeFilter: string,
): Promise<RawStep[]> {
  const res = await client.get<ListResponse<RawStep>>(
    "sdkmessageprocessingsteps",
    {
      select: STEP_SELECT,
      filter: `statecode eq 0 and ${scopeFilter}`,
      expand: STEP_EXPAND,
    },
  );
  return res.value;
}

type ScopeResult =
  | { kind: "steps"; steps: RawStep[] }
  | { kind: "early"; result: unknown };

async function resolvePluginTypeSteps(
  client: Pick<DataverseClient, "get">,
  pluginTypeName: string,
): Promise<ScopeResult> {
  const escaped = escapeODataString(pluginTypeName);
  const select = ["plugintypeid", "typename"];
  let types = await client.get<ListResponse<{ plugintypeid: string }>>(
    "plugintypes",
    { select, filter: `typename eq '${escaped}'` },
  );
  if (types.value.length === 0) {
    types = await client.get<ListResponse<{ plugintypeid: string }>>(
      "plugintypes",
      { select, filter: `contains(typename,'${escaped}')` },
    );
  }
  if (types.value.length === 0) {
    return {
      kind: "early",
      result: {
        stepsAnalyzed: 0,
        findings: [],
        hint: `No plug-in type matching "${pluginTypeName}" was found. Check the fully-qualified type name (namespace.class).`,
      },
    };
  }
  const idFilter = types.value
    .map((t) => `_plugintypeid_value eq ${t.plugintypeid}`)
    .join(" or ");
  return { kind: "steps", steps: await fetchActiveSteps(client, `(${idFilter})`) };
}

async function resolveSolutionSteps(
  client: Pick<DataverseClient, "get">,
  solutionName: string,
): Promise<ScopeResult> {
  const escaped = escapeODataString(solutionName);
  const solutions = await client.get<ListResponse<{ solutionid: string }>>(
    "solutions",
    { select: ["solutionid"], filter: `uniquename eq '${escaped}'` },
  );
  const solution = solutions.value[0];
  if (solution === undefined) {
    return {
      kind: "early",
      result: errorEnvelope(`Solution not found: "${solutionName}"`, {
        hint: "Pass the solution's unique name (uniquename), not its display name. Check spelling and casing.",
      }),
    };
  }

  const components = await client.get<ListResponse<{ objectid: string }>>(
    "solutioncomponents",
    {
      select: ["objectid"],
      filter: `_solutionid_value eq ${solution.solutionid} and componenttype eq ${STEP_COMPONENT_TYPE}`,
    },
  );
  if (components.value.length === 0) {
    return {
      kind: "early",
      result: {
        stepsAnalyzed: 0,
        findings: [],
        hint: `Solution "${solutionName}" contains no plug-in steps.`,
      },
    };
  }

  const ids = components.value.map((c) => c.objectid);
  const steps: RawStep[] = [];
  for (let i = 0; i < ids.length; i += STEP_ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + STEP_ID_CHUNK_SIZE);
    const idFilter = chunk
      .map((id) => `sdkmessageprocessingstepid eq ${id}`)
      .join(" or ");
    steps.push(...(await fetchActiveSteps(client, `(${idFilter})`)));
  }
  return { kind: "steps", steps };
}

export async function analyzeStepConfig(
  client: Pick<DataverseClient, "get">,
  input: CheckStepConfigInput,
): Promise<unknown> {
  const { pluginTypeName, solutionName } = input;
  // The MCP server registers inputSchema.shape, so an object-level .refine()
  // would not be enforced at the transport. Guard here instead.
  if (pluginTypeName === undefined && solutionName === undefined) {
    return errorEnvelope("Provide pluginTypeName or solutionName", {
      hint: "Scope the analysis with either a plug-in type name (e.g. 'Contoso.Plugins.AccountPlugin') or a solution unique name.",
    });
  }

  try {
    // When both are supplied, pluginTypeName wins (narrower scope).
    const scope =
      pluginTypeName !== undefined
        ? await resolvePluginTypeSteps(client, pluginTypeName)
        : await resolveSolutionSteps(client, solutionName ?? "");
    if (scope.kind === "early") return scope.result;

    const findings = analyzeSteps(scope.steps);
    return { stepsAnalyzed: scope.steps.length, findings };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading step registrations requires customizer-level read privileges on " +
          "SdkMessageProcessingStep (and related SDK message tables). Ask an admin " +
          "to grant the System Customizer role or equivalent read privileges.",
        docsUrl: BEST_PRACTICES_DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const checkStepConfig = defineTool({
  name: "check_step_config",
  description:
    "Analyze Dataverse plug-in step registrations (SdkMessageProcessingStep) for " +
    "common misconfigurations: Update steps without filtering attributes, " +
    "synchronous steps on high-volume entities, missing pre-images, and rank " +
    "collisions. Scope by plug-in type name or solution unique name. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("check_step_config");
    try {
      return await analyzeStepConfig(getDefaultClient(), input);
    } catch (err) {
      // analyzeStepConfig traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
