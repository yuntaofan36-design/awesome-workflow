# Logto chart

Logto is a separate release so identity upgrades, scaling and rollback do not
depend on the Awesome Workflow API deployment. The external secret must expose
the `DB_URL` expected by the selected image. That is the only secret this chart
requires today. Social Connector credentials are configured as Logto
resources; placing extra keys in the Kubernetes Secret does not create or
configure those resources. Awesome Workflow email OTP is delivered by the API's
separate SMTP configuration and does not require a Logto email Connector.

The chart intentionally has no tenant/application/Connector bootstrap. When
`migration.enabled=true`, the pre-install/pre-upgrade hook runs only the pinned
image's `npm run cli db seed -- --swe` database command. It does not create the
Workflow OIDC client, redirect URI, Google/Feishu/WeChat Connectors, sign-in
experience, or provider consent state. Keep the hook
disabled until its behavior, backup, and rollback have been verified against
the exact image digest and database snapshot.

Google, Feishu, and WeChat remain independent Logto Connectors that can be
enabled later without adding provider secrets to the Workflow API.
`OIDC_ENABLED_PROVIDERS` in the application only describes which
already-configured provider entry points the client may display; it does not
provision or validate a Connector.

The chart exposes the public OIDC endpoint through `ingress.publicHost`. The
Console Ingress is disabled by default; prefer private network access, or set
`ingress.adminEnabled=true` only together with a separate access policy. Keep
`endpoint`, `ingress.publicHost`, and the API's `OIDC_ISSUER` aligned—the issuer
identity must not change between browser and server-side discovery.

Pin the image by digest in production and verify the migration command against
that exact Logto version before enabling the hook. The admin endpoint should be
private or protected separately from the public OIDC endpoint.

The pinned image does not declare a Docker `USER`. This chart explicitly runs
its existing `node` user as UID 1000 with GID 0 because the image makes the
alteration-script directory group-writable for non-root execution. Revalidate
that UID, group, and writable-path assumption whenever the image changes; an
unqualified `runAsNonRoot: true` against a root-default image will fail before
the container starts.
