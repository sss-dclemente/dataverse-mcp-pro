import { z } from "zod";
import { defineTool } from "./types.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";

// asyncoperation statuscode values for terminal, non-successful jobs.
const STATUS_FAILED = 31;
const STATUS_CANCELED = 32;

const MAX_ROWS = 500;
const EXCERPT_MAX_CHARS = 300;

// Operation types whose jobs can be resumed/retried from the system jobs grid
// (10 = Workflow). Data-driven so more types can be added as they are verified.
const RETRYABLE_OPERATION_TYPES = new Set([10]);

// Documented asyncoperation operationtype values; anything else is surfaced
// as the raw numeric value.
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

const inputSchema = z.object({
  hoursBack: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe(
      "How many hours back to look for failed or canceled async jobs (1-168, default 24).",
    ),
});

export type FailedAsyncJobsInput = z.infer<typeof inputSchema>;

interface AsyncOperationRow {
  asyncoperationid: string;
  name?: string | null;
  operationtype?: number | null;
  statuscode?: number | null;
  errorcode?: number | null;
  message?: string | null;
  friendlymessage?: string | null;
  createdon?: string | null;
  completedon?: string | null;
}

interface FailureGroup {
  name: string | null;
  errorCode: number | null;
  count: number;
  retryable: boolean;
  operationType: string;
  latestMessageExcerpt?: string;
  latestOccurrence: string | null;
}

function operationTypeLabel(operationtype: number | null | undefined): string {
  if (operationtype === null || operationtype === undefined) return "unknown";
  return OPERATION_TYPE_LABELS[operationtype] ?? String(operationtype);
}

function isRetryable(operationtype: number | null | undefined): boolean {
  return operationtype !== null && operationtype !== undefined
    ? RETRYABLE_OPERATION_TYPES.has(operationtype)
    : false;
}

function messageExcerpt(row: AsyncOperationRow): string | undefined {
  const message = row.message ?? row.friendlymessage;
  return message === null || message === undefined
    ? undefined
    : message.slice(0, EXCERPT_MAX_CHARS);
}

export async function queryFailedAsyncJobs(
  client: Pick<DataverseClient, "get">,
  input: FailedAsyncJobsInput,
): Promise<unknown> {
  const cutoff = new Date(Date.now() - input.hoursBack * 3_600_000).toISOString();
  try {
    const response = await client.get<{ value: AsyncOperationRow[] }>(
      "asyncoperations",
      {
        select: [
          "asyncoperationid",
          "name",
          "operationtype",
          "statuscode",
          "errorcode",
          "message",
          "friendlymessage",
          "createdon",
          "completedon",
        ],
        filter:
          `(statuscode eq ${STATUS_FAILED} or statuscode eq ${STATUS_CANCELED})` +
          ` and createdon ge ${cutoff}`,
        orderby: "createdon desc",
        top: MAX_ROWS,
      },
    );
    const rows = response.value;

    if (rows.length === 0) {
      return {
        totalFailures: 0,
        failed: 0,
        canceled: 0,
        windowHours: input.hoursBack,
        groups: [],
        topFailures: [],
        hint: `No failed or canceled async jobs in the last ${input.hoursBack} hours.`,
      };
    }

    // Rows arrive ordered by createdon desc, so the first row seen for each
    // group is that group's most recent occurrence.
    const groupsByKey = new Map<string, FailureGroup>();
    for (const row of rows) {
      const key = `${row.name ?? null}|${row.errorcode ?? null}`;
      const existing = groupsByKey.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        continue;
      }
      const excerpt = messageExcerpt(row);
      groupsByKey.set(key, {
        name: row.name ?? null,
        errorCode: row.errorcode ?? null,
        count: 1,
        retryable: isRetryable(row.operationtype),
        operationType: operationTypeLabel(row.operationtype),
        ...(excerpt !== undefined ? { latestMessageExcerpt: excerpt } : {}),
        latestOccurrence: row.createdon ?? null,
      });
    }
    const groups = [...groupsByKey.values()].sort((a, b) => b.count - a.count);

    const topFailures = rows.slice(0, 10).map((row) => {
      const excerpt = messageExcerpt(row);
      return {
        id: row.asyncoperationid,
        name: row.name ?? null,
        operationType: operationTypeLabel(row.operationtype),
        status: row.statuscode === STATUS_CANCELED ? "canceled" : "failed",
        errorCode: row.errorcode ?? null,
        ...(excerpt !== undefined ? { messageExcerpt: excerpt } : {}),
        retryable: isRetryable(row.operationtype),
        createdon: row.createdon ?? null,
        completedon: row.completedon ?? null,
      };
    });

    return {
      totalFailures: rows.length,
      failed: rows.filter((row) => row.statuscode === STATUS_FAILED).length,
      canceled: rows.filter((row) => row.statuscode === STATUS_CANCELED).length,
      windowHours: input.hoursBack,
      groups,
      topFailures,
      ...(rows.length === MAX_ROWS ? { truncated: true } : {}),
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

export const getFailedAsyncJobs = defineTool({
  name: "get_failed_async_jobs",
  description:
    "Summarizes failed and canceled Dataverse async jobs (system jobs) over a recent window: counts, groups by job name + error code with retryability, and the most recent individual failures. Free tier.",
  inputSchema,
  handler: async (input) => queryFailedAsyncJobs(getDefaultClient(), input),
});
