# Security policy

Report vulnerabilities privately to the repository security contact. Do not
include production tokens, OTPs, artifact signing keys, private user data, or
credential-store exports in issues or logs.

## Secret handling

- Rotate any credential found in the legacy repository; do not migrate it.
- Store deployment and release signing material in CI Secret Manager or KMS.
- Store desktop refresh material only in Windows Credential Manager or macOS
  Keychain.
- Keep `.env`, local state, downloaded artifacts and task logs untracked.
- Use workload OIDC for CI publishing and short-lived PKCE sessions for people.

## Supported trust levels

Trusted reviewed Web code may use Federation. Other Web code must use the
cross-origin iframe runtime. Python and native desktop applications are limited
to workspace-trusted or officially reviewed signatures until an OS-specific
sandbox profile is implemented and independently assessed.
