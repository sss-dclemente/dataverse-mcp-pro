import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseExceptionDetails } from "../src/tools/exceptionParser.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/exceptions/${name}`, import.meta.url), "utf8");
}

const PLATFORM_FRAME_RE =
  /^at (Microsoft\.Xrm\.|Microsoft\.Crm\.|Microsoft\.PowerPlatform\.|System\.|PluginProfiler\.)/;

const FIXTURES = [
  "sqlTimeout.txt",
  "deadlock.txt",
  "privilege.txt",
  "customException.txt",
  "aggregate.txt",
  "depthLoop.txt",
] as const;

describe("parseExceptionDetails", () => {
  it("sqlTimeout.txt: innermost SqlException with timeout message", () => {
    const parsed = parseExceptionDetails(fixture("sqlTimeout.txt"));
    expect(parsed.type).toBe("System.Data.SqlClient.SqlException");
    expect(parsed.message).toContain("Execution Timeout Expired");
    expect(parsed.message).toContain("server is not responding");
    expect(parsed.frames).toContain(
      "at MyCompany.Plugins.AccountPostUpdate.RecalculateRollups(IOrganizationService service, Guid accountId)",
    );
    expect(parsed.frames).toContain(
      "at MyCompany.Plugins.AccountPostUpdate.Execute(IServiceProvider serviceProvider)",
    );
  });

  it("deadlock.txt: innermost SqlException with deadlock message", () => {
    const parsed = parseExceptionDetails(fixture("deadlock.txt"));
    expect(parsed.type).toBe("System.Data.SqlClient.SqlException");
    expect(parsed.message).toContain("was deadlocked on lock resources");
    expect(parsed.message).toContain("Rerun the transaction");
    expect(parsed.frames).toContain(
      "at Contoso.Plugins.OpportunityPostUpdate.UpdateTotals(IOrganizationService service, EntityReference opportunityRef)",
    );
    expect(parsed.frames).toContain(
      "at Contoso.Plugins.OpportunityPostUpdate.Execute(IServiceProvider serviceProvider)",
    );
  });

  it("privilege.txt: FaultException wrapper with a multi-line SecLib message", () => {
    const parsed = parseExceptionDetails(fixture("privilege.txt"));
    expect(parsed.type).toBe(
      "System.ServiceModel.FaultException`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]",
    );
    expect(parsed.message).toContain("SecLib::AccessCheckEx failed");
    // second message line, before the first stack frame
    expect(parsed.message).toContain("missing prvReadAccount privilege");
    expect((parsed.message ?? "").length).toBeLessThanOrEqual(500);
    expect(parsed.frames).toContain(
      "at MyCompany.Plugins.AccountPostUpdate.Execute(IServiceProvider serviceProvider)",
    );
  });

  it("customException.txt: InvalidPluginExecutionException with a business message", () => {
    const parsed = parseExceptionDetails(fixture("customException.txt"));
    expect(parsed.type).toBe("Microsoft.Xrm.Sdk.InvalidPluginExecutionException");
    expect(parsed.message).toBe(
      "Credit limit cannot be lowered below the outstanding balance for this account.",
    );
    expect(parsed.frames).toEqual([
      "at MyCompany.Plugins.AccountPreUpdate.ValidateCreditLimit(Entity target, Entity preImage)",
      "at MyCompany.Plugins.AccountPreUpdate.Execute(IServiceProvider serviceProvider)",
    ]);
  });

  it("aggregate.txt: takes the AggregateException's FIRST inner exception", () => {
    const parsed = parseExceptionDetails(fixture("aggregate.txt"));
    expect(parsed.type).toBe("System.NullReferenceException");
    expect(parsed.message).toBe("Object reference not set to an instance of an object.");
    // NOT the "(Inner Exception #1)" TimeoutException
    expect(parsed.type).not.toContain("Timeout");
    expect(parsed.frames).toContain(
      "at MyCompany.Plugins.ContactPostCreate.<>c__DisplayClass3_0.<Execute>b__0()",
    );
    expect(parsed.frames).toContain(
      "at MyCompany.Plugins.ContactPostCreate.Execute(IServiceProvider serviceProvider)",
    );
  });

  it("depthLoop.txt: innermost InvalidPluginExecutionException with the loop message", () => {
    const parsed = parseExceptionDetails(fixture("depthLoop.txt"));
    expect(parsed.type).toBe("Microsoft.Xrm.Sdk.InvalidPluginExecutionException");
    expect(parsed.message).toContain("included an infinite loop");
    expect(parsed.frames).toContain(
      "at MyCompany.Plugins.CaseEscalationPlugin.Execute(IServiceProvider serviceProvider)",
    );
  });

  it.each(FIXTURES)("%s: keeps only user/plugin frames, all trimmed 'at ...' lines", (name) => {
    const parsed = parseExceptionDetails(fixture(name));
    expect(parsed.frames.length).toBeGreaterThan(0);
    for (const frame of parsed.frames) {
      expect(frame.startsWith("at ")).toBe(true);
      expect(frame).toBe(frame.trim());
      expect(frame).not.toMatch(PLATFORM_FRAME_RE);
    }
  });

  it("caps frames at 15", () => {
    const lines = ["Contoso.DemoException: too many frames"];
    for (let i = 0; i < 20; i++) {
      lines.push(`   at Contoso.Plugins.Frame${i}.Execute(IServiceProvider serviceProvider)`);
    }
    const parsed = parseExceptionDetails(lines.join("\n"));
    expect(parsed.frames).toHaveLength(15);
    expect(parsed.frames[0]).toBe(
      "at Contoso.Plugins.Frame0.Execute(IServiceProvider serviceProvider)",
    );
    expect(parsed.frames[14]).toBe(
      "at Contoso.Plugins.Frame14.Execute(IServiceProvider serviceProvider)",
    );
  });

  it("caps the message at 500 chars", () => {
    const parsed = parseExceptionDetails(`Contoso.DemoException: ${"x".repeat(600)}`);
    expect(parsed.type).toBe("Contoso.DemoException");
    expect(parsed.message).toHaveLength(500);
  });

  it("garbage input: null type, first non-empty line as message (max 200), no frames", () => {
    const parsed = parseExceptionDetails("\n   \nnot an exception at all ???\nsecond line\n");
    expect(parsed).toEqual({
      type: null,
      message: "not an exception at all ???",
      frames: [],
    });
  });

  it("garbage input: fallback message is trimmed to 200 chars", () => {
    const parsed = parseExceptionDetails("y".repeat(300));
    expect(parsed.type).toBeNull();
    expect(parsed.message).toHaveLength(200);
    expect(parsed.frames).toEqual([]);
  });

  it("empty string: all-null result", () => {
    expect(parseExceptionDetails("")).toEqual({ type: null, message: null, frames: [] });
  });

  it("whitespace-only input: all-null result", () => {
    expect(parseExceptionDetails("  \n\t \n")).toEqual({
      type: null,
      message: null,
      frames: [],
    });
  });
});
