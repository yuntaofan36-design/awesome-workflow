# Desktop micro-application examples

These examples are deliberately small, package-ready sources for the three
desktop runtime declarations supported by the current manifest schema.

| Example                                            | Runtime       | Development scope                               |
| -------------------------------------------------- | ------------- | ----------------------------------------------- |
| [`desktop-applet`](./desktop-applet)               | Python 3.12   | Windows x64 + macOS arm64 packages              |
| [`desktop-native-applet`](./desktop-native-applet) | Rust native   | Windows x64 + macOS arm64 build outputs         |
| [`desktop-web-ui-applet`](./desktop-web-ui-applet) | Static web UI | One portable artifact for both target platforms |

Each checked-in `applet.json` is an explicitly unsigned source template. Zero
digests and one-byte sizes are replaced from immutable package bytes, while the
`UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_...` sentinel is replaced by a real
Ed25519 signature. No example contains a fabricated release signature.

Validate all three manifests without building or changing any files:

```powershell
pnpm --filter @awesome-workflow/manifest-schema exec tsx ../../examples/validate-desktop-manifests.ts
```

Each `aw.package.json` maps a declared artifact name to its package input. The
CLI requires complete coverage, packages every input deterministically, emits
an individual CycloneDX/SPDX SBOM and Ed25519 artifact signature, computes the
complete artifact-set integrity digest, and signs the manifest once.

After placing a real publisher private key outside the repository, Python and
Web UI examples can be packaged directly from the repository root:

```powershell
pnpm aw package --manifest .\examples\desktop-applet\applet.json `
  --artifact-map .\examples\desktop-applet\aw.package.json `
  --output .\.artifacts\desktop-applet --key-id publisher-2026 `
  --private-key C:\secure\publisher.pem

pnpm aw package --manifest .\examples\desktop-web-ui-applet\applet.json `
  --artifact-map .\examples\desktop-web-ui-applet\aw.package.json `
  --output .\.artifacts\desktop-web-ui-applet --key-id publisher-2026 `
  --private-key C:\secure\publisher.pem
```

The native example first needs actual target binaries from Windows and macOS
builders; its README defines the staging paths. Once both outputs are present,
the same `--artifact-map` command produces one signed multi-platform Release
package. `aw publish` then creates one Release, uploads and finalizes every
artifact/SBOM pair, and submits only after the complete set is present.
