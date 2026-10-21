# 60Brands Webmail — Backend Technical PRD

**Handoff:** Node.js backend implementation session  
**Date:** 2026-10-21  
**Companion:** [Frontend PRD](webmail-frontend-prd.md) · [Master PRD](webmail-prd.md)

## 1. Mission

Build the Node.js backend-for-frontend (BFF) for a minimal webmail client. It authenticates existing `@60brands.com` mailbox users with Stalwart, maintains secure app sessions, and exposes a narrow app API for listing/reading mail, attachments, drafts, sending, and logout. Stalwart remains the source of truth for accounts and all email data.

Do not build the React UI, administer Stalwart accounts, modify mail policy, or change DNS/MX/firewall/server settings.

## 2. Current environment and integration facts

- Stalwart host: `https://mail.60brands.com`, VPS IPv4 `173.249.53.250`.
- Stalwart TLS is valid for `mail.60brands.com`.
- Stalwart HTTP/JMAP is believed to be served on HTTPS port 443. Verify listener and discovery during implementation. Do not expose admin/recovery port 8080.
- Known test accounts: `test1@60brands.com`, `test2@60brands.com`; credentials must be obtained from the owner and never committed or logged.
- Mailbox and outbound sending through Apple Mail have been verified over IMAP 993 and authenticated SMTP submission 465. Web app must use JMAP over HTTPS, not raw IMAP/SMTP.
- Current external inbound route is not cut over: authoritative Cloudflare MX currently points at `eforward*.registrar-servers.com`. Do not modify it. Internal mail between Stalwart accounts can be used for integration testing.
- Outbound Gmail test headers showed SPF pass, RSA DKIM pass, and DMARC pass with `p=none`. Inbox placement is not guaranteed by this app.

## 3. MVP scope

### In scope

- Custom app login using a mailbox email and password, authenticated against Stalwart; discard password immediately.
- Server-side opaque sessions, secure cookie, CSRF defenses, logout, session expiry.
- Per-user JMAP calls: folders/counts, message query/list, message fetch, read/unread, draft create/update/delete, attachment upload/download, EmailSubmission send.
- Stable app API and error format in Section 7.
- Durable session persistence (SQLite acceptable for single-node MVP), encrypted storage of any upstream token material if persisted.
- Config validation, readiness/liveness, safe structured logging, rate limits, documentation, tests, `.env.example`.

### Out of scope

- React frontend; user/account provisioning; admin API; password reset or recovery; MFA UX; mail migration; DNS/MX changes; push/WebSocket as a launch requirement; calendar/contacts; search indexing; server queue administration.
- No generic JMAP proxy. No service/admin key for user mail.
- No mail content database/cache in the BFF.

## 4. Required implementation sequence

### Phase A — Auth/JMAP feasibility spike (must precede full implementation)

1. Establish installed Stalwart version from the running server/admin UI (history indicates `0.16.26`, confirm).
2. Inspect `https://mail.60brands.com/.well-known/jmap` and authenticated JMAP session response. Record advertised API, upload, download, and event URLs plus supported capabilities.
3. Verify exact Stalwart OAuth client configuration and login/token flow for a custom client. Current official docs describe `POST /api/auth` with `type: "authCode"`, mailbox account name/secret, client ID, redirect URI, optional PKCE challenge, and return of a one-time client code, followed by token exchange at `/auth/token`. Confirm exact token request fields, scopes, refresh/expiry behavior, client registration, MFA behavior, and logout/revocation support for the installed version.
4. Do not invent token semantics. Do not persist a mailbox password as a workaround. If a secure supported flow cannot meet the custom login requirement, document the blocker and propose a reviewed alternative before building around Basic auth.
5. Test the flow with a test account; redact secrets from terminal output and logs.

### Phase B — Implement

- Runtime: Node.js LTS, TypeScript strict mode, Fastify, request schema validation.
- Prefer a maintained JMAP client only if it supports the installed Stalwart JMAP version and correct attachment/submission flows; otherwise implement a narrow typed adapter over `fetch`.
- Discover JMAP URLs from Stalwart and follow URLs advertised by the JMAP session. Do not hardcode `/jmap` or blob URLs except where discovery contract mandates.
- Session store: SQLite for single VPS MVP, behind a replaceable repository interface. Persist opaque session ID, account ID/address, encrypted access/refresh token only if required, token expiry, CSRF secret, and timestamps. Never persist passwords, mail bodies, or attachments.
- Encryption key, cookies, Stalwart URL, OAuth client settings, DB path, and runtime options are environment-provided. Provide placeholders only in `.env.example`.

## 5. Authentication and session behavior

- `POST /api/app/v1/auth/login` receives `{email,password}` over HTTPS, validates input and applies IP/account rate limits, then invokes the supported Stalwart user OAuth flow.
- Do not log the request body. Do not persist or cache the password; drop references after auth completes.
- If Stalwart returns MFA required, return a deliberate `MFA_REQUIRED` response. Do not bypass MFA. MVP may report unsupported MFA in UI until a separately specified challenge flow is added.
- On success, establish server-side session, rotate session ID, and set opaque cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, bounded idle and absolute expiration.
- Return user email/display name and CSRF token only; no upstream tokens, JMAP session URLs, or Stalwart IDs that are not needed by UI.
- Every protected request resolves account identity exclusively from server-side session. Never trust account ID/email supplied by browser.
- `POST /auth/logout` validates CSRF/origin, deletes session, expires cookie, and best-effort revokes upstream token only if supported. Local logout must succeed even if revocation is unavailable.
- On upstream token expiry, refresh only through verified supported mechanism. If refresh fails, destroy session and return `SESSION_EXPIRED`.

## 6. JMAP responsibilities

Implement isolated services for:

- **Session/discovery:** retrieve `/.well-known/jmap`, authenticate, parse JMAP session, verify required capabilities and account ID.
- **Mailbox:** query/get mailboxes, map system roles to stable UI names (Inbox, Sent, Drafts, Junk, Trash), obtain counts where available.
- **Message list:** query emails in a mailbox, return bounded page in newest-first order, use stable cursors/state tokens internally where suitable.
- **Message read:** fetch envelope/metadata, body structure, plain-text body, keywords, and attachment metadata. Keep full message content out of logs.
- **Read state:** update `Email` keywords (e.g. `$seen`) via JMAP Email/set, respecting current account ownership and current server state.
- **Attachment upload/download:** upload bytes to advertised JMAP upload URL; associate returned blob reference with active user and draft. Download only after proving the message/attachment belongs to the session account. Stream bytes where practical.
- **Drafts:** create/update/delete draft email using JMAP Email/set and appropriate Drafts mailbox semantics.
- **Send:** create EmailSubmission referring to the draft/email and identity allowed for the user. Return accepted/queued state only after JMAP confirms creation.
- **Duplicate prevention:** never automatically retry a send after an ambiguous network timeout unless JMAP idempotency/state guarantees are verified. Return `SEND_STATUS_UNKNOWN` and allow UI to refresh Sent/submission state.

Map JMAP errors into app errors; do not leak upstream response bodies or credentials.

## 7. Shared BFF API contract

Base path: `/api/app/v1`. Cookie-based requests; React sends `credentials: "include"`. JSON error envelope:

```json
{"error":{"code":"SESSION_EXPIRED","message":"Please sign in again.","requestId":"..."}}
```

| Method + route | Request | Success response | Notes |
|---|---|---|---|
| `POST /auth/login` | `{email,password}` | `200 {user:{email,displayName?},csrfToken}` | `202 {challenge:"mfa"}` only if a real MFA continuation is implemented; otherwise stable `MFA_REQUIRED` error. Generic invalid-credential response. |
| `GET /auth/session` | — | `200 {user:{email,displayName?},csrfToken}` or `401` | No token material returned. |
| `POST /auth/logout` | CSRF header | `204` | Invalidates server-side session and cookie. |
| `GET /mailboxes` | — | `{mailboxes:[{id,name,role?,unreadCount,totalCount}]}` | Only current user. |
| `GET /messages?mailboxId=&cursor=&limit=` | query | `{messages:[summary],nextCursor?}` | Clamp limit; define ordering. |
| `GET /messages/:id` | — | `{message:{id,mailboxIds,from,to,cc,subject,receivedAt,bodyText,keywords,attachments[]}}` | HTML is optional and omitted unless safely sanitized. |
| `PATCH /messages/:id` | `{isRead:boolean}` | `{message:{id,isRead}}` | Validate ownership. |
| `POST /attachments` | multipart/form-data | `201 {attachment:{id,name,type,size}}` | User-scoped temporary/uploaded blob reference. |
| `GET /attachments/:id` | — | file bytes | Authorized; safe `Content-Disposition`, nosniff. |
| `POST /drafts` | `{draftId?,to,cc?,bcc?,subject,bodyText,attachmentIds[]}` | `{draftId}` | Validate recipients and attachment ownership. |
| `DELETE /drafts/:id` | — | `204` | Validate draft ownership. |
| `POST /messages/send` | `{draftId? OR to,cc?,bcc?,subject,bodyText,attachmentIds[]}` | `202 {submissionId,status:"queued"}` | Submit using current user identity only. |

Stable error codes: `INVALID_CREDENTIALS`, `MFA_REQUIRED`, `SESSION_EXPIRED`, `CSRF_FAILED`, `MAILBOX_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `DRAFT_NOT_FOUND`, `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_TOO_LARGE`, `INVALID_REQUEST`, `SEND_REJECTED`, `SEND_STATUS_UNKNOWN`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`.

Contract semantics:

- `Sent` is the UI label for the JMAP Sent mailbox. “Outbox” means sent-mail view, not the server’s SMTP queue.
- JMAP object IDs are opaque and never serve as authorization. Validate each operation against authenticated user’s current JMAP account.
- Upload IDs are short-lived/user-scoped and cannot be reused across users or arbitrary messages.
- `202 queued` means Stalwart accepted the submission operation; it does not guarantee recipient delivery or Inbox placement.
- Send must prevent duplicate submission on retry/timeout; UI is expected to refresh state when status is unknown.

## 8. Security and privacy requirements

- HTTPS only in production; do not use wildcard CORS. Prefer one origin for React and BFF.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, bounded lifetime, rotate on login.
- CSRF token plus Origin/Referer allow-list validation for state-changing routes.
- Never expose/store credentials or OAuth tokens in browser storage, URL, frontend-visible payload, logs, analytics, or error reports.
- No administrator credentials/API keys for user JMAP calls. No catch-all JMAP proxy.
- Per-IP and per-account rate limits for login; per-session limits for send/upload/read endpoints. Avoid account-enumeration messages.
- Validate addresses, count, content type, request size, attachment limits (initial cap no higher than 20 MiB per file until server limits are verified), cursor and IDs.
- HTML email is untrusted. Prefer plain text in MVP. If HTML is returned, sanitize server-side with a maintained sanitizer or omit it; frontend must not execute it in app origin.
- Attachment access is authenticated and ownership-checked; safe download headers and no unsafe inline rendering.
- Logs contain request ID, route, outcome, latency, sanitized code. Never log passwords, OAuth codes/tokens, cookies, message bodies, or attachment bytes.
- Structured JSON logging, redaction filters, request IDs, timeouts, bounded retries only for safe reads.

## 9. Operational and quality requirements

- Health/readiness endpoints disclose no sensitive info; readiness may verify database and Stalwart reachability without exposing details.
- Graceful shutdown closes HTTP and SQLite cleanly.
- Body/upload caps and streaming attachments to avoid large memory spikes.
- No retry of non-idempotent EmailSubmission on uncertain outcome.
- Tests: unit tests for validation/error mapping, JMAP adapter contract tests with fixtures, session/account isolation, CSRF/rate limiting, upload ownership, send ambiguity behavior; manual staging checklist against real Stalwart.
- Deliver: backend source, migration(s), `.env.example`, API/OpenAPI contract, setup/run/deploy instructions, test commands/results, and an explicit list of unresolved integration checks.

## 10. Backend acceptance criteria

1. Valid mailbox login yields server-side session and JMAP access for only that mailbox; invalid login yields generic response.
2. Password is discarded and never persisted or logged. Tokens never reach the browser.
3. Two concurrent users cannot read each other’s folders, messages, drafts, attachments, or IDs.
4. API supports mailbox list, message list/detail, mark read/unread, attachment download/upload, draft save/update/delete, message submission, and logout.
5. Expired/invalid session returns `401`/`SESSION_EXPIRED`; logout immediately invalidates local session.
6. App handles MFA-required, rate limits, upstream outage, oversized attachment, failed submission, and unknown send outcome deliberately.
7. Core behavior is covered by tests and documented against the route contract.

## 11. Deployment and launch gates

- Backend sits behind HTTPS reverse proxy; do not expose its internal Node port publicly if avoidable.
- Only proxy app routes to Node; JMAP traffic from BFF to Stalwart uses verified TLS. Keep Stalwart admin/recovery access restricted as already configured.
- Confirm session DB backup/retention; it contains no email content but may contain encrypted tokens.
- Do not modify Cloudflare records, MX, PTR, firewall, or Stalwart service configuration in this task.
- External outbound can be tested to consented Gmail mailbox. External inbound cannot be marked complete until owner approves replacing Namecheap MX and validates all necessary recipients on Stalwart.

## 12. Stalwart checks and official references

- [JMAP overview and discovery](https://stalw.art/docs/http/jmap/)
- [JMAP for Mail](https://stalw.art/docs/email/settings/jmap/)
- [API endpoints and `/api/auth` flow](https://stalw.art/docs/development/api/)
- [OAuth overview](https://stalw.art/docs/auth/oauth/)
- [Email protocol overview](https://stalw.art/docs/email/)

Use the current docs and actual server discovery, then record exact authentication/token behavior for the installed build. The PRD intentionally leaves token request details as a feasibility check rather than guessing them.
