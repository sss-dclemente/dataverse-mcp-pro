# check_flow_connections

Audits the health of Power Automate **connection references** and the active
cloud flows that use them. Broken or orphaned connections are the #1 silent
flow killer: an unbound reference or an expired connection of a departed user
does not show up until the flow fails at run time — often weeks later, in
production. This tool surfaces those problems before they bite:

- **high** — `unbound-connection-reference`: a connection reference with no
  connection bound that is used by at least one active flow. Those flows fail
  at run time.
- **medium** — `owner-disabled`: a connection reference (or an active flow)
  owned by a disabled user. Connections of departed users stop refreshing.
- **medium** — `owner-mismatch`: a connection reference owned by a different
  user than a flow using it. Owner changes or departures can silently break
  the flow; prefer service-account-owned shared references.
- **low** — `unused-connection-reference`: a bound reference used by none of
  the scanned active flows — a cleanup candidate.

Usage is detected by matching each reference's logical name against the flow
definition (`clientdata`) of up to `top` active, solution-aware cloud flows.
Up to 500 connection references are audited.

**Tier: Pro** — requires the `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

All inputs are optional.

| Name  | Type    | Required | Description                                              |
| ----- | ------- | -------- | -------------------------------------------------------- |
| `top` | integer | no       | Maximum number of active cloud flows to scan, 1–500 (default 200). When the cap is hit the response carries `"flowsTruncated": true`. |

## Example call

```json
{
  "name": "check_flow_connections",
  "arguments": {}
}
```

## Example output

```json
{
  "connectionReferences": 2,
  "flowsScanned": 2,
  "findings": [
    {
      "severity": "high",
      "kind": "unbound-connection-reference",
      "subject": {
        "type": "connectionReference",
        "id": "aaaaaaaa-0000-0000-0000-000000000001",
        "name": "Dataverse (Contoso)",
        "logicalName": "contoso_sharedcommondataservice_1a2b3",
        "owner": "Ana Silva"
      },
      "issue": "Connection reference \"Dataverse (Contoso)\" has no connection bound; 2 active flow(s) using it will fail at run time.",
      "recommendation": "Bind the connection reference to a valid connection (edit it under Solutions, or supply the connection during solution import).",
      "affectedFlows": [
        { "id": "bbbbbbbb-0000-0000-0000-000000000001", "name": "Notify sales team" },
        { "id": "bbbbbbbb-0000-0000-0000-000000000002", "name": "Escalate overdue cases" }
      ]
    },
    {
      "severity": "medium",
      "kind": "owner-disabled",
      "subject": {
        "type": "connectionReference",
        "id": "aaaaaaaa-0000-0000-0000-000000000002",
        "name": "Office 365 Outlook (Contoso)",
        "logicalName": "contoso_sharedoffice365_9z8y7",
        "owner": "Bruno Costa"
      },
      "issue": "Connection reference \"Office 365 Outlook (Contoso)\" is owned by disabled user \"Bruno Costa\"; connections of departed users stop refreshing.",
      "recommendation": "Reassign the connection reference (and its underlying connection) to an active user — ideally a service account."
    }
  ],
  "summary": {
    "unbound": 1,
    "ownerDisabled": 1,
    "ownerMismatch": 0,
    "unused": 0
  }
}
```

Findings are sorted `high` → `medium` → `low`. Owner ids that do not resolve
to a user (team-owned records, deleted users) are labeled `"team or unknown"`;
owner-based findings are skipped for them. When zero connection references
exist the tool returns
`{ "connectionReferences": 0, ..., "hint": "No connection references found — flows may use directly-bound connections (non-solution-aware)." }`.

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "check_flow_connections", "message": "...Pro tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| `connectionreferences` table not found (404/400) | Error envelope with a hint that connection references exist only in environments supporting solution-aware cloud flows, and `docsUrl` pointing to the [connection reference docs](https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference). |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message and a hint that auditing requires read privilege on the Connection Reference (`connectionreference`), Process (`workflow`) and User (`systemuser`) tables. |
| Anything else | Generic `{ "error": "..." }` envelope — raw exceptions never escape to the host. |
