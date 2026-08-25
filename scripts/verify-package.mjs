#!/usr/bin/env node
// Verifies the packed npm artifact before it can be published.
//
// CI runs the fixture suite against source; nothing else checks that what
// `npm pack` produces actually starts and exposes every registered tool. A tool
// that fails to register, a missing dist file or a stray file in the tarball all
// pass `npm test` and only surface after publishing.
//
// Steps: pack, check the file list, unpack, boot the packed server over stdio,
// and compare the tools it reports against src/tools/index.ts (names, not just
// a count) as well as the built registry.
//
// The tarball is unpacked inside the repo so Node resolves the runtime deps from
// the repo's node_modules — the packed artifact ships no node_modules of its own.
// That means this checks the packed *code*, not that package.json declares every
// dependency it imports; a dep missing from "dependencies" would still resolve
// here and fail for a real consumer.

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const HANDSHAKE_TIMEOUT_MS = 30_000;

// package.json "files", plus the entries npm always includes.
const ALLOWED_TOP_LEVEL = new Set(["package.json", "README.md", "LICENSE"]);
const ALLOWED_PREFIX = "dist/";

let failures = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failures += 1;
};
const pass = (msg) => console.log(`ok: ${msg}`);

function packTarball() {
  const raw = execFileSync("npm", ["pack", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [entry] = JSON.parse(raw);
  return { name: entry.filename, files: entry.files.map((f) => f.path) };
}

function checkFileList(files) {
  const unexpected = files.filter(
    (f) => !f.startsWith(ALLOWED_PREFIX) && !ALLOWED_TOP_LEVEL.has(f),
  );
  if (unexpected.length > 0) {
    fail(`tarball contains unexpected files: ${unexpected.join(", ")}`);
  } else {
    pass(`tarball file list is clean (${files.length} files)`);
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const binPath = pkg.bin?.[Object.keys(pkg.bin ?? {})[0]];
  if (binPath && !files.includes(binPath.replace(/^\.\//, ""))) {
    fail(`bin entry "${binPath}" is not in the tarball`);
  } else if (binPath) {
    pass(`bin entry "${binPath}" is present`);
  }
}

async function registeredToolNames() {
  const indexPath = join(repoRoot, "dist", "tools", "index.js");
  if (!existsSync(indexPath)) {
    throw new Error(`${indexPath} missing — run "npm run build" first`);
  }
  const { tools } = await import(pathToFileURL(indexPath).href);
  return tools.map((t) => t.name);
}

/**
 * MCP tool names declared in source, in `export const tools = [ ... ]` order.
 *
 * Extracts identifier names from the source array (not a comma-split count),
 * then resolves each identifier's `name` from its tool module. Anchored to
 * source on purpose: comparing the packed server only against the built
 * registry compares the build to itself, so a tool dropped during build or
 * pack would agree on both sides and pass. The source list is the one input
 * the build cannot influence.
 */
function sourceToolNames() {
  const indexPath = join(repoRoot, "src", "tools", "index.ts");
  const src = readFileSync(indexPath, "utf8");
  const match = src.match(/export const tools[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!match) {
    throw new Error("could not find the tools array in src/tools/index.ts");
  }
  const identifiers = [...match[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)].map(
    (m) => m[1],
  );
  if (identifiers.length === 0) {
    throw new Error("tools array in src/tools/index.ts had no identifiers");
  }

  const idToRel = new Map();
  for (const m of src.matchAll(/import\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s+from\s+"(\.\/[^"]+)"/g)) {
    idToRel.set(m[1], m[2]);
  }

  const names = [];
  for (const id of identifiers) {
    const rel = idToRel.get(id);
    if (!rel) {
      throw new Error(
        `tools array identifier "${id}" has no matching import in src/tools/index.ts`,
      );
    }
    const filePath = join(
      repoRoot,
      "src",
      "tools",
      rel.replace(/^\.\//, "").replace(/\.js$/, ".ts"),
    );
    const fileSrc = readFileSync(filePath, "utf8");
    const nameMatch = fileSrc.match(/defineTool\(\s*\{[\s\S]*?\bname:\s*["']([^"']+)["']/);
    if (!nameMatch) {
      throw new Error(`could not find defineTool name in ${filePath} (${id})`);
    }
    names.push(nameMatch[1]);
  }
  return names;
}

/** Boot the packed server over stdio and return the tool names it reports. */
function toolNamesFromPackedServer(serverPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    // No DATAVERSE_URL on purpose: the client is built lazily, so tools/list
    // must answer without any credentials configured.
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DATAVERSE_URL: undefined },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`packed server did not answer within ${HANDSHAKE_TIMEOUT_MS}ms`));
    }, HANDSHAKE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d;
      // Answer as soon as the tools/list reply arrives; the server stays open otherwise.
      if (stdout.includes('"id":2') || stdout.includes('"id": 2')) {
        clearTimeout(timer);
        child.kill();
      }
    });
    child.stderr.on("data", (d) => (stderr += d));

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on("close", () => {
      clearTimeout(timer);
      const messages = stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return []; // non-JSON-RPC noise is not fatal, just ignored
          }
        });
      const reply = messages.find((m) => m.id === 2);
      if (!reply) {
        rejectPromise(
          new Error(
            `packed server produced no tools/list response.\nstderr:\n${stderr.trim() || "(empty)"}`,
          ),
        );
        return;
      }
      if (reply.error) {
        rejectPromise(new Error(`tools/list returned an error: ${JSON.stringify(reply.error)}`));
        return;
      }
      const tools = reply.result?.tools;
      if (!Array.isArray(tools)) {
        rejectPromise(new Error(`tools/list response had no tools array: ${JSON.stringify(reply).slice(0, 200)}`));
        return;
      }
      resolvePromise(tools);
    });

    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-package", version: "0.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

const workDir = mkdtempSync(join(repoRoot, ".verify-package-"));
let tarball;
try {
  const packed = packTarball();
  tarball = join(repoRoot, packed.name);
  console.log(`packed ${packed.name}`);
  checkFileList(packed.files);

  execFileSync("tar", ["-xzf", tarball, "-C", workDir]);
  const serverPath = join(workDir, "package", "dist", "server.js");
  if (!existsSync(serverPath)) {
    fail(`packed tarball has no dist/server.js`);
  } else {
    const expected = await registeredToolNames();
    const reported = await toolNamesFromPackedServer(serverPath);
    const reportedNames = reported.map((t) => t.name);

    const sourceNames = sourceToolNames();
    if (reportedNames.length !== sourceNames.length) {
      fail(
        `src/tools/index.ts registers ${sourceNames.length} tools but the packed server exposes ` +
          `${reportedNames.length} — the build or pack dropped something.`,
      );
    } else {
      pass(`packed tool count matches src/tools/index.ts (${sourceNames.length})`);
    }

    const missingFromSource = sourceNames.filter((n) => !reportedNames.includes(n));
    const extraVsSource = reportedNames.filter((n) => !sourceNames.includes(n));
    if (missingFromSource.length > 0) {
      fail(
        `in src/tools/index.ts but not exposed by the packed server: ${missingFromSource.join(", ")}`,
      );
    }
    if (extraVsSource.length > 0) {
      fail(
        `exposed by the packed server but not in src/tools/index.ts: ${extraVsSource.join(", ")}`,
      );
    }
    if (missingFromSource.length === 0 && extraVsSource.length === 0) {
      pass(`packed server exposes every tool named in src/tools/index.ts (${sourceNames.length})`);
    }

    const missing = expected.filter((n) => !reportedNames.includes(n));
    const extra = reportedNames.filter((n) => !expected.includes(n));
    if (missing.length > 0) fail(`registered but not exposed by the packed server: ${missing.join(", ")}`);
    if (extra.length > 0) fail(`exposed by the packed server but not registered: ${extra.join(", ")}`);
    if (missing.length === 0 && extra.length === 0) {
      pass(`packed server exposes all ${reportedNames.length} registered tools`);
    }

    const undescribed = reported.filter((t) => !t.description || t.description.trim() === "");
    if (undescribed.length > 0) {
      fail(`tools with an empty description: ${undescribed.map((t) => t.name).join(", ")}`);
    } else {
      pass("every tool has a non-empty description");
    }
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — do not publish this artifact.`);
  process.exit(1);
}
console.log("\npacked artifact verified.");
