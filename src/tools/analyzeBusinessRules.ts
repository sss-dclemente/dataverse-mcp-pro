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
  "https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-business-rules-recommendations-apply-logic-form";

// workflow.category 2 = Business Rule, type 1 = definition (not an instance).
const CATEGORY_BUSINESS_RULE = 2;
const WORKFLOW_TYPE_DEFINITION = 1;

// workflow.processtriggerscope: 1 = Form, 2 = Entity. NOT workflow.scope, which
// is ownership (1 User / 2 BU / 3 Parent:Child / 4 Organization) and would
// silently misreport every rule.
const TRIGGER_SCOPE_FORM = 1;
const TRIGGER_SCOPE_ENTITY = 2;

// One table's rule pile is small; a cap keeps the query bounded anyway.
const RULE_CAP = 200;

// A field referenced by this many activated rules or more is reported as
// contested — the usual cause of rules fighting each other.
const OVERLAP_MIN_RULES = 2;

const PRIVILEGE_HINT =
  "Reading business rules requires read privilege on the Process (workflow) " +
  "table and on entity metadata. Ask an admin to grant the connecting " +
  "principal the System Customizer role or equivalent read privileges.";

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

export type AnalyzeBusinessRulesInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

// --- Action taxonomy ---------------------------------------------------------

/**
 * Portability per the documented business rule action table: Set Field Value,
 * Set Default Value and Show Error Message apply to "All scopes"; the rest are
 * model-driven-app only and are ignored when a rule runs server-side. Only the
 * portable ones can move into a plug-in.
 *
 * Matching is by marker against the raw clientdata rather than by walking a
 * parsed shape: the business rule definition format is not documented, and
 * markers survive both the JSON and XAML serializations. False positives are
 * possible where a rule's own text repeats an action name — hence `verdict`
 * is always reported alongside the actions it was derived from.
 */
interface ActionRule {
  action: string;
  portable: boolean;
  markers: RegExp[];
}

const ACTION_RULES: ActionRule[] = [
  {
    action: "Set Field Value",
    portable: true,
    markers: [/SetAttributeValue/i, /SetFieldValue/i],
  },
  { action: "Set Default Value", portable: true, markers: [/SetDefaultValue/i] },
  {
    action: "Show Error Message",
    portable: true,
    markers: [/ValidationError/i, /SetErrorMessage/i, /ShowErrorMessage/i],
  },
  { action: "Set Visibility", portable: false, markers: [/SetVisib/i] },
  {
    action: "Lock/Unlock",
    portable: false,
    markers: [/SetDisabled/i, /SetEnabled/i, /LockAttribute/i, /SetLocked/i],
  },
  {
    action: "Set Business Required",
    portable: false,
    markers: [/SetRequiredLevel/i, /SetBusinessRequired/i],
  },
  { action: "Recommendation", portable: false, markers: [/Recommendation/i] },
];

type Verdict = "portable" | "form-only" | "partial" | "unknown";

function detectActions(definition: string): string[] {
  const found: string[] = [];
  for (const rule of ACTION_RULES) {
    if (rule.markers.some((m) => m.test(definition))) found.push(rule.action);
  }
  return found;
}

const PORTABLE_ACTIONS = new Set(
  ACTION_RULES.filter((r) => r.portable).map((r) => r.action),
);

function verdictFor(actions: string[]): Verdict {
  if (actions.length === 0) return "unknown";
  const portable = actions.some((a) => PORTABLE_ACTIONS.has(a));
  const formOnly = actions.some((a) => !PORTABLE_ACTIONS.has(a));
  if (portable && formOnly) return "partial";
  return portable ? "portable" : "form-only";
}

// --- Field resolution --------------------------------------------------------

/**
 * Columns are resolved by intersecting the table's real logical names with the
 * rule definition, which needs no knowledge of the definition's structure.
 * Boundaries stop 'name' matching inside 'accountname'.
 */
function buildColumnMatchers(columns: string[]): Array<{ column: string; re: RegExp }> {
  return columns.map((column) => ({
    column,
    re: new RegExp(`(?<![a-z0-9_])${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`, "i"),
  }));
}

function fieldsIn(
  definition: string,
  matchers: Array<{ column: string; re: RegExp }>,
): string[] {
  return matchers.filter((m) => m.re.test(definition)).map((m) => m.column).sort();
}

// --- Rule shape --------------------------------------------------------------

interface RawRule {
  workflowid?: string;
  name?: string | null;
  statecode?: number;
  processtriggerscope?: number | null;
  processtriggerformid?: string | null;
  ismanaged?: boolean | null;
  modifiedon?: string | null;
  clientdata?: string | null;
  xaml?: string | null;
}

interface RuleInfo {
  id: string;
  name: string;
  state: "draft" | "activated" | "suspended";
  scope: "form" | "entity" | "unknown";
  formId: string | null;
  isManaged: boolean;
  lastModified: string | null;
  actions: string[];
  fieldsReferenced: string[];
  verdict: Verdict;
  actionsUnknown?: true;
}

const RULE_SELECT = [
  "workflowid",
  "name",
  "statecode",
  "processtriggerscope",
  "processtriggerformid",
  "ismanaged",
  "modifiedon",
  "clientdata",
  "xaml",
];

function stateLabel(statecode: number | undefined): RuleInfo["state"] {
  switch (statecode) {
    case 1:
      return "activated";
    case 2:
      return "suspended";
    default:
      return "draft";
  }
}

function scopeLabel(scope: number | null | undefined): RuleInfo["scope"] {
  if (scope === TRIGGER_SCOPE_ENTITY) return "entity";
  if (scope === TRIGGER_SCOPE_FORM) return "form";
  return "unknown";
}

function toRuleInfo(
  raw: RawRule,
  matchers: Array<{ column: string; re: RegExp }>,
): RuleInfo {
  // Either serialization carries the action markers; concatenating avoids
  // depending on which one this rule happens to populate.
  const definition = `${raw.clientdata ?? ""}\n${raw.xaml ?? ""}`;
  const actions = detectActions(definition);
  const verdict = verdictFor(actions);
  return {
    id: raw.workflowid ?? "unknown",
    name: raw.name ?? "(unnamed rule)",
    state: stateLabel(raw.statecode),
    scope: scopeLabel(raw.processtriggerscope),
    formId: raw.processtriggerformid ?? null,
    isManaged: raw.ismanaged === true,
    lastModified: raw.modifiedon ?? null,
    actions,
    fieldsReferenced: fieldsIn(definition, matchers),
    verdict,
    ...(verdict === "unknown" ? { actionsUnknown: true as const } : {}),
  };
}

// --- Findings ----------------------------------------------------------------

interface Finding {
  severity: "high" | "medium" | "low";
  flag: string;
  issue: string;
  recommendation: string;
  evidence: Record<string, number>;
}

function buildFindings(rules: RuleInfo[]): Finding[] {
  const findings: Finding[] = [];
  const active = rules.filter((r) => r.state === "activated");

  const byField = new Map<string, string[]>();
  for (const rule of active) {
    for (const field of rule.fieldsReferenced) {
      const owners = byField.get(field) ?? [];
      owners.push(rule.name);
      byField.set(field, owners);
    }
  }
  const contested = [...byField.entries()]
    .filter(([, owners]) => owners.length >= OVERLAP_MIN_RULES)
    .sort((a, b) => b[1].length - a[1].length);
  if (contested.length > 0) {
    const worst = contested
      .slice(0, 5)
      .map(([field, owners]) => `${field} (${owners.length} rules)`)
      .join(", ");
    findings.push({
      severity: "medium",
      flag: "overlapping-fields",
      issue:
        `${contested.length} column(s) are referenced by more than one activated ` +
        `business rule: ${worst}. Rules that touch the same column can contradict ` +
        "each other, and their relative order is not guaranteed.",
      recommendation:
        "Review these columns first — merging the rules that share one column is " +
        "usually a bigger win than moving logic to a plug-in.",
      evidence: { contestedColumns: contested.length },
    });
  }

  const formScopedPortable = active.filter(
    (r) => r.scope === "form" && (r.verdict === "portable" || r.verdict === "partial"),
  );
  if (formScopedPortable.length > 0) {
    findings.push({
      severity: "medium",
      flag: "form-scope-only",
      issue:
        `${formScopedPortable.length} activated rule(s) carry data logic but are ` +
        "scoped to a form, so they do not run on API writes, imports or flows.",
      recommendation:
        "Either widen the scope to Entity (it then runs server-side as-is) or move " +
        "the logic into the plug-in. Do not assume this logic is enforced today.",
      evidence: { formScopedDataRules: formScopedPortable.length },
    });
  }

  const partial = active.filter((r) => r.verdict === "partial");
  if (partial.length > 0) {
    findings.push({
      severity: "low",
      flag: "mixed-verdict-rule",
      issue:
        `${partial.length} activated rule(s) mix data actions with form-only ` +
        "actions (visibility, lock, business required, recommendation).",
      recommendation:
        "These cannot move wholesale. Split each one: the data half goes to the " +
        "plug-in, the form half stays a business rule.",
      evidence: { mixedRules: partial.length },
    });
  }

  const drafts = rules.filter((r) => r.state !== "activated");
  if (drafts.length > 0) {
    findings.push({
      severity: "low",
      flag: "draft-rules",
      issue: `${drafts.length} rule(s) on this table are not activated.`,
      recommendation:
        "Delete the ones that are no longer needed — they inflate the apparent " +
        "size of the problem without doing anything.",
      evidence: { inactiveRules: drafts.length },
    });
  }

  const unknown = rules.filter((r) => r.verdict === "unknown");
  if (unknown.length > 0) {
    findings.push({
      severity: "low",
      flag: "unclassified-rules",
      issue:
        `${unknown.length} rule(s) had no recognisable action in their stored ` +
        "definition, so they could not be classified.",
      recommendation:
        "Open these in the maker portal and classify them by hand before quoting " +
        "a consolidation scope.",
      evidence: { unclassifiedRules: unknown.length },
    });
  }

  const order: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

// --- Plug-in proposal --------------------------------------------------------

interface PluginProposal {
  messages: string[];
  stage: string;
  mode: string;
  filteringAttributes: string[];
  replaces: string[];
  partiallyReplaces: Array<{ rule: string; formOnlyActionsThatMustStay: string[] }>;
  staysDeclarative: Array<{ rule: string; reason: string }>;
  note: string;
}

function buildProposal(rules: RuleInfo[]): PluginProposal | undefined {
  const active = rules.filter((r) => r.state === "activated");
  const movable = active.filter(
    (r) => r.verdict === "portable" || r.verdict === "partial",
  );
  if (movable.length === 0) return undefined;

  const attributes = [...new Set(movable.flatMap((r) => r.fieldsReferenced))].sort();
  const managed = movable.filter((r) => r.isManaged).length;

  return {
    messages: ["Create", "Update"],
    stage: "PreOperation",
    mode: "sync",
    filteringAttributes: attributes,
    replaces: active.filter((r) => r.verdict === "portable").map((r) => r.name),
    partiallyReplaces: active
      .filter((r) => r.verdict === "partial")
      .map((r) => ({
        rule: r.name,
        formOnlyActionsThatMustStay: r.actions.filter(
          (a) => !PORTABLE_ACTIONS.has(a),
        ),
      })),
    staysDeclarative: active
      .filter((r) => r.verdict === "form-only")
      .map((r) => ({
        rule: r.name,
        reason: `Only form-only actions (${r.actions.join(", ")}) — a plug-in cannot do these.`,
      })),
    note:
      "One step, not one per rule: the filtering attributes are what keep it cheap. " +
      (managed > 0
        ? `${managed} of these rules are managed and cannot be deactivated in this environment without an update to their solution. `
        : "") +
      "Deactivate the replaced rules in the same deployment as the plug-in, or both will run.",
  };
}

// --- Error mapping -----------------------------------------------------------

function privilegeEnvelope(err: DataverseHttpError): ErrorEnvelope {
  return errorEnvelope(err.dataverseMessage ?? err.message, {
    hint: PRIVILEGE_HINT,
    docsUrl: DOCS_URL,
  });
}

function errText(err: unknown): string {
  if (err instanceof DataverseHttpError) return err.dataverseMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// --- Core --------------------------------------------------------------------

interface RawAttribute {
  LogicalName?: string;
}

export async function analyzeBusinessRules(
  client: Pick<DataverseClient, "get">,
  input: AnalyzeBusinessRulesInput,
): Promise<unknown> {
  const table = input.table.trim().toLowerCase();
  const escaped = escapeODataString(table);
  const sectionNotes: string[] = [];

  // Metadata first: it doubles as table-name validation. The rule query alone
  // cannot do that — a mistyped logical name returns zero rows, which reads as
  // "this table has no business rules".
  let columns: string[];
  try {
    const res = await client.get<ListResponse<RawAttribute>>(
      `EntityDefinitions(LogicalName='${escaped}')/Attributes`,
      { select: ["LogicalName"] },
    );
    columns = (res.value ?? [])
      .map((a) => a.LogicalName)
      .filter((n): n is string => typeof n === "string" && n !== "");
  } catch (err) {
    if (err instanceof DataverseHttpError) {
      if (err.status === 403) return privilegeEnvelope(err);
      if (err.status === 404) {
        return errorEnvelope(err.dataverseMessage ?? err.message, {
          hint:
            `No table with logical name '${table}' exists. Use the singular, ` +
            "lowercase logical name (e.g. 'account', not 'Accounts').",
          docsUrl: DOCS_URL,
        });
      }
    }
    return toErrorEnvelope(err);
  }

  const matchers = buildColumnMatchers(columns);

  let raw: RawRule[];
  try {
    const res = await client.get<ListResponse<RawRule>>("workflows", {
      select: RULE_SELECT,
      filter:
        `category eq ${CATEGORY_BUSINESS_RULE} and ` +
        `type eq ${WORKFLOW_TYPE_DEFINITION} and primaryentity eq '${escaped}'`,
      top: RULE_CAP,
    });
    raw = res.value ?? [];
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return privilegeEnvelope(err);
    }
    return toErrorEnvelope(err);
  }

  const truncated = raw.length >= RULE_CAP;
  const rules = raw
    .map((r) => toRuleInfo(r, matchers))
    .sort((a, b) => a.name.localeCompare(b.name));

  const active = rules.filter((r) => r.state === "activated");
  const summary = {
    total: rules.length,
    activated: active.length,
    inactive: rules.length - active.length,
    entityScoped: active.filter((r) => r.scope === "entity").length,
    formScoped: active.filter((r) => r.scope === "form").length,
    portable: active.filter((r) => r.verdict === "portable").length,
    partial: active.filter((r) => r.verdict === "partial").length,
    formOnly: active.filter((r) => r.verdict === "form-only").length,
    unclassified: active.filter((r) => r.verdict === "unknown").length,
  };

  const proposal = buildProposal(rules);

  if (columns.length === 0) {
    sectionNotes.push(
      "No columns were returned for this table, so no fields could be resolved " +
        "and overlap detection is not meaningful.",
    );
  }

  let hint: string | undefined;
  if (rules.length === 0) {
    hint = `No business rules are defined on '${table}'.`;
  } else if (proposal === undefined) {
    hint =
      "Nothing here can move to a plug-in: every activated rule is form-only " +
      "behaviour (visibility, lock, business required, recommendation), which a " +
      "plug-in cannot do. Consolidate the rules themselves, or replace them with " +
      "one form script.";
  }

  return {
    table,
    summary,
    rules,
    findings: buildFindings(rules),
    ...(proposal !== undefined ? { pluginProposal: proposal } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(sectionNotes.length > 0 ? { sectionNotes } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

export const analyzeBusinessRulesTool = defineTool({
  name: "analyze_business_rules",
  description:
    "Assessment follow-on: should this table's business rules become a plug-in? " +
    "Reads every business rule on one Dataverse table — activated and draft — and " +
    "reports each one's trigger scope (Form vs Entity), managed state, the actions " +
    "it performs and the columns it references. Classifies each rule portable, " +
    "form-only or partial: Set Field Value, Set Default Value and Show Error " +
    "Message can run server-side, while visibility, lock, business required and " +
    "recommendation cannot and are ignored off the form. Flags columns contested " +
    "by several rules, form-scoped data logic and inactive rules, and where any " +
    "logic is portable proposes the single plug-in step that would replace it " +
    "(message, stage, filtering attributes). One table per call, capped at 200 " +
    "rules with truncated set when hit. Read-only: it proposes a registration, it " +
    "does not create one. Pass the table's logical name, e.g. 'account'.",
  inputSchema,
  handler: async (input) => {
    try {
      return await analyzeBusinessRules(getDefaultClient(), input);
    } catch (err) {
      // analyzeBusinessRules traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
