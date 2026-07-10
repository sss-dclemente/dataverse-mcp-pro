import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetLicensingForTests,
  initLicensing,
  isProLicensed,
  proUpgradeMessage,
} from "../src/licensing.js";

const KEY = "dvops-secret-license-key-123";
const ORG_URL = "https://MyOrg.crm.dynamics.com";

const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

type FetchStub = ReturnType<typeof vi.fn> & typeof fetch;

function fetchReturning(status: number, body: unknown): FetchStub {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as FetchStub;
}

function fetchRejecting(): FetchStub {
  return vi.fn(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as FetchStub;
}

let cacheDir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    LICENSE_KEY: KEY,
    DATAVERSE_URL: ORG_URL,
    DVOPS_CACHE_DIR: cacheDir,
    ...overrides,
  };
}

function cachePath(): string {
  return join(cacheDir, "license-cache.json");
}

function seedCache(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    cachePath(),
    JSON.stringify({
      keyHash: sha256(KEY),
      orgId: sha256(ORG_URL.trim().toLowerCase()),
      valid: true,
      tier: "pro",
      expiresAt: null,
      fetchedAt: Date.now() - DAY_MS,
      ...overrides,
    }),
    "utf8",
  );
}

function allStderrOutput(): string {
  return errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  _resetLicensingForTests();
  cacheDir = mkdtempSync(join(tmpdir(), "dvops-license-test-"));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetLicensingForTests();
});

describe("initLicensing", () => {
  it("valid key: remote state, cache written with hash only, body has no raw org URL", async () => {
    const fetchImpl = fetchReturning(200, {
      valid: true,
      tier: "pro",
      expiresAt: "2027-01-01T00:00:00Z",
    });

    const state = await initLicensing({ env: env(), fetchImpl });

    expect(state).toEqual({ licensed: true, tier: "pro", source: "remote" });
    expect(isProLicensed()).toBe(true);

    // Request: POST to the default validate URL with exactly the three fields.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("https://licensing.simplesmoothsafe.com/v1/validate");
    expect(init.method).toBe("POST");
    const rawBody = init.body as string;
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "licenseKey",
      "orgId",
      "productId",
    ]);
    expect(body["productId"]).toBe("dvops");
    // orgId is a sha256 hex of the trimmed, lowercased DATAVERSE_URL — the
    // raw URL itself never leaves the machine.
    expect(body["orgId"]).toMatch(/^[0-9a-f]{64}$/);
    expect(body["orgId"]).toBe(sha256(ORG_URL.trim().toLowerCase()));
    expect(rawBody).not.toContain("crm.dynamics.com");
    expect(rawBody).not.toContain("MyOrg");

    // Cache file: keyHash present, raw key absent.
    const cacheRaw = readFileSync(cachePath(), "utf8");
    expect(cacheRaw).toContain(sha256(KEY));
    expect(cacheRaw).not.toContain(KEY);
    const cached = JSON.parse(cacheRaw) as Record<string, unknown>;
    expect(cached["valid"]).toBe(true);
    expect(cached["tier"]).toBe("pro");
    expect(cached["expiresAt"]).toBe("2027-01-01T00:00:00Z");
    expect(typeof cached["fetchedAt"]).toBe("number");

    // The raw key never appears in the log output either.
    expect(allStderrOutput()).not.toContain(KEY);
    expect(allStderrOutput()).toContain("license valid (pro, remote)");
  });

  it("invalid key: free tier and matching cache file removed", async () => {
    seedCache();
    const fetchImpl = fetchReturning(200, {
      valid: false,
      tier: null,
      expiresAt: null,
    });

    const state = await initLicensing({ env: env(), fetchImpl });

    expect(state).toEqual({ licensed: false, tier: null, source: "none" });
    expect(isProLicensed()).toBe(false);
    expect(existsSync(cachePath())).toBe(false);
    expect(allStderrOutput()).not.toContain(KEY);
  });

  it("offline with fresh cache: licensed via cache source", async () => {
    seedCache({ fetchedAt: Date.now() - DAY_MS });

    const state = await initLicensing({ env: env(), fetchImpl: fetchRejecting() });

    expect(state).toEqual({ licensed: true, tier: "pro", source: "cache" });
    expect(isProLicensed()).toBe(true);
    expect(allStderrOutput()).toContain("cached validation");
    expect(allStderrOutput()).not.toContain(KEY);
  });

  it("offline with no cache: free tier", async () => {
    const state = await initLicensing({ env: env(), fetchImpl: fetchRejecting() });
    expect(state).toEqual({ licensed: false, tier: null, source: "none" });
    expect(isProLicensed()).toBe(false);
  });

  it("offline with stale cache (older than 7 days): free tier", async () => {
    seedCache({ fetchedAt: Date.now() - 8 * DAY_MS });
    const state = await initLicensing({ env: env(), fetchImpl: fetchRejecting() });
    expect(state).toEqual({ licensed: false, tier: null, source: "none" });
    expect(isProLicensed()).toBe(false);
  });

  it("offline with mismatched keyHash in cache: free tier", async () => {
    seedCache({ keyHash: sha256("some-other-key") });
    const state = await initLicensing({ env: env(), fetchImpl: fetchRejecting() });
    expect(state).toEqual({ licensed: false, tier: null, source: "none" });
    expect(isProLicensed()).toBe(false);
  });

  it("5xx from the service falls back to offline grace", async () => {
    seedCache();
    const fetchImpl = fetchReturning(503, { error: "unavailable" });
    const state = await initLicensing({ env: env(), fetchImpl });
    expect(state).toEqual({ licensed: true, tier: "pro", source: "cache" });
  });

  it("no license key: free tier immediately, zero fetch calls", async () => {
    const fetchImpl = fetchReturning(200, { valid: true, tier: "pro" });

    for (const key of [undefined, "", "   "]) {
      _resetLicensingForTests();
      const state = await initLicensing({
        env: env({ LICENSE_KEY: key }),
        fetchImpl,
      });
      expect(state).toEqual({ licensed: false, tier: null, source: "none" });
      expect(isProLicensed()).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors DVOPS_LICENSE_URL override", async () => {
    const fetchImpl = fetchReturning(200, { valid: true, tier: "team" });
    const state = await initLicensing({
      env: env({ DVOPS_LICENSE_URL: "https://example.test/v1/validate" }),
      fetchImpl,
    });
    expect(state).toEqual({ licensed: true, tier: "team", source: "remote" });
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe("https://example.test/v1/validate");
  });

  it("never throws even when fetch throws synchronously", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const state = await initLicensing({ env: env(), fetchImpl });
    expect(state).toEqual({ licensed: false, tier: null, source: "none" });
  });
});

describe("proUpgradeMessage", () => {
  it("returns the expected shape including checkoutUrl", () => {
    const msg = proUpgradeMessage("check_step_config");
    expect(msg.upgradeRequired).toBe(true);
    expect(msg.tool).toBe("check_step_config");
    expect(msg.checkoutUrl).toBe("https://dvops.simplesmoothsafe.com/#pricing");
    expect(msg.docsUrl).toBe(
      "https://github.com/sss-dclemente/dataverse-mcp-pro#pro",
    );
    expect(msg.message).toContain("check_step_config");
    expect(msg.message).toContain("Pro");
    expect(msg.message).toContain("LICENSE_KEY");
    expect(msg.message).toContain("pricing");
    expect(msg.message).toContain(msg.checkoutUrl);
  });
});

describe("isProLicensed legacy stub path", () => {
  // Documents the compatibility escape hatch: tool unit tests stub
  // LICENSE_KEY via env without ever calling initLicensing, and the gate
  // behaves like the pre-0.2.0 stub in that case.
  it("returns true from env LICENSE_KEY when initLicensing never ran", () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    expect(isProLicensed()).toBe(true);
  });

  it("returns false for blank env LICENSE_KEY when initLicensing never ran", () => {
    vi.stubEnv("LICENSE_KEY", "   ");
    expect(isProLicensed()).toBe(false);
  });

  it("ignores env LICENSE_KEY once initLicensing has run", async () => {
    vi.stubEnv("LICENSE_KEY", "valid-key");
    await initLicensing({
      env: env({ LICENSE_KEY: undefined }),
      fetchImpl: fetchRejecting(),
    });
    expect(isProLicensed()).toBe(false);
  });
});
