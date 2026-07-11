# explain_flow_failure

Root-cause analysis for a failed Power Automate cloud-flow run — the flow twin
of `explain_trace`. Given a run (or just a flow), the tool:

- resolves the run from Dataverse run history (the `flowrun` virtual table) —
  either the exact run you name, or the flow's **latest Failed run**;
- fetches the flow's stored definition (`workflow.clientdata`) and extracts its
  **actions** (names + connector `operationId`s) and trigger type, tolerating
  missing or unparsable definitions;
- **guesses the failing action** from the run's error message and cross-checks
  it against the parsed definition;
- runs a **known-pattern detector** over the error code + message:
  `connection-auth`, `throttling`, `timeout`, `permission`, `expression`,
  `apply-to-each-limits`, `dataverse-plugin-error` — each hit comes with the
  evidence that triggered it and a likely fix.

The output is structured JSON optimized for an LLM host to reason over, not a
raw run dump.

**Tier: Pro** — requires the `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

At least one of the three inputs is required. `runName` wins over `flowId`,
which wins over `flowName`.

| Name       | Type                    | Required     | Description                                                                                              |
| ---------- | ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| `runName`  | string (optional)       | one of three | The flow run's `name` (the Power Automate run id string, e.g. from `get_flow_runs`). Analyzes that exact run. |
| `flowId`   | string, UUID (optional) | one of three | `workflowid` of the cloud flow; the **latest Failed run** is analyzed.                                    |
| `flowName` | string (optional)       | one of three | Display name of the cloud flow, matched exactly first, then by `contains()`; the first match's latest Failed run is analyzed. |

## Output shape

| Field | Description |
| --- | --- |
| `summary` | 1–2 plain-language sentences naming the flow, run, error and detected patterns. |
| `run` | `{ runName, status, startTime, endTime, durationMs?, triggerType, errorCode?, errorMessageExcerpt? }` — the excerpt is capped at 500 characters. |
| `flow` | `{ id, name, state ("draft"\|"activated") }`, or `null` when the run no longer references an existing flow. |
| `statusNote` | Optional; present when the resolved run's status is not `Failed` (the run is still analyzed). |
| `failedActionGuess` | Optional; `{ name, foundInDefinition, operationId? }` — the action named in the error message, cross-checked against the parsed definition. |
| `actions` | Actions parsed from the flow definition: `{ name, operationId? }`, capped at 50. |
| `actionsTruncated` | Optional; `true` when the 50-action cap was hit. |
| `definitionNote` | Optional; present when the flow definition was missing or could not be parsed. |
| `detectedPatterns` | Known-pattern hits: `{ pattern, evidence, likelyFix }`. Empty array when nothing matched. |
| `rawErrorExcerpt` | First 500 characters of `errorcode: errormessage`. |

## Worked example

`analyze_flow_runs` flagged a failure streak on "Invoice Approval" — its
connection expired. Grab the newest failed run's id from `get_flow_runs` (or
just pass the flow name) and hand it to `explain_flow_failure`:

### Example call

```json
{
  "name": "explain_flow_failure",
  "arguments": {
    "runName": "08585287500499200907519834647CU12"
  }
}
```

### Example output

```json
{
  "summary": "Cloud flow \"Invoice Approval\" run 08585287500499200907519834647CU12 failed (started 2026-07-10T11:30:00Z) with error ConnectionAuthorizationFailed, apparently in action 'Send_approval_email'. Detected patterns: connection-auth.",
  "run": {
    "runName": "08585287500499200907519834647CU12",
    "status": "Failed",
    "startTime": "2026-07-10T11:30:00Z",
    "endTime": "2026-07-10T11:30:04Z",
    "durationMs": 4000,
    "triggerType": "OpenApiConnectionWebhook",
    "errorCode": "ConnectionAuthorizationFailed",
    "errorMessageExcerpt": "Action 'Send_approval_email' failed: The connection 'shared_office365' is not authorized. Received a 401 Unauthorized response from the Office 365 Outlook connector. AADSTS700082: The refresh token has expired due to inactivity. ..."
  },
  "flow": {
    "id": "11111111-0000-4000-8000-000000000011",
    "name": "Invoice Approval",
    "state": "activated"
  },
  "failedActionGuess": {
    "name": "Send_approval_email",
    "foundInDefinition": true,
    "operationId": "SendEmailV2"
  },
  "actions": [
    { "name": "Get_invoice_row", "operationId": "GetItem" },
    { "name": "Condition" },
    { "name": "Send_approval_email", "operationId": "SendEmailV2" },
    { "name": "Update_status", "operationId": "UpdateRecord" }
  ],
  "detectedPatterns": [
    {
      "pattern": "connection-auth",
      "evidence": "Action 'Send_approval_email' failed: The connection 'shared_office365' is not authorized. Received a 401 Unauthorized response from the Office 365 Outlook connector. AADSTS700082: The refresh token h",
      "likelyFix": "Reconnect or re-consent the failing connection (edit it in Power Automate and sign in again), and check that the solution's connection references point at live, authorized connections."
    }
  ],
  "rawErrorExcerpt": "ConnectionAuthorizationFailed: Action 'Send_approval_email' failed: The connection 'shared_office365' is not authorized. Received a 401 Unauthorized response from the Office 365 Outlook connector. AADSTS700082: The refresh token has expired due to inactivity. ..."
}
```

### How to read this

Start at `summary` — it already names the flow, the failing action and the
pattern. `failedActionGuess` confirms `Send_approval_email` exists in the
definition and runs the Office 365 `SendEmailV2` operation, so the failure sits
squarely on that connector call. `detectedPatterns[0]` ties the 401 /
`AADSTS700082` evidence to `connection-auth` and hands you the fix: reauthorize
the `shared_office365` connection (and verify the solution's connection
references) — no flow edit needed. If the pattern had been
`dataverse-plugin-error` instead, the failure would originate server-side in a
Dataverse plug-in: run `explain_trace` on the correlated plug-in trace.

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "explain_flow_failure", "message": "...Pro tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| No input provided | `{ "error": "Provide runName, flowId or flowName", "hint": "..." }` |
| `runName` not found | `{ "error": "Flow run not found: \"...\"", "hint": "Run names come from get_flow_runs; Dataverse run history only covers solution-aware cloud flows and is retained for a limited window." }` |
| Flow has no Failed runs | `{ "error": "No failed runs found for this flow", "hint": "Use get_flow_runs to inspect recent runs in any state..." }` |
| `flowName` matches nothing | `{ "error": "No cloud flow found matching \"...\".", "hint": "Use the exact display name or pass flowId instead." }` |
| `flowruns` table missing (404/400) | Error envelope hinting that the flowrun virtual table requires solution-aware flows and may not be enabled in every environment/region, with `docsUrl` [https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata](https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata). |
| HTTP 403 from Dataverse | Error envelope noting the missing read privilege on the Process (workflow) and flow run tables, and the same `docsUrl`. |
