# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Install docs: the quickstart claimed the package being "published with provenance" is what makes
  `npx` work. Publishing is what makes `npx` resolve; provenance is a separate attestation that
  lets you verify which commit and workflow built the tarball. Both facts kept, no longer welded
  by a false "so".
- `docs/smoke-test.md` now says explicitly to point the host at *this build's* `dist/server.js`
  rather than `npx`, and why: `npx` runs the last published release, while the checklist exists to
  exercise the commit about to be tagged. Previously it mentioned both launch paths in a way that
  could read as "use both".

### Changed

- Install docs now lead with `npx @simplesmoothsafe/dataverse-ops-mcp`, which resolves since
  0.3.1 was published from the `v0.3.1` tag. The README, `CLAUDE.md` and `docs/smoke-test.md` all
  still said the package was unpublished and told readers not to use `npx` — accurate when written,
  wrong the moment the release workflow succeeded, and the first thing a visitor to a public repo
  reads. Run-from-source stays documented as an equal path and is what the live-org checklist uses,
  so the smoke test exercises the commit being tagged rather than the last published one.

## [0.3.1] - 2026-08-25

### Added

- `npm run verify:package` (`scripts/verify-package.mjs`): verifies the artifact npm would
  actually publish. It packs the tarball, checks the file list and `bin` entry, unpacks it, boots
  the packed server over stdio, and checks the tools it exposes against `src/tools/index.ts` —
  identifier names from `export const tools = [ ... ]`, resolved to each module's `name`, compared
  to packed `tools/list` (not only a count). CI (`ci.yml`) and `prepublishOnly` run
  `node scripts/verify-package.mjs` after build and test so a broken pack fails the PR and a
  laptop `npm publish`, not only a `v*` tag. `release.yml` still runs it before `npm publish`.
  The check is anchored to source rather than to the built registry — comparing the packed server
  against `dist/tools/index.js` alone compares the build to itself and agrees with a tool that was
  dropped during build. Needs no Dataverse org: the client is lazily constructed, so `tools/list`
  answers with no environment set.

### Changed

- `package-lock.json` root and `packages.""` `version` / `license` synced to `package.json`
  (`0.3.1`, MIT). Dependency versions unchanged.
- README honesty pass: run-from-source is the real install path (`npx @simplesmoothsafe/dataverse-ops-mcp` does not resolve until the first `v*` git tag); dropped the complete-automation-graph claim; data flow is no-middleman Web API + Entra, with the caveat that a cloud MCP host still sends tool JSON to the model vendor; documented the real caps (`flowrun` elastic page 500, `analyze_flow_runs` truncated at 500, `detect_automation_loops` definition-based cloud-flow only, `what_runs_on_table` cloud-flow scan cap 500).
- `docs/smoke-test.md` tightened to a short live-org checklist. CI remains fixture-based and is not live-org validation.
- Removed the leftover "Free tier." suffix from six tool descriptions and the `**Tier:** Free`
  line from five doc pages. The tiers were removed in 0.3.0, and labelling only some tools
  implied the rest were paid. A registry test now fails if tier wording reappears.

### Fixed

- `configFromEnv` now treats blank `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` as unset and trims
  surrounding whitespace. Previously an empty-but-declared variable (common in `.env` templates
  and CI) forced the client-credentials flow with empty values instead of falling back to
  `DefaultAzureCredential`.
- `analyze_plugin_performance` now derives an N+1 offender's `messageName` from the offending
  correlation rather than a window-wide histogram, so a plug-in type registered on several
  messages is no longer mislabelled.
- `explain_import_failure` attributes failures on `<solutionManifest>`, which previously surfaced
  as `componentType: "unknown"`.
- `get_solution_layers` no longer describes the lower layers as managed: the layer table carries
  no managed/unmanaged flag, so the finding now says "lower layer(s)".
- `get_flow_runs` bounds both workflow name lookups with `$top`; the `contains()` fallback was
  unbounded even though only five matches are ever used.
- Pattern matchers reset `lastIndex` before `exec`, so a future `/g` rule cannot skip matches.
- `analyze_flow_runs` requested a 5000-row page and only reported `truncated` at exactly 5000
  rows. `flowrun` is an elastic table, for which Dataverse serves at most 500 rows per page, so
  the flag could never fire and a partial window was reported as complete. The cap is now 500.
- `flowrun` was described as a "virtual table" throughout the flow tools and their docs. It is an
  **elastic** table (Cosmos-backed, partitioned per user, 500-row page cap). `msdyn_componentlayer`
  really is virtual, so the two were being conflated. Documented the partitioning and page-cap
  consequences in `docs/tools/get_flow_runs.md`.
- `docs/smoke-test.md` referenced a `0.1.0` tarball that `npm pack` no longer produces, and told
  readers to expect "exactly seven tools" from `tools/list` when the registry holds 20 — so the
  release gate failed against a correct build.

## [0.3.0] - 2026-07-11

### Changed

- **Now fully open source (MIT), every tool free.** The paid tiers and the licensing gate are gone: all 20 tools run without a license key. Removed the `src/licensing.ts` module, the startup validation, the `LICENSE_KEY` / `DVOPS_LICENSE_URL` / `DVOPS_CACHE_DIR` environment variables, and all per-tool gating. The `LICENSE` file is now MIT.

### Added

Thirteen tools bringing the set to 20, spanning plug-in diagnostics, Power Automate flow diagnostics, and Dataverse governance/documentation:

- `get_flow_runs`: filtered Power Automate cloud-flow run history (flow, status, time window) via the Dataverse `flowrun` elastic table.
- `document_flow`: structured documentation for a cloud flow parsed from its definition — triggers, action tree with dependencies, connectors, and a ready-to-share markdown document.
- `analyze_flow_runs`: per-flow reliability report with success rates, duration percentiles, error clusters, and flags for high failure rates, failure streaks and slow p95 durations.
- `get_org_automation_settings`: org-level plug-in trace logging and auditing switches with actionable hints.
- `find_stuck_jobs`: async jobs stuck in waiting/in-progress beyond a threshold, with postponed (scheduled) jobs excluded.
- `explain_flow_failure`: root-cause analysis for a failed cloud-flow run with failed-action guess and known-pattern detection.
- `check_flow_connections`: connection-reference health audit (unbound references, disabled owners, owner mismatches, unused references).
- `flow_governance_report`: flow ownership/state inventory flagging disabled owners, suspended flows, stale drafts and owner concentration.
- `what_runs_on_table`: unified map of plug-in steps, cloud flows, classic workflows and business rules registered on one table.
- `detect_automation_loops`: suspected trigger→write cycles between cloud flows (self-loops and 2–3 flow cycles).
- `document_table`: table documentation from EntityDefinitions metadata with attached automation and markdown output.
- `get_solution_layers`: solution layering of one component, flagging unmanaged Active layers that block managed updates.
- `modernization_report`: inventory of legacy automation (dialogs, classic workflows, business rules) with migration priorities.

## [0.2.0] - 2026-07-10

### Changed

- Licensing stub replaced by real remote validation: `LICENSE_KEY` is now checked once at startup against the license service, with a 7-day offline grace window backed by an on-disk cache (`~/.dvops/license-cache.json`, storing only a SHA-256 hash of the key). Validation failures never crash the server and never block free tools.

### Added

- Checkout/pricing URL included in Pro upgrade messages (`checkoutUrl` field).
- `DVOPS_LICENSE_URL` env var to override the license validation endpoint.
- `DVOPS_CACHE_DIR` env var to relocate the license cache directory.

## [0.1.0] - 2026-07-10

### Added

- Stdio MCP server for Microsoft Dataverse diagnostics, runnable via `npx @simplesmoothsafe/dataverse-ops-mcp` inside any MCP host.
- `ping` (free): health check that returns `{ ok: true }` without contacting Dataverse.
- `get_plugin_traces` (free): recent plug-in trace logs, defaulting to executions with exceptions, trimmed to one-line summaries plus excerpts.
- `get_failed_async_jobs` (free): failed/canceled async jobs over a time window, grouped by job name and error code, with the ten most recent failures.
- `check_step_config` (pro): lints plug-in step registrations for missing filtering attributes, synchronous steps on high-volume entities, and rank collisions.
- `explain_trace` (pro): root-cause analysis of a single failing plug-in execution — step registration, sibling traces in the same correlation, and parsed exception.
- `explain_import_failure` (pro): explains a failed solution import with per-component causes and missing-dependency resolution.
- `analyze_plugin_performance` (pro): per-plugin/message performance table (p50/p95, sync vs async, depth) with anti-pattern flags.
- Authentication via client credentials (`CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID`) with `DefaultAzureCredential` fallback when the trio is absent.
- Automatic retry on HTTP 429 honoring `Retry-After`, with in-memory token caching.
- Licensing stub gate: pro tools return a friendly upgrade message when `LICENSE_KEY` is not set; free tools are never blocked.
