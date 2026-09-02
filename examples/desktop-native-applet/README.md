# Hello Rust native desktop applet

This self-contained Rust program demonstrates the native Runner contract. It
checks only the Host allowlisted task environment and emits `AW_EVENT` log,
progress, and result records. It never receives or prints a platform token or
the task lease.

## Windows x64 development build

Install the MSVC target and build from the repository root:

```powershell
rustup target add x86_64-pc-windows-msvc
cargo build --release --target x86_64-pc-windows-msvc `
  --manifest-path .\examples\desktop-native-applet\Cargo.toml
New-Item -ItemType Directory -Force .\examples\desktop-native-applet\release\windows-x64\bin | Out-Null
Copy-Item .\examples\desktop-native-applet\target\x86_64-pc-windows-msvc\release\aw-native-example.exe `
  .\examples\desktop-native-applet\release\windows-x64\bin\aw-native-example.exe
```

The generated `target/` and `release/` directories are ignored and must not be
committed.

## macOS arm64 development build

Build on an Apple-silicon macOS runner with the Apple SDK and signing tooling;
installing the Rust target on Windows alone does not provide a working Apple
linker or SDK.

```bash
rustup target add aarch64-apple-darwin
cargo build --release --target aarch64-apple-darwin \
  --manifest-path ./examples/desktop-native-applet/Cargo.toml
mkdir -p ./examples/desktop-native-applet/release/macos-arm64/bin
cp ./examples/desktop-native-applet/target/aarch64-apple-darwin/release/aw-native-example \
  ./examples/desktop-native-applet/release/macos-arm64/bin/aw-native-example
```

The Host selects only the runtime matching its OS and CPU.

## Publication boundary

Once both real target outputs have been collected by a release job, package and
publish them as one immutable Release:

```powershell
pnpm aw package --manifest .\examples\desktop-native-applet\applet.json `
  --artifact-map .\examples\desktop-native-applet\aw.package.json `
  --output .\.artifacts\desktop-native-applet --key-id publisher-2026 `
  --private-key C:\secure\publisher.pem
pnpm aw publish --application-id 00000000-0000-4000-8000-000000000001 `
  --package .\.artifacts\desktop-native-applet\package.json
```

`applet.json` is explicitly unsigned and contains no fabricated signature. The
package command derives real descriptors, per-artifact SBOMs and signatures,
then signs the complete Windows/macOS artifact set. Platform code signing and
macOS notarization remain additional release gates and are not claimed by this
source-level example.
