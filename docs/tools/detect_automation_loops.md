# detect_automation_loops

Detects suspected trigger→write loops between Power Automate cloud flows on
Dataverse tables — a classic source of runaway runs. Plugin↔flow ping-pong is
out of scope (this tool is definition-based and **cloud-flow only**). The tool
scans **activated** cloud flows (`workflow` rows with
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

## Why it used to hang, and what bounds it

A previous build issued **one** query for activated cloud flows with
`clientdata` in `$select`, and the Web API client had **no deadline**. On a
live org that query did not return for **840 seconds** even though the same
filter matched **one** flow (102 cloud flows, 101 of them drafts). Flow count
does not explain that, and lowering `maxFlows` would not have changed it.

What the code was doing, checked against that report:

- It does **not** follow `@odata.nextLink`. There is no unbounded page loop.
  `$top` is the list cap. If a response still carries a next link, the tool
  stops and sets `truncated` rather than walking it.
- The definition walk stops at depth 10. One flow cannot recurse forever.
- Cycle search only looks for cycles of length 2–3. One flow has nothing to
  traverse. A dense graph of hundreds of flows can still be expensive, so the
  search also stops when the scan budget is spent.

The list query now selects `workflowid` and `name` only. Each definition is
read by primary key (`workflows(id)?$select=clientdata`) under a **20 second**
request deadline. The whole scan stops at **60 seconds** (`timedOut`, plus
`flowsListed` for how many rows the list returned). A definition longer than
**4,000,000** characters, an HTTP body over twice that, or an action walk over
**25,000** nodes is skipped (`skippedOversized`) and is not reported as a loop
from a partial walk. These are guards on the same detection rules, not a new
algorithm. CI still does not call a live org, so a demo should wait until
someone has seen this return against one.

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
hit `maxFlows` rows, or when Dataverse returned an `@odata.nextLink` that this
tool refuses to follow. `timedOut: true` means the deadline stopped the scan;
`flowsListed` is then the list length, and `flowsScanned` is how many
definitions were actually finished. `skippedOversized` counts definitions the
size guard refused to analyse. `parseFailures` counts flows whose id was not a
GUID or whose `clientdata` was missing or not valid JSON; they are skipped,
never fatal. When nothing is suspected and the guards did not fire, the tool
returns `"hint": "No suspected loops detected among scanned flows"` plus a
`note` recommending `analyze_plugin_performance` depth flags for plugin-side
loops. A guard that fires replaces that hint with one that says the result is
partial — an empty `suspectedLoops` in that case is not "no loops in the org".

## Common errors

| Situation | Response |
| --------- | -------- |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that scanning flow definitions requires read privilege on the Process (workflow) table including `clientdata` (e.g. System Customizer), and `docsUrl` pointing to the [Dataverse trigger docs](https://learn.microsoft.com/power-automate/dataverse/create-update-delete-trigger). A 403 on a single definition read fails the call the same way — a privilege error must not look like "no loops". |
| The list query hits its deadline | Error envelope: the request timed out, with a hint that the list does not select `clientdata` and that lowering `maxFlows` is not the fix for a call that does not return. |
| A later definition read hits the deadline, or the 60s scan budget runs out | Partial success with `timedOut: true`. Loops found before the stop are kept. |
| Definition over the size guard | Counted in `skippedOversized` and omitted from `suspectedLoops`. |
| Flow with broken/empty `clientdata`, or an id that is not a GUID | Counted in `parseFailures` and skipped; the rest of the scan proceeds. The bad id is not requested. |
| Other failures | Generic `{ "error": "..." }` envelope; raw exceptions never escape to the host. |
