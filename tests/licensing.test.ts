import { describe, expect, it } from "vitest";
import { isProLicensed, proUpgradeMessage } from "../src/licensing.js";

describe("isProLicensed", () => {
  it("returns false when LICENSE_KEY is absent", () => {
    expect(isProLicensed({})).toBe(false);
    expect(isProLicensed({ OTHER: "x" })).toBe(false);
  });

  it("returns false when LICENSE_KEY is undefined", () => {
    expect(isProLicensed({ LICENSE_KEY: undefined })).toBe(false);
  });

  it("returns false when LICENSE_KEY is empty or whitespace", () => {
    expect(isProLicensed({ LICENSE_KEY: "" })).toBe(false);
    expect(isProLicensed({ LICENSE_KEY: "   " })).toBe(false);
    expect(isProLicensed({ LICENSE_KEY: "\t\n" })).toBe(false);
  });

  it("returns true when LICENSE_KEY is set", () => {
    expect(isProLicensed({ LICENSE_KEY: "abc-123" })).toBe(true);
    expect(isProLicensed({ LICENSE_KEY: "  abc-123  " })).toBe(true);
  });
});

describe("proUpgradeMessage", () => {
  it("returns the expected shape for a tool", () => {
    const msg = proUpgradeMessage("trace_analyzer");
    expect(msg.upgradeRequired).toBe(true);
    expect(msg.tool).toBe("trace_analyzer");
    expect(msg.docsUrl).toBe(
      "https://github.com/sss-dclemente/dataverse-mcp-pro#pro",
    );
    expect(msg.message).toContain("trace_analyzer");
    expect(msg.message).toContain("Pro");
    expect(msg.message).toContain("LICENSE_KEY");
    expect(Object.keys(msg).sort()).toEqual([
      "docsUrl",
      "message",
      "tool",
      "upgradeRequired",
    ]);
  });
});
