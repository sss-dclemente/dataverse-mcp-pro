# what_runs_on_table

Maps **all** active automation registered on one Dataverse table in a single
cross-automation view — the pro-code and low-code sides that are otherwise
scattered across the Plugin Registration Tool, Power Automate and the classic
process list:

- **Plug-in steps** (`SdkMessageProcessingStep`) — with message, stage, mode,
  rank and filtering attributes, sorted by pipeline stage then rank.
- **Cloud flows** (solution-aware, activated) — the flow definitions
  (`workflow.clientdata`) are scanned for the table as a **trigger** entity
  (`subscriptionRequest/entityname`) or in Dataverse **actions**
  (`entityName`, including the plural entity-set form like `accounts`).
- **Classic workflows** (`category 0`) scoped to the table via `primaryentity`.
- **Business rules** (`category 2`) scoped the same way.

Only **active** registrations are included (`statecode eq 0` for steps,
`statecode eq 1` for flows/workflows/rules). Use it for impact analysis before
schema changes: "what breaks if I rename or restructure this column/table?"

**Tier: Pro** — requires the `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

| Name    | Type   | Required | Description                                                                                              |
| ------- | ------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `table` | string | yes      | Logical name of the table, e.g. `account` (singular, lowercase — not the display name or plural entity-set name). Trimmed and lowercased before querying. |

## Example call

```json
{
  "name": "what_runs_on_table",
  "arguments": {
    "table": "account"
  }
}
```

## Example output

```json
{
  "table": "account",
  "pluginSteps": [
    {
      "id": "22222222-0000-0000-0000-000000000003",
      "name": "Contoso.Plugins.AccountPlugin: Create of account",
      "pluginType": "Contoso.Plugins.AccountPlugin",
      "message": "Create",
      "stage": "PreOperation",
      "mode": "sync",
      "rank": 1,
      "filteringAttributes": null
    },
    {
      "id": "22222222-0000-0000-0000-000000000001",
      "name": "Contoso.Plugins.AccountPlugin: Update of account (post)",
      "pluginType": "Contoso.Plugins.AccountPlugin",
      "message": "Update",
      "stage": "PostOperation",
      "mode": "async",
      "rank": 1,
      "filteringAttributes": null
    }
  ],
  "cloudFlows": [
    {
      "id": "55555555-0000-0000-0000-000000000001",
      "name": "Notify team on new account",
      "uses": ["trigger"]
    },
    {
      "id": "55555555-0000-0000-0000-000000000002",
      "name": "Nightly account cleanup",
      "uses": ["action"]
    }
  ],
  "classicWorkflows": [
    { "id": "33333333-0000-0000-0000-000000000001", "name": "Account escalation" }
  ],
  "businessRules": [
    { "id": "44444444-0000-0000-0000-000000000001", "name": "Require main phone" }
  ],
  "summary": {
    "pluginSteps": 2,
    "cloudFlows": 2,
    "classicWorkflows": 1,
    "businessRules": 1,
    "total": 6
  }
}
```

Notes on the shape:

- `pluginSteps` is sorted by pipeline stage (`PreValidation` →
  `PreOperation` → `PostOperation`) then rank — the actual execution order.
- `uses` on a cloud flow is a subset of `["trigger", "action", "unknown"]`.
  `"unknown"` means the flow's definition could not be parsed as JSON but a
  substring scan still suggests it references the table.
- Up to 500 activated cloud-flow definitions are scanned; when that cap is
  hit the response carries `"flowsScanTruncated": true`.
- The four sections are failure-isolated: if one query fails (other than a
  privilege error), the response carries a `sectionNotes` array describing the
  skipped section and the other sections are still returned.
- When nothing is found at all, the response includes
  `"hint": "No active automation found on 'account' — check the logical name (singular, lowercase)."`

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "what_runs_on_table", "message": "...Pro tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that the tool needs read privileges on `SdkMessageProcessingStep`, `SdkMessageFilter` and Process (workflow) — e.g. the System Customizer role — and `docsUrl` pointing to the [business logic best practices](https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/). |
| HTTP 400 mentioning `primaryobjecttypecode` / invalid property | Error envelope with a hint to check the table logical name (singular, lowercase, e.g. `account`). |
| One section's query fails mid-run | Not an error envelope — the section comes back empty and `sectionNotes` explains what could not be scanned. |
| Table exists but has no automation | Normal result with all sections empty, `summary.total: 0` and the check-the-logical-name hint. |
