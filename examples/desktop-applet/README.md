# Hello Python desktop applet

This is a package-ready Python 3.12 example for Windows x64 and macOS arm64. It
does not receive a platform access token: the Runner injects only a task-scoped
lease and local RPC coordinates. Both platform artifacts intentionally use the
same portable `runtime/` source directory.

`applet.json` is a development manifest. Validate it together with the native
and web-UI fixtures from the repository root:

```powershell
pnpm --filter @awesome-workflow/manifest-schema exec tsx ../../examples/validate-desktop-manifests.ts
```

## Package and publish

From the repository root, package both declared artifacts with a real publisher
key held outside the repository:

```powershell
pnpm aw package --manifest .\examples\desktop-applet\applet.json `
  --artifact-map .\examples\desktop-applet\aw.package.json `
  --output .\.artifacts\desktop-applet --key-id publisher-2026 `
  --private-key C:\secure\publisher.pem
```

The command replaces all template descriptors from the deterministic archive
bytes, emits per-artifact SBOMs and signatures, and signs the complete manifest.
After registering a matching application and configuring the corresponding
public key as trusted, publish the generated metadata:

```powershell
pnpm aw publish --application-id 00000000-0000-4000-8000-000000000001 `
  --package .\.artifacts\desktop-applet\package.json
```

The checked-in Manifest remains an unsigned source template; only the generated
`release.manifest.json` is a signed release document. Publication proves the
control-plane upload flow, while execution still requires a Host-managed Python
3.12 runtime on the target device.
