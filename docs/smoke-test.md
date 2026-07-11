# Manual smoke test

Run these steps against a real Dataverse environment before tagging a release.
Nothing here is automated — CI covers build + unit tests; this covers "does the
packed artifact actually work over stdio".

## 1. Build and pack

```bash
npm run build
npm pack
```

`npm pack` produces `simplesmoothsafe-dataverse-ops-mcp-0.1.0.tgz` in the repo
root (scoped name flattened, current version). Sanity-check the file list it
prints: only `dist/*`, `README.md`, `LICENSE`, `package.json`.

## 2. Run the packed tarball directly

```bash
export DATAVERSE_URL=https://yourorg.crm.dynamics.com
export CLIENT_ID=...        # optional trio; omit all three to use
export CLIENT_SECRET=...    # DefaultAzureCredential (e.g. az login)
export TENANT_ID=...

npx --yes ./simplesmoothsafe-dataverse-ops-mcp-0.1.0.tgz
```

The server starts and waits silently on stdin (stdio transport — no port, no
output until a request arrives). Ctrl+C to exit.

## 3. Raw stdio JSON-RPC check

Pipe an `initialize` handshake plus a `tools/list` request straight into the
binary:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx --yes ./simplesmoothsafe-dataverse-ops-mcp-0.1.0.tgz
```

Expected: the `id: 2` response lists exactly **seven** tools — `ping`,
`get_plugin_traces`, `get_failed_async_jobs`, `check_step_config`,
`explain_trace`, `explain_import_failure`, `analyze_plugin_performance`.

## 4. Alternative: MCP Inspector

For an interactive check with a UI:

```bash
npx @modelcontextprotocol/inspector npx -y ./simplesmoothsafe-dataverse-ops-mcp-0.1.0.tgz
```

(Env vars from step 2 must be exported in the same shell, or set them in the
Inspector's environment panel.)

## 5. Before tagging

In the Inspector (or via your MCP host), verify against the real environment:

1. `ping` returns `{ "ok": true }`.
2. `get_plugin_traces` with default inputs returns structured results (or a
   clean "no traces" result / specific hint — never a raw exception).

Only tag `v0.1.0` once both pass.
