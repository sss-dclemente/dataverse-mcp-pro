import { describe, expect, it, vi } from "vitest";
import {
  configFromEnv,
  createDataverseClient,
  DataverseHttpError,
  type DataverseConfig,
} from "../src/dataverse/client.js";

const CONFIG: DataverseConfig = { url: "https://org.crm.dynamics.com" };
const tokenProvider = async () => "test-token";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

function asFetch(mock: ReturnType<typeof vi.fn>): FetchMock {
  return mock as unknown as FetchMock;
}

function firstCall(mock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return mock.mock.calls[0] as unknown as [string, RequestInit];
}

describe("configFromEnv", () => {
  it("reads all variables and returns a full config", () => {
    const config = configFromEnv({
      DATAVERSE_URL: "https://org.crm.dynamics.com",
      CLIENT_ID: "cid",
      CLIENT_SECRET: "csecret",
      TENANT_ID: "tid",
    });
    expect(config).toEqual({
      url: "https://org.crm.dynamics.com",
      clientId: "cid",
      clientSecret: "csecret",
      tenantId: "tid",
    });
  });

  it("throws a clear error naming DATAVERSE_URL when it is missing", () => {
    expect(() => configFromEnv({})).toThrowError(/DATAVERSE_URL/);
  });

  it("trims the trailing slash from the url", () => {
    const config = configFromEnv({ DATAVERSE_URL: "https://org.crm.dynamics.com/" });
    expect(config.url).toBe("https://org.crm.dynamics.com");
  });

  it("omits optional properties that are not set", () => {
    const config = configFromEnv({ DATAVERSE_URL: "https://org.crm.dynamics.com" });
    expect("clientId" in config).toBe(false);
    expect("clientSecret" in config).toBe(false);
    expect("tenantId" in config).toBe(false);
  });
});

describe("get", () => {
  it("builds the URL with $select/$filter/$top/$orderby and sends auth + OData headers", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);

    const result = await client.get<{ value: unknown[] }>("accounts", {
      select: ["name", "accountid"],
      filter: "statecode eq 0 and name eq 'A & B'",
      top: 5,
      orderby: "name asc",
    });

    expect(result).toEqual({ value: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = firstCall(fetchMock);
    const url = new URL(calledUrl);
    expect(url.origin).toBe("https://org.crm.dynamics.com");
    expect(url.pathname).toBe("/api/data/v9.2/accounts");
    expect(url.searchParams.get("$select")).toBe("name,accountid");
    expect(url.searchParams.get("$filter")).toBe("statecode eq 0 and name eq 'A & B'");
    expect(url.searchParams.get("$top")).toBe("5");
    expect(url.searchParams.get("$orderby")).toBe("name asc");
    // the raw query string must be URL-encoded (no literal spaces or ampersands in values)
    expect(url.search).not.toContain(" ");

    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["OData-MaxVersion"]).toBe("4.0");
    expect(headers["OData-Version"]).toBe("4.0");
  });

  it("sends no query string when no options are given", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);
    await client.get("WhoAmI");
    expect(firstCall(fetchMock)[0]).toBe(
      "https://org.crm.dynamics.com/api/data/v9.2/WhoAmI",
    );
  });

  it("retries on 429 honoring Retry-After and then succeeds", async () => {
    const throttled = () =>
      new Response("", { status: 429, headers: { "Retry-After": "0" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(jsonResponse({ value: [{ name: "ok" }] }));
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);

    const result = await client.get<{ value: Array<{ name: string }> }>("accounts");
    expect(result.value[0]?.name).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws DataverseHttpError after exhausting 429 retries", async () => {
    const fetchMock = vi.fn(
      async () => new Response("", { status: 429, headers: { "Retry-After": "0" } }),
    );
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);

    await expect(client.get("accounts")).rejects.toMatchObject({
      name: "DataverseHttpError",
      status: 429,
    });
    // 1 initial attempt + 3 retries
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws DataverseHttpError with the parsed OData message on 403", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: "0x80048306", message: "Principal user is missing prvReadPluginTraceLog privilege" } },
        403,
      ),
    );
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);

    const err = await client.get("plugintracelogs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataverseHttpError);
    const httpErr = err as DataverseHttpError;
    expect(httpErr.status).toBe(403);
    expect(httpErr.dataverseMessage).toBe(
      "Principal user is missing prvReadPluginTraceLog privilege",
    );
    expect(httpErr.message).toContain("403");
    expect(httpErr.message).toContain("prvReadPluginTraceLog");
  });
});

describe("batchGet", () => {
  const CRLF = "\r\n";
  const responseBoundary = "batchresponse_11111111-2222-3333-4444-555555555555";
  const multipartFixture =
    `--${responseBoundary}${CRLF}` +
    `Content-Type: application/http${CRLF}` +
    `Content-Transfer-Encoding: binary${CRLF}` +
    CRLF +
    `HTTP/1.1 200 OK${CRLF}` +
    `Content-Type: application/json; odata.metadata=minimal${CRLF}` +
    `OData-Version: 4.0${CRLF}` +
    CRLF +
    `{"@odata.context":"https://org.crm.dynamics.com/api/data/v9.2/$metadata#accounts","value":[{"name":"Contoso"}]}${CRLF}` +
    `--${responseBoundary}${CRLF}` +
    `Content-Type: application/http${CRLF}` +
    `Content-Transfer-Encoding: binary${CRLF}` +
    CRLF +
    `HTTP/1.1 204 No Content${CRLF}` +
    CRLF +
    `--${responseBoundary}--${CRLF}`;

  it("builds a multipart body with one GET part per path and parses the response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(multipartFixture, {
          status: 200,
          headers: {
            "Content-Type": `multipart/mixed; boundary="${responseBoundary}"`,
          },
        }),
    );
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);

    const results = await client.batchGet(["accounts?$top=1", "contacts(00000000-0000-0000-0000-000000000000)"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = firstCall(fetchMock);
    expect(calledUrl).toBe("https://org.crm.dynamics.com/api/data/v9.2/$batch");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    const contentType = headers["Content-Type"] ?? "";
    expect(contentType).toMatch(/^multipart\/mixed;boundary=batch_[0-9a-f-]{36}$/);
    const requestBoundary = contentType.split("boundary=")[1] as string;

    const body = init.body as string;
    expect(body).toContain(
      "GET https://org.crm.dynamics.com/api/data/v9.2/accounts?$top=1 HTTP/1.1",
    );
    expect(body).toContain(
      "GET https://org.crm.dynamics.com/api/data/v9.2/contacts(00000000-0000-0000-0000-000000000000) HTTP/1.1",
    );
    expect(body).toContain("Content-Type: application/http");
    expect(body).toContain("Content-Transfer-Encoding: binary");
    // one opening boundary per part plus one terminator
    expect(body.match(new RegExp(`--${requestBoundary}(?!--)`, "g"))?.length).toBe(2);
    expect(body).toContain(`--${requestBoundary}--`);

    expect(results).toEqual([
      {
        status: 200,
        body: {
          "@odata.context":
            "https://org.crm.dynamics.com/api/data/v9.2/$metadata#accounts",
          value: [{ name: "Contoso" }],
        },
      },
      { status: 204, body: undefined },
    ]);
  });

  it("retries $batch on 429 before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "0" } }),
      )
      .mockResolvedValueOnce(
        new Response(multipartFixture, {
          status: 200,
          headers: {
            "Content-Type": `multipart/mixed; boundary="${responseBoundary}"`,
          },
        }),
      );
    const client = createDataverseClient(CONFIG, asFetch(fetchMock), tokenProvider);

    const results = await client.batchGet(["accounts"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe(200);
  });
});
