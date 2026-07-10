import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFailedAsyncJobs,
  queryFailedAsyncJobs,
} from "../src/tools/getFailedAsyncJobs.js";
import { DataverseHttpError, type QueryOptions } from "../src/dataverse/client.js";

interface FixtureRow {
  asyncoperationid: string;
  name: string | null;
  operationtype: number | null;
  statuscode: number | null;
  errorcode: number | null;
  message: string | null;
  friendlymessage: string | null;
  createdon: string | null;
  completedon: string | null;
}

function loadFixture(name: string): { value: FixtureRow[] } {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as { value: FixtureRow[] };
}

interface ToolResult {
  totalFailures: number;
  failed: number;
  canceled: number;
  windowHours: number;
  groups: Array<{
    name: string | null;
    errorCode: number | null;
    count: number;
    retryable: boolean;
    operationType: string;
    latestMessageExcerpt?: string;
    latestOccurrence: string | null;
  }>;
  topFailures: Array<{
    id: string;
    name: string | null;
    operationType: string;
    status: string;
    errorCode: number | null;
    messageExcerpt?: string;
    retryable: boolean;
    createdon: string | null;
    completedon: string | null;
  }>;
  truncated?: boolean;
  hint?: string;
}

function fakeClient(response: unknown) {
  return { get: vi.fn(async () => response) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("input schema", () => {
  it("defaults hoursBack to 24", () => {
    expect(getFailedAsyncJobs.inputSchema.parse({})).toEqual({ hoursBack: 24 });
  });

  it("accepts the bounds 1 and 168", () => {
    expect(getFailedAsyncJobs.inputSchema.parse({ hoursBack: 1 }).hoursBack).toBe(1);
    expect(getFailedAsyncJobs.inputSchema.parse({ hoursBack: 168 }).hoursBack).toBe(168);
  });

  it("rejects 0 and 169", () => {
    expect(() => getFailedAsyncJobs.inputSchema.parse({ hoursBack: 0 })).toThrow();
    expect(() => getFailedAsyncJobs.inputSchema.parse({ hoursBack: 169 })).toThrow();
  });

  it("rejects non-integers", () => {
    expect(() => getFailedAsyncJobs.inputSchema.parse({ hoursBack: 1.5 })).toThrow();
  });
});

describe("queryFailedAsyncJobs happy path", () => {
  it("queries asyncoperations with the documented select/filter/orderby/top", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const client = fakeClient(loadFixture("asyncJobs.happy.json"));

    await queryFailedAsyncJobs(client, { hoursBack: 24 });

    expect(client.get).toHaveBeenCalledTimes(1);
    const [path, options] = client.get.mock.calls[0] as unknown as [
      string,
      QueryOptions,
    ];
    expect(path).toBe("asyncoperations");
    expect(options.select).toEqual([
      "asyncoperationid",
      "name",
      "operationtype",
      "statuscode",
      "errorcode",
      "message",
      "friendlymessage",
      "createdon",
      "completedon",
    ]);
    expect(options.filter).toBe(
      "(statuscode eq 31 or statuscode eq 32) and createdon ge 2026-07-09T12:00:00.000Z",
    );
    expect(options.orderby).toBe("createdon desc");
    expect(options.top).toBe(500);
  });

  it("groups by name + errorcode, sorts by count desc and summarizes statuses", async () => {
    const fixture = loadFixture("asyncJobs.happy.json");
    const result = (await queryFailedAsyncJobs(fakeClient(fixture), {
      hoursBack: 24,
    })) as ToolResult;

    expect(result.totalFailures).toBe(6);
    expect(result.failed).toBe(4);
    expect(result.canceled).toBe(2);
    expect(result.windowHours).toBe(24);
    expect(result).not.toHaveProperty("truncated");

    expect(result.groups.map((g) => g.count)).toEqual([3, 2, 1]);
    const [workflowGroup, bulkDeleteGroup, importGroup] = result.groups;

    expect(workflowGroup).toMatchObject({
      name: "Sync Contacts Workflow",
      errorCode: -2147220970,
      count: 3,
      retryable: true,
      operationType: "Workflow",
      latestOccurrence: "2026-07-10T11:30:00Z",
    });
    // Excerpt comes from the most recent row and is capped at 300 chars.
    const longMessage = fixture.value[0]?.message ?? "";
    expect(longMessage.length).toBeGreaterThan(300);
    expect(workflowGroup?.latestMessageExcerpt).toBe(longMessage.slice(0, 300));
    expect(workflowGroup?.latestMessageExcerpt?.length).toBe(300);

    expect(bulkDeleteGroup).toMatchObject({
      name: "Nightly Bulk Delete",
      errorCode: null,
      count: 2,
      retryable: false,
      operationType: "Bulk Delete",
      latestMessageExcerpt: "Job was canceled by an administrator.",
      latestOccurrence: "2026-07-10T08:00:00Z",
    });

    // Undocumented operationtype falls back to the numeric value as a string.
    expect(importGroup).toMatchObject({
      name: "Contact Import",
      errorCode: -2147204784,
      count: 1,
      retryable: false,
      operationType: "99",
    });
  });

  it("maps topFailures with status labels, retryable flags and optional excerpts", async () => {
    const result = (await queryFailedAsyncJobs(
      fakeClient(loadFixture("asyncJobs.happy.json")),
      { hoursBack: 24 },
    )) as ToolResult;

    expect(result.topFailures.length).toBeLessThanOrEqual(10);
    expect(result.topFailures).toHaveLength(6);
    expect(result.topFailures.map((f) => f.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "canceled",
      "canceled",
      "failed",
    ]);
    expect(result.topFailures.map((f) => f.retryable)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);

    const first = result.topFailures[0];
    expect(first).toMatchObject({
      id: "11111111-0000-0000-0000-000000000001",
      name: "Sync Contacts Workflow",
      operationType: "Workflow",
      errorCode: -2147220970,
      createdon: "2026-07-10T11:30:00Z",
      completedon: "2026-07-10T11:31:00Z",
    });
    expect(first?.messageExcerpt?.length).toBe(300);

    // Falls back to friendlymessage when message is null.
    expect(result.topFailures[2]?.messageExcerpt).toBe(
      "Friendly-only variant of the same failure.",
    );
    // Omits messageExcerpt entirely when neither field is present.
    expect(result.topFailures[4]).not.toHaveProperty("messageExcerpt");
  });
});

describe("queryFailedAsyncJobs empty window", () => {
  it("returns a zeroed summary with a hint, not an error", async () => {
    const result = await queryFailedAsyncJobs(
      fakeClient(loadFixture("asyncJobs.empty.json")),
      { hoursBack: 48 },
    );
    expect(result).toEqual({
      totalFailures: 0,
      failed: 0,
      canceled: 0,
      windowHours: 48,
      groups: [],
      topFailures: [],
      hint: "No failed or canceled async jobs in the last 48 hours.",
    });
  });
});

describe("queryFailedAsyncJobs failure modes", () => {
  it("maps 403 to an envelope with a privilege hint and docsUrl", async () => {
    const client = {
      get: vi.fn(async () => {
        throw new DataverseHttpError(
          403,
          "Principal user is missing prvReadAsyncOperation privilege",
        );
      }),
    };
    const result = await queryFailedAsyncJobs(client, { hoursBack: 24 });
    expect(result).toEqual({
      error: "Principal user is missing prvReadAsyncOperation privilege",
      hint: "Reading system jobs requires read privilege on the AsyncOperation (System Job) table (prvReadAsyncOperation). Grant it to the connecting identity's security role.",
      docsUrl:
        "https://learn.microsoft.com/power-apps/developer/data-platform/asynchronous-service",
    });
  });

  it("maps other errors through toErrorEnvelope", async () => {
    const client = {
      get: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    };
    expect(await queryFailedAsyncJobs(client, { hoursBack: 24 })).toEqual({
      error: "socket hang up",
    });
  });
});

describe("queryFailedAsyncJobs truncation", () => {
  it("sets truncated: true when exactly 500 rows come back", async () => {
    const rows: FixtureRow[] = Array.from({ length: 500 }, (_, i) => ({
      asyncoperationid: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      name: "Flaky Workflow",
      operationtype: 10,
      statuscode: i % 2 === 0 ? 31 : 32,
      errorcode: -2147220970,
      message: `failure ${i}`,
      friendlymessage: null,
      createdon: "2026-07-10T11:00:00Z",
      completedon: null,
    }));
    const result = (await queryFailedAsyncJobs(fakeClient({ value: rows }), {
      hoursBack: 24,
    })) as ToolResult;

    expect(result.truncated).toBe(true);
    expect(result.totalFailures).toBe(500);
    expect(result.failed).toBe(250);
    expect(result.canceled).toBe(250);
    expect(result.topFailures).toHaveLength(10);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.count).toBe(500);
  });
});
