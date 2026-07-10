// Licensing gate for free vs pro tools. LICENSE_KEY is validated against the
// remote license service once at server start (initLicensing); the result is
// held in memory and mirrored to an on-disk cache that grants a 7-day offline
// grace window. Licensing must never crash the server or block free tools:
// every failure path degrades to the free tier. The raw license key is never
// logged and never written to disk — the cache stores only its SHA-256 hash.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PRODUCT_ID = "dvops";
// Placeholder domain — the owner points this at the deployed license worker.
const DEFAULT_VALIDATE_URL =
  "https://licensing-worker.duarte-clemente.workers.dev/v1/validate";
// Docs-site pricing anchor — the owner fills in the final domain.
const CHECKOUT_URL = "https://dvops-docs.pages.dev/#pricing";
const PRO_DOCS_URL = "https://github.com/sss-dclemente/dataverse-mcp-pro#pro";

const CACHE_FILE_NAME = "license-cache.json";
// Offline grace: a cached positive validation is honored for 7 days.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VALIDATE_TIMEOUT_MS = 10_000;

export interface LicenseState {
  licensed: boolean;
  tier: string | null;
  source: "remote" | "cache" | "none";
}

let state: LicenseState = { licensed: false, tier: null, source: "none" };
let initHasRun = false;

interface CacheEntry {
  keyHash: string;
  orgId: string;
  valid: boolean;
  tier: string | null;
  expiresAt: string | null;
  fetchedAt: number;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function cacheFilePath(env: Record<string, string | undefined>): string {
  const dir = (env["DVOPS_CACHE_DIR"] ?? "").trim() || join(homedir(), ".dvops");
  return join(dir, CACHE_FILE_NAME);
}

function readCache(path: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheEntry>;
    if (
      typeof parsed.keyHash !== "string" ||
      typeof parsed.valid !== "boolean" ||
      typeof parsed.fetchedAt !== "number"
    ) {
      return null;
    }
    return {
      keyHash: parsed.keyHash,
      orgId: typeof parsed.orgId === "string" ? parsed.orgId : "",
      valid: parsed.valid,
      tier: typeof parsed.tier === "string" ? parsed.tier : null,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return null;
  }
}

function writeCache(path: string, entry: CacheEntry): void {
  // Best-effort: a read-only home directory must not break licensing.
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function deleteCacheIfKeyMatches(path: string, keyHash: string): void {
  try {
    const cached = readCache(path);
    if (cached !== null && cached.keyHash === keyHash) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export async function initLicensing(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<LicenseState> {
  const env = opts?.env ?? process.env;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const now = opts?.now ?? Date.now;
  initHasRun = true;
  state = { licensed: false, tier: null, source: "none" };

  try {
    const key = (env["LICENSE_KEY"] ?? "").trim();
    if (key === "") {
      console.error("dataverse-ops-mcp: no license key — free tier");
      return state;
    }

    const keyHash = sha256Hex(key);
    // Only a hash of the org URL is ever sent — never the URL itself.
    const orgId = sha256Hex((env["DATAVERSE_URL"] ?? "").trim().toLowerCase());
    const validateUrl =
      (env["DVOPS_LICENSE_URL"] ?? "").trim() || DEFAULT_VALIDATE_URL;
    const cachePath = cacheFilePath(env);

    let res: Response | undefined;
    try {
      res = await fetchImpl(validateUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ licenseKey: key, productId: PRODUCT_ID, orgId }),
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      });
    } catch {
      res = undefined; // network error or timeout → offline grace below
    }

    if (res !== undefined && res.ok) {
      const body = (await res.json()) as {
        valid?: unknown;
        tier?: unknown;
        expiresAt?: unknown;
      };
      if (body.valid === true) {
        const tier = typeof body.tier === "string" ? body.tier : null;
        const expiresAt =
          typeof body.expiresAt === "string" ? body.expiresAt : null;
        state = { licensed: true, tier, source: "remote" };
        writeCache(cachePath, {
          keyHash,
          orgId,
          valid: true,
          tier,
          expiresAt,
          fetchedAt: now(),
        });
        console.error(
          `dataverse-ops-mcp: license valid (${tier ?? "pro"}, remote)`,
        );
      } else {
        // Explicit rejection never falls back to the cache.
        deleteCacheIfKeyMatches(cachePath, keyHash);
        console.error(
          "dataverse-ops-mcp: license key rejected by license service — free tier",
        );
      }
      return state;
    }

    if (res !== undefined && res.status < 500) {
      // Definitive 4xx answer from the service: no offline grace.
      console.error(
        `dataverse-ops-mcp: license validation failed (HTTP ${res.status}) — free tier`,
      );
      return state;
    }

    // Network error, timeout or 5xx → honor a fresh cached validation for the
    // same key (7-day offline grace).
    const cached = readCache(cachePath);
    if (
      cached !== null &&
      cached.keyHash === keyHash &&
      cached.valid === true &&
      now() - cached.fetchedAt <= CACHE_TTL_MS
    ) {
      state = { licensed: true, tier: cached.tier, source: "cache" };
      const graceEnd = new Date(cached.fetchedAt + CACHE_TTL_MS).toISOString();
      console.error(
        `dataverse-ops-mcp: license service unreachable — using cached validation (expires ${graceEnd})`,
      );
    } else {
      console.error(
        "dataverse-ops-mcp: license service unreachable and no usable cached validation — free tier",
      );
    }
    return state;
  } catch {
    // Licensing must never throw out of init — degrade to the free tier.
    state = { licensed: false, tier: null, source: "none" };
    console.error(
      "dataverse-ops-mcp: license validation failed unexpectedly — free tier",
    );
    return state;
  }
}

export function isProLicensed(): boolean {
  // Legacy escape hatch: preserves the pre-0.2.0 stub behavior for tool unit
  // tests that stub LICENSE_KEY in the env without booting the server. The
  // server always calls initLicensing, so this branch never runs in
  // production.
  if (!initHasRun && state.source === "none") {
    const key = process.env["LICENSE_KEY"];
    return typeof key === "string" && key.trim().length > 0;
  }
  return state.licensed;
}

export function proUpgradeMessage(toolName: string): {
  upgradeRequired: true;
  tool: string;
  message: string;
  docsUrl: string;
  checkoutUrl: string;
} {
  return {
    upgradeRequired: true,
    tool: toolName,
    message:
      `The tool "${toolName}" is part of the Pro tier. ` +
      `Purchase a license on the pricing page (${CHECKOUT_URL}) and set the ` +
      "LICENSE_KEY environment variable to unlock it. " +
      `See ${PRO_DOCS_URL} for details.`,
    docsUrl: PRO_DOCS_URL,
    checkoutUrl: CHECKOUT_URL,
  };
}

// Test-only: resets module state so test suites can exercise initLicensing
// repeatedly within one process. Never call this from production code.
export function _resetLicensingForTests(): void {
  state = { licensed: false, tier: null, source: "none" };
  initHasRun = false;
}
