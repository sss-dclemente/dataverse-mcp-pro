import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, test } from "vitest";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: rootDir,
  });
  client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

test("lists registered tools over stdio", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  expect(names).toContain("ping");
  for (const tool of tools) {
    expect(tool.description).toBeTruthy();
  }
});

test("ping returns structured JSON", async () => {
  const result = await client.callTool({ name: "ping", arguments: {} });
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]?.type).toBe("text");
  expect(JSON.parse(content[0]!.text)).toEqual({ ok: true });
});
