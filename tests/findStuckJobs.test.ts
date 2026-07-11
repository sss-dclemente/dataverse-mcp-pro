import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findStuckJobs, queryStuckJobs } from "../src/tools/findStuckJobs.js";
import { DataverseHttpError, type QueryOptions } from "../src/dataverse/client.js";

interface FixtureRow {
  asyncoperationid: string;
  name: string | null;
  operationtype: number | null;
  statuscode: number | null;
  statecode: number | null;
  createdon: string | null;
  startedon: string | null;
  postponeuntil: string | null;
  message: string | null;
}

function loadFixture(name: string): { value: FixtureRow[] } {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as { value: FixtureRow[] };
}

interface ToolResult {
  stuckCount: number;
  scheduledCount: number;
  windowNote: string;
  groups: Array<{
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
  }>;
  oldest: Array<{
    id: string;
    name: string | null;
    operationType: string;
    status: string;
    createdOn: string | null;
    startedOn?: string;
    ageHours: number | null;
    messageExcerpt?: string;
  }>;
  truncated?: boolean;
  hints?: string[];
  hint?: string;
}

function fakeClient(response: unknown) {
  return { get: vi.fn(async () => response) };
}

function useFrozenClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("input schema", () => {
  it("defaults olderThanHours to 6", () => {
    expect(findStuckJobs.inputSchema.parse({})).toEqual({ olderThanHours: 6 });
  });

  it("accepts the bounds 1 and 720", () => {
    expect(findStuckJobs.inputSchema.parse({ olderThanHours: 1 }).olderThanHours).toBe(1);
    expect(findStuckJobs.inputSchema.parse({ olderThanHours: 720 }).olderThanHours).toBe(
      720,
    );
  });

  it("rejects 0, 721 and non-integers", () => {
    expect(() => findStuckJobs.inputSchema.parse({ olderThanHours: 0 })).toThrow();
    expect(() => findStuckJobs.inputSchema.parse({ olderThanHours: 721 })).toThrow();
    expect(() => findStuckJobs.inputSchema.parse({ olderThanHours: 2.5 })).toThrow();
  });
});

describe("queryStuckJobs query shape", () => {
  it("queries asyncoperations with the documented select/filter/orderby/top", async () => {
    useFrozenClock();
    const client = fakeClient(loadFixture("stuckJobs.happy.json"));

    await queryStuckJobs(client, { olderThanHours: 6 });

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
      "statecode",
      "createdon",
      "startedon",
      "postponeuntil",
      "message",
    ]);
    expect(options.filter).toBe(
      "(statuscode eq 0 or statuscode eq 10 or statuscode eq 20) and createdon le 2026-07-11T06:00:00.000Z",
    );
    expect(options.orderby).toBe("createdon asc");
    expect(options.top).toBe(500);
  });
});

describe("queryStuckJobs happy path", () => {
  it("splits stuck vs scheduled and notes the excluded postponed jobs", async () => {
    useFrozenClock();
    const result = (await queryStuckJobs(
      fakeClient(loadFixture("stuckJobs.happy.json")),
      { olderThanHours: 6 },
    )) as ToolResult;

    expect(result.stuckCount).toBe(7);
    expect(result.scheduledCount).toBe(1);
    expect(result.windowNote).toBe(
      "jobs created more than 6 hours ago still waiting/in progress",
    );
    expect(result).not.toHaveProperty("truncated");

    // The future-postponeuntil row is scheduled: absent from groups and oldest.
    expect(result.groups.map((g) => g.name)).not.toContain("Delayed Escalation");
    expect(result.oldest.map((r) => r.name)).not.toContain("Delayed Escalation");
    // The past-postponeuntil row is stuck, not scheduled.
    expect(result.oldest.map((r) => r.id)).toContain(
      "22222222-0000-0000-0000-000000000006",
    );

    expect(result.hints).toContain(
      "waiting-for-resources jobs older than a day usually mean the async service is saturated or maintenance jobs are blocked",
    );
    expect(
      result.hints?.some((h) => h.includes("postponeuntil in the future")),
    ).toBe(true);
  });

  it("groups stuck rows by name + operation type with status breakdowns, oldest first", async () => {
    useFrozenClock();
    const result = (await queryStuckJobs(
      fakeClient(loadFixture("stuckJobs.happy.json")),
      { olderThanHours: 6 },
    )) as ToolResult;

    expect(result.groups).toHaveLength(3);
    const [workflowGroup, maintenanceGroup, customGroup] = result.groups;

    expect(workflowGroup).toEqual({
      name: "Sync Contacts Workflow",
      operationType: "Workflow",
      statusBreakdown: { waitingForResources: 1, waiting: 2, inProgress: 1 },
      count: 4,
      oldestCreatedOn: "2026-07-10T06:00:00Z",
      ageHours: 30,
    });
    expect(maintenanceGroup).toEqual({
      name: "Nightly Maintenance",
      operationType: "Bulk Delete",
      statusBreakdown: { waitingForResources: 1, waiting: 1, inProgress: 0 },
      count: 2,
      oldestCreatedOn: "2026-07-10T09:00:00Z",
      ageHours: 27,
    });
    // Undocumented operationtype falls back to the numeric value as a string.
    expect(customGroup).toEqual({
      name: "Custom Job",
      operationType: "99",
      statusBreakdown: { waitingForResources: 0, waiting: 0, inProgress: 1 },
      count: 1,
      oldestCreatedOn: "2026-07-11T03:00:00Z",
      ageHours: 9,
    });
  });

  it("maps oldest rows with status labels, ageHours and optional startedOn/messageExcerpt", async () => {
    useFrozenClock();
    const fixture = loadFixture("stuckJobs.happy.json");
    const result = (await queryStuckJobs(fakeClient(fixture), {
      olderThanHours: 6,
    })) as ToolResult;

    expect(result.oldest).toHaveLength(7);
    expect(result.oldest.map((r) => r.ageHours)).toEqual([30, 27, 24, 18, 15, 12, 9]);
    expect(result.oldest.map((r) => r.status)).toEqual([
      "waiting",
      "waiting-for-resources",
      "waiting",
      "in-progress",
      "waiting",
      "waiting-for-resources",
      "in-progress",
    ]);

    const first = result.oldest[0];
    expect(first).toMatchObject({
      id: "22222222-0000-0000-0000-000000000001",
      name: "Sync Contacts Workflow",
      operationType: "Workflow",
      status: "waiting",
      createdOn: "2026-07-10T06:00:00Z",
      ageHours: 30,
    });
    // Excerpt capped at 200 chars; startedOn omitted when startedon is null.
    const longMessage = fixture.value[0]?.message ?? "";
    expect(longMessage.length).toBeGreaterThan(200);
    expect(first?.messageExcerpt).toBe(longMessage.slice(0, 200));
    expect(first?.messageExcerpt?.length).toBe(200);
    expect(first).not.toHaveProperty("startedOn");

    // startedOn included when present; messageExcerpt omitted when message is null.
    const inProgress = result.oldest[3];
    expect(inProgress?.startedOn).toBe("2026-07-10T18:05:00Z");
    expect(result.oldest[1]).not.toHaveProperty("messageExcerpt");
  });
});

describe("queryStuckJobs healthy queue", () => {
  it("returns a zeroed summary with a healthy hint, not an error", async () => {
    useFrozenClock();
    const result = await queryStuckJobs(
      fakeClient(loadFixture("stuckJobs.empty.json")),
      { olderThanHours: 12 },
    );
    expect(result).toEqual({
      stuckCount: 0,
      scheduledCount: 0,
      windowNote: "jobs created more than 12 hours ago still waiting/in progress",
      groups: [],
      oldest: [],
      hint: "No stuck async jobs older than 12 hours — the async queue is healthy.",
    });
  });
});

describe("queryStuckJobs failure modes", () => {
  it("maps 403 to an envelope with a privilege hint and docsUrl", async () => {
    const client = {
      get: vi.fn(async () => {
        throw new DataverseHttpError(
          403,
          "Principal user is missing prvReadAsyncOperation privilege",
        );
      }),
    };
    const result = await queryStuckJobs(client, { olderThanHours: 6 });
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
    expect(await queryStuckJobs(client, { olderThanHours: 6 })).toEqual({
      error: "socket hang up",
    });
  });
});

describe("queryStuckJobs truncation", () => {
  it("sets truncated: true when exactly 500 rows come back", async () => {
    useFrozenClock();
    const rows: FixtureRow[] = Array.from({ length: 500 }, (_, i) => ({
      asyncoperationid: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      name: "Backlogged Workflow",
      operationtype: 10,
      statuscode: i % 2 === 0 ? 10 : 0,
      statecode: 0,
      createdon: "2026-07-10T06:00:00Z",
      startedon: null,
      postponeuntil: null,
      message: null,
    }));
    const result = (await queryStuckJobs(fakeClient({ value: rows }), {
      olderThanHours: 6,
    })) as ToolResult;

    expect(result.truncated).toBe(true);
    expect(result.stuckCount).toBe(500);
    expect(result.scheduledCount).toBe(0);
    expect(result.oldest).toHaveLength(10);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.count).toBe(500);
    expect(result.groups[0]?.statusBreakdown).toEqual({
      waitingForResources: 250,
      waiting: 250,
      inProgress: 0,
    });
  });
});
