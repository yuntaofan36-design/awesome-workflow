# Local Compose stack

The stack describes PostgreSQL, Redis/BullMQ, private MinIO storage, Mailpit,
Logto, API, Worker, Web Shell and Control Plane. Validate interpolation without
starting services or pulling images:

```powershell
docker compose --env-file .env.example -f infra/compose/docker-compose.yml config
```

Copy `.env.example` to `.env` and replace every `change-me` value before any
future build or startup. The four application images use the targets `api`,
`worker`, `web-shell`, and `control-plane` in
`infra/docker/Dockerfile`.

## Startup ordering and required signing key

`api-migrate` applies the checked-in Drizzle migrations once PostgreSQL is
healthy. The API has a hard `service_completed_successfully` dependency on that
one-shot service, so a failed migration prevents API startup. Migrations are
idempotently tracked by Drizzle; do not bypass or remove this dependency.

The pinned Logto image declares `ENTRYPOINT ["npm", "run"]`. Compose therefore
overrides `entrypoint`, runs the real `cli db seed -- --swe` command, starts
Logto, and waits for OIDC discovery before starting the API. Overriding only
`command` would incorrectly execute `npm run sh ...`. Database seeding does not
create the Workflow OIDC application, social Connectors, sign-in experience,
provider credentials, or consent configuration; complete those steps in
[the authentication guide](../../docs/local-logto.md).

Email OTP does not pass through Logto. The API connects directly to the
`mailpit:1025` SMTP fixture, while a host-run API uses `localhost:1025`. The
same BFF code path retains the six-digit, five-minute, five-attempt and
60-second resend policy; production replaces Mailpit with TLS-protected SMTP
and the in-memory abuse limiter with Redis.

Replace `RELEASE_SIGNING_PUBLIC_KEYS` with a real public-key map before the
Worker can validate releases. The placeholder is intentionally not a usable
Ed25519 key.

## Internal and public addresses

- Containers administer MinIO through
  `MINIO_INTERNAL_ENDPOINT=http://minio:9000`.
- Browser-visible artifact URLs use
  `MINIO_PUBLIC_ENDPOINT=http://minio.localhost:9000`; the API signs browser
  uploads against this address. This avoids leaking the Compose-only `minio`
  DNS name to a browser.
- Browser uploads are presigned with `S3_PUBLIC_ENDPOINT`; API verification and
  Worker downloads are presigned with `S3_ENDPOINT`. Consequently the Worker
  allowlist contains the internal `http://minio:9000` origin.
- `minio-bootstrap` keeps the bucket private and applies
  `minio-cors.xml`, which permits the two checked-in local Web origins to use
  presigned `PUT`, `GET`, and `HEAD` requests. If local Web ports or origins are
  changed, update that explicit CORS file as well; a valid signature does not
  bypass browser CORS.
- The same pattern is used for Logto: `logto` is container-only, while
  `logto.localhost` is the issuer visible to both browser and API. OIDC issuer
  identity must not be rewritten between internal and external URLs. A Compose
  network alias resolves that same hostname directly to the Logto container for
  API discovery, avoiding a host-gateway hairpin.

Expected local endpoints after the blockers are resolved:

- Web Shell: `http://localhost:4300`
- Control Plane: `http://localhost:4302`
- API health: `http://localhost:4100/api/v1/health`
- Logto: `http://logto.localhost:3001`
- Logto Console: `http://localhost:3002`
- Mailpit: `http://localhost:8025`
- MinIO Console: `http://localhost:9001`

`001-create-logto.sql` only creates the separate Logto database when the
PostgreSQL volume is first initialized. API schema migrations are owned by the
separate `api-migrate` service.

Production PostgreSQL, Redis, object storage, and Logto remain external managed
dependencies with independent backup and upgrade procedures.
