# Implementation status and acceptance boundary

This file prevents scaffolding or simulated tests from being mistaken for
production acceptance.

Evidence levels used here:

- **L1 — source/configuration:** a contract, implementation, or deployment file exists.
- **L2 — simulated integration:** unit tests, an in-memory repository, Fastify `inject`, mock fetch, or local process integration passes.
- **L3 — deployed integration:** real Compose services, PostgreSQL/S3/Redis, and a real browser or Tauri process interoperate.
- **L4 — production-style acceptance:** signed/notarized packages, real machines, production-like identity, networking, storage, and upgrade paths pass.

L1 and L2 are engineering evidence, not substitutes for L3 or L4.

| Capability             | Repository proof expected                                      | Real-environment acceptance still required                               |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| contracts and manifest | schema tests and generated JSON Schema                         | compatibility against independently built apps                           |
| email authentication   | BFF OTP policy, SMTP adapter and API tests                     | real SMTP delivery, Redis abuse testing and bounce/availability handling |
| provider slots         | generic descriptors and OIDC adapter                           | Google, Feishu and WeChat connector credentials/consent                  |
| release/channel        | transactional repository tests                                 | PostgreSQL concurrency and S3 failure injection                          |
| Control Plane UI       | registered apps, release history and review queue API/UI tests | browser E2E against a deployed API and independent remote                |
| artifact validation    | worker tests with malicious fixtures                           | production KMS keys, scanner and large artifact load                     |
| Web Federation         | host lifecycle tests/build                                     | two independently deployed remotes and no-shell-rebuild rollback         |
| sandbox iframe         | origin/source/capability tests                                 | distinct-origin browser security test with CSP/CDN                       |
| Agent/Runner           | Rust unit/integration tests                                    | login-start persistence, offline schedule, crash and cancellation        |
| desktop Web UI         | loopback server, browser SDK and child WebView boundary tests  | real WebView2/WKWebView launch, close and process-crash smoke            |
| desktop packages       | Tauri build/check                                              | signed Windows x64 and notarized macOS arm64 real-machine smoke          |
| Compose/Helm           | config/template validation                                     | end-to-end deployment with external DNS/TLS/storage/IdP                  |
| permission grants      | strict contract, hash, repository and Fastify `inject` tests   | offline expiry, revocation cleanup, directory picker and OS prompts      |

No row is considered complete solely because its directory or API shape exists.

## Explicitly open acceptance gaps

- The elevated helper has no L4 macOS Authorization Services acceptance. A Rust type or mock result does not prove a real authorization prompt, signed helper install, cancellation, or failure recovery.
- `user-selected` filesystem scope is only a Manifest/Broker contract until a real OS directory picker returns a durable, revocable grant and the Runner is proven unable to escape it.
- Offline permission-grant expiry is not closed. The Agent needs a bounded authorization lease and deterministic behavior when it expires without server connectivity.
- Revoking a server grant blocks future server-authorized work, but removal of cached schedules, task leases, installed files, and already-running processes on every device is not yet accepted.
- Federation manifests reject `unsafe-eval`, but the Module Federation runtime has not been proven in a deployed browser under the production CSP. Source-level policy checks do not prove that transitive runtime code never requires dynamic evaluation.
