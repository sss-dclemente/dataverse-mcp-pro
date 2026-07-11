import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";
import { isProLicensed, proUpgradeMessage } from "../licensing.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-automate/overview-solution-flows";

const EMPTY_RESULT_HINT =
  "No solution cloud flows found (category 5). Only solution-aware cloud " +
  "flows are stored in the Dataverse workflows table; non-solution flows are " +
  "not visible here.";

// Dataverse $top ceiling for one page; beyond this the report is flagged truncated.
const MAX_FLOWS = 1000;
// Keep OData $filter clauses well below URL-length limits when expanding
// owner ids into `systemuserid eq guid or ...` chains.
const OWNER_ID_CHUNK_SIZE = 25;
const OWNER_TABLE_MAX_ROWS = 25;
const UNKNOWN_OWNER_LABEL = "team or unknown";

const inputSchema = z.object({
  staleDraftDays: z
    .number()
    .int()
    .min(7)
    .max(365)
    .default(90)
    .describe(
      "Draft flows not modified for this many days are flagged as stale, 7–365 (default 90).",
    ),
  ownerConcentrationThreshold: z
    .number()
    .int()
    .min(5)
    .max(200)
    .default(20)
    .describe(
      "Flag owners who own at least this many flows as a bus-factor risk, 5–200 (default 20).",
    ),
});

export type FlowGovernanceInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

interface RawWorkflow {
  workflowid?: string;
  name?: string | null;
  statecode?: number | null;
  statuscode?: number | null;
  createdon?: string | null;
  modifiedon?: string | null;
  _ownerid_value?: string | null;
  ismanaged?: boolean | null;
}

interface RawSystemUser {
  systemuserid?: string;
  fullname?: string | null;
  isdisabled?: boolean | null;
}

interface OwnerInfo {
  fullname: string;
  isdisabled: boolean | undefined;
}

interface FlowRef {
  id: string;
  name: string;
}

interface Finding {
  severity: "high" | "medium" | "low";
  flow?: FlowRef;
  owner?: string;
  issue: string;
  recommendation: string;
}

interface OwnerRow {
  owner: string;
  isDisabled?: boolean;
  flows: number;
  activated: number;
}

// workflow statecode: 0 = Draft, 1 = Activated, 2 = Suspended. The suspended
// encoding varies across Dataverse versions (some surface it only through
// statuscode), so statuscode is applied with the same 0/1/2 mapping as a
// fallback signal when statecode is outside the known range. Both raw codes
// are exposed in the findings that depend on them.
function mapStateCode(code: number): "draft" | "activated" | "suspended" | undefined {
  switch (code) {
    case 0:
      return "draft";
    case 1:
      return "activated";
    case 2:
      return "suspended";
    default:
      return undefined;
  }
}

function flowState(raw: RawWorkflow): string {
  if (typeof raw.statecode === "number") {
    const mapped = mapStateCode(raw.statecode);
    if (mapped !== undefined) return mapped;
  }
  if (typeof raw.statuscode === "number") {
    const mapped = mapStateCode(raw.statuscode);
    if (mapped !== undefined) return mapped;
  }
  return String(raw.statecode);
}

async function fetchOwners(
  client: Pick<DataverseClient, "get">,
  ownerIds: string[],
): Promise<Map<string, OwnerInfo>> {
  const owners = new Map<string, OwnerInfo>();
  for (let i = 0; i < ownerIds.length; i += OWNER_ID_CHUNK_SIZE) {
    const chunk = ownerIds.slice(i, i + OWNER_ID_CHUNK_SIZE);
    // systemuserid is a uniqueidentifier: GUID literals are unquoted in OData.
    const filter = chunk.map((id) => `systemuserid eq ${id}`).join(" or ");
    const res = await client.get<ListResponse<RawSystemUser>>("systemusers", {
      select: ["systemuserid", "fullname", "isdisabled"],
      filter,
    });
    for (const user of res.value ?? []) {
      if (typeof user.systemuserid !== "string") continue;
      owners.set(user.systemuserid, {
        fullname: user.fullname ?? "(unnamed user)",
        isdisabled: typeof user.isdisabled === "boolean" ? user.isdisabled : undefined,
      });
    }
  }
  return owners;
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export async function flowGovernanceReport(
  client: Pick<DataverseClient, "get">,
  input: FlowGovernanceInput,
): Promise<unknown> {
  try {
    const response = await client.get<ListResponse<RawWorkflow>>("workflows", {
      select: [
        "workflowid",
        "name",
        "statecode",
        "statuscode",
        "createdon",
        "modifiedon",
        "_ownerid_value",
        "ismanaged",
      ],
      // category 5 = modern cloud flow, type 1 = definition (not activation/template).
      filter: "category eq 5 and type eq 1",
      top: MAX_FLOWS,
    });
    const flows = response.value ?? [];
    if (flows.length === 0) {
      return {
        totalFlows: 0,
        activated: 0,
        draft: 0,
        suspended: 0,
        managed: 0,
        findings: [],
        ownerTable: [],
        hint: EMPTY_RESULT_HINT,
      };
    }
    const truncated = flows.length >= MAX_FLOWS;

    const ownerIds = [
      ...new Set(
        flows
          .map((f) => f._ownerid_value)
          .filter((id): id is string => typeof id === "string" && id !== ""),
      ),
    ];
    // _ownerid_value can point at a team; ids missing from systemusers are
    // reported as "team or unknown" with no disabled signal.
    const owners = ownerIds.length > 0 ? await fetchOwners(client, ownerIds) : new Map<string, OwnerInfo>();

    let activated = 0;
    let draft = 0;
    let suspended = 0;
    let managed = 0;
    const findings: Finding[] = [];
    const ownerRows = new Map<string, OwnerRow>();
    const staleCutoffMs = Date.now() - input.staleDraftDays * 86_400_000;

    for (const raw of flows) {
      const state = flowState(raw);
      if (state === "activated") activated += 1;
      else if (state === "draft") draft += 1;
      else if (state === "suspended") suspended += 1;
      if (raw.ismanaged === true) managed += 1;

      const flowRef: FlowRef = {
        id: raw.workflowid ?? "(unknown)",
        name: raw.name ?? "(unnamed flow)",
      };
      const ownerId = raw._ownerid_value ?? "";
      const ownerInfo = ownerId !== "" ? owners.get(ownerId) : undefined;
      const ownerName = ownerInfo?.fullname ?? UNKNOWN_OWNER_LABEL;

      const rowKey = ownerId !== "" ? ownerId : "(no owner)";
      let row = ownerRows.get(rowKey);
      if (row === undefined) {
        row = {
          owner: ownerName,
          ...(ownerInfo?.isdisabled !== undefined
            ? { isDisabled: ownerInfo.isdisabled }
            : {}),
          flows: 0,
          activated: 0,
        };
        ownerRows.set(rowKey, row);
      }
      row.flows += 1;
      if (state === "activated") row.activated += 1;

      if (state === "activated" && ownerInfo?.isdisabled === true) {
        findings.push({
          severity: "high",
          flow: flowRef,
          owner: ownerName,
          issue:
            `Activated flow is owned by disabled user "${ownerName}"; ` +
            "its connections and runs will start failing.",
          recommendation:
            "Reassign the flow (and its connection references) to an active user or service account.",
        });
      }

      if (state === "suspended") {
        findings.push({
          severity: "medium",
          flow: flowRef,
          owner: ownerName,
          issue:
            `Flow is suspended (statecode ${raw.statecode ?? "unknown"}, ` +
            `statuscode ${raw.statuscode ?? "unknown"}); suspensions usually ` +
            "come from billing issues, DLP policy violations or repeated failures.",
          recommendation:
            "Investigate the suspension reason in Power Automate and resume the flow once resolved.",
        });
      }

      if (state === "draft" && typeof raw.modifiedon === "string") {
        const modifiedMs = Date.parse(raw.modifiedon);
        if (Number.isFinite(modifiedMs) && modifiedMs < staleCutoffMs) {
          findings.push({
            severity: "low",
            flow: flowRef,
            owner: ownerName,
            issue:
              `Draft flow last modified ${raw.modifiedon} — untouched for over ` +
              `${input.staleDraftDays} days and never activated; likely abandoned.`,
            recommendation:
              "Delete the stale draft, or finish and activate it; abandoned drafts clutter solutions and audits.",
          });
        }
      }
    }

    for (const row of ownerRows.values()) {
      if (row.flows >= input.ownerConcentrationThreshold) {
        findings.push({
          severity: "low",
          owner: row.owner,
          issue:
            `Owner "${row.owner}" owns ${row.flows} of ${flows.length} solution cloud ` +
            `flows (threshold ${input.ownerConcentrationThreshold}); a single departure ` +
            "or disabled account puts all of them at risk.",
          recommendation:
            "Move business-critical flows to a service account and add co-owners to reduce bus-factor risk.",
        });
      }
    }

    findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const ownerTable = [...ownerRows.values()]
      .sort((a, b) => b.flows - a.flows)
      .slice(0, OWNER_TABLE_MAX_ROWS);

    return {
      totalFlows: flows.length,
      activated,
      draft,
      suspended,
      managed,
      findings,
      ownerTable,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Building the governance report requires read privilege on the Process " +
          "(workflow) table, plus SystemUser for owner lookups. Grant the connecting " +
          "principal a security role with those read privileges (e.g. System " +
          "Administrator or System Customizer).",
        docsUrl: DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const flowGovernanceReportTool = defineTool({
  name: "flow_governance_report",
  description:
    "Ownership and state inventory of solution-aware Power Automate cloud flows in " +
    "Dataverse: activated/draft/suspended counts, an owner table, and governance " +
    "findings — activated flows owned by disabled users, suspended flows, stale " +
    "drafts, and owner concentration (bus-factor) risks. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isProLicensed()) return proUpgradeMessage("flow_governance_report");
    try {
      return await flowGovernanceReport(getDefaultClient(), input);
    } catch (err) {
      // flowGovernanceReport traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
