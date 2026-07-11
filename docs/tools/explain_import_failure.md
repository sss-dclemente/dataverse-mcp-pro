# explain_import_failure

Explains why a Dataverse solution import failed. Reads the import job record
(`importjobs`), parses the `importexportxml` result document stored in its
`data` column, and returns:

- every failed component with its type, schema name, error code, a truncated
  error text excerpt, and a **plain-language cause** from a built-in error-code
  knowledge table (missing dependencies, incompatible versions, unmanaged layer
  conflicts, duplicate names, generic SQL errors);
- for missing-dependency failures, the missing component and — when the error
  text names it — the solution that **provides** it (`providedBy`);
- a `resolutionOrder`: deduplicated plain-language steps with all
  missing-dependency fixes **first**, followed by the remaining component fixes
  in file order.

Unknown error codes fall back to the first 300 characters of the raw error text
as the cause. Warnings are counted (`warningCount`) but do not appear as failed
components.

Part of the free, open-source tool set — no license key required.

## Inputs

At least one of the two inputs is required. If both are provided,
`importJobId` wins.

| Name           | Type          | Required       | Description                                                                                     |
| -------------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `importJobId`  | string (UUID) | one of the two | GUID of the import job (`importjobid`) to explain.                                              |
| `solutionName` | string        | one of the two | Solution **unique name** (`uniquename`, not the display name). Analyzes its most recent import. |

## Example call

```json
{
  "name": "explain_import_failure",
  "arguments": {
    "solutionName": "ContosoSales"
  }
}
```

## Example output

```json
{
  "importJobId": "aaaaaaaa-1111-2222-3333-444444444444",
  "solutionName": "ContosoSales",
  "progress": 87.5,
  "startedon": "2026-07-01T09:15:00Z",
  "completedon": "2026-07-01T09:21:42Z",
  "failedCount": 2,
  "warningCount": 1,
  "failedComponents": [
    {
      "componentType": "entity",
      "schemaName": "contoso_widget",
      "errorCode": "0x80048264",
      "errorText": "The dependent component Entity \"contoso_gadget\" does not exist. Missing component: contoso_gadget. The missing component is provided by solution \"Contoso Base\" & must be installed first.",
      "cause": "The component references another component that is not present in the target environment (missing dependency).",
      "advice": "Import or update solution 'Contoso Base' first — it provides 'contoso_gadget'.",
      "providedBy": "Contoso Base"
    },
    {
      "componentType": "webresource",
      "schemaName": "contoso_/scripts/main.js",
      "errorCode": "0x8004f036",
      "errorText": "An unmanaged layer exists for web resource \"contoso_/scripts/main.js\" & blocks the managed import.",
      "cause": "The component exists in an unmanaged customization layer that blocks the incoming managed change.",
      "advice": "Remove the unmanaged layer from the component (see solution layers in the maker portal) or merge the customization into the solution, then re-import."
    }
  ],
  "resolutionOrder": [
    "Import or update solution 'Contoso Base' which provides 'contoso_gadget'.",
    "Fix webresource 'contoso_/scripts/main.js': Remove the unmanaged layer from the component (see solution layers in the maker portal) or merge the customization into the solution, then re-import."
  ]
}
```

When the import has no failed components the tool returns
`failedCount: 0`, empty `failedComponents`/`resolutionOrder`, and a `hint`:
`"Import completed without component failures."` at `progress` 100, or
`"No failed components recorded yet — the import may still be running (progress N%)."`
below 100.

## Common errors

| Situation | Response |
| --------- | -------- |
| Neither input provided | `{ "error": "Provide importJobId or solutionName", "hint": "..." }` |
| Import job GUID not found (HTTP 404) | `{ "error": "Import job not found: ...", "hint": "Check the importjobid GUID. Import job records are purged over time..." }` |
| No import job for the solution | `{ "error": "No import job found for solution \"...\"", "hint": "Pass the solution's unique name (uniquename), not its display name. Import job records are also purged over time..." }` |
| Job still running / no result XML yet | `{ "error": "Import job contains no parseable result data", "hint": "The import may still be running (progress N%)..." }` |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message, a hint that reading import jobs requires read privilege on the `ImportJob` table (System Customizer/Administrator), and `docsUrl` pointing to the [solutions overview](https://learn.microsoft.com/power-apps/maker/data-platform/solutions-overview). |
