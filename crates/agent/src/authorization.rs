use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    scheduler::{is_application_slug, is_contract_semver},
    AgentError, AgentResult, Capability,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_AUTHORIZATION_LEASE_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
pub(crate) const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;
const SIGNATURE_DOMAIN: &str = "awesome-workflow:authorization-lease:v1\n";
const INTENT_DOMAIN: &str = "awesome-workflow:authorization-intent:v1\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorizationTaskKind {
    Schedule,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationLeaseTask {
    pub kind: AuthorizationTaskKind,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationLeaseClaims {
    pub schema_version: u16,
    pub lease_id: String,
    pub revision: u64,
    pub device_id: String,
    pub application_id: String,
    pub release_id: String,
    pub app_id: String,
    pub version: String,
    pub task: AuthorizationLeaseTask,
    pub capability_hash: String,
    pub intent_hash: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationLeaseSignature {
    pub algorithm: String,
    pub key_id: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationLease {
    pub claims: AuthorizationLeaseClaims,
    pub signature: AuthorizationLeaseSignature,
}

impl AuthorizationLease {
    pub fn validate(&self) -> AgentResult<()> {
        let claims = &self.claims;
        if claims.schema_version != 1
            || claims.revision == 0
            || claims.revision > MAX_SAFE_INTEGER
            || Uuid::parse_str(&claims.lease_id).is_err()
            || Uuid::parse_str(&claims.device_id).is_err()
            || Uuid::parse_str(&claims.application_id).is_err()
            || Uuid::parse_str(&claims.release_id).is_err()
            || Uuid::parse_str(&claims.task.id).is_err()
            || !is_application_slug(&claims.app_id)
            || !is_contract_semver(&claims.version)
            || !is_sha256(&claims.capability_hash)
            || !is_sha256(&claims.intent_hash)
            || claims.expires_at <= claims.issued_at
            || claims.expires_at - claims.issued_at > MAX_AUTHORIZATION_LEASE_TTL_MS
            || self.signature.algorithm != "ed25519"
            || self.signature.key_id.is_empty()
            || self.signature.key_id.len() > 160
        {
            return Err(AgentError::AccessDenied(
                "authorization lease contract is invalid".into(),
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // A positional omission here must not silently weaken lease scope checks.
    pub fn validate_scope(
        &self,
        expected_device_id: &str,
        expected_app_id: &str,
        expected_version: &str,
        expected_task_kind: AuthorizationTaskKind,
        expected_task_id: &str,
        expected_revision: u64,
        expected_capability_hash: &str,
        now_ms: u64,
    ) -> AgentResult<()> {
        self.validate()?;
        let claims = &self.claims;
        if claims.issued_at > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
            return denied("authorization lease was issued too far in the future");
        }
        if claims.expires_at <= now_ms {
            return denied("authorization lease has expired");
        }
        if claims.device_id != expected_device_id
            || claims.app_id != expected_app_id
            || claims.version != expected_version
            || claims.task.kind != expected_task_kind
            || claims.task.id != expected_task_id
            || claims.revision != expected_revision
            || claims.capability_hash != expected_capability_hash
        {
            return denied("authorization lease scope mismatch");
        }
        Ok(())
    }

    pub(crate) fn signature_payload(&self) -> AgentResult<Vec<u8>> {
        self.validate()?;
        let value = serde_json::to_value(&self.claims)?;
        let canonical = canonical_json(&value)?;
        Ok(format!("{SIGNATURE_DOMAIN}{canonical}").into_bytes())
    }
}

pub trait AuthorizationLeaseVerifier: Send + Sync {
    fn verify(&self, lease: &AuthorizationLease) -> AgentResult<()>;
}

pub struct RejectAuthorizationLeases;

impl AuthorizationLeaseVerifier for RejectAuthorizationLeases {
    fn verify(&self, _lease: &AuthorizationLease) -> AgentResult<()> {
        denied("no trusted authorization lease key is configured")
    }
}

pub struct Ed25519AuthorizationLeaseVerifier {
    pub key_id: String,
    pub key: VerifyingKey,
}

impl AuthorizationLeaseVerifier for Ed25519AuthorizationLeaseVerifier {
    fn verify(&self, lease: &AuthorizationLease) -> AgentResult<()> {
        lease.validate()?;
        if lease.signature.key_id != self.key_id {
            return denied("authorization lease uses an unknown signing key");
        }
        let bytes = STANDARD.decode(&lease.signature.value).map_err(|_| {
            AgentError::AccessDenied("authorization lease signature is invalid".into())
        })?;
        let signature = Signature::from_slice(&bytes).map_err(|_| {
            AgentError::AccessDenied("authorization lease signature is invalid".into())
        })?;
        self.key
            .verify(&lease.signature_payload()?, &signature)
            .map_err(|_| {
                AgentError::AccessDenied("authorization lease signature verification failed".into())
            })
    }
}

pub fn desktop_capability_hash(capabilities: &[Capability]) -> AgentResult<String> {
    let mut value = serde_json::to_value(capabilities)?;
    if let Value::Array(entries) = &mut value {
        for entry in entries {
            if entry.get("kind").and_then(Value::as_str) == Some("network") {
                if let Some(domains) = entry.get_mut("domains").and_then(Value::as_array_mut) {
                    for domain in domains {
                        if let Some(value) = domain.as_str() {
                            *domain = Value::String(value.to_lowercase());
                        }
                    }
                }
            }
        }
    }
    normalize_set_arrays(&mut value)?;
    let canonical = canonical_json(&value)?;
    Ok(hex::encode(Sha256::digest(
        format!("awesome-workflow:desktop-capabilities:v1\n{canonical}").as_bytes(),
    )))
}

pub(crate) fn authorization_intent_hash<T: Serialize>(intent: &T) -> AgentResult<String> {
    let value = serde_json::to_value(intent)?;
    let canonical = canonical_json(&value)?;
    Ok(hex::encode(Sha256::digest(
        format!("{INTENT_DOMAIN}{canonical}").as_bytes(),
    )))
}

fn normalize_set_arrays(value: &mut Value) -> AgentResult<()> {
    match value {
        Value::Array(entries) => {
            for entry in entries.iter_mut() {
                normalize_set_arrays(entry)?;
            }
            let mut keyed = entries
                .drain(..)
                .map(|entry| Ok((canonical_json(&entry)?, entry)))
                .collect::<AgentResult<Vec<_>>>()?;
            keyed.sort_by(|left, right| left.0.cmp(&right.0));
            keyed.dedup_by(|left, right| left.0 == right.0);
            entries.extend(keyed.into_iter().map(|(_, entry)| entry));
        }
        Value::Object(entries) => {
            for entry in entries.values_mut() {
                normalize_set_arrays(entry)?;
            }
        }
        _ => {}
    }
    Ok(())
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

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn denied<T>(message: &str) -> AgentResult<T> {
    Err(AgentError::AccessDenied(message.into()))
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    fn claims() -> AuthorizationLeaseClaims {
        AuthorizationLeaseClaims {
            schema_version: 1,
            lease_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            revision: 9,
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            application_id: "22222222-2222-4222-8222-222222222222".into(),
            release_id: "33333333-3333-4333-8333-333333333333".into(),
            app_id: "lease-test-app".into(),
            version: "1.2.3".into(),
            task: AuthorizationLeaseTask {
                kind: AuthorizationTaskKind::Schedule,
                id: "44444444-4444-4444-8444-444444444444".into(),
            },
            capability_hash: "a".repeat(64),
            intent_hash: "b".repeat(64),
            issued_at: 1_800_000_000_000,
            expires_at: 1_800_000_300_000,
        }
    }

    fn signed_lease() -> (AuthorizationLease, Ed25519AuthorizationLeaseVerifier) {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut lease = AuthorizationLease {
            claims: claims(),
            signature: AuthorizationLeaseSignature {
                algorithm: "ed25519".into(),
                key_id: "lease-test-key".into(),
                value: String::new(),
            },
        };
        lease.signature.value = STANDARD.encode(
            signing_key
                .sign(&lease.signature_payload().unwrap())
                .to_bytes(),
        );
        let verifier = Ed25519AuthorizationLeaseVerifier {
            key_id: "lease-test-key".into(),
            key: signing_key.verifying_key(),
        };
        (lease, verifier)
    }

    #[test]
    fn verifies_signature_and_rejects_expiry_scope_and_excessive_ttl() {
        let (mut lease, verifier) = signed_lease();
        verifier.verify(&lease).unwrap();
        lease
            .validate_scope(
                &lease.claims.device_id,
                &lease.claims.app_id,
                &lease.claims.version,
                AuthorizationTaskKind::Schedule,
                &lease.claims.task.id,
                lease.claims.revision,
                &lease.claims.capability_hash,
                lease.claims.issued_at + 1,
            )
            .unwrap();
        assert!(lease
            .validate_scope(
                &lease.claims.device_id,
                &lease.claims.app_id,
                &lease.claims.version,
                AuthorizationTaskKind::Run,
                &lease.claims.task.id,
                lease.claims.revision,
                &lease.claims.capability_hash,
                lease.claims.issued_at + 1,
            )
            .is_err());
        assert!(lease
            .validate_scope(
                &lease.claims.device_id,
                &lease.claims.app_id,
                &lease.claims.version,
                AuthorizationTaskKind::Schedule,
                &lease.claims.task.id,
                lease.claims.revision,
                &lease.claims.capability_hash,
                lease.claims.expires_at,
            )
            .is_err());
        lease.claims.expires_at = lease.claims.issued_at + MAX_AUTHORIZATION_LEASE_TTL_MS + 1;
        assert!(lease.validate().is_err());
    }

    #[test]
    fn rejects_tampering_wrong_device_wrong_task_and_expired_authorization() {
        let (lease, verifier) = signed_lease();
        let mut tampered = lease.clone();
        tampered.claims.app_id = "tampered-app".into();
        assert!(verifier.verify(&tampered).is_err());

        assert!(lease
            .validate_scope(
                "99999999-9999-4999-8999-999999999999",
                &lease.claims.app_id,
                &lease.claims.version,
                AuthorizationTaskKind::Schedule,
                &lease.claims.task.id,
                lease.claims.revision,
                &lease.claims.capability_hash,
                lease.claims.issued_at + 1,
            )
            .is_err());
        assert!(lease
            .validate_scope(
                &lease.claims.device_id,
                &lease.claims.app_id,
                &lease.claims.version,
                AuthorizationTaskKind::Schedule,
                "55555555-5555-4555-8555-555555555555",
                lease.claims.revision,
                &lease.claims.capability_hash,
                lease.claims.issued_at + 1,
            )
            .is_err());
        assert!(lease
            .validate_scope(
                &lease.claims.device_id,
                &lease.claims.app_id,
                &lease.claims.version,
                AuthorizationTaskKind::Schedule,
                &lease.claims.task.id,
                lease.claims.revision,
                &lease.claims.capability_hash,
                lease.claims.expires_at,
            )
            .is_err());
    }

    #[test]
    fn verifies_typescript_canonical_signature_golden() {
        let public_key: [u8; 32] = STANDARD
            .decode("6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=")
            .unwrap()
            .try_into()
            .unwrap();
        let lease = AuthorizationLease {
            claims: claims(),
            signature: AuthorizationLeaseSignature {
                algorithm: "ed25519".into(),
                key_id: "lease-test-key".into(),
                value: "ZRy4YJ+/o2GrZtH5hysqXWcWSHesrO/7ZJzdS8ykAt4LFR92dKQ7JKUILg1dvmoxKocI+E3AYlF/r534MIrSCg==".into(),
            },
        };
        Ed25519AuthorizationLeaseVerifier {
            key_id: "lease-test-key".into(),
            key: VerifyingKey::from_bytes(&public_key).unwrap(),
        }
        .verify(&lease)
        .unwrap();
    }

    #[test]
    fn matches_typescript_schedule_intent_hash_golden_and_binds_every_execution_field() {
        let intent = serde_json::json!({
            "scheduleId": "44444444-4444-4444-8444-444444444444",
            "revision": 9,
            "applicationId": "22222222-2222-4222-8222-222222222222",
            "releaseId": "33333333-3333-4333-8333-333333333333",
            "appId": "lease-test-app",
            "version": "1.2.3",
            "cronExpression": "0 * * * *",
            "timezone": "UTC",
            "nextRunAtMs": 1_800_000_600_000_u64,
            "args": ["--safe"],
            "enabled": true,
        });
        let expected = "971833f03b907777e4816cac5f224f6a3a5ad568464203bdcdecc4a17d45f482";
        assert_eq!(authorization_intent_hash(&intent).unwrap(), expected);

        for field in [
            "cronExpression",
            "timezone",
            "nextRunAtMs",
            "args",
            "enabled",
        ] {
            let mut tampered = intent.clone();
            tampered[field] = match field {
                "nextRunAtMs" => serde_json::json!(1_800_000_600_001_u64),
                "args" => serde_json::json!(["--unsafe"]),
                "enabled" => serde_json::json!(false),
                _ => serde_json::json!("tampered"),
            };
            assert_ne!(authorization_intent_hash(&tampered).unwrap(), expected);
        }
    }
}
