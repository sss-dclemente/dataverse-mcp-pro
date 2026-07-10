# get_failed_async_jobs

Summarizes failed and canceled Dataverse async jobs (system jobs, the
`asyncoperation` table) over a recent time window. Instead of dumping raw rows,
it returns counts, groups by job name + error code (so recurring failures stand
out), and the ten most recent individual failures — including whether a job type
is retryable from the system jobs grid (currently workflows).

Use it to answer "what background work has been failing lately and why?"
without opening the Power Platform admin center.

**Tier:** Free

## Inputs

| Name        | Type    | Required | Default | Description                                                      |
| ----------- | ------- | -------- | ------- | ---------------------------------------------------------------- |
| `hoursBack` | integer | no       | `24`    | How many hours back to look for failed or canceled jobs (1–168). |

## Example call

```json
{
  "name": "get_failed_async_jobs",
  "arguments": { "hoursBack": 24 }
}
```

## Example output (trimmed)

```json
{
  "totalFailures": 6,
  "failed": 4,
  "canceled": 2,
  "windowHours": 24,
  "groups": [
    {
      "name": "Sync Contacts Workflow",
      "errorCode": -2147220970,
      "count": 3,
      "retryable": true,
      "operationType": "Workflow",
      "latestMessageExcerpt": "Unhandled exception in workflow: System.TimeoutException: The sync to the downstream contact service timed out after 120 seconds. ...",
      "latestOccurrence": "2026-07-10T11:30:00Z"
    },
    {
      "name": "Nightly Bulk Delete",
      "errorCode": null,
      "count": 2,
      "retryable": false,
      "operationType": "Bulk Delete",
      "latestMessageExcerpt": "Job was canceled by an administrator.",
      "latestOccurrence": "2026-07-10T08:00:00Z"
    }
  ],
  "topFailures": [
    {
      "id": "11111111-0000-0000-0000-000000000001",
      "name": "Sync Contacts Workflow",
      "operationType": "Workflow",
      "status": "failed",
      "errorCode": -2147220970,
      "messageExcerpt": "Unhandled exception in workflow: System.TimeoutException: ...",
      "retryable": true,
      "createdon": "2026-07-10T11:30:00Z",
      "completedon": "2026-07-10T11:31:00Z"
    }
  ]
}
```

Notes:

- `groups` is sorted by `count` descending; `topFailures` holds at most the 10
  most recent rows.
- Message excerpts are truncated to 300 characters and omitted when the job has
  neither `message` nor `friendlymessage`.
- The query reads at most 500 rows; when exactly 500 come back the response
  includes `"truncated": true` — narrow `hoursBack` to see everything.

## Common errors

| Situation                                  | Response                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 403 from Dataverse                    | Error envelope with the Dataverse message, a hint that reading system jobs requires read privilege on the AsyncOperation (System Job) table (`prvReadAsyncOperation`), and a docs link to the asynchronous service documentation. |
| Other Dataverse/network errors             | Generic error envelope (`{ "error": "..." }`).                                                                                                                                                                                                  |
| No failed or canceled jobs in the window   | **Not an error.** A zeroed summary with `"hint": "No failed or canceled async jobs in the last N hours."`.                                                                                                                                      |
