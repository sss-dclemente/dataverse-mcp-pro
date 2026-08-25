import { z } from "zod";
import { defineTool } from "./types.js";

export const ping = defineTool({
  name: "ping",
  description:
    "Go-live step 1: confirm the server process is up. Health check for the Dataverse Ops MCP server. Returns { ok: true } without contacting Dataverse.",
  inputSchema: z.object({}),
  handler: async () => ({ ok: true }),
});
