# get_plugin_traces

Queries Microsoft Dataverse plug-in trace logs (`plugintracelogs`) and returns a
structured, trimmed summary of recent plug-in executions. By default it returns
only traces that recorded an exception in the last 24 hours — the fastest way to
answer "which plug-in just failed and why?". Exception details are reduced to a
one-line summary plus a 500-character excerpt; the raw `messageblock` is never
fetched or returned.

**Tier:** Free

## Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `entity` | string (optional) | — | Logical name of the primary entity to filter on (e.g. `account`). |
| `messageName` | string (optional) | — | SDK message name to filter on (e.g. `Update`, `Create`). |
| `pluginTypeName` | string (optional) | — | Substring matched against the plug-in type name (`contains()`), e.g. `Contoso.Plugins`. |
| `onlyErrors` | boolean | `true` | When true, only traces with exception details are returned. |
| `correlationId` | string, UUID (optional) | — | Correlation id to follow a single pipeline execution across steps. |
| `hoursBack` | integer, 1–168 | `24` | How many hours back to search. |
| `top` | integer, 1–100 | `25` | Maximum number of traces to return (newest first). |

## Example call

```json
{
  "entity": "account",
  "messageName": "Update",
  "hoursBack": 48,
  "top": 10
}
```

## Example output

```json
{
  "count": 2,
  "traces": [
    {
      "id": "a1b2c3d4-0001-4a2b-9c3d-1234567890ab",
      "createdon": "2026-07-10T09:41:07Z",
      "pluginType": "Contoso.Plugins.AccountNumberValidator",
      "messageName": "Update",
      "primaryEntity": "account",
      "depth": 1,
      "mode": "sync",
      "durationMs": 312,
      "correlationId": "0f0e0d0c-0b0a-4998-8877-665544332211",
      "exceptionSummary": "Unhandled Exception: Microsoft.Xrm.Sdk.InvalidPluginExecutionException: Account number is required...",
      "exceptionExcerpt": "\r\nUnhandled Exception: Microsoft.Xrm.Sdk.InvalidPluginExecutionException: Account number is required... (first 500 chars)"
    },
    {
      "id": "a1b2c3d4-0002-4a2b-9c3d-1234567890ab",
      "createdon": "2026-07-10T08:15:33Z",
      "pluginType": "Contoso.Plugins.OrderTotalsRecalculator",
      "messageName": "Update",
      "primaryEntity": "account",
      "depth": 2,
      "mode": "async",
      "durationMs": 1874,
      "correlationId": "11111111-2222-4333-8444-555555555555"
    }
  ]
}
```

`exceptionSummary` and `exceptionExcerpt` only appear on traces that recorded an
exception. `mode` is `"sync"` (0) or `"async"` (1).

## Common errors

**403 — missing privilege**

```json
{
  "error": "Principal user (...) is missing prvReadPluginTraceLog privilege",
  "hint": "Reading plug-in trace logs requires the prvReadPluginTraceLog privilege. Use a user with the System Administrator or System Customizer role, or add that privilege to the connecting principal's security role.",
  "docsUrl": "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing"
}
```

**Empty result — trace logging may be disabled**

An empty result is returned as a success payload with a hint, because the most
common cause is that plug-in trace logging is turned off for the organization:

```json
{
  "count": 0,
  "traces": [],
  "hint": "No plug-in trace records matched. Plug-in trace logging may be disabled in this org: enable it under Settings > Administration > System Settings > Customization > \"Enable logging to plug-in trace log\" (set to \"Exception\" or \"All\"), then reproduce the operation and query again. Otherwise, try widening hoursBack or relaxing filters (e.g. onlyErrors: false).",
  "docsUrl": "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing"
}
```
