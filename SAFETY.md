Sender safety currently uses only the visible From address. `INTERNAL_EMAIL_DOMAINS` is a comma-separated exact-domain list (default `muditam.com`); matching ignores case and surrounding configuration whitespace. Subdomains must be listed explicitly. A matching domain is internal without authentication headers. Other valid domains are external; missing, malformed or multiple From addresses are suspicious.

The API returns `safety: {classification, fromDomain}`. This is not proof of sender authenticity: a forged From address can match an internal domain. Authentication and spam-header interpretation are deferred; `STALWART_AUTHSERV_ID` is not needed or read.

External or unknown senders show a warning and require per-message confirmation before attachment downloads. Trust resets on navigation, and the warning stays visible. Message bodies remain escaped plain text.

Set `IT_REPORT_EMAIL` to a monitored IT mailbox to enable Report to IT. Reports send only message metadata, not original bodies or attachments. The authenticated POST `/api/app/v1/messages/:id/report` requires an empty object and CSRF token, with a limit of ten reports per session per minute. Success means accepted for sending; submission errors remain visible. These settings belong only on the backend, not in VITE variables.
