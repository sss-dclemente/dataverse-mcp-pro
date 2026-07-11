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

const METADATA_DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-metadata-web-api";

const MAX_COLUMNS = 300;
const DESCRIPTION_MAX_CHARS = 200;
const MARKDOWN_MAX_CHARS = 8000;
const MARKDOWN_COLUMN_ROWS = 100;
const STEP_TOP_COUNT = 10;
const FLOW_NAME_CAP = 15;
// Keep OData $filter clauses well below URL-length limits when expanding
// message-filter ids into `id eq guid or ...` chains.
const FILTER_ID_CHUNK_SIZE = 25;
// workflow.category 5 = Modern Flow (cloud flow); workflow.type 1 = Definition.
const CLOUD_FLOW_CATEGORY = 5;
const WORKFLOW_TYPE_DEFINITION = 1;

const inputSchema = z.object({
  table: z
    .string()
    .min(1)
    .describe(
      "Logical name of the table to document (singular lowercase, e.g. " +
        "'account' or 'new_project').",
    ),
  includeAutomation: z
    .boolean()
    .default(true)
    .describe(
      "Also summarize active plug-in steps and cloud flows that reference the " +
        "table. Defaults to true.",
    ),
});

export type DocumentTableInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

// Metadata labels are objects, not strings: the display text lives in
// UserLocalizedLabel (caller's language) with LocalizedLabels as fallback.
interface RawLabelPart {
  Label?: string | null;
}

interface RawLabel {
  UserLocalizedLabel?: RawLabelPart | null;
  LocalizedLabels?: RawLabelPart[] | null;
}

function labelText(label: RawLabel | null | undefined): string | null {
  const text =
    label?.UserLocalizedLabel?.Label ??
    label?.LocalizedLabels?.[0]?.Label ??
    null;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}

interface RawAttribute {
  LogicalName?: string;
  SchemaName?: string;
  AttributeType?: string | null;
  DisplayName?: RawLabel | null;
  Description?: RawLabel | null;
  // Managed property: the actual level is nested under Value.
  RequiredLevel?: { Value?: string | null } | null;
  IsCustomAttribute?: boolean | null;
}

interface RawOneToMany {
  SchemaName?: string;
  ReferencedEntity?: string;
  ReferencingEntity?: string;
  ReferencingAttribute?: string;
}

interface RawManyToOne {
  SchemaName?: string;
  ReferencedEntity?: string;
  ReferencingAttribute?: string;
}

interface RawManyToMany {
  SchemaName?: string;
  Entity1LogicalName?: string;
  Entity2LogicalName?: string;
}

interface RawKey {
  LogicalName?: string;
  KeyAttributes?: string[];
}

interface RawEntityMetadata {
  LogicalName?: string;
  SchemaName?: string;
  DisplayName?: RawLabel | null;
  Description?: RawLabel | null;
  PrimaryIdAttribute?: string;
  PrimaryNameAttribute?: string;
  IsCustomEntity?: boolean;
  OwnershipType?: string | null;
  Attributes?: RawAttribute[];
  OneToManyRelationships?: RawOneToMany[];
  ManyToOneRelationships?: RawManyToOne[];
  ManyToManyRelationships?: RawManyToMany[];
  Keys?: RawKey[];
}

interface TableDoc {
  logicalName: string;
  schemaName: string;
  displayName?: string;
  description?: string;
  isCustom: boolean;
  ownershipType: string;
  primaryId: string | null;
  primaryName: string | null;
}

interface ColumnDoc {
  logicalName: string;
  schemaName: string;
  type: string;
  displayName?: string;
  description?: string;
  required: string;
  isCustom: boolean;
}

interface RelationshipsDoc {
  oneToMany: Array<{
    schemaName: string;
    referencedEntity: string;
    referencingEntity: string;
    referencingAttribute: string;
  }>;
  manyToOne: Array<{
    schemaName: string;
    referencedEntity: string;
    referencingAttribute: string;
  }>;
  manyToMany: Array<{
    schemaName: string;
    entity1LogicalName: string;
    entity2LogicalName: string;
  }>;
}

interface KeyDoc {
  name: string;
  attributes: string[];
}

interface AutomationStepDoc {
  name: string;
  message: string;
  stage: string;
  mode: "sync" | "async";
}

interface PluginStepSummary {
  count: number;
  top: AutomationStepDoc[];
}

interface CloudFlowSummary {
  count: number;
  names: string[];
}

interface AutomationDoc {
  pluginSteps?: PluginStepSummary;
  cloudFlows?: CloudFlowSummary;
}

function toColumn(raw: RawAttribute): ColumnDoc {
  const displayName = labelText(raw.DisplayName);
  const description = labelText(raw.Description);
  return {
    logicalName: raw.LogicalName ?? "",
    schemaName: raw.SchemaName ?? raw.LogicalName ?? "",
    type: raw.AttributeType ?? "unknown",
    ...(displayName !== null ? { displayName } : {}),
    ...(description !== null
      ? { description: description.slice(0, DESCRIPTION_MAX_CHARS) }
      : {}),
    required: raw.RequiredLevel?.Value ?? "None",
    isCustom: raw.IsCustomAttribute === true,
  };
}

function mapRelationships(meta: RawEntityMetadata): RelationshipsDoc {
  return {
    oneToMany: (meta.OneToManyRelationships ?? []).map((r) => ({
      schemaName: r.SchemaName ?? "unknown",
      referencedEntity: r.ReferencedEntity ?? "unknown",
      referencingEntity: r.ReferencingEntity ?? "unknown",
      referencingAttribute: r.ReferencingAttribute ?? "unknown",
    })),
    manyToOne: (meta.ManyToOneRelationships ?? []).map((r) => ({
      schemaName: r.SchemaName ?? "unknown",
      referencedEntity: r.ReferencedEntity ?? "unknown",
      referencingAttribute: r.ReferencingAttribute ?? "unknown",
    })),
    manyToMany: (meta.ManyToManyRelationships ?? []).map((r) => ({
      schemaName: r.SchemaName ?? "unknown",
      entity1LogicalName: r.Entity1LogicalName ?? "unknown",
      entity2LogicalName: r.Entity2LogicalName ?? "unknown",
    })),
  };
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

interface RawAutomationStep {
  name?: string | null;
  stage?: number | null;
  mode?: number | null;
  sdkmessageid?: { name?: string | null } | null;
}

async function summarizePluginSteps(
  client: Pick<DataverseClient, "get">,
  table: string,
): Promise<PluginStepSummary> {
  const filters = await client.get<ListResponse<{ sdkmessagefilterid: string }>>(
    "sdkmessagefilters",
    {
      select: ["sdkmessagefilterid"],
      filter: `primaryobjecttypecode eq '${escapeODataString(table)}'`,
      top: 200,
    },
  );
  const ids = filters.value.map((f) => f.sdkmessagefilterid);
  if (ids.length === 0) return { count: 0, top: [] };

  const steps: RawAutomationStep[] = [];
  for (let i = 0; i < ids.length; i += FILTER_ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + FILTER_ID_CHUNK_SIZE);
    const idFilter = chunk
      .map((id) => `_sdkmessagefilterid_value eq ${id}`)
      .join(" or ");
    const res = await client.get<ListResponse<RawAutomationStep>>(
      "sdkmessageprocessingsteps",
      {
        select: ["name", "stage", "mode"],
        filter: `statecode eq 0 and (${idFilter})`,
        expand: "sdkmessageid($select=name)",
      },
    );
    steps.push(...res.value);
  }

  return {
    count: steps.length,
    top: steps.slice(0, STEP_TOP_COUNT).map((s) => ({
      name: s.name ?? "(unnamed step)",
      message: s.sdkmessageid?.name ?? "unknown",
      stage: stageLabel(s.stage),
      mode: s.mode === 1 ? "async" : "sync",
    })),
  };
}

function naivePlural(name: string): string {
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`;
  if (name.endsWith("s")) return `${name}es`;
  return `${name}s`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RawFlow {
  workflowid?: string;
  name?: string | null;
  clientdata?: string | null;
}

async function summarizeCloudFlows(
  client: Pick<DataverseClient, "get">,
  table: string,
): Promise<CloudFlowSummary> {
  const res = await client.get<ListResponse<RawFlow>>("workflows", {
    select: ["workflowid", "name", "clientdata"],
    filter:
      `category eq ${CLOUD_FLOW_CATEGORY} and ` +
      `type eq ${WORKFLOW_TYPE_DEFINITION} and statecode eq 1`,
    top: 300,
  });
  // Substring heuristic: Dataverse-connector nodes carry the target table in
  // an "entityname"-suffixed parameter key (e.g. subscriptionRequest/entityname
  // for triggers, plural entity set for list/create actions).
  const pattern = new RegExp(
    `entityname"\\s*:\\s*"(?:${escapeRegExp(table)}|${escapeRegExp(naivePlural(table))})"`,
    "i",
  );
  const matching = res.value.filter(
    (w) => typeof w.clientdata === "string" && pattern.test(w.clientdata),
  );
  return {
    count: matching.length,
    names: matching
      .slice(0, FLOW_NAME_CAP)
      .map((w) => w.name ?? "(unnamed flow)"),
  };
}

function buildMarkdown(
  table: TableDoc,
  columnCount: number,
  columns: ColumnDoc[],
  relationships: RelationshipsDoc,
  keys: KeyDoc[],
  automation: AutomationDoc | undefined,
  sectionNotes: string[],
): string {
  const lines: string[] = [];
  lines.push(`# ${table.displayName ?? table.logicalName}`);
  lines.push("");
  lines.push(
    `Schema name: ${table.schemaName} · Ownership: ${table.ownershipType} · ` +
      `${table.isCustom ? "Custom" : "Standard"} table · ` +
      `Primary name: ${table.primaryName ?? "—"}`,
  );
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  const relationshipCount =
    relationships.oneToMany.length +
    relationships.manyToOne.length +
    relationships.manyToMany.length;
  lines.push(
    table.description ??
      `Dataverse ${table.isCustom ? "custom" : "standard"} table ` +
        `\`${table.logicalName}\` with ${columnCount} columns, ` +
        `${relationshipCount} relationships and ${keys.length} alternate key(s).`,
  );
  lines.push("");
  lines.push("## Columns");
  lines.push("");
  lines.push("| Logical name | Type | Required | Display name |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of columns.slice(0, MARKDOWN_COLUMN_ROWS)) {
    lines.push(
      `| ${c.logicalName} | ${c.type} | ${c.required} | ${c.displayName ?? "—"} |`,
    );
  }
  if (columnCount > MARKDOWN_COLUMN_ROWS) {
    lines.push("");
    lines.push(`_…and ${columnCount - MARKDOWN_COLUMN_ROWS} more columns._`);
  }
  lines.push("");
  lines.push("## Relationships");
  lines.push("");
  lines.push("### One-to-many (this table as parent)");
  lines.push("");
  if (relationships.oneToMany.length === 0) lines.push("_(none)_");
  for (const r of relationships.oneToMany) {
    lines.push(
      `- **${r.schemaName}** — referenced by \`${r.referencingEntity}.${r.referencingAttribute}\``,
    );
  }
  lines.push("");
  lines.push("### Many-to-one (lookups on this table)");
  lines.push("");
  if (relationships.manyToOne.length === 0) lines.push("_(none)_");
  for (const r of relationships.manyToOne) {
    lines.push(
      `- **${r.schemaName}** — \`${r.referencingAttribute}\` → \`${r.referencedEntity}\``,
    );
  }
  lines.push("");
  lines.push("### Many-to-many");
  lines.push("");
  if (relationships.manyToMany.length === 0) lines.push("_(none)_");
  for (const r of relationships.manyToMany) {
    lines.push(
      `- **${r.schemaName}** — \`${r.entity1LogicalName}\` ↔ \`${r.entity2LogicalName}\``,
    );
  }
  lines.push("");
  lines.push("## Keys");
  lines.push("");
  if (keys.length === 0) lines.push("_(none)_");
  for (const k of keys) {
    lines.push(`- **${k.name}**: ${k.attributes.join(", ")}`);
  }
  if (automation !== undefined) {
    lines.push("");
    lines.push("## Automation");
    lines.push("");
    if (automation.pluginSteps !== undefined) {
      lines.push(`Active plug-in steps: ${automation.pluginSteps.count}`);
      for (const s of automation.pluginSteps.top) {
        lines.push(`- **${s.name}** — ${s.message}, ${s.stage}, ${s.mode}`);
      }
      lines.push("");
    }
    if (automation.cloudFlows !== undefined) {
      lines.push(
        `Active cloud flows referencing this table: ${automation.cloudFlows.count}`,
      );
      for (const name of automation.cloudFlows.names) {
        lines.push(`- ${name}`);
      }
      lines.push("");
    }
    for (const note of sectionNotes) {
      lines.push(`_Note: ${note}_`);
    }
  }

  const markdown = lines.join("\n");
  return markdown.length > MARKDOWN_MAX_CHARS
    ? `${markdown.slice(0, MARKDOWN_MAX_CHARS)}…(truncated)`
    : markdown;
}

const ENTITY_SELECT = [
  "DisplayName",
  "LogicalName",
  "SchemaName",
  "Description",
  "PrimaryIdAttribute",
  "PrimaryNameAttribute",
  "IsCustomEntity",
  "OwnershipType",
];

const ENTITY_EXPAND =
  "Attributes($select=LogicalName,SchemaName,AttributeType,DisplayName,Description,RequiredLevel,IsCustomAttribute)," +
  "OneToManyRelationships($select=SchemaName,ReferencedEntity,ReferencingEntity,ReferencingAttribute)," +
  "ManyToOneRelationships($select=SchemaName,ReferencedEntity,ReferencingAttribute)," +
  "ManyToManyRelationships($select=SchemaName,Entity1LogicalName,Entity2LogicalName)," +
  "Keys($select=LogicalName,KeyAttributes)";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function documentTable(
  client: Pick<DataverseClient, "get">,
  input: DocumentTableInput,
): Promise<unknown> {
  try {
    let meta: RawEntityMetadata;
    try {
      meta = await client.get<RawEntityMetadata>(
        `EntityDefinitions(LogicalName='${escapeODataString(input.table)}')`,
        { select: ENTITY_SELECT, expand: ENTITY_EXPAND },
      );
    } catch (err) {
      if (err instanceof DataverseHttpError && err.status === 404) {
        return errorEnvelope(`Table not found: "${input.table}"`, {
          hint:
            "Pass the table's logical name — singular and lowercase (e.g. " +
            "'account', not 'Accounts' or the display name). Custom tables " +
            "keep their publisher prefix (e.g. 'new_project').",
        });
      }
      if (err instanceof DataverseHttpError && err.status === 400) {
        return errorEnvelope(err.dataverseMessage ?? err.message, {
          hint:
            "Dataverse rejected the metadata query. EntityDefinitions supports " +
            "only a limited set of $expand/$select options, and some " +
            "properties are unavailable on older environments.",
          docsUrl: METADATA_DOCS_URL,
        });
      }
      throw err;
    }

    const displayName = labelText(meta.DisplayName);
    const description = labelText(meta.Description);
    const table: TableDoc = {
      logicalName: meta.LogicalName ?? input.table,
      schemaName: meta.SchemaName ?? meta.LogicalName ?? input.table,
      ...(displayName !== null ? { displayName } : {}),
      ...(description !== null ? { description } : {}),
      isCustom: meta.IsCustomEntity === true,
      ownershipType: meta.OwnershipType ?? "unknown",
      primaryId: meta.PrimaryIdAttribute ?? null,
      primaryName: meta.PrimaryNameAttribute ?? null,
    };

    // Virtual attributes (formatted-value shadows like *_base/yominame,
    // entityimage_url, ...) are noise in documentation.
    const mapped = (meta.Attributes ?? [])
      .filter((a) => a.AttributeType !== "Virtual")
      .map(toColumn);
    const columnCount = mapped.length;
    const columnsTruncated = mapped.length > MAX_COLUMNS;
    const columns = mapped.slice(0, MAX_COLUMNS);

    const relationships = mapRelationships(meta);
    const keys: KeyDoc[] = (meta.Keys ?? []).map((k) => ({
      name: k.LogicalName ?? "unknown",
      attributes: k.KeyAttributes ?? [],
    }));

    // Each automation sub-query is failure-isolated: a 403 on plug-in steps
    // (or flows) must not sink the whole metadata document.
    let automation: AutomationDoc | undefined;
    const sectionNotes: string[] = [];
    if (input.includeAutomation) {
      automation = {};
      try {
        automation.pluginSteps = await summarizePluginSteps(client, input.table);
      } catch (err) {
        sectionNotes.push(`Plug-in step summary unavailable: ${errMessage(err)}`);
      }
      try {
        automation.cloudFlows = await summarizeCloudFlows(client, input.table);
      } catch (err) {
        sectionNotes.push(`Cloud flow summary unavailable: ${errMessage(err)}`);
      }
    }

    return {
      table,
      columnCount,
      columns,
      relationships,
      keys,
      ...(automation !== undefined ? { automation } : {}),
      markdown: buildMarkdown(
        table,
        columnCount,
        columns,
        relationships,
        keys,
        automation,
        sectionNotes,
      ),
      ...(columnsTruncated ? { columnsTruncated: true } : {}),
      ...(sectionNotes.length > 0 ? { sectionNotes } : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Documenting a table requires read access to entity metadata (and, " +
          "with includeAutomation, to SdkMessageProcessingStep and Process " +
          "rows). Ask an admin for the System Customizer role or equivalent " +
          "read privileges.",
        docsUrl: METADATA_DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const documentTableTool = defineTool({
  name: "document_table",
  description:
    "Generate structured documentation for a Dataverse table from its " +
    "EntityDefinitions metadata: columns (type, required level, custom flag), " +
    "relationships (1:N, N:1, N:N), alternate keys, an optional summary of the " +
    "plug-in steps and cloud flows that automate the table, and a " +
    "ready-to-share markdown document. Pass the table's logical name. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("document_table");
    try {
      return await documentTable(getDefaultClient(), input);
    } catch (err) {
      // documentTable traps its own errors; this covers client construction
      // failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
