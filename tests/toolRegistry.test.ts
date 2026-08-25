import { describe, expect, it } from "vitest";
import { tools } from "../src/tools/index.js";

describe("tool registry", () => {
  it("registers every tool with a unique name and a description", () => {
    const names = tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.description.trim()).not.toBe("");
    }
  });

  it("advertises no licensing tiers: every tool is free and MIT-licensed", () => {
    // The paid tiers were removed in 0.3.0. Tool descriptions are surfaced
    // verbatim by MCP hosts, so a stray "Free tier." implies the others are not.
    const offenders = tools
      .filter((t) => /\btier\b|license key|upgrade to/i.test(t.description))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("keeps descriptions free of trailing whitespace", () => {
    for (const tool of tools) {
      expect(tool.description).toBe(tool.description.trim());
    }
  });
});
