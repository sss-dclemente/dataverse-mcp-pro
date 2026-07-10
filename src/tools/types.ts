import type { z } from "zod";

/**
 * Every tool module under src/tools/ exports one of these. The server
 * auto-registers everything listed in src/tools/index.ts.
 */
export interface ToolDefinition<S extends z.AnyZodObject = z.AnyZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>) => Promise<unknown>;
}

/** Identity helper so tool modules get full inference on their handler input. */
export function defineTool<S extends z.AnyZodObject>(tool: ToolDefinition<S>): ToolDefinition<S> {
  return tool;
}

// Registry entries erase the schema type; handlers receive already-validated input.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;
