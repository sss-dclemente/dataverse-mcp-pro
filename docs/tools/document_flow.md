# document_flow

Generates structured documentation for a Power Automate **cloud flow** from its
Dataverse definition (the `clientdata` column of the `workflow` table):

- **Triggers** — type, kind, recurrence schedule (frequency/interval), and for
  connector triggers the `operationId` and connection reference.
- **Actions** — a flat, pre-order outline of the whole action tree with nesting
  `depth`, `runAfter` dependencies, connector operation details, and trimmed
  condition/switch expressions. Containers (`Scope`, `If` with its `else`
  branch, `Switch` with all its cases) are walked recursively.
- **Connectors** — the flow's connection references, deduplicated by API name.
- **markdown** — a ready-to-share markdown document (title, overview, trigger
  list, connectors table, nested action outline).

It complements Microsoft's FlowAgent authoring plugin: FlowAgent helps you
*build* flows, `document_flow` produces shareable *documentation* of what an
existing flow does — for reviews, handovers, and change records.

Caps keep output LLM-friendly: children below nesting depth 5 are omitted (the
container gets a `note`), the action list stops at 200 entries
(`actionsTruncated: true`), expressions are trimmed to 200 chars, and the
markdown is hard-capped at 8000 chars with a trailing `…(truncated)` marker.

Part of the free, open-source tool set — no license key required.

## Inputs

At least one of the two inputs is required. If both are provided, `flowId`
wins.

| Name       | Type          | Required       | Description                                                                 |
| ---------- | ------------- | -------------- | --------------------------------------------------------------------------- |
| `flowId`   | string (GUID) | one of the two | `workflowid` of the cloud flow to document.                                 |
| `flowName` | string        | one of the two | Display name of the cloud flow. Matched exactly first, then as a substring. |

## Example call

```json
{
  "name": "document_flow",
  "arguments": {
    "flowName": "Daily Task Reminder"
  }
}
```

## Example output

Trimmed for brevity:

```json
{
  "flow": {
    "id": "aaaaaaaa-1111-2222-3333-444444444444",
    "name": "Daily Task Reminder",
    "description": "Reminds owners about overdue tasks every morning.",
    "state": "activated",
    "createdon": "2026-05-01T08:00:00Z",
    "modifiedon": "2026-07-01T09:30:00Z"
  },
  "triggers": [
    {
      "name": "Recurrence_daily",
      "type": "Recurrence",
      "recurrence": { "frequency": "Day", "interval": 1 }
    }
  ],
  "actions": [
    {
      "name": "List_overdue_tasks",
      "type": "OpenApiConnection",
      "depth": 0,
      "operationId": "ListRecords",
      "connectionReference": "shared_commondataserviceforapps"
    },
    {
      "name": "Process_tasks",
      "type": "Scope",
      "depth": 0,
      "runAfter": ["List_overdue_tasks"]
    },
    {
      "name": "Check_count",
      "type": "If",
      "depth": 1,
      "runAfter": ["Compose_summary"],
      "expression": "{\"greater\":[\"@length(body('List_overdue_tasks')?['value'])\",0]}"
    }
  ],
  "actionCount": 10,
  "connectors": [
    {
      "referenceName": "shared_commondataserviceforapps",
      "apiName": "shared_commondataserviceforapps",
      "connectionName": "shared-commondataser-1234"
    },
    {
      "referenceName": "shared_office365",
      "apiName": "shared_office365",
      "connectionName": "shared-office365-abcd"
    }
  ],
  "markdown": "# Daily Task Reminder\n\nState: activated · Last modified: 2026-07-01T09:30:00Z\n\n## Overview\n\nReminds owners about overdue tasks every morning.\n\n## Triggers\n\n- **Recurrence_daily** (`Recurrence`) — every 1 Day\n\n## Connectors\n\n| apiName | referenceName | connectionName |\n| --- | --- | --- |\n| shared_office365 | shared_office365 | shared-office365-abcd |\n\n## Actions\n\n- **List_overdue_tasks** (`OpenApiConnection`) — operation: ListRecords\n  - **Compose_summary** (`Compose`)\n..."
}
```

## Common errors

| Situation | Response |
| --------- | -------- |
| Neither input provided | `{ "error": "Provide flowId or flowName", "hint": "..." }` |
| `flowId` does not exist (HTTP 404) | `{ "error": "Flow not found", "hint": "Verify the workflowid (GUID)..." }` |
| No cloud flow matches `flowName` | `{ "error": "Flow not found: \"...\"", "hint": "No cloud flow (category 5) matched that display name..." }` |
| Workflow is not a cloud flow (`category` ≠ 5) | `{ "error": "Not a cloud flow", "hint": "Classic workflows, business process flows and desktop flows are not supported..." }` |
| `clientdata` is null/empty | `{ "error": "Flow definition unavailable", "hint": "The flow may be part of a managed solution without a stored definition..." }` |
| `clientdata` is not valid JSON | `{ "error": "Flow definition could not be parsed", "hint": "Re-save the flow in the Power Automate designer..." }` |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that documenting a flow requires read privilege on the Process (`workflow`) table, and `docsUrl` pointing to [cloud flow run metadata](https://learn.microsoft.com/power-automate/dataverse/cloud-flow-run-metadata). |
