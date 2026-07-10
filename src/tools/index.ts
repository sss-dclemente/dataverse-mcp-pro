import type { AnyToolDefinition } from "./types.js";
import { ping } from "./ping.js";

/** All tools exposed by the server. Add new tool modules here. */
export const tools: AnyToolDefinition[] = [ping];
