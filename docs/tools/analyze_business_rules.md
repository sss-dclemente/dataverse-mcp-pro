# analyze_business_rules

Answers one question about one table: **should these business rules become a
plug-in?** Reads every business rule on the table — activated *and* draft —
classifies each by whether its logic can run server-side at all, and where any
of it can, proposes the single plug-in step that would replace it.

Read-only. It proposes a step registration; it never creates one.

This is the follow-on to the `business-rules-inventory` finding from
[`modernization_report`](modernization_report.md), which counts business rules
org-wide and recommends consolidating them without being able to say which ones
can move.

Part of the free, open-source tool set — no license key required.

## What "portable" means

Business rule actions split by portability, per the
[business rule action table](https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-business-rules-recommendations-apply-logic-form):

| Action | Applies to | Verdict |
| ------ | ---------- | ------- |
| Set Field Value | All scopes | portable |
| Set Default Value | All scopes | portable |
| Show Error Message | All scopes | portable |
| Set Visibility | Model-driven app | form-only |
| Lock/Unlock | Model-driven app | form-only |
| Set Business Required | Model-driven app | form-only |
| Recommendation | Model-driven app | form-only |

> Actions that only apply to model-driven apps are ignored when the rule is run
> server-side.

So a plug-in can never replace visibility, lock, business-required or
recommendation logic. A rule that mixes both kinds is reported as `partial` and
must be split, not moved.

## Scope: `processtriggerscope`, not `scope`

Scope comes from `workflow.processtriggerscope` (`1` = Form, `2` = Entity).
This is **not** `workflow.scope`, which is ownership (User / Business Unit /
Parent:Child / Organization) and would misreport every rule.

The distinction matters because **entity-scoped rules already run server-side**.
"Business rules only run on the form" is true only for form-scoped ones, so the
case for a plug-in usually rests on capability, not on coverage.

## Inputs

| Name    | Type   | Required | Description |
| ------- | ------ | -------- | ----------- |
| `table` | string | yes      | Logical name of the table, e.g. `account` (singular, lowercase — not the display name or plural entity-set name). Trimmed and lowercased before querying. |

## Example call

```json
{
  "name": "analyze_business_rules",
  "arguments": {
    "table": "account"
  }
}
```

## Example output

```json
{
  "table": "account",
  "summary": {
    "total": 4,
    "activated": 3,
    "inactive": 1,
    "entityScoped": 1,
    "formScoped": 2,
    "portable": 1,
    "partial": 1,
    "formOnly": 1,
    "unclassified": 0
  },
  "rules": [
    {
      "id": "aaaa0000-0000-0000-0000-000000000003",
      "name": "Credit hold enforcement",
      "state": "activated",
      "scope": "form",
      "formId": "ffff0000-0000-0000-0000-0000000000f1",
      "isManaged": true,
      "lastModified": "2026-05-04T08:00:00Z",
      "actions": ["Set Field Value", "Set Business Required"],
      "fieldsReferenced": ["creditlimit", "industrycode"],
      "verdict": "partial"
    },
    {
      "id": "aaaa0000-0000-0000-0000-000000000001",
      "name": "Credit limit default",
      "state": "activated",
      "scope": "entity",
      "formId": null,
      "isManaged": false,
      "lastModified": "2026-05-02T08:00:00Z",
      "actions": ["Set Default Value"],
      "fieldsReferenced": ["creditlimit"],
      "verdict": "portable"
    }
  ],
  "findings": [
    {
      "severity": "medium",
      "flag": "overlapping-fields",
      "issue": "1 column(s) are referenced by more than one activated business rule: creditlimit (2 rules). Rules that touch the same column can contradict each other, and their relative order is not guaranteed.",
      "recommendation": "Review these columns first — merging the rules that share one column is usually a bigger win than moving logic to a plug-in.",
      "evidence": { "contestedColumns": 1 }
    }
  ],
  "pluginProposal": {
    "messages": ["Create", "Update"],
    "stage": "PreOperation",
    "mode": "sync",
    "filteringAttributes": ["creditlimit", "industrycode"],
    "replaces": ["Credit limit default"],
    "partiallyReplaces": [
      {
        "rule": "Credit hold enforcement",
        "formOnlyActionsThatMustStay": ["Set Business Required"]
      }
    ],
    "staysDeclarative": [
      {
        "rule": "Hide phone for on-hold accounts",
        "reason": "Only form-only actions (Set Visibility) — a plug-in cannot do these."
      }
    ],
    "note": "One step, not one per rule: the filtering attributes are what keep it cheap. 1 of these rules are managed and cannot be deactivated in this environment without an update to their solution. Deactivate the replaced rules in the same deployment as the plug-in, or both will run."
  }
}
```

Notes on the shape:

- `rules` is sorted by name and includes **draft rules** — unlike
  `what_runs_on_table`, which lists activated rules only. Inactive rules inflate
  the apparent size of the problem and are usually the first thing to delete.
- `summary` counts describe **activated** rules only, except `total` and
  `inactive`.
- `fieldsReferenced` is resolved by intersecting the table's real column logical
  names with the stored rule definition. It does not distinguish reads from
  writes.
- `pluginProposal` is omitted entirely when nothing is portable; a `hint`
  then explains that the pile is UI behaviour a plug-in cannot replace.
- Up to 200 rules are read; when that cap is hit the response carries
  `"truncated": true`.

## Findings

| Flag | Severity | Meaning |
| ---- | -------- | ------- |
| `overlapping-fields` | medium | A column is referenced by two or more activated rules. Usually the real cause of the pain — rule order is not guaranteed. |
| `form-scope-only` | medium | Activated rules carry data logic but are form-scoped, so they do not run on API writes, imports or flows. That logic is not enforced today. |
| `mixed-verdict-rule` | low | A rule mixes data actions with form-only actions and cannot move wholesale. |
| `draft-rules` | low | Rules on the table are not activated. |
| `unclassified-rules` | low | No recognisable action was found in the stored definition. Classify these by hand. |

## Limits

- **One table per call.** It does not sweep an environment.
- **Actions are detected by marker** against the stored rule definition
  (`clientdata`, falling back to `xaml`). The definition format is not
  documented, so a rule whose definition cannot be recognised is reported with
  `"verdict": "unknown"` and `"actionsUnknown": true` rather than being dropped
  or guessed at. Verify the classification in the maker portal before quoting a
  consolidation scope.
- `isManaged` is read from the rule record itself. The tool makes no claim about
  solution layers below it — use [`get_solution_layers`](get_solution_layers.md).

## Common errors

| Situation | Response |
| --------- | -------- |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message and a hint that the tool needs read privileges on the Process (workflow) table and entity metadata — e.g. the System Customizer role. |
| HTTP 404 on the metadata query | Error envelope with a hint that no table has that logical name, and to use the singular lowercase form. The rule query does not run. |
| Table exists but has no business rules | Normal result with `summary.total: 0`, empty `findings`, and a `hint`. Not an error. |
| Every rule is form-only | Normal result with no `pluginProposal` and a hint explaining that a plug-in cannot replace UI behaviour. |
| No columns returned for the table | Normal result; `sectionNotes` explains that fields could not be resolved. Classification still works. |
