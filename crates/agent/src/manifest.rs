use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{AgentError, AgentResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct TargetPlatform {
    pub os: DesktopOs,
    pub arch: DesktopArch,
}

impl TargetPlatform {
    pub const WINDOWS_X64: Self = Self {
        os: DesktopOs::Windows,
        arch: DesktopArch::X64,
    };
    pub const MACOS_ARM64: Self = Self {
        os: DesktopOs::Macos,
        arch: DesktopArch::Arm64,
    };

    pub fn current() -> AgentResult<Self> {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => Ok(Self::WINDOWS_X64),
            ("macos", "aarch64") => Ok(Self::MACOS_ARM64),
            (os, arch) => Err(AgentError::UnsupportedTarget(format!("{os}-{arch}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopOs {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopArch {
    X64,
    Arm64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestArtifact {
    pub name: String,
    pub file_name: PathBuf,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<TargetPlatform>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Integrity {
    pub algorithm: Sha256Algorithm,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sha256Algorithm {
    Sha256,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherSignature {
    pub algorithm: Ed25519Algorithm,
    pub key_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ed25519Algorithm {
    Ed25519,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FileScope {
    Workspace,
    AppData,
    UserSelected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileAccess {
    Read,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClipboardAccess {
    Read,
    Write,
    ReadWrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Capability {
    Filesystem {
        access: FileAccess,
        scopes: Vec<FileScope>,
    },
    Network {
        domains: Vec<String>,
        methods: Vec<HttpMethod>,
    },
    Clipboard {
        access: ClipboardAccess,
    },
    Shortcut {
        accelerators: Vec<String>,
        global: bool,
    },
    Background {
        modes: Vec<BackgroundMode>,
    },
    Lifecycle {
        actions: Vec<LifecycleAction>,
        elevation: ElevationPolicy,
    },
    Subprocess {
        executables: Vec<PathBuf>,
    },
    Notifications,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundMode {
    Scheduled,
    Startup,
    Persistent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleAction {
    Install,
    Update,
    Uninstall,
    Service,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ElevationPolicy {
    Never,
    UserApproved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunMode {
    Singleton,
    Serial,
    Parallel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RuntimeKind {
    Python {
        python: String,
    },
    Native,
    WebUi {
        #[serde(default)]
        allowed_origins: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
// serde flatten cannot be combined with deny_unknown_fields. RuntimeKind itself
// is tagged/strict, while the external signed manifest is parsed by the shared schema.
#[serde(rename_all = "camelCase")]
pub struct RuntimeSpec {
    pub platform: TargetPlatform,
    pub artifact: String,
    pub entry: PathBuf,
    #[serde(flatten)]
    pub runtime: RuntimeKind,
}

impl RuntimeSpec {
    pub fn entry(&self) -> &Path {
        &self.entry
    }
}
impl RuntimeKind {
    pub fn entry<'a>(&self, runtime: &'a RuntimeSpec) -> &'a Path {
        &runtime.entry
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DesktopDependency {
    Python {
        version: String,
        lock_artifact: String,
    },
    System {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    Application {
        app_id: String,
        version: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManifestKind {
    Desktop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppletManifest {
    pub schema_version: u32,
    pub app_id: String,
    pub version: Version,
    pub artifacts: Vec<ManifestArtifact>,
    pub integrity: Integrity,
    pub signature: PublisherSignature,
    pub kind: ManifestKind,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub runtimes: Vec<RuntimeSpec>,
    #[serde(default)]
    pub dependencies: Vec<DesktopDependency>,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    pub run_mode: RunMode,
    pub min_host_version: Version,
}

impl AppletManifest {
    pub fn validate(&self) -> AgentResult<()> {
        if self.schema_version != 1 {
            return invalid(format!("unsupported schemaVersion {}", self.schema_version));
        }
        if !is_slug(&self.app_id) {
            return invalid("appId must be a lowercase slug".into());
        }
        if self.name.trim().len() < 2 || self.name.len() > 80 {
            return invalid("name must contain 2-80 characters".into());
        }
        if !is_sha256(&self.integrity.digest) {
            return invalid("integrity.digest must be lowercase SHA-256".into());
        }
        if self.signature.key_id.is_empty() || self.signature.value.len() < 40 {
            return invalid("publisher signature is incomplete".into());
        }
        if self.runtimes.is_empty() {
            return invalid("at least one runtime is required".into());
        }

        let mut artifact_names = HashSet::new();
        for artifact in &self.artifacts {
            if !artifact_names.insert(artifact.name.as_str()) {
                return invalid(format!("duplicate artifact {}", artifact.name));
            }
            validate_artifact_name(&artifact.name)?;
            validate_relative_path(&artifact.file_name)?;
            if artifact.size == 0 || artifact.size > 2 * 1024 * 1024 * 1024 {
                return invalid(format!("invalid artifact size for {}", artifact.name));
            }
            if !is_sha256(&artifact.sha256) {
                return invalid(format!("invalid SHA-256 for artifact {}", artifact.name));
            }
        }

        let mut targets = HashSet::new();
        for runtime in &self.runtimes {
            if !targets.insert(runtime.platform) {
                return invalid(format!("duplicate runtime for {:?}", runtime.platform));
            }
            if !artifact_names.contains(runtime.artifact.as_str()) {
                return invalid(format!(
                    "runtime references unknown artifact {}",
                    runtime.artifact
                ));
            }
            let artifact = self
                .artifacts
                .iter()
                .find(|artifact| artifact.name == runtime.artifact)
                .expect("artifact existence checked");
            if artifact
                .platform
                .is_some_and(|platform| platform != runtime.platform)
            {
                return invalid(format!(
                    "runtime and artifact platform mismatch for {}",
                    runtime.artifact
                ));
            }
            validate_relative_path(&runtime.entry)?;
            if let RuntimeKind::Python { python } = &runtime.runtime {
                if python.is_empty() || python.len() > 40 {
                    return invalid("python runtime version is invalid".into());
                }
            }
        }
        for dependency in &self.dependencies {
            if let DesktopDependency::Python { lock_artifact, .. } = dependency {
                if !artifact_names.contains(lock_artifact.as_str()) {
                    return invalid(format!(
                        "python lock references unknown artifact {lock_artifact}"
                    ));
                }
            }
        }
        for capability in &self.capabilities {
            validate_capability(capability)?;
        }
        Ok(())
    }

    pub fn runtime_for(&self, target: TargetPlatform) -> AgentResult<&RuntimeSpec> {
        self.validate()?;
        self.runtimes
            .iter()
            .find(|runtime| runtime.platform == target)
            .ok_or_else(|| AgentError::UnsupportedTarget(format!("{:?}", target)))
    }

    pub fn verify_artifact_set_integrity(&self) -> AgentResult<()> {
        self.validate()?;
        let observed = self.artifact_set_integrity_digest()?;
        if observed != self.integrity.digest {
            return Err(AgentError::DigestMismatch);
        }
        Ok(())
    }

    pub fn artifact_set_integrity_digest(&self) -> AgentResult<String> {
        self.validate()?;
        let mut artifacts = self.artifacts.clone();
        artifacts.sort_by(|left, right| left.name.cmp(&right.name));
        let canonical = canonical_json(&serde_json::to_value(artifacts)?)?;
        Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
    }

    pub fn signature_payload(&self) -> AgentResult<Vec<u8>> {
        self.validate()?;
        let mut value = serde_json::to_value(self)?;
        let signature = value
            .get_mut("signature")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| AgentError::InvalidManifest("signature object is missing".into()))?;
        signature.remove("value");
        Ok(canonical_json(&value)?.into_bytes())
    }
}

fn canonical_json(value: &Value) -> AgentResult<String> {
    let mut output = String::new();
    write_canonical_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json(value: &Value, output: &mut String) -> AgentResult<()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&value.to_string()),
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                write_canonical_json(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

impl Capability {
    pub fn grants_workspace_read(&self) -> bool {
        matches!(self, Self::Filesystem { scopes, .. } if scopes.contains(&FileScope::Workspace))
    }
    pub fn grants_workspace_write(&self) -> bool {
        matches!(self, Self::Filesystem { access: FileAccess::ReadWrite, scopes } if scopes.contains(&FileScope::Workspace))
    }
}

pub fn resolve_contained(root: &Path, relative: &Path) -> AgentResult<PathBuf> {
    validate_relative_path(relative)?;
    let canonical_root = root.canonicalize()?;
    let canonical_candidate = root.join(relative).canonicalize()?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(AgentError::PathEscape(relative.display().to_string()));
    }
    Ok(canonical_candidate)
}

fn validate_capability(capability: &Capability) -> AgentResult<()> {
    match capability {
        Capability::Filesystem { scopes, .. } if scopes.is_empty() => {
            invalid("filesystem capability needs a scope".into())
        }
        Capability::Network { domains, methods } if domains.is_empty() || methods.is_empty() => {
            invalid("network capability needs domains and methods".into())
        }
        Capability::Shortcut { accelerators, .. } if accelerators.is_empty() => {
            invalid("shortcut capability needs accelerators".into())
        }
        Capability::Background { modes } if modes.is_empty() => {
            invalid("background capability needs modes".into())
        }
        Capability::Lifecycle { actions, .. } if actions.is_empty() => {
            invalid("lifecycle capability needs actions".into())
        }
        Capability::Subprocess { executables } if executables.is_empty() => {
            invalid("subprocess capability needs executable paths".into())
        }
        Capability::Subprocess { executables } => {
            for executable in executables {
                validate_relative_path(executable)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_relative_path(path: &Path) -> AgentResult<()> {
    if path.as_os_str().is_empty() || path.is_absolute() || path.to_string_lossy().contains('\\') {
        return Err(AgentError::PathEscape(path.display().to_string()));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(AgentError::PathEscape(path.display().to_string()));
    }
    Ok(())
}

fn validate_artifact_name(value: &str) -> AgentResult<()> {
    if value.is_empty()
        || value.len() > 120
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
    {
        return invalid(format!("invalid artifact name {value}"));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn invalid<T>(message: String) -> AgentResult<T> {
    Err(AgentError::InvalidManifest(message))
}

fn is_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 3 || bytes.len() > 64 || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut previous_dash = false;
    for byte in bytes {
        if !(byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
            || (*byte == b'-' && previous_dash)
        {
            return false;
        }
        previous_dash = *byte == b'-';
    }
    !previous_dash
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn manifest() -> AppletManifest {
        AppletManifest {
            schema_version: 1,
            app_id: "sample-app".into(),
            version: Version::new(1, 0, 0),
            artifacts: vec![ManifestArtifact {
                name: "windows-runtime".into(),
                file_name: "payload.zip".into(),
                media_type: "application/zip".into(),
                size: 4,
                sha256: "a".repeat(64),
                platform: Some(TargetPlatform::WINDOWS_X64),
            }],
            integrity: Integrity {
                algorithm: Sha256Algorithm::Sha256,
                digest: "b".repeat(64),
            },
            signature: PublisherSignature {
                algorithm: Ed25519Algorithm::Ed25519,
                key_id: "test-key".into(),
                value: "x".repeat(64),
            },
            kind: ManifestKind::Desktop,
            name: "Sample".into(),
            description: String::new(),
            runtimes: vec![RuntimeSpec {
                platform: TargetPlatform::WINDOWS_X64,
                artifact: "windows-runtime".into(),
                entry: "main.py".into(),
                runtime: RuntimeKind::Python {
                    python: "3.12".into(),
                },
            }],
            dependencies: vec![],
            capabilities: vec![],
            run_mode: RunMode::Parallel,
            min_host_version: Version::new(0, 1, 0),
        }
    }

    #[test]
    fn rejects_runtime_artifact_mismatch_and_entry_traversal() {
        let mut value = manifest();
        value.runtimes[0].artifact = "missing".into();
        assert!(value.validate().is_err());
        value.runtimes[0].artifact = "windows-runtime".into();
        value.runtimes[0].entry = "../escape.exe".into();
        assert!(matches!(value.validate(), Err(AgentError::PathEscape(_))));
    }

    #[test]
    fn matches_only_explicit_os_and_arch() {
        let value = manifest();
        assert!(value.runtime_for(TargetPlatform::WINDOWS_X64).is_ok());
        assert!(value.runtime_for(TargetPlatform::MACOS_ARM64).is_err());
    }

    #[test]
    fn http_method_json_remains_uppercase() {
        assert_eq!(serde_json::to_string(&HttpMethod::Get).unwrap(), "\"GET\"");
        assert_eq!(
            serde_json::from_str::<HttpMethod>("\"POST\"").unwrap(),
            HttpMethod::Post
        );
    }

    #[test]
    fn signature_payload_excludes_only_the_signature_value() {
        let value = manifest();
        let payload = String::from_utf8(value.signature_payload().unwrap()).unwrap();
        assert!(!payload.contains(&value.signature.value));
        assert!(payload.contains(&value.signature.key_id));
        assert!(payload.contains(&value.integrity.digest));
        assert_eq!(
            payload,
            r#"{"appId":"sample-app","artifacts":[{"fileName":"payload.zip","mediaType":"application/zip","name":"windows-runtime","platform":{"arch":"x64","os":"windows"},"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":4}],"capabilities":[],"dependencies":[],"description":"","integrity":{"algorithm":"sha256","digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"kind":"desktop","minHostVersion":"0.1.0","name":"Sample","runMode":"parallel","runtimes":[{"artifact":"windows-runtime","entry":"main.py","kind":"python","platform":{"arch":"x64","os":"windows"},"python":"3.12"}],"schemaVersion":1,"signature":{"algorithm":"ed25519","keyId":"test-key"},"version":"1.0.0"}"#
        );
    }
}
