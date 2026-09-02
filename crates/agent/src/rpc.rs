use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::Capability;

pub const RPC_PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentMethod {
    ContextRead,
    TaskLogAppend,
    TaskProgress,
    WorkspaceRead,
    WorkspaceWrite,
    HttpRequest,
    NotificationShow,
    ProcessSpawn,
}

impl AgentMethod {
    pub fn is_granted_by(&self, capabilities: &[Capability]) -> bool {
        match self {
            Self::ContextRead | Self::TaskLogAppend | Self::TaskProgress => true,
            Self::WorkspaceRead => capabilities.iter().any(Capability::grants_workspace_read),
            Self::WorkspaceWrite => capabilities.iter().any(Capability::grants_workspace_write),
            Self::HttpRequest => capabilities
                .iter()
                .any(|capability| matches!(capability, Capability::Network { .. })),
            Self::NotificationShow => capabilities
                .iter()
                .any(|capability| matches!(capability, Capability::Notifications)),
            Self::ProcessSpawn => capabilities
                .iter()
                .any(|capability| matches!(capability, Capability::Subprocess { .. })),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcEnvelope<T> {
    pub protocol_version: u16,
    pub app_id: String,
    pub task_id: String,
    pub lease: String,
    pub method: AgentMethod,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostTaskContext {
    pub app_id: String,
    pub task_id: String,
    pub work_directory: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_directory: Option<PathBuf>,
    pub arguments: Vec<String>,
}
