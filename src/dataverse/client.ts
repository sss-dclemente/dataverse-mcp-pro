// Thin Dataverse Web API v9.2 client: auth (client credentials or
// DefaultAzureCredential fallback), token caching, 429/503 retry, OData query
// building and $batch GET support. Never log tokens or secrets.

export interface DataverseConfig {
  url: string;
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
}

export interface QueryOptions {
  select?: string[];
  filter?: string;
  top?: number;
  orderby?: string;
  expand?: string;
}

export class DataverseHttpError extends Error {
  readonly status: number;
  readonly dataverseMessage?: string;

  constructor(status: number, dataverseMessage?: string) {
    super(
      dataverseMessage === undefined
        ? `Dataverse request failed (HTTP ${status})`
        : `Dataverse request failed (HTTP ${status}): ${dataverseMessage}`,
    );
    this.name = "DataverseHttpError";
    this.status = status;
    if (dataverseMessage !== undefined) {
      this.dataverseMessage = dataverseMessage;
    }
  }
}

export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): DataverseConfig {
  const rawUrl = env["DATAVERSE_URL"];
  if (rawUrl === undefined || rawUrl.trim() === "") {
    throw new Error(
      "Missing required environment variable DATAVERSE_URL (e.g. https://yourorg.crm.dynamics.com)",
    );
  }
  const config: DataverseConfig = { url: rawUrl.trim().replace(/\/+$/, "") };
  const clientId = env["CLIENT_ID"];
  const clientSecret = env["CLIENT_SECRET"];
  const tenantId = env["TENANT_ID"];
  if (clientId !== undefined) config.clientId = clientId;
  if (clientSecret !== undefined) config.clientSecret = clientSecret;
  if (tenantId !== undefined) config.tenantId = tenantId;
  return config;
}

const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_429_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 2;
const MAX_RETRY_AFTER_S = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get("Retry-After");
  const seconds = header === null ? Number.NaN : Number(header);
  const effective =
    Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_S;
  return Math.min(effective, MAX_RETRY_AFTER_S) * 1000;
}

async function acquireClientCredentialsToken(
  config: DataverseConfig,
  fetchImpl: typeof fetch,
): Promise<{ token: string; expiresAtMs: number }> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId ?? "",
    client_secret: config.clientSecret ?? "",
    scope: `${config.url}/.default`,
  });
  const res = await fetchImpl(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    // Deliberately not including the response body: it can echo request details.
    throw new Error(`Token request to Entra ID failed (HTTP ${res.status})`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (typeof json.access_token !== "string") {
    throw new Error("Token response from Entra ID did not contain access_token");
  }
  const expiresInS = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return { token: json.access_token, expiresAtMs: Date.now() + expiresInS * 1000 };
}

async function acquireDefaultCredentialToken(
  config: DataverseConfig,
): Promise<{ token: string; expiresAtMs: number }> {
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential();
  const result = await credential.getToken(`${config.url}/.default`);
  if (!result) {
    throw new Error("DefaultAzureCredential did not return a token");
  }
  return { token: result.token, expiresAtMs: result.expiresOnTimestamp };
}

function createTokenProvider(
  config: DataverseConfig,
  fetchImpl: typeof fetch,
): () => Promise<string> {
  let cached: { token: string; expiresAtMs: number } | undefined;
  return async () => {
    if (cached !== undefined && Date.now() < cached.expiresAtMs - TOKEN_EXPIRY_SKEW_MS) {
      return cached.token;
    }
    cached =
      config.clientId !== undefined &&
      config.clientSecret !== undefined &&
      config.tenantId !== undefined
        ? await acquireClientCredentialsToken(config, fetchImpl)
        : await acquireDefaultCredentialToken(config);
    return cached.token;
  };
}

async function fetchWithRetry(send: () => Promise<Response>): Promise<Response> {
  let retries429 = 0;
  let retried503 = false;
  for (;;) {
    const res = await send();
    if (res.status === 429 && retries429 < MAX_429_RETRIES) {
      retries429 += 1;
      await sleep(retryAfterMs(res));
      continue;
    }
    if (res.status === 503 && !retried503) {
      retried503 = true;
      await sleep(retryAfterMs(res));
      continue;
    }
    return res;
  }
}

async function toHttpError(res: Response): Promise<DataverseHttpError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // ignore unreadable bodies
  }
  let message: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (typeof parsed?.error?.message === "string") {
      message = parsed.error.message;
    }
  } catch {
    // not JSON — fall through to raw text
  }
  if (message === undefined && text.trim() !== "") {
    message = text.slice(0, 500);
  }
  return new DataverseHttpError(res.status, message);
}

/** OData string literals escape embedded single quotes by doubling them. */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export type DataverseClient = ReturnType<typeof createDataverseClient>;

let defaultClient: DataverseClient | undefined;

/** Process-wide client built from env vars, created on first use so tools can
 * be imported (and unit-tested with a fake client) without any env present. */
export function getDefaultClient(): DataverseClient {
  defaultClient ??= createDataverseClient(configFromEnv());
  return defaultClient;
}

export function createDataverseClient(
  config: DataverseConfig,
  fetchImpl: typeof fetch = fetch,
  tokenProvider?: () => Promise<string>,
) {
  const getToken = tokenProvider ?? createTokenProvider(config, fetchImpl);
  const apiBase = `${config.url}/api/data/v9.2`;

  const absoluteUrl = (entitySetOrPath: string): string =>
    /^https?:\/\//i.test(entitySetOrPath)
      ? entitySetOrPath
      : `${apiBase}/${entitySetOrPath.replace(/^\//, "")}`;

  function buildUrl(entitySetOrPath: string, options?: QueryOptions): string {
    const params = new URLSearchParams();
    if (options?.select !== undefined && options.select.length > 0) {
      params.set("$select", options.select.join(","));
    }
    if (options?.filter !== undefined) params.set("$filter", options.filter);
    if (options?.top !== undefined) params.set("$top", String(options.top));
    if (options?.orderby !== undefined) params.set("$orderby", options.orderby);
    if (options?.expand !== undefined) params.set("$expand", options.expand);
    const qs = params.toString();
    const base = absoluteUrl(entitySetOrPath);
    return qs === "" ? base : `${base}?${qs}`;
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await getToken();
    return {
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Authorization: `Bearer ${token}`,
    };
  }

  async function get<T>(entitySetOrPath: string, options?: QueryOptions): Promise<T> {
    const url = buildUrl(entitySetOrPath, options);
    const headers = await authHeaders();
    const res = await fetchWithRetry(() => fetchImpl(url, { method: "GET", headers }));
    if (!res.ok) throw await toHttpError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function batchGet(
    paths: string[],
  ): Promise<Array<{ status: number; body: unknown }>> {
    const boundary = `batch_${crypto.randomUUID()}`;
    const CRLF = "\r\n";
    const body =
      paths
        .map(
          (path) =>
            `--${boundary}${CRLF}` +
            `Content-Type: application/http${CRLF}` +
            `Content-Transfer-Encoding: binary${CRLF}` +
            CRLF +
            `GET ${absoluteUrl(path)} HTTP/1.1${CRLF}` +
            `Accept: application/json${CRLF}` +
            CRLF,
        )
        .join("") + `--${boundary}--${CRLF}`;

    const headers = {
      ...(await authHeaders()),
      "Content-Type": `multipart/mixed;boundary=${boundary}`,
    };
    const res = await fetchWithRetry(() =>
      fetchImpl(`${apiBase}/$batch`, { method: "POST", headers, body }),
    );
    if (!res.ok) throw await toHttpError(res);

    const contentType = res.headers.get("Content-Type") ?? "";
    const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
    const responseBoundary = boundaryMatch?.[1];
    if (responseBoundary === undefined) {
      throw new Error("Dataverse $batch response missing multipart boundary");
    }

    const text = await res.text();
    const chunks = text.split(`--${responseBoundary}`);
    chunks.shift(); // preamble before first boundary
    const results: Array<{ status: number; body: unknown }> = [];
    for (const chunk of chunks) {
      const trimmed = chunk.trimStart();
      if (trimmed === "" || trimmed.startsWith("--")) continue; // terminator
      const statusMatch = chunk.match(/HTTP\/1\.1 (\d{3})/);
      const statusCode = statusMatch?.[1];
      if (statusCode === undefined) {
        throw new Error("Malformed $batch response part: missing HTTP status line");
      }
      const statusLineIdx = chunk.indexOf("HTTP/1.1");
      const headerEnd = chunk.indexOf("\r\n\r\n", statusLineIdx);
      const rawBody = headerEnd === -1 ? "" : chunk.slice(headerEnd + 4).trim();
      let parsedBody: unknown;
      if (rawBody !== "") {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }
      results.push({ status: Number(statusCode), body: parsedBody });
    }
    return results;
  }

  return { get, batchGet };
}
