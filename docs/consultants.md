# Consultant playbooks

Twenty tools is too many to hold in your head on a client call. In practice a
consultant lives on four to six of them, and which four depends on the job you
were hired to do. This page is the routing the MCP host does not give you.

Three jobs, three orders. Run them in sequence — each step tells you whether the
next one is worth running.

Nothing here adds a tool or changes one. It is the order, the arguments that
matter, what "done" looks like, and where each tool stops being trustworthy.

> **Observed behaviour below** comes from a run against a live production org
> (`sss-prod`, 2026-08-25). The automated suite is fixture-based and does not
> talk to a Dataverse org, so treat those numbers as one org's reality rather
> than a guarantee about yours.

---

## Playbook A — Go-live

*"We cut over last night and something is wrong."*

| # | Tool | Arguments | Why here |
| --- | --- | --- | --- |
| 1 | `ping` | none | Is the process even up? |
| 2 | `get_org_automation_settings` | none | Are the switches the other tools depend on turned on? |
| 3 | `what_runs_on_table` | `{ "table": "<logical name>" }` | The headline: what actually runs on this table |
| 4 | `get_solution_layers` | the broken form or view | Who overwrote it |
| 5 | `document_table` / `document_flow` | as needed | Only if the SOW calls for an artefact |
| 6 | `check_step_config` | table or assembly | Only if step 3 showed sync Update steps |

**Do not run `detect_automation_loops` here.** See [the note below](#detect_automation_loops).

### 1. `ping` — no arguments

Returns `{ "ok": true }` without contacting Dataverse. It confirms the host
spawned the server and nothing more.

**Done:** `{ ok: true }`. **If it fails, stop** — everything downstream is
meaningless until the process is up.

**It does not diagnose the org.** A green `ping` says nothing about credentials,
privileges, or whether the org is reachable.

### 2. `get_org_automation_settings` — no arguments

Reads the plug-in trace log setting (off / exception / all) and the auditing
configuration.

**Done:** you know whether traces are on.

**This step decides whether steps in Playbook B are worth running.** On
`sss-prod` the trace log was **off** and auditing **disabled**. With traces off,
`get_plugin_traces`, `explain_trace` and `analyze_plugin_performance` will come
back empty — correctly. That is not a broken tool and not an empty org; it is a
switch. Say so out loud on the call before someone concludes the diagnostics
"don't work".

### 3. `what_runs_on_table` — `{ "table": "<logical name>" }`

The headline tool. Four sections in one view: plug-in steps (message, stage,
mode, rank), solution-aware cloud flows that trigger on or write to the table,
classic workflows, and business rules.

Takes the **logical name** (`account`, `contoso_order`), not the display name.

**Done:** four sections, and you can name what fires on write.

**Caps, and say them:**

- Cloud-flow definitions are scanned client-side up to **500**. When that cap is
  hit the payload sets `flowsScanTruncated: true` — check for it before calling
  a list complete.
- Solution-aware cloud flows only.
- **This is one table, not a whole-environment automation graph.** Do not
  present it as one.

On `sss-prod`, `account` returned **54 plug-in steps, 0 cloud flows, 0 classic
workflows, 0 business rules** — including `PSA_Plugins.accountCreateHandler` and
`accountUpdateHandler`. A heavily pro-code org with no low-code automation on
its busiest table is a finding in itself, and this is the tool that shows it.

### 4. `get_solution_layers` — the component that is misbehaving

Lists every solution layer on one component from the winning (top) layer down.

**Done:** you can name the solution whose version is actually in effect.

**The top layer is the one that wins.** Read the list downward from there.

**Do not invent managed/unmanaged status for the lower layers.** The layer table
exposes no such flag, so the tool does not claim one and neither should you. An
unmanaged `Active` layer sitting on top is worth flagging; what sits *beneath*
it is not something this tool can tell you.

### 5. `document_table` / `document_flow` — only if the SOW needs an artefact

`document_table` returns columns, relationships, alternate keys and attached
automation — **not** raw `EntityDefinitions`. `document_flow` builds from
`workflow.clientdata`: triggers, an action outline with nesting and `runAfter`
dependencies, and the connectors used. Both also return ready-to-share markdown.

**Done:** a document you can hand over.

Skip this step during triage. It produces deliverables, not answers.

### 6. `check_step_config` — only if step 3 showed sync Update steps

Lints plug-in step registrations. The **high**-severity finding is an **Update
step with no filtering attributes**: it fires on every column change, including
ones it does not care about.

**Done:** you can point at a specific registration and say what to change.

---

## Playbook B — Incident

*"Something failed in production."*

Pick **one lane** by what actually failed. Running all four is not thoroughness,
it is noise.

### Lane: solution import failed

`explain_import_failure`

Reads the import job's result XML and returns each failed component with a
plain-language cause — missing dependencies, version conflicts, unmanaged
layers, duplicates, SQL errors — plus a dependencies-first resolution order.

**Done:** you know which component to fix first.

You should never be reading raw `importexportxml` on a call. If a failure is
attributed to `componentType: "unknown"`, that is a gap in the parser, not in
your understanding — manifest-level failures (`solutionManifest`) were fixed in
0.3.1.

### Lane: plug-in failed

`get_org_automation_settings` → `get_plugin_traces` → `explain_trace`

**Check the settings first.** With trace logging off there is nothing to read
and the next two steps waste the call.

`get_plugin_traces` defaults to `onlyErrors: true`, `hoursBack: 24`,
`top` between 1 and 100.

**An empty result plus a hint is a successful run when logging is off.** On
`sss-prod` the defaults returned **count 0 with a hint** — the tool worked; the
switch was off.

Then `explain_trace` with the `correlationId` from a trace that matters. It
correlates the step registration, reconstructs the sibling traces in the same
correlation, parses the exception, and matches known patterns.

**Done:** a named exception, a named step, and a reason.

### Lane: cloud flow failed

`get_flow_runs` → `explain_flow_failure`

`get_flow_runs` takes `hoursBack` 1–168 and `top` up to 100.

**Caps:** `flowrun` is an **elastic** table with a Dataverse page cap of **500**
(this tool's `top` maxes at 100, comfortably inside it). Run history covers
**solution-aware cloud flows only**. On `sss-prod` a 24-hour window returned
**count 0 with a hint** — no runs in the window, not a broken tool.

Then `explain_flow_failure` on a failed run: failed-action guess, definition
context, and known patterns (expired connections, throttling, timeouts,
permissions, expression errors, pagination limits, plug-in errors).

**Done:** a named action and a likely fix.

### Lane: jobs are piling up

`find_stuck_jobs` → `get_failed_async_jobs`

`find_stuck_jobs` shows the waiting/in-progress backlog past an age threshold.
Postponed jobs (`postponeuntil` in the future) are reported **separately as
scheduled** — they are not stuck, do not report them as such.

`get_failed_async_jobs` covers what already died, grouped by **job name + error
code** so recurring failures stand out from one-offs.

**Done:** you can say whether the queue is backed up, broken, or both.

---

## Playbook C — Assessment

*"Tell us what we've got."*

Not a triage path. This is the inventory you bill for.

### 1. `modernization_report`

Classic workflows (background and real-time), dialogs (removed technology),
business rules, and business process flows — with migration priorities.

**Done:** a list of legacy automation with a reason to care about each.

### 2. `flow_governance_report` → `check_flow_connections` → `analyze_flow_runs`

- `flow_governance_report` — activated/draft/suspended counts, owner table, and
  findings: flows owned by disabled users, suspended flows, stale drafts, owner
  concentration (bus-factor).
- `check_flow_connections` — unbound references used by active flows, disabled
  owners, owner mismatches, unused references.
- `analyze_flow_runs` — per-flow success rate, duration percentiles, error
  clusters, failure streaks.

**Cap:** `analyze_flow_runs` reads a single page of **500** runs (the Dataverse
elastic-table page cap) and sets `truncated: true` when it hits it. Narrow
`hoursBack` or scope by `flowId` for a complete picture, and check the flag
before quoting a success rate.

**Done:** you can name who owns what and which flows are unreliable.

### 3. `analyze_plugin_performance` — only if traces are on

p50/p95/avg/max duration, depth, sync vs async, and anti-pattern flags: slow
synchronous steps, deep cascades, N+1 firing within one correlation.

Requires plug-in trace logging. With it off you get an empty table, correctly.

**Done:** a ranked list of what is slow and why.

### 4. `detect_automation_loops` — only on written request

See below. This is not a step you run because you got to step 4.

---

## `detect_automation_loops`

<a id="detect_automation_loops"></a>

**Do not run this on a demo, on a first pass, or during triage.**

On `sss-prod` it **timed out after 840 seconds**. It parses the stored
definition of each activated cloud flow client-side and builds a graph, so its
cost scales with how many flows it scans rather than with how many are relevant
to your question.

It is bounded, but not cheaply: `maxFlows` accepts 10–1000 and **defaults to
500**, and the result carries `truncated: true` when the cap is reached. Lowering
`maxFlows` is what makes it finish; it is also what makes the answer partial, so
read the flag before trusting the graph.

Run it only when a client has asked for loop detection **in writing** and
understands it may not return.

**Scope, and say it:** definition-based and **cloud-flow only**. Self-loops and
2–3 flow cycles. Plug-in ↔ flow ping-pong is **out of scope** — for the
pro-code side use `analyze_plugin_performance` depth flags and
`what_runs_on_table`.

Improving the timeout, scan cap, or progress reporting is worthwhile and is a
**separate change** — not a new detection algorithm, and not part of this page.

---

## Reading empty results

The most common misreading on a live call: an empty result is not a failure.

| Result | What it usually means |
| --- | --- |
| `count: 0` + a hint | The window is genuinely empty, or a switch is off. Read the hint. |
| Trace tools empty | Check `get_org_automation_settings` first. |
| Flow tools empty | Run history covers solution-aware flows only. |
| `truncated` / `flowsScanTruncated` | You are looking at a **partial** answer. Narrow the window before quoting numbers. |

Every tool returns a structured error envelope — `{ error, hint, docsUrl }` —
rather than a raw exception. Known failure modes (missing privilege, feature
disabled, empty result) carry a specific hint. If you get a bare exception, that
is a bug worth reporting.

---

## What these tools do not do

- **They are read-only.** The client exposes only reads. Nothing here creates,
  updates or deletes anything in the org.
- **They do not map a whole environment.** `what_runs_on_table` is one table.
- **They complement rather than replace** Microsoft's
  [Dataverse MCP server](https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-mcp)
  (data operations — query, create, update) and FlowAgent (which writes flows).
  Running this alongside the official server is a reasonable setup.
- **A cloud MCP host still sends tool JSON — including results — to the model
  vendor.** This process talks only to your org's Web API and Entra ID, but that
  is a statement about this process, not about your whole toolchain. Know which
  host you are running before you put a client's data through it.
