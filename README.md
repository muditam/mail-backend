# 60Brands mail backend

Node.js 22+ / TypeScript / Fastify backend for the existing `mail-frontend`. It exposes `/api/app/v1` on port 3000 by default. Stalwart remains the mailbox and message store. MongoDB holds only app sessions, encrypted OAuth token material, temporary blob references, and send attempt hashes.

Authenticated mailbox refreshes are limited per session to 30 folder-list requests and 60 message-list requests per minute before any Stalwart call. The current limiter is process local, so these ceilings apply independently on each web dyno.

## Run locally

```bash
npm install
cp .env.example .env
# Set MONGODB_URI, SESSION_ENCRYPTION_KEY, OAuth client values, and URLs in .env.
npm run dev
```

Use a dedicated MongoDB database and a database user with access only to it. The app creates its collections and expiration indexes on startup; the user needs index creation permission. Keep `MONGODB_URI` and `SESSION_ENCRYPTION_KEY` in environment secrets, never in source control. The server automatically loads `mail-backend/.env` when present; environment variables supplied by Heroku or your shell take precedence. `npm run check`, `npm test`, and `npm run build` validate the package. Tests start a temporary local MongoDB instance; they never use your configured cluster. `npm start` runs `dist/server.js` after a build. `/health` checks the process; `/ready` pings MongoDB. Neither endpoint tests upstream auth.

`MONGODB_URI` is required; `MONGODB_DB_NAME` defaults to `webmail`. For Heroku, set the URI and encryption key as config vars, set `HOST=0.0.0.0`, and deploy the backend with the frontend on the same HTTPS origin or proxy `/api` to the backend. The backend currently has no active MongoDB credentials and has not been tested against your own cluster. Its user must be able to reach the cluster from the Heroku dyno.

The frontend currently reopens drafts without restoring Bcc recipients; verify that UI behavior during integration before relying on saved Bcc drafts.

The frontend reads its own `.env`: `VITE_API_BASE_URL` controls the browser API path and `DEV_API_PROXY_TARGET` controls Vite's local proxy. Keep the frontend proxy target aligned with this backend's `HOST` and `PORT`. `APP_ORIGIN` must be the exact browser origin (`http://localhost:5173` locally). Production must use a single HTTPS origin; this backend currently assumes the single-origin arrangement. Set `STALWART_URL`, `STALWART_AUTH_URL`, `STALWART_TOKEN_URL`, and `STALWART_JMAP_SESSION_URL` in the backend environment. The latter three must use the same HTTPS origin as `STALWART_URL`. JMAP API, upload, and download URLs come from Stalwart's authenticated session discovery response. Set the OAuth redirect URI to the exact URI registered for this client in Stalwart. The BFF exchanges codes server to server and does not need a browser callback route, but Stalwart may require a registered redirect URI match.

## API contract

See `openapi.yaml`. All application routes are under `/api/app/v1`; the frontend already uses their request and response shapes. Mutating routes require `Origin` or `Referer` matching `APP_ORIGIN`. Except login, they also require `X-CSRF-Token` returned by login or session restore. Browser requests include the opaque `HttpOnly` session cookie. JSON errors use `error.code`, `error.message`, and `error.requestId`. Message pages are sorted by `receivedAt` descending; `cursor` is a numeric offset string. Attachment multipart field is `file`, with a 20 MiB cap and maximum 10 referenced attachments per draft.

## Security and operations

The backend binds to `127.0.0.1` by default. In production, serve the frontend and `/api/app/v1/*` from one HTTPS origin. Forward the actual `Origin` header and avoid rewriting cookie attributes. The app checks Stalwart URLs against `STALWART_URL`'s HTTPS origin to avoid following arbitrary advertised hosts. Adjust that rule only after verifying a deliberate separate JMAP host. Store `SESSION_ENCRYPTION_KEY` in a secret manager and back up MongoDB with access controls. Changing the key invalidates persisted sessions. Idle expiry is 30 minutes by default; the browser cookie has the same maximum age from login, while the server also imposes a 12-hour absolute cap. Restart preserves unexpired sessions. Logout deletes the MongoDB session, upload references, and send attempt records. Upstream token revocation is not attempted because the live OAuth discovery currently advertises no revocation endpoint.

The app does not log request bodies, passwords, tokens, message contents, or attachment bytes. It does not render HTML mail. Uploaded blobs are stored in Stalwart; this service stores only short-lived references. A repeated identical send payload within 24 hours in the same app session returns `SEND_STATUS_UNKNOWN` to avoid duplicate submissions after a timeout. Confirm Sent before creating a new send attempt.

## Live integration gate

Stalwart URLs exercised: `POST https://mail.60brands.com/api/auth`, `POST https://mail.60brands.com/auth/token`, `GET https://mail.60brands.com/.well-known/jmap` (redirects to `https://mail.60brands.com/jmap/session`), `POST https://mail.60brands.com/jmap/`, `POST https://mail.60brands.com/jmap/upload/{accountId}/`, and `GET https://mail.60brands.com/jmap/download/{accountId}/{blobId}/{name}?accept={type}`. The placeholders in blob URLs are filled with values from the authenticated session and message.

On 2026-10-21, a test mailbox authenticated through `POST https://mail.60brands.com/api/auth`, received an access and refresh token from `POST https://mail.60brands.com/auth/token`, and fetched the authenticated JMAP session from `GET https://mail.60brands.com/.well-known/jmap` (redirecting to `/jmap/session`). The deployed auth response uses `client_code`, which the adapter now accepts. The JMAP session advertised API, upload, and download URLs and the mail/submission capabilities. The installed Stalwart version, registered OAuth client policy, and per-account upload limits still require operator verification. A live backend test then logged in as test1, listed folders and Inbox messages, uploaded a 34-byte text attachment, saved and read a draft, submitted a self-addressed message, found it in Sent and Inbox, downloaded the attachment from both copies, and logged out. The test message remains in the test mailbox. The implementation uses the documented Stalwart `POST /api/auth` `authCode` flow and standard authorization-code/refresh-token form fields. If the deployment is upgraded, reverify this flow and adjust the isolated `src/stalwart.ts` adapter if needed. No Stalwart, DNS, MX, or firewall settings were changed.

Manual staging checks with owner-provided test mailbox credentials:

1. Verify installed Stalwart version and OAuth client registration/redirect URI in its admin UI; check the authenticated JMAP session and advertised capabilities.
2. Log in as test1, list/read mail, mark read/unread, upload and download a small attachment, save/edit/delete a draft, and send test1 to test2. Confirm the message moves to Sent and test2 receives the attachment.
3. Log out and sign in as test2. Confirm test1's IDs and attachments cannot be used. Restart Node and verify session persistence and expiry.
4. Test invalid credentials, MFA-required, oversized upload, upstream outage, and ambiguous send timeout. Confirm browser storage and logs have no secrets.
5. Test external outbound only with a consenting recipient. External inbound remains dependent on the separate MX cutover.

Protocol references: [Stalwart API](https://stalw.art/docs/development/api/), [Stalwart OAuth clients](https://stalw.art/docs/auth/oauth/oauth-client/), [Stalwart JMAP](https://stalw.art/docs/http/jmap/), [JMAP Mail RFC 8621](https://jmap.io/spec/rfc8621/).
