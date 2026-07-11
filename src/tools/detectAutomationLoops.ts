import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";
import { isEnterpriseLicensed, enterpriseUpgradeMessage } from "../licensing.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/dataverse/create-update-delete-trigger";

// workflow.category 5 = Modern Flow, type 1 = Definition, statecode 1 = activated.
const ACTIVE_CLOUD_FLOW_FILTER = "category eq 5 and type eq 1 and statecode eq 1";

// Dataverse connector operations that write rows.
const WRITE_OPERATION_IDS = new Set([
  "CreateRecord",
  "UpdateRecord",
  "UpdateOnlyRecord",
  "UpsertRecord",
  "DeleteRecord",
]);

// Cycles longer than 3 flows are rarely actionable and blow up the search space.
const MAX_CYCLE_LENGTH = 3;
// Defensive cap when walking nested action containers of a malformed definition.
const MAX_WALK_DEPTH = 10;

const NO_LOOPS_HINT = "No suspected loops detected among scanned flows";
const NO_LOOPS_NOTE =
  "This check is definition-based and covers cloud flows only. Plug-in-side " +
  "loops surface as depth flags in analyze_plugin_performance — run it for the " +
  "same tables to cover plugin↔flow ping-pong.";

const inputSchema = z.object({
  maxFlows: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .default(500)
    .describe(
      "Maximum number of activated cloud flows to scan, 10–1000 (default 500). " +
        "When the environment has more flows than this, the result is flagged truncated.",
    ),
});

export type DetectAutomationLoopsInput = z.infer<typeof inputSchema>;

interface RawWorkflow {
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Naive singular form of a Dataverse entity-set name so trigger tables
 * ("account") and write targets ("accounts") compare equal:
 * "ies" -> "y" ("opportunities" -> "opportunity"), else trim one trailing "s".
 */
export function singularize(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}

interface FlowNode {
  id: string;
  name: string;
  triggerTable?: string;
  triggerHasFilteringAttributes: boolean;
  writesTables: string[];
}

function isDataverseTrigger(node: JsonRecord): boolean {
  const type = asString(node["type"]) ?? "";
  if (type === "OpenApiConnectionWebhook" || type === "ApiConnectionWebhook") {
    return true;
  }
  const inputs = node["inputs"];
  if (inputs === undefined) return false;
  return JSON.stringify(inputs).toLowerCase().includes("commondataservice");
}

/** First parameter whose key mentions "entityname" (e.g. "subscriptionRequest/entityname"). */
function entityFromParameters(parameters: JsonRecord): string | null {
  for (const [key, value] of Object.entries(parameters)) {
    if (!key.toLowerCase().includes("entityname")) continue;
    const entity = asString(value);
    if (entity !== null) return singularize(entity);
  }
  return null;
}

function triggerHasFiltering(node: JsonRecord, parameters: JsonRecord): boolean {
  for (const [key, value] of Object.entries(parameters)) {
    if (!key.toLowerCase().includes("filteringattributes")) continue;
    const attrs = asString(value);
    if (attrs !== null && attrs.trim() !== "") return true;
  }
  // Trigger conditions live in node.conditions (or runtimeConfiguration.conditions
  // in some exports); either also prevents naive re-triggering.
  const conditions = node["conditions"];
  if (Array.isArray(conditions) && conditions.length > 0) return true;
  const runtimeConditions =
    asRecord(node["runtimeConfiguration"])?.["conditions"];
  return Array.isArray(runtimeConditions) && runtimeConditions.length > 0;
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

/** Recursively collect the tables written by Dataverse write actions. */
function collectWrites(record: JsonRecord, depth: number, out: Set<string>): void {
  if (depth > MAX_WALK_DEPTH) return;
  for (const value of Object.values(record)) {
    const node = asRecord(value);
    if (node === null) continue;
    const inputs = asRecord(node["inputs"]);
    const host = asRecord(inputs?.["host"]);
    const operationId = asString(host?.["operationId"]);
    if (operationId !== null && WRITE_OPERATION_IDS.has(operationId)) {
      const parameters = asRecord(inputs?.["parameters"]) ?? {};
      const entity = entityFromParameters(parameters);
      if (entity !== null) out.add(entity);
    }
    for (const group of childGroups(node)) {
      collectWrites(group, depth + 1, out);
    }
  }
}

/** Defensive parse of workflow.clientdata; "unparseable" only for broken JSON. */
function parseFlow(raw: RawWorkflow): FlowNode | "unparseable" {
  const clientdata = raw.clientdata;
  if (typeof clientdata !== "string" || clientdata.trim() === "") {
    return "unparseable";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientdata);
  } catch {
    return "unparseable";
  }
  const definition = asRecord(
    asRecord(asRecord(parsed)?.["properties"])?.["definition"],
  );

  let triggerTable: string | undefined;
  let hasFiltering = false;
  const triggers = asRecord(definition?.["triggers"]) ?? {};
  for (const value of Object.values(triggers)) {
    const node = asRecord(value);
    if (node === null || !isDataverseTrigger(node)) continue;
    const parameters = asRecord(asRecord(node["inputs"])?.["parameters"]) ?? {};
    const entity = entityFromParameters(parameters);
    if (entity === null) continue;
    triggerTable = entity;
    hasFiltering = triggerHasFiltering(node, parameters);
    break;
  }

  const writes = new Set<string>();
  const actions = asRecord(definition?.["actions"]);
  if (actions !== null) collectWrites(actions, 0, writes);

  return {
    id: raw.workflowid ?? "",
    name: raw.name ?? "(unnamed flow)",
    ...(triggerTable !== undefined ? { triggerTable } : {}),
    triggerHasFilteringAttributes: hasFiltering,
    writesTables: [...writes],
  };
}

interface SuspectedLoop {
  severity: "high" | "medium";
  kind: "self-loop" | "cycle";
  flows: Array<{ id: string; name: string }>;
  tables: string[];
  evidence: string;
  recommendation: string;
}

const SELF_LOOP_RECOMMENDATION =
  "Add trigger filtering attributes or a trigger condition so the flow does not " +
  "re-fire on its own writes, or break the loop with a guard column the flow " +
  "checks before writing. Plug-in steps on the same table can extend the loop — " +
  "check them with what_runs_on_table.";

const CYCLE_RECOMMENDATION =
  "Break the chain by adding trigger filtering attributes or trigger conditions " +
  "to at least one flow, or introduce a guard column that stops the hand-off. " +
  "Plug-in steps on these tables can extend the cycle — check each table with " +
  "what_runs_on_table.";

function selfLoops(nodes: FlowNode[]): SuspectedLoop[] {
  const loops: SuspectedLoop[] = [];
  for (const node of nodes) {
    const table = node.triggerTable;
    if (table === undefined || !node.writesTables.includes(table)) continue;
    const filtered = node.triggerHasFilteringAttributes;
    loops.push({
      severity: filtered ? "medium" : "high",
      kind: "self-loop",
      flows: [{ id: node.id, name: node.name }],
      tables: [table],
      evidence: filtered
        ? `Flow "${node.name}" triggers on ${table} and writes to ${table}; ` +
          "trigger filtering attributes or conditions are set, which reduces " +
          "but does not remove the risk of re-triggering itself."
        : `Flow "${node.name}" triggers on ${table} and writes to ${table} ` +
          "without trigger filtering attributes or trigger conditions.",
      recommendation: SELF_LOOP_RECOMMENDATION,
    });
  }
  return loops;
}

/** Rotate a cycle so the lexicographically-smallest flow id comes first. */
function canonicalRotate(ids: string[]): string[] {
  let minIdx = 0;
  for (let i = 1; i < ids.length; i += 1) {
    const candidate = ids[i];
    const current = ids[minIdx];
    if (candidate !== undefined && current !== undefined && candidate < current) {
      minIdx = i;
    }
  }
  return [...ids.slice(minIdx), ...ids.slice(0, minIdx)];
}

/** Directed cycles of length 2..MAX_CYCLE_LENGTH, each reported once. */
function findCycles(nodes: FlowNode[]): FlowNode[][] {
  const byId = new Map<string, FlowNode>();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) byId.set(node.id, node);
  for (const from of nodes) {
    const targets: string[] = [];
    for (const to of nodes) {
      if (from.id === to.id) continue;
      if (to.triggerTable !== undefined && from.writesTables.includes(to.triggerTable)) {
        targets.push(to.id);
      }
    }
    adjacency.set(from.id, targets);
  }

  const seen = new Set<string>();
  const cycles: FlowNode[][] = [];
  const dfs = (startId: string, currentId: string, path: string[]): void => {
    for (const nextId of adjacency.get(currentId) ?? []) {
      if (nextId === startId) {
        if (path.length < 2) continue; // self-loops are reported separately
        const rotated = canonicalRotate(path);
        const key = rotated.join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const flows: FlowNode[] = [];
        for (const id of rotated) {
          const node = byId.get(id);
          if (node !== undefined) flows.push(node);
        }
        cycles.push(flows);
        continue;
      }
      if (path.length >= MAX_CYCLE_LENGTH || path.includes(nextId)) continue;
      dfs(startId, nextId, [...path, nextId]);
    }
  };
  for (const node of nodes) dfs(node.id, node.id, [node.id]);
  return cycles;
}

function cycleLoops(nodes: FlowNode[]): SuspectedLoop[] {
  return findCycles(nodes).map((cycle) => {
    const segments = cycle.map((flow, i) => {
      const next = cycle[(i + 1) % cycle.length];
      return (
        `"${flow.name}" triggers on ${flow.triggerTable ?? "unknown"} ` +
        `and writes to ${next?.triggerTable ?? "unknown"}`
      );
    });
    return {
      severity: "medium" as const,
      kind: "cycle" as const,
      flows: cycle.map((flow) => ({ id: flow.id, name: flow.name })),
      tables: cycle.map((flow) => flow.triggerTable ?? "unknown"),
      evidence: `${segments.join(" → ")} → back to the start.`,
      recommendation: CYCLE_RECOMMENDATION,
    };
  });
}

export async function detectAutomationLoops(
  client: Pick<DataverseClient, "get">,
  input: DetectAutomationLoopsInput,
): Promise<unknown> {
  try {
    const response = await client.get<{ value: RawWorkflow[] }>("workflows", {
      select: ["workflowid", "name", "clientdata"],
      filter: ACTIVE_CLOUD_FLOW_FILTER,
      top: input.maxFlows,
    });
    const rows = response.value ?? [];

    let parseFailures = 0;
    const nodes: FlowNode[] = [];
    for (const raw of rows) {
      const parsed = parseFlow(raw);
      if (parsed === "unparseable") {
        parseFailures += 1;
        continue;
      }
      nodes.push(parsed);
    }

    const withTrigger = nodes.filter((node) => node.triggerTable !== undefined);
    const loops = [...selfLoops(withTrigger), ...cycleLoops(withTrigger)];
    const severityOrder: Record<SuspectedLoop["severity"], number> = {
      high: 0,
      medium: 1,
    };
    loops.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return {
      flowsScanned: rows.length,
      flowsWithDataverseTrigger: withTrigger.length,
      suspectedLoops: loops,
      ...(rows.length >= input.maxFlows ? { truncated: true } : {}),
      ...(parseFailures > 0 ? { parseFailures } : {}),
      ...(loops.length === 0 ? { hint: NO_LOOPS_HINT, note: NO_LOOPS_NOTE } : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Scanning flow definitions requires read privilege on the Process " +
          "(workflow) table, including its clientdata column. Ask an admin for a " +
          "security role with read access to Process (e.g. System Customizer), " +
          "or run as a user who can see the flows.",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const detectAutomationLoopsTool = defineTool({
  name: "detect_automation_loops",
  description:
    "Detects suspected trigger→write loops between Power Automate cloud flows on " +
    "Dataverse tables: flows that write the table they trigger on (self-loops) and " +
    "chains of 2–3 flows whose writes trigger each other (cycles). Heuristic, " +
    "definition-based analysis of activated cloud flows (workflow.clientdata); " +
    "flags missing trigger filtering attributes. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isEnterpriseLicensed()) return enterpriseUpgradeMessage("detect_automation_loops");
    try {
      return await detectAutomationLoops(getDefaultClient(), input);
    } catch (err) {
      // detectAutomationLoops traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
