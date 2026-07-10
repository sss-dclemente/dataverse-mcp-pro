#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toErrorEnvelope } from "./errors.js";
import { initLicensing } from "./licensing.js";
import { tools } from "./tools/index.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export function buildServer(): McpServer {
  const server = new McpServer({ name: "dataverse-ops-mcp", version: pkg.version });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema.shape },
      async (input: Record<string, unknown>) => {
        try {
          const result = await tool.handler(input);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(toErrorEnvelope(err)) }],
          };
        }
      },
    );
  }

  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  // Resolve the license once at startup; never throws and never blocks free tools.
  await initLicensing();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; human-facing output goes to stderr.
  console.error(`dataverse-ops-mcp v${pkg.version} ready on stdio`);
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
