use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use crate::{manifest::PublisherSignature, AgentError, AgentResult};

const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactAttestation {
    pub sha256: String,
    pub signature: String,
    pub key_id: String,
}

pub trait SignatureVerifier: Send + Sync {
    fn verify_artifact_digest(
        &self,
        digest: &[u8; 32],
        attestation: &ArtifactAttestation,
    ) -> AgentResult<()>;
    fn verify_manifest(&self, payload: &[u8], signature: &PublisherSignature) -> AgentResult<()>;
}

pub struct RejectUnsignedVerifier;

impl SignatureVerifier for RejectUnsignedVerifier {
    fn verify_artifact_digest(
        &self,
        _digest: &[u8; 32],
        _attestation: &ArtifactAttestation,
    ) -> AgentResult<()> {
        Err(AgentError::SignatureRejected(
            "no trusted signing key is configured".into(),
        ))
    }

    fn verify_manifest(&self, _payload: &[u8], _signature: &PublisherSignature) -> AgentResult<()> {
        Err(AgentError::SignatureRejected(
            "no trusted signing key is configured".into(),
        ))
    }
}

pub struct Ed25519Verifier {
    pub key_id: String,
    pub key: VerifyingKey,
}

impl SignatureVerifier for Ed25519Verifier {
    fn verify_artifact_digest(
        &self,
        digest: &[u8; 32],
        attestation: &ArtifactAttestation,
    ) -> AgentResult<()> {
        if attestation.key_id != self.key_id {
            return Err(AgentError::SignatureRejected("unknown signing key".into()));
        }
        let signature_bytes = STANDARD
            .decode(&attestation.signature)
            .map_err(|_| AgentError::SignatureRejected("signature is not base64".into()))?;
        let signature = Signature::from_slice(&signature_bytes).map_err(|_| {
            AgentError::SignatureRejected("invalid Ed25519 signature length".into())
        })?;
        self.key
            .verify(digest, &signature)
            .map_err(|_| AgentError::SignatureRejected("Ed25519 verification failed".into()))
    }

    fn verify_manifest(&self, payload: &[u8], signature: &PublisherSignature) -> AgentResult<()> {
        if signature.key_id != self.key_id {
            return Err(AgentError::SignatureRejected(
                "unknown manifest signing key".into(),
            ));
        }
        let signature = decode_signature(&signature.value)?;
        self.key.verify(payload, &signature).map_err(|_| {
            AgentError::SignatureRejected("manifest Ed25519 verification failed".into())
        })
    }
}

fn decode_signature(value: &str) -> AgentResult<Signature> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| AgentError::SignatureRejected("signature is not base64".into()))?;
    Signature::from_slice(&bytes)
        .map_err(|_| AgentError::SignatureRejected("invalid Ed25519 signature length".into()))
}

pub fn verify_artifact(
    package_path: &Path,
    attestation: &ArtifactAttestation,
    verifier: &dyn SignatureVerifier,
) -> AgentResult<[u8; 32]> {
    let digest = sha256_file(package_path)?;
    let expected = hex::decode(&attestation.sha256).map_err(|_| AgentError::DigestMismatch)?;
    if expected.as_slice() != digest {
        return Err(AgentError::DigestMismatch);
    }
    verifier.verify_artifact_digest(&digest, attestation)?;
    Ok(digest)
}

pub fn sha256_file(path: &Path) -> AgentResult<[u8; 32]> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().into())
}

pub fn extract_to_staging(package_path: &Path, staging_root: &Path) -> AgentResult<PathBuf> {
    fs::create_dir_all(staging_root)?;
    let staging = staging_root.join(Uuid::new_v4().to_string());
    fs::create_dir(&staging)?;
    let result = extract_checked(package_path, &staging);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|_| staging)
}

fn extract_checked(package_path: &Path, destination: &Path) -> AgentResult<()> {
    let file = File::open(package_path)?;
    let mut archive = ZipArchive::new(file)?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(AgentError::UnsafeArchive("too many archive entries".into()));
    }

    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| AgentError::UnsafeArchive("archive size overflow".into()))?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err(AgentError::UnsafeArchive(
                "uncompressed size limit exceeded".into(),
            ));
        }
        validate_portable_archive_path(entry.name())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AgentError::UnsafeArchive(format!("unsafe path: {}", entry.name())))?
            .to_owned();
        if is_symlink(entry.unix_mode()) {
            return Err(AgentError::UnsafeArchive(format!(
                "symbolic link: {}",
                entry.name()
            )));
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output_file = File::options().write(true).create_new(true).open(&output)?;
        std::io::copy(&mut entry, &mut output_file)?;
        output_file.flush()?;
    }
    Ok(())
}

fn is_symlink(mode: Option<u32>) -> bool {
    mode.is_some_and(|value| value & 0o170000 == 0o120000)
}

fn validate_portable_archive_path(name: &str) -> AgentResult<()> {
    if name.contains('\\') {
        return Err(AgentError::UnsafeArchive("backslash path separator".into()));
    }
    for component in name.split('/').filter(|component| !component.is_empty()) {
        if component == "." || component == ".." || component.contains(':') {
            return Err(AgentError::UnsafeArchive(format!(
                "unsafe Windows path component: {component}"
            )));
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return Err(AgentError::UnsafeArchive(format!(
                "trailing dot or space: {component}"
            )));
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            || stem
                .strip_prefix("COM")
                .is_some_and(is_reserved_device_number)
            || stem
                .strip_prefix("LPT")
                .is_some_and(is_reserved_device_number);
        if reserved {
            return Err(AgentError::UnsafeArchive(format!(
                "reserved Windows device name: {component}"
            )));
        }
    }
    Ok(())
}

fn is_reserved_device_number(value: &str) -> bool {
    matches!(value, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use ed25519_dalek::{Signer, SigningKey};
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, ZipWriter};

    use super::*;

    struct AcceptVerifier;
    impl SignatureVerifier for AcceptVerifier {
        fn verify_artifact_digest(
            &self,
            _digest: &[u8; 32],
            _attestation: &ArtifactAttestation,
        ) -> AgentResult<()> {
            Ok(())
        }

        fn verify_manifest(
            &self,
            _payload: &[u8],
            _signature: &PublisherSignature,
        ) -> AgentResult<()> {
            Ok(())
        }
    }

    #[test]
    fn ed25519_verifier_checks_artifact_digest_and_manifest_payload_separately() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let verifier = Ed25519Verifier {
            key_id: "publisher-test".into(),
            key: signing_key.verifying_key(),
        };
        let digest = [3_u8; 32];
        let artifact_attestation = ArtifactAttestation {
            sha256: hex::encode(digest),
            signature: STANDARD.encode(signing_key.sign(&digest).to_bytes()),
            key_id: "publisher-test".into(),
        };
        verifier
            .verify_artifact_digest(&digest, &artifact_attestation)
            .unwrap();

        let payload = b"canonical signed manifest";
        let manifest_signature = PublisherSignature {
            algorithm: crate::manifest::Ed25519Algorithm::Ed25519,
            key_id: "publisher-test".into(),
            value: STANDARD.encode(signing_key.sign(payload).to_bytes()),
        };
        verifier
            .verify_manifest(payload, &manifest_signature)
            .unwrap();
        assert!(verifier
            .verify_manifest(b"modified manifest", &manifest_signature)
            .is_err());
    }

    #[test]
    fn rejects_sha_mismatch_before_signature() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("app.awpkg");
        fs::write(&package, b"package").unwrap();
        let attestation = ArtifactAttestation {
            sha256: "00".repeat(32),
            signature: "ignored".into(),
            key_id: "test".into(),
        };
        assert!(matches!(
            verify_artifact(&package, &attestation, &AcceptVerifier),
            Err(AgentError::DigestMismatch)
        ));
    }

    #[test]
    fn rejects_zip_slip_entry() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("evil.awpkg");
        let file = File::create(&package).unwrap();
        let mut zip = ZipWriter::new(file);
        zip.start_file("../escape.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"escape").unwrap();
        zip.finish().unwrap();

        let result = extract_to_staging(&package, &directory.path().join("staging"));
        assert!(matches!(result, Err(AgentError::UnsafeArchive(_))));
        assert!(!directory.path().join("escape.txt").exists());
    }

    #[test]
    fn rejects_windows_ads_and_device_names() {
        for unsafe_name in ["payload.exe:stream", "CON.txt", "folder/COM1.dll", "name. "] {
            let directory = tempdir().unwrap();
            let package = directory.path().join("evil.awpkg");
            let file = File::create(&package).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file(unsafe_name, SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"unsafe").unwrap();
            zip.finish().unwrap();
            assert!(
                matches!(
                    extract_to_staging(&package, &directory.path().join("staging")),
                    Err(AgentError::UnsafeArchive(_))
                ),
                "accepted unsafe entry {unsafe_name}"
            );
        }
    }
}
