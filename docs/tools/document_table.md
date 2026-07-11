# document_table

Generates structured documentation for a Dataverse table from its
`EntityDefinitions` metadata:

- **Table header** — display name, schema name, description, ownership type,
  custom flag, primary id/name attributes.
- **Columns** — logical/schema name, attribute type, required level
  (`RequiredLevel.Value`), custom flag, display name and description (labels
  are resolved from `UserLocalizedLabel` with `LocalizedLabels[0]` fallback;
  descriptions are trimmed to 200 chars). `Virtual` attributes (formatted-value
  shadows such as `entityimage_url`) are excluded. Capped at 300 columns with a
  `columnsTruncated` flag.
- **Relationships** — one-to-many, many-to-one and many-to-many, plus alternate
  **keys**.
- **Automation** (optional) — count and top 10 active plug-in steps registered
  on the table, and active cloud flows whose definition references the table
  (substring heuristic over `workflow.clientdata`, singular or naive plural).
  Each automation sub-query is failure-isolated: a failure is reported in
  `sectionNotes` without sinking the metadata document.
- **`markdown`** — a ready-to-share document (title, overview, column table
  capped at 100 rows, relationship/key/automation sections), capped at 8000
  chars with an `…(truncated)` marker.

Pairs with `document_flow` for a "document my customization" suite.

**Tier: Pro** — requires the `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

| Name                | Type    | Required | Default | Description                                                                       |
| ------------------- | ------- | -------- | ------- | --------------------------------------------------------------------------------- |
| `table`             | string  | yes      | —       | Logical name of the table (singular lowercase, e.g. `account`, `new_project`).    |
| `includeAutomation` | boolean | no       | `true`  | Also summarize active plug-in steps and cloud flows that reference the table.     |

## Example call

```json
{
  "name": "document_table",
  "arguments": {
    "table": "account"
  }
}
```

## Example output

```json
{
  "table": {
    "logicalName": "account",
    "schemaName": "Account",
    "displayName": "Account",
    "description": "Business that represents a customer or potential customer.",
    "isCustom": false,
    "ownershipType": "UserOwned",
    "primaryId": "accountid",
    "primaryName": "name"
  },
  "columnCount": 7,
  "columns": [
    {
      "logicalName": "name",
      "schemaName": "Name",
      "type": "String",
      "displayName": "Account Name",
      "description": "Name of the company or business.",
      "required": "ApplicationRequired",
      "isCustom": false
    }
  ],
  "relationships": {
    "oneToMany": [
      {
        "schemaName": "contact_customer_accounts",
        "referencedEntity": "account",
        "referencingEntity": "contact",
        "referencingAttribute": "parentcustomerid"
      }
    ],
    "manyToOne": [
      {
        "schemaName": "account_primary_contact",
        "referencedEntity": "contact",
        "referencingAttribute": "primarycontactid"
      }
    ],
    "manyToMany": [
      {
        "schemaName": "accountleads_association",
        "entity1LogicalName": "account",
        "entity2LogicalName": "lead"
      }
    ]
  },
  "keys": [{ "name": "account_number_key", "attributes": ["accountnumber"] }],
  "automation": {
    "pluginSteps": {
      "count": 2,
      "top": [
        {
          "name": "Contoso.Plugins.AccountPlugin: Update of account",
          "message": "Update",
          "stage": "PreOperation",
          "mode": "sync"
        }
      ]
    },
    "cloudFlows": {
      "count": 2,
      "names": ["When an account is created, notify sales"]
    }
  },
  "markdown": "# Account\n\nSchema name: Account · Ownership: UserOwned · Standard table · Primary name: name\n\n## Overview\n..."
}
```

`columnsTruncated: true` appears when the table has more than 300 non-virtual
columns (the markdown table additionally caps at 100 rows and notes the
remainder). `sectionNotes: ["..."]` appears when an automation sub-query
failed while the rest of the document succeeded.

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "document_table", "message": "...Pro tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| Table not found (HTTP 404) | `{ "error": "Table not found: \"...\"", "hint": "Pass the table's logical name — singular and lowercase..." }` |
| Metadata query rejected (HTTP 400) | Error envelope with the Dataverse message and a hint that `EntityDefinitions` supports only a limited set of `$expand`/`$select` options, plus a `docsUrl` to the [metadata Web API docs](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query-metadata-web-api). |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message and a hint that documenting a table requires metadata read access (and, with `includeAutomation`, read on `SdkMessageProcessingStep`/Process), e.g. the System Customizer role. |
| Plug-in step or flow lookup fails | The table document is still returned; the failed section is omitted from `automation` and explained in `sectionNotes`. |
