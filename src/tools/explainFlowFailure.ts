import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope, type ErrorEnvelope } from "../errors.js";
import { isProLicensed, proUpgradeMessage } from "../licensing.js";
import {
  DataverseHttpError,
  escapeODataString,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import {
  detectFlowFailurePatterns,
  type DetectedFlowFailurePattern,
} from "./flowFailurePatterns.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

const VIRTUAL_TABLE_HINT =
  "Cloud-flow run history in Dataverse (the flowrun virtual table) requires " +
  "solution-aware flows and may not be enabled in every environment/region";

const PRIVILEGE_HINT =
  "Reading cloud-flow run history requires read privilege on the Process " +
  "(workflow) and flow run tables. Use a user with the System Administrator " +
  "role, or grant those read privileges to the connecting principal's security role.";

const ERROR_EXCERPT_MAX_CHARS = 500;
const MAX_ACTIONS = 50;

// workflow.category 5 = Modern Flow (cloud flow); workflow.type 1 = Definition.
const CLOUD_FLOW_DEFINITION_FILTER = "category eq 5 and type eq 1";

const inputSchema = z.object({
  runName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The flow run's name (the Power Automate run id string, e.g. from " +
        "get_flow_runs). Takes precedence over flowId/flowName when supplied.",
    ),
  flowId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "workflowid (GUID) of the cloud flow; the latest Failed run is analyzed. " +
        "Takes precedence over flowName.",
    ),
  flowName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Display name of the cloud flow. Matched exactly first, then by " +
        "contains(); the latest Failed run of the first match is analyzed.",
    ),
});

export type ExplainFlowFailureInput = z.infer<typeof inputSchema>;

const RUN_SELECT = [
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

const FLOW_SELECT = ["workflowid", "name", "clientdata", "statecode"];

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

interface RawWorkflow {
  workflowid?: string;
  name?: string | null;
  clientdata?: string | null;
  statecode?: number | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stateLabel(statecode: number | null | undefined): string {
  switch (statecode) {
    case 0:
      return "draft";
    case 1:
      return "activated";
    default:
      return String(statecode ?? "unknown");
  }
}

type RunResult = { run: RawFlowRun } | { envelope: ErrorEnvelope };

async function fetchRunByName(
  client: Pick<DataverseClient, "get">,
  runName: string,
): Promise<RunResult> {
  const res = await client.get<{ value: RawFlowRun[] }>("flowruns", {
    select: RUN_SELECT,
    filter: `name eq '${escapeODataString(runName)}'`,
    top: 1,
  });
  const run = (res.value ?? [])[0];
  if (run === undefined) {
    return {
      envelope: errorEnvelope(`Flow run not found: "${runName}"`, {
        hint:
          "No flowrun row has that name. Run names come from get_flow_runs (the " +
          "runName field); note that Dataverse run history only covers " +
          "solution-aware cloud flows and is retained for a limited window.",
      }),
    };
  }
  return { run };
}

async function fetchLatestFailedRun(
  client: Pick<DataverseClient, "get">,
  flowId: string,
): Promise<RunResult> {
  // _workflow_value is a lookup (uniqueidentifier): GUID literals are unquoted.
  const res = await client.get<{ value: RawFlowRun[] }>("flowruns", {
    select: RUN_SELECT,
    filter: `_workflow_value eq ${flowId} and status eq 'Failed'`,
    orderby: "starttime desc",
    top: 1,
  });
  const run = (res.value ?? [])[0];
  if (run === undefined) {
    return {
      envelope: errorEnvelope("No failed runs found for this flow", {
        hint:
          "The flow has no run with status Failed in Dataverse run history. Use " +
          "get_flow_runs to inspect recent runs in any state, and note that run " +
          "history only covers solution-aware cloud flows.",
      }),
    };
  }
  return { run };
}

async function resolveFlowIdByName(
  client: Pick<DataverseClient, "get">,
  flowName: string,
): Promise<string | ErrorEnvelope> {
  const escaped = escapeODataString(flowName);
  const exact = await client.get<{ value: RawWorkflow[] }>("workflows", {
    select: ["workflowid", "name"],
    filter: `${CLOUD_FLOW_DEFINITION_FILTER} and name eq '${escaped}'`,
    top: 1,
  });
  let match = (exact.value ?? [])[0];
  if (match === undefined) {
    const fuzzy = await client.get<{ value: RawWorkflow[] }>("workflows", {
      select: ["workflowid", "name"],
      filter: `${CLOUD_FLOW_DEFINITION_FILTER} and contains(name,'${escaped}')`,
      top: 1,
    });
    match = (fuzzy.value ?? [])[0];
  }
  const id = match?.workflowid;
  if (typeof id !== "string") {
    return errorEnvelope(`No cloud flow found matching "${flowName}".`, {
      hint:
        "Use the flow's display name exactly as shown in Power Automate, or pass " +
        "flowId (the workflow id GUID) instead. Only solution-aware cloud flows are visible.",
    });
  }
  return id;
}

interface ActionSummary {
  name: string;
  operationId?: string;
}

/** Child action maps of a container node: own actions, If else branch, Switch cases. */
function childGroups(node: JsonRecord): JsonRecord[] {
  const groups: JsonRecord[] = [];
  const own = asRecord(node["actions"]);
  if (own !== null) groups.push(own);
  const elseActions = asRecord(asRecord(node["else"])?.["actions"]);
  if (elseActions !== null) groups.push(elseActions);
  const cases = asRecord(node["cases"]);
  if (cases !== null) {
    for (const caseValue of Object.values(cases)) {
      const caseActions = asRecord(asRecord(caseValue)?.["actions"]);
      if (caseActions !== null) groups.push(caseActions);
    }
  }
  return groups;
}

interface ActionWalkState {
  actions: ActionSummary[];
  truncated: boolean;
}

function collectActions(record: JsonRecord, state: ActionWalkState): void {
  for (const [name, value] of Object.entries(record)) {
    if (state.actions.length >= MAX_ACTIONS) {
      state.truncated = true;
      return;
    }
    const node = asRecord(value) ?? {};
    const operationId = asString(
      asRecord(asRecord(node["inputs"])?.["host"])?.["operationId"],
    );
    state.actions.push({
      name,
      ...(operationId !== null ? { operationId } : {}),
    });
    for (const group of childGroups(node)) collectActions(group, state);
  }
}

function firstTriggerType(definition: JsonRecord | null): string | null {
  const triggers = asRecord(definition?.["triggers"]);
  if (triggers === null) return null;
  return asString(asRecord(Object.values(triggers)[0])?.["type"]);
}

interface FlowContext {
  flow: { id: string | null; name: string | null; state: string } | null;
  actions: ActionSummary[];
  actionsTruncated: boolean;
  definitionTriggerType: string | null;
  definitionNote?: string;
}

const EMPTY_DEFINITION = {
  actions: [] as ActionSummary[],
  actionsTruncated: false,
  definitionTriggerType: null,
};

async function fetchFlowContext(
  client: Pick<DataverseClient, "get">,
  flowGuid: string | null,
): Promise<FlowContext> {
  if (flowGuid === null) {
    return {
      ...EMPTY_DEFINITION,
      flow: null,
      definitionNote: "run does not reference a flow",
    };
  }

  let raw: RawWorkflow;
  try {
    raw = await client.get<RawWorkflow>(`workflows(${flowGuid})`, {
      select: FLOW_SELECT,
    });
  } catch (err) {
    // Run history can outlive the flow; a missing workflow row is context, not a failure.
    if (err instanceof DataverseHttpError && err.status === 404) {
      return {
        ...EMPTY_DEFINITION,
        flow: null,
        definitionNote: "flow record no longer exists (deleted since the run)",
      };
    }
    throw err;
  }

  const flow = {
    id: raw.workflowid ?? flowGuid,
    name: raw.name ?? null,
    state: stateLabel(raw.statecode),
  };

  const clientData = raw.clientdata;
  if (typeof clientData !== "string" || clientData.trim() === "") {
    return {
      ...EMPTY_DEFINITION,
      flow,
      definitionNote: "flow definition unavailable (empty clientdata)",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(clientData);
  } catch {
    return {
      ...EMPTY_DEFINITION,
      flow,
      definitionNote: "flow definition could not be parsed (invalid clientdata JSON)",
    };
  }

  const definition = asRecord(
    asRecord(asRecord(parsed)?.["properties"])?.["definition"],
  );
  const state: ActionWalkState = { actions: [], truncated: false };
  const actionRoot = asRecord(definition?.["actions"]);
  if (actionRoot !== null) collectActions(actionRoot, state);
  return {
    flow,
    actions: state.actions,
    actionsTruncated: state.truncated,
    definitionTriggerType: firstTriggerType(definition),
    ...(definition === null
      ? { definitionNote: "flow definition missing the expected properties.definition structure" }
      : {}),
  };
}

interface FailedActionGuess {
  name: string;
  foundInDefinition: boolean;
  operationId?: string;
}

// Connector error messages commonly name the failing action, e.g.
// "Action 'Send_approval_email' failed" or "The 'Update_row' action ...".
const GUESS_REGEXES = [/Action '([^']+)' failed/i, /'([^']+)' action\b/i];

function guessFailedAction(
  errorMessage: string,
  actions: ActionSummary[],
): FailedActionGuess | undefined {
  for (const re of GUESS_REGEXES) {
    const name = re.exec(errorMessage)?.[1];
    if (name !== undefined && name !== "") {
      const match = actions.find((action) => action.name === name);
      return {
        name,
        foundInDefinition: match !== undefined,
        ...(match?.operationId !== undefined
          ? { operationId: match.operationId }
          : {}),
      };
    }
  }
  return undefined;
}

function composeSummary(
  run: RawFlowRun,
  flowName: string | null,
  guess: FailedActionGuess | undefined,
  patterns: DetectedFlowFailurePattern[],
): string {
  const flowLabel = flowName ?? "an unknown flow";
  const runLabel = run.name ?? "(unknown run)";
  const status = run.status ?? "unknown";
  const outcome = status === "Failed" ? "failed" : `ended with status ${status}`;
  const started = run.starttime ?? "an unknown time";
  const code = nonEmpty(run.errorcode);
  const sentences = [
    `Cloud flow "${flowLabel}" run ${runLabel} ${outcome} (started ${started})` +
      `${code !== null ? ` with error ${code}` : ""}` +
      `${guess !== undefined ? `, apparently in action '${guess.name}'` : ""}.`,
  ];
  if (patterns.length > 0) {
    sentences.push(
      `Detected patterns: ${patterns.map((p) => p.pattern).join(", ")}.`,
    );
  }
  return sentences.join(" ");
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

export async function explainFlowFailure(
  client: Pick<DataverseClient, "get">,
  input: ExplainFlowFailureInput,
): Promise<unknown> {
  // The MCP server registers inputSchema.shape, so an object-level .refine()
  // would not be enforced at the transport. Guard here instead.
  if (
    input.runName === undefined &&
    input.flowId === undefined &&
    input.flowName === undefined
  ) {
    return errorEnvelope("Provide runName, flowId or flowName", {
      hint:
        "Pass the flow run's name (from get_flow_runs) as runName to analyze that " +
        "exact run, or a flowId (workflowid GUID) / flowName to analyze the flow's " +
        "latest Failed run. runName takes precedence when several are supplied.",
    });
  }

  try {
    // runName wins (it names an exact run); otherwise the latest Failed run
    // of the flow identified by flowId (or resolved from flowName).
    let resolved: RunResult;
    if (input.runName !== undefined) {
      resolved = await fetchRunByName(client, input.runName);
    } else {
      let flowId = input.flowId;
      if (flowId === undefined) {
        const byName = await resolveFlowIdByName(client, input.flowName ?? "");
        if (typeof byName !== "string") return byName;
        flowId = byName;
      }
      resolved = await fetchLatestFailedRun(client, flowId);
    }
    if ("envelope" in resolved) return resolved.envelope;
    const run = resolved.run;

    const context = await fetchFlowContext(client, nonEmpty(run._workflow_value));

    const errorCode = nonEmpty(run.errorcode);
    const errorMessage = nonEmpty(run.errormessage);
    const detectedPatterns = detectFlowFailurePatterns({
      text: `${errorCode ?? ""}\n${errorMessage ?? ""}`,
    });
    const failedActionGuess =
      errorMessage !== null
        ? guessFailedAction(errorMessage, context.actions)
        : undefined;
    const statusNote =
      run.status === "Failed"
        ? undefined
        : `Run status is "${run.status ?? "unknown"}", not "Failed" — analyzed anyway.`;
    const rawError = [errorCode, errorMessage]
      .filter((part): part is string => part !== null)
      .join(": ");

    return {
      summary: composeSummary(
        run,
        context.flow?.name ?? null,
        failedActionGuess,
        detectedPatterns,
      ),
      run: {
        runName: run.name ?? null,
        status: run.status ?? null,
        startTime: run.starttime ?? null,
        endTime: run.endtime ?? null,
        ...(run.duration !== null && run.duration !== undefined
          ? { durationMs: run.duration }
          : {}),
        triggerType: run.triggertype ?? context.definitionTriggerType,
        ...(errorCode !== null ? { errorCode } : {}),
        ...(errorMessage !== null
          ? { errorMessageExcerpt: errorMessage.slice(0, ERROR_EXCERPT_MAX_CHARS) }
          : {}),
      },
      flow: context.flow,
      ...(statusNote !== undefined ? { statusNote } : {}),
      ...(failedActionGuess !== undefined ? { failedActionGuess } : {}),
      actions: context.actions,
      ...(context.actionsTruncated ? { actionsTruncated: true } : {}),
      ...(context.definitionNote !== undefined
        ? { definitionNote: context.definitionNote }
        : {}),
      detectedPatterns,
      rawErrorExcerpt: rawError.slice(0, ERROR_EXCERPT_MAX_CHARS),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError) {
      const message = err.dataverseMessage ?? err.message;
      if (isEntityNotFound(err)) {
        return errorEnvelope(message, { hint: VIRTUAL_TABLE_HINT, docsUrl: DOCS_URL });
      }
      if (err.status === 403) {
        return errorEnvelope(message, { hint: PRIVILEGE_HINT, docsUrl: DOCS_URL });
      }
    }
    return toErrorEnvelope(err);
  }
}

export const explainFlowFailureTool = defineTool({
  name: "explain_flow_failure",
  description:
    "Root-cause analysis for a failed Power Automate cloud-flow run: resolves the run " +
    "from Dataverse run history (flowruns), correlates it with the flow's definition " +
    "(actions, connector operations, trigger), guesses the failing action from the " +
    "error message, and detects known failure patterns (expired connections, " +
    "throttling, timeouts, permissions, expression errors, pagination limits, " +
    "Dataverse plug-in errors) with likely fixes. Pass runName (the run id from " +
    "get_flow_runs), or flowId/flowName to analyze the flow's latest failed run. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("explain_flow_failure");
    try {
      return await explainFlowFailure(getDefaultClient(), input);
    } catch (err) {
      // explainFlowFailure traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
