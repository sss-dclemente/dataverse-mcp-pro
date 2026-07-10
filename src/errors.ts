export interface ErrorEnvelope {
  error: string;
  hint?: string;
  docsUrl?: string;
}

export function errorEnvelope(
  error: string,
  extras?: { hint?: string; docsUrl?: string },
): ErrorEnvelope {
  const envelope: ErrorEnvelope = { error };
  if (extras?.hint !== undefined) envelope.hint = extras.hint;
  if (extras?.docsUrl !== undefined) envelope.docsUrl = extras.docsUrl;
  return envelope;
}

export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (
    typeof err === "object" &&
    err !== null &&
    "error" in err &&
    typeof (err as { error: unknown }).error === "string"
  ) {
    const shaped = err as { error: string; hint?: unknown; docsUrl?: unknown };
    return errorEnvelope(shaped.error, {
      ...(typeof shaped.hint === "string" ? { hint: shaped.hint } : {}),
      ...(typeof shaped.docsUrl === "string" ? { docsUrl: shaped.docsUrl } : {}),
    });
  }
  if (err instanceof Error) return errorEnvelope(err.message);
  return errorEnvelope(String(err));
}
