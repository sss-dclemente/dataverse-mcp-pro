# dataverse-ops-mcp

TypeScript MCP server for Microsoft Dataverse diagnostics. Distributed as an npm
package, runs over **stdio** inside the user's MCP host (Claude Desktop, Claude
Code, etc.). All Dataverse data stays on the user's machine/tenant.

## Runtime & toolchain

- Node **20+**, TypeScript **strict**, **ESM only** (`"type": "module"`, NodeNext resolution).
- MCP SDK: `@modelcontextprotocol/sdk` with the stdio transport.
- Dataverse **Web API v9.2** called via native `fetch`. No heavy SDK dependencies.
- Runtime deps: MCP SDK + `zod` only, plus `@azure/identity` (lazy-imported, needed
  for the DefaultAzureCredential fallback). Do not add others without strong reason.
- Tests: `vitest`. Mock Dataverse responses with fixtures under `tests/fixtures/`.

## Authentication

User-supplied connection, two modes, resolved in `src/dataverse/client.ts`:

1. Client credentials from env: `DATAVERSE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`.
2. Fallback: `DefaultAzureCredential` (`@azure/identity`, dynamic import) when the
   secret vars are absent — `DATAVERSE_URL` is always required.

Tokens are cached in memory until near expiry. Requests retry on 429 honoring
`Retry-After`. **Never** log tokens or secrets.

## Privacy

Data NEVER leaves the user's machine/tenant. No telemetry, ever — do not add
analytics or any outbound call besides Dataverse and Entra ID. The project is
MIT-licensed and every tool is free; there is no licensing gate — do not
reintroduce one.

## Architecture

- `src/server.ts` — stdio bootstrap; registers every tool from `src/tools/index.ts`.
- `src/tools/<toolName>.ts` — **one file per tool**, exporting
  `{ name, description, inputSchema (zod), handler }`.
- `src/dataverse/client.ts` — thin Web API client (auth, retry, `$select`/`$filter`/`$top`, batch GET).
- `src/errors.ts` — error envelope `{ error, hint, docsUrl }`. Handlers return this
  shape on failure; never let raw exceptions escape to the host.

## Tool conventions

- Every tool returns **structured JSON**, never raw Dataverse payloads. Map/trim
  fields explicitly; truncate long text (e.g. exception details) into dedicated
  excerpt fields.
- Validate input with zod; apply defaults and max bounds in the schema.
- Known failure modes (403 missing privilege, feature disabled in org, empty
  results) get a specific `hint` + `docsUrl`, not a generic error.

## Style

- Minimal, YAGNI. No speculative abstractions, no plugin systems, no config
  files beyond env vars. Prefer plain functions over classes.
- Small modules; if a helper is used by one tool, it lives in that tool's file.
- Comments only for non-obvious constraints (API quirks, OData escaping, etc.).

## tsconfig guidance

Keep `tsconfig.json` aligned with:

- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`.
- `"strict": true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- `"outDir": "dist"`, declarations on. Only `src/` is compiled; tests are
  type-checked by vitest, not shipped.
- ESM means local imports use explicit `.js` extensions in source.

## Commands

- `npm run build` — tsc to `dist/`.
- `npm test` — vitest run.
- `npm run dev` — run the server from source with tsx.

## Definition of done — for every tool

1. Input schema in zod with defaults + bounds, exercised by at least one test.
2. Fixture-based tests under `tests/` covering happy path and the tool's known
   failure modes (fixtures in `tests/fixtures/`).
3. Doc page stub at `docs/tools/<tool_name>.md` (inputs table, example call,
   example output, common errors).
4. Registered in `src/tools/index.ts`; `npm run build` and `npm test` green.
