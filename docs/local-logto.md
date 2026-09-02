# Configure hybrid authentication

Awesome Workflow uses two authentication paths behind one BFF session:

- email verification codes are issued and verified by the API and delivered
  through SMTP;
- Google, Feishu, and WeChat are brokered by Logto OIDC only after their
  Connectors are explicitly enabled.

The browser never receives SMTP credentials, an OIDC client secret, Logto
tokens, or a refresh token.

## Local email OTP with Mailpit

Copy `.env.example` to an uncommitted `.env`, replace every `change-me` value,
and keep these local settings:

```dotenv
AUTH_MODE=hybrid
EMAIL_DELIVERY=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_FROM=no-reply@awesome-workflow.local
AUTH_DEV_EXPOSE_OTP=false
```

When the API runs inside Compose, `SMTP_HOST` is intentionally replaced with
the service address `mailpit`; a host-run API uses `localhost`. Start the local
dependencies and API, then inspect delivered messages at
`http://localhost:8025`:

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d postgres redis mailpit logto api
```

The BFF enforces one policy in both development and production:

- a cryptographically generated six-digit code;
- HMAC storage using `OTP_PEPPER`, never plaintext persistence or logging;
- five-minute expiry;
- at most five failed verification attempts;
- a 60-second per-email resend cooldown; and
- fixed-window limits keyed independently by normalized email and client IP.

Production uses the Redis limiter. The email challenge is created before SMTP
delivery, so an upstream delivery failure returns an error but may leave an
unreceived challenge subject to cooldown. Monitor and alert on SMTP failures;
do not bypass the cooldown or expose the code to compensate.

## What Logto initialization really does

The Compose stack pins `svhd/logto:1.31.0`. On first PostgreSQL volume creation,
`infra/compose/initdb/001-create-logto.sql` creates the separate `logto`
database. The container then runs `npm run cli db seed -- --swe` before
`npm start` and becomes healthy only after OIDC discovery responds.

Database seeding does **not** create the Awesome Workflow OIDC application,
redirect URI, Google/Feishu/WeChat Connectors, sign-in experience, provider
credentials, consent configuration, or publishing/review state. PostgreSQL
init scripts also do not rerun for an existing volume. Do not delete a volume
to make missing configuration appear initialized.

## Configure the social OIDC application

1. Open the local Logto Console at `http://localhost:3002` and complete its
   operator bootstrap.
2. Create a traditional Web application for the API BFF.
3. Register the exact sign-in redirect URI
   `http://localhost:4100/api/v1/auth/oidc/callback`.
4. Copy the application ID and secret into `OIDC_CLIENT_ID` and
   `OIDC_CLIENT_SECRET` in the uncommitted `.env`.
5. Leave `OIDC_ENABLED_PROVIDERS` empty until each Connector below is fully
   configured and tested.

For each provider:

- **Google:** create a Web OAuth client, register the Logto origin and exact
  Callback URI displayed by the Logto Google Connector, configure `clientId`
  and `clientSecret`, request only justified scopes, and complete Google's
  consent-screen test/publish process.
- **Feishu:** create and enable a custom application, register
  `${LOGTO_PUBLIC_ENDPOINT}/callback/<connector-id>`, and configure `appId` and
  `appSecret`. Saving a Connector does not release or enable the Feishu app.
- **WeChat:** use the Logto **WeChat Web** Connector, register the Logto
  authorization callback domain in WeChat Open Platform, complete provider
  review, and configure `appId`, `appSecret`, and the reviewed scope.

Add the tested Connector to Logto's sign-in experience, then add only its
target name to `OIDC_ENABLED_PROVIDERS`, for example `google,feishu`. The API
uses Logto 1.31's `direct_sign_in=social:<provider>` parameter and rejects a
direct request for any provider absent from that allowlist. The environment
variable is not a provisioning mechanism.

## Production fail-closed boundary

Production configuration parsing requires all of the following before the API
can start:

- `AUTH_MODE=hybrid`;
- PostgreSQL, Redis validation queue and S3-compatible storage;
- non-development `SESSION_SECRET`, `OTP_PEPPER`, and worker callback secret;
- `EMAIL_DELIVERY=smtp`, an SMTP host and sender, and either implicit TLS or
  mandatory STARTTLS;
- HTTPS API, Web, OIDC issuer, callback and post-login URLs; and
- an OIDC client ID and secret even if social buttons are initially hidden.

SMTP username and password are optional only for an intentionally trusted
relay, and must be supplied together otherwise. TLS certificate verification
is never disabled. A bearer-authenticated HTTPS webhook adapter remains
available for non-production integration, but production hybrid mode requires
SMTP.

The Helm chart does not provision Logto resources or SMTP accounts. Its
optional Logto migration hook only runs the pinned image's database seed
command. Real acceptance still requires SMTP delivery, Redis abuse tests, each
provider callback and consent flow, session-cookie verification, and failure
injection against unavailable SMTP and Logto endpoints.

Identity records use `(issuer, subject)` as their external key. Equal email
addresses from different providers are not sufficient for automatic account
merging; linking requires an authenticated user and explicit reauthentication.
