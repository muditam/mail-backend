# Thirty-day browser sessions

New browser logins use a fixed 30-day lifetime with inactivity expiry disabled:

```env
SESSION_IDLE_MINUTES=0
SESSION_ABSOLUTE_HOURS=720
```

These are backend settings only. `0` means inactivity expiry is disabled; a positive idle timeout remains supported for deployments that need it. Configuration accepts up to 720 absolute hours. Defaults and `.env.example` use the settings above; explicit environment values override defaults. The local backend `.env` has been updated. Heroku configuration and Stalwart settings were not changed during implementation, and no deployment was performed for this feature.

Cookie Max-Age counts down to the session's original absolute expiry. Reads, CSRF checks, token refreshes and MongoDB TTL cleanup use that same fixed deadline. Requests do not extend the absolute lifetime. Closing/reopening a normal browser preserves the persistent HttpOnly cookie; clearing cookies or closing private browsing can remove it. Logout, password changes/onboarding version changes and confirmed revoked upstream credentials can still end access sooner.

Existing sessions retain the deadline stored when they were created. They are not resurrected or extended to 30 days. Existing users may need to sign in once to receive the new lifetime. Deploy the new backend code first with the existing environment values, then set both new session variables together. The new code supports the old settings during that transition; the old code rejects idle timeout 0 and absolute lifetime 720, so do not apply the new values before deployment.

## OAuth credential coordination

`oauth_credentials` is a shared MongoDB collection with a TTL index. Each OAuth grant stores encrypted credentials, account ID, a stable opaque credential reference and refresh state. Browser sessions and durable delivery retry jobs carry that reference inside their encrypted token data. Independent device logins normally receive distinct Stalwart refresh credentials and therefore distinct references. The reference is derived with a domain-separated HMAC of account/client/original refresh credentials, so legacy snapshots sharing those credentials can converge without guessing by email. Already diverged historical snapshots cannot safely be assumed to represent the same grant.

A request always reads the latest grant credentials, including when its in-memory or retry snapshot is stale. One atomic MongoDB update claims renewal for the grant. Other instances wait briefly for the owner and reuse the stored result. Waiting is bounded; contention returns a retryable 503 rather than expiring the session. A five-second cooldown after a temporary renewal failure prevents every concurrent request from immediately repeating the failed renewal.

Successful renewal saves the encrypted access/refresh token pair centrally before using it, and refresh-token omission preserves the previous refresh token. Refresh requests reject redirects. HTTP 429/5xx, network errors, unreadable replies, unexpected responses and client-configuration failures preserve the browser session and return a service error. Only an explicit OAuth `invalid_grant` on HTTP 400/401, or an expired access token with no refresh credential, is treated as credentials requiring reauthentication. An unqualified HTTP 401 is insufficient proof of grant revocation.

A crashed owner or lost MongoDB write can leave renewal uncertain. An expired refresh lease is fenced into an uncertain state and is not blindly replayed. The browser session is retained, but requests report a service error; signing in again obtains a new grant if recovery is needed. No implementation can guarantee uninterrupted login through lost provider responses, revoked credentials or outages. The v0.16.26 provider refresh handler permits retries of still-valid refresh credentials; revisit network-ambiguity handling if upgrading to a provider/version with stricter refresh-token replay rules.

Browser sessions are checked again after renewal. A concurrent logout or absolute expiry cannot cause renewal to recreate a session. Revocation of one grant and logout of one browser do not revoke independently signed-in devices. Account-wide password-setup revocation remains intentional.

Retry jobs share centralized refresh state with the browser but retain their existing send claims and dispatch fencing. They can continue after browser logout within their own existing deadline. This change never retries an uncertain email submission or re-adds accepted recipients. Upstream credential failures can still move retry jobs to attention under the existing conservative delivery policy.

The grant collection stores ciphertext only; no plaintext credentials or provider responses are logged. Grant retention covers its consumers' deadlines and the configured retry window, so pending retries can outlive a browser session. Expiry does not authorize access: every browser operation still needs its own live session and account policy. Keep SESSION_ENCRYPTION_KEY stable across dynos/restarts. No new secret environment variable is required.

## Stalwart and rollout

The backend cannot renew a Stalwart refresh token that Stalwart has expired or revoked. Verify the installed server's refresh-token lifetime supports at least 30 days of non-use. The documented default is 30 days, but the actual deployed setting has not been read or changed here. Access tokens should remain short-lived and renew automatically; do not set access tokens to 30 days. Any server-wide token setting also affects other clients and should be reviewed separately.

Before deployment: run the backend suite/build, verify the branch diff excludes account-administration code, deploy the new code before updating Heroku's two session variables together, and verify readiness. Test a permitted account in two browsers/devices after rollout without changing its password. No frontend environment change is required. The unmerged admin implementation remains on its separate local branch.

Regression tests simulate 29 days of inactivity, exact expiry, cookie/CSRF consistency, multi-instance renewal, device isolation, temporary upstream failures/cooldown, confirmed invalid grants, stale refresh owners, logout during renewal and shared retry credentials. All provider and time tests use isolated MongoDB/test doubles, not real account passwords or real email submissions.
