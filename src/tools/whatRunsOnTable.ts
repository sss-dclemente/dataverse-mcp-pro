import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope, type ErrorEnvelope } from "../errors.js";
import {
  DataverseHttpError,
  escapeODataString,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/";

// One table rarely has more message filters than this; a cap keeps the query bounded.
const MESSAGE_FILTER_TOP = 200;
// Keep OData $filter clauses well below URL-length limits when expanding
// filter ids into `_sdkmessagefilterid_value eq guid or ...` chains.
const FILTER_ID_CHUNK_SIZE = 25;
// Cloud flows are scanned client-side (clientdata is opaque to OData filters),
// so the definition list is capped and a truncation flag reported.
const FLOW_SCAN_TOP = 500;
// Safety cap when walking nested flow action containers (Scope/If/Switch).
const MAX_ACTION_DEPTH = 10;

const inputSchema = z.object({
  table: z
    .string()
    .min(1)
    .describe(
      "Logical name of the Dataverse table, e.g. 'account' (singular, " +
        "lowercase — not the display name or plural entity-set name). " +
        "Trimmed and lowercased before querying.",
    ),
});

export type WhatRunsOnTableInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

// --- Plug-in steps ---------------------------------------------------------

interface RawStep {
  sdkmessageprocessingstepid: string;
  name?: string | null;
  stage: number;
  mode: number;
  rank: number;
  filteringattributes?: string | null;
  sdkmessageid?: { name?: string | null } | null;
  plugintypeid?: { typename?: string | null } | null;
}

interface PluginStepInfo {
  id: string;
  name: string;
  pluginType: string;
  message: string;
  stage: string;
  mode: "sync" | "async";
  rank: number;
  filteringAttributes: string | null;
}

const STEP_SELECT = [
  "sdkmessageprocessingstepid",
  "name",
  "stage",
  "mode",
  "rank",
  "filteringattributes",
];

const STEP_EXPAND = "sdkmessageid($select=name),plugintypeid($select=typename)";

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

function toStepInfo(raw: RawStep): PluginStepInfo {
  const filtering = raw.filteringattributes ?? null;
  return {
    id: raw.sdkmessageprocessingstepid,
    name: raw.name ?? "(unnamed step)",
    pluginType: raw.plugintypeid?.typename ?? "unknown",
    message: raw.sdkmessageid?.name ?? "unknown",
    stage: stageLabel(raw.stage),
    mode: raw.mode === 1 ? "async" : "sync",
    rank: raw.rank,
    filteringAttributes:
      filtering !== null && filtering.trim() !== "" ? filtering : null,
  };
}

// --- Cloud-flow clientdata scan --------------------------------------------

type FlowUse = "trigger" | "action" | "unknown";

interface CloudFlowInfo {
  id: string | null;
  name: string;
  uses: FlowUse[];
}

interface RawFlow {
  workflowid?: string;
  name?: string | null;
  clientdata?: string | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Logical name plus the naive plural entity-set form flows often use. */
function tableNameForms(table: string): Set<string> {
  const plural = table.endsWith("y")
    ? `${table.slice(0, -1)}ies`
    : `${table}s`;
  return new Set([table, plural]);
}

/** True when a trigger/action node's inputs.parameters has an entityname-ish
 * key (e.g. "subscriptionRequest/entityname", "entityName") naming the table. */
function parametersReferenceTable(node: JsonRecord, names: Set<string>): boolean {
  const inputs = asRecord(node["inputs"]);
  const params = asRecord(inputs?.["parameters"]);
  if (params === null) return false;
  for (const [key, value] of Object.entries(params)) {
    if (!key.toLowerCase().includes("entityname")) continue;
    if (typeof value === "string" && names.has(value.toLowerCase())) return true;
  }
  return false;
}

/** Child action maps of a container node: own actions, If else branch, Switch cases. */
function childActionGroups(node: JsonRecord): JsonRecord[] {
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

function anyActionReferencesTable(
  record: JsonRecord,
  names: Set<string>,
  depth: number,
): boolean {
  if (depth > MAX_ACTION_DEPTH) return false;
  for (const value of Object.values(record)) {
    const node = asRecord(value);
    if (node === null) continue;
    if (parametersReferenceTable(node, names)) return true;
    for (const group of childActionGroups(node)) {
      if (anyActionReferencesTable(group, names, depth + 1)) return true;
    }
  }
  return false;
}

/** How a cloud-flow definition (workflow.clientdata) uses the table: as the
 * trigger entity, in Dataverse actions, or "unknown" when the definition is
 * unparseable but a substring heuristic still suggests a reference. */
export function flowUsesTable(clientdata: string, table: string): FlowUse[] {
  const lower = clientdata.toLowerCase();
  if (!lower.includes("entityname")) return [];
  const names = tableNameForms(table);

  let parsed: unknown;
  try {
    parsed = JSON.parse(clientdata);
  } catch {
    // Unparseable definition — cheap substring heuristic instead of a walk.
    for (const name of names) {
      if (lower.includes(`"${name}"`)) return ["unknown"];
    }
    return [];
  }

  const definition = asRecord(
    asRecord(asRecord(parsed)?.["properties"])?.["definition"],
  );
  const uses: FlowUse[] = [];
  const triggers = asRecord(definition?.["triggers"]);
  if (triggers !== null) {
    for (const value of Object.values(triggers)) {
      const node = asRecord(value);
      if (node !== null && parametersReferenceTable(node, names)) {
        uses.push("trigger");
        break;
      }
    }
  }
  const actions = asRecord(definition?.["actions"]);
  if (actions !== null && anyActionReferencesTable(actions, names, 0)) {
    uses.push("action");
  }
  return uses;
}

// --- Classic workflows & business rules -------------------------------------

interface RawWorkflowRow {
  workflowid?: string;
  name?: string | null;
  modifiedon?: string | null;
}

interface ProcessInfo {
  id: string | null;
  name: string;
}

async function fetchProcesses(
  client: Pick<DataverseClient, "get">,
  category: number,
  escapedTable: string,
): Promise<ProcessInfo[]> {
  const res = await client.get<ListResponse<RawWorkflowRow>>("workflows", {
    select: ["workflowid", "name", "modifiedon"],
    filter:
      `category eq ${category} and type eq 1 and statecode eq 1 ` +
      `and primaryentity eq '${escapedTable}'`,
  });
  return (res.value ?? []).map((w) => ({
    id: w.workflowid ?? null,
    name: w.name ?? "(unnamed)",
  }));
}

// --- Error mapping -----------------------------------------------------------

const PRIVILEGE_HINT =
  "Mapping table automation requires read privileges on SdkMessageProcessingStep, " +
  "SdkMessageFilter and Process (workflow). Ask an admin to grant the System " +
  "Customizer role or equivalent read privileges.";

function privilegeEnvelope(err: DataverseHttpError): ErrorEnvelope {
  return errorEnvelope(err.dataverseMessage ?? err.message, {
    hint: PRIVILEGE_HINT,
    docsUrl: DOCS_URL,
  });
}

function firstQueryEnvelope(err: unknown, table: string): ErrorEnvelope {
  if (err instanceof DataverseHttpError) {
    const message = err.dataverseMessage ?? err.message;
    if (err.status === 403) return privilegeEnvelope(err);
    if (
      err.status === 400 &&
      /primaryobjecttypecode|invalid property/i.test(message)
    ) {
      return errorEnvelope(message, {
        hint:
          `Dataverse rejected the query — check the table logical name ` +
          `'${table}' (singular, lowercase, e.g. 'account', not the display ` +
          `name or plural entity-set name).`,
      });
    }
  }
  return toErrorEnvelope(err);
}

function errText(err: unknown): string {
  if (err instanceof DataverseHttpError) return err.dataverseMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// --- Core ---------------------------------------------------------------------

export async function whatRunsOnTable(
  client: Pick<DataverseClient, "get">,
  input: WhatRunsOnTableInput,
): Promise<unknown> {
  const table = input.table.trim().toLowerCase();
  const escaped = escapeODataString(table);
  const sectionNotes: string[] = [];

  // The first query doubles as connectivity/table-name validation: when it
  // fails outright the whole call returns an envelope. Later sections are
  // failure-isolated and degrade to sectionNotes (except 403 — a privilege
  // problem dooms every remaining query too).
  let filterIds: string[];
  try {
    const filters = await client.get<
      ListResponse<{ sdkmessagefilterid: string }>
    >("sdkmessagefilters", {
      select: ["sdkmessagefilterid"],
      filter: `primaryobjecttypecode eq '${escaped}'`,
      top: MESSAGE_FILTER_TOP,
    });
    filterIds = (filters.value ?? []).map((f) => f.sdkmessagefilterid);
  } catch (err) {
    return firstQueryEnvelope(err, table);
  }

  let pluginSteps: PluginStepInfo[] = [];
  try {
    const raw: RawStep[] = [];
    for (let i = 0; i < filterIds.length; i += FILTER_ID_CHUNK_SIZE) {
      const chunk = filterIds.slice(i, i + FILTER_ID_CHUNK_SIZE);
      const idFilter = chunk
        .map((id) => `_sdkmessagefilterid_value eq ${id}`)
        .join(" or ");
      const res = await client.get<ListResponse<RawStep>>(
        "sdkmessageprocessingsteps",
        {
          select: STEP_SELECT,
          filter: `statecode eq 0 and (${idFilter})`,
          expand: STEP_EXPAND,
        },
      );
      raw.push(...(res.value ?? []));
    }
    raw.sort((a, b) => a.stage - b.stage || a.rank - b.rank);
    pluginSteps = raw.map(toStepInfo);
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return privilegeEnvelope(err);
    }
    sectionNotes.push(`Plug-in steps could not be scanned: ${errText(err)}`);
  }

  let cloudFlows: CloudFlowInfo[] = [];
  let flowsScanTruncated = false;
  try {
    // category 5 = modern cloud flow, type 1 = definition, statecode 1 = activated.
    const res = await client.get<ListResponse<RawFlow>>("workflows", {
      select: ["workflowid", "name", "clientdata"],
      filter: "category eq 5 and type eq 1 and statecode eq 1",
      top: FLOW_SCAN_TOP,
    });
    const flows = res.value ?? [];
    flowsScanTruncated = flows.length >= FLOW_SCAN_TOP;
    for (const flow of flows) {
      if (typeof flow.clientdata !== "string" || flow.clientdata === "") continue;
      const uses = flowUsesTable(flow.clientdata, table);
      if (uses.length === 0) continue;
      cloudFlows.push({
        id: flow.workflowid ?? null,
        name: flow.name ?? "(unnamed flow)",
        uses,
      });
    }
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return privilegeEnvelope(err);
    }
    cloudFlows = [];
    sectionNotes.push(`Cloud flows could not be scanned: ${errText(err)}`);
  }

  let classicWorkflows: ProcessInfo[] = [];
  try {
    classicWorkflows = await fetchProcesses(client, 0, escaped);
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return privilegeEnvelope(err);
    }
    sectionNotes.push(`Classic workflows could not be scanned: ${errText(err)}`);
  }

  let businessRules: ProcessInfo[] = [];
  try {
    businessRules = await fetchProcesses(client, 2, escaped);
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return privilegeEnvelope(err);
    }
    sectionNotes.push(`Business rules could not be scanned: ${errText(err)}`);
  }

  const summary = {
    pluginSteps: pluginSteps.length,
    cloudFlows: cloudFlows.length,
    classicWorkflows: classicWorkflows.length,
    businessRules: businessRules.length,
    total:
      pluginSteps.length +
      cloudFlows.length +
      classicWorkflows.length +
      businessRules.length,
  };

  return {
    table,
    pluginSteps,
    cloudFlows,
    classicWorkflows,
    businessRules,
    summary,
    ...(flowsScanTruncated ? { flowsScanTruncated: true } : {}),
    ...(sectionNotes.length > 0 ? { sectionNotes } : {}),
    ...(summary.total === 0
      ? {
          hint: `No active automation found on '${table}' — check the logical name (singular, lowercase).`,
        }
      : {}),
  };
}

export const whatRunsOnTableTool = defineTool({
  name: "what_runs_on_table",
  description:
    "Maps every piece of active automation registered on one Dataverse table in " +
    "a single view: plug-in steps (with message, stage, mode and rank), " +
    "solution-aware cloud flows that trigger on or act against the table, " +
    "classic workflows and business rules. Use it for impact analysis before " +
    "schema or logic changes. Pass the table's logical name, e.g. 'account'.",
  inputSchema,
  handler: async (input) => {
    try {
      return await whatRunsOnTable(getDefaultClient(), input);
    } catch (err) {
      // whatRunsOnTable traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
