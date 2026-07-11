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

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata";

// workflow.category 5 = Modern Flow (cloud flow); workflow.type 1 = Definition.
const CLOUD_FLOW_CATEGORY = 5;
const WORKFLOW_TYPE_DEFINITION = 1;

// Nested containers (Scope/If/Switch/...) beyond this depth have their
// children omitted; the container itself is kept with an explanatory note.
const MAX_ACTION_DEPTH = 5;
const MAX_ACTIONS = 200;
const EXPRESSION_MAX_CHARS = 200;
const MARKDOWN_MAX_CHARS = 8000;

const inputSchema = z.object({
  flowId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "workflowid (GUID) of the cloud flow to document. Takes precedence over " +
        "flowName when both are supplied.",
    ),
  flowName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Display name of the cloud flow. Matched exactly first, then as a " +
        "substring; the first match is documented.",
    ),
});

export type DocumentFlowInput = z.infer<typeof inputSchema>;

const FLOW_SELECT = [
  "workflowid",
  "name",
  "description",
  "statecode",
  "category",
  "type",
  "clientdata",
  "createdon",
  "modifiedon",
  "_ownerid_value",
];

interface RawWorkflow {
  workflowid?: string;
  name?: string | null;
  description?: string | null;
  statecode?: number | null;
  category?: number | null;
  type?: number | null;
  clientdata?: string | null;
  createdon?: string | null;
  modifiedon?: string | null;
  _ownerid_value?: string | null;
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

interface ConnectorDoc {
  referenceName: string;
  apiName: string;
  connectionName?: string;
}

interface TriggerDoc {
  name: string;
  type: string;
  kind?: string;
  recurrence?: { frequency: string; interval: number };
  operationId?: string;
  connectionReference?: string;
}

interface ActionDoc {
  name: string;
  type: string;
  depth: number;
  runAfter?: string[];
  operationId?: string;
  connectionReference?: string;
  expression?: string;
  note?: string;
}

interface FlowDoc {
  id: string | null;
  name: string;
  description?: string;
  state: string;
  createdon: string | null;
  modifiedon: string | null;
}

/** operationId / connection reference of OpenApiConnection-style nodes. */
function extractHost(node: JsonRecord): {
  operationId?: string;
  connectionReference?: string;
} {
  const inputs = asRecord(node["inputs"]);
  const host = asRecord(inputs?.["host"]);
  if (host === null) return {};
  const operationId = asString(host["operationId"]);
  const connection = asRecord(host["connection"]);
  const connectionReference =
    asString(connection?.["referenceName"]) ?? asString(host["connectionName"]);
  return {
    ...(operationId !== null ? { operationId } : {}),
    ...(connectionReference !== null ? { connectionReference } : {}),
  };
}

function mapConnectionReferences(raw: unknown): ConnectorDoc[] {
  const record = asRecord(raw);
  if (record === null) return [];
  const out: ConnectorDoc[] = [];
  for (const [referenceName, value] of Object.entries(record)) {
    const entry = asRecord(value) ?? {};
    const api = asRecord(entry["api"]);
    const connectionName = asString(entry["connectionName"]);
    const apiName =
      asString(api?.["name"]) ??
      asString(entry["id"]) ??
      connectionName ??
      "unknown";
    out.push({
      referenceName,
      apiName,
      ...(connectionName !== null ? { connectionName } : {}),
    });
  }
  return out;
}

function dedupeByApiName(refs: ConnectorDoc[]): ConnectorDoc[] {
  const seen = new Set<string>();
  const out: ConnectorDoc[] = [];
  for (const ref of refs) {
    if (seen.has(ref.apiName)) continue;
    seen.add(ref.apiName);
    out.push(ref);
  }
  return out;
}

function mapTriggers(raw: unknown): TriggerDoc[] {
  const record = asRecord(raw);
  if (record === null) return [];
  const out: TriggerDoc[] = [];
  for (const [name, value] of Object.entries(record)) {
    const node = asRecord(value) ?? {};
    const type = asString(node["type"]) ?? "unknown";
    const kind = asString(node["kind"]);
    let recurrence: { frequency: string; interval: number } | undefined;
    if (type === "Recurrence") {
      const rec = asRecord(node["recurrence"]);
      if (rec !== null) {
        recurrence = {
          frequency: asString(rec["frequency"]) ?? "unknown",
          interval: typeof rec["interval"] === "number" ? rec["interval"] : 1,
        };
      }
    }
    out.push({
      name,
      type,
      ...(kind !== null ? { kind } : {}),
      ...(recurrence !== undefined ? { recurrence } : {}),
      ...extractHost(node),
    });
  }
  return out;
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
  return groups.filter((group) => Object.keys(group).length > 0);
}

interface WalkState {
  actions: ActionDoc[];
  truncated: boolean;
}

/** Pre-order flatten of the action tree, capped by depth and total count. */
function walkActions(record: JsonRecord, depth: number, state: WalkState): void {
  for (const [name, value] of Object.entries(record)) {
    if (state.actions.length >= MAX_ACTIONS) {
      state.truncated = true;
      return;
    }
    const node = asRecord(value) ?? {};
    const type = asString(node["type"]) ?? "unknown";
    const groups = childGroups(node);

    if (depth >= MAX_ACTION_DEPTH && groups.length > 0) {
      state.actions.push({
        name,
        type,
        depth,
        note: "children omitted (depth cap)",
      });
      continue;
    }

    const runAfterKeys = Object.keys(asRecord(node["runAfter"]) ?? {});
    const expressionValue = node["expression"];
    const expression =
      expressionValue !== undefined && expressionValue !== null
        ? JSON.stringify(expressionValue).slice(0, EXPRESSION_MAX_CHARS)
        : null;
    state.actions.push({
      name,
      type,
      depth,
      ...(runAfterKeys.length > 0 ? { runAfter: runAfterKeys } : {}),
      ...extractHost(node),
      ...(expression !== null ? { expression } : {}),
    });
    for (const group of groups) {
      walkActions(group, depth + 1, state);
    }
  }
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

function triggerBullet(trigger: TriggerDoc): string {
  const extras: string[] = [];
  if (trigger.kind !== undefined) extras.push(`kind: ${trigger.kind}`);
  if (trigger.recurrence !== undefined) {
    extras.push(
      `every ${trigger.recurrence.interval} ${trigger.recurrence.frequency}`,
    );
  }
  if (trigger.operationId !== undefined) {
    extras.push(`operation: ${trigger.operationId}`);
  }
  if (trigger.connectionReference !== undefined) {
    extras.push(`connection: ${trigger.connectionReference}`);
  }
  const suffix = extras.length > 0 ? ` — ${extras.join(", ")}` : "";
  return `- **${trigger.name}** (\`${trigger.type}\`)${suffix}`;
}

function actionBullet(action: ActionDoc): string {
  const extras: string[] = [];
  if (action.runAfter !== undefined) {
    extras.push(`after: ${action.runAfter.join(", ")}`);
  }
  if (action.operationId !== undefined) {
    extras.push(`operation: ${action.operationId}`);
  }
  if (action.note !== undefined) extras.push(action.note);
  const suffix = extras.length > 0 ? ` — ${extras.join(", ")}` : "";
  return `${"  ".repeat(action.depth)}- **${action.name}** (\`${action.type}\`)${suffix}`;
}

function buildMarkdown(
  flow: FlowDoc,
  triggers: TriggerDoc[],
  actions: ActionDoc[],
  connectors: ConnectorDoc[],
): string {
  const lines: string[] = [];
  lines.push(`# ${flow.name}`);
  lines.push("");
  lines.push(
    `State: ${flow.state} · Last modified: ${flow.modifiedon ?? "unknown"}`,
  );
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(
    flow.description ??
      `Cloud flow with ${actions.length} actions triggered by ` +
        `${triggers[0]?.type ?? "an unknown trigger"}.`,
  );
  lines.push("");
  lines.push("## Triggers");
  lines.push("");
  if (triggers.length === 0) lines.push("_(none)_");
  for (const trigger of triggers) lines.push(triggerBullet(trigger));
  lines.push("");
  lines.push("## Connectors");
  lines.push("");
  if (connectors.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push("| apiName | referenceName | connectionName |");
    lines.push("| --- | --- | --- |");
    for (const connector of connectors) {
      lines.push(
        `| ${connector.apiName} | ${connector.referenceName} | ${connector.connectionName ?? "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Actions");
  lines.push("");
  if (actions.length === 0) lines.push("_(none)_");
  for (const action of actions) lines.push(actionBullet(action));

  const markdown = lines.join("\n");
  return markdown.length > MARKDOWN_MAX_CHARS
    ? `${markdown.slice(0, MARKDOWN_MAX_CHARS)}…(truncated)`
    : markdown;
}

type FetchResult = { flow: RawWorkflow } | { envelope: ErrorEnvelope };

async function fetchByFlowId(
  client: Pick<DataverseClient, "get">,
  flowId: string,
): Promise<FetchResult> {
  try {
    const flow = await client.get<RawWorkflow>(`workflows(${flowId})`, {
      select: FLOW_SELECT,
    });
    return { flow };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 404) {
      return {
        envelope: errorEnvelope("Flow not found", {
          hint:
            "No workflow row with that id exists in this environment. Verify the " +
            "workflowid (GUID), and that you are connected to the environment that " +
            "contains the flow.",
        }),
      };
    }
    throw err;
  }
}

async function fetchByFlowName(
  client: Pick<DataverseClient, "get">,
  flowName: string,
): Promise<FetchResult> {
  const escaped = escapeODataString(flowName);
  const scope = `category eq ${CLOUD_FLOW_CATEGORY} and type eq ${WORKFLOW_TYPE_DEFINITION}`;
  let res = await client.get<{ value: RawWorkflow[] }>("workflows", {
    select: FLOW_SELECT,
    filter: `${scope} and name eq '${escaped}'`,
    top: 1,
  });
  let flow = (res.value ?? [])[0];
  if (flow === undefined) {
    res = await client.get<{ value: RawWorkflow[] }>("workflows", {
      select: FLOW_SELECT,
      filter: `${scope} and contains(name,'${escaped}')`,
      top: 1,
    });
    flow = (res.value ?? [])[0];
  }
  if (flow === undefined) {
    return {
      envelope: errorEnvelope(`Flow not found: "${flowName}"`, {
        hint:
          "No cloud flow (category 5) matched that display name, exactly or as a " +
          "substring. Check spelling, or pass the workflowid (GUID) as flowId instead.",
      }),
    };
  }
  return { flow };
}

export async function documentFlow(
  client: Pick<DataverseClient, "get">,
  input: DocumentFlowInput,
): Promise<unknown> {
  // The MCP server registers inputSchema.shape, so an object-level .refine()
  // would not be enforced at the transport. Guard here instead.
  if (input.flowId === undefined && input.flowName === undefined) {
    return errorEnvelope("Provide flowId or flowName", {
      hint:
        "Pass the cloud flow's workflowid (GUID) as flowId, or its display name " +
        "as flowName. flowId takes precedence when both are supplied.",
    });
  }

  try {
    // When both are supplied, flowId wins (it names an exact record).
    const fetched =
      input.flowId !== undefined
        ? await fetchByFlowId(client, input.flowId)
        : await fetchByFlowName(client, input.flowName ?? "");
    if ("envelope" in fetched) return fetched.envelope;
    const raw = fetched.flow;

    if (raw.category !== CLOUD_FLOW_CATEGORY) {
      return errorEnvelope("Not a cloud flow", {
        hint:
          "This workflow's category is not 5 (Modern Flow). Classic workflows, " +
          "business process flows and desktop flows are not supported by " +
          "document_flow — pass the id or name of a Power Automate cloud flow.",
      });
    }

    const clientData = raw.clientdata;
    if (typeof clientData !== "string" || clientData.trim() === "") {
      return errorEnvelope("Flow definition unavailable", {
        hint:
          "This flow's clientdata is empty, so there is no stored definition to " +
          "document. The flow may be part of a managed solution without a stored " +
          "definition, or it was created outside solutions in a way that does not " +
          "persist clientdata in Dataverse.",
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(clientData);
    } catch {
      return errorEnvelope("Flow definition could not be parsed", {
        hint:
          "The flow's clientdata is not valid JSON. Re-save the flow in the Power " +
          "Automate designer and try again.",
      });
    }

    const properties = asRecord(asRecord(parsed)?.["properties"]);
    const definition = asRecord(properties?.["definition"]);
    const connectors = dedupeByApiName(
      mapConnectionReferences(properties?.["connectionReferences"]),
    );
    const triggers = mapTriggers(definition?.["triggers"]);
    const walk: WalkState = { actions: [], truncated: false };
    const actionRoot = asRecord(definition?.["actions"]);
    if (actionRoot !== null) walkActions(actionRoot, 0, walk);

    const description = asString(raw.description);
    const flow: FlowDoc = {
      id: raw.workflowid ?? null,
      name: raw.name ?? "(unnamed flow)",
      ...(description !== null ? { description } : {}),
      state: stateLabel(raw.statecode),
      createdon: raw.createdon ?? null,
      modifiedon: raw.modifiedon ?? null,
    };

    return {
      flow,
      triggers,
      actions: walk.actions,
      actionCount: walk.actions.length,
      connectors,
      ...(walk.truncated ? { actionsTruncated: true } : {}),
      markdown: buildMarkdown(flow, triggers, walk.actions, connectors),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Documenting a flow requires read privilege on the Process (workflow) " +
          "table, including its clientdata column. Ask an admin for a security " +
          "role with read access to Process (e.g. System Customizer), or run as " +
          "a user who owns or can see the flow.",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const documentFlowTool = defineTool({
  name: "document_flow",
  description:
    "Generate structured documentation for a Power Automate cloud flow from its " +
    "Dataverse definition (workflow.clientdata): triggers (including recurrence " +
    "schedules), a flat pre-order outline of actions with nesting depth and " +
    "runAfter dependencies, the connectors it uses, and a ready-to-share markdown " +
    "document. Pass flowId (workflowid GUID) or flowName (display name). Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("document_flow");
    try {
      return await documentFlow(getDefaultClient(), input);
    } catch (err) {
      // documentFlow traps its own errors; this covers client construction
      // failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
