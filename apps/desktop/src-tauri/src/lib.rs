use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context};
use awesome_workflow_agent::{
    AgentClient, AgentLocaleSettings, AgentSnapshot, AppletManifest, ArtifactAttestation,
    InstalledApplet, RunOutcome, ScheduleSnapshot, TaskRecord,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

mod auth;

use auth::{
    AuthError, AuthProviderDescriptor, AuthenticatedApiInput, AuthenticatedApiResponse,
    DesktopAuth, DesktopLocale, DesktopSession,
};

/// The Tauri process is deliberately a management client. The durable Agent owns all
/// installation, execution, lease and schedule state and survives this process exiting.
struct DesktopState {
    agent: AgentClient,
    web_ui_windows: Arc<Mutex<HashMap<String, String>>>,
}

impl DesktopState {
    fn new(agent: AgentClient) -> Self {
        Self {
            agent,
            web_ui_windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct DesktopAuthState(Arc<DesktopAuth>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallSignedPackageInput {
    package_path: PathBuf,
    sha256: String,
    signature: String,
    key_id: String,
    manifest: AppletManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunAppletInput {
    app_id: String,
    version: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollDeviceInput {
    workspace_id: String,
    name: String,
    locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopLocaleInput {
    locale: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopPasswordLoginInput {
    email: String,
    password: String,
    locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetLocaleInput {
    locale: String,
    fallback_locales: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCommandError {
    code: &'static str,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrolledDevice {
    device_id: String,
    name: String,
    os: awesome_workflow_agent::DesktopOs,
    arch: awesome_workflow_agent::DesktopArch,
    agent_version: String,
    api_base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "runtime", rename_all = "kebab-case")]
enum PublicRunOutcome {
    Process { task: TaskRecord },
    WebUi { task: TaskRecord },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedSigningKey {
    key_id: String,
    public_key: String,
}

const AUTHORIZATION_LEASE_KEY_ID_ENV: &str = "AW_AUTHORIZATION_LEASE_KEY_ID";
const AUTHORIZATION_LEASE_PUBLIC_KEY_ENV: &str = "AW_AUTHORIZATION_LEASE_PUBLIC_KEY";
const AUTHORIZATION_LEASE_KEY_RESOURCE: &str = "trusted-authorization-lease-public-key.json";

#[tauri::command]
fn agent_snapshot(state: State<'_, DesktopState>) -> Result<AgentSnapshot, DesktopCommandError> {
    state
        .agent
        .snapshot()
        .map_err(|error| command_error("agent_snapshot_failed", error))
}

#[tauri::command]
async fn agent_set_locale(
    state: State<'_, DesktopState>,
    input: SetLocaleInput,
) -> Result<AgentLocaleSettings, DesktopCommandError> {
    let agent = state.agent.clone();
    tauri::async_runtime::spawn_blocking(move || {
        agent.set_locale(input.locale, input.fallback_locales)
    })
    .await
    .map_err(|error| command_error("locale_sync_failed", error))?
    .map_err(|error| command_error("locale_sync_failed", error))
}

#[tauri::command]
fn validate_development_applet(
    state: State<'_, DesktopState>,
    path: PathBuf,
) -> Result<AppletManifest, DesktopCommandError> {
    state
        .agent
        .validate_development_applet(path)
        .map_err(|error| command_error("applet_validation_failed", error))
}

#[tauri::command]
fn register_development_applet(
    state: State<'_, DesktopState>,
    path: PathBuf,
) -> Result<InstalledApplet, DesktopCommandError> {
    state
        .agent
        .register_development_applet(path)
        .map_err(|error| command_error("development_applet_registration_failed", error))
}

#[tauri::command]
fn install_signed_package(
    state: State<'_, DesktopState>,
    input: InstallSignedPackageInput,
) -> Result<InstalledApplet, DesktopCommandError> {
    state
        .agent
        .install_signed_package(
            input.package_path,
            ArtifactAttestation {
                sha256: input.sha256,
                signature: input.signature,
                key_id: input.key_id,
            },
            input.manifest,
        )
        .map_err(|error| command_error("signed_package_install_failed", error))
}

#[tauri::command]
fn uninstall_applet(
    state: State<'_, DesktopState>,
    app_id: String,
    version: String,
) -> Result<(), DesktopCommandError> {
    state
        .agent
        .uninstall_applet(app_id, version)
        .map_err(|error| command_error("applet_uninstall_failed", error))
}

#[tauri::command]
async fn run_applet(
    app: AppHandle,
    state: State<'_, DesktopState>,
    input: RunAppletInput,
) -> Result<PublicRunOutcome, DesktopCommandError> {
    let agent = state.agent.clone();
    let run_agent = agent.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_agent.run_applet(input.app_id, input.version, input.args)
    })
    .await
    .map_err(|error| command_error("applet_run_failed", error))?
    .map_err(|error| command_error("applet_run_failed", error))?;

    match outcome {
        RunOutcome::Process { task, lease: _ } => Ok(PublicRunOutcome::Process { task }),
        RunOutcome::WebUi { task, launch_url } => {
            let task_id = task.task_id.clone();
            if let Err(error) = open_web_ui_window(
                &app,
                &agent,
                Arc::clone(&state.web_ui_windows),
                &task,
                &launch_url,
            ) {
                return Err(command_error(
                    "web_ui_launch_failed",
                    compensate_failed_web_ui_launch(&agent, &task_id, error),
                ));
            }
            Ok(PublicRunOutcome::WebUi { task })
        }
    }
}

#[tauri::command]
async fn stop_task(
    app: AppHandle,
    state: State<'_, DesktopState>,
    task_id: String,
) -> Result<(), DesktopCommandError> {
    let agent = state.agent.clone();
    let stop_agent = agent.clone();
    let stop_task_id = task_id.clone();
    tauri::async_runtime::spawn_blocking(move || stop_agent.stop_task(stop_task_id))
        .await
        .map_err(|error| command_error("task_stop_failed", error))?
        .map_err(|error| command_error("task_stop_failed", error))?;

    let label = state
        .web_ui_windows
        .lock()
        .map_err(|_| command_error("task_stop_failed", "Web UI window registry is unavailable"))?
        .remove(&task_id);
    if let Some(label) = label {
        if let Some(window) = app.get_webview_window(&label) {
            window.destroy().map_err(|_| {
                command_error(
                    "task_stop_failed",
                    "Task stopped, but its Web UI window could not be closed",
                )
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
fn read_task_log(
    state: State<'_, DesktopState>,
    task_id: String,
) -> Result<String, DesktopCommandError> {
    state
        .agent
        .read_task_log(task_id)
        .map_err(|error| command_error("task_log_read_failed", error))
}

#[tauri::command]
fn apply_schedule_snapshot(
    state: State<'_, DesktopState>,
    snapshot: ScheduleSnapshot,
) -> Result<bool, DesktopCommandError> {
    state
        .agent
        .apply_schedule_snapshot(snapshot)
        .map_err(|error| command_error("schedule_apply_failed", error))
}

#[tauri::command]
fn mark_schedule_offline(state: State<'_, DesktopState>) -> Result<(), DesktopCommandError> {
    state
        .agent
        .mark_schedule_offline()
        .map_err(|error| command_error("schedule_offline_failed", error))
}

#[tauri::command]
async fn desktop_session_current(
    state: State<'_, DesktopAuthState>,
    input: DesktopLocaleInput,
) -> Result<Option<DesktopSession>, DesktopCommandError> {
    let auth = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || auth.current(&input.locale))
        .await
        .map_err(|error| command_error("session_restore_failed", error))?
        .map_err(|error| command_error(auth_error_code(&error), error))
}

#[tauri::command]
async fn desktop_auth_providers(
    state: State<'_, DesktopAuthState>,
    input: DesktopLocaleInput,
) -> Result<Vec<AuthProviderDescriptor>, DesktopCommandError> {
    let auth = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || auth.providers(&input.locale))
        .await
        .map_err(|error| command_error("auth_providers_failed", error))?
        .map_err(|error| command_error(auth_error_code(&error), error))
}

#[tauri::command]
async fn desktop_session_login(
    state: State<'_, DesktopAuthState>,
    input: DesktopLocaleInput,
) -> Result<DesktopSession, DesktopCommandError> {
    let auth = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || auth.login(&input.locale))
        .await
        .map_err(|error| command_error("sign_in_failed", error))?
        .map_err(|error| command_error(auth_error_code(&error), error))
}

#[tauri::command]
async fn desktop_session_password_login(
    state: State<'_, DesktopAuthState>,
    input: DesktopPasswordLoginInput,
) -> Result<DesktopSession, DesktopCommandError> {
    let auth = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        auth.login_password(&input.email, &input.password, &input.locale)
    })
    .await
    .map_err(|error| command_error("sign_in_failed", error))?
    .map_err(|error| command_error(auth_error_code(&error), error))
}

#[tauri::command]
async fn desktop_session_logout(
    state: State<'_, DesktopAuthState>,
    input: DesktopLocaleInput,
) -> Result<(), DesktopCommandError> {
    let auth = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || auth.logout(&input.locale))
        .await
        .map_err(|error| command_error("sign_out_failed", error))?
        .map_err(|error| command_error(auth_error_code(&error), error))
}

#[tauri::command]
async fn desktop_api_request(
    state: State<'_, DesktopAuthState>,
    input: AuthenticatedApiInput,
) -> Result<AuthenticatedApiResponse, DesktopCommandError> {
    let auth = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || auth.authenticated_request(input))
        .await
        .map_err(|error| command_error("api_request_failed", error))?
        .map_err(|error| command_error(auth_error_code(&error), error))
}

#[tauri::command]
async fn desktop_device_enroll(
    desktop: State<'_, DesktopState>,
    auth: State<'_, DesktopAuthState>,
    input: EnrollDeviceInput,
) -> Result<EnrolledDevice, DesktopCommandError> {
    let locale = DesktopLocale::parse(&input.locale)
        .map_err(|error| command_error(auth_error_code(&error), error))?;
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.len() > 120 {
        return Err(command_error(
            "device_name_invalid",
            "Device name must contain 1-120 characters",
        ));
    }
    let agent = desktop.agent.clone();
    let auth = Arc::clone(&auth.0);
    tauri::async_runtime::spawn_blocking(move || {
        if agent
            .snapshot()
            .map_err(|error| command_error("device_enrollment_failed", error))?
            .device
            .is_some()
        {
            return Err(command_error(
                "agent_already_enrolled",
                "This Agent is already enrolled",
            ));
        }
        let preparation = agent
            .prepare_device_enrollment()
            .map_err(|error| command_error("device_enrollment_failed", error))?;
        let body = serde_json::json!({
            "workspaceId": input.workspace_id,
            "name": name,
            "os": preparation.os,
            "arch": preparation.arch,
            "agentVersion": preparation.agent_version,
            "publicKeyThumbprint": preparation.public_key_thumbprint,
        });
        let api_base_url = auth.api_base_url();
        let secret = auth
            .register_device(body, locale.as_str())
            .map_err(|error| command_error(auth_error_code(&error), error))?;
        let device_id = secret.device_id;
        agent
            .complete_device_enrollment(api_base_url.clone(), device_id.clone(), secret.credential)
            .map_err(|error| command_error("device_enrollment_failed", error))?;
        Ok(EnrolledDevice {
            device_id,
            name,
            os: preparation.os,
            arch: preparation.arch,
            agent_version: preparation.agent_version,
            api_base_url,
        })
    })
    .await
    .map_err(|error| command_error("device_enrollment_failed", error))?
}

#[derive(Clone)]
struct LoopbackOrigin {
    scheme: String,
    host: String,
    port: u16,
}

impl LoopbackOrigin {
    fn parse_launch_url(value: &str) -> Result<(Url, Self), String> {
        let url =
            Url::parse(value).map_err(|_| "Agent returned an invalid Web UI URL".to_owned())?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_none()
            || url.query().is_some()
        {
            return Err("Agent returned a Web UI URL outside the loopback boundary".to_owned());
        }
        let port = url.port().expect("port checked above");
        Ok((
            url,
            Self {
                scheme: "http".to_owned(),
                host: "127.0.0.1".to_owned(),
                port,
            },
        ))
    }

    fn contains(&self, candidate: &Url) -> bool {
        candidate.scheme() == self.scheme
            && candidate.host_str() == Some(self.host.as_str())
            && candidate.port() == Some(self.port)
            && candidate.username().is_empty()
            && candidate.password().is_none()
    }
}

fn open_web_ui_window(
    app: &AppHandle,
    agent: &AgentClient,
    web_ui_windows: Arc<Mutex<HashMap<String, String>>>,
    task: &TaskRecord,
    launch_url: &str,
) -> Result<(), String> {
    let (url, origin) = LoopbackOrigin::parse_launch_url(launch_url)?;
    let label = format!("applet-{}", task.task_id);
    if app.get_webview_window(&label).is_some() {
        return Err("A Web UI window already exists for this task".to_owned());
    }

    let navigation_origin = origin.clone();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(task.app_id.clone())
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .visible(false)
        .incognito(true)
        .on_navigation(move |candidate| navigation_origin.contains(candidate))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| "Failed to create the Web UI window".to_owned())?;

    {
        let mut windows = match web_ui_windows.lock() {
            Ok(windows) => windows,
            Err(_) => {
                let _ = window.destroy();
                return Err("Web UI window registry is unavailable".to_owned());
            }
        };
        if windows.contains_key(&task.task_id) {
            let _ = window.destroy();
            return Err("A Web UI window is already registered for this task".to_owned());
        }
        windows.insert(task.task_id.clone(), label.clone());
    }

    let close_task_id = task.task_id.clone();
    let close_agent = agent.clone();
    let close_windows = Arc::clone(&web_ui_windows);
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let should_stop = close_windows
                .lock()
                .map(|mut windows| windows.remove(&close_task_id).is_some())
                .unwrap_or(true);
            if should_stop {
                let agent = close_agent.clone();
                let task_id = close_task_id.clone();
                thread::spawn(move || {
                    let _ = agent.stop_task(task_id);
                });
            }
        }
    });

    if window.show().is_err() {
        if let Ok(mut windows) = web_ui_windows.lock() {
            windows.remove(&task.task_id);
        }
        let _ = window.destroy();
        return Err("Failed to show the Web UI window".to_owned());
    }
    Ok(())
}

fn compensate_failed_web_ui_launch(agent: &AgentClient, task_id: &str, error: String) -> String {
    match agent.stop_task(task_id.to_owned()) {
        Ok(()) => error,
        Err(stop_error) => format!("{error}; compensating task stop failed: {stop_error}"),
    }
}

fn command_error(code: &'static str, error: impl std::fmt::Display) -> DesktopCommandError {
    DesktopCommandError {
        code,
        detail: error.to_string(),
    }
}

fn auth_error_code(error: &AuthError) -> &'static str {
    match error {
        AuthError::CredentialUnavailable => "credential_unavailable",
        AuthError::InvalidCredential => "invalid_credential",
        AuthError::InvalidCredentials => "invalid_credentials",
        AuthError::PasswordAuthenticationDisabled => "password_auth_disabled",
        AuthError::InvalidResponse => "invalid_auth_response",
        AuthError::Rejected(_) => "auth_rejected",
        AuthError::InvalidApiBase => "invalid_api_base",
        AuthError::InvalidCallback => "invalid_callback",
        AuthError::CallbackTimeout => "callback_timeout",
        AuthError::BrowserUnavailable => "browser_unavailable",
        AuthError::EndpointNotAllowed => "endpoint_not_allowed",
        AuthError::ResponseTooLarge => "response_too_large",
        AuthError::Transport => "auth_transport_failed",
        AuthError::UnsupportedPlatform => "unsupported_platform",
        AuthError::UnsupportedLocale => "unsupported_locale",
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let client = connect_or_launch_agent(app.handle())?;
            app.manage(DesktopState::new(client));
            app.manage(DesktopAuthState(Arc::new(DesktopAuth::production()?)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_snapshot,
            agent_set_locale,
            validate_development_applet,
            register_development_applet,
            install_signed_package,
            uninstall_applet,
            run_applet,
            stop_task,
            read_task_log,
            apply_schedule_snapshot,
            mark_schedule_offline,
            desktop_session_current,
            desktop_auth_providers,
            desktop_session_login,
            desktop_session_password_login,
            desktop_session_logout,
            desktop_api_request,
            desktop_device_enroll,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Awesome Workflow desktop host");
}

fn connect_or_launch_agent(app: &AppHandle) -> anyhow::Result<AgentClient> {
    let data_root = agent_data_root(app)?;
    let client = AgentClient::for_data_root(&data_root).context("initialize Agent client")?;
    if client.snapshot().is_ok() {
        return Ok(client);
    }

    let agent_path = resolve_binary(app, "awesome-workflow-agent", "AW_AGENT_PATH")?;
    let runner_path = resolve_binary(app, "awesome-workflow-runner", "AW_RUNNER_PATH")?;
    launch_detached_agent(app, &data_root, &agent_path, &runner_path)?;

    let mut last_error = None;
    for _ in 0..40 {
        match client.snapshot() {
            Ok(_) => return Ok(client),
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(anyhow!(
        "Agent did not become ready: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown startup error".into())
    ))
}

fn agent_data_root(app: &AppHandle) -> anyhow::Result<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("AW_AGENT_DATA_ROOT") {
            return Ok(PathBuf::from(path));
        }
    }
    Ok(app
        .path()
        .app_data_dir()
        .context("resolve application data directory")?
        .join("agent"))
}

fn resolve_binary(app: &AppHandle, name: &str, debug_override: &str) -> anyhow::Result<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os(debug_override) {
            return require_file(PathBuf::from(path), name);
        }
    }

    let file_name = executable_name(name);
    let executable_directory = std::env::current_exe()
        .context("resolve desktop executable")?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("desktop executable has no parent directory"))?;
    let resource_directory = app
        .path()
        .resource_dir()
        .context("resolve resource directory")?;
    let candidates = [
        executable_directory.join(&file_name),
        resource_directory.join("sidecars").join(&file_name),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| anyhow!("{name} sidecar is missing from the desktop bundle"))
}

fn require_file(path: PathBuf, label: &str) -> anyhow::Result<PathBuf> {
    let path = path
        .canonicalize()
        .with_context(|| format!("resolve {label} override"))?;
    if !path.is_file() {
        return Err(anyhow!("{label} override is not a file"));
    }
    Ok(path)
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn launch_detached_agent(
    app: &AppHandle,
    data_root: &Path,
    agent_path: &Path,
    runner_path: &Path,
) -> anyhow::Result<()> {
    fs::create_dir_all(data_root).context("create Agent data directory")?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_root.join("agent.log"))
        .context("open Agent log")?;
    let error_log = log.try_clone().context("clone Agent log handle")?;

    let mut command = Command::new(agent_path);
    command
        .env_clear()
        .env("AW_AGENT_DATA_ROOT", data_root)
        .env("AW_RUNNER_PATH", runner_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));

    if let Some(python) = bundled_python_runtime(app)? {
        command.env("AW_PYTHON_RUNTIME", python);
    }
    if let Some(key) = trusted_signing_key(app)? {
        command
            .env("AW_SIGNING_KEY_ID", key.key_id)
            .env("AW_SIGNING_PUBLIC_KEY", key.public_key);
    }
    if let Some(key) = trusted_authorization_lease_key(app)? {
        configure_authorization_lease_key_environment(&mut command, &key);
    }
    command.env(
        "AW_DEVELOPER_MODE",
        if cfg!(debug_assertions) { "1" } else { "0" },
    );
    detach(&mut command);
    command.spawn().context("launch persistent Agent sidecar")?;
    Ok(())
}

fn bundled_python_runtime(app: &AppHandle) -> anyhow::Result<Option<PathBuf>> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("AW_PYTHON_RUNTIME") {
            return require_file(PathBuf::from(path), "Python runtime").map(Some);
        }
    }
    let resource_directory = app
        .path()
        .resource_dir()
        .context("resolve resource directory")?;
    let name = if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    };
    let candidate = resource_directory.join("runtime").join("python").join(name);
    Ok(candidate.is_file().then_some(candidate))
}

fn trusted_signing_key(app: &AppHandle) -> anyhow::Result<Option<TrustedSigningKey>> {
    if cfg!(debug_assertions) {
        match (
            std::env::var("AW_SIGNING_KEY_ID"),
            std::env::var("AW_SIGNING_PUBLIC_KEY"),
        ) {
            (Ok(key_id), Ok(public_key)) => {
                return Ok(Some(TrustedSigningKey { key_id, public_key }))
            }
            (Err(_), Err(_)) => {}
            _ => {
                return Err(anyhow!(
                    "both signing key development overrides are required"
                ))
            }
        }
    } else {
        match (
            option_env!("AW_SIGNING_KEY_ID"),
            option_env!("AW_SIGNING_PUBLIC_KEY"),
        ) {
            (Some(key_id), Some(public_key)) => {
                return Ok(Some(TrustedSigningKey {
                    key_id: key_id.to_owned(),
                    public_key: public_key.to_owned(),
                }))
            }
            (None, None) => {}
            _ => return Err(anyhow!("release build embedded an incomplete signing key")),
        }
    }
    let resource_directory = app
        .path()
        .resource_dir()
        .context("resolve resource directory")?;
    let path = resource_directory.join("trusted-signing-key.json");
    if !path.is_file() {
        return Ok(None);
    }
    let key = serde_json::from_slice(&fs::read(path).context("read trusted signing key")?)
        .context("parse trusted signing key")?;
    Ok(Some(key))
}

fn trusted_authorization_lease_key(app: &AppHandle) -> anyhow::Result<Option<TrustedSigningKey>> {
    #[cfg(debug_assertions)]
    {
        let development_key = trusted_authorization_lease_key_pair(
            optional_unicode_environment(AUTHORIZATION_LEASE_KEY_ID_ENV)?,
            optional_unicode_environment(AUTHORIZATION_LEASE_PUBLIC_KEY_ENV)?,
            "both authorization lease key development overrides are required",
        )?;
        if development_key.is_some() {
            return Ok(development_key);
        }
    }

    #[cfg(not(debug_assertions))]
    {
        let embedded_key = trusted_authorization_lease_key_pair(
            option_env!("AW_AUTHORIZATION_LEASE_KEY_ID").map(str::to_owned),
            option_env!("AW_AUTHORIZATION_LEASE_PUBLIC_KEY").map(str::to_owned),
            "release build embedded an incomplete authorization lease key",
        )?;
        if embedded_key.is_some() {
            return Ok(embedded_key);
        }
    }

    let resource_directory = app
        .path()
        .resource_dir()
        .context("resolve resource directory")?;
    let path = resource_directory.join(AUTHORIZATION_LEASE_KEY_RESOURCE);
    if !path.is_file() {
        return Ok(None);
    }
    parse_trusted_authorization_lease_public_key(
        &fs::read(path).context("read trusted authorization lease public key")?,
    )
}

fn parse_trusted_authorization_lease_public_key(
    contents: &[u8],
) -> anyhow::Result<Option<TrustedSigningKey>> {
    let key: TrustedSigningKey =
        serde_json::from_slice(contents).context("parse trusted authorization lease public key")?;
    trusted_authorization_lease_key_pair(
        Some(key.key_id),
        Some(key.public_key),
        "trusted authorization lease key resource is incomplete",
    )
}

fn optional_unicode_environment(name: &str) -> anyhow::Result<Option<String>> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err(anyhow!("{name} must contain valid Unicode text"))
        }
    }
}

fn trusted_authorization_lease_key_pair(
    key_id: Option<String>,
    public_key: Option<String>,
    incomplete_message: &'static str,
) -> anyhow::Result<Option<TrustedSigningKey>> {
    match (key_id, public_key) {
        (None, None) => Ok(None),
        (Some(key_id), Some(public_key)) => {
            let key_id = key_id.trim().to_owned();
            let public_key = public_key.trim().to_owned();
            if key_id.is_empty() || public_key.is_empty() {
                return Err(anyhow!(incomplete_message));
            }
            Ok(Some(TrustedSigningKey { key_id, public_key }))
        }
        _ => Err(anyhow!(incomplete_message)),
    }
}

fn configure_authorization_lease_key_environment(command: &mut Command, key: &TrustedSigningKey) {
    command
        .env(AUTHORIZATION_LEASE_KEY_ID_ENV, &key.key_id)
        .env(AUTHORIZATION_LEASE_PUBLIC_KEY_ENV, &key.public_key);
}

#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> TaskRecord {
        TaskRecord {
            task_id: "648b1920-1278-47da-9cea-ab08d8c89a4e".into(),
            app_id: "sample-applet".into(),
            version: "1.2.3".into(),
            status: "running".into(),
            pid: None,
            log_path: PathBuf::from("task.log"),
            started_at: 1,
            finished_at: None,
        }
    }

    #[test]
    fn public_run_outcomes_never_serialize_runtime_authority() {
        for outcome in [
            PublicRunOutcome::Process { task: task() },
            PublicRunOutcome::WebUi { task: task() },
        ] {
            let encoded = serde_json::to_string(&outcome).unwrap();
            assert!(encoded.contains("sample-applet"));
            assert!(!encoded.contains("lease"));
            assert!(!encoded.contains("launchUrl"));
            assert!(!encoded.contains("aw-task"));
        }
    }

    #[test]
    fn web_ui_navigation_is_confined_to_the_exact_loopback_origin() {
        let (_, origin) = LoopbackOrigin::parse_launch_url(
            "http://127.0.0.1:43123/index.html#aw-task=opaque-bootstrap",
        )
        .unwrap();
        assert!(origin.contains(&Url::parse("http://127.0.0.1:43123/assets/app.js").unwrap()));
        assert!(!origin.contains(&Url::parse("http://127.0.0.1:43124/index.html").unwrap()));
        assert!(!origin.contains(&Url::parse("http://localhost:43123/index.html").unwrap()));
        assert!(!origin.contains(&Url::parse("https://127.0.0.1:43123/index.html").unwrap()));
        assert!(!origin.contains(&Url::parse("http://user@127.0.0.1:43123/index.html").unwrap()));
    }

    #[test]
    fn web_ui_launch_rejects_non_loopback_or_ambiguous_urls() {
        for value in [
            "https://127.0.0.1:43123/index.html",
            "http://localhost:43123/index.html",
            "http://127.0.0.1/index.html",
            "http://user@127.0.0.1:43123/index.html",
            "http://127.0.0.1:43123/index.html?token=unexpected",
            "not a URL",
        ] {
            assert!(LoopbackOrigin::parse_launch_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn static_capability_is_scoped_only_to_the_management_window() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("webviews").is_none());
    }

    #[test]
    fn password_login_permission_is_scoped_only_to_the_local_management_window() {
        use tauri::utils::{
            acl::{resolved::Resolved, ExecutionContext},
            platform::Target,
        };

        let manifests =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let capabilities =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        let resolved = Resolved::resolve(&manifests, capabilities, Target::current()).unwrap();
        let command = "desktop_session_password_login";
        assert!(resolved.has_app_acl);
        let grants = resolved
            .allowed_commands
            .get(command)
            .expect("the management window must be allowed to invoke password login");
        assert_eq!(grants.len(), 1);
        let grant = &grants[0];
        assert_eq!(grant.context, ExecutionContext::Local);
        assert_eq!(
            grant
                .windows
                .iter()
                .map(|pattern| pattern.as_str())
                .collect::<Vec<_>>(),
            vec!["main"]
        );
        assert!(grant.webviews.is_empty());
        assert!(!resolved.denied_commands.contains_key(command));
    }

    #[test]
    fn locale_command_accepts_only_the_explicit_locale_contract() {
        let input: SetLocaleInput = serde_json::from_value(serde_json::json!({
            "locale": "zh-CN",
            "fallbackLocales": ["en-US"]
        }))
        .unwrap();
        assert_eq!(input.locale, "zh-CN");
        assert_eq!(input.fallback_locales, vec!["en-US"]);

        assert!(serde_json::from_value::<SetLocaleInput>(serde_json::json!({
            "locale": "zh-CN",
            "fallbackLocales": ["en-US"],
            "accessToken": "must-not-cross"
        }))
        .is_err());
    }

    #[test]
    fn authorization_lease_key_pair_requires_both_values() {
        let error = trusted_authorization_lease_key_pair(
            Some("lease-key-1".into()),
            None,
            "authorization lease key pair is incomplete",
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "authorization lease key pair is incomplete"
        );

        let error = trusted_authorization_lease_key_pair(
            None,
            Some("public-key".into()),
            "authorization lease key pair is incomplete",
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "authorization lease key pair is incomplete"
        );
    }

    #[test]
    fn absent_authorization_lease_key_pair_keeps_agent_fail_closed() {
        assert!(trusted_authorization_lease_key_pair(
            None,
            None,
            "authorization lease key pair is incomplete",
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn authorization_lease_key_pair_is_forwarded_to_the_agent_command() {
        let key = trusted_authorization_lease_key_pair(
            Some(" lease-key-1 ".into()),
            Some(" public-key ".into()),
            "authorization lease key pair is incomplete",
        )
        .unwrap()
        .unwrap();
        let mut command = Command::new("unused-test-program");

        configure_authorization_lease_key_environment(&mut command, &key);

        let environment = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(
            environment.get(AUTHORIZATION_LEASE_KEY_ID_ENV),
            Some(&Some("lease-key-1".into()))
        );
        assert_eq!(
            environment.get(AUTHORIZATION_LEASE_PUBLIC_KEY_ENV),
            Some(&Some("public-key".into()))
        );
    }

    #[test]
    fn authorization_lease_public_key_resource_accepts_only_public_fields() {
        let key = parse_trusted_authorization_lease_public_key(
            br#"{"keyId":"lease-key-1","publicKey":"public-key"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(key.key_id, "lease-key-1");
        assert_eq!(key.public_key, "public-key");

        let error = parse_trusted_authorization_lease_public_key(
            br#"{"keyId":"lease-key-1","publicKey":"public-key","privateKey":"must-not-load"}"#,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("parse trusted authorization lease public key"));
    }
}
