# Live smoke checklist

CI is fixture-based (`vitest` against recorded payloads under `tests/fixtures/`).
It does **not** talk to a Dataverse org. A green CI run is not live-org validation.

Run this against a real org **after merge**, before any `v*` tag. Use the
run-from-source path:

```bash
git clone https://github.com/sss-dclemente/dataverse-mcp-pro.git
cd dataverse-mcp-pro
npm install
npm run build
```

Point the MCP host at `dist/server.js` (see the README). `npx @simplesmoothsafe/dataverse-ops-mcp`
does **not** resolve until the first `v*` git tag exists — do not use `npx`.

1. `ping` → `{ "ok": true }` (no Dataverse call).
2. `get_plugin_traces` with defaults → structured results, an empty-with-hint payload, or a specific privilege/feature envelope — never a raw exception.
3. `get_flow_runs` with defaults → same shape. `flowrun` is an elastic table (Dataverse page cap 500); this tool's `top` max is 100.
4. `what_runs_on_table` on a table you know (e.g. `account`) → plug-in / cloud-flow / classic-workflow / business-rule sections. Cloud-flow scan cap 500 (`flowsScanTruncated` when hit).
5. Optional: `analyze_flow_runs` — if the window has 500 runs, expect `truncated: true`. `detect_automation_loops` is definition-based **cloud-flow only**; plugin↔flow ping-pong is out of scope.

Do not tag and do not `npm publish` from the honesty PR. Live smoke is a human step after merge.

## Before tagging: verify the packed artifact

This checklist covers behaviour against a real org. It does not check what
`npm pack` actually produces, and the release workflow publishes on any `v*`
tag, so run this too:

```bash
npm run verify:package
```

It packs the tarball, checks the file list and `bin` entry, unpacks it, boots
the packed server over stdio and compares the tools it exposes against
`src/tools/index.ts`. No Dataverse org or credentials needed — the client is
built lazily, so `tools/list` answers without any environment set. It exits
non-zero and names the failing check, and `release.yml` runs it before
`npm publish`, so a broken artifact cannot reach the registry.
