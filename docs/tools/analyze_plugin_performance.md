# analyze_plugin_performance

Aggregates Microsoft Dataverse plug-in trace logs (`plugintracelogs`) over a
time window into a per-plugin/message performance table — executions, p50/p95
(nearest-rank), average and max duration, execution depth, sync vs async split —
and flags common anti-patterns: slow synchronous steps, deep cascades (plug-in
chains), and N+1 firing of the same plug-in within a single correlation. Reads a
single page of up to 5000 traces (newest first); when the cap is hit the result
is marked `truncated`.

**Tier:** Pro — requires `LICENSE_KEY`; without it the tool returns an upgrade
message instead of running.

## Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `hoursBack` | integer, 1–336 | `72` | How many hours of plug-in traces to analyze. |

## Example call

```json
{
  "hoursBack": 48
}
```

## Example output

```json
{
  "windowHours": 48,
  "totalExecutions": 17,
  "analyzedPlugins": 3,
  "table": [
    {
      "pluginType": "Contoso.Plugins.OrderTotalsPlugin",
      "messageName": "Update",
      "executions": 8,
      "p50DurationMs": 1200,
      "p95DurationMs": 2600,
      "avgDurationMs": 1375,
      "maxDurationMs": 2600,
      "maxDepth": 1,
      "avgDepth": 1,
      "syncExecutions": 8,
      "asyncExecutions": 0,
      "entities": ["salesorder"]
    },
    {
      "pluginType": "Contoso.Plugins.CascadePlugin",
      "messageName": "Update",
      "executions": 4,
      "p50DurationMs": 100,
      "p95DurationMs": 300,
      "avgDurationMs": 150,
      "maxDurationMs": 300,
      "maxDepth": 5,
      "avgDepth": 3.5,
      "syncExecutions": 2,
      "asyncExecutions": 2,
      "entities": ["contact"]
    },
    {
      "pluginType": "Contoso.Plugins.ContactEnrichmentPlugin",
      "messageName": "Create",
      "executions": 5,
      "p50DurationMs": 70,
      "p95DurationMs": 90,
      "avgDurationMs": 70,
      "maxDurationMs": 90,
      "maxDepth": 1,
      "avgDepth": 1,
      "syncExecutions": 0,
      "asyncExecutions": 5,
      "entities": ["contact"]
    }
  ],
  "flags": [
    {
      "flag": "slow-sync",
      "pluginType": "Contoso.Plugins.OrderTotalsPlugin",
      "messageName": "Update",
      "evidence": "p95 duration 2600 ms with 8 synchronous execution(s) blocking the calling operation.",
      "recommendation": "Move heavy work to an asynchronous step, trim the queries the plug-in runs, or narrow the step's scope with filtering attributes so it fires less often."
    },
    {
      "flag": "deep-cascade",
      "pluginType": "Contoso.Plugins.CascadePlugin",
      "messageName": "Update",
      "evidence": "maxDepth 5 indicates nested pipeline executions.",
      "recommendation": "Check for plug-in chains/cascades (update loops between plug-ins) and add depth guards (context.Depth checks) to break re-entrant loops."
    },
    {
      "flag": "n-plus-one",
      "pluginType": "Contoso.Plugins.ContactEnrichmentPlugin",
      "messageName": "Create",
      "evidence": "fired 5 times in one correlation (correlationId cccccccc-0000-4000-8000-000000000001).",
      "recommendation": "Batch the work with ExecuteMultiple, cache repeated lookups, or move per-record logic to a single bulk operation."
    }
  ]
}
```

The `table` is sorted by `p95DurationMs` descending. Percentiles use
nearest-rank over the group's sorted durations; traces without a recorded
duration count as 0 ms. `entities` lists up to 5 distinct primary entities and
is omitted when none were recorded. When exactly 5000 rows come back the
payload includes `"truncated": true` — narrow `hoursBack` for a complete
picture.

Flags are ordered `slow-sync`, then `deep-cascade`, then `n-plus-one`:

- **slow-sync** — the group's p95 exceeds 2000 ms and it has synchronous
  executions that block the calling operation.
- **deep-cascade** — the group reached execution depth 4 or more, indicating
  plug-ins triggering each other.
- **n-plus-one** — the same plug-in type fired more than 3 times within a
  single `correlationid` (per-record logic in a bulk operation).

## Common errors

**Unlicensed — Pro tier gate**

Without a `LICENSE_KEY` the tool returns an upgrade payload and performs no
Dataverse calls:

```json
{
  "upgradeRequired": true,
  "tool": "analyze_plugin_performance",
  "message": "The tool \"analyze_plugin_performance\" is part of the Pro tier. Set the LICENSE_KEY environment variable to unlock it. See https://github.com/sss-dclemente/dataverse-mcp-pro#pro for details.",
  "docsUrl": "https://github.com/sss-dclemente/dataverse-mcp-pro#pro"
}
```

**Empty window — trace logging may be disabled**

An empty result is a success payload with a hint, because the most common cause
is that plug-in trace logging is turned off for the organization:

```json
{
  "windowHours": 72,
  "totalExecutions": 0,
  "analyzedPlugins": 0,
  "table": [],
  "flags": [],
  "hint": "No plug-in traces in the window. Plug-in trace logging may be disabled.",
  "docsUrl": "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing"
}
```

**403 — missing privilege**

```json
{
  "error": "Principal user (...) is missing prvReadPluginTraceLog privilege",
  "hint": "Reading plug-in trace logs requires the prvReadPluginTraceLog privilege. Use a user with the System Administrator or System Customizer role, or add that privilege to the connecting principal's security role.",
  "docsUrl": "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing"
}
```
