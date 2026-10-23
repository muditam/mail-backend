# Muditam Mail Backend

This project powers the Muditam Mail web app. It connects the web interface to the mail service and supports sign-in, reading mail, composing and sending messages, drafts, and attachments.

### Sender safety and IT reporting

`INTERNAL_EMAIL_DOMAINS` is a comma-separated exact-domain allow-list, defaulting to
`muditam.com`. Matching ignores case; subdomains and lookalikes are external.
Every summary and detail includes `safety: {classification, fromDomain,
authentication, spam}`. Missing/malformed/multiple From addresses are suspicious.
An internal-looking sender is suspicious unless the configured authentication
service reports DMARC pass with `header.from` matching the visible From domain.
DMARC incorporates SPF/DKIM alignment; SPF or DKIM pass alone is insufficient.
`X-Spam-Result` spam/reject/quarantine/discard results also raise suspicion.

`STALWART_AUTHSERV_ID` has no trusted default. Before configuring it, ensure the
receiving Stalwart ingress strips sender-supplied Authentication-Results claiming
that ID and inserts its own results. Without that guarantee leave it unset:
internal-looking messages remain suspicious. Duplicate matching results fail closed.
Header absence is unverified, never an implicit pass. Verify the deployment's
Stalwart header format; unknown formats cannot establish internal trust.

Set `IT_REPORT_EMAIL` to enable reporting. Authenticated same-origin clients POST
`{}` with the normal CSRF token to `/api/app/v1/messages/:id/report`. The backend
fetches only metadata in the signed-in account and submits a new plain-text report
containing message ID, reporter, From addresses, subject, received time and safety.
It never forwards original body, preview, attachments or raw headers. Reports are
limited to ten per session per minute and use existing duplicate-send protection.
202 means queued by the mail server, not confirmed delivery; disabled reporting,
missing messages and submission failures return errors. No external mail is sent
by the tests. Attachment trust confirmation remains a frontend per-message gate;
body links must remain plain text until a safe-link policy exists.
