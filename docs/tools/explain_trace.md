# explain_trace

Root-cause analysis for a single failing plug-in execution. Given one failing
plug-in trace, the tool:

- correlates it with its **step registration** (`SdkMessageProcessingStep`,
  including images and filtering attributes), so you see how the failing code
  was wired up;
- pulls **every sibling trace in the same correlation** to reconstruct the
  pipeline picture — what fired before, after, and around the failure;
- **parses the exception**: innermost exception type and message, plus only the
  plug-in's own stack frames (`Microsoft.Xrm.*` / `System.*` infrastructure
  frames are stripped);
- runs a **known-pattern detector** over the evidence: `sql-timeout`,
  `sql-deadlock`, `missing-privilege`, `null-reference`, `depth-loop` (when
  `depth > 7`), `duplicate-detection` — each hit comes with the evidence that
  triggered it and a likely fix.

The output is structured JSON optimized for an LLM host to reason over, not a
raw trace dump.

**Tier: Pro** — requires the `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

At least one of the two inputs is required. If both are provided, `traceId`
wins.

| Name            | Type                    | Required       | Description                                                                                                      |
| --------------- | ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `traceId`       | string, UUID (optional) | one of the two | Explain this exact plug-in trace log record.                                                                     |
| `correlationId` | string, UUID (optional) | one of the two | Pick the **deepest failing trace** within this correlation and explain that one. Ideal straight after `get_plugin_traces`. |

## Output shape

| Field | Description |
| --- | --- |
| `summary` | One-paragraph plain-language diagnosis. |
| `trace` | The focus trace: `{ id, createdon, pluginType, messageName, primaryEntity, depth, mode ("sync"\|"async"), durationMs, correlationId }`. |
| `exception` | `{ type, message, frames[] }` — innermost exception, plugin-only frames — or `null` if the trace recorded no exception. |
| `stepConfig` | `{ id, name, message, entity, stage ("PreValidation"\|"PreOperation"\|"PostOperation"), mode, rank, filteringAttributes, images[] }` for the failing step, or `null` when the registration could not be resolved. Each image is `{ name, entityAlias, imageType ("PreImage"\|"PostImage"\|"Both"), attributes }`. |
| `stepConfigNote` | Optional note when `stepConfig` is missing or ambiguous (e.g. the step was deleted since the trace was written). |
| `pipeline` | All traces sharing the correlation, ordered as they executed: `{ id, pluginType, messageName, primaryEntity, depth, mode, durationMs, failed, isFocus }`. |
| `detectedPatterns` | Known-pattern hits: `{ pattern, evidence, likelyFix }`. Empty array when nothing matched. |
| `rawExcerpt` | First 1500 characters of the raw exception details. |
| `messageBlockExcerpt` | Optional; first 500 characters of the plug-in's own trace messages (`ITracingService` output). |

## Worked example

An account update is timing out. `get_plugin_traces` surfaced a failure in
`MyCompany.Plugins.AccountPostUpdate` and its correlation id; hand that id to
`explain_trace`:

### Example call

```json
{
  "name": "explain_trace",
  "arguments": {
    "correlationId": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
  }
}
```

### Example output

```json
{
  "summary": "MyCompany.Plugins.AccountPostUpdate failed with a SQL timeout (30.1 s) during a synchronous PostOperation Update of account at depth 3. It was triggered indirectly: a contact update (depth 1) caused AccountRollupCalculator to update the account (depth 2), which fired this step again. The step has no filtering attributes, so it runs on every account column change, and its open-opportunity query exceeded the SQL execution timeout.",
  "trace": {
    "id": "a1b2c3d4-0007-4a2b-9c3d-1234567890ab",
    "createdon": "2026-07-10T09:41:07Z",
    "pluginType": "MyCompany.Plugins.AccountPostUpdate",
    "messageName": "Update",
    "primaryEntity": "account",
    "depth": 3,
    "mode": "sync",
    "durationMs": 30125,
    "correlationId": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
  },
  "exception": {
    "type": "System.Data.SqlClient.SqlException",
    "message": "Execution Timeout Expired. The timeout period elapsed prior to completion of the operation or the server is not responding.",
    "frames": [
      "MyCompany.Plugins.Data.OpportunityRepository.GetOpenOpportunities(Guid accountId)",
      "MyCompany.Plugins.AccountPostUpdate.RecalculatePipelineValue(IOrganizationService service, Entity account)",
      "MyCompany.Plugins.AccountPostUpdate.Execute(IServiceProvider serviceProvider)"
    ]
  },
  "stepConfig": {
    "id": "bbbbbbbb-0000-0000-0000-000000000042",
    "name": "MyCompany.Plugins.AccountPostUpdate: Update of account",
    "message": "Update",
    "entity": "account",
    "stage": "PostOperation",
    "mode": "sync",
    "rank": 1,
    "filteringAttributes": null,
    "images": [
      {
        "name": "PreImage",
        "entityAlias": "PreImage",
        "imageType": "PreImage",
        "attributes": ["revenue", "customertypecode"]
      }
    ]
  },
  "pipeline": [
    {
      "id": "a1b2c3d4-0005-4a2b-9c3d-1234567890ab",
      "pluginType": "MyCompany.Plugins.ContactPostUpdate",
      "messageName": "Update",
      "primaryEntity": "contact",
      "depth": 1,
      "mode": "sync",
      "durationMs": 145,
      "failed": false,
      "isFocus": false
    },
    {
      "id": "a1b2c3d4-0006-4a2b-9c3d-1234567890ab",
      "pluginType": "MyCompany.Plugins.AccountRollupCalculator",
      "messageName": "Update",
      "primaryEntity": "account",
      "depth": 2,
      "mode": "sync",
      "durationMs": 480,
      "failed": false,
      "isFocus": false
    },
    {
      "id": "a1b2c3d4-0007-4a2b-9c3d-1234567890ab",
      "pluginType": "MyCompany.Plugins.AccountPostUpdate",
      "messageName": "Update",
      "primaryEntity": "account",
      "depth": 3,
      "mode": "sync",
      "durationMs": 30125,
      "failed": true,
      "isFocus": true
    },
    {
      "id": "a1b2c3d4-0008-4a2b-9c3d-1234567890ab",
      "pluginType": "MyCompany.Plugins.AuditLogger",
      "messageName": "Update",
      "primaryEntity": "account",
      "depth": 2,
      "mode": "async",
      "durationMs": 92,
      "failed": false,
      "isFocus": false
    }
  ],
  "detectedPatterns": [
    {
      "pattern": "sql-timeout",
      "evidence": "Innermost exception is System.Data.SqlClient.SqlException with \"Execution Timeout Expired\", and the trace ran for 30125 ms in a synchronous step — right at the 30 s SQL execution timeout.",
      "likelyFix": "Move the step to asynchronous mode if the recalculation does not need to happen inside the transaction, or keep it synchronous but add filtering attributes (e.g. revenue) so it only fires when relevant columns change, and optimize GetOpenOpportunities (page the query, select fewer columns, add a filtered view/index)."
    }
  ],
  "rawExcerpt": "Unhandled Exception: System.ServiceModel.FaultException`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]: Generic SQL error. ---> System.Data.SqlClient.SqlException: Execution Timeout Expired. The timeout period elapsed prior to completion of the operation or the server is not responding. ...",
  "messageBlockExcerpt": "AccountPostUpdate: begin RecalculatePipelineValue for account 4f1c... Retrieving open opportunities (no page size set). Executing query against opportunity ..."
}
```

### How to read this

Start at `summary` — it already names the culprit, the trigger chain, and the
misconfiguration. Then confirm it against `pipeline`: the update cascaded from
contact (depth 1) through `AccountRollupCalculator` (depth 2) back into the
account, so `AccountPostUpdate` fired at depth 3 for a change it probably
didn't care about; it is the only entry with `failed: true`. `stepConfig`
explains why it fired at all: `filteringAttributes` is `null`, so the step runs
on **every** account column change, and `mode: "sync"` in `PostOperation` means
its 30-second query blocked the whole transaction. Finally,
`detectedPatterns[0]` ties the `SqlException` and the 30125 ms duration to the
`sql-timeout` pattern and hands you the concrete fix: make the step async, or
add filtering attributes so it only fires when the columns it recalculates
from actually change — and optimize the offending query either way.

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "explain_trace", "message": "...Pro tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| Neither input provided | `{ "error": "Provide traceId or correlationId", "hint": "..." }` |
| `traceId` not found | `{ "error": "Trace not found: \"...\"", "hint": "Plug-in trace logs are purged quickly by the platform. Run get_plugin_traces to find fresh trace ids, then retry." }` |
| No failing trace in the correlation | `{ "error": "No failing trace found for that correlationId", "hint": "All traces in this correlation completed without an exception. Pass an explicit traceId to explain a non-failing trace, or re-check the correlation id." }` |
| HTTP 403 from Dataverse | Error envelope noting the missing `prvReadPluginTraceLog` privilege, a hint to use a System Administrator/System Customizer principal or add the privilege to the connecting principal's role, and `docsUrl` [https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing](https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing). |
