# dataverse-ops-mcp

**Microsoft Dataverse diagnostics for your AI assistant — plugin traces, failed async jobs, import failures and step configuration analysis over MCP.**

Diagnosing production problems in Dataverse / Dynamics 365 usually means firing up XrmToolBox, exporting plugin trace logs, and spelunking through raw exception blocks and `importexportxml` documents by hand: plugin failures buried in thousands of trace rows, async job graveyards in the admin center, cryptic solution import errors, and performance mysteries with no obvious culprit. This MCP server puts those diagnostics directly inside your AI assistant. Instead of raw Dataverse payloads, every tool returns structured, LLM-optimized JSON — trimmed, grouped, and annotated — so the assistant can reason about *why* something failed, not just show you that it did.

It runs locally over stdio inside Claude Desktop, Claude Code, or any MCP host, and talks only to your own Dataverse org via the Web API (v9.2) — no middleman service, no data leaving your machine or tenant. The free tier covers everyday triage (health check, recent plugin failures, failed async jobs); the Pro tier adds root-cause analysis: step configuration linting, single-trace root-cause correlation, solution import failure explanations, and plugin performance profiling.

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
| `LICENSE_KEY` | No | Unlocks the Pro tools. Validated once at startup against the license service; without it, Pro tools return an upgrade message. |
| `DVOPS_LICENSE_URL` | No | Overrides the license validation endpoint (mainly for testing/self-hosting). |
| `DVOPS_CACHE_DIR` | No | Directory for the license cache file (`license-cache.json`). Defaults to `~/.dvops`. |

When the `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` trio is absent, the server falls back to [`DefaultAzureCredential`](https://learn.microsoft.com/azure/developer/javascript/sdk/credential-chains) — so a plain `az login` (or managed identity, VS Code sign-in, etc.) works too.

## Tools

| Tool | Tier | What it does |
| --- | --- | --- |
| `ping` | Free | Health check — returns `{ ok: true }` without contacting Dataverse. |
| [`get_plugin_traces`](docs/tools/get_plugin_traces.md) | Free | Recent plug-in trace logs, defaulting to executions that threw an exception, with trimmed one-line summaries and excerpts. |
| [`get_failed_async_jobs`](docs/tools/get_failed_async_jobs.md) | Free | Failed/canceled async jobs over a time window, grouped by job name + error code so recurring failures stand out. |
| [`check_step_config`](docs/tools/check_step_config.md) | Pro | Lints plug-in step registrations for misconfigurations: missing filtering attributes, sync steps on high-volume entities, rank collisions. |
| [`explain_trace`](docs/tools/explain_trace.md) | Pro | Root-cause analysis of one failing plug-in execution: correlates the step registration, sibling traces and parsed exception. |
| [`explain_import_failure`](docs/tools/explain_import_failure.md) | Pro | Explains a failed solution import: each failed component with a plain-language cause and missing-dependency resolution. |
| [`analyze_plugin_performance`](docs/tools/analyze_plugin_performance.md) | Pro | Per-plugin performance table (p50/p95, sync vs async, depth) plus anti-pattern flags: slow sync steps, deep cascades, N+1 firing. |

## Security & privacy

- **stdio only.** The server is spawned by your MCP host and communicates over stdin/stdout — it opens no ports and runs no network server.
- **Your data stays yours.** All Dataverse data stays on your machine and in your tenant; nothing is proxied through third-party services.
- **Minimal outbound surface.** The only outbound calls are to your Dataverse org (Web API) and Microsoft Entra ID (token acquisition).
- **No telemetry by default.** The single optional outbound call beyond that is license validation when `LICENSE_KEY` is set — and it never carries org data.
- Tokens and secrets are held in memory only and are never logged.

## Pro

Pro tools are unlocked with a license key — purchase one on the [pricing page](https://dvops.simplesmoothsafe.com/#pricing) and set it via the `LICENSE_KEY` environment variable.

**How validation works.** The key is checked **once at server startup** against the license service. The result is cached in memory for the lifetime of the process, and a positive validation is also cached on disk in `~/.dvops/license-cache.json` (configurable via `DVOPS_CACHE_DIR`). If the license service is unreachable at startup, that on-disk cache grants a **7-day offline grace** window, so a flaky network or a short service outage never locks you out of tools you paid for. An explicitly rejected key never falls back to the cache. Licensing failures never crash the server and never affect the free tools.

**Privacy.** The only data sent to the license service is the license key, the product id, and a SHA-256 hash of your org URL — never the URL itself, and never any org data. The on-disk cache stores a SHA-256 hash of the key, not the key itself.

## License

Proprietary — see [LICENSE](LICENSE). Free-tier tools are free to use for any internal business purpose; Pro-tier tools require a license key.
