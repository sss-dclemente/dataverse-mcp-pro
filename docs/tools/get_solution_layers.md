# get_solution_layers

Shows the solution layering of one component — the "who overwrote my form"
tool (sibling of `explain_import_failure`). Queries the `msdyn_componentlayer`
virtual table and lists every layer from the winning (top) layer down, so you
can see which solution's version of the component actually applies:

- **medium** — an unmanaged **Active** layer sits on top of one or more managed
  layers, so managed solution updates never reach the component.
- **low** — deep layering (more than 3 layers): the effective component depends
  on solution upgrade order, which is fragile.

The huge `msdyn_componentjson` column is never selected or returned.

**Tier: Pro** — requires the `LICENSE_KEY` environment variable. Without a
license the tool returns a friendly upgrade message instead of results.

## Inputs

Both inputs are required — the `msdyn_componentlayer` virtual table only
answers queries filtered on both the component type and the component id.

| Name            | Type          | Required | Description                                                                                                                                        |
| --------------- | ------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `componentType` | string        | yes      | Solution component type name exactly as the virtual table expects it, e.g. `Entity`, `Attribute`, `Workflow`, `SystemForm`, `SavedQuery`, `WebResource`. |
| `componentId`   | string (GUID) | yes      | GUID of the component itself (e.g. the `formid` of a SystemForm) — **not** the id of a solution.                                                     |

## Example call

```json
{
  "name": "get_solution_layers",
  "arguments": {
    "componentType": "SystemForm",
    "componentId": "12345678-1234-1234-1234-123456789abc"
  }
}
```

## Example output

```json
{
  "component": {
    "type": "SystemForm",
    "id": "12345678-1234-1234-1234-123456789abc",
    "name": "Account Main Form"
  },
  "layerCount": 3,
  "layers": [
    {
      "rank": 1,
      "solution": "Active",
      "publisher": "Default Publisher",
      "overwriteTime": "2026-05-14T09:30:00Z",
      "isActiveLayer": true
    },
    {
      "rank": 2,
      "solution": "ContosoSales",
      "publisher": "Contoso Ltd",
      "overwriteTime": "2026-02-01T12:00:00Z",
      "isActiveLayer": false
    },
    {
      "rank": 3,
      "solution": "ContosoBase",
      "publisher": "Contoso Ltd",
      "isActiveLayer": false
    }
  ],
  "findings": [
    {
      "severity": "medium",
      "issue": "Unmanaged 'Active' layer overrides 2 managed layer(s)",
      "recommendation": "Remove the unmanaged layer (Solution Layers > Remove active customizations) so managed solution updates reach this component"
    }
  ]
}
```

`rank` 1 is the winning (top) layer. `overwriteTime` is omitted when the layer
was never overwritten (Dataverse reports a null or 1900-01-01 sentinel). When
no layers match, the tool returns `layerCount: 0` plus a hint to check the
`componentType` spelling and that the id is the component's id, not the
solution's.

## Common errors

| Situation | Response |
| --------- | -------- |
| No `LICENSE_KEY` set | `{ "upgradeRequired": true, "tool": "get_solution_layers", "message": "...Pro tier...", "docsUrl": "..." }` — the tool never throws on a missing license. |
| No layers found | `{ "layerCount": 0, "layers": [], "findings": [], "hint": "No layers found — check the componentType spelling (e.g. Entity, SystemForm) and that the id is the component's id, not the solution's" }` |
| HTTP 404 from Dataverse | Error envelope with a hint that the `msdyn_componentlayer` virtual table is not available in this environment. |
| HTTP 400 from Dataverse | Error envelope with a hint that the virtual table requires **both** `msdyn_solutioncomponentname` and `msdyn_componentid` equality filters and an exact component type name (e.g. `Entity`, `SystemForm`). |
| HTTP 403 from Dataverse | Error envelope with the Dataverse message and a hint that reading solution layers requires customizer-level privileges (System Customizer role or equivalent), with `docsUrl` pointing to the [solution layers docs](https://learn.microsoft.com/power-apps/maker/data-platform/solution-layers). |
