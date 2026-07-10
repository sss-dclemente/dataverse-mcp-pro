import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPluginTraces,
  queryPluginTraces,
  type PluginTracesInput,
} from "../src/tools/getPluginTraces.js";
import {
  DataverseHttpError,
  type DataverseClient,
  type QueryOptions,
} from "../src/dataverse/client.js";

const DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";

const happyFixture = JSON.parse(
  readFileSync(new URL("./fixtures/pluginTraces.happy.json", import.meta.url), "utf8"),
) as { value: Array<Record<string, unknown>> };
const emptyFixture = JSON.parse(
  readFileSync(new URL("./fixtures/pluginTraces.empty.json", import.meta.url), "utf8"),
) as { value: unknown[] };

interface ResultShape {
  count?: number;
  traces?: Array<Record<string, unknown>>;
  error?: string;
  hint?: string;
  docsUrl?: string;
}

function fakeClient(result: unknown) {
  const get = vi.fn(
    async (_path: string, _options?: QueryOptions): Promise<unknown> => result,
  );
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function throwingClient(err: unknown) {
  const get = vi.fn(async (_path: string, _options?: QueryOptions): Promise<unknown> => {
    throw err;
  });
  return { get, client: { get } as unknown as Pick<DataverseClient, "get"> };
}

function firstCall(get: ReturnType<typeof vi.fn>): [string, QueryOptions] {
  return get.mock.calls[0] as unknown as [string, QueryOptions];
}

function parseInput(raw: Record<string, unknown> = {}): PluginTracesInput {
  return getPluginTraces.inputSchema.parse(raw);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("input schema", () => {
  it("applies defaults: onlyErrors true, hoursBack 24, top 25", () => {
    const input = parseInput();
    expect(input.onlyErrors).toBe(true);
    expect(input.hoursBack).toBe(24);
    expect(input.top).toBe(25);
    expect(input.entity).toBeUndefined();
    expect(input.messageName).toBeUndefined();
    expect(input.pluginTypeName).toBeUndefined();
    expect(input.correlationId).toBeUndefined();
  });

  it("rejects hoursBack above 168 and below 1", () => {
    expect(getPluginTraces.inputSchema.safeParse({ hoursBack: 169 }).success).toBe(false);
    expect(getPluginTraces.inputSchema.safeParse({ hoursBack: 0 }).success).toBe(false);
    expect(getPluginTraces.inputSchema.safeParse({ hoursBack: 168 }).success).toBe(true);
  });

  it("rejects top above 100 and below 1", () => {
    expect(getPluginTraces.inputSchema.safeParse({ top: 101 }).success).toBe(false);
    expect(getPluginTraces.inputSchema.safeParse({ top: 0 }).success).toBe(false);
    expect(getPluginTraces.inputSchema.safeParse({ top: 100 }).success).toBe(true);
  });

  it("rejects a non-uuid correlationId and accepts a valid one", () => {
    expect(
      getPluginTraces.inputSchema.safeParse({ correlationId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      getPluginTraces.inputSchema.safeParse({
        correlationId: "0f0e0d0c-0b0a-4998-8877-665544332211",
      }).success,
    ).toBe(true);
  });

  it("is exposed as the tool get_plugin_traces", () => {
    expect(getPluginTraces.name).toBe("get_plugin_traces");
    expect(getPluginTraces.description.toLowerCase()).toContain("free tier");
  });
});

describe("queryPluginTraces happy path", () => {
  it("queries plugintracelogs with select/orderby/top and errors-only default filter", async () => {
    const { get, client } = fakeClient(happyFixture);
    await queryPluginTraces(client, parseInput());

    expect(get).toHaveBeenCalledTimes(1);
    const [path, options] = firstCall(get);
    expect(path).toBe("plugintracelogs");
    expect(options.select).toEqual([
      "plugintracelogid",
      "createdon",
      "typename",
      "messagename",
      "primaryentity",
      "depth",
      "mode",
      "performanceexecutionduration",
      "exceptiondetails",
      "correlationid",
    ]);
    expect(options.select).not.toContain("messageblock");
    expect(options.orderby).toBe("createdon desc");
    expect(options.top).toBe(25);
    expect(options.filter).toMatch(
      /^createdon ge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z and exceptiondetails ne null$/,
    );
  });

  it("maps traces to the structured output shape", async () => {
    const { client } = fakeClient(happyFixture);
    const result = (await queryPluginTraces(client, parseInput())) as ResultShape;

    expect(result.count).toBe(3);
    expect(result.traces).toHaveLength(3);

    const [first, second, third] = result.traces as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(first).toMatchObject({
      id: "a1b2c3d4-0001-4a2b-9c3d-1234567890ab",
      createdon: "2026-07-10T09:41:07Z",
      pluginType: "Contoso.Plugins.AccountNumberValidator",
      messageName: "Update",
      primaryEntity: "account",
      depth: 1,
      mode: "sync",
      durationMs: 312,
      correlationId: "0f0e0d0c-0b0a-4998-8877-665544332211",
    });
    expect(second.mode).toBe("async");
    expect(third.mode).toBe("sync");
  });

  it("summarizes and truncates exception details, never returning the raw fields", async () => {
    const { client } = fakeClient(happyFixture);
    const result = (await queryPluginTraces(client, parseInput())) as ResultShape;
    const [first, second, third] = result.traces as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    // Summary is the first non-empty line only (fixture starts with a blank line).
    expect(first.exceptionSummary).toBe(
      "Unhandled Exception: Microsoft.Xrm.Sdk.InvalidPluginExecutionException: " +
        "Account number is required and must match the pattern ACC-#####. " +
        "Fix the value on the form or in the integration payload before saving.",
    );
    expect(first.exceptionSummary).not.toContain("\n");
    // Excerpt is exactly the first 500 chars of a >500-char details string.
    const rawDetails = happyFixture.value[0]?.["exceptiondetails"] as string;
    expect(rawDetails.length).toBeGreaterThan(500);
    expect(first.exceptionExcerpt).toBe(rawDetails.slice(0, 500));
    expect((first.exceptionExcerpt as string).length).toBe(500);

    // Raw payload fields never appear in the output.
    for (const trace of result.traces ?? []) {
      expect("exceptiondetails" in trace).toBe(false);
      expect("messageblock" in trace).toBe(false);
    }
    // No exception fields when details are null or empty string.
    expect("exceptionSummary" in second).toBe(false);
    expect("exceptionExcerpt" in second).toBe(false);
    expect("exceptionSummary" in third).toBe(false);
    expect("exceptionExcerpt" in third).toBe(false);
  });
});

describe("empty result", () => {
  it("returns count 0 with a tracing-may-be-disabled hint and docsUrl", async () => {
    const { client } = fakeClient(emptyFixture);
    const result = (await queryPluginTraces(client, parseInput())) as ResultShape;

    expect(result.count).toBe(0);
    expect(result.traces).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.hint).toContain('"Enable logging to plug-in trace log"');
    expect(result.hint).toContain("Settings > Administration > System Settings");
    expect(result.docsUrl).toBe(DOCS_URL);
  });
});

describe("failure modes", () => {
  it("maps a 403 to an envelope with the privilege hint", async () => {
    const { client } = throwingClient(
      new DataverseHttpError(
        403,
        "Principal user (Id=00000000-0000-0000-0000-000000000001, type=8) is missing prvReadPluginTraceLog privilege",
      ),
    );
    const result = (await queryPluginTraces(client, parseInput())) as ResultShape;

    expect(result.error).toContain("prvReadPluginTraceLog");
    expect(result.hint).toContain("prvReadPluginTraceLog");
    expect(result.hint).toContain("System Administrator");
    expect(result.docsUrl).toBe(DOCS_URL);
    expect(result.traces).toBeUndefined();
  });

  it("maps any other error via toErrorEnvelope without letting it escape", async () => {
    const { client } = throwingClient(new Error("socket hang up"));
    const result = (await queryPluginTraces(client, parseInput())) as ResultShape;
    expect(result).toEqual({ error: "socket hang up" });
  });
});

describe("filter building", () => {
  it("combines all filters, escapes strings, uses contains() and an unquoted guid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));

    const { get, client } = fakeClient(emptyFixture);
    await queryPluginTraces(
      client,
      parseInput({
        entity: "o'brien_orders",
        messageName: "Upd'ate",
        pluginTypeName: "Conto'so.Plugins",
        correlationId: "0f0e0d0c-0b0a-4998-8877-665544332211",
        onlyErrors: false,
        hoursBack: 48,
        top: 100,
      }),
    );

    const [, options] = firstCall(get);
    const filter = options.filter ?? "";
    const parts = filter.split(" and ");
    expect(parts).toEqual([
      "createdon ge 2026-07-08T12:00:00.000Z",
      "primaryentity eq 'o''brien_orders'",
      "messagename eq 'Upd''ate'",
      "contains(typename,'Conto''so.Plugins')",
      "correlationid eq 0f0e0d0c-0b0a-4998-8877-665544332211",
    ]);
    // uniqueidentifier literal must not be quoted, and errors-only clause is off
    expect(filter).not.toContain("correlationid eq '");
    expect(filter).not.toContain("exceptiondetails ne null");
    expect(options.top).toBe(100);
  });
});
