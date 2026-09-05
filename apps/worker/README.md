# Validation worker

The worker consumes `release.validate` BullMQ jobs and returns structured
validation evidence to `/api/v1/internal/validation-results`. It streams
objects to a private temporary directory, checks declared size and SHA-256,
verifies Ed25519 publisher signatures for Web releases, downloads and hashes
the SBOM, parses its declared format, and inspects ZIP/`.awpkg` entries without
extracting. Desktop releases do not carry publisher signatures; their artifact
digest, size, SBOM, platform, manifest, permissions, and archive safety checks
remain mandatory.

Required environment:

- `REDIS_URL`
- `WORKER_API_BASE_URL`
- `WORKER_CALLBACK_TOKEN`
- `ARTIFACT_ALLOWED_ORIGINS`

`RELEASE_SIGNING_PUBLIC_KEYS` is required when this worker validates Web
releases. It is a JSON object from key id to raw 32-byte Ed25519 public key
encoded as base64. A Desktop-only worker may omit it and uses an empty key map.

Limits are configured with `ARTIFACT_MAX_BYTES`, `ARTIFACT_MAX_FILES`,
`ARTIFACT_MAX_EXPANDED_BYTES`, and `SBOM_MAX_BYTES`. Object redirects and
origins outside the explicit allowlist are rejected. Private keys never belong
in the worker.
