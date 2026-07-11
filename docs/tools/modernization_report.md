# modernization_report

Governance deliverable: an inventory of deprecated/legacy automation still
active in the environment — what legacy tech still runs, where, and where to
start migrating. Queries the `workflow` (process) table once per category:

- **Classic workflows** (`category eq 0`) — background (async, `mode` 0) and
  real-time (sync, `mode` 1) workflows. Deprecated in favor of Power Automate
  cloud flows.
- **Dialogs** (`category eq 1`) — **removed** technology: dialogs were
  deprecated and removed from the product and no longer run reliably. Anything
  still active here is a high-severity finding.
- **Business rules** (`category eq 2`) — not deprecated, but a large active
  inventory signals a heavy client-logic footprint worth consolidating.
- **Business process flows** (`category eq 4`) — counted for context only
  (informational, not deprecated); no item list is returned.

Each category reports `total` and `active` (`statecode eq 1`) counts. Item
lists contain **active** processes only, sorted by `modifiedon` descending and
capped at `top` per category. Findings, sorted `high` → `low`:

- **high** — `active-dialogs`: any active dialog (migrate to canvas apps,
  Power Pages, or custom pages).
- **medium** — `active-classic-workflows`: any active classic workflow.
  Background workflows should move to cloud flows; real-time (sync) workflows
  need a plug-in or stay as-is. Evidence includes sync vs async counts.
- **low** — `classic-workflow-drafts`: more than 10 inactive classic
  workflows (cleanup candidate).
- **low** — `business-rules-inventory`: more than 25 active business rules
  (informational; consider consolidating).

Part of the free, open-source tool set — no license key required.

## Inputs

| Name  | Type    | Required | Default | Description                                          |
| ----- | ------- | -------- | ------- | ---------------------------------------------------- |
| `top` | integer | no       | 25      | Maximum active items listed per category, 5–100.     |

## Example call

```json
{
  "name": "modernization_report",
  "arguments": {
    "top": 25
  }
}
```

## Example output

```json
{
  "categories": {
    "classicWorkflows": {
      "total": 14,
      "active": 3,
      "syncActive": 1,
      "asyncActive": 2,
      "items": [
        {
          "id": "aaaa0000-0000-0000-0000-000000000002",
          "name": "Sync account owner (real-time)",
          "primaryEntity": "account",
          "mode": "real-time (sync)",
          "lastModified": "2026-06-01T12:00:00Z"
        }
      ]
    },
    "dialogs": {
      "total": 2,
      "active": 1,
      "items": [
        {
          "id": "bbbb0000-0000-0000-0000-000000000001",
          "name": "Case triage dialog",
          "primaryEntity": "incident",
          "lastModified": "2026-01-15T10:00:00Z"
        }
      ]
    },
    "businessRules": { "total": 30, "active": 30, "items": ["..."] },
    "businessProcessFlows": { "total": 2, "active": 2 }
  },
  "findings": [
    {
      "severity": "high",
      "flag": "active-dialogs",
      "issue": "1 active dialog(s) found. Dialogs were deprecated and removed from the product — they no longer run reliably.",
      "recommendation": "Migrate dialog functionality to canvas apps, Power Pages, or custom pages.",
      "evidence": { "activeDialogs": 1 }
    },
    {
      "severity": "medium",
      "flag": "active-classic-workflows",
      "issue": "3 active classic workflow(s) still run in this environment (1 real-time/sync, 2 background/async).",
      "recommendation": "Migrate background (async) workflows to Power Automate cloud flows. Real-time (sync) workflows have no direct cloud-flow equivalent — convert them to plug-ins or keep them as-is.",
      "evidence": { "activeClassicWorkflows": 3, "syncActive": 1, "asyncActive": 2 }
    }
  ]
}
```

When every category is empty the tool returns zeroed categories, no findings
and `"hint": "No legacy automation found — this environment is already modern."`.

Each category is scanned up to 500 rows; a category at the cap adds a
`truncationNotes` entry (totals may undercount).

## Common errors

| Situation | Response |
| --------- | -------- |
| HTTP 403 on the first (classic workflows) query | Error envelope with the Dataverse message, a hint that reading processes requires read privilege on the Process (`workflow`) table, and `docsUrl` pointing to [Replace classic workflows with flows](https://learn.microsoft.com/power-automate/replace-workflows-with-flows). |
| Any other failure on the first query | Generic error envelope `{ "error": "..." }`. |
| A later category query fails | The report is still returned; the failed category is zeroed and a `sectionNotes` entry records the failure (e.g. `"dialogs: query failed — ..."`). |
