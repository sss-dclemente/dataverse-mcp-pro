// Stub gate for free vs pro tools. Real remote validation lands in a later
// phase; for now a non-empty LICENSE_KEY unlocks pro tools.

const PRO_DOCS_URL = "https://github.com/sss-dclemente/dataverse-mcp-pro#pro";

export function isProLicensed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const key = env["LICENSE_KEY"];
  return typeof key === "string" && key.trim().length > 0;
}

export function proUpgradeMessage(toolName: string): {
  upgradeRequired: true;
  tool: string;
  message: string;
  docsUrl: string;
} {
  return {
    upgradeRequired: true,
    tool: toolName,
    message:
      `The tool "${toolName}" is part of the Pro tier. ` +
      "Set the LICENSE_KEY environment variable to unlock it. " +
      `See ${PRO_DOCS_URL} for details.`,
    docsUrl: PRO_DOCS_URL,
  };
}
