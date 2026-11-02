# Automatic delivery retries

The backend owns a persistent MongoDB `delivery_retries` queue. The web dyno polls it; no extra dyno or Redis is required. Deploy backend and frontend together for pending/error status and read-only pending drafts.

Only JMAP recipient outcomes with `delivered: no` and a three-digit SMTP 4xx reply enter this queue. Recipients marked `yes`, `queued`, or `unknown` are never resubmitted. Stalwart owns its own queued delivery retries. Permanent rejections are not retried. This feature handles immediate submission failures; it does not monitor or resubmit later bounces for accepted mail.

Retries reference the original Email ID and identity, with an explicit SMTP envelope containing only the remaining temporary-failure recipients. The message body, attachments, To/CC/BCC headers and Message-ID are not rebuilt. BCC stays under Stalwart's normal submission handling; recipient addresses and OAuth tokens are not returned in the public retry summary.

## Schedule

First retry after 5 minutes; subsequent waits are 15 minutes, 45 minutes, then 60 minutes. The default maximum is six retry attempts, with a separate 24-hour deadline. Processing also depends on dyno uptime. Optional Heroku config vars:

- `SEND_RETRY_MAX_ATTEMPTS=6` (1–20)
- `SEND_RETRY_MAX_AGE_HOURS=24` (1–72)
- `SEND_RETRY_POLL_SECONDS=30` (10–300)

No new secrets are required. Keep the existing MongoDB settings, OAuth configuration and stable `SESSION_ENCRYPTION_KEY`.

## Failure safety

MongoDB atomically claims one job for one worker. A durable dispatch marker is written before any submission. Concurrent workers cannot dispatch that claim twice. If a process dies or a response/write is ambiguous, the job stops in `attention`; expired claims are never automatically redispatched. This intentionally favors avoiding duplicates over automatic recovery of every outage. SMTP/JMAP submission has no general exactly-once transaction with MongoDB, so an unconditional exactly-once guarantee is not possible.

Known outcomes are persisted before folder updates. Successfully accepted recipients are removed permanently from future attempts. Identical same-session send requests retain the existing send guard, and original/current draft IDs with retry records cannot be edited or resubmitted through draft/send endpoints. New intentionally composed messages are separate sends.

Fully deferred messages remain in Drafts with a read-only delivery status. A message accepted for any recipients moves to Sent with status describing remaining attempts. Pending messages cannot be moved to Trash through this app. Terminal/uncertain outcomes remain visible on the message; no synthetic bounce email is sent. `completed` means the provider accepted the remaining recipients, not that every recipient has read or finally received the message.

Each job has an encrypted OAuth credential snapshot for its authorized background send. Accepted background work continues after browser logout or idle expiry. Refresh uses the job credential; revoked/expired authorization stops retries for review. Credentials are erased at completion, exhaustion, or uncertainty; terminal metadata expires after seven days. Original messages are not deleted by this cleanup. A rotated encryption key makes old jobs require review.

No historical failed messages are automatically enrolled. Do not blindly resubmit an `attention` job: inspect its EmailSubmission and recipient status first. Tests use synthetic provider responses, including the observed 452 failure; no production emails are sent by the suite.
