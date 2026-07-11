import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope, type ErrorEnvelope } from "../errors.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import { parseExceptionDetails, type ParsedException } from "./exceptionParser.js";
import { detectPatterns, type DetectedPattern } from "./patterns.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

const RAW_EXCERPT_MAX_CHARS = 1500;
const MESSAGE_BLOCK_EXCERPT_MAX_CHARS = 500;
const PIPELINE_TOP = 50;

const inputSchema = z.object({
  traceId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "plugintracelogid (GUID) of the trace to explain. Takes precedence over " +
        "correlationId when both are supplied.",
    ),
  correlationId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Correlation id (GUID) of a pipeline execution; the deepest failing trace " +
        "in that correlation is analyzed.",
    ),
});

export type ExplainTraceInput = z.infer<typeof inputSchema>;

// Unlike get_plugin_traces, this tool deliberately selects messageblock: pattern
// detection needs the plug-in's own trace output. Only a 500-char excerpt is
// ever returned to the host.
const TRACE_SELECT = [
  "plugintracelogid",
  "createdon",
  "typename",
  "messagename",
  "primaryentity",
  "depth",
  "mode",
  "performanceexecutionduration",
  "exceptiondetails",
  "messageblock",
  "correlationid",
  "pluginstepid",
];

const PIPELINE_SELECT = [
  "plugintracelogid",
  "typename",
  "messagename",
  "primaryentity",
  "depth",
  "mode",
  "performanceexecutionduration",
  "createdon",
  "exceptiondetails",
];

const STEP_SELECT = ["name", "stage", "mode", "rank", "filteringattributes"];

const STEP_EXPAND =
  "sdkmessageid($select=name)," +
  "sdkmessagefilterid($select=primaryobjecttypecode)," +
  "sdkmessageprocessingstepid_sdkmessageprocessingstepimage($select=name,entityalias,imagetype,attributes)";

interface RawTrace {
  plugintracelogid?: string;
  createdon?: string;
  typename?: string | null;
  messagename?: string | null;
  primaryentity?: string | null;
  depth?: number | null;
  mode?: number | null;
  performanceexecutionduration?: number | null;
  exceptiondetails?: string | null;
  messageblock?: string | null;
  correlationid?: string | null;
  pluginstepid?: string | null;
}

interface RawStepImage {
  name?: string | null;
  entityalias?: string | null;
  imagetype?: number | null;
  attributes?: string | null;
}

interface RawStep {
  name?: string | null;
  stage?: number | null;
  mode?: number | null;
  rank?: number | null;
  filteringattributes?: string | null;
  sdkmessageid?: { name?: string | null } | null;
  sdkmessagefilterid?: { primaryobjecttypecode?: string | null } | null;
  sdkmessageprocessingstepid_sdkmessageprocessingstepimage?: RawStepImage[];
}

interface StepImage {
  name: string | null;
  entityAlias: string | null;
  imageType: string;
  attributes: string | null;
}

interface StepConfig {
  id: string;
  name: string;
  message: string;
  entity: string;
  stage: string;
  mode: "sync" | "async";
  rank: number | null;
  filteringAttributes: string | null;
  images: StepImage[];
}

interface PipelineEntry {
  id: string | null;
  pluginType: string | null;
  messageName: string | null;
  primaryEntity: string | null;
  depth: number | null;
  mode: "sync" | "async";
  durationMs: number | null;
  failed: boolean;
  isFocus: boolean;
}

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

function normalizeGuid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === EMPTY_GUID) return null;
  return trimmed;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function modeLabel(mode: number | null | undefined): "sync" | "async" {
  return mode === 1 ? "async" : "sync";
}

function stageLabel(stage: number | null | undefined): string {
  switch (stage) {
    case 10:
      return "PreValidation";
    case 20:
      return "PreOperation";
    case 40:
      return "PostOperation";
    default:
      return String(stage ?? "unknown");
  }
}

// imagetype: 0 = PreImage, 1 = PostImage, 2 = Both.
function imageTypeLabel(imageType: number | null | undefined): string {
  switch (imageType) {
    case 0:
      return "PreImage";
    case 1:
      return "PostImage";
    case 2:
      return "Both";
    default:
      return String(imageType ?? "unknown");
  }
}

type FocusResult = { trace: RawTrace } | { envelope: ErrorEnvelope };

async function fetchFocusByTraceId(
  client: Pick<DataverseClient, "get">,
  traceId: string,
): Promise<FocusResult> {
  try {
    const trace = await client.get<RawTrace>(`plugintracelogs(${traceId})`, {
      select: TRACE_SELECT,
    });
    return { trace };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 404) {
      return {
        envelope: errorEnvelope("Trace not found", {
          hint:
            "Plug-in trace logs are purged frequently, so this id may already be gone. " +
            "Use get_plugin_traces to list recent traces and pick a current plugintracelogid.",
        }),
      };
    }
    throw err;
  }
}

async function fetchFocusByCorrelationId(
  client: Pick<DataverseClient, "get">,
  correlationId: string,
): Promise<FocusResult> {
  // correlationid is a uniqueidentifier attribute: GUID literals are unquoted.
  const res = await client.get<{ value: RawTrace[] }>("plugintracelogs", {
    select: TRACE_SELECT,
    filter: `correlationid eq ${correlationId} and exceptiondetails ne null`,
    orderby: "depth desc,createdon desc",
    top: 1,
  });
  const trace = (res.value ?? [])[0];
  if (trace === undefined) {
    return {
      envelope: errorEnvelope("No failing trace found for that correlationId", {
        hint:
          "Either every trace in this correlation completed without an exception, or " +
          "plug-in trace logging was disabled when the operation ran. Use get_plugin_traces " +
          "with onlyErrors: false to inspect all traces for the correlation.",
      }),
    };
  }
  return { trace };
}

function mapStepConfig(stepId: string, raw: RawStep): StepConfig {
  const filtering = raw.filteringattributes ?? null;
  const images = raw.sdkmessageprocessingstepid_sdkmessageprocessingstepimage ?? [];
  return {
    id: stepId,
    name: raw.name ?? "(unnamed step)",
    message: raw.sdkmessageid?.name ?? "unknown",
    entity: raw.sdkmessagefilterid?.primaryobjecttypecode ?? "none",
    stage: stageLabel(raw.stage),
    mode: modeLabel(raw.mode),
    rank: raw.rank ?? null,
    filteringAttributes:
      filtering !== null && filtering.trim() !== "" ? filtering : null,
    images: images.map((img) => ({
      name: img.name ?? null,
      entityAlias: img.entityalias ?? null,
      imageType: imageTypeLabel(img.imagetype),
      // null means the image captures all attributes.
      attributes: nonEmpty(img.attributes),
    })),
  };
}

interface StepConfigResult {
  stepConfig: StepConfig | null;
  stepConfigNote?: string;
}

async function fetchStepConfig(
  client: Pick<DataverseClient, "get">,
  pluginStepId: string | null | undefined,
): Promise<StepConfigResult> {
  const stepId = normalizeGuid(pluginStepId);
  if (stepId === null) {
    return { stepConfig: null, stepConfigNote: "trace does not reference a step" };
  }
  try {
    const raw = await client.get<RawStep>(`sdkmessageprocessingsteps(${stepId})`, {
      select: STEP_SELECT,
      expand: STEP_EXPAND,
    });
    return { stepConfig: mapStepConfig(stepId, raw) };
  } catch (err) {
    // The trace can outlive the registration; a missing step is context, not a failure.
    if (err instanceof DataverseHttpError && err.status === 404) {
      return {
        stepConfig: null,
        stepConfigNote: "step no longer exists (plug-in re-registered or removed)",
      };
    }
    throw err;
  }
}

function mapPipelineEntry(row: RawTrace, focus: RawTrace): PipelineEntry {
  return {
    id: row.plugintracelogid ?? null,
    pluginType: row.typename ?? null,
    messageName: row.messagename ?? null,
    primaryEntity: row.primaryentity ?? null,
    depth: row.depth ?? null,
    mode: modeLabel(row.mode),
    durationMs: row.performanceexecutionduration ?? null,
    failed: nonEmpty(row.exceptiondetails) !== null,
    isFocus:
      row.plugintracelogid !== undefined &&
      row.plugintracelogid === focus.plugintracelogid,
  };
}

async function fetchPipeline(
  client: Pick<DataverseClient, "get">,
  focus: RawTrace,
): Promise<PipelineEntry[]> {
  const correlationId = normalizeGuid(focus.correlationid);
  if (correlationId === null) return [mapPipelineEntry(focus, focus)];
  const res = await client.get<{ value: RawTrace[] }>("plugintracelogs", {
    select: PIPELINE_SELECT,
    filter: `correlationid eq ${correlationId}`,
    orderby: "depth asc,createdon asc",
    top: PIPELINE_TOP,
  });
  const rows = res.value ?? [];
  if (rows.length === 0) return [mapPipelineEntry(focus, focus)];
  return rows.map((row) => mapPipelineEntry(row, focus));
}

function composeSummary(
  focus: RawTrace,
  exception: ParsedException | null,
  pipeline: PipelineEntry[],
  patterns: DetectedPattern[],
): string {
  const pluginType = focus.typename ?? "An unknown plug-in";
  const message = focus.messagename ?? "an unknown message";
  const entity = focus.primaryentity ?? "an unknown entity";
  const depth = focus.depth ?? "unknown";
  const duration =
    focus.performanceexecutionduration !== null &&
    focus.performanceexecutionduration !== undefined
      ? `${focus.performanceexecutionduration} ms`
      : "unknown duration";
  const where = `during ${message} on ${entity} at depth ${depth} (${modeLabel(focus.mode)}, ${duration})`;

  const sentences: string[] = [];
  if (exception !== null) {
    const excType = exception.type ?? "an unhandled exception";
    const excMessage = exception.message !== null ? `: ${exception.message}` : "";
    sentences.push(`${pluginType} failed ${where} with ${excType}${excMessage}.`);
  } else {
    sentences.push(`${pluginType} completed ${where} without recording an exception.`);
  }
  if (pipeline.length > 1) {
    const failedCount = pipeline.filter((entry) => entry.failed).length;
    sentences.push(
      `${failedCount} of ${pipeline.length} traces in this correlation failed.`,
    );
  }
  if (patterns.length > 0) {
    sentences.push(
      `Detected patterns: ${patterns.map((p) => p.pattern).join(", ")}.`,
    );
  }
  return sentences.join(" ");
}

export async function explainTrace(
  client: Pick<DataverseClient, "get">,
  input: ExplainTraceInput,
): Promise<unknown> {
  // The MCP server registers inputSchema.shape, so an object-level .refine()
  // would not be enforced at the transport. Guard here instead.
  if (input.traceId === undefined && input.correlationId === undefined) {
    return errorEnvelope("Provide traceId or correlationId", {
      hint:
        "Pass the plugintracelogid of the trace to explain, or a correlation id (GUID) " +
        "to analyze the deepest failing trace of that pipeline execution. Use " +
        "get_plugin_traces to find recent trace and correlation ids.",
    });
  }

  try {
    // When both are supplied, traceId wins (it names an exact record).
    const focus =
      input.traceId !== undefined
        ? await fetchFocusByTraceId(client, input.traceId)
        : await fetchFocusByCorrelationId(client, input.correlationId ?? "");
    if ("envelope" in focus) return focus.envelope;
    const trace = focus.trace;

    const { stepConfig, stepConfigNote } = await fetchStepConfig(
      client,
      trace.pluginstepid,
    );
    const pipeline = await fetchPipeline(client, trace);

    const exceptionDetails = nonEmpty(trace.exceptiondetails);
    const messageBlock = nonEmpty(trace.messageblock);
    const exception =
      exceptionDetails !== null ? parseExceptionDetails(exceptionDetails) : null;
    const detectedPatterns = detectPatterns({
      text: `${exceptionDetails ?? ""}\n${messageBlock ?? ""}`,
      depth: trace.depth ?? 1,
    });

    return {
      summary: composeSummary(trace, exception, pipeline, detectedPatterns),
      trace: {
        id: trace.plugintracelogid ?? null,
        createdon: trace.createdon ?? null,
        pluginType: trace.typename ?? null,
        messageName: trace.messagename ?? null,
        primaryEntity: trace.primaryentity ?? null,
        depth: trace.depth ?? null,
        mode: modeLabel(trace.mode),
        durationMs: trace.performanceexecutionduration ?? null,
        correlationId: trace.correlationid ?? null,
      },
      exception,
      stepConfig,
      ...(stepConfigNote !== undefined ? { stepConfigNote } : {}),
      pipeline,
      detectedPatterns,
      rawExcerpt: (exceptionDetails ?? "").slice(0, RAW_EXCERPT_MAX_CHARS),
      ...(messageBlock !== null
        ? {
            messageBlockExcerpt: messageBlock.slice(
              0,
              MESSAGE_BLOCK_EXCERPT_MAX_CHARS,
            ),
          }
        : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "This tool requires the prvReadPluginTraceLog privilege (and read access to " +
          "SdkMessageProcessingStep for step details). Use a user with the System " +
          "Administrator or System Customizer role, or add those privileges to the " +
          "connecting principal's security role.",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const explainTraceTool = defineTool({
  name: "explain_trace",
  description:
    "Root-cause analysis for one Dataverse plug-in trace: correlates the trace with its " +
    "step registration (stage, mode, filtering attributes, images), reconstructs the " +
    "pipeline of sibling traces sharing the correlation id, parses the exception into " +
    "type/message/frames, and detects known failure patterns. Pass traceId " +
    "(plugintracelogid) or correlationId (the deepest failing trace is analyzed).",
  inputSchema,
  handler: async (input) => {
    try {
      return await explainTrace(getDefaultClient(), input);
    } catch (err) {
      // explainTrace traps its own errors; this covers client construction
      // failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
