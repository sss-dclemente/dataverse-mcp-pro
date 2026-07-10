import { z } from "zod";
import { defineTool } from "./types.js";
import {
  DataverseHttpError,
  escapeODataString,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

const EMPTY_RESULT_HINT =
  "No plug-in trace records matched. Plug-in trace logging may be disabled in this org: " +
  'enable it under Settings > Administration > System Settings > Customization > "Enable logging to plug-in trace log" ' +
  '(set to "Exception" or "All"), then reproduce the operation and query again. ' +
  "Otherwise, try widening hoursBack or relaxing filters (e.g. onlyErrors: false).";

const EXCERPT_MAX_CHARS = 500;

const inputSchema = z.object({
  entity: z
    .string()
    .optional()
    .describe('Logical name of the primary entity to filter on (e.g. "account").'),
  messageName: z
    .string()
    .optional()
    .describe('SDK message name to filter on (e.g. "Update", "Create").'),
  pluginTypeName: z
    .string()
    .optional()
    .describe(
      "Substring matched against the plug-in type name (OData contains()), " +
        'e.g. "Contoso.Plugins".',
    ),
  onlyErrors: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), return only traces that recorded exception details.",
    ),
  correlationId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Correlation id (GUID) to filter on — follows a single pipeline execution across steps.",
    ),
  hoursBack: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe("How many hours back to search, 1–168 (default 24)."),
  top: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of traces to return, 1–100 (default 25)."),
});

export type PluginTracesInput = z.infer<typeof inputSchema>;

// Deliberately excludes messageblock: it can be huge and may contain sensitive
// business data — never select or return it.
const SELECT_FIELDS = [
  "plugintracelogid",
  "createdon",
  "typename",
  "messagename",
  "primaryentity",
  "depth",
  "mode",
  "performanceexecutionduration",
  "exceptiondetails",
  "correlationid",
];

interface RawPluginTrace {
  plugintracelogid?: string;
  createdon?: string;
  typename?: string | null;
  messagename?: string | null;
  primaryentity?: string | null;
  depth?: number | null;
  mode?: number | null;
  performanceexecutionduration?: number | null;
  exceptiondetails?: string | null;
  correlationid?: string | null;
}

function mapTrace(raw: RawPluginTrace): Record<string, unknown> {
  const details = raw.exceptiondetails;
  const hasException = typeof details === "string" && details !== "";
  return {
    id: raw.plugintracelogid ?? null,
    createdon: raw.createdon ?? null,
    pluginType: raw.typename ?? null,
    messageName: raw.messagename ?? null,
    primaryEntity: raw.primaryentity ?? null,
    depth: raw.depth ?? null,
    mode: raw.mode === 1 ? "async" : "sync",
    durationMs: raw.performanceexecutionduration ?? null,
    correlationId: raw.correlationid ?? null,
    ...(hasException
      ? {
          exceptionSummary:
            details.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "",
          exceptionExcerpt: details.slice(0, EXCERPT_MAX_CHARS),
        }
      : {}),
  };
}

export async function queryPluginTraces(
  client: Pick<DataverseClient, "get">,
  input: PluginTracesInput,
): Promise<unknown> {
  try {
    const cutoff = new Date(Date.now() - input.hoursBack * 3_600_000).toISOString();
    const filters = [`createdon ge ${cutoff}`];
    if (input.onlyErrors) filters.push("exceptiondetails ne null");
    if (input.entity !== undefined) {
      filters.push(`primaryentity eq '${escapeODataString(input.entity)}'`);
    }
    if (input.messageName !== undefined) {
      filters.push(`messagename eq '${escapeODataString(input.messageName)}'`);
    }
    if (input.pluginTypeName !== undefined) {
      filters.push(`contains(typename,'${escapeODataString(input.pluginTypeName)}')`);
    }
    if (input.correlationId !== undefined) {
      // correlationid is a uniqueidentifier attribute: GUID literals are unquoted.
      filters.push(`correlationid eq ${input.correlationId}`);
    }

    const response = await client.get<{ value: RawPluginTrace[] }>("plugintracelogs", {
      select: SELECT_FIELDS,
      filter: filters.join(" and "),
      orderby: "createdon desc",
      top: input.top,
    });

    const traces = (response.value ?? []).map(mapTrace);
    if (traces.length === 0) {
      // Success payload (not an error): empty very often means tracing is off.
      return { count: 0, traces: [], hint: EMPTY_RESULT_HINT, docsUrl: DOCS_URL };
    }
    return { count: traces.length, traces };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading plug-in trace logs requires the prvReadPluginTraceLog privilege. " +
          "Use a user with the System Administrator or System Customizer role, or add " +
          "that privilege to the connecting principal's security role.",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const getPluginTraces = defineTool({
  name: "get_plugin_traces",
  description:
    "Queries Dataverse plug-in trace logs (plugintracelogs) with filters for primary entity, " +
    "message name, plug-in type, correlation id and time window. Defaults to errors only from " +
    "the last 24 hours; exception details are summarized/truncated. Free tier.",
  inputSchema,
  handler: async (input) => queryPluginTraces(getDefaultClient(), input),
});
