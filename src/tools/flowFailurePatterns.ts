/**
 * Extensible pattern-detection table for explain_flow_failure. Data, not
 * logic: each rule pairs a kebab-case id with a matcher over the combined
 * run error text (errorcode + "\n" + errormessage).
 */

export interface FlowFailurePatternInput {
  text: string;
}

export interface DetectedFlowFailurePattern {
  pattern: string;
  evidence: string;
  likelyFix: string;
}

export interface FlowFailurePatternRule {
  pattern: string;
  likelyFix: string;
  /** Returns evidence when matched, undefined otherwise. */
  matcher: (input: FlowFailurePatternInput) => string | undefined;
}

const MAX_EVIDENCE_LENGTH = 200;

/**
 * Builds a matcher that runs a regex over the whole text and returns the
 * matched line, trimmed, capped at 200 chars. When the line is longer than
 * the cap, the window starts at the match so the evidence keeps the hit
 * visible (connector error messages can be a single very long line).
 */
function lineMatcher(re: RegExp): (input: FlowFailurePatternInput) => string | undefined {
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

export const FLOW_FAILURE_PATTERN_RULES: FlowFailurePatternRule[] = [
  {
    pattern: "connection-auth",
    likelyFix:
      "Reconnect or re-consent the failing connection (edit it in Power Automate and " +
      "sign in again), and check that the solution's connection references point at " +
      "live, authorized connections.",
    matcher: lineMatcher(
      /401|Unauthorized|AADSTS|token.*expired|InvalidAuthenticationToken/i,
    ),
  },
  {
    pattern: "throttling",
    likelyFix:
      "Reduce trigger frequency, add concurrency limits on the trigger and " +
      "apply-to-each loops, and stagger triggers so calls stay under the " +
      "connector's rate limits.",
    matcher: lineMatcher(/429|Rate limit|throttl|TooManyRequests/i),
  },
  {
    pattern: "timeout",
    likelyFix:
      "Reduce batch sizes, add a retry policy on the failing action, and split " +
      "long-running operations into smaller child flows.",
    matcher: lineMatcher(/timeout|504|GatewayTimeout|BadGateway/i),
  },
  {
    pattern: "permission",
    likelyFix:
      "Check the run-only user's permissions and record-level access in the target " +
      "system; grant the missing privilege or share the records with the executing " +
      "identity.",
    matcher: lineMatcher(/403|Forbidden|privilege|AccessDenied/i),
  },
  {
    pattern: "expression",
    likelyFix:
      "Guard null values with coalesce()/'?' operators and check that dynamic " +
      "content types match what the expression expects.",
    matcher: lineMatcher(/InvalidTemplate|expression.*evaluat|cannot be evaluated/i),
  },
  {
    pattern: "apply-to-each-limits",
    likelyFix:
      "Enable pagination on the list action and filter rows server-side (OData " +
      "$filter) so loops stay under the item limits.",
    matcher: lineMatcher(/pagination|limit exceeded|maximum.*items/i),
  },
  {
    pattern: "dataverse-plugin-error",
    likelyFix:
      "The failure originates in a Dataverse plug-in, not the flow itself; run " +
      "explain_trace on the correlated plug-in trace to root-cause it.",
    matcher: lineMatcher(/plugin|business process error|ISV code aborted/i),
  },
];

/** Runs every rule against the input; at most one finding per rule. */
export function detectFlowFailurePatterns(
  input: FlowFailurePatternInput,
): DetectedFlowFailurePattern[] {
  const findings: DetectedFlowFailurePattern[] = [];
  for (const rule of FLOW_FAILURE_PATTERN_RULES) {
    const evidence = rule.matcher(input);
    if (evidence !== undefined) {
      findings.push({ pattern: rule.pattern, evidence, likelyFix: rule.likelyFix });
    }
  }
  return findings;
}
