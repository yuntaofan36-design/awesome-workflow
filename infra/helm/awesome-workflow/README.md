# Awesome Workflow Helm chart

This chart deploys the stateless API, validation worker, Web Shell, and Control
Plane independently. PostgreSQL, Redis, S3-compatible storage, Logto, SMTP, and
signing keys are intentionally external production dependencies.

Create the secret named by `global.existingSecret` with these exact keys:

- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_SECRET`
- `OTP_PEPPER`
- `WORKER_CALLBACK_TOKEN`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `RELEASE_SIGNING_PUBLIC_KEYS`, containing a JSON map or comma-separated
  `keyId=raw-base64-public-key` pairs

When the SMTP relay requires authentication, add both `SMTP_USER` and
`SMTP_PASSWORD`; omit both only for an intentionally trusted relay. If
`config.api.emailDelivery` is `webhook`, also add `EMAIL_WEBHOOK_TOKEN`. Never
store any of these values in `values.yaml`.

`S3_ENDPOINT` is the private endpoint used for verification and Worker
downloads. `S3_PUBLIC_ENDPOINT` is the browser-resolvable endpoint used when
signing uploads. Set `config.worker.artifactAllowedOrigins` to the origin of
the private endpoint, because the API deliberately issues internal download
URLs to the Worker.

## Database migration ordering

The chart runs the API image's checked-in Drizzle migrator as a blocking Helm
`pre-install,pre-upgrade` Job. Helm does not create or roll the API Deployment
until that Job succeeds; a failed migration therefore fails the release. Use
Helm for installation and upgrades—rendering the hooks and applying all YAML
directly with `kubectl apply` does not preserve Helm hook ordering.

The migration Job intentionally receives only `DATABASE_URL`; the migration
entrypoint validates it as a PostgreSQL URL independently from the rest of the
API runtime configuration.

Replace every example hostname, image repository, and signing key before an
installation. Keep `AUTH_DEV_EXPOSE_OTP=false` in production.

The Web Shell and Control Plane are static Vite bundles. Variables such as
`VITE_API_BASE_URL`, `VITE_CONTROL_PLANE_MANIFEST_URL`, and
`VITE_TRUSTED_FEDERATION_ORIGINS` must be supplied when their images are built;
changing Helm values at runtime cannot rewrite an already-built bundle.
The provided GitHub image workflow therefore requires repository variables
`AW_WEB_API_BASE_URL`, `AW_CONTROL_PLANE_MANIFEST_URL`, and
`AW_TRUSTED_FEDERATION_ORIGINS` before publishing static images. With the
example two-host Ingress, use the public Shell API URL, the Control Plane
`/mf-manifest.json` URL, and the Control Plane origin respectively. Static
assets return permissive CORS headers because federation resources are public
code loaded with credentials omitted; API CORS remains restricted separately
by `config.api.origins`. The chart renders each static component's CSP into a
read-only Nginx ConfigMap and starts Nginx directly, so the containers do not
need to rewrite configuration on a read-only root filesystem.

Use a separate Logto release (or managed OIDC provider) so IdP upgrades and
database maintenance are independent from application rollouts. The local
Compose stack includes Logto only for development. Neither chart provisions a
Logto tenant application, social Connector, sign-in experience, or provider
consent state; `OIDC_ENABLED_PROVIDERS` is only a client descriptor allowlist.
Email OTP is owned by the API BFF and delivered through the independently
configured SMTP relay; see `docs/local-logto.md` before production acceptance.

Validate both charts without contacting a cluster:

```powershell
helm lint infra/helm/awesome-workflow
helm lint infra/helm/logto
```
