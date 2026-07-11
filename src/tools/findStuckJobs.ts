import { z } from "zod";
import { defineTool } from "./types.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";

// asyncoperation statuscode values for non-terminal jobs that may be stuck.
const STATUS_WAITING_FOR_RESOURCES = 0;
const STATUS_WAITING = 10;
const STATUS_IN_PROGRESS = 20;

const MAX_ROWS = 500;
const EXCERPT_MAX_CHARS = 200;
const MS_PER_HOUR = 3_600_000;

const STATUS_LABELS: Record<number, string> = {
  [STATUS_WAITING_FOR_RESOURCES]: "waiting-for-resources",
  [STATUS_WAITING]: "waiting",
  [STATUS_IN_PROGRESS]: "in-progress",
};

// Documented asyncoperation operationtype values (same map as
// get_failed_async_jobs); anything else is surfaced as the raw numeric value.
const OPERATION_TYPE_LABELS: Record<number, string> = {
  1: "System Event",
  2: "Bulk Email",
  3: "Import File Parse",
  4: "Transform Parse Data",
  5: "Import",
  6: "Activity Propagation",
  7: "Duplicate Detection Rule Publish",
  8: "Bulk Duplicate Detection",
  9: "SQM Data Collection",
  10: "Workflow",
  11: "Quick Campaign",
  12: "Matchcode Update",
  13: "Bulk Delete",
};

const SATURATION_HINT =
  "waiting-for-resources jobs older than a day usually mean the async service is saturated or maintenance jobs are blocked";

const inputSchema = z.object({
  olderThanHours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .default(6)
    .describe(
      "Flag async jobs created more than this many hours ago that are still waiting or in progress (1-720, default 6).",
    ),
});

export type FindStuckJobsInput = z.infer<typeof inputSchema>;

interface AsyncOperationRow {
  asyncoperationid: string;
  name?: string | null;
  operationtype?: number | null;
  statuscode?: number | null;
  statecode?: number | null;
  createdon?: string | null;
  startedon?: string | null;
  postponeuntil?: string | null;
  message?: string | null;
}

interface StuckGroup {
  name: string | null;
  operationType: string;
  statusBreakdown: {
    waitingForResources: number;
    waiting: number;
    inProgress: number;
  };
  count: number;
  oldestCreatedOn: string | null;
  ageHours: number | null;
}

function operationTypeLabel(operationtype: number | null | undefined): string {
  if (operationtype === null || operationtype === undefined) return "unknown";
  return OPERATION_TYPE_LABELS[operationtype] ?? String(operationtype);
}

function statusLabel(statuscode: number | null | undefined): string {
  if (statuscode === null || statuscode === undefined) return "unknown";
  return STATUS_LABELS[statuscode] ?? String(statuscode);
}

function ageHoursFrom(
  createdon: string | null | undefined,
  nowMs: number,
): number | null {
  if (createdon === null || createdon === undefined) return null;
  const parsed = Date.parse(createdon);
  if (Number.isNaN(parsed)) return null;
  return Math.round((nowMs - parsed) / MS_PER_HOUR);
}

export async function queryStuckJobs(
  client: Pick<DataverseClient, "get">,
  input: FindStuckJobsInput,
): Promise<unknown> {
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - input.olderThanHours * MS_PER_HOUR).toISOString();
  const windowNote =
    `jobs created more than ${input.olderThanHours} hours ago still waiting/in progress`;
  try {
    const response = await client.get<{ value: AsyncOperationRow[] }>(
      "asyncoperations",
      {
        select: [
          "asyncoperationid",
          "name",
          "operationtype",
          "statuscode",
          "statecode",
          "createdon",
          "startedon",
          "postponeuntil",
          "message",
        ],
        filter:
          `(statuscode eq ${STATUS_WAITING_FOR_RESOURCES}` +
          ` or statuscode eq ${STATUS_WAITING}` +
          ` or statuscode eq ${STATUS_IN_PROGRESS})` +
          ` and createdon le ${cutoff}`,
        orderby: "createdon asc",
        top: MAX_ROWS,
      },
    );
    const rows = response.value;

    // A postponeuntil in the future means the job is legitimately parked
    // (e.g. a workflow timeout/delay) — scheduled, not stuck.
    const isScheduled = (row: AsyncOperationRow): boolean =>
      row.postponeuntil !== null &&
      row.postponeuntil !== undefined &&
      Date.parse(row.postponeuntil) > nowMs;
    const stuck = rows.filter((row) => !isScheduled(row));
    const scheduledCount = rows.length - stuck.length;

    if (stuck.length === 0) {
      return {
        stuckCount: 0,
        scheduledCount,
        windowNote,
        groups: [],
        oldest: [],
        hint: `No stuck async jobs older than ${input.olderThanHours} hours — the async queue is healthy.`,
      };
    }

    const groupsByKey = new Map<string, StuckGroup>();
    for (const row of stuck) {
      const key = `${row.name ?? null}|${row.operationtype ?? null}`;
      let group = groupsByKey.get(key);
      if (group === undefined) {
        // Rows arrive ordered by createdon asc, so the first row seen for
        // each group is that group's oldest occurrence.
        group = {
          name: row.name ?? null,
          operationType: operationTypeLabel(row.operationtype),
          statusBreakdown: { waitingForResources: 0, waiting: 0, inProgress: 0 },
          count: 0,
          oldestCreatedOn: row.createdon ?? null,
          ageHours: ageHoursFrom(row.createdon, nowMs),
        };
        groupsByKey.set(key, group);
      }
      group.count += 1;
      if (row.statuscode === STATUS_WAITING_FOR_RESOURCES) {
        group.statusBreakdown.waitingForResources += 1;
      } else if (row.statuscode === STATUS_WAITING) {
        group.statusBreakdown.waiting += 1;
      } else if (row.statuscode === STATUS_IN_PROGRESS) {
        group.statusBreakdown.inProgress += 1;
      }
    }
    const groups = [...groupsByKey.values()].sort((a, b) =>
      (a.oldestCreatedOn ?? "").localeCompare(b.oldestCreatedOn ?? ""),
    );

    const oldest = stuck.slice(0, 10).map((row) => {
      const excerpt =
        row.message === null || row.message === undefined
          ? undefined
          : row.message.slice(0, EXCERPT_MAX_CHARS);
      return {
        id: row.asyncoperationid,
        name: row.name ?? null,
        operationType: operationTypeLabel(row.operationtype),
        status: statusLabel(row.statuscode),
        createdOn: row.createdon ?? null,
        ...(row.startedon !== null && row.startedon !== undefined
          ? { startedOn: row.startedon }
          : {}),
        ageHours: ageHoursFrom(row.createdon, nowMs),
        ...(excerpt !== undefined ? { messageExcerpt: excerpt } : {}),
      };
    });

    const hints = [SATURATION_HINT];
    if (scheduledCount > 0) {
      hints.push(
        `${scheduledCount} postponed job(s) with postponeuntil in the future were excluded as scheduled — they are waiting by design, not stuck.`,
      );
    }

    return {
      stuckCount: stuck.length,
      scheduledCount,
      windowNote,
      groups,
      oldest,
      ...(rows.length === MAX_ROWS ? { truncated: true } : {}),
      hints,
    };
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading system jobs requires read privilege on the AsyncOperation (System Job) table (prvReadAsyncOperation). Grant it to the connecting identity's security role.",
        docsUrl:
          "https://learn.microsoft.com/power-apps/developer/data-platform/asynchronous-service",
      });
    }
    return toErrorEnvelope(err);
  }
}

export const findStuckJobs = defineTool({
  name: "find_stuck_jobs",
  description:
    "Surfaces Dataverse async jobs (system jobs) sitting in waiting or in-progress states beyond an age threshold: counts, groups by job name + operation type with status breakdowns, and the oldest individual stuck jobs. Postponed jobs (postponeuntil in the future) are reported separately as scheduled. Free tier.",
  inputSchema,
  handler: async (input) => queryStuckJobs(getDefaultClient(), input),
});
