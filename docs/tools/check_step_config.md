# check_step_config

Analyzes active plug-in step registrations (`SdkMessageProcessingStep`) for
common misconfigurations that cause performance problems, redundant executions,
and non-deterministic behavior:

- **high** — `Update` steps registered without filtering attributes (they fire
  on every column change).
- **medium** — synchronous `Create`/`Update` steps on high-volume entities
  (`activitypointer`, `annotation`).
- **medium** — rank collisions: two or more steps sharing message + entity +
  stage + rank, so their relative execution order is not guaranteed.
- **low** — `Update`/`Delete` steps without a pre-image (comparing old vs new
  values requires one).

Only **active** steps (`statecode eq 0`) are analyzed.

Part of the free, open-source tool set — no license key required.

## Inputs

At least one of the two inputs is required. If both are provided,
`pluginTypeName` wins.

| Name             | Type   | Required            | Description                                                                                          |
| ---------------- | ------ | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `pluginTypeName` | string | one of the two      | Plug-in type name, e.g. `Contoso.Plugins.AccountPlugin`. Matched exactly first, then as a substring. |
| `solutionName`   | string | one of the two      | Solution **unique name** (`uniquename`, not the display name). Analyzes all plug-in steps it contains. |

## Example call

```json
{
  "name": "check_step_config",
  "arguments": {
    "pluginTypeName": "Contoso.Plugins.AccountPlugin"
  }
}
```

## Example output

```json
{
  "stepsAnalyzed": 6,
  "findings": [
    {
      "severity": "high",
      "step": {
        "id": "aaaaaaaa-0000-0000-0000-000000000001",
        "name": "Contoso.Plugins.AccountPlugin: Update of account",
        "pluginType": "Contoso.Plugins.AccountPlugin",
        "message": "Update",
        "entity": "account",
        "stage": "PostOperation",
        "mode": "sync",
        "rank": 1,
        "filteringAttributes": null
      },
      "issue": "Update step without filtering attributes fires on every column change.",
      "recommendation": "Set filtering attributes so the step only runs when the columns it cares about change."
    },
    {
      "severity": "low",
      "step": {
        "id": "aaaaaaaa-0000-0000-0000-000000000003",
        "name": "Contoso.Plugins.AccountPlugin: Delete step",
        "pluginType": "Contoso.Plugins.AccountPlugin",
        "message": "Delete",
        "entity": "none",
        "stage": "PreValidation",
        "mode": "sync",
        "rank": 1,
        "filteringAttributes": null
      },
      "issue": "Delete step has no pre-image registered; comparing old vs new values requires one.",
      "recommendation": "Register a PreImage containing only the attributes the plug-in actually needs."
    }
  ]
}
```

Findings are sorted `high` → `medium` → `low`. When the scope matches no
plug-in type or the solution contains no steps, the tool returns
`{ "stepsAnalyzed": 0, "findings": [], "hint": "..." }`.

## Common errors

| Situation | Response |
| --------- | -------- |
| Neither input provided | `{ "error": "Provide pluginTypeName or solutionName", "hint": "..." }` |
| Solution unique name not found | `{ "error": "Solution not found: \"...\"", "hint": "Pass the solution's unique name (uniquename), not its display name..." }` |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that reading step registrations requires customizer-level read privileges on `SdkMessageProcessingStep`, and `docsUrl` pointing to the [business logic best practices](https://learn.microsoft.com/power-apps/developer/data-platform/best-practices/business-logic/). |
