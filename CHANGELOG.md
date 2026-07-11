# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `get_flow_runs` tool (free): filtered Power Automate cloud-flow run history (flow, status, time window) via the Dataverse `flowrun` virtual table.
- `document_flow` tool (pro): structured documentation for a cloud flow parsed from its definition — triggers, action tree with dependencies, connectors, and a ready-to-share markdown document.
- `analyze_flow_runs` tool (pro): per-flow reliability report with success rates, duration percentiles, error clusters, and flags for high failure rates, failure streaks and slow p95 durations.

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
