# Implementation status and acceptance boundary

This file prevents scaffolding or simulated tests from being mistaken for
production acceptance.

Evidence levels used here:

- **L1 — source/configuration:** a contract, implementation, or deployment file exists.
- **L2 — simulated integration:** unit tests, an in-memory repository, Fastify `inject`, mock fetch, or local process integration passes.
- **L3 — deployed integration:** real Compose services, PostgreSQL/S3/Redis, and a real browser or Tauri process interoperate.
- **L4 — production-style acceptance:** signed/notarized packages, real machines, production-like identity, networking, storage, and upgrade paths pass.

L1 and L2 are engineering evidence, not substitutes for L3 or L4.

| Capability             | Repository proof expected                                        | Real-environment acceptance still required                                 |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| contracts and manifest | schema tests and generated JSON Schema                           | compatibility against independently built apps                             |
| internationalization   | locale/key parity tests, API negotiation and task snapshot tests | native UI/browser smoke in both locales and independently built micro-apps |
| email authentication   | BFF OTP policy, SMTP adapter and API tests                       | real SMTP delivery, Redis abuse testing and bounce/availability handling   |
| provider slots         | generic descriptors and OIDC adapter                             | Google, Feishu and WeChat connector credentials/consent                    |
| release/channel        | transactional repository tests                                   | PostgreSQL concurrency and S3 failure injection                            |
| Control Plane UI       | registered apps, release history and review queue API/UI tests   | browser E2E against a deployed API and independent remote                  |
| artifact validation    | worker tests with malicious fixtures                             | production KMS keys, scanner and large artifact load                       |
| Web Federation         | signed origin policy, bundle digest, real Chromium CSP graph     | production Nginx/CDN and two-remote no-shell-rebuild rollback              |
| sandbox iframe         | origin/source/capability tests                                   | distinct-origin browser security test with CSP/CDN                         |
| Agent/Runner           | signed intent lease, Runner recheck, clock/restart tests         | real disconnected schedule/run and OS-login persistence                    |
| desktop Web UI         | loopback boundary tests plus Windows Tauri/Agent process smoke   | custom app WebView, macOS process and process-crash smoke                  |
| desktop packages       | Tauri build/check                                                | signed Windows x64 and notarized macOS arm64 real-machine smoke            |
| Compose/Helm           | Compose PostgreSQL/Redis/MinIO with host API/Worker L3           | API/Worker images and external DNS/TLS/storage/IdP deployment              |
| permission grants      | signed bounded lease, intent binding and fail-closed replay      | real offline expiry/revocation, directory picker and OS prompts            |

No row is considered complete solely because its directory or API shape exists.

## Explicitly open acceptance gaps

- The checked-in catalogs, browser language-switch smoke, API negotiation
  tests, and Agent SQLite task snapshots are L1/L2 evidence. Complete L3/L4
  acceptance still requires English and Chinese smoke on packaged Windows x64
  and macOS arm64 applications, real localized email delivery, and independent
  Federation, iframe, Python, native, and desktop Web UI applets consuming the
  locale contract.

- The elevated helper has no L4 macOS Authorization Services acceptance. A Rust type or mock result does not prove a real authorization prompt, signed helper install, cancellation, or failure recovery.
- `user-selected` filesystem scope is only a Manifest/Broker contract until a real OS directory picker returns a durable, revocable grant and the Runner is proven unable to escape it.
- Offline authorization now has a signed, task-scoped and intent-bound lease,
  Runner re-authorization, a persisted clock high-water mark and restart
  fail-closed tests. A real API-to-Agent run that disconnects, executes before
  expiry and is rejected after expiry is still required for L3.
- Revoking a server grant stops lease renewal, so a disconnected device can
  continue only until its current lease expires. Immediate offline revocation
  is impossible without an independent online control channel; cleanup of
  installed files and already-running processes remains unaccepted.
- Federation executes successfully in real Chromium under the checked-in Vite
  CSP without `unsafe-eval`, including transitive chunks and CSS. The production
  Nginx/Ingress response, CDN byte immutability and two-remote channel rollback
  still require separate L3/L4 evidence.
- The Windows Tauri debug process gate proves a real WebView can launch one
  isolated Agent and that the Agent survives UI exit. It is not evidence for a
  signed installer, macOS, updater, Keychain/Credential Manager or OS-login
  startup.
