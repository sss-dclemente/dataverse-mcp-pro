import { z } from "zod";
import { defineTool } from "./types.js";
import { errorEnvelope, toErrorEnvelope } from "../errors.js";
import {
  DataverseHttpError,
  escapeODataString,
  getDefaultClient,
  type DataverseClient,
} from "../dataverse/client.js";

const SOLUTIONS_DOCS_URL =
  "https://learn.microsoft.com/power-apps/maker/data-platform/solutions-overview";

const inputSchema = z.object({
  importJobId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "GUID of the import job (importjobid) to explain. Wins over solutionName when both are provided.",
    ),
  solutionName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Solution unique name (uniquename, not the display name); the most recent " +
        "import job for that solution is analyzed.",
    ),
});

export type ExplainImportFailureInput = z.infer<typeof inputSchema>;

interface ListResponse<T> {
  value: T[];
}

interface RawImportJob {
  importjobid: string;
  solutionname?: string | null;
  progress?: number | null;
  startedon?: string | null;
  completedon?: string | null;
  data?: string | null;
  createdon?: string | null;
}

const IMPORT_JOB_SELECT = [
  "importjobid",
  "solutionname",
  "progress",
  "startedon",
  "completedon",
  "data",
  "createdon",
];

// ---------------------------------------------------------------------------
// importexportxml result parsing (targeted regex — no XML parser dependency)
// ---------------------------------------------------------------------------

// Component elements of the import result XML that carry a name/id and wrap a
// <result .../> node. Plural wrappers like <entities> never match: the word
// boundary after the tag name rejects trailing characters.
const COMPONENT_TAGS = [
  "entity",
  "attribute",
  "relationship",
  "optionset",
  "webresource",
  "workflow",
  "sdkmessageprocessingstep",
  "pluginassembly",
  "role",
  "savedquery",
  "form",
  "sitemap",
  "ribbon",
] as const;

const COMPONENT_TAG_RE = new RegExp(
  `<(${COMPONENT_TAGS.join("|")})\\b([^>]*)>`,
  "gi",
);

const RESULT_TAG_RE = /<result\b([^>]*?)\/?>/gi;

/** Decode the five predefined XML entities; &amp; last to avoid double-decoding. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extract one attribute value from a tag's raw attribute text. */
function attrValue(attrs: string, name: string): string | undefined {
  const match = attrs.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : decodeXmlEntities(raw);
}

interface ParsedFailure {
  componentType: string;
  schemaName: string;
  /** Lowercased hex code, e.g. "0x80048264". */
  errorCode: string;
  /** Entity-decoded, untruncated error text. */
  errorText: string;
}

interface ParsedJobData {
  failures: ParsedFailure[];
  warningCount: number;
  resultCount: number;
}

function parseJobData(data: string): ParsedJobData {
  const components: Array<{ index: number; tag: string; attrs: string }> = [];
  for (const match of data.matchAll(COMPONENT_TAG_RE)) {
    components.push({
      index: match.index ?? 0,
      tag: (match[1] ?? "").toLowerCase(),
      attrs: match[2] ?? "",
    });
  }

  const failures: ParsedFailure[] = [];
  let warningCount = 0;
  let resultCount = 0;
  for (const match of data.matchAll(RESULT_TAG_RE)) {
    resultCount += 1;
    const attrs = match[1] ?? "";
    const outcome = (attrValue(attrs, "result") ?? "").toLowerCase();
    if (outcome === "warning") {
      warningCount += 1;
      continue;
    }
    if (outcome !== "failure") continue;

    // The owning component is the nearest opening component tag before this
    // <result>; components list is already in document order.
    const resultIndex = match.index ?? 0;
    let owner: { tag: string; attrs: string } | undefined;
    for (const component of components) {
      if (component.index >= resultIndex) break;
      owner = component;
    }

    failures.push({
      componentType: owner?.tag ?? "unknown",
      schemaName:
        owner === undefined
          ? "unknown"
          : (attrValue(owner.attrs, "name") ??
            attrValue(owner.attrs, "localizedname") ??
            attrValue(owner.attrs, "id") ??
            "unknown"),
      errorCode: (attrValue(attrs, "errorcode") ?? "").toLowerCase(),
      errorText: attrValue(attrs, "errortext") ?? "",
    });
  }
  return { failures, warningCount, resultCount };
}

// ---------------------------------------------------------------------------
// Error-code knowledge table
// ---------------------------------------------------------------------------

const MISSING_DEPENDENCY_CODE = "0x80048264";

interface KnownErrorCode {
  /** Lowercased hex error code as it appears in the result node. */
  code: string;
  cause: string;
  advice: string;
}

// Extensible knowledge table mapping Dataverse import error codes to
// plain-language causes and advice. Codes are stored lowercased.
const ERROR_CODE_TABLE: KnownErrorCode[] = [
  // Missing dependency: the component references another component (entity,
  // attribute, option set, web resource, ...) that is absent from the target org.
  {
    code: MISSING_DEPENDENCY_CODE,
    cause:
      "The component references another component that is not present in the " +
      "target environment (missing dependency).",
    advice:
      "Import or update the solution that provides the missing component before " +
      "importing this solution.",
  },
  // Solution/component version incompatible: the target org already holds a
  // newer (or otherwise incompatible) version than the one being imported.
  {
    code: "0x80048541",
    cause:
      "The target environment already contains a newer or incompatible version " +
      "of this solution or component.",
    advice:
      "Align the versions — export a higher solution version from the source " +
      "environment, or apply the changes as an update instead of a fresh import.",
  },
  // Managed/unmanaged layer conflict: an unmanaged customization layer on the
  // component blocks the incoming managed change.
  {
    code: "0x8004f036",
    cause:
      "The component exists in an unmanaged customization layer that blocks the " +
      "incoming managed change.",
    advice:
      "Remove the unmanaged layer from the component (see solution layers in the " +
      "maker portal) or merge the customization into the solution, then re-import.",
  },
  // Duplicate name: a different component with the same schema name already
  // exists in the target environment.
  {
    code: "0x80040237",
    cause:
      "A different component with the same name already exists in the target " +
      "environment (duplicate name).",
    advice:
      "Rename or remove the conflicting component in the target environment, " +
      "then re-run the import.",
  },
  // Generic SQL error: a database-level failure inside Dataverse, often
  // transient (timeout/deadlock) or caused by inconsistent rows.
  {
    code: "0x80044150",
    cause:
      "Dataverse hit a database-level failure (generic SQL error) while " +
      "importing the component; this is often transient.",
    advice:
      "Retry the import; if it keeps failing, check the component for orphaned " +
      "or inconsistent data and contact support with the import job id.",
  },
];

// Patterns used to pull the missing component's name out of a missing-dependency
// errortext, e.g. "Missing component: contoso_gadget." or
// 'The dependent component "contoso_gadget" does not exist'.
const MISSING_NAME_RES = [
  /missing component[:\s]+["']?([\w][\w .-]*?)["']?(?:[.,;]|$)/i,
  /dependent component ["']([^"']+)["']/i,
];

// Pattern for the providing solution when the errortext names it, e.g.
// 'is provided by solution "Contoso Base"'.
const PROVIDED_BY_RE = /provided by (?:the )?solution[:\s]+["']([^"']+)["']/i;

function extractMissingDependency(errorText: string): {
  missing: string | undefined;
  providedBy: string | undefined;
} {
  let missing: string | undefined;
  for (const re of MISSING_NAME_RES) {
    const match = errorText.match(re);
    if (match?.[1] !== undefined) {
      missing = match[1].trim();
      break;
    }
  }
  return { missing, providedBy: errorText.match(PROVIDED_BY_RE)?.[1] };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

const ERROR_TEXT_MAX = 300;

interface FailedComponent {
  componentType: string;
  schemaName: string;
  errorCode: string;
  errorText: string;
  cause: string;
  advice?: string;
  providedBy?: string;
}

interface EnrichedFailure {
  component: FailedComponent;
  isDependency: boolean;
  missing: string | undefined;
  providedBy: string | undefined;
}

function enrichFailure(failure: ParsedFailure): EnrichedFailure {
  const known = ERROR_CODE_TABLE.find((entry) => entry.code === failure.errorCode);
  const isDependency = failure.errorCode === MISSING_DEPENDENCY_CODE;
  const { missing, providedBy } = isDependency
    ? extractMissingDependency(failure.errorText)
    : { missing: undefined, providedBy: undefined };

  const advice =
    isDependency && providedBy !== undefined
      ? `Import or update solution '${providedBy}' first — it provides '${missing ?? "the missing component"}'.`
      : known?.advice;

  const cause =
    known?.cause ??
    (failure.errorText === ""
      ? `Unrecognized error code ${failure.errorCode}.`
      : failure.errorText.slice(0, ERROR_TEXT_MAX));

  const component: FailedComponent = {
    componentType: failure.componentType,
    schemaName: failure.schemaName,
    errorCode: failure.errorCode,
    errorText: failure.errorText.slice(0, ERROR_TEXT_MAX),
    cause,
    ...(advice !== undefined ? { advice } : {}),
    ...(providedBy !== undefined ? { providedBy } : {}),
  };
  return { component, isDependency, missing, providedBy };
}

/**
 * Plain-language steps, dependencies first: every distinct missing-dependency
 * fix precedes the remaining per-component fixes (kept in file order),
 * deduplicated by step text.
 */
function buildResolutionOrder(enriched: EnrichedFailure[]): string[] {
  const dependencySteps: string[] = [];
  const otherSteps: string[] = [];
  const seen = new Set<string>();
  for (const entry of enriched) {
    let step: string;
    let bucket: string[];
    if (entry.isDependency) {
      const missing = entry.missing ?? entry.component.schemaName;
      step =
        entry.providedBy !== undefined
          ? `Import or update solution '${entry.providedBy}' which provides '${missing}'.`
          : `Import or update the solution that provides '${missing}'.`;
      bucket = dependencySteps;
    } else {
      step = `Fix ${entry.component.componentType} '${entry.component.schemaName}': ${entry.component.advice ?? entry.component.cause}`;
      bucket = otherSteps;
    }
    if (!seen.has(step)) {
      seen.add(step);
      bucket.push(step);
    }
  }
  return [...dependencySteps, ...otherSteps];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function explainImportFailure(
  client: Pick<DataverseClient, "get">,
  input: ExplainImportFailureInput,
): Promise<unknown> {
  const { importJobId, solutionName } = input;
  // The MCP server registers inputSchema.shape, so an object-level .refine()
  // would not be enforced at the transport. Guard here instead.
  if (importJobId === undefined && solutionName === undefined) {
    return errorEnvelope("Provide importJobId or solutionName", {
      hint:
        "Pass the import job GUID (importjobid) to explain a specific import, or a " +
        "solution unique name to explain its most recent import.",
    });
  }

  try {
    let job: RawImportJob;
    // When both are supplied, importJobId wins (it identifies one exact import).
    if (importJobId !== undefined) {
      try {
        job = await client.get<RawImportJob>(`importjobs(${importJobId})`, {
          select: IMPORT_JOB_SELECT,
        });
      } catch (err) {
        if (err instanceof DataverseHttpError && err.status === 404) {
          return errorEnvelope(`Import job not found: ${importJobId}`, {
            hint:
              "Check the importjobid GUID. Import job records are purged over time, " +
              "so older imports may no longer be available.",
          });
        }
        throw err;
      }
    } else {
      const jobs = await client.get<ListResponse<RawImportJob>>("importjobs", {
        select: IMPORT_JOB_SELECT,
        filter: `solutionname eq '${escapeODataString(solutionName ?? "")}'`,
        orderby: "createdon desc",
        top: 1,
      });
      const latest = jobs.value[0];
      if (latest === undefined) {
        return errorEnvelope(
          `No import job found for solution "${solutionName}"`,
          {
            hint:
              "Pass the solution's unique name (uniquename), not its display name. " +
              "Import job records are also purged over time, so older imports may no " +
              "longer be available.",
          },
        );
      }
      job = latest;
    }

    const progress = typeof job.progress === "number" ? job.progress : 0;
    const parsed =
      typeof job.data === "string" && job.data !== ""
        ? parseJobData(job.data)
        : undefined;
    if (parsed === undefined || parsed.resultCount === 0) {
      return errorEnvelope("Import job contains no parseable result data", {
        hint:
          `The import may still be running (progress ${progress}%), or the job's ` +
          "data column does not contain the importexportxml result document yet.",
      });
    }

    const enriched = parsed.failures.map(enrichFailure);
    const failedComponents = enriched.map((entry) => entry.component);
    const result = {
      importJobId: job.importjobid,
      solutionName: job.solutionname ?? "unknown",
      progress,
      startedon: job.startedon ?? null,
      completedon: job.completedon ?? null,
      failedCount: failedComponents.length,
      warningCount: parsed.warningCount,
      failedComponents,
      resolutionOrder: buildResolutionOrder(enriched),
    };
    if (failedComponents.length === 0) {
      return {
        ...result,
        hint:
          progress >= 100
            ? "Import completed without component failures."
            : `No failed components recorded yet — the import may still be running (progress ${progress}%).`,
      };
    }
    return result;
  } catch (err) {
    if (err instanceof DataverseHttpError && err.status === 403) {
      return errorEnvelope(err.dataverseMessage ?? err.message, {
        hint:
          "Reading import jobs requires read privilege on the ImportJob table, " +
          "typically granted by the System Customizer or System Administrator role.",
        docsUrl: SOLUTIONS_DOCS_URL,
      });
    }
    return toErrorEnvelope(err);
  }
}

export const explainImportFailureTool = defineTool({
  name: "explain_import_failure",
  description:
    "Explain why a Dataverse solution import failed: reads the import job's " +
    "result XML, lists each failed component with a plain-language cause " +
    "(missing dependencies, version conflicts, unmanaged layers, duplicates, " +
    "SQL errors) and builds a dependencies-first resolution order. Scope by " +
    "import job id or solution unique name (latest import).",
  inputSchema,
  handler: async (input) => {
    try {
      return await explainImportFailure(getDefaultClient(), input);
    } catch (err) {
      // explainImportFailure traps its own errors; this covers client
      // construction failures (e.g. missing DATAVERSE_URL).
      return toErrorEnvelope(err);
    }
  },
});
