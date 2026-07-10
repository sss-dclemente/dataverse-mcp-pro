/**
 * Extensible pattern-detection table for explain_trace. Data, not logic:
 * each rule pairs a kebab-case id with a matcher over the combined trace
 * text (exceptiondetails + "\n" + messageblock) and the execution depth.
 */

export interface PatternInput {
  text: string;
  depth: number;
}

export interface DetectedPattern {
  pattern: string;
  evidence: string;
  likelyFix: string;
}

export interface PatternRule {
  pattern: string;
  likelyFix: string;
  /** Returns evidence when matched, undefined otherwise. */
  matcher: (input: PatternInput) => string | undefined;
}

const MAX_EVIDENCE_LENGTH = 200;

/**
 * Builds a matcher that runs a regex over the whole text and returns the
 * matched line, trimmed, capped at 200 chars. When the line is longer than
 * the cap, the window starts at the match so the evidence keeps the hit
 * visible (one-line "---> ..." exception chains can be very long).
 */
function lineMatcher(re: RegExp): (input: PatternInput) => string | undefined {
  return ({ text }) => {
    const match = re.exec(text);
    if (!match) return undefined;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const nl = text.indexOf("\n", match.index);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd).trim();
    if (line.length <= MAX_EVIDENCE_LENGTH) return line;
    const offsetInLine = match.index - lineStart;
    return text
      .slice(lineStart + offsetInLine, lineEnd)
      .trim()
      .slice(0, MAX_EVIDENCE_LENGTH);
  };
}

export const PATTERN_RULES: PatternRule[] = [
  {
    pattern: "sql-timeout",
    likelyFix:
      "Reduce the work done inside the transaction, add or select indexes via targeted queries, and move heavy logic to an asynchronous step.",
    matcher: lineMatcher(
      /timeout expired|SqlException.*timeout|execution timeout expired|Query execution time.*exceeded/i,
    ),
  },
  {
    pattern: "sql-deadlock",
    likelyFix:
      "Shorten the transaction scope, touch entities in a consistent order across plug-ins, and consider moving the work to an async step with retry.",
    matcher: lineMatcher(/deadlock|was deadlocked on lock/i),
  },
  {
    pattern: "missing-privilege",
    likelyFix:
      "Grant the missing privilege (see the prv* name in the evidence) to the executing user's security role.",
    matcher: lineMatcher(
      /SecLib::AccessCheckEx|missing prv\w+|privilege.*denied|does not have.*privilege/i,
    ),
  },
  {
    pattern: "null-reference",
    likelyFix:
      "Guard attribute/EntityReference access (Contains/GetAttributeValue) before dereferencing, and check that images provide the needed attributes.",
    matcher: lineMatcher(/NullReferenceException|Object reference not set/i),
  },
  {
    pattern: "depth-loop",
    likelyFix:
      "Guard self-triggering updates: compare depth/context, use filtering attributes, and avoid updating the triggering record unconditionally.",
    matcher: ({ depth }) =>
      depth > 7 ? `execution depth ${depth} suggests a plug-in update loop` : undefined,
  },
  {
    pattern: "duplicate-detection",
    likelyFix:
      "Handle duplicate-detection faults in the caller or disable the duplicate detection rule for system-driven writes.",
    matcher: lineMatcher(
      /duplicate detection|a duplicate.*was found|MSCRM_DuplicateDetectionRule/i,
    ),
  },
];

/** Runs every rule against the input; at most one finding per rule. */
export function detectPatterns(input: PatternInput): DetectedPattern[] {
  const findings: DetectedPattern[] = [];
  for (const rule of PATTERN_RULES) {
    const evidence = rule.matcher(input);
    if (evidence !== undefined) {
      findings.push({ pattern: rule.pattern, evidence, likelyFix: rule.likelyFix });
    }
  }
  return findings;
}
