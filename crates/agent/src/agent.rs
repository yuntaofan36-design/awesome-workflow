use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex},
    time::Duration,
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    artifact::{extract_to_staging, verify_artifact},
    control_plane::{
        load_control_plane_config, ArtifactDownloader, InstallationStatusReport,
        InstallationSyncItem, InstallationSyncSnapshot, InstallationSyncStatus,
        ReportInstallationStatus, RunClaim, RunControl, RunReport,
    },
    db::{
        Database, InstallationReportOutboxEntry, RemoteRunCompletion, RemoteRunRecord,
        RunReportOutboxEntry,
    },
    manifest::resolve_contained,
    now_unix,
    web_ui::{self, WebUiServerHandle},
    AgentError, AgentResult, AppletManifest, ArtifactAttestation, Capability, HostTaskContext,
    IssuedLease, LeaseAuthority, RpcEnvelope, RunMode, RuntimeKind, ScheduleDelta, ScheduleRecord,
    ScheduleSnapshot, SignatureVerifier, SyncState, TargetPlatform,
};

const LEASE_TTL: Duration = Duration::from_secs(4 * 60 * 60);
const WEB_UI_LEASE_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_LOG_BYTES: u64 = 128 * 1024;
const MAX_RPC_LOG_MESSAGE_BYTES: usize = 16 * 1024;
const DEVICE_IDENTITY_FILE: &str = "device-identity.key";

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub data_root: PathBuf,
    pub runner_path: PathBuf,
    pub python_runtime: Option<PathBuf>,
    pub rpc_endpoint: String,
    pub target: TargetPlatform,
    pub developer_mode: bool,
}

#[derive(Debug, Clone)]
pub struct InstallRequest {
    pub package_path: PathBuf,
    pub attestation: ArtifactAttestation,
    pub manifest: AppletManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApplet {
    pub manifest: AppletManifest,
    pub install_path: PathBuf,
    pub installed_at: u64,
    pub active: bool,
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    pub app_id: String,
    pub version: String,
    pub status: String,
    pub pid: Option<u32>,
    pub log_path: PathBuf,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RunOutcome {
    Process {
        task: TaskRecord,
        lease: IssuedLease,
    },
    WebUi {
        task: TaskRecord,
        launch_url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub installed: Vec<InstalledApplet>,
    pub tasks: Vec<TaskRecord>,
    pub sync: SyncState,
    pub installation_revision: u64,
    pub device: Option<DeviceRegistrationStatus>,
    pub developer_mode: bool,
    pub target: TargetPlatform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRegistrationStatus {
    pub device_id: String,
    pub api_base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceEnrollmentPreparation {
    pub public_key_thumbprint: String,
    pub os: crate::DesktopOs,
    pub arch: crate::DesktopArch,
    pub agent_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerRequest {
    pub protocol_version: u16,
    pub app_id: String,
    pub task_id: String,
    pub lease: String,
    pub rpc_endpoint: String,
    pub manifest: AppletManifest,
    pub target: TargetPlatform,
    pub package_dir: PathBuf,
    pub work_dir: PathBuf,
    pub log_path: PathBuf,
    pub python_runtime: Option<PathBuf>,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone)]
pub struct Agent {
    config: AgentConfig,
    database: Arc<Database>,
    leases: LeaseAuthority,
    children: Arc<Mutex<HashMap<String, Child>>>,
    web_ui_servers: Arc<Mutex<HashMap<String, WebUiServerHandle>>>,
}

impl Agent {
    pub fn open(config: AgentConfig) -> AgentResult<Self> {
        fs::create_dir_all(config.data_root.join("apps"))?;
        fs::create_dir_all(config.data_root.join("staging"))?;
        fs::create_dir_all(config.data_root.join("tasks"))?;
        fs::create_dir_all(config.data_root.join("trash"))?;
        let database = Arc::new(Database::open(&config.data_root.join("agent.db"))?);
        database.fail_interrupted_tasks(now_unix())?;
        let leases = LeaseAuthority::new(database.clone());
        Ok(Self {
            config,
            database,
            leases,
            children: Arc::new(Mutex::new(HashMap::new())),
            web_ui_servers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.config.data_root
    }

    pub fn snapshot(&self) -> AgentResult<AgentSnapshot> {
        self.refresh_tasks()?;
        let device = load_control_plane_config(&self.config.data_root)?.map(|config| {
            DeviceRegistrationStatus {
                device_id: config.device_id().to_string(),
                api_base_url: config.api_base_url().to_string(),
            }
        });
        Ok(AgentSnapshot {
            installed: self.database.installed()?,
            tasks: self.database.tasks()?,
            sync: self.database.sync_state()?,
            installation_revision: self.database.installation_sync_revision()?,
            device,
            developer_mode: self.config.developer_mode,
            target: self.config.target,
        })
    }

    pub fn prepare_device_enrollment(&self) -> AgentResult<DeviceEnrollmentPreparation> {
        fs::create_dir_all(&self.config.data_root)?;
        let path = self.config.data_root.join(DEVICE_IDENTITY_FILE);
        let identity = match fs::read(&path) {
            Ok(bytes) => validate_device_identity(bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut generated = [0_u8; 32];
                rand::rng().fill_bytes(&mut generated);
                match write_device_identity(&path, &generated) {
                    Ok(()) => generated,
                    Err(AgentError::Io(error))
                        if error.kind() == std::io::ErrorKind::AlreadyExists =>
                    {
                        validate_device_identity(fs::read(&path)?)?
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error.into()),
        };
        Ok(DeviceEnrollmentPreparation {
            public_key_thumbprint: format!("sha256:{}", hex::encode(Sha256::digest(identity))),
            os: self.config.target.os,
            arch: self.config.target.arch,
            agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        })
    }

    pub fn validate_manifest_directory(&self, directory: &Path) -> AgentResult<AppletManifest> {
        let root = directory.canonicalize()?;
        let manifest: AppletManifest =
            serde_json::from_slice(&fs::read(root.join("applet.json"))?)?;
        manifest.validate()?;
        let runtime = manifest.runtime_for(self.config.target)?;
        resolve_contained(&root, runtime.entry())?;
        Ok(manifest)
    }

    pub fn register_dev_directory(&self, directory: &Path) -> AgentResult<InstalledApplet> {
        if !self.config.developer_mode {
            return Err(AgentError::AccessDenied(
                "developer mode is disabled".into(),
            ));
        }
        let root = directory.canonicalize()?;
        let manifest = self.validate_manifest_directory(&root)?;
        self.database
            .activate_install(&manifest, &root, now_unix(), false)?;
        Ok(InstalledApplet {
            manifest,
            install_path: root,
            installed_at: now_unix(),
            active: true,
            managed: false,
        })
    }

    pub fn install_signed(
        &self,
        request: &InstallRequest,
        verifier: &dyn SignatureVerifier,
    ) -> AgentResult<InstalledApplet> {
        self.install_signed_with_hook(request, verifier, &AllowActivation)
    }

    fn install_signed_with_hook(
        &self,
        request: &InstallRequest,
        verifier: &dyn SignatureVerifier,
        hook: &dyn ActivationHook,
    ) -> AgentResult<InstalledApplet> {
        request.manifest.validate()?;
        request.manifest.verify_artifact_set_integrity()?;
        verifier.verify_manifest(
            &request.manifest.signature_payload()?,
            &request.manifest.signature,
        )?;

        let runtime = request.manifest.runtime_for(self.config.target)?;
        let artifact = request
            .manifest
            .artifacts
            .iter()
            .find(|artifact| artifact.name == runtime.artifact)
            .ok_or_else(|| {
                AgentError::InvalidManifest(format!(
                    "runtime references unknown artifact {}",
                    runtime.artifact
                ))
            })?;
        if artifact.sha256 != request.attestation.sha256
            || fs::metadata(&request.package_path)?.len() != artifact.size
        {
            return Err(AgentError::DigestMismatch);
        }
        verify_artifact(&request.package_path, &request.attestation, verifier)?;
        let staging = extract_to_staging(
            &request.package_path,
            &self.config.data_root.join("staging"),
        )?;
        if let Err(error) =
            validate_extracted_release(&staging, &request.manifest, self.config.target)
        {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let manifest = request.manifest.clone();
        let destination = self
            .config
            .data_root
            .join("apps")
            .join(&manifest.app_id)
            .join(manifest.version.to_string());
        if destination.exists() {
            let _ = fs::remove_dir_all(&staging);
            return Err(AgentError::State(
                "immutable application version is already installed".into(),
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| AgentError::PathEscape(destination.display().to_string()))?;
        fs::create_dir_all(parent)?;
        fs::rename(&staging, &destination)?;

        let activation = hook.before_activation(&manifest).and_then(|_| {
            self.database
                .activate_install(&manifest, &destination, now_unix(), true)
        });
        if let Err(error) = activation {
            let _ = fs::remove_dir_all(&destination);
            return Err(error);
        }
        Ok(InstalledApplet {
            manifest,
            install_path: destination,
            installed_at: now_unix(),
            active: true,
            managed: true,
        })
    }

    pub fn uninstall(&self, app_id: &str, version: &str) -> AgentResult<()> {
        if self.database.tasks()?.iter().any(|task| {
            task.app_id == app_id && matches!(task.status.as_str(), "starting" | "running")
        }) {
            return Err(AgentError::State(
                "cannot uninstall an application with running tasks".into(),
            ));
        }
        let installed = self.database.active_install(app_id, Some(version))?;
        if !installed.managed {
            self.database.remove_install(app_id, version)?;
            return Ok(());
        }
        let apps_root = self.config.data_root.join("apps").canonicalize()?;
        let install_path = installed.install_path.canonicalize()?;
        if !install_path.starts_with(&apps_root) {
            return Err(AgentError::PathEscape(install_path.display().to_string()));
        }
        let quarantine = self
            .config
            .data_root
            .join("trash")
            .join(Uuid::new_v4().to_string());
        fs::rename(&install_path, &quarantine)?;
        if let Err(error) = self.database.remove_install(app_id, version) {
            let _ = fs::rename(&quarantine, &install_path);
            return Err(error);
        }
        fs::remove_dir_all(quarantine)?;
        Ok(())
    }

    pub fn run(
        &self,
        app_id: &str,
        version: Option<&str>,
        args: Vec<String>,
    ) -> AgentResult<RunOutcome> {
        self.refresh_tasks()?;
        let installed = self.database.active_install(app_id, version)?;
        let running = self.database.tasks()?.into_iter().any(|task| {
            task.app_id == app_id && matches!(task.status.as_str(), "starting" | "running")
        });
        if running && installed.manifest.run_mode != RunMode::Parallel {
            return Err(AgentError::State(
                "application run mode does not allow another active task".into(),
            ));
        }
        let runtime = installed.manifest.runtime_for(self.config.target)?.clone();
        let task_id = Uuid::new_v4().to_string();
        let task_dir = self.config.data_root.join("tasks").join(&task_id);
        fs::create_dir(&task_dir)?;
        let log_path = task_dir.join("task.log");
        fs::File::create(&log_path)?;
        let lease_ttl = if matches!(&runtime.runtime, RuntimeKind::WebUi { .. }) {
            WEB_UI_LEASE_TTL
        } else {
            LEASE_TTL
        };
        let lease = self.leases.issue(
            &installed.manifest.app_id,
            &task_id,
            &installed.manifest.capabilities,
            lease_ttl,
        )?;
        let mut task = TaskRecord {
            task_id: task_id.clone(),
            app_id: installed.manifest.app_id.clone(),
            version: installed.manifest.version.to_string(),
            status: "starting".into(),
            pid: None,
            log_path: log_path.clone(),
            started_at: now_unix(),
            finished_at: None,
        };

        if matches!(&runtime.runtime, RuntimeKind::WebUi { .. }) {
            let entry_path = resolve_contained(&installed.install_path, runtime.entry())?;
            task.status = "running".into();
            self.database.insert_task(&task)?;
            let (server, launch_url) = match web_ui::start(
                self.web_ui_server_agent(),
                &installed.install_path,
                &entry_path,
                &task,
                &lease,
                args,
            ) {
                Ok(started) => started,
                Err(error) => {
                    self.database
                        .update_task(&task.task_id, "failed", Some(now_unix()))?;
                    self.database.revoke_task_leases(&task.task_id)?;
                    return Err(error);
                }
            };
            let mut servers = match self.web_ui_servers.lock() {
                Ok(servers) => servers,
                Err(_) => {
                    server.stop();
                    self.database
                        .update_task(&task.task_id, "failed", Some(now_unix()))?;
                    self.database.revoke_task_leases(&task.task_id)?;
                    return Err(AgentError::State("web UI server lock was poisoned".into()));
                }
            };
            servers.insert(task_id, server);
            return Ok(RunOutcome::WebUi { task, launch_url });
        }

        let request = RunnerRequest {
            protocol_version: crate::RPC_PROTOCOL_VERSION,
            app_id: task.app_id.clone(),
            task_id: task_id.clone(),
            lease: lease.value.clone(),
            rpc_endpoint: self.config.rpc_endpoint.clone(),
            manifest: installed.manifest,
            target: self.config.target,
            package_dir: installed.install_path,
            work_dir: task_dir.clone(),
            log_path: log_path.clone(),
            python_runtime: self.config.python_runtime.clone(),
            args,
        };
        let request_path = task_dir.join("runner-request.json");
        fs::write(&request_path, serde_json::to_vec_pretty(&request)?)?;
        let mut command = Command::new(&self.config.runner_path);
        command.arg("--request").arg(&request_path).env_clear();
        copy_runner_environment(&mut command);
        let child = command
            .spawn()
            .map_err(|error| AgentError::Runner(error.to_string()))?;
        task.pid = Some(child.id());
        task.status = "running".into();
        self.database.insert_task(&task)?;
        self.children
            .lock()
            .map_err(|_| AgentError::State("runner lock was poisoned".into()))?
            .insert(task_id, child);
        Ok(RunOutcome::Process { task, lease })
    }

    pub fn stop(&self, task_id: &str) -> AgentResult<()> {
        let task = self.database.task(task_id)?;
        if let Some(server) = self
            .web_ui_servers
            .lock()
            .map_err(|_| AgentError::State("web UI server lock was poisoned".into()))?
            .remove(task_id)
        {
            server.stop();
        }
        if let Some(mut child) = self
            .children
            .lock()
            .map_err(|_| AgentError::State("runner lock was poisoned".into()))?
            .remove(task_id)
        {
            child.kill()?;
            let _ = child.wait();
        }
        if matches!(task.status.as_str(), "starting" | "running") {
            self.database
                .update_task(task_id, "stopped", Some(now_unix()))?;
        }
        self.database.revoke_task_leases(task_id)?;
        Ok(())
    }

    pub fn read_log(&self, task_id: &str) -> AgentResult<String> {
        let task = self.database.task(task_id)?;
        let tasks_root = self.config.data_root.join("tasks").canonicalize()?;
        let log_path = task.log_path.canonicalize()?;
        if !log_path.starts_with(tasks_root) {
            return Err(AgentError::PathEscape(log_path.display().to_string()));
        }
        let mut file = fs::File::open(log_path)?;
        let length = file.metadata()?.len();
        if length > MAX_LOG_BYTES {
            file.seek(SeekFrom::Start(length - MAX_LOG_BYTES))?;
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        Ok(contents)
    }

    pub fn authorize_rpc<T>(&self, envelope: &RpcEnvelope<T>) -> AgentResult<()> {
        self.leases.authorize(envelope)
    }

    pub fn rpc_capabilities<T>(&self, envelope: &RpcEnvelope<T>) -> AgentResult<Vec<Capability>> {
        self.leases.authorized_capabilities(envelope)
    }

    pub fn task_package_directory(&self, app_id: &str, task_id: &str) -> AgentResult<PathBuf> {
        let task = self.database.task(task_id)?;
        if task.app_id != app_id {
            return Err(AgentError::AccessDenied("task identity mismatch".into()));
        }
        Ok(self
            .database
            .active_install(app_id, Some(&task.version))?
            .install_path)
    }

    pub fn task_context(&self, app_id: &str, task_id: &str) -> AgentResult<HostTaskContext> {
        let task = self.database.task(task_id)?;
        if task.app_id != app_id {
            return Err(AgentError::AccessDenied("task identity mismatch".into()));
        }
        let work_directory = task
            .log_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| AgentError::PathEscape(task.log_path.display().to_string()))?;
        Ok(HostTaskContext {
            app_id: task.app_id,
            task_id: task.task_id,
            work_directory,
            workspace_directory: None,
            arguments: Vec::new(),
        })
    }

    pub fn append_task_rpc_event(
        &self,
        task_id: &str,
        event: &serde_json::Value,
    ) -> AgentResult<()> {
        let encoded = serde_json::to_string(event)?;
        if encoded.len() > MAX_RPC_LOG_MESSAGE_BYTES {
            return Err(AgentError::AccessDenied("task event is too large".into()));
        }
        let task = self.database.task(task_id)?;
        let tasks_root = self.config.data_root.join("tasks").canonicalize()?;
        let log_path = task.log_path.canonicalize()?;
        if !log_path.starts_with(tasks_root) {
            return Err(AgentError::PathEscape(log_path.display().to_string()));
        }
        let mut log = fs::OpenOptions::new().append(true).open(log_path)?;
        writeln!(log, "AW_RPC_EVENT {encoded}")?;
        Ok(())
    }

    pub(crate) fn finish_web_ui_task(&self, task_id: &str, status: &str) {
        if let Ok(task) = self.database.task(task_id) {
            if matches!(task.status.as_str(), "starting" | "running") {
                let _ = self.database.update_task(task_id, status, Some(now_unix()));
            }
        }
        let _ = self.database.revoke_task_leases(task_id);
    }

    fn web_ui_server_agent(&self) -> Self {
        Self {
            config: self.config.clone(),
            database: Arc::clone(&self.database),
            leases: self.leases.clone(),
            children: Arc::clone(&self.children),
            // The server thread must not retain the registry entry that owns
            // its own join handle. A detached registry breaks that lifetime
            // cycle while preserving the shared database and lease authority.
            web_ui_servers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn apply_schedule_snapshot(&self, snapshot: &ScheduleSnapshot) -> AgentResult<bool> {
        self.database
            .apply_schedule_snapshot(snapshot, crate::now_unix_ms())
    }

    pub fn apply_schedule_delta(&self, delta: &ScheduleDelta) -> AgentResult<bool> {
        self.database
            .apply_schedule_delta(delta, crate::now_unix_ms())
    }

    pub fn mark_schedule_offline(&self) -> AgentResult<()> {
        self.database.mark_offline()
    }

    pub fn schedule_sync_state(&self) -> AgentResult<SyncState> {
        self.database.sync_state()
    }

    pub(crate) fn installation_sync_revision(&self) -> AgentResult<u64> {
        self.database.installation_sync_revision()
    }

    pub(crate) fn apply_installation_snapshot(
        &self,
        snapshot: &InstallationSyncSnapshot,
        downloader: &dyn ArtifactDownloader,
        verifier: &dyn SignatureVerifier,
    ) -> AgentResult<bool> {
        snapshot.validate_for_target(self.config.target)?;
        let local_revision = self.database.installation_sync_revision()?;
        if snapshot.revision < local_revision {
            return Err(AgentError::State(
                "installation snapshot is older than the committed local revision".into(),
            ));
        }
        if snapshot.revision == local_revision {
            return Ok(false);
        }

        let mut waiting_for_downloading_ack = false;
        for installation in &snapshot.installations {
            if self.installation_is_present(installation)? {
                if installation.status != InstallationSyncStatus::Installed {
                    self.enqueue_installation_report(
                        &installation.installation_id,
                        InstallationStatusReport {
                            status: ReportInstallationStatus::Installed,
                            error_code: None,
                        },
                    )?;
                }
                continue;
            }

            match installation.status {
                InstallationSyncStatus::Requested => {
                    self.enqueue_installation_report(
                        &installation.installation_id,
                        InstallationStatusReport {
                            status: ReportInstallationStatus::Downloading,
                            error_code: None,
                        },
                    )?;
                    waiting_for_downloading_ack = true;
                }
                InstallationSyncStatus::Downloading => {
                    let report = match self.install_synced(installation, downloader, verifier) {
                        Ok(_) => InstallationStatusReport {
                            status: ReportInstallationStatus::Installed,
                            error_code: None,
                        },
                        Err(error) => InstallationStatusReport {
                            status: ReportInstallationStatus::Failed,
                            error_code: Some(installation_error_code(&error).into()),
                        },
                    };
                    self.enqueue_installation_report(&installation.installation_id, report)?;
                }
                InstallationSyncStatus::Installed => {
                    // The server already considers this desired version installed. Reconcile
                    // a missing local copy, but do not emit an invalid installed -> failed
                    // transition if the repair cannot be completed.
                    self.install_synced(installation, downloader, verifier)?;
                }
            }
        }
        if waiting_for_downloading_ack {
            return Ok(false);
        }
        self.database
            .commit_installation_sync_revision(snapshot.revision)
    }

    pub(crate) fn due_installation_reports(
        &self,
    ) -> AgentResult<Vec<InstallationReportOutboxEntry>> {
        self.database.due_installation_reports(crate::now_unix_ms())
    }

    pub(crate) fn acknowledge_installation_report(&self, outbox_id: i64) -> AgentResult<()> {
        self.database.acknowledge_installation_report(outbox_id)
    }

    pub(crate) fn retry_installation_report(
        &self,
        outbox_id: i64,
        next_attempt_at_ms: u64,
    ) -> AgentResult<()> {
        self.database
            .retry_installation_report(outbox_id, next_attempt_at_ms)
    }

    fn enqueue_installation_report(
        &self,
        installation_id: &str,
        report: InstallationStatusReport,
    ) -> AgentResult<()> {
        self.database
            .enqueue_installation_report(installation_id, &report, crate::now_unix_ms())
    }

    fn installation_is_present(&self, installation: &InstallationSyncItem) -> AgentResult<bool> {
        let installed = match self
            .database
            .active_install(&installation.app_id, Some(&installation.version))
        {
            Ok(installed) => installed,
            Err(AgentError::NotInstalled(_, _)) => return Ok(false),
            Err(error) => return Err(error),
        };
        if installed.manifest != installation.manifest {
            return Err(AgentError::State(
                "installed immutable version differs from the control-plane manifest".into(),
            ));
        }
        if !installed.install_path.is_dir() {
            self.database
                .remove_install(&installation.app_id, &installation.version)?;
            return Ok(false);
        }
        validate_extracted_release(
            &installed.install_path,
            &installation.manifest,
            self.config.target,
        )?;
        Ok(true)
    }

    fn install_synced(
        &self,
        installation: &InstallationSyncItem,
        downloader: &dyn ArtifactDownloader,
        verifier: &dyn SignatureVerifier,
    ) -> AgentResult<InstalledApplet> {
        installation.validate_for_target(self.config.target)?;
        let downloads = self.config.data_root.join("downloads");
        fs::create_dir_all(&downloads)?;
        let package_path = downloads.join(format!("{}.awpkg.part", Uuid::new_v4()));
        let result = (|| {
            downloader.download(&installation.artifact, &package_path)?;
            self.install_signed(
                &InstallRequest {
                    package_path: package_path.clone(),
                    attestation: installation.artifact.artifact_attestation(),
                    manifest: installation.manifest.clone(),
                },
                verifier,
            )
        })();
        let _ = fs::remove_file(package_path);
        result
    }

    pub fn due_schedules(&self, now: u64) -> AgentResult<Vec<ScheduleRecord>> {
        self.database.due_schedules(now)
    }

    pub fn claim_due_schedules(&self, now: u64) -> AgentResult<Vec<ScheduleRecord>> {
        self.database.claim_due_schedules(now)
    }

    pub(crate) fn record_remote_claim(&self, claim: &RunClaim) -> AgentResult<bool> {
        self.database
            .record_remote_claim(claim, crate::now_unix_ms())
    }

    pub(crate) fn pending_remote_runs(&self) -> AgentResult<Vec<RemoteRunRecord>> {
        self.database.pending_remote_runs()
    }

    pub(crate) fn bind_remote_task_and_enqueue_running(
        &self,
        run_id: &str,
        attempt: u64,
        task_id: &str,
    ) -> AgentResult<()> {
        self.database.bind_remote_task_and_enqueue_running(
            run_id,
            attempt,
            task_id,
            crate::now_unix_ms(),
        )
    }

    pub(crate) fn enqueue_run_report(&self, run_id: &str, report: &RunReport) -> AgentResult<()> {
        self.database
            .enqueue_run_report(run_id, report, crate::now_unix_ms())
    }

    pub(crate) fn completed_remote_runs(&self) -> AgentResult<Vec<RemoteRunCompletion>> {
        self.refresh_tasks()?;
        self.database.completed_remote_runs()
    }

    pub(crate) fn due_run_reports(&self) -> AgentResult<Vec<RunReportOutboxEntry>> {
        self.database.due_run_reports(crate::now_unix_ms())
    }

    pub(crate) fn acknowledge_run_report(&self, outbox_id: i64) -> AgentResult<()> {
        self.database.acknowledge_run_report(outbox_id)
    }

    pub(crate) fn retry_run_report(
        &self,
        outbox_id: i64,
        next_attempt_at_ms: u64,
    ) -> AgentResult<()> {
        self.database
            .retry_run_report(outbox_id, next_attempt_at_ms)
    }

    pub(crate) fn run_requires_foreground(
        &self,
        app_id: &str,
        version: Option<&str>,
    ) -> AgentResult<bool> {
        let installed = self.database.active_install(app_id, version)?;
        Ok(matches!(
            &installed.manifest.runtime_for(self.config.target)?.runtime,
            RuntimeKind::WebUi { .. }
        ))
    }

    /// Applies device-scoped cancellation requests idempotently. An unknown
    /// run attempt is ignored, and a terminal local record is left untouched
    /// so any existing outbox report can still be delivered.
    pub(crate) fn apply_run_controls(&self, controls: &[RunControl]) -> AgentResult<usize> {
        self.refresh_tasks()?;
        let mut applied = 0;
        for control in controls {
            let Some(remote) = self.database.remote_run_for_control(control)? else {
                continue;
            };
            if remote.state == "terminal" {
                continue;
            }
            if let Some(task_id) = remote.task_id.as_deref() {
                match self.stop(task_id) {
                    Ok(()) | Err(AgentError::TaskNotFound(_)) => {}
                    Err(error) => return Err(error),
                }
            }
            self.enqueue_run_report(
                &remote.run_id,
                &RunReport {
                    attempt: remote.attempt,
                    status: crate::ReportRunStatus::Cancelled,
                    result: None,
                    error_code: None,
                },
            )?;
            applied += 1;
        }
        Ok(applied)
    }

    fn refresh_tasks(&self) -> AgentResult<()> {
        let finished_servers = {
            let mut servers = self
                .web_ui_servers
                .lock()
                .map_err(|_| AgentError::State("web UI server lock was poisoned".into()))?;
            let finished = servers
                .iter()
                .filter_map(|(task_id, server)| server.is_finished().then_some(task_id.clone()))
                .collect::<Vec<_>>();
            finished
                .into_iter()
                .filter_map(|task_id| servers.remove(&task_id))
                .collect::<Vec<_>>()
        };
        for server in finished_servers {
            server.join();
        }
        let mut completed = Vec::new();
        let mut children = self
            .children
            .lock()
            .map_err(|_| AgentError::State("runner lock was poisoned".into()))?;
        for (task_id, child) in children.iter_mut() {
            if let Some(status) = child.try_wait()? {
                completed.push((
                    task_id.clone(),
                    if status.success() {
                        "succeeded"
                    } else {
                        "failed"
                    },
                ));
            }
        }
        for (task_id, status) in &completed {
            children.remove(task_id);
            self.database
                .update_task(task_id, status, Some(now_unix()))?;
            self.database.revoke_task_leases(task_id)?;
        }
        Ok(())
    }
}

fn validate_extracted_release(
    staging: &Path,
    trusted_manifest: &AppletManifest,
    target: TargetPlatform,
) -> AgentResult<()> {
    let runtime = trusted_manifest.runtime_for(target)?;
    let entry = resolve_contained(staging, runtime.entry())?;
    if !entry.is_file() {
        return Err(AgentError::InvalidManifest(
            "runtime entry is not a regular file".into(),
        ));
    }

    let metadata_path = staging.join("applet.json");
    if metadata_path.is_file() {
        let metadata: AppletManifest = serde_json::from_slice(&fs::read(metadata_path)?)?;
        metadata.validate()?;
        if metadata.app_id != trusted_manifest.app_id
            || metadata.version != trusted_manifest.version
            || metadata.capabilities != trusted_manifest.capabilities
        {
            return Err(AgentError::AccessDenied(
                "untrusted package metadata conflicts with the signed catalog manifest".into(),
            ));
        }
    }
    Ok(())
}

fn validate_device_identity(bytes: Vec<u8>) -> AgentResult<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| AgentError::State("stored device identity is malformed".into()))
}

fn installation_error_code(error: &AgentError) -> &'static str {
    match error {
        AgentError::DigestMismatch => "digest_mismatch",
        AgentError::SignatureRejected(_) => "signature_rejected",
        AgentError::UnsafeArchive(_) | AgentError::Archive(_) | AgentError::PathEscape(_) => {
            "unsafe_archive"
        }
        AgentError::InvalidManifest(_) | AgentError::UnsupportedTarget(_) => "invalid_manifest",
        AgentError::ControlPlane(_) | AgentError::Io(_) => "download_failed",
        _ => "installation_failed",
    }
}

#[cfg(unix)]
fn write_device_identity(path: &Path, identity: &[u8; 32]) -> AgentResult<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(identity)?;
    file.flush()?;
    Ok(())
}

#[cfg(windows)]
fn write_device_identity(path: &Path, identity: &[u8; 32]) -> AgentResult<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(identity)?;
    file.flush()?;
    Ok(())
}

trait ActivationHook {
    fn before_activation(&self, manifest: &AppletManifest) -> AgentResult<()>;
}

struct AllowActivation;
impl ActivationHook for AllowActivation {
    fn before_activation(&self, _manifest: &AppletManifest) -> AgentResult<()> {
        Ok(())
    }
}

fn copy_runner_environment(command: &mut Command) {
    const ALLOWED: &[&str] = &[
        "SystemRoot",
        "WINDIR",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ];
    for key in ALLOWED {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs::File, io::Write};

    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, ZipWriter};

    use crate::{
        artifact::sha256_file,
        manifest::{
            Capability, Ed25519Algorithm, Integrity, ManifestArtifact, ManifestKind,
            PublisherSignature, Sha256Algorithm,
        },
        RunMode, RuntimeSpec,
    };

    use super::*;

    struct AcceptSignature;
    impl SignatureVerifier for AcceptSignature {
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
    struct RejectActivation;
    impl ActivationHook for RejectActivation {
        fn before_activation(&self, _manifest: &AppletManifest) -> AgentResult<()> {
            Err(AgentError::State("simulated activation failure".into()))
        }
    }

    struct CopyDownloader(PathBuf);

    impl ArtifactDownloader for CopyDownloader {
        fn download(
            &self,
            _artifact: &crate::InstallationSyncArtifact,
            destination: &Path,
        ) -> AgentResult<()> {
            fs::copy(&self.0, destination)?;
            Ok(())
        }
    }

    #[test]
    fn device_identity_thumbprint_is_stable_without_exposing_identity_bytes() {
        let directory = tempdir().unwrap();
        let data_root = directory.path().join("agent");
        let config = AgentConfig {
            data_root: data_root.clone(),
            runner_path: "missing-runner".into(),
            rpc_endpoint: "local://test".into(),
            python_runtime: None,
            target: TargetPlatform::WINDOWS_X64,
            developer_mode: false,
        };
        let first = Agent::open(config.clone())
            .unwrap()
            .prepare_device_enrollment()
            .unwrap();
        let second = Agent::open(config)
            .unwrap()
            .prepare_device_enrollment()
            .unwrap();
        assert_eq!(first.public_key_thumbprint, second.public_key_thumbprint);
        assert!(first.public_key_thumbprint.starts_with("sha256:"));
        assert_eq!(
            fs::read(data_root.join(DEVICE_IDENTITY_FILE))
                .unwrap()
                .len(),
            32
        );
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("device-identity"));
    }

    #[test]
    fn installation_snapshot_reports_downloading_before_atomic_install_and_revision_commit() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("synced.awpkg");
        let file = File::create(&package).unwrap();
        let mut zip = ZipWriter::new(file);
        zip.start_file("main.py", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"print('synced')").unwrap();
        zip.finish().unwrap();
        let digest = hex::encode(sha256_file(&package).unwrap());
        let mut manifest = AppletManifest {
            schema_version: 1,
            app_id: "synced-app".into(),
            version: semver::Version::new(1, 2, 3),
            artifacts: vec![ManifestArtifact {
                name: "windows-x64".into(),
                file_name: "synced.awpkg".into(),
                media_type: "application/zip".into(),
                size: fs::metadata(&package).unwrap().len(),
                sha256: digest.clone(),
                platform: Some(TargetPlatform::WINDOWS_X64),
            }],
            integrity: Integrity {
                algorithm: Sha256Algorithm::Sha256,
                digest: "0".repeat(64),
            },
            signature: PublisherSignature {
                algorithm: Ed25519Algorithm::Ed25519,
                key_id: "test-key".into(),
                value: "A".repeat(88),
            },
            kind: ManifestKind::Desktop,
            name: "Synced app".into(),
            description: "Control-plane installation test".into(),
            runtimes: vec![RuntimeSpec {
                platform: TargetPlatform::WINDOWS_X64,
                artifact: "windows-x64".into(),
                entry: "main.py".into(),
                runtime: RuntimeKind::Python {
                    python: "3.12".into(),
                },
            }],
            dependencies: vec![],
            capabilities: vec![],
            run_mode: RunMode::Parallel,
            min_host_version: semver::Version::new(0, 1, 0),
        };
        manifest.integrity.digest = manifest.artifact_set_integrity_digest().unwrap();
        let installation_id = Uuid::new_v4().to_string();
        let item = InstallationSyncItem {
            installation_id: installation_id.clone(),
            status: InstallationSyncStatus::Requested,
            app_id: manifest.app_id.clone(),
            version: manifest.version.to_string(),
            manifest: manifest.clone(),
            artifact: crate::InstallationSyncArtifact {
                name: "windows-x64".into(),
                file_name: "synced.awpkg".into(),
                media_type: "application/zip".into(),
                size: fs::metadata(&package).unwrap().len(),
                sha256: digest,
                download_url: "https://artifacts.example.test/synced.awpkg?signature=opaque".into(),
                download_expires_at: "2999-01-01T00:00:00.000Z".into(),
                attestation: PublisherSignature {
                    algorithm: Ed25519Algorithm::Ed25519,
                    key_id: "test-key".into(),
                    value: "B".repeat(88),
                },
            },
        };
        let agent = Agent::open(AgentConfig {
            data_root: directory.path().join("agent"),
            runner_path: "missing-runner".into(),
            rpc_endpoint: "local://test".into(),
            python_runtime: None,
            target: TargetPlatform::WINDOWS_X64,
            developer_mode: false,
        })
        .unwrap();
        let downloader = CopyDownloader(package);
        let requested = InstallationSyncSnapshot {
            revision: 1,
            installations: vec![item.clone()],
        };
        assert!(!agent
            .apply_installation_snapshot(&requested, &downloader, &AcceptSignature)
            .unwrap());
        assert_eq!(agent.installation_sync_revision().unwrap(), 0);
        assert!(agent.database.installed().unwrap().is_empty());
        let downloading = agent.due_installation_reports().unwrap();
        assert_eq!(downloading.len(), 1);
        assert_eq!(
            downloading[0].report.status,
            ReportInstallationStatus::Downloading
        );
        agent
            .acknowledge_installation_report(downloading[0].outbox_id)
            .unwrap();

        let mut downloading_item = item;
        downloading_item.status = InstallationSyncStatus::Downloading;
        let downloading_snapshot = InstallationSyncSnapshot {
            revision: 1,
            installations: vec![downloading_item],
        };
        assert!(agent
            .apply_installation_snapshot(&downloading_snapshot, &downloader, &AcceptSignature,)
            .unwrap());
        assert_eq!(agent.installation_sync_revision().unwrap(), 1);
        let installed = agent.database.installed().unwrap();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].manifest, manifest);
        let reports = agent.due_installation_reports().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].installation_id, installation_id);
        assert_eq!(
            reports[0].report.status,
            ReportInstallationStatus::Installed
        );
    }

    #[test]
    fn remote_cancellation_is_attempt_scoped_idempotent_and_persistent() {
        const RUN_ID: &str = "fef02ed3-6b09-462f-ac14-51e208b490c6";
        let directory = tempdir().unwrap();
        let data_root = directory.path().join("agent");
        let agent = Agent::open(AgentConfig {
            data_root: data_root.clone(),
            runner_path: "missing-runner".into(),
            rpc_endpoint: "local://test".into(),
            python_runtime: None,
            target: TargetPlatform::WINDOWS_X64,
            developer_mode: false,
        })
        .unwrap();
        agent
            .record_remote_claim(&RunClaim {
                run_id: RUN_ID.into(),
                attempt: 3,
                app_id: "cancel-test".into(),
                version: "1.0.0".into(),
                args: vec![],
                requires_elevation: false,
            })
            .unwrap();

        let task_id = Uuid::new_v4().to_string();
        let task_dir = data_root.join("tasks").join(&task_id);
        fs::create_dir(&task_dir).unwrap();
        let log_path = task_dir.join("task.log");
        fs::write(&log_path, []).unwrap();
        agent
            .database
            .insert_task(&TaskRecord {
                task_id: task_id.clone(),
                app_id: "cancel-test".into(),
                version: "1.0.0".into(),
                status: "running".into(),
                pid: None,
                log_path,
                started_at: now_unix(),
                finished_at: None,
            })
            .unwrap();
        agent
            .bind_remote_task_and_enqueue_running(RUN_ID, 3, &task_id)
            .unwrap();

        let unknown_attempt = RunControl {
            run_id: RUN_ID.into(),
            attempt: 4,
            cancel_requested_at: "2026-09-01T12:00:00+08:00".into(),
        };
        assert_eq!(agent.apply_run_controls(&[unknown_attempt]).unwrap(), 0);
        assert_eq!(agent.database.task(&task_id).unwrap().status, "running");
        assert_eq!(agent.due_run_reports().unwrap().len(), 1);

        let matching = RunControl {
            run_id: RUN_ID.into(),
            attempt: 3,
            cancel_requested_at: "2026-09-01T12:00:00+08:00".into(),
        };
        assert_eq!(
            agent
                .apply_run_controls(std::slice::from_ref(&matching))
                .unwrap(),
            1
        );
        assert_eq!(agent.database.task(&task_id).unwrap().status, "stopped");
        assert_eq!(agent.apply_run_controls(&[matching]).unwrap(), 0);
        let reports = agent.due_run_reports().unwrap();
        assert_eq!(reports.len(), 2);
        assert_eq!(reports[0].report.status, crate::ReportRunStatus::Running);
        assert_eq!(reports[1].report.status, crate::ReportRunStatus::Cancelled);

        drop(agent);
        let reopened = Agent::open(AgentConfig {
            data_root,
            runner_path: "missing-runner".into(),
            rpc_endpoint: "local://test".into(),
            python_runtime: None,
            target: TargetPlatform::WINDOWS_X64,
            developer_mode: false,
        })
        .unwrap();
        assert_eq!(reopened.due_run_reports().unwrap().len(), 2);
    }

    #[test]
    fn cancellation_without_a_local_task_enqueues_cancelled_safely() {
        const RUN_ID: &str = "c765258c-d755-41f6-8612-9eb7f1a9782b";
        let directory = tempdir().unwrap();
        let agent = Agent::open(AgentConfig {
            data_root: directory.path().join("agent"),
            runner_path: "missing-runner".into(),
            rpc_endpoint: "local://test".into(),
            python_runtime: None,
            target: TargetPlatform::WINDOWS_X64,
            developer_mode: false,
        })
        .unwrap();
        agent
            .record_remote_claim(&RunClaim {
                run_id: RUN_ID.into(),
                attempt: 1,
                app_id: "approval-test".into(),
                version: "1.0.0".into(),
                args: vec![],
                requires_elevation: true,
            })
            .unwrap();
        let control = RunControl {
            run_id: RUN_ID.into(),
            attempt: 1,
            cancel_requested_at: "2026-09-01T04:00:00Z".into(),
        };
        assert_eq!(agent.apply_run_controls(&[control]).unwrap(), 1);
        let reports = agent.due_run_reports().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].report.status, crate::ReportRunStatus::Cancelled);
    }

    #[test]
    fn failed_activation_removes_new_version_and_preserves_empty_index() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("app.awpkg");
        let mut manifest = AppletManifest {
            schema_version: 1,
            app_id: "rollback-app".into(),
            version: semver::Version::new(1, 0, 0),
            artifacts: vec![ManifestArtifact {
                name: "runtime".into(),
                file_name: "app.awpkg".into(),
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
                key_id: "test".into(),
                value: "x".repeat(64),
            },
            kind: ManifestKind::Desktop,
            name: "Rollback".into(),
            description: String::new(),
            runtimes: vec![RuntimeSpec {
                platform: TargetPlatform::WINDOWS_X64,
                artifact: "runtime".into(),
                entry: "main.py".into(),
                runtime: RuntimeKind::Python {
                    python: "3.12".into(),
                },
            }],
            dependencies: vec![],
            capabilities: vec![],
            run_mode: RunMode::Parallel,
            min_host_version: semver::Version::new(0, 1, 0),
        };
        let file = File::create(&package).unwrap();
        let mut zip = ZipWriter::new(file);
        zip.start_file("main.py", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"print('ok')").unwrap();
        zip.finish().unwrap();
        let digest = hex::encode(sha256_file(&package).unwrap());
        manifest.artifacts[0].size = fs::metadata(&package).unwrap().len();
        manifest.artifacts[0].sha256 = digest.clone();
        manifest.integrity.digest = manifest.artifact_set_integrity_digest().unwrap();
        let agent = Agent::open(AgentConfig {
            data_root: directory.path().join("agent"),
            runner_path: "missing-runner".into(),
            rpc_endpoint: "local://test".into(),
            python_runtime: None,
            target: TargetPlatform::WINDOWS_X64,
            developer_mode: false,
        })
        .unwrap();
        let request = InstallRequest {
            package_path: package,
            attestation: ArtifactAttestation {
                sha256: digest,
                signature: "test".into(),
                key_id: "test".into(),
            },
            manifest,
        };
        let error = agent
            .install_signed_with_hook(&request, &AcceptSignature, &RejectActivation)
            .unwrap_err();
        assert!(
            matches!(error, AgentError::State(message) if message == "simulated activation failure")
        );
        assert!(agent.database.installed().unwrap().is_empty());
        assert!(!agent
            .config
            .data_root
            .join("apps/rollback-app/1.0.0")
            .exists());

        let mut mismatched_manifest = request.manifest.clone();
        mismatched_manifest.artifacts[0].sha256 = "c".repeat(64);
        mismatched_manifest.integrity.digest =
            mismatched_manifest.artifact_set_integrity_digest().unwrap();
        let mismatched_request = InstallRequest {
            package_path: request.package_path.clone(),
            attestation: request.attestation.clone(),
            manifest: mismatched_manifest,
        };
        assert!(matches!(
            agent.install_signed(&mismatched_request, &AcceptSignature),
            Err(AgentError::DigestMismatch)
        ));

        let metadata_root = directory.path().join("untrusted-metadata");
        fs::create_dir(&metadata_root).unwrap();
        fs::write(metadata_root.join("main.py"), b"print('ok')").unwrap();
        let mut conflicting_metadata = request.manifest.clone();
        conflicting_metadata
            .capabilities
            .push(Capability::Notifications);
        fs::write(
            metadata_root.join("applet.json"),
            serde_json::to_vec(&conflicting_metadata).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            validate_extracted_release(
                &metadata_root,
                &request.manifest,
                TargetPlatform::WINDOWS_X64
            ),
            Err(AgentError::AccessDenied(_))
        ));
    }
}
