# analyze_flow_runs

Aggregates Power Automate cloud-flow run history (the Dataverse `flowruns`
virtual table) over a time window into a per-flow reliability/performance
table — run counts by status, success rate, p50/p95 (nearest-rank), average and
max duration, last run, and the top error groups — and flags problems: flows
with a high failure rate, flows whose most recent runs all failed (a failure
streak), and flows with a slow p95 runtime. Flow display names are resolved
from the `workflows` table. Reads a single page of up to 5000 runs (newest
first); when the cap is hit the result is marked `truncated`.

**Tier:** Pro — requires `LICENSE_KEY`; without it the tool returns an upgrade
message instead of running.

## Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `hoursBack` | integer, 1–336 | `72` | How many hours of cloud-flow run history to analyze. |
| `flowId` | string (GUID), optional | — | Scope the analysis to a single cloud flow (its `workflowid`). |

## Example call

```json
{
  "hoursBack": 48,
  "flowId": "aaaaaaaa-0000-4000-8000-00000000000a"
}
```

## Example output

```json
{
  "windowHours": 48,
  "totalRuns": 15,
  "flowsAnalyzed": 3,
  "table": [
    {
      "flowId": "aaaaaaaa-0000-4000-8000-00000000000a",
      "flowName": "Order Sync",
      "runs": 6,
      "succeeded": 3,
      "failed": 3,
      "cancelled": 0,
      "otherStatuses": 0,
      "successRate": 50,
      "p50DurationMs": 10000,
      "p95DurationMs": 15000,
      "avgDurationMs": 10833,
      "maxDurationMs": 15000,
      "lastRunAt": "2026-07-10T11:00:00Z",
      "lastRunStatus": "Succeeded",
      "errorGroups": [
        {
          "errorCode": "ActionFailed",
          "messageExcerpt": "Action 'Update_row' failed: The record was not found in table 'accounts'.",
          "count": 3
        }
      ]
    },
    {
      "flowId": "bbbbbbbb-0000-4000-8000-00000000000b",
      "flowName": "Invoice Approval",
      "runs": 4,
      "succeeded": 1,
      "failed": 3,
      "cancelled": 0,
      "otherStatuses": 0,
      "successRate": 25,
      "p50DurationMs": 5000,
      "p95DurationMs": 6000,
      "avgDurationMs": 5000,
      "maxDurationMs": 6000,
      "lastRunAt": "2026-07-10T11:30:00Z",
      "lastRunStatus": "Failed",
      "errorGroups": [
        {
          "errorCode": "ConnectionAuthorizationFailed",
          "messageExcerpt": "The connection 'shared_office365' is not authorized. Please reauthorize.",
          "count": 2
        },
        {
          "errorCode": "TimeoutError",
          "messageExcerpt": "The operation timed out after 120 seconds while waiting for a response from the downstream service. The request to https://api.contoso.com/v1/or",
          "count": 1
        }
      ]
    },
    {
      "flowId": "cccccccc-0000-4000-8000-00000000000c",
      "flowName": "Nightly Data Export",
      "runs": 5,
      "succeeded": 4,
      "failed": 0,
      "cancelled": 1,
      "otherStatuses": 0,
      "successRate": 80,
      "p50DurationMs": 90000,
      "p95DurationMs": 320000,
      "avgDurationMs": 147500,
      "maxDurationMs": 320000,
      "lastRunAt": "2026-07-10T12:00:00Z",
      "lastRunStatus": "Succeeded",
      "errorGroups": []
    }
  ],
  "flags": [
    {
      "flag": "high-failure-rate",
      "flowId": "aaaaaaaa-0000-4000-8000-00000000000a",
      "flowName": "Order Sync",
      "evidence": "success rate 50% over 6 runs (3 failed, 3 succeeded).",
      "recommendation": "Inspect the top error group and pinpoint the failing action via run history (get_flow_runs / FlowAgent)."
    },
    {
      "flag": "failure-streak",
      "flowId": "bbbbbbbb-0000-4000-8000-00000000000b",
      "flowName": "Invoice Approval",
      "evidence": "last 3 runs failed consecutively.",
      "recommendation": "Check for an expired connection or a recent flow edit — streaks usually mean a systemic break, not data-dependent errors."
    },
    {
      "flag": "slow-p95",
      "flowId": "cccccccc-0000-4000-8000-00000000000c",
      "flowName": "Nightly Data Export",
      "evidence": "p95 duration 320000 ms exceeds 5 minutes.",
      "recommendation": "Check for loops over large datasets, chatty connector calls, or missing pagination/concurrency settings."
    }
  ]
}
```

The `table` is sorted by `failed` descending, then `runs` descending.
Percentiles use nearest-rank over each flow's sorted non-null durations; runs
without a recorded duration (e.g. still running or cancelled early) are dropped
from the duration distribution, and a flow with no recorded durations reports
0 for all duration statistics. `successRate` is `succeeded / runs * 100`
rounded to one decimal. `errorGroups` lists the flow's top 3 clusters of failed
runs grouped by error code plus the first 150 characters of the error message,
sorted by count. A run whose flow cannot be resolved in `workflows` gets
`flowName: "unknown"`. When exactly 5000 rows come back the payload includes
`"truncated": true` — narrow `hoursBack` (or scope with `flowId`) for a
complete picture.

Flags are ordered `high-failure-rate`, then `failure-streak`, then `slow-p95`
(worst first within each kind):

- **high-failure-rate** — success rate below 80% across at least 5 runs.
- **failure-streak** — the flow's 3 or more most recent runs all failed,
  which usually points at a systemic break (expired connection, bad flow
  edit) rather than data-dependent errors.
- **slow-p95** — p95 duration above 300000 ms (5 minutes).

## Common errors

**Unlicensed — Pro tier gate**

Without a `LICENSE_KEY` the tool returns an upgrade payload and performs no
Dataverse calls:

```json
{
  "upgradeRequired": true,
  "tool": "analyze_flow_runs",
  "message": "The tool \"analyze_flow_runs\" is part of the Pro tier. Set the LICENSE_KEY environment variable to unlock it. See https://github.com/sss-dclemente/dataverse-mcp-pro#pro for details.",
  "docsUrl": "https://github.com/sss-dclemente/dataverse-mcp-pro#pro"
}
```

**Empty window — run history only covers solution-aware flows**

An empty result is a success payload with a hint, because Dataverse only
records run metadata for solution-aware cloud flows:

```json
{
  "windowHours": 72,
  "totalRuns": 0,
  "flowsAnalyzed": 0,
  "table": [],
  "flags": [],
  "hint": "No cloud-flow runs found in the window. Dataverse run history covers solution-aware flows.",
  "docsUrl": "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata"
}
```

**404 — flowrun table not available**

```json
{
  "error": "Resource not found for the segment 'flowruns'.",
  "hint": "The flowrun table was not found. Cloud-flow run history in Dataverse is a virtual table that only covers solution-aware flows and may not be enabled in this environment.",
  "docsUrl": "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata"
}
```

**403 — missing privilege**

```json
{
  "error": "Principal user (...) is missing prvReadflowrun privilege",
  "hint": "Reading cloud-flow run history requires read privilege on the flowrun table. Use a user with the System Administrator role, or grant the connecting principal read access to Flow Run records.",
  "docsUrl": "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata"
}
```
