mod agent;
mod artifact;
mod authorization;
mod control_plane;
mod db;
mod ipc;
mod lease;
mod manifest;
mod rpc;
mod scheduler;
mod web_ui;

pub use agent::{
    Agent, AgentConfig, AgentLocaleSettings, AgentSnapshot, DeviceEnrollmentPreparation,
    DeviceRegistrationStatus, InstallRequest, InstalledApplet, RunOutcome, RunnerRequest,
    TaskRecord,
};
pub use artifact::{
    ArtifactAttestation, Ed25519Verifier, RejectUnsignedVerifier, SignatureVerifier,
};
pub use authorization::{
    desktop_capability_hash, AuthorizationLease, AuthorizationLeaseClaims,
    AuthorizationLeaseSignature, AuthorizationLeaseTask, AuthorizationLeaseVerifier,
    AuthorizationTaskKind, Ed25519AuthorizationLeaseVerifier, RejectAuthorizationLeases,
    MAX_AUTHORIZATION_LEASE_TTL_MS,
};
pub use control_plane::{
    clear_device_registration, load_control_plane_config, persist_device_registration,
    ArtifactDownloader, ControlPlaneClient, ControlPlaneConfig, ControlPlaneHttpRequest,
    ControlPlaneHttpResponse, ControlPlaneMethod, ControlPlaneTransport, DeviceCredential,
    DeviceCredentialProvider, InstallationStatusReport, InstallationSyncArtifact,
    InstallationSyncItem, InstallationSyncResponse, InstallationSyncSnapshot,
    InstallationSyncStatus, NativeDeviceCredentialStore, ReportInstallationStatus, ReportRunStatus,
    ReqwestArtifactDownloader, ReqwestControlPlaneTransport, RunClaim, RunControl, RunReport,
    ScheduleSyncOutcome, ScheduleSyncResponse,
};
pub use ipc::{
    authorize_runner_request, run_agent_daemon, AgentClient, AgentEndpoint, ManagementCommand,
    AGENT_PROTOCOL_VERSION,
};
pub use lease::{IssuedLease, LeaseAuthority};
pub use manifest::{
    resolve_contained, AppletManifest, Capability, DesktopArch, DesktopOs, RunMode, RuntimeKind,
    RuntimeSpec, TargetPlatform,
};
pub use rpc::{AgentMethod, HostTaskContext, RpcEnvelope, RPC_PROTOCOL_VERSION};
pub use scheduler::{ScheduleDelta, ScheduleRecord, ScheduleSnapshot, SyncState};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
    #[error("artifact digest mismatch")]
    DigestMismatch,
    #[error("artifact signature was rejected: {0}")]
    SignatureRejected(String),
    #[error("archive is unsafe: {0}")]
    UnsafeArchive(String),
    #[error("path escapes its allowed root: {0}")]
    PathEscape(String),
    #[error("application is not installed: {0}@{1}")]
    NotInstalled(String, String),
    #[error("task was not found: {0}")]
    TaskNotFound(String),
    #[error("request was denied: {0}")]
    AccessDenied(String),
    #[error("unsupported host target: {0}")]
    UnsupportedTarget(String),
    #[error("state error: {0}")]
    State(String),
    #[error("runner error: {0}")]
    Runner(String),
    #[error("control plane error: {0}")]
    ControlPlane(String),
    #[error("control plane rejected the device request with HTTP {0}")]
    ControlPlaneRejected(u16),
    #[error("device credential is invalid: {0}")]
    DeviceCredentialInvalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    #[error(transparent)]
    Archive(#[from] zip::result::ZipError),
}

pub type AgentResult<T> = Result<T, AgentError>;

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
