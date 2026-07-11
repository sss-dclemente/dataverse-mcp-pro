import { z } from "zod";
import { defineTool } from "./types.js";
import {
  DataverseHttpError,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";

const TRACING_DOCS_URL =
  "https://learn.microsoft.com/power-apps/developer/data-platform/logging-tracing";
const SECURITY_DOCS_URL =
  "https://learn.microsoft.com/power-platform/admin/security-roles-privileges";

const TRACING_OFF_HINT =
  "Plug-in trace logging is off: get_plugin_traces, explain_trace and analyze_plugin_performance " +
  "will return nothing. Enable it under Settings > Administration > System Settings > Customization > " +
  '"Enable logging to plug-in trace log" (or set plugintracelogsetting to 1/Exception or 2/All).';

const TRACING_EXCEPTION_HINT =
  "Plug-in trace logging is set to Exception: only failing executions are captured, so " +
  "durations and performance analysis (analyze_plugin_performance) cover errors only.";

const TRACING_ALL_HINT =
  "Plug-in trace logging is set to All: every execution is captured — full visibility, but " +
  "trace storage counts against org capacity; consider Exception for steady state.";

const AUDIT_DISABLED_HINT =
  "Auditing is disabled: field-change history is unavailable (who changed what, and when).";

const inputSchema = z.object({});

const SELECT_FIELDS = [
  "organizationid",
  "name",
  "plugintracelogsetting",
  "isauditenabled",
  "auditretentionperiodv2",
  "isreadauditenabled",
  "isuseraccessauditenabled",
];

interface RawOrganization {
  organizationid?: string;
  name?: string | null;
  plugintracelogsetting?: number | null;
  isauditenabled?: boolean | null;
  auditretentionperiodv2?: number | null;
  isreadauditenabled?: boolean | null;
  isuseraccessauditenabled?: boolean | null;
}

function mapTraceSetting(value: number): string {
  switch (value) {
    case 0:
      return "off";
    case 1:
      return "exception";
    case 2:
      return "all";
    default:
      return String(value);
  }
}

function traceSettingHint(setting: string): string {
  switch (setting) {
    case "off":
      return TRACING_OFF_HINT;
    case "exception":
      return TRACING_EXCEPTION_HINT;
    case "all":
      return TRACING_ALL_HINT;
    default:
      return `Unrecognized plugintracelogsetting value ${setting}; expected 0 (off), 1 (exception) or 2 (all).`;
  }
}

export async function queryOrgAutomationSettings(
  client: Pick<DataverseClient, "get">,
): Promise<unknown> {
  try {
    // There is exactly one organization row per environment.
    const response = await client.get<{ value?: RawOrganization[] }>("organizations", {
      select: SELECT_FIELDS,
      top: 1,
    });

    const org = (response.value ?? [])[0];
    if (org === undefined) {
      return errorEnvelope("Organization record not readable", {
        hint:
          "The organizations query returned no rows. The connecting principal may lack read " +
          "access to the Organization table — verify it has a security role in this environment.",
        docsUrl: SECURITY_DOCS_URL,
      });
    }

    const hints: string[] = [];
    const result: Record<string, unknown> = { organization: org.name ?? null };

    // Older orgs may omit columns entirely — spread conditionally, never crash.
    if (org.plugintracelogsetting != null) {
      const setting = mapTraceSetting(org.plugintracelogsetting);
      const hint = traceSettingHint(setting);
      result["pluginTraceLog"] = {
        setting,
        hint,
        ...(setting === "off" ? { docsUrl: TRACING_DOCS_URL } : {}),
      };
      hints.push(hint);
    }

    if (org.isauditenabled != null) {
      const auditing: Record<string, unknown> = {
        enabled: org.isauditenabled,
        ...(org.auditretentionperiodv2 != null
          ? { retentionDays: org.auditretentionperiodv2 }
          : {}),
        ...(org.isreadauditenabled != null
          ? { readAuditEnabled: org.isreadauditenabled }
          : {}),
        ...(org.isuseraccessauditenabled != null
          ? { userAccessAuditEnabled: org.isuseraccessauditenabled }
          : {}),
      };
      if (org.isauditenabled === false) {
        auditing["hint"] = AUDIT_DISABLED_HINT;
        hints.push(AUDIT_DISABLED_HINT);
      }
      result["auditing"] = auditing;
    }

    result["hints"] = hints;
    return result;
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading org settings requires read privilege on the Organization table. Almost every " +
          "security role (including the basic user role) grants it — check that the connecting " +
          "principal has at least a basic user role in this environment.",
        docsUrl: SECURITY_DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const getOrgAutomationSettings = defineTool({
  name: "get_org_automation_settings",
  description:
    "Reads the org-level switches the other diagnostics tools depend on: plug-in trace log " +
    "setting (off/exception/all) and auditing configuration (enabled, retention, read/user-access " +
    "audit). Use this first to verify the switches before you chase ghosts. Free tier.",
  inputSchema,
  handler: async () => {
    try {
      return await queryOrgAutomationSettings(getDefaultClient());
    } catch (err) {
      return toErrorEnvelope(err);
    }
  },
});
