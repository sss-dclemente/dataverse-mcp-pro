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
  "https://learn.microsoft.com/power-automate/replace-workflows-with-flows";

const MODERN_HINT =
  "No legacy automation found — this environment is already modern.";

const PRIVILEGE_HINT =
  "Reading processes requires read privilege on the Process (workflow) table. " +
  "Ask an admin to grant the connecting principal a security role with that " +
  "privilege (e.g. System Customizer) or equivalent.";

// Per-category row cap. Categories at the cap get a truncation note because
// totals may undercount.
const CATEGORY_ROW_CAP = 500;

// workflow.category values (process definitions only: type eq 1).
const CATEGORY_CLASSIC_WORKFLOW = 0;
const CATEGORY_DIALOG = 1;
const CATEGORY_BUSINESS_RULE = 2;
const CATEGORY_BPF = 4;

const CLASSIC_DRAFTS_THRESHOLD = 10;
const BUSINESS_RULES_THRESHOLD = 25;

const inputSchema = z.object({
  top: z
    .number()
    .int()
    .min(5)
    .max(100)
    .default(25)
    .describe("Maximum active items listed per category, 5–100 (default 25)."),
});

export type ModernizationReportInput = z.infer<typeof inputSchema>;

const CLASSIC_SELECT = [
  "workflowid",
  "name",
  "statecode",
  "mode",
  "primaryentity",
  "modifiedon",
];
const BASIC_SELECT = [
  "workflowid",
  "name",
  "statecode",
  "primaryentity",
  "modifiedon",
];
// BPFs are count-only (informational): keep the payload minimal.
const BPF_SELECT = ["workflowid", "statecode"];

interface RawProcess {
  workflowid?: string;
  name?: string | null;
  statecode?: number;
  mode?: number;
  primaryentity?: string | null;
  modifiedon?: string | null;
}

interface CategoryRows {
  rows: RawProcess[];
  truncated: boolean;
}

interface ProcessItem {
  id: string;
  name: string;
  primaryEntity: string | null;
  mode?: string;
  lastModified: string | null;
}

interface Finding {
  severity: "high" | "medium" | "low";
  flag: string;
  issue: string;
  recommendation: string;
  evidence: Record<string, number>;
}

// mode: 0 = background (async), 1 = real-time (sync).
function modeLabel(mode: number | undefined): string {
  return mode === 1 ? "real-time (sync)" : "background (async)";
}

function isActive(row: RawProcess): boolean {
  // workflow.statecode: 0 = Draft, 1 = Activated.
  return row.statecode === 1;
}

async function fetchCategory(
  client: Pick<DataverseClient, "get">,
  category: number,
  select: string[],
): Promise<CategoryRows> {
  const res = await client.get<{ value: RawProcess[] }>("workflows", {
    select,
    filter: `category eq ${category} and type eq 1`,
    top: CATEGORY_ROW_CAP,
  });
  const rows = res.value ?? [];
  return { rows, truncated: rows.length >= CATEGORY_ROW_CAP };
}

function errorMessage(err: unknown): string {
  if (err instanceof DataverseHttpError) {
    return err.dataverseMessage ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Active rows only, newest modifiedon first, capped at `top`. */
function toItems(
  rows: RawProcess[],
  top: number,
  withMode: boolean,
): ProcessItem[] {
  return rows
    .filter(isActive)
    .sort((a, b) => (b.modifiedon ?? "").localeCompare(a.modifiedon ?? ""))
    .slice(0, top)
    .map((row) => ({
      id: row.workflowid ?? "unknown",
      name: row.name ?? "(unnamed)",
      primaryEntity: row.primaryentity ?? null,
      ...(withMode ? { mode: modeLabel(row.mode) } : {}),
      lastModified: row.modifiedon ?? null,
    }));
}

export async function modernizationReport(
  client: Pick<DataverseClient, "get">,
  input: ModernizationReportInput,
): Promise<unknown> {
  // First query: failures produce a top-level envelope (there is nothing to
  // report yet). Later categories degrade to sectionNotes instead.
  let classic: CategoryRows;
  try {
    classic = await fetchCategory(client, CATEGORY_CLASSIC_WORKFLOW, CLASSIC_SELECT);
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint: PRIVILEGE_HINT,
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }

  const sectionNotes: string[] = [];
  const guarded = async (
    label: string,
    category: number,
    select: string[],
  ): Promise<CategoryRows> => {
    try {
      return await fetchCategory(client, category, select);
    } catch (err) {
      sectionNotes.push(`${label}: query failed — ${errorMessage(err)}`);
      return { rows: [], truncated: false };
    }
  };

  const dialogs = await guarded("dialogs", CATEGORY_DIALOG, BASIC_SELECT);
  const businessRules = await guarded(
    "businessRules",
    CATEGORY_BUSINESS_RULE,
    BASIC_SELECT,
  );
  const bpfs = await guarded("businessProcessFlows", CATEGORY_BPF, BPF_SELECT);

  const truncationNotes: string[] = [];
  const noteTruncation = (label: string, category: CategoryRows): void => {
    if (category.truncated) {
      truncationNotes.push(
        `${label}: only the first ${CATEGORY_ROW_CAP} rows were scanned; totals may undercount.`,
      );
    }
  };
  noteTruncation("classicWorkflows", classic);
  noteTruncation("dialogs", dialogs);
  noteTruncation("businessRules", businessRules);
  noteTruncation("businessProcessFlows", bpfs);

  const activeClassic = classic.rows.filter(isActive);
  const syncActive = activeClassic.filter((r) => r.mode === 1).length;
  const asyncActive = activeClassic.length - syncActive;
  const classicDrafts = classic.rows.length - activeClassic.length;

  const activeDialogs = dialogs.rows.filter(isActive).length;
  const activeBusinessRules = businessRules.rows.filter(isActive).length;
  const activeBpfs = bpfs.rows.filter(isActive).length;

  const findings: Finding[] = [];
  if (activeDialogs > 0) {
    findings.push({
      severity: "high",
      flag: "active-dialogs",
      issue:
        `${activeDialogs} active dialog(s) found. Dialogs were deprecated and ` +
        "removed from the product — they no longer run reliably.",
      recommendation:
        "Migrate dialog functionality to canvas apps, Power Pages, or custom pages.",
      evidence: { activeDialogs },
    });
  }
  if (activeClassic.length > 0) {
    findings.push({
      severity: "medium",
      flag: "active-classic-workflows",
      issue:
        `${activeClassic.length} active classic workflow(s) still run in this ` +
        `environment (${syncActive} real-time/sync, ${asyncActive} background/async).`,
      recommendation:
        "Migrate background (async) workflows to Power Automate cloud flows. " +
        "Real-time (sync) workflows have no direct cloud-flow equivalent — " +
        "convert them to plug-ins or keep them as-is.",
      evidence: {
        activeClassicWorkflows: activeClassic.length,
        syncActive,
        asyncActive,
      },
    });
  }
  if (classicDrafts > CLASSIC_DRAFTS_THRESHOLD) {
    findings.push({
      severity: "low",
      flag: "classic-workflow-drafts",
      issue: `${classicDrafts} draft (inactive) classic workflows are cluttering the environment.`,
      recommendation:
        "Delete or archive draft classic workflows that are no longer needed.",
      evidence: { draftClassicWorkflows: classicDrafts },
    });
  }
  if (activeBusinessRules > BUSINESS_RULES_THRESHOLD) {
    findings.push({
      severity: "low",
      flag: "business-rules-inventory",
      issue: `${activeBusinessRules} active business rules indicate a heavy client-logic footprint.`,
      recommendation:
        "Consider consolidating overlapping business rules per table, or moving " +
        "complex logic into a single maintainable layer.",
      evidence: { activeBusinessRules },
    });
  }
  // Findings are pushed high → low already; keep the sort as a guarantee.
  const severityOrder: Record<Finding["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const allZero =
    sectionNotes.length === 0 &&
    classic.rows.length === 0 &&
    dialogs.rows.length === 0 &&
    businessRules.rows.length === 0 &&
    bpfs.rows.length === 0;

  return {
    categories: {
      classicWorkflows: {
        total: classic.rows.length,
        active: activeClassic.length,
        syncActive,
        asyncActive,
        items: toItems(classic.rows, input.top, true),
      },
      dialogs: {
        total: dialogs.rows.length,
        active: activeDialogs,
        items: toItems(dialogs.rows, input.top, false),
      },
      businessRules: {
        total: businessRules.rows.length,
        active: activeBusinessRules,
        items: toItems(businessRules.rows, input.top, false),
      },
      businessProcessFlows: {
        total: bpfs.rows.length,
        active: activeBpfs,
      },
    },
    findings,
    ...(sectionNotes.length > 0 ? { sectionNotes } : {}),
    ...(truncationNotes.length > 0 ? { truncationNotes } : {}),
    ...(allZero ? { hint: MODERN_HINT } : {}),
  };
}

export const modernizationReportTool = defineTool({
  name: "modernization_report",
  description:
    "Inventories deprecated/legacy automation still active in the org: classic " +
    "workflows (background and real-time), dialogs (removed technology), business " +
    "rules and business process flows. Returns per-category counts, the most " +
    "recently modified active items, and prioritized migration findings. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isEnterpriseLicensed()) return enterpriseUpgradeMessage("modernization_report");
    try {
      return await modernizationReport(getDefaultClient(), input);
    } catch (err) {
      // modernizationReport traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
