# get_org_automation_settings

Reads the organization-level switches (`organizations` table) that the other
diagnostics tools depend on: the plug-in trace log setting and the auditing
configuration. Verify the switches before you chase ghosts — if trace logging
is off, `get_plugin_traces`, `explain_trace` and `analyze_plugin_performance`
will return nothing no matter how broken the plug-in is, and if auditing is off
there is no field-change history to consult.

**Tier:** Free

## Inputs

None — the tool takes an empty object.

## Example call

```json
{}
```

## Example output

```json
{
  "organization": "Contoso Production",
  "pluginTraceLog": {
    "setting": "all",
    "hint": "Plug-in trace logging is set to All: every execution is captured — full visibility, but trace storage counts against org capacity; consider Exception for steady state."
  },
  "auditing": {
    "enabled": true,
    "retentionDays": 30,
    "readAuditEnabled": true,
    "userAccessAuditEnabled": true
  },
  "hints": [
    "Plug-in trace logging is set to All: every execution is captured — full visibility, but trace storage counts against org capacity; consider Exception for steady state."
  ]
}
```

`pluginTraceLog.setting` is `"off"` (0), `"exception"` (1) or `"all"` (2);
unknown values are returned as their numeric string. When the setting is
`"off"` the entry carries a `docsUrl` and an enable hint:

```json
{
  "organization": "Contoso Dev",
  "pluginTraceLog": {
    "setting": "off",
    "hint": "Plug-in trace logging is off: get_plugin_traces, explain_trace and analyze_plugin_performance will return nothing. Enable it under Settings > Administration > System Settings > Customization > \"Enable logging to plug-in trace log\" (or set plugintracelogsetting to 1/Exception or 2/All).",
    "docsUrl": "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing"
  },
  "auditing": {
    "enabled": false,
    "hint": "Auditing is disabled: field-change history is unavailable (who changed what, and when)."
  },
  "hints": [
    "Plug-in trace logging is off: ...",
    "Auditing is disabled: field-change history is unavailable (who changed what, and when)."
  ]
}
```

`hints` aggregates every actionable hint in one place. Optional columns that an
older org does not return (`auditretentionperiodv2`, `isreadauditenabled`,
`isuseraccessauditenabled`, even `plugintracelogsetting`) are simply omitted
from the output rather than reported as errors.

## Common errors

**403 — missing privilege**

Almost every security role, including the basic user role, can read the
Organization table, so a 403 usually means the connecting principal has no
security role at all in the environment:

```json
{
  "error": "Principal user (...) is missing prvReadOrganization privilege",
  "hint": "Reading org settings requires read privilege on the Organization table. Almost every security role (including the basic user role) grants it — check that the connecting principal has at least a basic user role in this environment.",
  "docsUrl": "https://learn.microsoft.com/power-platform/admin/security-roles-privileges"
}
```

**Empty result — organization row not readable**

```json
{
  "error": "Organization record not readable",
  "hint": "The organizations query returned no rows. The connecting principal may lack read access to the Organization table — verify it has a security role in this environment.",
  "docsUrl": "https://learn.microsoft.com/power-platform/admin/security-roles-privileges"
}
```
