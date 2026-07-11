# get_flow_runs

Lists Power Automate cloud-flow runs from the Dataverse `flowruns` virtual table
— the run-history metadata Dataverse keeps for solution-aware cloud flows. Scope
by flow (id or display name), run status and time window; failed runs carry a
truncated error code/message. This complements Microsoft's FlowAgent authoring
plugin with read-only diagnostics: it answers "which runs failed overnight and
why?" without opening the Power Automate portal.

**Tier:** Free

## Inputs

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `flowId` | string, UUID (optional) | — | Workflow id of the cloud flow to scope runs to. Takes precedence over `flowName`. |
| `flowName` | string (optional) | — | Cloud flow display name. Matched exactly first, then via `contains()`; up to 5 matching flows are included. |
| `status` | `succeeded` \| `failed` \| `cancelled` \| `running` (optional) | — | Filter runs by outcome. Omit for all states. |
| `hoursBack` | integer, 1–168 | `24` | How many hours back to search. |
| `top` | integer, 1–100 | `25` | Maximum number of runs to return (newest first). |

Omitting both `flowId` and `flowName` lists runs across all flows.

## Example call

```json
{
  "flowName": "Order Sync",
  "status": "failed",
  "hoursBack": 48,
  "top": 10
}
```

## Example output

```json
{
  "count": 2,
  "windowHours": 48,
  "runs": [
    {
      "runName": "08585287700727607973207791544CU21",
      "flowId": "aaaaaaaa-1111-4111-8111-111111111111",
      "status": "Failed",
      "startTime": "2026-07-10T11:30:02Z",
      "endTime": "2026-07-10T11:30:14Z",
      "durationMs": 12345,
      "triggerType": "Automated",
      "errorCode": "WorkflowActionFailed",
      "errorMessage": "Action 'Update_account_record' failed: The 'Update a row' action could not complete because... (first 300 chars)"
    },
    {
      "runName": "08585287700999999999999999999CU42",
      "flowId": "aaaaaaaa-1111-4111-8111-111111111111",
      "status": "Running",
      "startTime": "2026-07-10T11:58:41Z",
      "endTime": null,
      "triggerType": "Manual"
    }
  ]
}
```

`runName` is the Power Automate run id string (usable to open the run in the
portal). `errorCode` / `errorMessage` only appear on runs that recorded an
error; `errorMessage` is truncated to 300 characters. `durationMs` is omitted
while a run is still in flight.

## Common errors

**Flow run table not available (404, or 400 "entity not found")**

Cloud-flow run history in Dataverse is backed by the `flowrun` virtual table,
which requires solution-aware flows and is not enabled in every
environment/region:

```json
{
  "error": "Resource not found for the segment 'flowruns'.",
  "hint": "Cloud-flow run history in Dataverse (the flowrun virtual table) requires solution-aware flows and may not be enabled in every environment/region",
  "docsUrl": "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata"
}
```

**400 — unsupported filter**

The virtual table supports only limited OData filtering:

```json
{
  "error": "The query specified in the URI is not valid. ...",
  "hint": "The flowrun virtual table supports limited OData filtering. Try narrowing the query by flowId and keep filters to starttime, status and the flow lookup.",
  "docsUrl": "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata"
}
```

**403 — missing privilege**

```json
{
  "error": "Principal user is missing prvReadWorkflow privilege",
  "hint": "Reading cloud-flow run history requires read privilege on the Process (workflow) and flow run tables. Use a user with the System Administrator role, or grant those read privileges to the connecting principal's security role.",
  "docsUrl": "https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata"
}
```

**No cloud flow found matching the name**

```json
{
  "error": "No cloud flow found matching \"Ghost Flow\".",
  "hint": "Use the flow's display name exactly as shown in Power Automate, or pass flowId (the workflow id GUID) instead. Only solution-aware cloud flows are visible."
}
```

**Empty result**

Returned as a success payload with a hint — run history only covers
solution-aware cloud flows:

```json
{
  "count": 0,
  "windowHours": 24,
  "runs": [],
  "hint": "No runs in the window. Note that Dataverse run history covers solution-aware cloud flows."
}
```
