use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use chrono::DateTime;
use reqwest::{
    blocking::Client,
    header::{ACCEPT, AUTHORIZATION},
    redirect::Policy,
    Method,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use url::{Host, Url};
use uuid::Uuid;

use crate::{
    manifest::PublisherSignature,
    scheduler::{is_application_slug, is_contract_semver},
    Agent, AgentError, AgentResult, AppletManifest, ScheduleDelta, ScheduleSnapshot,
    TargetPlatform,
};

const MAX_HTTP_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DEVICE_CREDENTIAL_SERVICE: &str = "dev.awesome-workflow.agent";
const CONTROL_PLANE_CONFIG_FILE: &str = "control-plane.json";
const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ControlPlaneConfig {
    api_base_url: Url,
    device_id: Uuid,
}

impl ControlPlaneConfig {
    pub fn new(api_base_url: &str, device_id: &str) -> AgentResult<Self> {
        let mut api_base_url = Url::parse(api_base_url)
            .map_err(|_| AgentError::ControlPlane("API base URL is invalid".into()))?;
        let local_http = api_base_url.scheme() == "http"
            && match api_base_url.host() {
                Some(Host::Domain(host)) => host == "localhost",
                Some(Host::Ipv4(address)) => address.is_loopback(),
                Some(Host::Ipv6(address)) => address.is_loopback(),
                None => false,
            };
        if (api_base_url.scheme() != "https" && !local_http)
            || !api_base_url.username().is_empty()
            || api_base_url.password().is_some()
            || api_base_url.query().is_some()
            || api_base_url.fragment().is_some()
        {
            return Err(AgentError::ControlPlane(
                "API base URL must be HTTPS (or loopback HTTP) without credentials, query or fragment"
                    .into(),
            ));
        }
        let base_path = api_base_url.path().trim_end_matches('/').to_owned();
        if base_path.is_empty() {
            return Err(AgentError::ControlPlane(
                "API base URL must include its fixed API path".into(),
            ));
        }
        api_base_url.set_path(&base_path);
        let device_id = Uuid::parse_str(device_id)
            .map_err(|_| AgentError::ControlPlane("device ID must be a UUID".into()))?;
        Ok(Self {
            api_base_url,
            device_id,
        })
    }

    pub fn api_base_url(&self) -> &Url {
        &self.api_base_url
    }

    pub fn device_id(&self) -> Uuid {
        self.device_id
    }

    fn endpoint(&self, suffix: &str) -> Url {
        let mut endpoint = self.api_base_url.clone();
        endpoint.set_path(&format!(
            "{}/{}",
            self.api_base_url.path(),
            suffix.trim_start_matches('/')
        ));
        endpoint
    }
}

/// An opaque credential issued to one registered device. It deliberately has
/// no `Debug`, `Display`, serialization or cloning implementation.
pub struct DeviceCredential(String);

impl DeviceCredential {
    pub fn new(value: String) -> AgentResult<Self> {
        let valid = value.len() == 47
            && value.starts_with("awd_")
            && value[4..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        if !valid {
            return Err(AgentError::DeviceCredentialInvalid(
                "credential is incomplete or malformed".into(),
            ));
        }
        Ok(Self(value))
    }

    /// Intended only for the trusted HTTP transport while constructing the
    /// Authorization header. Callers must never log or serialize the value.
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

pub trait DeviceCredentialProvider: Send + Sync {
    fn load(&self, device_id: Uuid) -> AgentResult<Option<DeviceCredential>>;
}

#[derive(Default)]
pub struct NativeDeviceCredentialStore;

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl NativeDeviceCredentialStore {
    fn entry(&self, device_id: Uuid) -> AgentResult<keyring::Entry> {
        keyring::Entry::new(DEVICE_CREDENTIAL_SERVICE, &format!("device-{device_id}"))
            .map_err(|_| AgentError::AccessDenied("device credential store is unavailable".into()))
    }

    pub fn save(&self, device_id: Uuid, credential: &DeviceCredential) -> AgentResult<()> {
        self.entry(device_id)?
            .set_password(credential.expose_secret())
            .map_err(|_| AgentError::AccessDenied("device credential store is unavailable".into()))
    }

    pub fn delete(&self, device_id: Uuid) -> AgentResult<()> {
        match self.entry(device_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AgentError::AccessDenied(
                "device credential store is unavailable".into(),
            )),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
impl NativeDeviceCredentialStore {
    pub fn save(&self, _device_id: Uuid, _credential: &DeviceCredential) -> AgentResult<()> {
        Err(AgentError::AccessDenied(
            "device credential storage is unsupported on this platform".into(),
        ))
    }

    pub fn delete(&self, _device_id: Uuid) -> AgentResult<()> {
        Err(AgentError::AccessDenied(
            "device credential storage is unsupported on this platform".into(),
        ))
    }
}

impl DeviceCredentialProvider for NativeDeviceCredentialStore {
    fn load(&self, device_id: Uuid) -> AgentResult<Option<DeviceCredential>> {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let value = match self.entry(device_id)?.get_password() {
                Ok(value) => value,
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(_) => {
                    return Err(AgentError::AccessDenied(
                        "device credential store is unavailable".into(),
                    ))
                }
            };
            DeviceCredential::new(value).map(Some)
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = device_id;
            Err(AgentError::AccessDenied(
                "device credential storage is unsupported on this platform".into(),
            ))
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedControlPlaneConfig {
    api_base_url: String,
    device_id: String,
}

pub fn load_control_plane_config(data_root: &Path) -> AgentResult<Option<ControlPlaneConfig>> {
    let path = data_root.join(CONTROL_PLANE_CONFIG_FILE);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let persisted: PersistedControlPlaneConfig = serde_json::from_slice(&bytes)
        .map_err(|_| AgentError::ControlPlane("stored device configuration is invalid".into()))?;
    ControlPlaneConfig::new(&persisted.api_base_url, &persisted.device_id).map(Some)
}

pub fn persist_device_registration(
    data_root: &Path,
    config: &ControlPlaneConfig,
    credential: &DeviceCredential,
) -> AgentResult<()> {
    fs::create_dir_all(data_root)?;
    let store = NativeDeviceCredentialStore;
    if let Some(existing) = load_control_plane_config(data_root)? {
        if existing.device_id != config.device_id || existing.api_base_url != config.api_base_url {
            return Err(AgentError::State(
                "Agent is already enrolled with a different device registration".into(),
            ));
        }
        // Re-enrollment rotates only the OS credential. The secretless config
        // is already durable, so there is no reason to replace it on Windows.
        return store.save(config.device_id, credential);
    }
    store.save(config.device_id, credential)?;
    let persisted = PersistedControlPlaneConfig {
        api_base_url: config.api_base_url.to_string(),
        device_id: config.device_id.to_string(),
    };
    let path = data_root.join(CONTROL_PLANE_CONFIG_FILE);
    let temporary = temporary_config_path(data_root);
    let result = (|| {
        fs::write(&temporary, serde_json::to_vec_pretty(&persisted)?)?;
        restrict_secretless_config(&temporary)?;
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
        let _ = store.delete(config.device_id);
    }
    result
}

pub fn clear_device_registration(data_root: &Path, device_id: Uuid) -> AgentResult<()> {
    let path = data_root.join(CONTROL_PLANE_CONFIG_FILE);
    let file_result = match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AgentError::Io(error)),
    };
    let credential_result = NativeDeviceCredentialStore.delete(device_id);
    file_result.and(credential_result)
}

fn temporary_config_path(data_root: &Path) -> PathBuf {
    data_root.join(format!(
        ".{CONTROL_PLANE_CONFIG_FILE}.{}.tmp",
        Uuid::new_v4()
    ))
}

#[cfg(unix)]
fn restrict_secretless_config(path: &Path) -> AgentResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(windows)]
fn restrict_secretless_config(_path: &Path) -> AgentResult<()> {
    // AgentEndpoint applies a same-user ACL to the containing data directory.
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlPlaneMethod {
    Get,
    Post,
}

pub struct ControlPlaneHttpRequest {
    method: ControlPlaneMethod,
    url: Url,
    authorization: DeviceCredential,
    body: Option<Value>,
}

impl ControlPlaneHttpRequest {
    pub fn method(&self) -> ControlPlaneMethod {
        self.method
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    pub fn authorization(&self) -> &DeviceCredential {
        &self.authorization
    }

    pub fn body(&self) -> Option<&Value> {
        self.body.as_ref()
    }
}

#[derive(Debug)]
pub struct ControlPlaneHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait ControlPlaneTransport: Send + Sync {
    fn send(&self, request: ControlPlaneHttpRequest) -> AgentResult<ControlPlaneHttpResponse>;
}

pub trait ArtifactDownloader: Send + Sync {
    fn download(&self, artifact: &InstallationSyncArtifact, destination: &Path) -> AgentResult<()>;
}

pub struct ReqwestControlPlaneTransport {
    client: Client,
}

impl ReqwestControlPlaneTransport {
    pub fn new() -> AgentResult<Self> {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .build()
            .map(|client| Self { client })
            .map_err(|_| AgentError::ControlPlane("failed to initialize HTTP transport".into()))
    }
}

impl ControlPlaneTransport for ReqwestControlPlaneTransport {
    fn send(&self, request: ControlPlaneHttpRequest) -> AgentResult<ControlPlaneHttpResponse> {
        let method = match request.method {
            ControlPlaneMethod::Get => Method::GET,
            ControlPlaneMethod::Post => Method::POST,
        };
        let authorization = format!("Device {}", request.authorization.expose_secret());
        let mut builder = self
            .client
            .request(method, request.url)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, authorization);
        if let Some(body) = request.body {
            builder = builder.json(&body);
        }
        let response = builder
            .send()
            .map_err(|_| AgentError::ControlPlane("HTTP request failed".into()))?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES)
        {
            return Err(AgentError::ControlPlane(
                "HTTP response is too large".into(),
            ));
        }
        let status = response.status().as_u16();
        let mut body = Vec::new();
        response
            .take(MAX_HTTP_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| AgentError::ControlPlane("failed to read HTTP response".into()))?;
        if body.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
            return Err(AgentError::ControlPlane(
                "HTTP response is too large".into(),
            ));
        }
        Ok(ControlPlaneHttpResponse { status, body })
    }
}

pub struct ReqwestArtifactDownloader {
    client: Client,
}

impl ReqwestArtifactDownloader {
    pub fn new() -> AgentResult<Self> {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(10 * 60))
            .redirect(Policy::none())
            .build()
            .map(|client| Self { client })
            .map_err(|_| AgentError::ControlPlane("failed to initialize artifact transport".into()))
    }
}

impl ArtifactDownloader for ReqwestArtifactDownloader {
    fn download(&self, artifact: &InstallationSyncArtifact, destination: &Path) -> AgentResult<()> {
        artifact.validate()?;
        if artifact.download_expired() {
            return Err(AgentError::ControlPlane(
                "artifact download URL has expired".into(),
            ));
        }
        let url = validated_download_url(&artifact.download_url)?;
        let mut response = self
            .client
            .get(url)
            .header(ACCEPT, "application/octet-stream")
            .send()
            .map_err(|_| AgentError::ControlPlane("artifact download failed".into()))?;
        if response.status().as_u16() != 200 {
            return Err(AgentError::ControlPlane(format!(
                "artifact download returned HTTP {}",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length != artifact.size)
        {
            return Err(AgentError::DigestMismatch);
        }

        let result = (|| {
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            let mut written = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = response.read(&mut buffer).map_err(|_| {
                    AgentError::ControlPlane("artifact download was interrupted".into())
                })?;
                if count == 0 {
                    break;
                }
                written = written
                    .checked_add(count as u64)
                    .ok_or_else(|| AgentError::ControlPlane("artifact size overflow".into()))?;
                if written > artifact.size {
                    return Err(AgentError::DigestMismatch);
                }
                output.write_all(&buffer[..count])?;
            }
            output.flush()?;
            if written != artifact.size {
                return Err(AgentError::DigestMismatch);
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(destination);
        }
        result
    }
}

pub struct ControlPlaneClient {
    config: ControlPlaneConfig,
    credentials: Arc<dyn DeviceCredentialProvider>,
    transport: Arc<dyn ControlPlaneTransport>,
}

impl ControlPlaneClient {
    pub fn new(
        config: ControlPlaneConfig,
        credentials: Arc<dyn DeviceCredentialProvider>,
        transport: Arc<dyn ControlPlaneTransport>,
    ) -> Self {
        Self {
            config,
            credentials,
            transport,
        }
    }

    pub(crate) fn device_id(&self) -> String {
        self.config.device_id().to_string()
    }

    pub fn sync_agent_schedules(
        &self,
        agent: &Agent,
        verifier: &dyn crate::AuthorizationLeaseVerifier,
    ) -> AgentResult<ScheduleSyncOutcome> {
        let result = (|| {
            let sync = agent.schedule_sync_state()?;
            let revision = sync.last_sync_at.map(|_| sync.revision);
            match self.fetch_schedule_sync(revision)? {
                ScheduleSyncResponse::Snapshot { snapshot } => {
                    let revision = snapshot.revision;
                    let applied = agent.apply_control_plane_schedule_snapshot(
                        &snapshot,
                        &self.config.device_id().to_string(),
                        verifier,
                    )?;
                    Ok(ScheduleSyncOutcome::Snapshot { revision, applied })
                }
                ScheduleSyncResponse::Delta { delta } => {
                    let from_revision = delta.from_revision;
                    let to_revision = delta.to_revision;
                    let applied = agent.apply_control_plane_schedule_delta(
                        &delta,
                        &self.config.device_id().to_string(),
                        verifier,
                    )?;
                    Ok(ScheduleSyncOutcome::Delta {
                        from_revision,
                        to_revision,
                        applied,
                    })
                }
            }
        })();
        if result.is_err() {
            let _ = agent.mark_schedule_offline();
        }
        result
    }

    pub fn fetch_schedule_sync(&self, revision: Option<u64>) -> AgentResult<ScheduleSyncResponse> {
        if revision.is_some_and(|value| value > MAX_SAFE_INTEGER) {
            return Err(AgentError::ControlPlane(
                "schedule revision exceeds the JSON safe-integer range".into(),
            ));
        }
        let mut url = self
            .config
            .endpoint(&format!("devices/{}/schedules/sync", self.config.device_id));
        if let Some(revision) = revision {
            url.query_pairs_mut()
                .append_pair("revision", &revision.to_string());
        }
        let response: ScheduleSyncResponse = self.request(ControlPlaneMethod::Get, url, None)?;
        match &response {
            ScheduleSyncResponse::Snapshot { snapshot } => snapshot.validate()?,
            ScheduleSyncResponse::Delta { delta } => delta.validate()?,
        }
        Ok(response)
    }

    pub fn fetch_installation_sync(
        &self,
        revision: Option<u64>,
    ) -> AgentResult<InstallationSyncResponse> {
        if revision.is_some_and(|value| value > MAX_SAFE_INTEGER) {
            return Err(AgentError::ControlPlane(
                "installation revision exceeds the JSON safe-integer range".into(),
            ));
        }
        let mut url = self.config.endpoint(&format!(
            "devices/{}/installations/sync",
            self.config.device_id
        ));
        if let Some(revision) = revision {
            url.query_pairs_mut()
                .append_pair("revision", &revision.to_string());
        }
        let response: InstallationSyncResponse =
            self.request(ControlPlaneMethod::Get, url, None)?;
        response.validate(revision)?;
        Ok(response)
    }

    pub fn claim_runs(&self, limit: u8) -> AgentResult<Vec<RunClaim>> {
        if !(1..=32).contains(&limit) {
            return Err(AgentError::ControlPlane(
                "run claim limit must be between 1 and 32".into(),
            ));
        }
        let url = self
            .config
            .endpoint(&format!("devices/{}/runs/claim", self.config.device_id));
        let claims: Vec<RunClaim> = self.request(
            ControlPlaneMethod::Post,
            url,
            Some(serde_json::json!({ "limit": limit })),
        )?;
        let mut run_ids = HashSet::new();
        for claim in &claims {
            claim.validate()?;
            if !run_ids.insert(claim.run_id.as_str()) {
                return Err(AgentError::ControlPlane(
                    "run claim response contains a duplicate run".into(),
                ));
            }
        }
        Ok(claims)
    }

    pub fn fetch_run_controls(&self) -> AgentResult<Vec<RunControl>> {
        let url = self
            .config
            .endpoint(&format!("devices/{}/runs/control", self.config.device_id));
        let controls: Vec<RunControl> = self.request(ControlPlaneMethod::Get, url, None)?;
        let mut attempts = HashSet::new();
        for control in &controls {
            control.validate()?;
            if !attempts.insert((control.run_id.as_str(), control.attempt)) {
                return Err(AgentError::ControlPlane(
                    "run control response contains a duplicate run attempt".into(),
                ));
            }
        }
        Ok(controls)
    }

    pub fn report_installation(
        &self,
        installation_id: &str,
        report: &InstallationStatusReport,
    ) -> AgentResult<()> {
        let installation_id = Uuid::parse_str(installation_id)
            .map_err(|_| AgentError::ControlPlane("installation ID must be a UUID".into()))?;
        report.validate()?;
        let url = self.config.endpoint(&format!(
            "devices/{}/installations/{installation_id}/status",
            self.config.device_id
        ));
        let acknowledged: Value = self.request(
            ControlPlaneMethod::Post,
            url,
            Some(serde_json::to_value(report)?),
        )?;
        validate_acknowledgement(
            &acknowledged,
            installation_id,
            report.status.as_str(),
            "installation status",
        )
    }

    pub fn report_run(&self, run_id: &str, report: &RunReport) -> AgentResult<()> {
        let run_id = Uuid::parse_str(run_id)
            .map_err(|_| AgentError::ControlPlane("run ID must be a UUID".into()))?;
        report.validate()?;
        let url = self.config.endpoint(&format!(
            "devices/{}/runs/{run_id}/report",
            self.config.device_id
        ));
        let acknowledged: Value = self.request(
            ControlPlaneMethod::Post,
            url,
            Some(serde_json::to_value(report)?),
        )?;
        validate_acknowledgement(&acknowledged, run_id, report.status.as_str(), "run report")
    }

    fn request<T: DeserializeOwned>(
        &self,
        method: ControlPlaneMethod,
        url: Url,
        body: Option<Value>,
    ) -> AgentResult<T> {
        if url.origin() != self.config.api_base_url.origin() {
            return Err(AgentError::AccessDenied(
                "control-plane request origin changed".into(),
            ));
        }
        let credential = self
            .credentials
            .load(self.config.device_id)?
            .ok_or_else(|| AgentError::DeviceCredentialInvalid("credential is missing".into()))?;
        let response = self.transport.send(ControlPlaneHttpRequest {
            method,
            url,
            authorization: credential,
            body,
        })?;
        if matches!(response.status, 401 | 403) {
            return Err(AgentError::ControlPlaneRejected(response.status));
        }
        if response.status != 200 {
            return Err(AgentError::ControlPlane(format!(
                "request returned HTTP {}",
                response.status
            )));
        }
        let envelope: ApiEnvelope<T> = serde_json::from_slice(&response.body).map_err(|_| {
            AgentError::ControlPlane("response JSON does not match the contract".into())
        })?;
        Ok(envelope.data)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleSyncOutcome {
    Snapshot {
        revision: u64,
        applied: bool,
    },
    Delta {
        from_revision: u64,
        to_revision: u64,
        applied: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ScheduleSyncResponse {
    Snapshot { snapshot: ScheduleSnapshot },
    Delta { delta: ScheduleDelta },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum InstallationSyncResponse {
    Snapshot { snapshot: InstallationSyncSnapshot },
    Unchanged { revision: u64 },
}

impl InstallationSyncResponse {
    fn validate(&self, requested_revision: Option<u64>) -> AgentResult<()> {
        let revision = match self {
            Self::Snapshot { snapshot } => {
                snapshot.validate()?;
                snapshot.revision
            }
            Self::Unchanged { revision } => *revision,
        };
        if revision > MAX_SAFE_INTEGER
            || requested_revision.is_some_and(|requested| revision < requested)
        {
            return Err(AgentError::ControlPlane(
                "installation sync revision is invalid".into(),
            ));
        }
        if matches!(self, Self::Unchanged { .. }) && requested_revision != Some(revision) {
            return Err(AgentError::ControlPlane(
                "unchanged installation response does not match the requested revision".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationSyncSnapshot {
    pub revision: u64,
    pub installations: Vec<InstallationSyncItem>,
}

impl InstallationSyncSnapshot {
    fn validate(&self) -> AgentResult<()> {
        if self.revision > MAX_SAFE_INTEGER {
            return Err(AgentError::ControlPlane(
                "installation snapshot revision is invalid".into(),
            ));
        }
        let mut ids = HashSet::new();
        for installation in &self.installations {
            installation.validate_identity()?;
            if !ids.insert(installation.installation_id.as_str()) {
                return Err(AgentError::ControlPlane(
                    "installation snapshot contains a duplicate installation".into(),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn validate_for_target(&self, target: TargetPlatform) -> AgentResult<()> {
        self.validate()?;
        for installation in &self.installations {
            installation.validate_for_target(target)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallationSyncStatus {
    Requested,
    Downloading,
    Installed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationSyncItem {
    pub installation_id: String,
    pub status: InstallationSyncStatus,
    pub app_id: String,
    pub version: String,
    pub manifest: AppletManifest,
    pub artifact: InstallationSyncArtifact,
}

impl InstallationSyncItem {
    fn validate_identity(&self) -> AgentResult<()> {
        if Uuid::parse_str(&self.installation_id).is_err()
            || !is_application_slug(&self.app_id)
            || !is_contract_semver(&self.version)
            || self.manifest.app_id != self.app_id
            || self.manifest.version.to_string() != self.version
        {
            return Err(AgentError::ControlPlane(
                "installation item does not match the Agent contract".into(),
            ));
        }
        self.manifest.validate()?;
        self.artifact.validate()
    }

    pub(crate) fn validate_for_target(&self, target: TargetPlatform) -> AgentResult<()> {
        self.validate_identity()?;
        let runtime = self.manifest.runtime_for(target)?;
        let declaration = self
            .manifest
            .artifacts
            .iter()
            .find(|candidate| candidate.name == runtime.artifact)
            .ok_or_else(|| {
                AgentError::ControlPlane(
                    "installation runtime artifact is missing from the manifest".into(),
                )
            })?;
        if declaration.name != self.artifact.name
            || declaration.file_name.to_string_lossy() != self.artifact.file_name
            || declaration.media_type != self.artifact.media_type
            || declaration.size != self.artifact.size
            || declaration.sha256 != self.artifact.sha256
        {
            return Err(AgentError::ControlPlane(
                "installation artifact does not match the signed manifest".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationSyncArtifact {
    pub name: String,
    pub file_name: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
    pub download_url: String,
    pub download_expires_at: String,
    pub attestation: PublisherSignature,
}

impl InstallationSyncArtifact {
    fn validate(&self) -> AgentResult<()> {
        if self.name.is_empty()
            || self.name.len() > 120
            || self.file_name.is_empty()
            || self.file_name.len() > 240
            || self.media_type.is_empty()
            || self.media_type.len() > 120
            || self.size == 0
            || self.size > MAX_ARTIFACT_BYTES
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || DateTime::parse_from_rfc3339(&self.download_expires_at).is_err()
        {
            return Err(AgentError::ControlPlane(
                "installation artifact does not match the Agent contract".into(),
            ));
        }
        validated_download_url(&self.download_url)?;
        Ok(())
    }

    fn download_expired(&self) -> bool {
        DateTime::parse_from_rfc3339(&self.download_expires_at)
            .map(|expires| expires.timestamp() <= chrono::Utc::now().timestamp())
            .unwrap_or(true)
    }

    pub(crate) fn artifact_attestation(&self) -> crate::ArtifactAttestation {
        crate::ArtifactAttestation {
            sha256: self.sha256.clone(),
            signature: self.attestation.value.clone(),
            key_id: self.attestation.key_id.clone(),
        }
    }
}

fn validated_download_url(value: &str) -> AgentResult<Url> {
    let url = Url::parse(value)
        .map_err(|_| AgentError::ControlPlane("artifact download URL is invalid".into()))?;
    let local_http = url.scheme() == "http"
        && match url.host() {
            Some(Host::Domain(host)) => host == "localhost",
            Some(Host::Ipv4(address)) => address.is_loopback(),
            Some(Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        };
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AgentError::ControlPlane(
            "artifact download URL must be HTTPS (or loopback HTTP) without credentials or fragment"
                .into(),
        ));
    }
    Ok(url)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportInstallationStatus {
    Downloading,
    Installed,
    Failed,
    Removed,
}

impl ReportInstallationStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Downloading => "downloading",
            Self::Installed => "installed",
            Self::Failed => "failed",
            Self::Removed => "removed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationStatusReport {
    pub status: ReportInstallationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl InstallationStatusReport {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if self.error_code.as_deref().is_some_and(invalid_error_code) {
            return Err(AgentError::ControlPlane(
                "installation report errorCode is invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunClaim {
    pub run_id: String,
    pub attempt: u64,
    pub app_id: String,
    pub version: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub requires_elevation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_lease: Option<crate::AuthorizationLease>,
}

impl RunClaim {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if Uuid::parse_str(&self.run_id).is_err()
            || self.attempt == 0
            || self.attempt > MAX_SAFE_INTEGER
            || !is_application_slug(&self.app_id)
            || !is_contract_semver(&self.version)
            || self.args.len() > 256
            || self.args.iter().any(|argument| argument.len() > 8_192)
        {
            return Err(AgentError::ControlPlane(
                "run claim does not match the Agent contract".into(),
            ));
        }
        if let Some(lease) = &self.authorization_lease {
            lease.validate()?;
            if lease.claims.task.kind != crate::AuthorizationTaskKind::Run
                || lease.claims.task.id != self.run_id
                || lease.claims.revision != self.attempt
                || lease.claims.app_id != self.app_id
                || lease.claims.version != self.version
                || lease.claims.intent_hash != self.authorization_intent_hash()?
            {
                return Err(AgentError::ControlPlane(
                    "run authorization lease scope does not match the claim".into(),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn authorization_intent_hash(&self) -> AgentResult<String> {
        let mut intent = serde_json::to_value(self)?;
        intent
            .as_object_mut()
            .ok_or_else(|| AgentError::State("run claim intent is not an object".into()))?
            .remove("authorizationLease");
        crate::authorization::authorization_intent_hash(&intent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunControl {
    pub run_id: String,
    pub attempt: u64,
    pub cancel_requested_at: String,
}

impl RunControl {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if Uuid::parse_str(&self.run_id).is_err()
            || self.attempt == 0
            || self.attempt > MAX_SAFE_INTEGER
            || DateTime::parse_from_rfc3339(&self.cancel_requested_at).is_err()
        {
            return Err(AgentError::ControlPlane(
                "run control does not match the Agent contract".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportRunStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    NeedsUserApproval,
}

impl ReportRunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::NeedsUserApproval => "needs_user_approval",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunReport {
    pub attempt: u64,
    pub status: ReportRunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl RunReport {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if self.attempt == 0 || self.attempt > MAX_SAFE_INTEGER {
            return Err(AgentError::ControlPlane(
                "run report attempt is invalid".into(),
            ));
        }
        if self.error_code.as_deref().is_some_and(invalid_error_code) {
            return Err(AgentError::ControlPlane(
                "run report errorCode is invalid".into(),
            ));
        }
        Ok(())
    }
}

fn invalid_error_code(value: &str) -> bool {
    value.is_empty()
        || value.len() > 160
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'_')
        })
}

fn validate_acknowledgement(
    acknowledged: &Value,
    expected_id: Uuid,
    expected_status: &str,
    operation: &str,
) -> AgentResult<()> {
    let acknowledged_id = acknowledged
        .get("id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok());
    if acknowledged_id != Some(expected_id)
        || acknowledged.get("status").and_then(Value::as_str) != Some(expected_status)
    {
        return Err(AgentError::ControlPlane(format!(
            "{operation} acknowledgement does not match the request"
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, path::PathBuf, sync::Mutex};

    use tempfile::tempdir;

    use crate::{AgentConfig, DesktopArch, DesktopOs, TargetPlatform};

    use super::*;

    const DEVICE_ID: &str = "0a758fd3-c85d-4d36-8f0c-604d3d77879a";
    const INSTALLATION_ID: &str = "c765258c-d755-41f6-8612-9eb7f1a9782b";
    const SCHEDULE_ID: &str = "3cf60eb1-9355-48d0-8d2f-97b3c307f0cf";
    const RUN_ID: &str = "fef02ed3-6b09-462f-ac14-51e208b490c6";
    const APPLICATION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const RELEASE_ID: &str = "22222222-2222-4222-8222-222222222222";

    struct AllowAuthorization;
    impl crate::AuthorizationLeaseVerifier for AllowAuthorization {
        fn verify(&self, lease: &crate::AuthorizationLease) -> AgentResult<()> {
            lease.validate()
        }
    }

    struct StaticCredentials(Option<String>);

    impl DeviceCredentialProvider for StaticCredentials {
        fn load(&self, device_id: Uuid) -> AgentResult<Option<DeviceCredential>> {
            assert_eq!(device_id, Uuid::parse_str(DEVICE_ID).unwrap());
            self.0.clone().map(DeviceCredential::new).transpose()
        }
    }

    #[derive(Debug)]
    struct ObservedRequest {
        method: ControlPlaneMethod,
        url: Url,
        authorization: String,
        body: Option<Value>,
    }

    struct MockTransport {
        responses: Mutex<VecDeque<ControlPlaneHttpResponse>>,
        requests: Mutex<Vec<ObservedRequest>>,
    }

    impl MockTransport {
        fn new(responses: Vec<Value>) -> Self {
            Self {
                responses: Mutex::new(
                    responses
                        .into_iter()
                        .map(|body| ControlPlaneHttpResponse {
                            status: 200,
                            body: serde_json::to_vec(&body).unwrap(),
                        })
                        .collect(),
                ),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl ControlPlaneTransport for MockTransport {
        fn send(&self, request: ControlPlaneHttpRequest) -> AgentResult<ControlPlaneHttpResponse> {
            self.requests.lock().unwrap().push(ObservedRequest {
                method: request.method,
                url: request.url,
                authorization: format!("Device {}", request.authorization.expose_secret()),
                body: request.body,
            });
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| AgentError::ControlPlane("missing mock response".into()))
        }
    }

    fn test_agent(root: PathBuf) -> Agent {
        Agent::open(AgentConfig {
            runner_path: root.join("runner"),
            rpc_endpoint: "test-rpc".into(),
            data_root: root,
            python_runtime: None,
            target: TargetPlatform {
                os: DesktopOs::Windows,
                arch: DesktopArch::X64,
            },
            developer_mode: false,
        })
        .unwrap()
    }

    fn schedule(args: &[&str], revision: u64) -> Value {
        let issued_at = crate::now_unix_ms();
        let intent = serde_json::json!({
            "scheduleId": SCHEDULE_ID,
            "revision": revision,
            "applicationId": APPLICATION_ID,
            "releaseId": RELEASE_ID,
            "appId": "demo-app",
            "version": "1.2.3",
            "cronExpression": "0 * * * *",
            "timezone": "UTC",
            "nextRunAtMs": crate::now_unix_ms() + 3_600_000,
            "args": args,
            "enabled": true
        });
        let intent_hash = crate::authorization::authorization_intent_hash(&intent).unwrap();
        let mut record = intent;
        record.as_object_mut().unwrap().insert(
            "authorizationLease".into(),
            serde_json::json!({
                "authorizationLease": {
                    "claims": {
                        "schemaVersion": 1,
                        "leaseId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "revision": revision,
                        "deviceId": DEVICE_ID,
                        "applicationId": APPLICATION_ID,
                        "releaseId": RELEASE_ID,
                        "appId": "demo-app",
                        "version": "1.2.3",
                        "task": {"kind": "schedule", "id": SCHEDULE_ID},
                        "capabilityHash": "a".repeat(64),
                        "intentHash": intent_hash,
                        "issuedAt": issued_at,
                        "expiresAt": issued_at + 300_000
                    },
                    "signature": {"algorithm": "ed25519", "keyId": "test", "value": "A".repeat(88)}
                }
            })["authorizationLease"]
                .clone(),
        );
        record
    }

    #[test]
    fn run_authorization_rejects_argument_and_elevation_tampering() {
        let mut claim = RunClaim {
            run_id: RUN_ID.into(),
            attempt: 2,
            app_id: "demo-app".into(),
            version: "1.2.3".into(),
            args: vec!["--safe".into()],
            requires_elevation: false,
            authorization_lease: None,
        };
        let intent_hash = claim.authorization_intent_hash().unwrap();
        claim.authorization_lease = Some(crate::AuthorizationLease {
            claims: crate::AuthorizationLeaseClaims {
                schema_version: 1,
                lease_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                revision: claim.attempt,
                device_id: DEVICE_ID.into(),
                application_id: APPLICATION_ID.into(),
                release_id: RELEASE_ID.into(),
                app_id: claim.app_id.clone(),
                version: claim.version.clone(),
                task: crate::AuthorizationLeaseTask {
                    kind: crate::AuthorizationTaskKind::Run,
                    id: claim.run_id.clone(),
                },
                capability_hash: "a".repeat(64),
                intent_hash,
                issued_at: 1_800_000_000_000,
                expires_at: 1_800_000_300_000,
            },
            signature: crate::AuthorizationLeaseSignature {
                algorithm: "ed25519".into(),
                key_id: "intent-test".into(),
                value: "A".repeat(88),
            },
        });
        claim.validate().unwrap();

        let mut changed_args = claim.clone();
        changed_args.args = vec!["--unsafe".into()];
        assert!(changed_args.validate().is_err());
        let mut elevated = claim;
        elevated.requires_elevation = true;
        assert!(elevated.validate().is_err());
    }

    #[test]
    fn fixed_device_origin_drives_snapshot_delta_claim_and_report() {
        let directory = tempdir().unwrap();
        let agent = test_agent(directory.path().to_path_buf());
        let transport = Arc::new(MockTransport::new(vec![
            serde_json::json!({"data": {
                "kind": "snapshot",
                "snapshot": {"revision": 1, "schedules": [schedule(&["--first"], 1)]}
            }}),
            serde_json::json!({"data": {
                "kind": "delta",
                "delta": {
                    "fromRevision": 1,
                    "toRevision": 2,
                    "upserts": [schedule(&["--updated"], 2)],
                    "removedScheduleIds": []
                }
            }}),
            serde_json::json!({"data": {"id": INSTALLATION_ID, "status": "installed"}}),
            serde_json::json!({"data": [{
                "runId": RUN_ID,
                "attempt": 1,
                "appId": "demo-app",
                "version": "1.2.3",
                "args": ["--manual"],
                "requiresElevation": false
            }]}),
            serde_json::json!({"data": [{
                "runId": RUN_ID,
                "attempt": 1,
                "cancelRequestedAt": "2026-09-01T12:00:00+08:00"
            }]}),
            serde_json::json!({"data": {"id": RUN_ID, "status": "running"}}),
        ]));
        let client = ControlPlaneClient::new(
            ControlPlaneConfig::new("https://api.example.test/api/v1", DEVICE_ID).unwrap(),
            Arc::new(StaticCredentials(Some(format!("awd_{}", "d".repeat(43))))),
            transport.clone(),
        );

        assert_eq!(
            client
                .sync_agent_schedules(&agent, &AllowAuthorization)
                .unwrap(),
            ScheduleSyncOutcome::Snapshot {
                revision: 1,
                applied: true
            }
        );
        assert_eq!(
            client
                .sync_agent_schedules(&agent, &AllowAuthorization)
                .unwrap(),
            ScheduleSyncOutcome::Delta {
                from_revision: 1,
                to_revision: 2,
                applied: true
            }
        );
        client
            .report_installation(
                INSTALLATION_ID,
                &InstallationStatusReport {
                    status: ReportInstallationStatus::Installed,
                    error_code: None,
                },
            )
            .unwrap();
        assert_eq!(client.claim_runs(1).unwrap()[0].run_id, RUN_ID);
        assert_eq!(client.fetch_run_controls().unwrap()[0].attempt, 1);
        client
            .report_run(
                RUN_ID,
                &RunReport {
                    attempt: 1,
                    status: ReportRunStatus::Running,
                    result: None,
                    error_code: None,
                },
            )
            .unwrap();

        let requests = transport.requests.lock().unwrap();
        assert_eq!(requests.len(), 6);
        for request in requests.iter() {
            assert_eq!(
                request.url.origin().ascii_serialization(),
                "https://api.example.test"
            );
            assert_eq!(
                request.authorization,
                format!("Device awd_{}", "d".repeat(43))
            );
        }
        assert_eq!(requests[0].method, ControlPlaneMethod::Get);
        assert!(requests[0].url.query().is_none());
        assert_eq!(requests[1].url.query(), Some("revision=1"));
        assert_eq!(requests[2].body.as_ref().unwrap()["status"], "installed");
        assert_eq!(requests[3].body.as_ref().unwrap()["limit"], 1);
        assert_eq!(requests[4].method, ControlPlaneMethod::Get);
        assert_eq!(
            requests[4].url.path(),
            format!("/api/v1/devices/{DEVICE_ID}/runs/control")
        );
        assert_eq!(requests[5].body.as_ref().unwrap()["status"], "running");
        assert_eq!(agent.schedule_sync_state().unwrap().revision, 2);
    }

    #[test]
    fn configuration_and_missing_device_credentials_fail_closed() {
        assert!(ControlPlaneConfig::new("http://api.example.test/api/v1", DEVICE_ID).is_err());
        assert!(
            ControlPlaneConfig::new("https://user:pass@api.example.test/api/v1", DEVICE_ID)
                .is_err()
        );
        let transport = Arc::new(MockTransport::new(vec![]));
        let client = ControlPlaneClient::new(
            ControlPlaneConfig::new("http://127.0.0.1:3000/api/v1", DEVICE_ID).unwrap(),
            Arc::new(StaticCredentials(None)),
            transport.clone(),
        );
        assert!(matches!(
            client.fetch_schedule_sync(None),
            Err(AgentError::DeviceCredentialInvalid(_))
        ));
        assert!(transport.requests.lock().unwrap().is_empty());

        assert!(RunControl {
            run_id: RUN_ID.into(),
            attempt: 1,
            cancel_requested_at: "not-a-timestamp".into(),
        }
        .validate()
        .is_err());

        let credential = format!("awd_{}", "s".repeat(43));
        let persisted = serde_json::to_string(&PersistedControlPlaneConfig {
            api_base_url: "https://api.example.test/api/v1".into(),
            device_id: DEVICE_ID.into(),
        })
        .unwrap();
        assert!(!persisted.contains(&credential));
    }
}
