import { z } from "zod";
import { defineTool } from "./types.js";

export const ping = defineTool({
  name: "ping",
  description:
    "Health check for the Dataverse Ops MCP server. Returns { ok: true } without contacting Dataverse. Free tier.",
  inputSchema: z.object({}),
  handler: async () => ({ ok: true }),
});
