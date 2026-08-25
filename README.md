# dataverse-ops-mcp

**Open-source MCP server for Microsoft Dataverse & Power Automate diagnostics — plugin traces, async jobs, flow runs, governance and documentation, right inside your AI assistant. MIT-licensed, every tool free.**

Diagnosing production problems in Dataverse / Dynamics 365 usually means firing up XrmToolBox, exporting plugin trace logs, and spelunking through raw exception blocks and `importexportxml` documents by hand: plugin failures buried in thousands of trace rows, async job graveyards in the admin center, cryptic solution import errors, Power Automate flows that fail silently, and performance mysteries with no obvious culprit — each in its own tool. This MCP server puts those diagnostics directly inside your AI assistant. Instead of raw Dataverse payloads, every tool returns structured, LLM-optimized JSON — trimmed, grouped, and annotated — so the assistant can reason about *why* something failed, not just show you that it did.

It runs over stdio inside Claude Desktop, Claude Code, Grok, or any MCP host. There is no middleman: this process talks to the org Web API (v9.2) and Entra ID only. A cloud MCP host still sends tool JSON (including tool results) to the model vendor. All 20 tools are free and the source is MIT-licensed; contributions and issues are welcome.

## What you can ask it

The server turns Dataverse's diagnostic tables into questions you can ask in plain
language. A few things it answers end to end:

**When something just broke**

- *"The Order Sync plug-in threw this morning — what happened?"* → `explain_trace` correlates
  the failing execution with its step registration, sibling traces in the same correlation, and
  a parsed exception (SQL timeout, deadlock, depth loop, missing privilege, custom throw).
- *"Why did last night's solution import fail?"* → `explain_import_failure` names each failed
  component, translates the error code into plain language, and orders the missing dependencies
  so you know what to install first.
- *"Which flow runs failed in the last 24 hours, and why?"* → `get_flow_runs` plus
  `explain_flow_failure` for the failed-action guess and known patterns (expired connections,
  throttling, timeouts).

**When something is slow or looping**

- *"Which plug-ins are slowing down saves on account?"* → `analyze_plugin_performance` returns a
  p50/p95 table split by sync vs async and flags slow sync steps, deep cascades and N+1 firing.
- *"Is anything looping?"* → `detect_automation_loops` looks for trigger→write cycles between
  **cloud flows** (self-loops and 2–3 flow cycles), with filtering-attribute evidence. It is
  definition-based and cloud-flow only; plugin↔flow ping-pong is out of scope.
- *"Are jobs piling up?"* → `find_stuck_jobs` for the waiting/in-progress backlog,
  `get_failed_async_jobs` for what already died.

**When you're taking over someone else's org**

- *"What actually runs when a case is created?"* → `what_runs_on_table` is the headline tool:
  plug-in steps, cloud flows (trigger vs action), classic workflows and business rules for one
  table, in a single view. Cloud-flow definitions are scanned with a cap of 500.
- *"Document this table / this flow for the handover."* → `document_table` and `document_flow`
  return structured JSON *and* ready-to-share markdown.
- *"What legacy automation is still in here?"* → `modernization_report` inventories active
  dialogs, classic workflows and business rules with migration priorities.
- *"Who owns these flows, and are any of them orphaned?"* → `flow_governance_report` and
  `check_flow_connections` surface flows owned by disabled users, suspended flows, stale drafts
  and unbound connection references.

Every tool returns trimmed, structured JSON — never raw Dataverse payloads — so the assistant can
reason about *why* something failed instead of drowning in the response. Known failure modes
(missing privilege, feature disabled in the org, empty result) come back as a specific hint
rather than a bare error.

Everything is **read-only**: the Dataverse client exposes only reads (`GET`, and `$batch`
batches whose sub-requests are all `GET`), so there is no code path that creates, updates or
deletes anything in your org.

## How this relates to Microsoft's Dataverse MCP server

Microsoft ships an [official Dataverse MCP server](https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-mcp)
for working with *data*: querying rows, creating and updating records, inspecting table metadata.
This project is the *diagnostics* counterpart — plug-in traces, async job triage, flow run
history, solution layering, and a per-table view of plug-in steps, cloud flows, classic workflows
and business rules. The two are complementary, and running both is a reasonable setup.

## 5-minute quickstart

**Run from source.** That is the real path today.

`npx @simplesmoothsafe/dataverse-ops-mcp` does **not** resolve until the first `v*` git tag
exists (and the package is published). Do not use `npx`.

### Prerequisites

- **Node 20+** (`node --version`)
- A way to authenticate against your Dataverse org — either:
  - a **Dataverse app registration** (application user) with client ID, client secret and tenant ID, or
  - an **Azure CLI login** (`az login`) with access to the org — used automatically via `DefaultAzureCredential` when no client secret is configured.

### Run from source

```bash
git clone https://github.com/sss-dclemente/dataverse-mcp-pro.git
cd dataverse-mcp-pro
npm install
npm run build
```

Then point your MCP host at the built entry point. `npm run dev` runs the same server straight
from TypeScript via tsx, which is handy while developing. See [docs/smoke-test.md](docs/smoke-test.md)
for a short live-org checklist (CI does not talk to a live org).

### Claude Desktop

Add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dataverse-ops": {
      "command": "node",
      "args": ["/absolute/path/to/dataverse-mcp-pro/dist/server.js"],
      "env": {
        "DATAVERSE_URL": "https://yourorg.crm.dynamics.com",
        "CLIENT_ID": "...",
        "CLIENT_SECRET": "...",
        "TENANT_ID": "..."
      }
    }
  }
}
```

Restart Claude Desktop and ask it to run `ping` to confirm the connection.

### Claude Code

```bash
claude mcp add dataverse-ops \
  --env DATAVERSE_URL=https://yourorg.crm.dynamics.com \
  --env CLIENT_ID=... \
  --env CLIENT_SECRET=... \
  --env TENANT_ID=... \
  -- node /absolute/path/to/dataverse-mcp-pro/dist/server.js
```

Or declare it in a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "dataverse-ops": {
      "command": "node",
      "args": ["/absolute/path/to/dataverse-mcp-pro/dist/server.js"],
      "env": {
        "DATAVERSE_URL": "https://yourorg.crm.dynamics.com",
        "CLIENT_ID": "...",
        "CLIENT_SECRET": "...",
        "TENANT_ID": "..."
      }
    }
  }
}
```

### Grok

Grok's CLI takes stdio MCP servers with `grok mcp add` — everything after `--` is the launch
command:

```bash
grok mcp add dataverse-ops -- node /absolute/path/to/dataverse-mcp-pro/dist/server.js
```

Credentials go in `~/.grok/config.toml`, where `env` entries support `${VAR}` expansion so you
need not commit secrets:

```toml
[mcp_servers.dataverse-ops]
command = "node"
args = ["/absolute/path/to/dataverse-mcp-pro/dist/server.js"]
env = { DATAVERSE_URL = "https://yourorg.crm.dynamics.com", CLIENT_ID = "${DV_CLIENT_ID}", CLIENT_SECRET = "${DV_CLIENT_SECRET}", TENANT_ID = "${DV_TENANT_ID}" }
startup_timeout_sec = 60
```

Grok namespaces tools by server, so they appear as `dataverse-ops__get_plugin_traces`,
`dataverse-ops__explain_trace`, and so on. `grok mcp list` shows what is configured, and
`grok mcp doctor dataverse-ops` diagnoses a server that starts but fails to connect (its stderr
is captured to `~/.grok/logs/mcp/dataverse-ops.stderr.log`). Use `.grok/config.toml` with
`grok mcp add --scope project` to scope the server to one repository.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `DATAVERSE_URL` | Yes | Your org URL, e.g. `https://yourorg.crm.dynamics.com`. |
| `CLIENT_ID` | No | App registration client ID. Set together with `CLIENT_SECRET` and `TENANT_ID` for client-credentials auth. |
| `CLIENT_SECRET` | No | App registration client secret (part of the client-credentials trio). |
| `TENANT_ID` | No | Entra ID tenant ID (part of the client-credentials trio). |

When the `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` trio is absent, the server falls back to [`DefaultAzureCredential`](https://learn.microsoft.com/azure/developer/javascript/sdk/credential-chains) — so a plain `az login` (or managed identity, VS Code sign-in, etc.) works too.

## Tools

All 20 tools are free and read-only. Each links to its own doc page with the full input table,
an example call, example output, and the errors it knows how to explain.

### Plug-in and job diagnostics

| Tool | What it does |
| --- | --- |
| [`get_org_automation_settings`](docs/tools/get_org_automation_settings.md) | Org-level switches the other tools depend on: plug-in trace logging level and auditing configuration, with actionable hints. |
| [`get_plugin_traces`](docs/tools/get_plugin_traces.md) | Recent plug-in trace logs, defaulting to executions that threw an exception, with trimmed one-line summaries and excerpts. |
| [`get_failed_async_jobs`](docs/tools/get_failed_async_jobs.md) | Failed/canceled async jobs over a time window, grouped by job name + error code so recurring failures stand out. |
| [`find_stuck_jobs`](docs/tools/find_stuck_jobs.md) | Async jobs stuck in waiting/in-progress beyond a threshold — the backlog complement to `get_failed_async_jobs` (postponed jobs excluded). |
| [`check_step_config`](docs/tools/check_step_config.md) | Lints plug-in step registrations for misconfigurations: missing filtering attributes, sync steps on high-volume entities, rank collisions. |
| [`explain_trace`](docs/tools/explain_trace.md) | Root-cause analysis of one failing plug-in execution: correlates the step registration, sibling traces and parsed exception. |
| [`explain_import_failure`](docs/tools/explain_import_failure.md) | Explains a failed solution import: each failed component with a plain-language cause and missing-dependency resolution. |
| [`analyze_plugin_performance`](docs/tools/analyze_plugin_performance.md) | Per-plugin performance table (p50/p95, sync vs async, depth) plus anti-pattern flags: slow sync steps, deep cascades, N+1 firing. |

### Power Automate flow diagnostics

| Tool | What it does |
| --- | --- |
| [`get_flow_runs`](docs/tools/get_flow_runs.md) | Filtered Power Automate cloud-flow run history (by flow, status, time window) from the Dataverse `flowrun` table. |
| [`document_flow`](docs/tools/document_flow.md) | Structured documentation for a cloud flow from its definition: triggers, action tree, connectors, plus ready-to-share markdown. |
| [`analyze_flow_runs`](docs/tools/analyze_flow_runs.md) | Per-flow reliability report: success rates, duration percentiles, error clusters, and flags for failure streaks and slow flows. |
| [`explain_flow_failure`](docs/tools/explain_flow_failure.md) | Root-cause analysis of a failed flow run: failed-action guess, definition context, and known-pattern detection (expired connections, throttling, timeouts). |
| [`check_flow_connections`](docs/tools/check_flow_connections.md) | Connection-reference health audit: unbound references, disabled owners, owner mismatches, unused references — with affected flows. |
| [`flow_governance_report`](docs/tools/flow_governance_report.md) | Flow inventory by state and owner: flows owned by disabled users, suspended flows, stale drafts, owner concentration. |

### Governance, documentation and table automation

| Tool | What it does |
| --- | --- |
| [`what_runs_on_table`](docs/tools/what_runs_on_table.md) | Plug-in steps, cloud flows (trigger vs action), classic workflows and business rules registered on one table — in one view. Cloud-flow scan cap 500. |
| [`detect_automation_loops`](docs/tools/detect_automation_loops.md) | Suspected trigger→write cycles between cloud flows (self-loops and 2–3 flow cycles), with filtering-attribute evidence. Definition-based cloud-flow only. |
| [`document_table`](docs/tools/document_table.md) | Table documentation from metadata: columns, relationships, keys and attached automation, plus ready-to-share markdown. |
| [`get_solution_layers`](docs/tools/get_solution_layers.md) | Solution layering for one component — who overwrote it, and whether an unmanaged Active layer is sitting on top and blocking solution updates. |
| [`modernization_report`](docs/tools/modernization_report.md) | Legacy automation inventory: active dialogs, classic workflows (sync/async), business rules footprint — with migration priorities. |

### Connectivity

| Tool | What it does |
| --- | --- |
| `ping` | Health check — returns `{ ok: true }` without contacting Dataverse. Use it to confirm the host has spawned the server before debugging auth. |

The flow tools complement Microsoft's [power-platform-skills](https://github.com/microsoft/power-platform-skills) FlowAgent plugin: FlowAgent builds and debugs flows interactively, while these tools add read-only diagnostics, reporting and documentation alongside the plug-in and Dataverse tools above.

## Limits

These caps are in the code today:

| Cap | Where | What it means |
| --- | --- | --- |
| `flowrun` elastic page 500 | Dataverse `flowrun` table | Elastic tables serve at most 500 rows per page. `get_flow_runs` stays inside this (`top` max 100). |
| `analyze_flow_runs` truncated at 500 | `analyze_flow_runs` | Single page of newest runs; when the cap is hit the payload includes `truncated: true`. |
| `detect_automation_loops` | cloud-flow definitions only | Definition-based analysis of activated cloud flows. Plugin↔flow ping-pong is out of scope — use `analyze_plugin_performance` depth flags and `what_runs_on_table` for the plug-in side. Default scan 500 (`maxFlows` 10–1000; `truncated` when hit). |
| `what_runs_on_table` cloud-flow scan cap 500 | `what_runs_on_table` | Activated cloud-flow definitions are scanned client-side; `flowsScanTruncated: true` when the cap is hit. |

## Security & privacy

- **stdio only.** The server is spawned by your MCP host and communicates over stdin/stdout — it opens no ports and runs no network server.
- **No middleman.** This process talks to the org Web API and Entra ID only. A cloud MCP host still sends tool JSON (including tool results) to the model vendor.
- **Minimal outbound surface.** The only outbound calls this process makes are to your Dataverse org (Web API) and Microsoft Entra ID (token acquisition).
- **No telemetry.** The server makes no analytics, licensing or telemetry calls of any kind.
- Tokens and secrets are held in memory only and are never logged.

## Contributing

Issues and pull requests are welcome. The whole tool set is free and MIT-licensed — new diagnostics, better failure-mode hints, and fixes for real-world Dataverse quirks are all fair game. Each tool is a single file under `src/tools/` with fixture-based tests under `tests/` and a doc page under `docs/tools/`; see [CLAUDE.md](CLAUDE.md) for the conventions.

## License

[MIT](LICENSE) © 2026 SimpleSmoothSafe. Use it, fork it, ship it.
