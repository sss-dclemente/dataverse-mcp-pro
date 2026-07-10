import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectPatterns, PATTERN_RULES } from "../src/tools/patterns.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/exceptions/${name}`, import.meta.url), "utf8");
}

function patterns(text: string, depth = 1): string[] {
  return detectPatterns({ text, depth }).map((finding) => finding.pattern);
}

function findingFor(text: string, pattern: string, depth = 1) {
  const finding = detectPatterns({ text, depth }).find((f) => f.pattern === pattern);
  expect(finding, `expected pattern "${pattern}" to fire`).toBeDefined();
  return finding as NonNullable<typeof finding>;
}

describe("PATTERN_RULES", () => {
  it("uses kebab-case ids and non-empty fixes", () => {
    for (const rule of PATTERN_RULES) {
      expect(rule.pattern).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(rule.likelyFix.length).toBeGreaterThan(0);
    }
    expect(PATTERN_RULES.map((r) => r.pattern)).toEqual([
      "sql-timeout",
      "sql-deadlock",
      "missing-privilege",
      "null-reference",
      "depth-loop",
      "duplicate-detection",
    ]);
  });
});

describe("detectPatterns", () => {
  it("sql-timeout fires on the SQL timeout fixture with the matching line as evidence", () => {
    const finding = findingFor(fixture("sqlTimeout.txt"), "sql-timeout");
    expect(finding.evidence).toContain("Timeout Expired");
    expect(finding.evidence.length).toBeLessThanOrEqual(200);
    expect(finding.likelyFix).toContain("async");
  });

  it("sql-deadlock fires on the deadlock fixture", () => {
    const finding = findingFor(fixture("deadlock.txt"), "sql-deadlock");
    expect(finding.evidence).toContain("was deadlocked on lock resources");
    expect(finding.evidence.length).toBeLessThanOrEqual(200);
    // deadlock is not a timeout
    expect(patterns(fixture("deadlock.txt"))).not.toContain("sql-timeout");
  });

  it("missing-privilege fires on the privilege fixture", () => {
    const finding = findingFor(fixture("privilege.txt"), "missing-privilege");
    expect(finding.evidence).toContain("SecLib::AccessCheckEx");
    expect(finding.evidence.length).toBeLessThanOrEqual(200);
    expect(finding.likelyFix).toContain("security role");
  });

  it("null-reference fires on the aggregate fixture", () => {
    const finding = findingFor(fixture("aggregate.txt"), "null-reference");
    expect(finding.evidence).toContain("NullReferenceException");
    expect(finding.evidence.length).toBeLessThanOrEqual(200);
  });

  it("duplicate-detection fires on duplicate detection fault text", () => {
    const text =
      "Microsoft.Xrm.Sdk.InvalidPluginExecutionException: A duplicate record was found when creating the account.\n" +
      "Duplicate detection rule 'Accounts with the same Account Name' matched 2 records.";
    const finding = findingFor(text, "duplicate-detection");
    expect(finding.evidence.toLowerCase()).toContain("duplicate");
  });

  it("depth-loop fires at depth 8 (not depth-7) with synthetic evidence", () => {
    const clean = fixture("customException.txt");
    expect(patterns(clean, 7)).not.toContain("depth-loop");
    const finding = findingFor(clean, "depth-loop", 8);
    expect(finding.evidence).toBe("execution depth 8 suggests a plug-in update loop");
  });

  it("depth-loop fires at depth 9 on the depth-loop fixture (and is the only finding)", () => {
    const findings = detectPatterns({ text: fixture("depthLoop.txt"), depth: 9 });
    expect(findings).toEqual([
      {
        pattern: "depth-loop",
        evidence: "execution depth 9 suggests a plug-in update loop",
        likelyFix: expect.stringContaining("filtering attributes"),
      },
    ]);
  });

  it("returns [] for clean text at low depth", () => {
    expect(detectPatterns({ text: fixture("customException.txt"), depth: 2 })).toEqual([]);
    expect(detectPatterns({ text: "", depth: 1 })).toEqual([]);
  });

  it("returns one finding per matching rule when several rules match", () => {
    const text =
      "System.Data.SqlClient.SqlException: Execution Timeout Expired. The timeout period elapsed.\n" +
      "Transaction (Process ID 51) was deadlocked on lock resources with another process.";
    const found = patterns(text);
    expect(found).toContain("sql-timeout");
    expect(found).toContain("sql-deadlock");
    expect(found).toHaveLength(2);
    // at most one finding per rule
    expect(new Set(found).size).toBe(found.length);
  });

  it("keeps the match visible when the matching line is longer than 200 chars", () => {
    const filler = "Sandbox worker process noise ".repeat(12); // > 200 chars of prefix
    const text = `${filler}System.Data.SqlClient.SqlException: Execution Timeout Expired before completion.`;
    const finding = findingFor(text, "sql-timeout");
    expect(finding.evidence.length).toBeLessThanOrEqual(200);
    expect(finding.evidence).toContain("Timeout Expired");
  });
});
