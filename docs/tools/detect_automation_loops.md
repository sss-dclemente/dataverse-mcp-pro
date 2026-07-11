# detect_automation_loops

Detects suspected trigger→write loops between Power Automate cloud flows on
Dataverse tables — a classic source of runaway runs and infinite plugin↔flow
ping-pong. The tool scans **activated** cloud flows (`workflow` rows with
`category eq 5 and type eq 1 and statecode eq 1`), parses each flow's stored
definition (`clientdata`), and builds a graph of "flow A writes the table flow
B triggers on":

- **self-loop** — a flow writes the same table it triggers on.
  - **high** when the trigger has no filtering attributes and no trigger
    conditions (every write can re-fire the flow).
  - **medium** when filtering attributes or trigger conditions are set (risk
    is reduced, not eliminated).
- **cycle** (**medium**) — 2 or 3 flows whose writes trigger each other
  (A→B→A or A→B→C→A). Each cycle is reported once.

The analysis is **heuristic and definition-based**: it looks at trigger entity
names and Dataverse write actions (`CreateRecord`, `UpdateRecord`,
`UpdateOnlyRecord`, `UpsertRecord`, `DeleteRecord`), including actions nested
inside Scope/Condition/Switch containers. It cannot see runtime behavior, and
it does not know about plug-in steps — plug-in-side loops surface as depth
flags in `analyze_plugin_performance`, and `what_runs_on_table` shows all
automation registered on a table. Use the three together to cover plugin↔flow
ping-pong.

Part of the free, open-source tool set — no license key required.

## Inputs

| Name       | Type    | Required | Default | Description                                                                                    |
| ---------- | ------- | -------- | ------- | ---------------------------------------------------------------------------------------------- |
| `maxFlows` | integer | no       | `500`   | Maximum number of activated cloud flows to scan, 10–1000. When hit, the result is flagged `truncated`. |

## Example call

```json
{
  "name": "detect_automation_loops",
  "arguments": {
    "maxFlows": 500
  }
}
```

## Example output

```json
{
  "flowsScanned": 42,
  "flowsWithDataverseTrigger": 17,
  "suspectedLoops": [
    {
      "severity": "high",
      "kind": "self-loop",
      "flows": [
        { "id": "aaaaaaaa-0000-0000-0000-000000000001", "name": "Auto-update accounts" }
      ],
      "tables": ["account"],
      "evidence": "Flow \"Auto-update accounts\" triggers on account and writes to account without trigger filtering attributes or trigger conditions.",
      "recommendation": "Add trigger filtering attributes or a trigger condition so the flow does not re-fire on its own writes, or break the loop with a guard column the flow checks before writing. Plug-in steps on the same table can extend the loop — check them with what_runs_on_table."
    },
    {
      "severity": "medium",
      "kind": "cycle",
      "flows": [
        { "id": "bbbbbbbb-0000-0000-0000-000000000001", "name": "Contact touch" },
        { "id": "bbbbbbbb-0000-0000-0000-000000000002", "name": "Opportunity touch" }
      ],
      "tables": ["contact", "opportunity"],
      "evidence": "\"Contact touch\" triggers on contact and writes to opportunity → \"Opportunity touch\" triggers on opportunity and writes to contact → back to the start.",
      "recommendation": "Break the chain by adding trigger filtering attributes or trigger conditions to at least one flow, or introduce a guard column that stops the hand-off. Plug-in steps on these tables can extend the cycle — check each table with what_runs_on_table."
    }
  ],
  "parseFailures": 1
}
```

Loops are sorted `high` → `medium`. `truncated: true` is added when the scan
hit `maxFlows` rows (rerun with a larger `maxFlows`, or accept that later flows
were not scanned). `parseFailures` counts flows whose `clientdata` was missing
or not valid JSON; they are skipped, never fatal. When nothing is suspected the
tool returns
`"hint": "No suspected loops detected among scanned flows"` plus a `note`
recommending `analyze_plugin_performance` depth flags for plugin-side loops.

## Common errors

| Situation | Response |
| --------- | -------- |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that scanning flow definitions requires read privilege on the Process (workflow) table including `clientdata` (e.g. System Customizer), and `docsUrl` pointing to the [Dataverse trigger docs](https://learn.microsoft.com/power-automate/dataverse/create-update-delete-trigger). |
| Flow with broken/empty `clientdata` | Counted in `parseFailures` and skipped; the rest of the scan proceeds. |
| Other failures | Generic `{ "error": "..." }` envelope; raw exceptions never escape to the host. |
