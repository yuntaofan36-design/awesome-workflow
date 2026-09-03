use std::{sync::Arc, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    db::{Database, LeaseRecord},
    now_unix, AgentError, AgentResult, AuthorizationLease, Capability, RpcEnvelope,
    RPC_PROTOCOL_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedLease {
    pub value: String,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct LeaseAuthority {
    database: Arc<Database>,
}

impl LeaseAuthority {
    pub(crate) fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub fn issue(
        &self,
        app_id: &str,
        task_id: &str,
        capabilities: &[Capability],
        ttl: Duration,
    ) -> AgentResult<IssuedLease> {
        self.issue_bound(app_id, task_id, capabilities, ttl, None)
    }

    pub(crate) fn issue_authorized(
        &self,
        app_id: &str,
        task_id: &str,
        capabilities: &[Capability],
        ttl: Duration,
        authorization_lease: &AuthorizationLease,
    ) -> AgentResult<IssuedLease> {
        self.issue_bound(
            app_id,
            task_id,
            capabilities,
            ttl,
            Some(authorization_lease),
        )
    }

    fn issue_bound(
        &self,
        app_id: &str,
        task_id: &str,
        capabilities: &[Capability],
        ttl: Duration,
        authorization_lease: Option<&AuthorizationLease>,
    ) -> AgentResult<IssuedLease> {
        let mut bytes = [0_u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let value = URL_SAFE_NO_PAD.encode(bytes);
        let expires_at = now_unix().saturating_add(ttl.as_secs());
        self.database.insert_lease(
            &lease_hash(&value),
            app_id,
            task_id,
            capabilities,
            expires_at,
            authorization_lease,
        )?;
        Ok(IssuedLease { value, expires_at })
    }

    pub fn authorize<T>(&self, envelope: &RpcEnvelope<T>) -> AgentResult<()> {
        self.authorized_capabilities(envelope).map(|_| ())
    }

    pub fn authorized_capabilities<T>(
        &self,
        envelope: &RpcEnvelope<T>,
    ) -> AgentResult<Vec<Capability>> {
        Ok(self.authorized_record(envelope)?.capabilities)
    }

    pub(crate) fn authorized_record<T>(
        &self,
        envelope: &RpcEnvelope<T>,
    ) -> AgentResult<LeaseRecord> {
        if envelope.protocol_version != RPC_PROTOCOL_VERSION {
            return Err(AgentError::AccessDenied(
                "unsupported RPC protocol version".into(),
            ));
        }
        let Some(lease) = self.database.lease(&lease_hash(&envelope.lease))? else {
            return Err(AgentError::AccessDenied("unknown lease".into()));
        };
        if lease.expires_at <= now_unix() {
            return Err(AgentError::AccessDenied("expired lease".into()));
        }
        if lease.app_id != envelope.app_id || lease.task_id != envelope.task_id {
            return Err(AgentError::AccessDenied("lease scope mismatch".into()));
        }
        if !envelope.method.is_granted_by(&lease.capabilities) {
            return Err(AgentError::AccessDenied(format!(
                "capability does not grant {:?}",
                envelope.method
            )));
        }
        Ok(lease)
    }
}

fn lease_hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::tempdir;

    use crate::{AgentMethod, RpcEnvelope};

    use super::*;

    #[test]
    fn lease_is_bound_to_protocol_app_task_and_capability() {
        let directory = tempdir().unwrap();
        let database = Arc::new(Database::open(&directory.path().join("state.db")).unwrap());
        let authority = LeaseAuthority::new(database);
        let lease = authority
            .issue(
                "demo-app",
                "task-1",
                &[Capability::Filesystem {
                    access: crate::manifest::FileAccess::Read,
                    scopes: vec![crate::manifest::FileScope::Workspace],
                }],
                Duration::from_secs(60),
            )
            .unwrap();
        let allowed = RpcEnvelope {
            protocol_version: RPC_PROTOCOL_VERSION,
            app_id: "demo-app".into(),
            task_id: "task-1".into(),
            lease: lease.value.clone(),
            method: AgentMethod::WorkspaceRead,
            payload: (),
        };
        assert!(authority.authorize(&allowed).is_ok());
        assert_eq!(
            authority.authorized_capabilities(&allowed).unwrap().len(),
            1
        );
        let mut wrong_task = allowed.clone();
        wrong_task.task_id = "task-2".into();
        assert!(authority.authorize(&wrong_task).is_err());
        let mut missing_capability = allowed;
        missing_capability.method = AgentMethod::ProcessSpawn;
        assert!(authority.authorize(&missing_capability).is_err());
    }
}
