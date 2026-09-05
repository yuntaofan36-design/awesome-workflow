# Awesome Workflow CLI

`aw` is the publisher-facing CLI for Web and desktop micro-applications. It
targets Node.js 24 and intentionally does not support long-lived personal
tokens.

## Commands

```powershell
# Create a Module Federation manifest template. The template has an explicit
# unsigned placeholder; package will replace its signing envelope.
pnpm aw init --kind web --app-id example-app

# Desktop manifests and packages do not contain publisher signatures.
pnpm aw init --kind desktop --app-id desktop-example

# Validate the manifest, then execute an argv vector without a shell.
pnpm aw dev -- pnpm dev

# Package a Web build into a deterministic ZIP and emit both CycloneDX and
# SPDX. Web packages require an Ed25519 PKCS#8 publisher key (or base64 DER
# supplied through an environment variable).
pnpm aw package --key-id publisher-2026 --private-key C:\secure\publisher.pem

# Package every artifact declared by a desktop manifest in one operation.
# Paths in the map are resolved relative to the map file.
pnpm aw package --manifest .\applet.json --artifact-map .\aw.package.json `
  --output .\.aw

# Upload every artifact + primary SBOM pair, finalize all, then submit once.
pnpm aw login --api http://127.0.0.1:4100
pnpm aw publish --application-id 00000000-0000-4000-8000-000000000001

# Promotion always carries an optimistic concurrency expectation.
pnpm aw promote `
  --application-id 00000000-0000-4000-8000-000000000001 `
  --release-id 00000000-0000-4000-8000-000000000002 `
  --channel stable `
  --expected-current-release-id 00000000-0000-4000-8000-000000000003

pnpm aw status --release-id 00000000-0000-4000-8000-000000000002
```

## Language

The CLI ships `en-US` and `zh-CN` messages. Select a language globally before
the command, or configure it for the current process:

```powershell
pnpm aw --locale zh-CN help
$env:AW_LOCALE = 'zh-CN'
pnpm aw status --release-id 00000000-0000-4000-8000-000000000002
```

Resolution order is `--locale`, `AW_LOCALE`, operating-system locale, then
`en-US`. Human-readable help and errors are translated, while JSON field names
and protocol values such as `approved`, `stable`, and `approve` remain stable
for automation. `Accept-Language` is sent only to the Awesome Workflow API; it
is removed from presigned object-storage uploads.

Use `--token-env NAME` in ephemeral automation when an already exchanged,
short-lived publisher token is injected by the runner. The variable's value is
never printed. `aw login --ci-oidc-env NAME` instead treats the value as a
workload OIDC subject token and sends it only to the exchange endpoint.

## Authentication protocol boundary

Interactive login is fully prepared for a loopback PKCE flow:

1. listen on an ephemeral `127.0.0.1` port;
2. create a high-entropy verifier, S256 challenge, and state;
3. call `POST /api/v1/auth/cli/authorize`;
4. strictly verify the callback state; and
5. exchange the code at `POST /api/v1/auth/cli/token`.

CI exchange calls `POST /api/v1/auth/workload/exchange`. The API implements both
flows: browser authorization codes are consumed atomically and workload tokens
are accepted only when issuer, audience, JWKS URI and subject match an explicit
policy. The Web email/OIDC cookie flow is not repurposed for CLI authentication
because it cannot safely provide the short-lived publisher credential required
by this protocol.

Successful sessions are stored in the user configuration directory with mode
`0600` (directory `0700` where the platform supports POSIX modes). Tokens,
private keys, signature values, presigned URLs, storage keys, and reviewer IDs
are excluded from command output.

## Package format

`.aw/package.json` references these sibling files. Schema version 1 remains the
single-input format; schema version 2 contains a sorted `artifacts` array for a
complete multi-artifact release:

- one deterministic, uncompressed ZIP per artifact;
- the release manifest (signed for Web, unsigned for desktop);
- a CycloneDX JSON SBOM per artifact used by the upload contract; and
- an SPDX 2.3 JSON SBOM per artifact, also embedded in its ZIP alongside CycloneDX.

The CLI rejects absolute/traversing archive paths, Windows device/alternate
stream paths, case-folded duplicates, symlinks, and non-regular files. Web
federation packages bind `integritySha256` to the single `mf-manifest.json` in
the build output. `aw init` puts `__AW_FEDERATION_SHA256__` in the manifest URL
path; `aw package` replaces it with the measured digest before signing. A
custom Federation URL must use the same placeholder or already contain the
measured digest in its path. `resourceOrigins` contains exact HTTPS origins
(loopback HTTP is reserved for local development), and the signed Federation
CSP must name exactly those origins for scripts, styles, and manifest fetches.
Desktop artifact maps must cover the manifest's complete artifact set, and
each artifact input must contain the runtime entries that reference it. The
desktop manifest and artifact metadata remain unsigned; the control plane binds
them to the authenticated publisher, immutable SHA-256 digests, and uploaded
object sizes. Web manifests are signed only after every immutable artifact
descriptor has been derived.

The shared `UploadIntentSchema` declares separate presigned PUT targets for the
artifact and primary SBOM. Publishing treats both as mandatory, stops before an
artifact finalize if either upload is absent or rejected, and submits the
Release only after every artifact has finalized.
