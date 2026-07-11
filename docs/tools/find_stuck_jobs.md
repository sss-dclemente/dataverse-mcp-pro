# find_stuck_jobs

Surfaces Dataverse async jobs (system jobs, the `asyncoperation` table) that
have been sitting in a non-terminal state — waiting for resources, waiting, or
in progress — since before a configurable age threshold. It is the backlog
complement to `get_failed_async_jobs`: failed jobs are loud, but the backlog
nobody notices until workflows are hours behind is made of jobs that never
finish at all.

Jobs whose `postponeuntil` is still in the future are legitimately parked
(e.g. a workflow timeout/delay step) and are reported separately as
**scheduled**, not stuck.

**Tier:** Free

## Inputs

| Name             | Type    | Required | Default | Description                                                                              |
| ---------------- | ------- | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `olderThanHours` | integer | no       | `6`     | Flag jobs created more than this many hours ago that are still waiting/in progress (1–720). |

## Example call

```json
{
  "name": "find_stuck_jobs",
  "arguments": { "olderThanHours": 6 }
}
```

## Example output (trimmed)

```json
{
  "stuckCount": 7,
  "scheduledCount": 1,
  "windowNote": "jobs created more than 6 hours ago still waiting/in progress",
  "groups": [
    {
      "name": "Sync Contacts Workflow",
      "operationType": "Workflow",
      "statusBreakdown": { "waitingForResources": 1, "waiting": 2, "inProgress": 1 },
      "count": 4,
      "oldestCreatedOn": "2026-07-10T06:00:00Z",
      "ageHours": 30
    },
    {
      "name": "Nightly Maintenance",
      "operationType": "Bulk Delete",
      "statusBreakdown": { "waitingForResources": 1, "waiting": 1, "inProgress": 0 },
      "count": 2,
      "oldestCreatedOn": "2026-07-10T09:00:00Z",
      "ageHours": 27
    }
  ],
  "oldest": [
    {
      "id": "22222222-0000-0000-0000-000000000001",
      "name": "Sync Contacts Workflow",
      "operationType": "Workflow",
      "status": "waiting",
      "createdOn": "2026-07-10T06:00:00Z",
      "ageHours": 30,
      "messageExcerpt": "The workflow instance has been waiting on an asynchronous child operation for an extended period. ..."
    }
  ],
  "hints": [
    "waiting-for-resources jobs older than a day usually mean the async service is saturated or maintenance jobs are blocked",
    "1 postponed job(s) with postponeuntil in the future were excluded as scheduled — they are waiting by design, not stuck."
  ]
}
```

Notes:

- `groups` is keyed by job name + operation type and sorted oldest first;
  `oldest` holds at most the 10 oldest individual stuck rows.
- `status` is one of `waiting-for-resources` (statuscode 0), `waiting` (10) or
  `in-progress` (20); unknown status codes are surfaced as the raw number.
- `startedOn` appears on `oldest` rows only when the job has actually started;
  `messageExcerpt` (truncated to 200 characters) only when a message is present.
- **Postponed jobs:** rows with `postponeuntil` in the future are counted in
  `scheduledCount` and excluded from `groups`/`oldest` — a workflow parked on a
  timeout is not stuck. A `postponeuntil` in the past does *not* exempt a row.
- The query reads at most 500 rows (oldest first); when exactly 500 come back
  the response includes `"truncated": true` — raise `olderThanHours` to narrow
  the set.

## Common errors

| Situation                             | Response                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 403 from Dataverse               | Error envelope with the Dataverse message, a hint that reading system jobs requires read privilege on the AsyncOperation (System Job) table (`prvReadAsyncOperation`), and a docs link to the asynchronous service documentation. |
| Other Dataverse/network errors        | Generic error envelope (`{ "error": "..." }`).                                                                                                                                                                                     |
| No stuck jobs older than the threshold | **Not an error.** A zeroed summary with `"hint": "No stuck async jobs older than N hours — the async queue is healthy."` (`scheduledCount` may still be non-zero if postponed jobs exist).                                          |
