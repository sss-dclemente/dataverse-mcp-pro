# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-11

### Changed

- **Now fully open source (MIT), every tool free.** The paid tiers and the licensing gate are gone: all 20 tools run without a license key. Removed the `src/licensing.ts` module, the startup validation, the `LICENSE_KEY` / `DVOPS_LICENSE_URL` / `DVOPS_CACHE_DIR` environment variables, and all per-tool gating. The `LICENSE` file is now MIT.

### Added

Thirteen tools bringing the set to 20, spanning plug-in diagnostics, Power Automate flow diagnostics, and Dataverse governance/documentation:

- `get_flow_runs`: filtered Power Automate cloud-flow run history (flow, status, time window) via the Dataverse `flowrun` virtual table.
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
