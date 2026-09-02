# Validation worker

The worker consumes `release.validate` BullMQ jobs and returns structured
validation evidence to `/api/v1/internal/validation-results`. It streams
objects to a private temporary directory, checks declared size and SHA-256,
verifies Ed25519 publisher signatures, downloads and hashes the SBOM, parses
its declared format, and inspects ZIP/`.awpkg` entries without extracting.

Required environment:

- `REDIS_URL`
- `WORKER_API_BASE_URL`
- `WORKER_CALLBACK_TOKEN`
- `ARTIFACT_ALLOWED_ORIGINS`
- `RELEASE_SIGNING_PUBLIC_KEYS`, a JSON object from key id to raw 32-byte
  Ed25519 public key encoded as base64

Limits are configured with `ARTIFACT_MAX_BYTES`, `ARTIFACT_MAX_FILES`,
`ARTIFACT_MAX_EXPANDED_BYTES`, and `SBOM_MAX_BYTES`. Object redirects and
origins outside the explicit allowlist are rejected. Private keys never belong
in the worker.
