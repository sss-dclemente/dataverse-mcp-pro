# Manual smoke test

Run these steps against a real Dataverse environment before tagging a release.
Nothing here is automated — CI covers build + unit tests; this covers "does the
packed artifact actually work over stdio".

## 1. Build and pack

```bash
npm run build
TARBALL=$(npm pack | tail -1)
echo "$TARBALL"
```

`npm pack` produces `simplesmoothsafe-dataverse-ops-mcp-<version>.tgz` in the
repo root (scoped name flattened, current version). Capturing it in `$TARBALL`
keeps the rest of this document correct across version bumps — every step below
uses the variable, so export it in each shell you run these steps from.

Sanity-check the file list `npm pack` prints: only `dist/*`, `README.md`,
`LICENSE`, `package.json`.

## 2. Run the packed tarball directly

```bash
export DATAVERSE_URL=https://yourorg.crm.dynamics.com
export CLIENT_ID=...        # optional trio; omit all three to use
export CLIENT_SECRET=...    # DefaultAzureCredential (e.g. az login)
export TENANT_ID=...

npx --yes "./$TARBALL"
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
  | npx --yes "./$TARBALL"
```

Expected: the `id: 2` response lists every tool registered in
`src/tools/index.ts`, each with a non-empty description, and `ping` among them.

Rather than checking against a number that goes stale on every new tool, compare
the response to the registry itself:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx --yes "./$TARBALL" \
  | node -e '
      let buf = "";
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => {
        const msg = buf
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .find((m) => m.id === 2);
        const names = msg.result.tools.map((t) => t.name);
        console.log(`${names.length} tools:`, names.join(", "));
      });
    '
```

Compare that count and list against the `tools` array in `src/tools/index.ts`.
They must match exactly — a tool that fails to register is the failure this step
exists to catch.

## 4. Alternative: MCP Inspector

For an interactive check with a UI:

```bash
npx @modelcontextprotocol/inspector npx -y "./$TARBALL"
```

(Env vars from step 2 must be exported in the same shell, or set them in the
Inspector's environment panel.)

## 5. Before tagging

In the Inspector (or via your MCP host), verify against the real environment:

1. `ping` returns `{ "ok": true }`.
2. `get_plugin_traces` with default inputs returns structured results (or a
   clean "no traces" result / specific hint — never a raw exception).

Only tag the release (`v<version>`, matching `package.json`) once both pass.
