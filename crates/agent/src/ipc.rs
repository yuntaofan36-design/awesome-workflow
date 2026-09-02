use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use interprocess::local_socket::{prelude::*, GenericFilePath, GenericNamespaced, ListenerOptions};
use rand::RngCore;
use reqwest::{blocking::Client, redirect::Policy, Method};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Digest;
use subtle::ConstantTimeEq;
use url::Url;
use uuid::Uuid;

use crate::manifest::HttpMethod;
use crate::{
    clear_device_registration, load_control_plane_config, persist_device_registration, Agent,
    AgentError, AgentMethod, AgentResult, AgentSnapshot, AppletManifest, ArtifactAttestation,
    ArtifactDownloader, Capability, ControlPlaneClient, ControlPlaneConfig, ControlPlaneTransport,
    DeviceCredential, DeviceCredentialProvider, DeviceEnrollmentPreparation, InstallRequest,
    InstallationSyncResponse, InstalledApplet, NativeDeviceCredentialStore, ReportRunStatus,
    ReqwestArtifactDownloader, ReqwestControlPlaneTransport, RpcEnvelope, RunOutcome, RunReport,
    ScheduleSnapshot, SignatureVerifier, RPC_PROTOCOL_VERSION,
};

pub const AGENT_PROTOCOL_VERSION: u16 = 1;
const MAX_MESSAGE_BYTES: u64 = 1024 * 1024;
const CONTROL_PLANE_INTERVAL: Duration = Duration::from_secs(5);
const RUN_CLAIM_LIMIT: u8 = 8;
const OUTBOX_RETRY_BASE_MS: u64 = 5_000;
const OUTBOX_RETRY_MAX_MS: u64 = 5 * 60_000;
const MAX_BROKER_FILE_BYTES: usize = 1024 * 1024;
const MAX_BROKER_HTTP_BYTES: usize = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES: usize = 256 * 1024;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct AgentEndpoint {
    data_root: PathBuf,
    management_name: String,
    task_name: String,
    namespaced: bool,
}

impl AgentEndpoint {
    pub fn from_data_root(data_root: &Path) -> AgentResult<Self> {
        let data_root = data_root.to_path_buf();
        fs::create_dir_all(&data_root)?;
        restrict_directory(&data_root)?;
        let hash = hex::encode(sha2::Sha256::digest(data_root.to_string_lossy().as_bytes()));
        #[cfg(windows)]
        let (management_name, task_name, namespaced) = (
            format!("awesome-workflow-agent-{}", &hash[..20]),
            format!("awesome-workflow-task-{}", &hash[..20]),
            true,
        );
        #[cfg(not(windows))]
        let (management_name, task_name, namespaced) = (
            data_root.join("agent.sock").to_string_lossy().into_owned(),
            data_root.join("task.sock").to_string_lossy().into_owned(),
            false,
        );
        Ok(Self {
            data_root,
            management_name,
            task_name,
            namespaced,
        })
    }

    fn local_name(&self) -> AgentResult<interprocess::local_socket::Name<'static>> {
        self.parse_local_name(&self.management_name)
    }

    fn task_local_name(&self) -> AgentResult<interprocess::local_socket::Name<'static>> {
        self.parse_local_name(&self.task_name)
    }

    fn parse_local_name(
        &self,
        value: &str,
    ) -> AgentResult<interprocess::local_socket::Name<'static>> {
        if self.namespaced {
            value
                .to_owned()
                .to_ns_name::<GenericNamespaced>()
                .map_err(|error| AgentError::State(format!("invalid Agent pipe name: {error}")))
        } else {
            value
                .to_owned()
                .to_fs_name::<GenericFilePath>()
                .map_err(|error| AgentError::State(format!("invalid Agent socket path: {error}")))
        }
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub fn task_rpc_endpoint(&self) -> String {
        if self.namespaced {
            format!(r"\\.\pipe\{}", self.task_name)
        } else {
            self.task_name.clone()
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ManagementCommand {
    Snapshot,
    PrepareDeviceEnrollment,
    CompleteDeviceEnrollment {
        api_base_url: String,
        device_id: String,
        credential: String,
    },
    ValidateDevelopmentApplet {
        path: PathBuf,
    },
    RegisterDevelopmentApplet {
        path: PathBuf,
    },
    InstallSignedPackage {
        package_path: PathBuf,
        attestation: ArtifactAttestation,
        manifest: Box<AppletManifest>,
    },
    UninstallApplet {
        app_id: String,
        version: String,
    },
    RunApplet {
        app_id: String,
        version: Option<String>,
        #[serde(default)]
        args: Vec<String>,
    },
    StopTask {
        task_id: String,
    },
    ReadTaskLog {
        task_id: String,
    },
    ApplyScheduleSnapshot {
        snapshot: ScheduleSnapshot,
    },
    MarkScheduleOffline,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentRequest {
    protocol_version: u16,
    request_id: String,
    bootstrap_secret: String,
    command: ManagementCommand,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentResponse {
    protocol_version: u16,
    request_id: String,
    ok: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRpcResponse {
    protocol_version: u16,
    ok: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TaskLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskLogPayload {
    level: TaskLogLevel,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskProgressPayload {
    value: f64,
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceReadPayload {
    path: PathBuf,
    #[serde(default = "default_text_encoding")]
    encoding: BrokerEncoding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceWritePayload {
    path: PathBuf,
    data: String,
    #[serde(default = "default_text_encoding")]
    encoding: BrokerEncoding,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum BrokerEncoding {
    Utf8,
    Base64,
}

fn default_text_encoding() -> BrokerEncoding {
    BrokerEncoding::Utf8
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HttpRequestPayload {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotificationPayload {
    title: String,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessSpawnPayload {
    executable: PathBuf,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Clone)]
pub struct AgentClient {
    endpoint: AgentEndpoint,
    bootstrap_secret: String,
}

impl AgentClient {
    pub fn for_data_root(data_root: &Path) -> AgentResult<Self> {
        let endpoint = AgentEndpoint::from_data_root(data_root)?;
        let bootstrap_secret = ensure_bootstrap_secret(endpoint.data_root())?;
        Ok(Self {
            endpoint,
            bootstrap_secret,
        })
    }

    pub fn snapshot(&self) -> AgentResult<AgentSnapshot> {
        self.call(ManagementCommand::Snapshot)
    }
    pub fn prepare_device_enrollment(&self) -> AgentResult<DeviceEnrollmentPreparation> {
        self.call(ManagementCommand::PrepareDeviceEnrollment)
    }
    pub fn complete_device_enrollment(
        &self,
        api_base_url: String,
        device_id: String,
        credential: String,
    ) -> AgentResult<()> {
        self.call(ManagementCommand::CompleteDeviceEnrollment {
            api_base_url,
            device_id,
            credential,
        })
    }
    pub fn validate_development_applet(&self, path: PathBuf) -> AgentResult<AppletManifest> {
        self.call(ManagementCommand::ValidateDevelopmentApplet { path })
    }
    pub fn register_development_applet(&self, path: PathBuf) -> AgentResult<InstalledApplet> {
        self.call(ManagementCommand::RegisterDevelopmentApplet { path })
    }
    pub fn install_signed_package(
        &self,
        package_path: PathBuf,
        attestation: ArtifactAttestation,
        manifest: AppletManifest,
    ) -> AgentResult<InstalledApplet> {
        self.call(ManagementCommand::InstallSignedPackage {
            package_path,
            attestation,
            manifest: Box::new(manifest),
        })
    }
    pub fn uninstall_applet(&self, app_id: String, version: String) -> AgentResult<()> {
        self.call(ManagementCommand::UninstallApplet { app_id, version })
    }
    pub fn run_applet(
        &self,
        app_id: String,
        version: Option<String>,
        args: Vec<String>,
    ) -> AgentResult<RunOutcome> {
        self.call(ManagementCommand::RunApplet {
            app_id,
            version,
            args,
        })
    }
    pub fn stop_task(&self, task_id: String) -> AgentResult<()> {
        self.call(ManagementCommand::StopTask { task_id })
    }
    pub fn read_task_log(&self, task_id: String) -> AgentResult<String> {
        self.call(ManagementCommand::ReadTaskLog { task_id })
    }
    pub fn apply_schedule_snapshot(&self, snapshot: ScheduleSnapshot) -> AgentResult<bool> {
        self.call(ManagementCommand::ApplyScheduleSnapshot { snapshot })
    }
    pub fn mark_schedule_offline(&self) -> AgentResult<()> {
        self.call(ManagementCommand::MarkScheduleOffline)
    }

    fn call<TResult: DeserializeOwned>(&self, command: ManagementCommand) -> AgentResult<TResult> {
        let request_id = Uuid::new_v4().to_string();
        let request = AgentRequest {
            protocol_version: AGENT_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            bootstrap_secret: self.bootstrap_secret.clone(),
            command,
        };
        let name = self.endpoint.local_name()?;
        let mut stream = interprocess::local_socket::Stream::connect(name)
            .map_err(|error| AgentError::State(format!("connect Agent: {error}")))?;
        let mut encoded = serde_json::to_vec(&request)?;
        encoded.push(b'\n');
        stream.write_all(&encoded)?;
        stream.flush()?;
        let mut response_line = String::new();
        BufReader::new(stream)
            .take(MAX_MESSAGE_BYTES)
            .read_line(&mut response_line)?;
        let response: AgentResponse = serde_json::from_str(&response_line)?;
        if response.protocol_version != AGENT_PROTOCOL_VERSION || response.request_id != request_id
        {
            return Err(AgentError::AccessDenied(
                "Agent response scope mismatch".into(),
            ));
        }
        if !response.ok {
            return Err(AgentError::State(
                response
                    .error
                    .unwrap_or_else(|| "Agent request failed".into()),
            ));
        }
        serde_json::from_value(response.data.unwrap_or(serde_json::Value::Null)).map_err(Into::into)
    }
}

pub fn run_agent_daemon(
    endpoint: AgentEndpoint,
    agent: Arc<Agent>,
    verifier: Arc<dyn SignatureVerifier>,
) -> AgentResult<()> {
    let bootstrap_secret = ensure_bootstrap_secret(endpoint.data_root())?;
    #[cfg(not(windows))]
    if !endpoint.namespaced {
        let _ = fs::remove_file(&endpoint.management_name);
        let _ = fs::remove_file(&endpoint.task_name);
    }
    let name = endpoint.local_name()?;
    let listener = listener_options(name)?
        .create_sync()
        .map_err(|error| AgentError::State(format!("listen for Agent IPC: {error}")))?;
    let task_listener = listener_options(endpoint.task_local_name()?)?
        .create_sync()
        .map_err(|error| AgentError::State(format!("listen for task RPC: {error}")))?;
    restrict_socket(&endpoint.management_name)?;
    restrict_socket(&endpoint.task_name)?;

    let task_agent = agent.clone();
    thread::spawn(move || serve_task_connections(task_listener, task_agent));

    let background_agent = agent.clone();
    let background_data_root = endpoint.data_root().to_path_buf();
    let background_verifier = verifier.clone();
    thread::spawn(move || {
        run_background_loop(background_data_root, background_agent, background_verifier)
    });

    for connection in listener.incoming() {
        match connection {
            Ok(connection) => {
                let connection_agent = agent.clone();
                let connection_verifier = verifier.clone();
                let connection_secret = bootstrap_secret.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(
                        connection,
                        &connection_secret,
                        &connection_agent,
                        connection_verifier.as_ref(),
                    ) {
                        eprintln!("Agent IPC request rejected: {error}");
                    }
                });
            }
            Err(error) => eprintln!("Agent IPC accept failed: {error}"),
        }
    }
    Ok(())
}

fn run_background_loop(
    data_root: PathBuf,
    agent: Arc<Agent>,
    verifier: Arc<dyn SignatureVerifier>,
) {
    let transport: Arc<dyn ControlPlaneTransport> = loop {
        match ReqwestControlPlaneTransport::new() {
            Ok(transport) => break Arc::new(transport),
            Err(error) => {
                eprintln!("Agent control-plane transport unavailable: {error}");
                thread::sleep(CONTROL_PLANE_INTERVAL);
            }
        }
    };
    let downloader: Arc<dyn ArtifactDownloader> = loop {
        match ReqwestArtifactDownloader::new() {
            Ok(downloader) => break Arc::new(downloader),
            Err(error) => {
                eprintln!("Agent artifact transport unavailable: {error}");
                thread::sleep(CONTROL_PLANE_INTERVAL);
            }
        }
    };
    let credentials: Arc<dyn DeviceCredentialProvider> = Arc::new(NativeDeviceCredentialStore);
    let mut last_control_cycle: Option<Instant> = None;

    loop {
        let config_result = load_control_plane_config(&data_root);
        if let Ok(Some(_)) = &config_result {
            run_due_schedules(&agent);
        }

        if last_control_cycle.is_none_or(|last| last.elapsed() >= CONTROL_PLANE_INTERVAL) {
            match config_result {
                Ok(Some(config)) => {
                    let device_id = config.device_id();
                    let client =
                        ControlPlaneClient::new(config, credentials.clone(), transport.clone());
                    if let Err(error) = run_control_plane_cycle(
                        &agent,
                        &client,
                        downloader.as_ref(),
                        verifier.as_ref(),
                    ) {
                        if invalidates_device_registration(&error) {
                            if let Err(clear_error) =
                                clear_device_registration(&data_root, device_id)
                            {
                                eprintln!(
                                    "Agent could not clear rejected device registration: {clear_error}"
                                );
                            }
                        } else {
                            eprintln!("Agent control-plane cycle failed: {error}");
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => eprintln!("Agent device configuration is invalid: {error}"),
            }
            last_control_cycle = Some(Instant::now());
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn run_due_schedules(agent: &Agent) {
    for schedule in agent
        .claim_due_schedules(crate::now_unix_ms())
        .unwrap_or_default()
    {
        let requires_foreground = agent
            .run_requires_foreground(&schedule.app_id, schedule.version.as_deref())
            .unwrap_or(true);
        if !requires_foreground {
            let _ = agent.run(&schedule.app_id, schedule.version.as_deref(), schedule.args);
        }
    }
}

fn run_control_plane_cycle(
    agent: &Agent,
    client: &ControlPlaneClient,
    downloader: &dyn ArtifactDownloader,
    verifier: &dyn SignatureVerifier,
) -> AgentResult<()> {
    let mut first_error = None;

    let installation_reports_flushed = capture_cycle_result(
        flush_installation_report_outbox(agent, client),
        &mut first_error,
    )?
    .unwrap_or(false);
    if installation_reports_flushed {
        let local_revision = agent.installation_sync_revision()?;
        if let Some(InstallationSyncResponse::Snapshot { snapshot }) = capture_cycle_result(
            client.fetch_installation_sync(Some(local_revision)),
            &mut first_error,
        )? {
            let _ = capture_cycle_result(
                agent.apply_installation_snapshot(&snapshot, downloader, verifier),
                &mut first_error,
            )?;
        }
        let _ = capture_cycle_result(
            flush_installation_report_outbox(agent, client),
            &mut first_error,
        )?;
    }

    if let Some(controls) = capture_cycle_result(client.fetch_run_controls(), &mut first_error)? {
        let _ = capture_cycle_result(agent.apply_run_controls(&controls), &mut first_error)?;
    }
    let _ = capture_cycle_result(enqueue_completed_run_reports(agent), &mut first_error)?;
    let _ = capture_cycle_result(process_pending_remote_runs(agent), &mut first_error)?;

    let outbox_flushed =
        capture_cycle_result(flush_run_report_outbox(agent, client), &mut first_error)?
            .unwrap_or(false);
    if outbox_flushed {
        if let Some(claims) =
            capture_cycle_result(client.claim_runs(RUN_CLAIM_LIMIT), &mut first_error)?
        {
            for claim in claims {
                let _ = capture_cycle_result(agent.record_remote_claim(&claim), &mut first_error)?;
            }
        }
        let _ = capture_cycle_result(process_pending_remote_runs(agent), &mut first_error)?;
        let _ = capture_cycle_result(flush_run_report_outbox(agent, client), &mut first_error)?;
    }
    let _ = capture_cycle_result(client.sync_agent_schedules(agent), &mut first_error)?;

    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn capture_cycle_result<T>(
    result: AgentResult<T>,
    first_error: &mut Option<AgentError>,
) -> AgentResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if invalidates_device_registration(&error) => Err(error),
        Err(error) => {
            if first_error.is_none() {
                *first_error = Some(error);
            }
            Ok(None)
        }
    }
}

fn process_pending_remote_runs(agent: &Agent) -> AgentResult<()> {
    for remote in agent.pending_remote_runs()? {
        if remote.requires_elevation {
            agent.enqueue_run_report(
                &remote.run_id,
                &RunReport {
                    attempt: remote.attempt,
                    status: ReportRunStatus::NeedsUserApproval,
                    result: None,
                    error_code: Some("elevation_required".into()),
                },
            )?;
            continue;
        }

        match agent.run_requires_foreground(&remote.app_id, Some(&remote.version)) {
            Ok(true) => {
                agent.enqueue_run_report(
                    &remote.run_id,
                    &RunReport {
                        attempt: remote.attempt,
                        status: ReportRunStatus::NeedsUserApproval,
                        result: None,
                        error_code: Some("foreground_required".into()),
                    },
                )?;
                continue;
            }
            Ok(false) => {}
            Err(_) => {
                agent.enqueue_run_report(
                    &remote.run_id,
                    &RunReport {
                        attempt: remote.attempt,
                        status: ReportRunStatus::Failed,
                        result: None,
                        error_code: Some("application_unavailable".into()),
                    },
                )?;
                continue;
            }
        }

        match agent.run(&remote.app_id, Some(&remote.version), remote.args) {
            Ok(RunOutcome::Process { task, .. }) => {
                if let Err(error) = agent.bind_remote_task_and_enqueue_running(
                    &remote.run_id,
                    remote.attempt,
                    &task.task_id,
                ) {
                    let _ = agent.stop(&task.task_id);
                    return Err(error);
                }
            }
            Ok(RunOutcome::WebUi { task, .. }) => {
                let _ = agent.stop(&task.task_id);
                agent.enqueue_run_report(
                    &remote.run_id,
                    &RunReport {
                        attempt: remote.attempt,
                        status: ReportRunStatus::NeedsUserApproval,
                        result: None,
                        error_code: Some("foreground_required".into()),
                    },
                )?;
            }
            Err(_) => {
                agent.enqueue_run_report(
                    &remote.run_id,
                    &RunReport {
                        attempt: remote.attempt,
                        status: ReportRunStatus::Failed,
                        result: None,
                        error_code: Some("agent_run_failed".into()),
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn enqueue_completed_run_reports(agent: &Agent) -> AgentResult<()> {
    for completion in agent.completed_remote_runs()? {
        let (status, error_code) = match completion.task_status.as_str() {
            "succeeded" => (ReportRunStatus::Succeeded, None),
            "failed" => (ReportRunStatus::Failed, Some("runner_failed".into())),
            "stopped" => (ReportRunStatus::Failed, Some("task_stopped".into())),
            _ => continue,
        };
        agent.enqueue_run_report(
            &completion.run_id,
            &RunReport {
                attempt: completion.attempt,
                status,
                result: None,
                error_code,
            },
        )?;
    }
    Ok(())
}

fn flush_run_report_outbox(agent: &Agent, client: &ControlPlaneClient) -> AgentResult<bool> {
    for entry in agent.due_run_reports()? {
        match client.report_run(&entry.run_id, &entry.report) {
            Ok(()) => agent.acknowledge_run_report(entry.outbox_id)?,
            Err(error) => {
                if invalidates_device_registration(&error) {
                    return Err(error);
                }
                let exponent = entry.delivery_attempts.min(6);
                let delay = OUTBOX_RETRY_BASE_MS
                    .saturating_mul(1_u64 << exponent)
                    .min(OUTBOX_RETRY_MAX_MS);
                agent.retry_run_report(
                    entry.outbox_id,
                    crate::now_unix_ms().saturating_add(delay),
                )?;
                return Err(error);
            }
        }
    }
    Ok(true)
}

fn flush_installation_report_outbox(
    agent: &Agent,
    client: &ControlPlaneClient,
) -> AgentResult<bool> {
    for entry in agent.due_installation_reports()? {
        match client.report_installation(&entry.installation_id, &entry.report) {
            Ok(()) => agent.acknowledge_installation_report(entry.outbox_id)?,
            Err(error) => {
                if invalidates_device_registration(&error) {
                    return Err(error);
                }
                let exponent = entry.delivery_attempts.min(6);
                let delay = OUTBOX_RETRY_BASE_MS
                    .saturating_mul(1_u64 << exponent)
                    .min(OUTBOX_RETRY_MAX_MS);
                agent.retry_installation_report(
                    entry.outbox_id,
                    crate::now_unix_ms().saturating_add(delay),
                )?;
                return Err(error);
            }
        }
    }
    Ok(true)
}

fn invalidates_device_registration(error: &AgentError) -> bool {
    matches!(
        error,
        AgentError::ControlPlaneRejected(401 | 403) | AgentError::DeviceCredentialInvalid(_)
    )
}

fn serve_task_connections(listener: interprocess::local_socket::Listener, agent: Arc<Agent>) {
    for connection in listener.incoming() {
        match connection {
            Ok(connection) => {
                let connection_agent = agent.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_task_connection(connection, &connection_agent) {
                        eprintln!("task RPC request rejected: {error}");
                    }
                });
            }
            Err(error) => eprintln!("task RPC accept failed: {error}"),
        }
    }
}

fn handle_task_connection(
    mut stream: interprocess::local_socket::Stream,
    agent: &Agent,
) -> AgentResult<()> {
    set_stream_timeouts(&stream)?;
    let mut request_line = String::new();
    BufReader::new(&stream)
        .take(MAX_MESSAGE_BYTES)
        .read_line(&mut request_line)?;
    let response = match serde_json::from_str::<RpcEnvelope<serde_json::Value>>(&request_line) {
        Ok(request) => dispatch_task_rpc(request, agent),
        Err(error) => task_error(AgentError::AccessDenied(format!(
            "invalid task RPC envelope: {error}"
        ))),
    };
    let mut encoded = serde_json::to_vec(&response)?;
    encoded.push(b'\n');
    stream.write_all(&encoded)?;
    stream.flush()?;
    Ok(())
}

pub(crate) fn dispatch_task_rpc(
    request: RpcEnvelope<serde_json::Value>,
    agent: &Agent,
) -> TaskRpcResponse {
    dispatch_task_rpc_with_arguments(request, agent, None)
}

pub(crate) fn dispatch_task_rpc_with_arguments(
    request: RpcEnvelope<serde_json::Value>,
    agent: &Agent,
    arguments: Option<&[String]>,
) -> TaskRpcResponse {
    let result = agent.rpc_capabilities(&request).and_then(|capabilities| {
        let app_id = request.app_id;
        let task_id = request.task_id;
        match request.method {
            AgentMethod::ContextRead => {
                let payload = request.payload.as_object().ok_or_else(|| {
                    AgentError::AccessDenied("context-read payload must be an object".into())
                })?;
                if !payload.is_empty() {
                    return Err(AgentError::AccessDenied(
                        "context-read payload must be empty".into(),
                    ));
                }
                let mut context = agent.task_context(&app_id, &task_id)?;
                if let Some(arguments) = arguments {
                    context.arguments = arguments.to_vec();
                }
                serde_json::to_value(context).map_err(Into::into)
            }
            AgentMethod::TaskLogAppend => {
                let payload: TaskLogPayload = serde_json::from_value(request.payload)?;
                if payload.message.is_empty() {
                    return Err(AgentError::AccessDenied("log message is empty".into()));
                }
                agent.append_task_rpc_event(
                    &task_id,
                    &serde_json::json!({
                        "type": "log",
                        "level": payload.level,
                        "message": payload.message,
                    }),
                )?;
                Ok(serde_json::Value::Null)
            }
            AgentMethod::TaskProgress => {
                let payload: TaskProgressPayload = serde_json::from_value(request.payload)?;
                if !payload.value.is_finite() || !(0.0..=1.0).contains(&payload.value) {
                    return Err(AgentError::AccessDenied(
                        "task progress must be between 0 and 1".into(),
                    ));
                }
                agent.append_task_rpc_event(
                    &task_id,
                    &serde_json::json!({
                        "type": "progress",
                        "value": payload.value,
                        "label": payload.label,
                    }),
                )?;
                Ok(serde_json::Value::Null)
            }
            AgentMethod::WorkspaceRead => broker_workspace_read(
                agent,
                &app_id,
                &task_id,
                serde_json::from_value(request.payload)?,
            ),
            AgentMethod::WorkspaceWrite => broker_workspace_write(
                agent,
                &app_id,
                &task_id,
                serde_json::from_value(request.payload)?,
            ),
            AgentMethod::HttpRequest => {
                broker_http_request(&capabilities, serde_json::from_value(request.payload)?)
            }
            AgentMethod::NotificationShow => {
                broker_notification(serde_json::from_value(request.payload)?)
            }
            AgentMethod::ProcessSpawn => broker_process_spawn(
                agent,
                &app_id,
                &task_id,
                &capabilities,
                serde_json::from_value(request.payload)?,
            ),
        }
    });
    match result {
        Ok(data) => TaskRpcResponse {
            protocol_version: RPC_PROTOCOL_VERSION,
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => task_error(error),
    }
}

fn broker_workspace_read(
    agent: &Agent,
    app_id: &str,
    task_id: &str,
    payload: WorkspaceReadPayload,
) -> AgentResult<serde_json::Value> {
    let context = agent.task_context(app_id, task_id)?;
    let path = resolve_broker_path(&context.work_directory, &payload.path, true)?;
    let metadata = path.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_BROKER_FILE_BYTES as u64 {
        return Err(AgentError::AccessDenied(
            "workspace read requires a regular file within the size limit".into(),
        ));
    }
    let data = fs::read(path)?;
    let encoded = match payload.encoding {
        BrokerEncoding::Utf8 => String::from_utf8(data)
            .map_err(|_| AgentError::AccessDenied("workspace file is not valid UTF-8".into()))?,
        BrokerEncoding::Base64 => base64::engine::general_purpose::STANDARD.encode(data),
    };
    Ok(serde_json::json!({
        "data": encoded,
        "encoding": payload.encoding,
    }))
}

fn broker_workspace_write(
    agent: &Agent,
    app_id: &str,
    task_id: &str,
    payload: WorkspaceWritePayload,
) -> AgentResult<serde_json::Value> {
    let data = match payload.encoding {
        BrokerEncoding::Utf8 => payload.data.into_bytes(),
        BrokerEncoding::Base64 => base64::engine::general_purpose::STANDARD
            .decode(payload.data)
            .map_err(|_| AgentError::AccessDenied("workspace data is not valid base64".into()))?,
    };
    if data.len() > MAX_BROKER_FILE_BYTES {
        return Err(AgentError::AccessDenied(
            "workspace write exceeds the size limit".into(),
        ));
    }
    let context = agent.task_context(app_id, task_id)?;
    let path = resolve_broker_path(&context.work_directory, &payload.path, false)?;
    if path.exists() {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AgentError::AccessDenied(
                "workspace write target must be a regular file".into(),
            ));
        }
    }
    fs::write(path, data)?;
    Ok(serde_json::Value::Null)
}

fn resolve_broker_path(root: &Path, relative: &Path, must_exist: bool) -> AgentResult<PathBuf> {
    validate_broker_relative_path(relative)?;
    let root = root.canonicalize()?;
    let candidate = root.join(relative);
    if must_exist || candidate.exists() {
        let candidate = candidate.canonicalize()?;
        if !candidate.starts_with(&root) {
            return Err(AgentError::PathEscape(relative.display().to_string()));
        }
        return Ok(candidate);
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| AgentError::PathEscape(relative.display().to_string()))?
        .canonicalize()?;
    if !parent.starts_with(&root) {
        return Err(AgentError::PathEscape(relative.display().to_string()));
    }
    Ok(candidate)
}

fn validate_broker_relative_path(path: &Path) -> AgentResult<()> {
    use std::path::Component;

    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(AgentError::PathEscape(path.display().to_string()));
    }
    Ok(())
}

fn broker_http_request(
    capabilities: &[Capability],
    payload: HttpRequestPayload,
) -> AgentResult<serde_json::Value> {
    let (manifest_method, request_method) = parse_http_method(payload.method.as_deref())?;
    let url = validate_http_url(capabilities, manifest_method, &payload.url)?;
    let host = url
        .host_str()
        .ok_or_else(|| AgentError::AccessDenied("HTTP broker URL has no host".into()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AgentError::AccessDenied("HTTP broker URL has no port".into()))?;
    let addresses = resolve_public_addresses(host, port)?;
    let body = payload
        .body_base64
        .map(|value| {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(|_| AgentError::AccessDenied("HTTP body is not valid base64".into()))
        })
        .transpose()?;
    if body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_BROKER_HTTP_BYTES)
    {
        return Err(AgentError::AccessDenied(
            "HTTP request body exceeds the size limit".into(),
        ));
    }
    if manifest_method == HttpMethod::Get && body.is_some() {
        return Err(AgentError::AccessDenied(
            "GET requests cannot include a brokered body".into(),
        ));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|error| AgentError::State(format!("build HTTP broker: {error}")))?;
    let mut request = client.request(request_method, url);
    for (name, value) in payload.headers {
        validate_broker_header(&name)?;
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let mut response = request
        .send()
        .map_err(|error| AgentError::State(format!("HTTP broker request failed: {error}")))?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    let mut header_bytes = 0_usize;
    for (name, value) in response.headers() {
        if name.as_str().eq_ignore_ascii_case("set-cookie") {
            continue;
        }
        let value = value
            .to_str()
            .map_err(|_| AgentError::AccessDenied("HTTP response header is not text".into()))?;
        header_bytes = header_bytes.saturating_add(name.as_str().len() + value.len());
        if header_bytes > 32 * 1024 {
            return Err(AgentError::AccessDenied(
                "HTTP response headers exceed the size limit".into(),
            ));
        }
        headers.insert(name.as_str().to_owned(), value.to_owned());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take((MAX_BROKER_HTTP_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BROKER_HTTP_BYTES {
        return Err(AgentError::AccessDenied(
            "HTTP response body exceeds the size limit".into(),
        ));
    }
    Ok(serde_json::json!({
        "status": status,
        "headers": headers,
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

fn parse_http_method(value: Option<&str>) -> AgentResult<(HttpMethod, Method)> {
    match value.unwrap_or("GET") {
        "GET" => Ok((HttpMethod::Get, Method::GET)),
        "POST" => Ok((HttpMethod::Post, Method::POST)),
        "PUT" => Ok((HttpMethod::Put, Method::PUT)),
        "PATCH" => Ok((HttpMethod::Patch, Method::PATCH)),
        "DELETE" => Ok((HttpMethod::Delete, Method::DELETE)),
        _ => Err(AgentError::AccessDenied(
            "HTTP broker method is not supported".into(),
        )),
    }
}

fn validate_http_url(
    capabilities: &[Capability],
    method: HttpMethod,
    value: &str,
) -> AgentResult<Url> {
    let url = Url::parse(value)
        .map_err(|_| AgentError::AccessDenied("HTTP broker URL is invalid".into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(AgentError::AccessDenied(
            "HTTP broker requires an HTTPS URL without credentials or fragment".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AgentError::AccessDenied("HTTP broker URL has no host".into()))?;
    if is_local_hostname(host) || host.parse::<IpAddr>().is_ok() {
        return Err(AgentError::AccessDenied(
            "HTTP broker rejects local and literal-IP destinations".into(),
        ));
    }
    let granted = capabilities.iter().any(|capability| match capability {
        Capability::Network { domains, methods } if methods.contains(&method) => domains
            .iter()
            .any(|pattern| domain_pattern_matches(pattern, host)),
        _ => false,
    });
    if !granted {
        return Err(AgentError::AccessDenied(
            "HTTP destination or method is outside the manifest grant".into(),
        ));
    }
    Ok(url)
}

fn domain_pattern_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.trim_end_matches('.').to_ascii_lowercase();
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if let Some(suffix) = pattern.strip_prefix("*.") {
        host.len() > suffix.len()
            && host.ends_with(suffix)
            && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
    } else {
        host == pattern
    }
}

fn is_local_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
}

fn resolve_public_addresses(host: &str, port: u16) -> AgentResult<Vec<SocketAddr>> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| AgentError::State(format!("resolve HTTP broker host: {error}")))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(AgentError::AccessDenied(
            "HTTP broker destination resolved to a non-public address".into(),
        ));
    }
    Ok(addresses)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

fn validate_broker_header(name: &str) -> AgentResult<()> {
    let name = name.to_ascii_lowercase();
    let forbidden = [
        "authorization",
        "cookie",
        "host",
        "connection",
        "content-length",
        "proxy-authorization",
        "transfer-encoding",
        "upgrade",
    ];
    if forbidden.contains(&name.as_str()) || name.starts_with("proxy-") || name.starts_with("sec-")
    {
        return Err(AgentError::AccessDenied(
            "HTTP broker header is not allowed".into(),
        ));
    }
    reqwest::header::HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| AgentError::AccessDenied("HTTP broker header name is invalid".into()))?;
    Ok(())
}

fn broker_notification(payload: NotificationPayload) -> AgentResult<serde_json::Value> {
    let title = payload.title.trim();
    let body = payload.body.unwrap_or_default();
    if title.is_empty() || title.len() > 200 || body.len() > 2_000 {
        return Err(AgentError::AccessDenied(
            "notification title or body is outside the size limit".into(),
        ));
    }
    show_native_notification(title, &body)?;
    Ok(serde_json::Value::Null)
}

#[cfg(windows)]
fn show_native_notification(title: &str, body: &str) -> AgentResult<()> {
    const SCRIPT: &str = r#"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02; $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template); $nodes = $xml.GetElementsByTagName('text'); $nodes.Item(0).AppendChild($xml.CreateTextNode($env:AW_NOTIFICATION_TITLE)) > $null; $nodes.Item(1).AppendChild($xml.CreateTextNode($env:AW_NOTIFICATION_BODY)) > $null; $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Awesome Workflow').Show($toast)"#;
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env_clear()
        .envs(filtered_child_environment(std::env::vars_os()))
        .env("AW_NOTIFICATION_TITLE", title)
        .env("AW_NOTIFICATION_BODY", body)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(AgentError::State(
            "native notification command failed".into(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_native_notification(title: &str, body: &str) -> AgentResult<()> {
    let status = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            "--",
            title,
            body,
        ])
        .env_clear()
        .envs(filtered_child_environment(std::env::vars_os()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(AgentError::State(
            "native notification command failed".into(),
        ));
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_native_notification(_title: &str, _body: &str) -> AgentResult<()> {
    Err(AgentError::UnsupportedTarget(
        "native notifications require Windows or macOS".into(),
    ))
}

fn broker_process_spawn(
    agent: &Agent,
    app_id: &str,
    task_id: &str,
    capabilities: &[Capability],
    payload: ProcessSpawnPayload,
) -> AgentResult<serde_json::Value> {
    validate_broker_relative_path(&payload.executable)?;
    if payload.args.len() > 64 || payload.args.iter().any(|value| value.len() > 4_096) {
        return Err(AgentError::AccessDenied(
            "subprocess arguments exceed the broker limit".into(),
        ));
    }
    let granted = capabilities.iter().any(|capability| match capability {
        Capability::Subprocess { executables } => executables.contains(&payload.executable),
        _ => false,
    });
    if !granted {
        return Err(AgentError::AccessDenied(
            "subprocess executable is outside the manifest grant".into(),
        ));
    }
    let package_directory = agent.task_package_directory(app_id, task_id)?;
    let executable = crate::resolve_contained(&package_directory, &payload.executable)?;
    if !executable.is_file() {
        return Err(AgentError::AccessDenied(
            "subprocess executable is not a regular file".into(),
        ));
    }
    let context = agent.task_context(app_id, task_id)?;
    let mut child = Command::new(executable)
        .args(payload.args)
        .current_dir(&context.work_directory)
        .env_clear()
        .envs(filtered_child_environment(std::env::vars_os()))
        .env("AW_PROTOCOL_VERSION", RPC_PROTOCOL_VERSION.to_string())
        .env("AW_APP_ID", app_id)
        .env("AW_TASK_ID", task_id)
        .env("AW_WORK_DIRECTORY", &context.work_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AgentError::State("capture subprocess stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AgentError::State("capture subprocess stderr".into()))?;
    let stdout_reader = thread::spawn(move || read_bounded_output(stdout));
    let stderr_reader = thread::spawn(move || read_bounded_output(stderr));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= PROCESS_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AgentError::AccessDenied(
                "subprocess exceeded the broker timeout".into(),
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| AgentError::State("subprocess stdout reader failed".into()))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| AgentError::State("subprocess stderr reader failed".into()))??;
    Ok(serde_json::json!({
        "exitCode": status.code().unwrap_or(1),
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
    }))
}

fn read_bounded_output(mut stream: impl Read) -> AgentResult<Vec<u8>> {
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = MAX_PROCESS_OUTPUT_BYTES.saturating_sub(captured.len());
        captured.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(captured)
}

fn filtered_child_environment(
    source: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let allowed = [
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    source
        .into_iter()
        .filter(|(key, _)| key.to_str().is_some_and(|value| allowed.contains(value)))
        .collect()
}

fn task_error(error: AgentError) -> TaskRpcResponse {
    TaskRpcResponse {
        protocol_version: RPC_PROTOCOL_VERSION,
        ok: false,
        data: None,
        error: Some(error.to_string()),
    }
}

#[cfg(windows)]
fn listener_options(
    name: interprocess::local_socket::Name<'static>,
) -> AgentResult<ListenerOptions<'static>> {
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };
    use widestring::U16CString;

    // OW means the object owner (the user launching this per-user Agent); SYSTEM is
    // retained for OS lifecycle operations. No broad Users/Everyone ACE is present.
    let sddl = U16CString::from_str("D:P(A;;GA;;;OW)(A;;GA;;;SY)")
        .map_err(|error| AgentError::State(format!("build Agent pipe DACL: {error}")))?;
    let descriptor = SecurityDescriptor::deserialize(&sddl)
        .map_err(|error| AgentError::State(format!("parse Agent pipe DACL: {error}")))?;
    Ok(ListenerOptions::new()
        .name(name)
        .security_descriptor(descriptor))
}

#[cfg(not(windows))]
fn listener_options(
    name: interprocess::local_socket::Name<'static>,
) -> AgentResult<ListenerOptions<'static>> {
    Ok(ListenerOptions::new().name(name))
}

fn handle_connection(
    mut stream: interprocess::local_socket::Stream,
    expected_secret: &str,
    agent: &Agent,
    verifier: &dyn SignatureVerifier,
) -> AgentResult<()> {
    set_stream_timeouts(&stream)?;
    let mut request_line = String::new();
    BufReader::new(&stream)
        .take(MAX_MESSAGE_BYTES)
        .read_line(&mut request_line)?;
    let request: AgentRequest = serde_json::from_str(&request_line)?;
    let response = dispatch(request, expected_secret, agent, verifier);
    let mut encoded = serde_json::to_vec(&response)?;
    encoded.push(b'\n');
    stream.write_all(&encoded)?;
    stream.flush()?;
    Ok(())
}

#[cfg(unix)]
fn set_stream_timeouts(stream: &interprocess::local_socket::Stream) -> AgentResult<()> {
    stream.set_recv_timeout(Some(Duration::from_secs(5)))?;
    stream.set_send_timeout(Some(Duration::from_secs(5)))?;
    Ok(())
}

#[cfg(windows)]
fn set_stream_timeouts(_stream: &interprocess::local_socket::Stream) -> AgentResult<()> {
    // The named-pipe backend does not expose I/O timeouts. Each connection is
    // isolated on its own thread so a stalled client cannot block new accepts.
    Ok(())
}

fn dispatch(
    request: AgentRequest,
    expected_secret: &str,
    agent: &Agent,
    verifier: &dyn SignatureVerifier,
) -> AgentResponse {
    let request_id = request.request_id.clone();
    let result =
        authorize_management_request(&request, expected_secret).and_then(|_| {
            match request.command {
                ManagementCommand::Snapshot => to_value(agent.snapshot()),
                ManagementCommand::PrepareDeviceEnrollment => {
                    to_value(agent.prepare_device_enrollment())
                }
                ManagementCommand::CompleteDeviceEnrollment {
                    api_base_url,
                    device_id,
                    credential,
                } => {
                    let config = ControlPlaneConfig::new(&api_base_url, &device_id)?;
                    let credential = DeviceCredential::new(credential)?;
                    to_value(persist_device_registration(
                        agent.data_root(),
                        &config,
                        &credential,
                    ))
                }
                ManagementCommand::ValidateDevelopmentApplet { path } => {
                    to_value(agent.validate_manifest_directory(&path))
                }
                ManagementCommand::RegisterDevelopmentApplet { path } => {
                    to_value(agent.register_dev_directory(&path))
                }
                ManagementCommand::InstallSignedPackage {
                    package_path,
                    attestation,
                    manifest,
                } => to_value(agent.install_signed(
                    &InstallRequest {
                        package_path,
                        attestation,
                        manifest: *manifest,
                    },
                    verifier,
                )),
                ManagementCommand::UninstallApplet { app_id, version } => {
                    to_value(agent.uninstall(&app_id, &version))
                }
                ManagementCommand::RunApplet {
                    app_id,
                    version,
                    args,
                } => to_value(agent.run(&app_id, version.as_deref(), args)),
                ManagementCommand::StopTask { task_id } => to_value(agent.stop(&task_id)),
                ManagementCommand::ReadTaskLog { task_id } => to_value(agent.read_log(&task_id)),
                ManagementCommand::ApplyScheduleSnapshot { snapshot } => {
                    to_value(agent.apply_schedule_snapshot(&snapshot))
                }
                ManagementCommand::MarkScheduleOffline => to_value(agent.mark_schedule_offline()),
            }
        });
    match result {
        Ok(data) => AgentResponse {
            protocol_version: AGENT_PROTOCOL_VERSION,
            request_id,
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => AgentResponse {
            protocol_version: AGENT_PROTOCOL_VERSION,
            request_id,
            ok: false,
            data: None,
            error: Some(error.to_string()),
        },
    }
}

fn authorize_management_request(request: &AgentRequest, expected_secret: &str) -> AgentResult<()> {
    if request.protocol_version != AGENT_PROTOCOL_VERSION {
        return Err(AgentError::AccessDenied(
            "unsupported Agent protocol version".into(),
        ));
    }
    if Uuid::parse_str(&request.request_id).is_err() {
        return Err(AgentError::AccessDenied("invalid Agent request id".into()));
    }
    if request.bootstrap_secret.len() < 32
        || request
            .bootstrap_secret
            .as_bytes()
            .ct_eq(expected_secret.as_bytes())
            .unwrap_u8()
            != 1
    {
        return Err(AgentError::AccessDenied(
            "Agent bootstrap secret mismatch".into(),
        ));
    }
    Ok(())
}

fn to_value<T: Serialize>(result: AgentResult<T>) -> AgentResult<serde_json::Value> {
    serde_json::to_value(result?).map_err(Into::into)
}

fn ensure_bootstrap_secret(data_root: &Path) -> AgentResult<String> {
    let path = data_root.join("agent-bootstrap.secret");
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim().to_owned();
        if value.len() >= 32 {
            return Ok(value);
        }
        return Err(AgentError::AccessDenied(
            "Agent bootstrap secret file is malformed".into(),
        ));
    }
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let value = URL_SAFE_NO_PAD.encode(bytes);
    write_secret_file(&path, value.as_bytes())?;
    Ok(value)
}

#[cfg(unix)]
fn write_secret_file(path: &Path, bytes: &[u8]) -> AgentResult<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(windows)]
fn write_secret_file(path: &Path, bytes: &[u8]) -> AgentResult<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> AgentResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
#[cfg(windows)]
fn restrict_directory(_path: &Path) -> AgentResult<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_socket(name: &str) -> AgentResult<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(name, fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(windows)]
fn restrict_socket(_name: &str) -> AgentResult<()> {
    // The Windows DACL is applied atomically when the named-pipe listener is created.
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};

    use tempfile::tempdir;

    use crate::manifest::{
        Ed25519Algorithm, FileAccess, FileScope, Integrity, ManifestArtifact, ManifestKind,
        PublisherSignature, Sha256Algorithm,
    };
    use crate::{AgentConfig, Capability, RunMode, RuntimeKind, RuntimeSpec, TargetPlatform};

    use super::*;

    #[test]
    fn management_protocol_rejects_wrong_version_or_bootstrap_secret() {
        let request = AgentRequest {
            protocol_version: AGENT_PROTOCOL_VERSION,
            request_id: Uuid::new_v4().to_string(),
            bootstrap_secret: "a".repeat(32),
            command: ManagementCommand::Snapshot,
        };
        assert!(authorize_management_request(&request, &"a".repeat(32)).is_ok());
        assert!(authorize_management_request(&request, &"b".repeat(32)).is_err());
        let wrong_version = AgentRequest {
            protocol_version: 9,
            ..request
        };
        assert!(authorize_management_request(&wrong_version, &"a".repeat(32)).is_err());
    }

    #[test]
    fn broker_paths_networks_headers_and_environment_are_fail_closed() {
        let directory = tempdir().unwrap();
        let root = directory.path().join("workspace");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("inside.txt"), b"inside").unwrap();
        assert!(resolve_broker_path(&root, Path::new("inside.txt"), true).is_ok());
        assert!(resolve_broker_path(&root, Path::new("new.txt"), false).is_ok());
        assert!(resolve_broker_path(&root, Path::new("../outside.txt"), false).is_err());

        let capabilities = vec![Capability::Network {
            domains: vec!["api.example.com".into(), "*.trusted.example".into()],
            methods: vec![HttpMethod::Get],
        }];
        assert!(
            validate_http_url(&capabilities, HttpMethod::Get, "https://api.example.com/v1").is_ok()
        );
        assert!(validate_http_url(
            &capabilities,
            HttpMethod::Get,
            "https://child.trusted.example/v1"
        )
        .is_ok());
        assert!(
            validate_http_url(&capabilities, HttpMethod::Get, "https://trusted.example/v1")
                .is_err()
        );
        assert!(validate_http_url(
            &capabilities,
            HttpMethod::Post,
            "https://api.example.com/v1"
        )
        .is_err());
        assert!(
            validate_http_url(&capabilities, HttpMethod::Get, "http://api.example.com/v1").is_err()
        );
        assert!(validate_http_url(&capabilities, HttpMethod::Get, "https://127.0.0.1/v1").is_err());
        assert!(validate_broker_header("x-request-id").is_ok());
        assert!(validate_broker_header("authorization").is_err());
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("169.254.169.254".parse().unwrap()));
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));

        let environment = filtered_child_environment([
            (OsString::from("SystemRoot"), OsString::from("C:\\Windows")),
            (OsString::from("WORKFLOW_TOKEN"), OsString::from("secret")),
        ]);
        assert_eq!(environment.len(), 1);
        let oversized = vec![b'x'; MAX_PROCESS_OUTPUT_BYTES + 100];
        assert_eq!(
            read_bounded_output(std::io::Cursor::new(oversized))
                .unwrap()
                .len(),
            MAX_PROCESS_OUTPUT_BYTES
        );
    }

    #[test]
    fn client_round_trips_to_the_persistent_agent_transport() {
        let directory = tempdir().unwrap();
        let data_root = directory.path().join("agent");
        let endpoint = AgentEndpoint::from_data_root(&data_root).unwrap();
        // Create the secret before the listener starts so daemon/client startup cannot race.
        let client = AgentClient::for_data_root(&data_root).unwrap();
        let agent = Arc::new(
            Agent::open(crate::AgentConfig {
                data_root,
                runner_path: "missing-runner".into(),
                python_runtime: None,
                rpc_endpoint: "local://test".into(),
                target: crate::TargetPlatform::current().unwrap(),
                developer_mode: false,
            })
            .unwrap(),
        );
        thread::spawn(move || {
            run_agent_daemon(endpoint, agent, Arc::new(crate::RejectUnsignedVerifier)).unwrap()
        });

        let mut snapshot = None;
        for _ in 0..50 {
            match client.snapshot() {
                Ok(value) => {
                    snapshot = Some(value);
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(20)),
            }
        }
        let snapshot = snapshot.expect("Agent listener did not become ready");
        assert!(!snapshot.developer_mode);
        assert!(snapshot.installed.is_empty());
    }

    #[test]
    fn task_rpc_round_trip_enforces_lease_scope_and_method_allowlist() {
        let directory = tempdir().unwrap();
        let data_root = directory.path().join("agent");
        let applet_root = directory.path().join("applet");
        fs::create_dir(&applet_root).unwrap();
        fs::write(applet_root.join("index.html"), b"<h1>RPC test</h1>").unwrap();
        let manifest = AppletManifest {
            schema_version: 1,
            app_id: "rpc-test-app".into(),
            version: semver::Version::new(1, 0, 0),
            artifacts: vec![ManifestArtifact {
                name: "windows-runtime".into(),
                file_name: "rpc-test.awpkg".into(),
                media_type: "application/vnd.awesome-workflow.package+zip".into(),
                size: 1,
                sha256: "a".repeat(64),
                platform: Some(TargetPlatform::WINDOWS_X64),
            }],
            integrity: Integrity {
                algorithm: Sha256Algorithm::Sha256,
                digest: "b".repeat(64),
            },
            signature: PublisherSignature {
                algorithm: Ed25519Algorithm::Ed25519,
                key_id: "development".into(),
                value: "x".repeat(64),
            },
            kind: ManifestKind::Desktop,
            name: "RPC Test".into(),
            description: String::new(),
            runtimes: vec![RuntimeSpec {
                platform: TargetPlatform::WINDOWS_X64,
                artifact: "windows-runtime".into(),
                entry: "index.html".into(),
                runtime: RuntimeKind::WebUi {
                    allowed_origins: vec![],
                },
            }],
            dependencies: vec![],
            capabilities: vec![Capability::Filesystem {
                access: FileAccess::ReadWrite,
                scopes: vec![FileScope::Workspace],
            }],
            run_mode: RunMode::Parallel,
            min_host_version: semver::Version::new(0, 1, 0),
        };
        fs::write(
            applet_root.join("applet.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let endpoint = AgentEndpoint::from_data_root(&data_root).unwrap();
        let agent = Arc::new(
            Agent::open(AgentConfig {
                data_root,
                runner_path: "missing-runner".into(),
                python_runtime: None,
                rpc_endpoint: endpoint.task_rpc_endpoint(),
                target: TargetPlatform::WINDOWS_X64,
                developer_mode: true,
            })
            .unwrap(),
        );
        agent.register_dev_directory(&applet_root).unwrap();
        let (task, lease) = match agent.run("rpc-test-app", None, vec![]).unwrap() {
            RunOutcome::WebUi { task, launch_url } => {
                let fragment = url::Url::parse(&launch_url)
                    .unwrap()
                    .fragment()
                    .unwrap()
                    .strip_prefix("aw-task=")
                    .unwrap()
                    .to_owned();
                let bootstrap: serde_json::Value =
                    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(fragment).unwrap()).unwrap();
                (task, bootstrap["lease"].as_str().unwrap().to_owned())
            }
            RunOutcome::Process { .. } => panic!("expected Web UI task"),
        };
        let daemon_endpoint = endpoint.clone();
        let daemon_agent = agent.clone();
        thread::spawn(move || {
            run_agent_daemon(
                daemon_endpoint,
                daemon_agent,
                Arc::new(crate::RejectUnsignedVerifier),
            )
            .unwrap()
        });

        let context = RpcEnvelope {
            protocol_version: RPC_PROTOCOL_VERSION,
            app_id: "rpc-test-app".into(),
            task_id: task.task_id.clone(),
            lease: lease.clone(),
            method: AgentMethod::ContextRead,
            payload: serde_json::json!({}),
        };
        let response = task_rpc_call(&endpoint, &serde_json::to_value(&context).unwrap());
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.data.unwrap()["appId"], "rpc-test-app");

        let log_request = RpcEnvelope {
            method: AgentMethod::TaskLogAppend,
            payload: serde_json::json!({"level":"info", "message":"hello over task RPC"}),
            ..context.clone()
        };
        assert!(task_rpc_call(&endpoint, &serde_json::to_value(log_request).unwrap()).ok);
        let progress_request = RpcEnvelope {
            method: AgentMethod::TaskProgress,
            payload: serde_json::json!({"value":0.5, "label":"half way"}),
            ..context.clone()
        };
        assert!(task_rpc_call(&endpoint, &serde_json::to_value(progress_request).unwrap()).ok);
        let log = agent.read_log(&task.task_id).unwrap();
        assert!(log.contains("hello over task RPC"));
        assert!(log.contains("half way"));

        let write_request = RpcEnvelope {
            method: AgentMethod::WorkspaceWrite,
            payload: serde_json::json!({"path":"result.txt", "data":"brokered"}),
            ..context.clone()
        };
        assert!(task_rpc_call(&endpoint, &serde_json::to_value(write_request).unwrap()).ok);
        let read_request = RpcEnvelope {
            method: AgentMethod::WorkspaceRead,
            payload: serde_json::json!({"path":"result.txt"}),
            ..context.clone()
        };
        let read_response = task_rpc_call(&endpoint, &serde_json::to_value(read_request).unwrap());
        assert!(read_response.ok, "{:?}", read_response.error);
        assert_eq!(read_response.data.unwrap()["data"], "brokered");
        let traversal = RpcEnvelope {
            method: AgentMethod::WorkspaceRead,
            payload: serde_json::json!({"path":"../secret.txt"}),
            ..context.clone()
        };
        assert!(!task_rpc_call(&endpoint, &serde_json::to_value(traversal).unwrap()).ok);

        let wrong_app = RpcEnvelope {
            app_id: "other-app".into(),
            ..context.clone()
        };
        assert!(!task_rpc_call(&endpoint, &serde_json::to_value(wrong_app).unwrap()).ok);
        let wrong_version = RpcEnvelope {
            protocol_version: 99,
            ..context.clone()
        };
        assert!(!task_rpc_call(&endpoint, &serde_json::to_value(wrong_version).unwrap()).ok);
        let unknown_lease = RpcEnvelope {
            lease: "unknown-lease-value-that-is-long-enough".into(),
            ..context.clone()
        };
        assert!(!task_rpc_call(&endpoint, &serde_json::to_value(unknown_lease).unwrap()).ok);
        let ungranted = RpcEnvelope {
            method: AgentMethod::ProcessSpawn,
            payload: serde_json::json!({"executable":"helper.exe"}),
            ..context
        };
        assert!(!task_rpc_call(&endpoint, &serde_json::to_value(ungranted).unwrap()).ok);
        let unknown_method = serde_json::json!({
            "protocolVersion": RPC_PROTOCOL_VERSION,
            "appId": "rpc-test-app",
            "taskId": task.task_id,
            "lease": lease,
            "method": "shell-exec",
            "payload": {},
        });
        assert!(!task_rpc_call(&endpoint, &unknown_method).ok);
    }

    fn task_rpc_call(endpoint: &AgentEndpoint, request: &serde_json::Value) -> TaskRpcResponse {
        for _ in 0..50 {
            if let Ok(mut stream) =
                interprocess::local_socket::Stream::connect(endpoint.task_local_name().unwrap())
            {
                let mut encoded = serde_json::to_vec(request).unwrap();
                encoded.push(b'\n');
                stream.write_all(&encoded).unwrap();
                stream.flush().unwrap();
                let mut response = String::new();
                BufReader::new(stream).read_line(&mut response).unwrap();
                return serde_json::from_str(&response).unwrap();
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("task RPC listener did not become ready")
    }
}
