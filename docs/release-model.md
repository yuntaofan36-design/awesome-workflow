# Release and manifest model

## State machine

```text
draft -> uploading -> validating -> ready -> approved
                                  \-> rejected
```

Transitions are compare-and-set operations. A release version is unique within
an application and its manifest/artifacts are immutable after creation.
Rejected releases remain auditable and can never enter a channel. A corrected
artifact requires a new SemVer release.

Channels are small transactional pointers:

```text
(application_id, channel) -> approved_release_id
```

Promotion records actor, channel, previous release, next release, and timestamp
as an audit event in the same transaction. Rollback is another promotion,
never an artifact overwrite.

The workspace release list is the authority for draft through reviewed state.
The catalog contains only channel pointers and must never be used to synthesize
an approval queue. The review queue is the server-side `ready` subset and each
decision remains attached to the immutable release.

## Trust and signatures

- CI requests a presigned URL scoped to one release, object key, size and short
  expiry.
- The uploader sends the declared SHA-256, Ed25519 signature and SBOM metadata
  when finalizing.
- The worker computes the digest from stored bytes and verifies a currently
  trusted publisher key. Declared values alone are never trusted.
- Web resources use content-addressed paths. A catalog response binds URL,
  digest, manifest, approval and channel revision.
- CI authenticates with GitHub/GitLab workload OIDC. Interactive CLI uses PKCE.
  Long-lived application tokens are intentionally unsupported.

## Permission review

A release may reuse approval only when its effective permissions are a subset
of the last approved release and policy permits it. Any added filesystem scope,
network domain, subprocess, background execution, shortcut, clipboard, Web
broker method, or lifecycle elevation requires a new review.
