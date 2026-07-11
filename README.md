# dataverse-ops-mcp

**Open-source MCP server for Microsoft Dataverse & Power Automate diagnostics — plugin traces, async jobs, flow runs, governance and documentation, right inside your AI assistant. MIT-licensed, every tool free.**

Diagnosing production problems in Dataverse / Dynamics 365 usually means firing up XrmToolBox, exporting plugin trace logs, and spelunking through raw exception blocks and `importexportxml` documents by hand: plugin failures buried in thousands of trace rows, async job graveyards in the admin center, cryptic solution import errors, Power Automate flows that fail silently, and performance mysteries with no obvious culprit — each in its own tool. This MCP server puts those diagnostics directly inside your AI assistant, and it does something no single tool does today: it reads the **whole automation graph** — plug-in steps, cloud flows, classic workflows and business rules — through one interface. Instead of raw Dataverse payloads, every tool returns structured, LLM-optimized JSON — trimmed, grouped, and annotated — so the assistant can reason about *why* something failed, not just show you that it did.

It runs locally over stdio inside Claude Desktop, Claude Code, or any MCP host, and talks only to your own Dataverse org via the Web API (v9.2) — no middleman service, no data leaving your machine or tenant. All 20 tools are free and the source is MIT-licensed; contributions and issues are welcome.

## 5-minute quickstart

### Prerequisites

- **Node 20+** (`node --version`)
- A way to authenticate against your Dataverse org — either:
  - a **Dataverse app registration** (application user) with client ID, client secret and tenant ID, or
  - an **Azure CLI login** (`az login`) with access to the org — used automatically via `DefaultAzureCredential` when no client secret is configured.

### Claude Desktop

Add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dataverse-ops": {
      "command": "npx",
      "args": ["-y", "@simplesmoothsafe/dataverse-ops-mcp"],
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
  -- npx -y @simplesmoothsafe/dataverse-ops-mcp
```

Or declare it in a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "dataverse-ops": {
      "command": "npx",
      "args": ["-y", "@simplesmoothsafe/dataverse-ops-mcp"],
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

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `DATAVERSE_URL` | Yes | Your org URL, e.g. `https://yourorg.crm.dynamics.com`. |
| `CLIENT_ID` | No | App registration client ID. Set together with `CLIENT_SECRET` and `TENANT_ID` for client-credentials auth. |
| `CLIENT_SECRET` | No | App registration client secret (part of the client-credentials trio). |
| `TENANT_ID` | No | Entra ID tenant ID (part of the client-credentials trio). |

When the `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` trio is absent, the server falls back to [`DefaultAzureCredential`](https://learn.microsoft.com/azure/developer/javascript/sdk/credential-chains) — so a plain `az login` (or managed identity, VS Code sign-in, etc.) works too.

## Tools

| Tool | What it does |
| --- | --- |
| `ping` | Health check — returns `{ ok: true }` without contacting Dataverse. |
| [`get_plugin_traces`](docs/tools/get_plugin_traces.md) | Recent plug-in trace logs, defaulting to executions that threw an exception, with trimmed one-line summaries and excerpts. |
| [`get_failed_async_jobs`](docs/tools/get_failed_async_jobs.md) | Failed/canceled async jobs over a time window, grouped by job name + error code so recurring failures stand out. |
| [`check_step_config`](docs/tools/check_step_config.md) | Lints plug-in step registrations for misconfigurations: missing filtering attributes, sync steps on high-volume entities, rank collisions. |
| [`explain_trace`](docs/tools/explain_trace.md) | Root-cause analysis of one failing plug-in execution: correlates the step registration, sibling traces and parsed exception. |
| [`explain_import_failure`](docs/tools/explain_import_failure.md) | Explains a failed solution import: each failed component with a plain-language cause and missing-dependency resolution. |
| [`analyze_plugin_performance`](docs/tools/analyze_plugin_performance.md) | Per-plugin performance table (p50/p95, sync vs async, depth) plus anti-pattern flags: slow sync steps, deep cascades, N+1 firing. |
| [`get_flow_runs`](docs/tools/get_flow_runs.md) | Filtered Power Automate cloud-flow run history (by flow, status, time window) from the Dataverse `flowrun` table. |
| [`document_flow`](docs/tools/document_flow.md) | Structured documentation for a cloud flow from its definition: triggers, action tree, connectors, plus ready-to-share markdown. |
| [`analyze_flow_runs`](docs/tools/analyze_flow_runs.md) | Per-flow reliability report: success rates, duration percentiles, error clusters, and flags for failure streaks and slow flows. |
| [`get_org_automation_settings`](docs/tools/get_org_automation_settings.md) | Org-level switches the other tools depend on: plug-in trace logging level and auditing configuration, with actionable hints. |
| [`find_stuck_jobs`](docs/tools/find_stuck_jobs.md) | Async jobs stuck in waiting/in-progress beyond a threshold — the backlog complement to `get_failed_async_jobs` (postponed jobs excluded). |
| [`explain_flow_failure`](docs/tools/explain_flow_failure.md) | Root-cause analysis of a failed flow run: failed-action guess, definition context, and known-pattern detection (expired connections, throttling, timeouts). |
| [`check_flow_connections`](docs/tools/check_flow_connections.md) | Connection-reference health audit: unbound references, disabled owners, owner mismatches, unused references — with affected flows. |
| [`flow_governance_report`](docs/tools/flow_governance_report.md) | Flow inventory by state and owner: flows owned by disabled users, suspended flows, stale drafts, owner concentration. |
| [`what_runs_on_table`](docs/tools/what_runs_on_table.md) | Everything registered on one table: plug-in steps, cloud flows (trigger vs action), classic workflows and business rules — in one view. |
| [`detect_automation_loops`](docs/tools/detect_automation_loops.md) | Suspected trigger→write cycles between cloud flows (self-loops and 2–3 flow cycles), with filtering-attribute evidence. |
| [`document_table`](docs/tools/document_table.md) | Table documentation from metadata: columns, relationships, keys and attached automation, plus ready-to-share markdown. |
| [`get_solution_layers`](docs/tools/get_solution_layers.md) | Solution layering for one component — who overwrote it, whether an unmanaged Active layer is blocking managed updates. |
| [`modernization_report`](docs/tools/modernization_report.md) | Legacy automation inventory: active dialogs, classic workflows (sync/async), business rules footprint — with migration priorities. |

The flow tools complement Microsoft's [power-platform-skills](https://github.com/microsoft/power-platform-skills) FlowAgent plugin: FlowAgent builds and debugs flows interactively, while these tools add read-only diagnostics, reporting and documentation alongside the plug-in and Dataverse tools above.

## Security & privacy

- **stdio only.** The server is spawned by your MCP host and communicates over stdin/stdout — it opens no ports and runs no network server.
- **Your data stays yours.** All Dataverse data stays on your machine and in your tenant; nothing is proxied through third-party services.
- **Minimal outbound surface.** The only outbound calls are to your Dataverse org (Web API) and Microsoft Entra ID (token acquisition).
- **No telemetry.** The server makes no analytics, licensing or telemetry calls of any kind — the only outbound traffic is to your own Dataverse org and Entra ID.
- Tokens and secrets are held in memory only and are never logged.

## Contributing

Issues and pull requests are welcome. The whole tool set is free and MIT-licensed — new diagnostics, better failure-mode hints, and fixes for real-world Dataverse quirks are all fair game. Each tool is a single file under `src/tools/` with fixture-based tests under `tests/` and a doc page under `docs/tools/`; see [CLAUDE.md](CLAUDE.md) for the conventions.

## License

[MIT](LICENSE) © 2026 SimpleSmoothSafe. Use it, fork it, ship it.
