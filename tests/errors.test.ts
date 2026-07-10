import { describe, expect, it } from "vitest";
import { errorEnvelope, toErrorEnvelope } from "../src/errors.js";

describe("errorEnvelope", () => {
  it("builds a bare envelope without undefined keys when extras omitted", () => {
    const env = errorEnvelope("boom");
    expect(env).toEqual({ error: "boom" });
    expect(Object.keys(env)).toEqual(["error"]);
    expect("hint" in env).toBe(false);
    expect("docsUrl" in env).toBe(false);
  });

  it("includes hint and docsUrl when provided", () => {
    expect(
      errorEnvelope("boom", { hint: "try again", docsUrl: "https://example.com" }),
    ).toEqual({ error: "boom", hint: "try again", docsUrl: "https://example.com" });
  });

  it("omits keys for extras fields left undefined", () => {
    const env = errorEnvelope("boom", { hint: "only hint" });
    expect(env).toEqual({ error: "boom", hint: "only hint" });
    expect("docsUrl" in env).toBe(false);
  });
});

describe("toErrorEnvelope", () => {
  it("passes through envelope-shaped values", () => {
    expect(
      toErrorEnvelope({ error: "already shaped", hint: "h", docsUrl: "d" }),
    ).toEqual({ error: "already shaped", hint: "h", docsUrl: "d" });
  });

  it("passes through a minimal envelope without adding keys", () => {
    const env = toErrorEnvelope({ error: "just error" });
    expect(env).toEqual({ error: "just error" });
    expect("hint" in env).toBe(false);
  });

  it("maps Error instances to their message, without a stack", () => {
    const env = toErrorEnvelope(new Error("kaboom"));
    expect(env).toEqual({ error: "kaboom" });
    expect(JSON.stringify(env)).not.toContain("stack");
  });

  it("maps non-Error values via String()", () => {
    expect(toErrorEnvelope("plain string")).toEqual({ error: "plain string" });
    expect(toErrorEnvelope(42)).toEqual({ error: "42" });
    expect(toErrorEnvelope(null)).toEqual({ error: "null" });
    expect(toErrorEnvelope(undefined)).toEqual({ error: "undefined" });
  });

  it("does not treat objects with a non-string error prop as envelopes", () => {
    const env = toErrorEnvelope({ error: 500 });
    expect(env).toEqual({ error: "[object Object]" });
  });
});
