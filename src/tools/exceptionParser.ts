/**
 * Parser for Dataverse plugintracelog `exceptiondetails` blobs. These are
 * .NET exception dumps, usually wrapped in FaultException<OrganizationServiceFault>
 * noise, with inner exceptions chained via "---> Type: message" and stack
 * frames as "at ..." lines. We surface the innermost exception and only the
 * user/plugin stack frames.
 */

export interface ParsedException {
  type: string | null;
  message: string | null;
  frames: string[];
}

const MAX_FRAMES = 15;
const MAX_MESSAGE_LENGTH = 500;
const MAX_FALLBACK_MESSAGE_LENGTH = 200;

/** Platform/framework frames are noise; keep user/plugin frames only. */
const EXCLUDED_FRAME_PREFIXES = [
  "Microsoft.Xrm.",
  "Microsoft.Crm.",
  "Microsoft.PowerPlatform.",
  "System.",
  "PluginProfiler.",
];

// "Namespace.Sub.SomeException: message" (also FaultException`1[...]).
// The bracket group uses [^:]* so the generic argument list cannot swallow
// the ": message" separator.
const HEADER_RE =
  /^((?:[A-Za-z_]\w*\.)+\w*(?:Exception|Fault)(?:`\d+\[[^:]*\])?)\s*:\s*(.*)$/;
const TYPE_ONLY_RE = /^(?:[A-Za-z_]\w*\.)+\w*(?:Exception|Fault)(?:`\d+\[[^:]*\])?$/;
// Async-job style dumps put the type on its own "Exception type: X" line.
const TYPE_LINE_RE = /^Exception type\s*:\s*(\S.*)$/i;
const UNHANDLED_PREFIX_RE = /^Unhandled exception\s*:\s*/i;
// AggregateException lists extra inners as "(Inner Exception #1) ..."; the
// first inner (#0 / the ---> chain) is the one we keep.
const INNER_N_MARKER_RE = /^\(Inner Exception #(\d+)\)\s*/;
const END_OF_INNER_RE = /^-+\s*End of inner exception stack trace\s*-+$/i;

interface HeaderMatch {
  type: string;
  message: string;
}

function matchHeader(line: string): HeaderMatch | null {
  let text = line.trim();
  const innerMarker = INNER_N_MARKER_RE.exec(text);
  if (innerMarker) text = text.slice(innerMarker[0].length).trim();
  text = text.replace(UNHANDLED_PREFIX_RE, "");
  const header = HEADER_RE.exec(text);
  if (header) return { type: header[1] ?? "", message: (header[2] ?? "").trim() };
  const typeLine = TYPE_LINE_RE.exec(text);
  if (typeLine) {
    const typeName = (typeLine[1] ?? "").trim();
    if (TYPE_ONLY_RE.test(typeName)) return { type: typeName, message: "" };
  }
  return null;
}

function isFrameLine(trimmed: string): boolean {
  return trimmed.startsWith("at ");
}

/**
 * Splits the raw text into logical lines: physical lines, with inline
 * "---> Inner: message" chains broken onto their own lines so each header
 * is inspected independently.
 */
function toLogicalLines(raw: string): string[] {
  const lines: string[] = [];
  for (const physical of raw.split(/\r?\n/)) {
    for (const segment of physical.split(/\s*--->\s*/)) {
      lines.push(segment);
    }
  }
  return lines;
}

function fallbackResult(raw: string): ParsedException {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return {
    type: null,
    message: firstLine ? firstLine.slice(0, MAX_FALLBACK_MESSAGE_LENGTH) : null,
    frames: [],
  };
}

export function parseExceptionDetails(raw: string): ParsedException {
  try {
    return parse(raw);
  } catch {
    // Never throw on garbage input.
    try {
      return fallbackResult(raw);
    } catch {
      return { type: null, message: null, frames: [] };
    }
  }
}

function parse(raw: string): ParsedException {
  const lines = toLogicalLines(raw);

  const headers: Array<{ index: number; type: string; message: string }> = [];
  const frames: string[] = [];
  let firstFrameIndex = -1;
  let firstExtraInnerIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.length === 0) continue;

    if (isFrameLine(trimmed)) {
      if (firstFrameIndex === -1) firstFrameIndex = i;
      const method = trimmed.slice("at ".length).trimStart();
      const excluded = EXCLUDED_FRAME_PREFIXES.some((prefix) => method.startsWith(prefix));
      if (!excluded && frames.length < MAX_FRAMES) frames.push(trimmed);
      continue;
    }

    const innerMarker = INNER_N_MARKER_RE.exec(trimmed);
    if (innerMarker && Number(innerMarker[1]) >= 1 && firstExtraInnerIndex === -1) {
      firstExtraInnerIndex = i;
    }

    const header = matchHeader(trimmed);
    if (header) headers.push({ index: i, ...header });
  }

  if (headers.length === 0) return fallbackResult(raw);

  // The primary "---> " chain runs outer -> inner and ends at the first stack
  // frame (or at AggregateException's "(Inner Exception #1)" block, so the
  // FIRST inner wins). The last header inside that window is the innermost.
  let boundary = lines.length;
  if (firstFrameIndex !== -1) boundary = Math.min(boundary, firstFrameIndex);
  if (firstExtraInnerIndex !== -1) boundary = Math.min(boundary, firstExtraInnerIndex);

  const candidates = headers.filter((h) => h.index < boundary);
  const innermost = candidates.length > 0 ? candidates[candidates.length - 1] : headers[0];
  if (!innermost) return fallbackResult(raw);

  // Message: header remainder plus following lines until the next frame,
  // header, or inner-exception marker.
  const parts: string[] = [];
  if (innermost.message.length > 0) parts.push(innermost.message);
  for (let j = innermost.index + 1; j < lines.length; j++) {
    const trimmed = (lines[j] ?? "").trim();
    if (trimmed.length === 0) continue;
    if (isFrameLine(trimmed)) break;
    if (END_OF_INNER_RE.test(trimmed)) break;
    if (INNER_N_MARKER_RE.test(trimmed)) break;
    if (matchHeader(trimmed) !== null) break;
    // "Exception type: X" dumps carry the message on a "Message: ..." line.
    parts.push(parts.length === 0 ? trimmed.replace(/^Message\s*:\s*/i, "") : trimmed);
  }

  const message = parts.join("\n").trim().slice(0, MAX_MESSAGE_LENGTH);
  return {
    type: innermost.type,
    message: message.length > 0 ? message : null,
    frames,
  };
}
