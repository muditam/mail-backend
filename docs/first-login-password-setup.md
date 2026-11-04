# First-login password setup

This feature automatically applies to every employee account on its next successful webmail login, including accounts created before deployment. Each account completes setup once. Stalwart owns passwords; MongoDB owns the webmail onboarding requirement. No password, password hash, admin API key or recovery token is stored by this feature. Forgot-password recovery is outside this implementation.

## Employee journey

1. IT creates the employee in Stalwart's internal directory with a unique temporary password.
2. No per-account command is required. On successful webmail authentication the backend atomically inserts a required policy if this canonical account ID has no existing onboarding record.
3. Employee signs in through Muditam Mail (existing employees use their current password). Backend authenticates with Stalwart using the existing OAuth/PKCE login flow, obtains the canonical account ID, and creates a cookie session carrying the onboarding version.
4. Login/session responses include `passwordChangeRequired: true`. Frontend renders the mandatory setup screen and never mounts Workspace. A backend guard denies mailbox, message, attachment, draft and send endpoints with `PASSWORD_CHANGE_REQUIRED` (403). Session restore, logout and setup remain available.
5. Employee enters the temporary/current password and confirms a new password. Frontend checks confirmation; backend validates 8–128 characters, nonempty and different from current. Stalwart may enforce additional password rules.
6. `POST /api/app/v1/auth/password-setup` carries `{currentPassword,newPassword}` over the existing same-origin HTTPS connection, with the HttpOnly session cookie and CSRF header. No client-supplied email/account ID is accepted. Five attempts per 15 minutes per account are allowed by the existing in-process rate limiter; Stalwart also verifies the current secret and applies its protections.
7. MongoDB atomically acquires a two-minute per-account operation lock. Backend uses the user's own OAuth token and discovered, same-origin JMAP endpoint. The mutation is `x:AccountPassword/set`, `update.singleton = {currentSecret,secret}` with `using` core + `urn:stalwart:jmap`. The singleton acts on the authenticated account. No admin credential is needed. Verified against the Stalwart v0.16.26 source mapping.
8. Only explicit `updated.singleton` confirms success. MongoDB moves the requirement to complete and rotates its version, invalidating all earlier webmail sessions. Backend deletes account sessions and expires the current browser cookie. Frontend clears cached mail/session state and shows a fresh sign-in screen.
9. Employee signs in with the new password. The completed requirement allows mailbox access. Other mail clients may need their saved password updated.

## IT workflow and rollout

Create the employee account in Stalwart's admin panel and distribute unique temporary credentials as usual. The first successful webmail login automatically requires a new password. Existing employees also change their current password once at their next sign-in. Completed accounts keep access on subsequent logins, including through aliases. Completion is never overwritten by automatic enrollment.

Existing sessions issued before rollout are not proactively invalidated by deployment. They continue until logout/expiry unless another sign-in creates the account's requirement; at that point old sessions fail their version check on the next protected request. Every successful new login enrolls before a cookie session is issued. No Stalwart directory snapshot, admin access token or additional environment variable is needed.

The optional operator command remains available only to deliberately require another change for a specific account:

```sh
npm run onboard -- employee@60brands.com STALWART_JMAP_ACCOUNT_ID
```

This is **not** part of routine employee creation. It changes the MongoDB requirement and revokes the account's webmail sessions; it does not create a Stalwart account or change its password. Use the canonical JMAP account ID and the intended backend database. Never pass passwords in command-line arguments.

## Persistent state and failures

`password_onboarding` stores account ID, operator-supplied email, random version, required/changing/complete state, marked/completed timestamps, and temporary operation/lease identifiers. It contains no passwords. Session rows record the version they were issued under. Every protected request checks the policy in MongoDB; old sessions cannot become unrestricted when another tab completes setup. MongoDB lookup failures fail closed through the normal service-error path.

An explicit wrong-current-password or provider rejection keeps setup required and releases the operation lock. A timeout, malformed response or interrupted operation may have changed Stalwart already: the requirement remains restricted, no automatic replay occurs, and the lock expires after two minutes. The employee must sign in using the password that works and submit a different new password to complete setup. Contact IT if neither credential works. If Stalwart succeeds but MongoDB finalization fails, keep the restriction; do not claim completion. Once MongoDB completes, its version mismatch protects old sessions even if physical deletion fails.

The restriction covers this webmail backend, not direct IMAP/SMTP/Outlook use. Temporary-password enforcement for every client requires mail-server/identity-provider policy. Stalwart's native password update handles its OAuth credential lifecycle; do not assume existing IMAP connections are forcibly disconnected. Existing background retry snapshots may stop when their Stalwart credentials become invalid and should be inspected rather than automatically resubmitted.

## Deployment and verification

Deploy backend and frontend together. Confirm the installed server exposes `urn:stalwart:jmap` and employee roles grant `sysAccountPasswordUpdate`; custom OAuth scopes/roles may block it. External-directory accounts must change credentials at their identity provider. No server settings or live employee passwords were modified during implementation.

Automated tests use isolated MongoDB plus mocked provider replies for restricted access, CSRF, multi-tab revocation, failure/uncertain outcomes, and the exact JMAP mutation. A disposable onboarded account on the actual Stalwart instance is still needed for a live acceptance test: temporary login -> setup -> old password rejected -> new password works -> mailbox opens. Run this with a designated disposable account; do not change an employee password as a connectivity probe.

Source references:
- https://github.com/stalwartlabs/stalwart/blob/v0.16.26/crates/jmap/src/registry/mapping/account.rs
- https://stalw.art/docs/ref/object/account-password/

## Authentication diagnostics

Structured backend events record login, password setup stages, logout and session rejection reasons. `sessionRef` is a domain-separated HMAC of the session hash; it cannot be used as a cookie or CSRF token. Logs include the authenticated email/account and request ID, never password fields or OAuth credentials. `session_revocations` retains account/email, hashed session identifier and reason for seven days with a MongoDB TTL index. Revocation records are written before deletion; existing policy version checks continue to deny sessions after a password change. Expired rows can explain idle/absolute timeouts while present; after TTL removal or for pre-deployment deletions the honest result is `unknown_session`. Missing cookies cannot be assigned to an employee. No additional environment variables are needed.

## Password rejection messages

Local validation reports too short (under 8), too long (over 128), whitespace-only and unchanged-password errors separately. Exactly 8 and 128 characters are included in the length range. The frontend shows the same local length guidance and renders safe backend rejection messages while preserving editable fields.

For Stalwart `notUpdated.singleton` errors of type `invalidProperties`, the adapter recognizes the v0.16.26 descriptions for a weak password and minimum/maximum length. It translates them into fixed public messages; length requirements are taken from a narrowly parsed numeric limit. Raw provider text, strength feedback and arbitrary descriptions are never forwarded or logged. Unrecognized policy descriptions use a safe policy fallback instead of inventing a reason. Public code remains `PASSWORD_POLICY`; internal logs get a safe `authReason`. Explicit rejection releases the onboarding operation lock so the employee can correct the input and try again. An accepted length alone does not guarantee acceptance by Stalwart's separate strength policy.
