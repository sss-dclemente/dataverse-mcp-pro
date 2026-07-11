import { z } from "zod";
import { defineTool } from "./types.js";
import {
  DataverseHttpError,
  escapeODataString,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import { errorEnvelope, toErrorEnvelope, type ErrorEnvelope } from "../errors.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const EMPTY_RESULT_HINT =
  "No runs in the window. Note that Dataverse run history covers solution-aware cloud flows.";

const VIRTUAL_TABLE_HINT =
  "Cloud-flow run history in Dataverse (the flowrun virtual table) requires " +
  "solution-aware flows and may not be enabled in every environment/region";

const ERROR_MESSAGE_MAX_CHARS = 300;
const MAX_NAME_MATCHES = 5;

const inputSchema = z.object({
  flowId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Workflow id (GUID) of the cloud flow to scope runs to. Takes precedence over flowName.",
    ),
  flowName: z
    .string()
    .optional()
    .describe(
      "Display name of the cloud flow. Matched exactly first, then by contains(); " +
        "up to 5 matching flows are included.",
    ),
  status: z
    .enum(["succeeded", "failed", "cancelled", "running"])
    .optional()
    .describe("Filter runs by outcome. Omit to return runs in any state."),
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
    .describe("Maximum number of runs to return, 1–100 (default 25)."),
});

export type FlowRunsInput = z.infer<typeof inputSchema>;

// flowrun status values are capitalized string literals in the virtual table.
const STATUS_LITERALS: Record<FlowRunsInput["status"] & string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  running: "Running",
};

const SELECT_FIELDS = [
  "name",
  "status",
  "starttime",
  "endtime",
  "duration",
  "triggertype",
  "errorcode",
  "errormessage",
  "_workflow_value",
];

// category 5 = modern cloud flow, type 1 = definition (not an activation/template).
const CLOUD_FLOW_DEFINITION_FILTER = "category eq 5 and type eq 1";

interface RawWorkflow {
  workflowid?: string;
  name?: string | null;
}

interface RawFlowRun {
  name?: string | null;
  status?: string | null;
  starttime?: string | null;
  endtime?: string | null;
  duration?: number | null;
  triggertype?: string | null;
  errorcode?: string | null;
  errormessage?: string | null;
  _workflow_value?: string | null;
}

function mapRun(raw: RawFlowRun): Record<string, unknown> {
  return {
    // name is the Power Automate run id string (usable to locate the run in the portal).
    runName: raw.name ?? null,
    flowId: raw._workflow_value ?? null,
    status: raw.status ?? null,
    startTime: raw.starttime ?? null,
    endTime: raw.endtime ?? null,
    ...(raw.duration !== null && raw.duration !== undefined
      ? { durationMs: raw.duration }
      : {}),
    triggerType: raw.triggertype ?? null,
    ...(raw.errorcode ? { errorCode: raw.errorcode } : {}),
    ...(raw.errormessage
      ? { errorMessage: raw.errormessage.slice(0, ERROR_MESSAGE_MAX_CHARS) }
      : {}),
  };
}

async function resolveFlowIdsByName(
  client: Pick<DataverseClient, "get">,
  flowName: string,
): Promise<string[] | ErrorEnvelope> {
  const escaped = escapeODataString(flowName);
  const exact = await client.get<{ value: RawWorkflow[] }>("workflows", {
    select: ["workflowid", "name"],
    filter: `${CLOUD_FLOW_DEFINITION_FILTER} and name eq '${escaped}'`,
  });
  let matches = exact.value ?? [];
  if (matches.length === 0) {
    const fuzzy = await client.get<{ value: RawWorkflow[] }>("workflows", {
      select: ["workflowid", "name"],
      filter: `${CLOUD_FLOW_DEFINITION_FILTER} and contains(name,'${escaped}')`,
    });
    matches = fuzzy.value ?? [];
  }
  const ids = matches
    .map((w) => w.workflowid)
    .filter((id): id is string => typeof id === "string")
    .slice(0, MAX_NAME_MATCHES);
  if (ids.length === 0) {
    return errorEnvelope(`No cloud flow found matching "${flowName}".`, {
      hint:
        "Use the flow's display name exactly as shown in Power Automate, or pass " +
        "flowId (the workflow id GUID) instead. Only solution-aware cloud flows are visible.",
    });
  }
  return ids;
}

function isEntityNotFound(err: DataverseHttpError): boolean {
  if (err.status === 404) return true;
  if (err.status !== 400) return false;
  const message = (err.dataverseMessage ?? err.message).toLowerCase();
  return (
    message.includes("not found") &&
    (message.includes("entity") ||
      message.includes("segment") ||
      message.includes("flowrun"))
  );
}

export async function queryFlowRuns(
  client: Pick<DataverseClient, "get">,
  input: FlowRunsInput,
): Promise<unknown> {
  try {
    let flowIds: string[] | undefined;
    if (input.flowId !== undefined) {
      flowIds = [input.flowId];
    } else if (input.flowName !== undefined) {
      const resolved = await resolveFlowIdsByName(client, input.flowName);
      if (!Array.isArray(resolved)) return resolved;
      flowIds = resolved;
    }

    const cutoff = new Date(Date.now() - input.hoursBack * 3_600_000).toISOString();
    const filters = [`starttime ge ${cutoff}`];
    if (input.status !== undefined) {
      filters.push(`status eq '${STATUS_LITERALS[input.status]}'`);
    }
    if (flowIds !== undefined) {
      // _workflow_value is a lookup (uniqueidentifier): GUID literals are unquoted.
      filters.push(`(${flowIds.map((id) => `_workflow_value eq ${id}`).join(" or ")})`);
    }

    const response = await client.get<{ value: RawFlowRun[] }>("flowruns", {
      select: SELECT_FIELDS,
      filter: filters.join(" and "),
      orderby: "starttime desc",
      top: input.top,
    });

    const runs = (response.value ?? []).map(mapRun);
    return {
      count: runs.length,
      windowHours: input.hoursBack,
      runs,
      ...(runs.length === 0 ? { hint: EMPTY_RESULT_HINT } : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError) {
      const message = err.dataverseMessage ?? err.message;
      if (isEntityNotFound(err)) {
        return errorEnvelope(message, { hint: VIRTUAL_TABLE_HINT, docsUrl: DOCS_URL });
      }
      if (err.status === 400) {
        return errorEnvelope(message, {
          hint:
            "The flowrun virtual table supports limited OData filtering. Try narrowing " +
            "the query by flowId and keep filters to starttime, status and the flow lookup.",
          docsUrl: DOCS_URL,
        });
      }
      if (err.status === 403) {
        return errorEnvelope(message, {
          hint:
            "Reading cloud-flow run history requires read privilege on the Process " +
            "(workflow) and flow run tables. Use a user with the System Administrator " +
            "role, or grant those read privileges to the connecting principal's security role.",
          docsUrl: DOCS_URL,
        });
      }
    }
    return toErrorEnvelope(err);
  }
}

export const getFlowRuns = defineTool({
  name: "get_flow_runs",
  description:
    "Lists Power Automate cloud-flow runs from the Dataverse flowrun virtual table, filtered " +
    "by flow (id or display name), run status and time window. Returns run id, status, timing " +
    "and truncated error details for failed runs. Covers solution-aware cloud flows. Free tier.",
  inputSchema,
  handler: async (input) => queryFlowRuns(getDefaultClient(), input),
});
