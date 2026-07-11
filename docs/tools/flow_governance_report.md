# flow_governance_report

Ownership and state inventory of the solution-aware Power Automate cloud flows
stored in Dataverse (`workflows` where `category eq 5 and type eq 1`) — the
"the person left and their flows died" audit. It reports state counts, an
owner table, and governance findings:

- **high** — activated flow owned by a **disabled user**: its connections and
  runs will start failing. Reassign it.
- **medium** — **suspended** flow: suspensions usually come from billing
  issues, DLP policy violations or repeated failures. Investigate and resume.
- **low** — **stale draft**: a draft flow not modified for `staleDraftDays`
  days — a cleanup candidate.
- **low** — **owner concentration**: one owner owns at least
  `ownerConcentrationThreshold` flows — bus-factor risk; prefer service
  accounts and co-owners.

Flow state is mapped defensively: `statecode` 0/1/2 →
`draft`/`activated`/`suspended`; the suspended encoding varies across
Dataverse versions, so `statuscode` is used as a fallback signal with the same
mapping, and suspended findings expose both raw codes. Owners that are not
system users (teams, deleted users) are reported as `"team or unknown"`.

**Tier: Enterprise** — requires an Enterprise `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

Both inputs are optional.

| Name                          | Type    | Required | Default | Description                                                                 |
| ----------------------------- | ------- | -------- | ------- | --------------------------------------------------------------------------- |
| `staleDraftDays`              | integer | no       | 90      | Draft flows not modified for this many days are flagged as stale (7–365).   |
| `ownerConcentrationThreshold` | integer | no       | 20      | Flag owners who own at least this many flows as a bus-factor risk (5–200).  |

## Example call

```json
{
  "name": "flow_governance_report",
  "arguments": {
    "staleDraftDays": 60,
    "ownerConcentrationThreshold": 15
  }
}
```

## Example output

```json
{
  "totalFlows": 23,
  "activated": 21,
  "draft": 1,
  "suspended": 1,
  "managed": 1,
  "findings": [
    {
      "severity": "high",
      "flow": {
        "id": "aaaaaaaa-0000-0000-0000-000000000001",
        "name": "Send welcome email"
      },
      "owner": "Dana Departed",
      "issue": "Activated flow is owned by disabled user \"Dana Departed\"; its connections and runs will start failing.",
      "recommendation": "Reassign the flow (and its connection references) to an active user or service account."
    },
    {
      "severity": "medium",
      "flow": {
        "id": "aaaaaaaa-0000-0000-0000-000000000002",
        "name": "Sync invoices to ERP"
      },
      "owner": "Ana Active",
      "issue": "Flow is suspended (statecode 2, statuscode 2); suspensions usually come from billing issues, DLP policy violations or repeated failures.",
      "recommendation": "Investigate the suspension reason in Power Automate and resume the flow once resolved."
    },
    {
      "severity": "low",
      "owner": "Bob Busy",
      "issue": "Owner \"Bob Busy\" owns 20 of 23 solution cloud flows (threshold 20); a single departure or disabled account puts all of them at risk.",
      "recommendation": "Move business-critical flows to a service account and add co-owners to reduce bus-factor risk."
    }
  ],
  "ownerTable": [
    { "owner": "Bob Busy", "isDisabled": false, "flows": 20, "activated": 20 },
    { "owner": "Ana Active", "isDisabled": false, "flows": 2, "activated": 0 },
    { "owner": "Dana Departed", "isDisabled": true, "flows": 1, "activated": 1 }
  ]
}
```

Findings are sorted `high` → `medium` → `low`. The owner table is sorted by
flow count descending and capped at 25 rows; `isDisabled` is omitted for
owners that are not system users. When more than 1000 flows exist, only the
first 1000 are analyzed and the report carries `"truncated": true`.

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "flow_governance_report", "message": "...Enterprise tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| No solution cloud flows in the org | Zeroed counts with `"hint": "No solution cloud flows found (category 5). ..."` — non-solution flows are not stored in the Dataverse `workflows` table. |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that the report requires read privilege on the Process (`workflow`) table plus `SystemUser` for owner lookups, and `docsUrl` pointing to the [solution flows overview](https://learn.microsoft.com/power-automate/overview-solution-flows). |
| Other Dataverse/network failure | Generic error envelope `{ "error": "..." }` — raw exceptions never escape to the host. |
