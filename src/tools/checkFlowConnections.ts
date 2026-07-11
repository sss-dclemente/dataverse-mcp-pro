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
  "https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference";

const NO_REFS_HINT =
  "No connection references found — flows may use directly-bound connections (non-solution-aware).";

// connectionreferences is a small table; a single capped page is enough.
const MAX_CONNECTION_REFERENCES = 500;
// Keep or-chained `systemuserid eq guid` filters well below URL-length limits.
const OWNER_ID_CHUNK_SIZE = 25;
// Owner ids missing from systemusers belong to teams (or were deleted).
const UNRESOLVED_OWNER_LABEL = "team or unknown";

// category 5 = modern cloud flow, type 1 = definition, statecode 1 = activated.
const ACTIVE_CLOUD_FLOW_FILTER = "category eq 5 and type eq 1 and statecode eq 1";

const inputSchema = z.object({
  top: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .describe("Maximum number of active cloud flows to scan, 1–500 (default 200)."),
});

export type CheckFlowConnectionsInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value?: T[];
}

interface RawConnectionReference {
  connectionreferenceid?: string;
  connectionreferencedisplayname?: string | null;
  connectionreferencelogicalname?: string | null;
  connectorid?: string | null;
  connectionid?: string | null;
  statecode?: number;
  _ownerid_value?: string | null;
  modifiedon?: string | null;
}

interface RawFlow {
  workflowid?: string;
  name?: string | null;
  clientdata?: string | null;
  _ownerid_value?: string | null;
}

interface RawSystemUser {
  systemuserid?: string;
  fullname?: string | null;
  isdisabled?: boolean | null;
}

interface OwnerInfo {
  fullname: string | null;
  isdisabled: boolean;
}

interface FlowPointer {
  id: string;
  name: string;
}

interface Subject {
  type: "connectionReference" | "flow";
  id: string;
  name: string;
  logicalName?: string;
  owner: string;
}

type FindingKind =
  | "unbound-connection-reference"
  | "owner-disabled"
  | "owner-mismatch"
  | "unused-connection-reference";

interface Finding {
  severity: "high" | "medium" | "low";
  kind: FindingKind;
  subject: Subject;
  issue: string;
  recommendation: string;
  affectedFlows?: FlowPointer[];
}

const REF_SELECT = [
  "connectionreferenceid",
  "connectionreferencedisplayname",
  "connectionreferencelogicalname",
  "connectorid",
  "connectionid",
  "statecode",
  "_ownerid_value",
  "modifiedon",
];

function flowPointer(flow: RawFlow): FlowPointer {
  return { id: flow.workflowid ?? "", name: flow.name ?? "(unnamed flow)" };
}

function refSubject(ref: RawConnectionReference, owner: string): Subject {
  const logicalName = ref.connectionreferencelogicalname;
  return {
    type: "connectionReference",
    id: ref.connectionreferenceid ?? "",
    name:
      ref.connectionreferencedisplayname ??
      logicalName ??
      ref.connectionreferenceid ??
      "(unnamed connection reference)",
    ...(typeof logicalName === "string" && logicalName !== ""
      ? { logicalName }
      : {}),
    owner,
  };
}

async function resolveOwners(
  client: Pick<DataverseClient, "get">,
  ownerIds: string[],
): Promise<Map<string, OwnerInfo>> {
  const owners = new Map<string, OwnerInfo>();
  for (let i = 0; i < ownerIds.length; i += OWNER_ID_CHUNK_SIZE) {
    const chunk = ownerIds.slice(i, i + OWNER_ID_CHUNK_SIZE);
    const res = await client.get<ListResponse<RawSystemUser>>("systemusers", {
      select: ["systemuserid", "fullname", "isdisabled"],
      filter: `(${chunk.map((id) => `systemuserid eq ${id}`).join(" or ")})`,
    });
    for (const user of res.value ?? []) {
      if (typeof user.systemuserid === "string") {
        owners.set(user.systemuserid, {
          fullname: user.fullname ?? null,
          isdisabled: user.isdisabled === true,
        });
      }
    }
  }
  return owners;
}

function isEntityNotFound(err: DataverseHttpError): boolean {
  if (err.status === 404) return true;
  if (err.status !== 400) return false;
  const message = (err.dataverseMessage ?? err.message).toLowerCase();
  return (
    message.includes("not found") &&
    (message.includes("entity") ||
      message.includes("segment") ||
      message.includes("connectionreference"))
  );
}

export async function checkFlowConnections(
  client: Pick<DataverseClient, "get">,
  input: CheckFlowConnectionsInput,
): Promise<unknown> {
  try {
    const refsRes = await client.get<ListResponse<RawConnectionReference>>(
      "connectionreferences",
      { select: REF_SELECT, top: MAX_CONNECTION_REFERENCES },
    );
    const refs = refsRes.value ?? [];
    if (refs.length === 0) {
      return {
        connectionReferences: 0,
        flowsScanned: 0,
        findings: [],
        summary: { unbound: 0, ownerDisabled: 0, ownerMismatch: 0, unused: 0 },
        hint: NO_REFS_HINT,
      };
    }

    const flowsRes = await client.get<ListResponse<RawFlow>>("workflows", {
      select: ["workflowid", "name", "clientdata", "_ownerid_value"],
      filter: ACTIVE_CLOUD_FLOW_FILTER,
      top: input.top,
    });
    const flows = flowsRes.value ?? [];
    const flowsTruncated = flows.length === input.top;

    const ownerIds = new Set<string>();
    for (const ref of refs) {
      if (typeof ref._ownerid_value === "string" && ref._ownerid_value !== "") {
        ownerIds.add(ref._ownerid_value);
      }
    }
    for (const flow of flows) {
      if (typeof flow._ownerid_value === "string" && flow._ownerid_value !== "") {
        ownerIds.add(flow._ownerid_value);
      }
    }
    const owners =
      ownerIds.size > 0
        ? await resolveOwners(client, [...ownerIds])
        : new Map<string, OwnerInfo>();

    const ownerInfo = (id: string | null | undefined): OwnerInfo | undefined =>
      typeof id === "string" ? owners.get(id) : undefined;
    const ownerLabel = (id: string | null | undefined): string => {
      const info = ownerInfo(id);
      if (info === undefined) return UNRESOLVED_OWNER_LABEL;
      return info.fullname ?? "(unnamed user)";
    };

    const findings: Finding[] = [];
    const summary = { unbound: 0, ownerDisabled: 0, ownerMismatch: 0, unused: 0 };

    for (const ref of refs) {
      const logicalName = ref.connectionreferencelogicalname;
      // Usage heuristic: when a cloud flow uses a connection reference, the
      // reference's logical name appears verbatim inside the flow's clientdata
      // JSON string. A case-sensitive substring match per (flow, ref) pair is
      // cheap and reliable (logical names are unique prefixed identifiers), so
      // we avoid parsing every flow definition.
      const usedBy =
        typeof logicalName === "string" && logicalName !== ""
          ? flows.filter((flow) => (flow.clientdata ?? "").includes(logicalName))
          : [];
      const bound =
        typeof ref.connectionid === "string" && ref.connectionid.trim() !== "";
      const subject = refSubject(ref, ownerLabel(ref._ownerid_value));
      const refOwner = ownerInfo(ref._ownerid_value);

      if (!bound && usedBy.length > 0) {
        summary.unbound += 1;
        findings.push({
          severity: "high",
          kind: "unbound-connection-reference",
          subject,
          issue:
            `Connection reference "${subject.name}" has no connection bound; ` +
            `${usedBy.length} active flow(s) using it will fail at run time.`,
          recommendation:
            "Bind the connection reference to a valid connection (edit it under " +
            "Solutions, or supply the connection during solution import).",
          affectedFlows: usedBy.map(flowPointer),
        });
      }

      if (bound && usedBy.length === 0) {
        summary.unused += 1;
        findings.push({
          severity: "low",
          kind: "unused-connection-reference",
          subject,
          issue:
            `Bound connection reference "${subject.name}" is not used by any of the ` +
            `${flows.length} scanned active cloud flows.` +
            (flowsTruncated
              ? ` Scan capped at ${input.top} flows — usage beyond the cap is not visible.`
              : ""),
          recommendation:
            "Confirm it is genuinely unused, then remove it to keep the environment tidy.",
        });
      }

      if (refOwner !== undefined && refOwner.isdisabled) {
        summary.ownerDisabled += 1;
        findings.push({
          severity: "medium",
          kind: "owner-disabled",
          subject,
          issue:
            `Connection reference "${subject.name}" is owned by disabled user ` +
            `"${subject.owner}"; connections of departed users stop refreshing.`,
          recommendation:
            "Reassign the connection reference (and its underlying connection) to an " +
            "active user — ideally a service account.",
        });
      }

      if (refOwner !== undefined) {
        // Skip flows whose owner did not resolve (teams/unknown): no basis to compare.
        const mismatched = usedBy.filter(
          (flow) =>
            ownerInfo(flow._ownerid_value) !== undefined &&
            flow._ownerid_value !== ref._ownerid_value,
        );
        if (mismatched.length > 0) {
          summary.ownerMismatch += 1;
          findings.push({
            severity: "medium",
            kind: "owner-mismatch",
            subject,
            issue:
              `Connection reference "${subject.name}" (owner "${subject.owner}") is ` +
              `used by ${mismatched.length} flow(s) owned by someone else; owner ` +
              "changes or departures can silently break those flows.",
            recommendation:
              "Prefer service-account-owned shared connection references over " +
              "personally-owned ones.",
            affectedFlows: mismatched.map(flowPointer),
          });
        }
      }
    }

    for (const flow of flows) {
      const flowOwner = ownerInfo(flow._ownerid_value);
      if (flowOwner !== undefined && flowOwner.isdisabled) {
        summary.ownerDisabled += 1;
        findings.push({
          severity: "medium",
          kind: "owner-disabled",
          subject: {
            type: "flow",
            id: flow.workflowid ?? "",
            name: flow.name ?? "(unnamed flow)",
            owner: ownerLabel(flow._ownerid_value),
          },
          issue:
            `Active cloud flow "${flow.name ?? "(unnamed flow)"}" is owned by ` +
            `disabled user "${ownerLabel(flow._ownerid_value)}"; it can stop running ` +
            "when the account's connections expire.",
          recommendation:
            "Reassign the flow to an active user or service account.",
        });
      }
    }

    const severityOrder: Record<Finding["severity"], number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return {
      connectionReferences: refs.length,
      flowsScanned: flows.length,
      ...(flowsTruncated ? { flowsTruncated: true } : {}),
      findings,
      summary,
    };
  } catch (err) {
    if (err instanceof DataverseHttpError) {
      const message = err.dataverseMessage ?? err.message;
      if (isEntityNotFound(err)) {
        return errorEnvelope(message, {
          hint:
            "The connectionreference table exists only in environments that support " +
            "solution-aware cloud flows and connection references. In environments " +
            "without it, flows bind connections directly and there is nothing to audit.",
          docsUrl: DOCS_URL,
        });
      }
      if (err.status === 403) {
        return errorEnvelope(message, {
          hint:
            "Auditing connection references requires read privilege on the Connection " +
            "Reference (connectionreference), Process (workflow) and User (systemuser) " +
            "tables. Ask an admin to grant those read privileges to the connecting " +
            "principal's security role.",
          docsUrl: DOCS_URL,
        });
      }
    }
    return toErrorEnvelope(err);
  }
}

export const checkFlowConnectionsTool = defineTool({
  name: "check_flow_connections",
  description:
    "Audits Power Automate connection-reference health in Dataverse: unbound " +
    "connection references used by active cloud flows (run-time failures), " +
    "references or flows owned by disabled users, owner mismatches between a " +
    "reference and the flows using it, and unused bound references. Pro tier.",
  inputSchema,
  handler: async (input) => {
    if (!isEnterpriseLicensed()) return enterpriseUpgradeMessage("check_flow_connections");
    try {
      return await checkFlowConnections(getDefaultClient(), input);
    } catch (err) {
      // checkFlowConnections traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
