use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

mod launchd;

pub use launchd::{launchd_definition_path, render_launchd_plist, LaunchdJobKind};

pub const HELPER_PROTOCOL_VERSION: u16 = 1;
const MAX_REQUEST_LIFETIME_SECONDS: u64 = 120;
const LIFECYCLE_NAME_PREFIX: &str = "AwesomeWorkflow.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperRequest {
    pub protocol_version: u16,
    pub nonce: String,
    pub expires_at: u64,
    pub application_root: PathBuf,
    pub action: LifecycleAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum LifecycleAction {
    InstallService {
        service_name: String,
        executable: PathBuf,
    },
    RemoveService {
        service_name: String,
    },
    InstallAutoStart {
        task_name: String,
        executable: PathBuf,
    },
    RemoveAutoStart {
        task_name: String,
    },
}

pub fn validate_request(
    request: &HelperRequest,
    expected_nonce: &str,
    now: u64,
) -> anyhow::Result<()> {
    if request.protocol_version != HELPER_PROTOCOL_VERSION {
        bail!("unsupported helper protocol version");
    }
    if request.expires_at <= now
        || request.expires_at.saturating_sub(now) > MAX_REQUEST_LIFETIME_SECONDS
    {
        bail!("helper request is expired or has an excessive lifetime");
    }
    if request.nonce.len() < 32
        || request
            .nonce
            .as_bytes()
            .ct_eq(expected_nonce.as_bytes())
            .unwrap_u8()
            != 1
    {
        bail!("helper nonce mismatch");
    }
    let application_root = canonicalize_application_root(&request.application_root)?;
    match &request.action {
        LifecycleAction::InstallService {
            service_name,
            executable,
        } => {
            validate_name(service_name, LIFECYCLE_NAME_PREFIX)?;
            validate_executable(&application_root, executable)?;
        }
        LifecycleAction::RemoveService { service_name } => {
            validate_name(service_name, LIFECYCLE_NAME_PREFIX)?
        }
        LifecycleAction::InstallAutoStart {
            task_name,
            executable,
        } => {
            validate_name(task_name, LIFECYCLE_NAME_PREFIX)?;
            validate_executable(&application_root, executable)?;
        }
        LifecycleAction::RemoveAutoStart { task_name } => {
            validate_name(task_name, LIFECYCLE_NAME_PREFIX)?
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn execute(request: &HelperRequest) -> anyhow::Result<()> {
    use std::process::Command;

    let status = match &request.action {
        LifecycleAction::InstallService {
            service_name,
            executable,
        } => Command::new("sc.exe")
            .args(["create", service_name, "start=", "auto", "binPath="])
            .arg(executable)
            .status()?,
        LifecycleAction::RemoveService { service_name } => Command::new("sc.exe")
            .args(["delete", service_name])
            .status()?,
        LifecycleAction::InstallAutoStart {
            task_name,
            executable,
        } => Command::new("schtasks.exe")
            .args(["/Create", "/TN", task_name, "/TR"])
            .arg(executable)
            .args(["/SC", "ONLOGON", "/RL", "LIMITED", "/F"])
            .status()?,
        LifecycleAction::RemoveAutoStart { task_name } => Command::new("schtasks.exe")
            .args(["/Delete", "/TN", task_name, "/F"])
            .status()?,
    };
    if !status.success() {
        bail!("fixed lifecycle command failed with {status}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
/// Executes only the four structured lifecycle actions through fixed launchd
/// locations and `/bin/launchctl` arguments.
///
/// This function does not acquire privileges. Launching a signed helper through
/// macOS Authorization Services is a separate, intentionally unimplemented
/// integration boundary; callers must not replace it with `sudo` or a shell.
pub fn execute(request: &HelperRequest) -> anyhow::Result<()> {
    match &request.action {
        LifecycleAction::InstallService {
            service_name,
            executable,
        } => install_launchd_job(request, service_name, executable, LaunchdJobKind::Service),
        LifecycleAction::RemoveService { service_name } => {
            remove_launchd_job(service_name, LaunchdJobKind::Service)
        }
        LifecycleAction::InstallAutoStart {
            task_name,
            executable,
        } => install_launchd_job(request, task_name, executable, LaunchdJobKind::AutoStart),
        LifecycleAction::RemoveAutoStart { task_name } => {
            remove_launchd_job(task_name, LaunchdJobKind::AutoStart)
        }
    }
}

#[cfg(target_os = "macos")]
fn install_launchd_job(
    request: &HelperRequest,
    label: &str,
    executable: &Path,
    kind: LaunchdJobKind,
) -> anyhow::Result<()> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    validate_name(label, LIFECYCLE_NAME_PREFIX)?;
    let application_root = canonicalize_application_root(&request.application_root)?;
    let executable = validate_executable(&application_root, executable)?;
    if fs::metadata(&executable)?.permissions().mode() & 0o111 == 0 {
        bail!("launchd executable is not marked executable");
    }

    let definition_path = launchd_definition_path(label, kind)?;
    let plist = render_launchd_plist(label, &executable, kind)?;
    write_new_launchd_definition(&definition_path, plist.as_bytes())?;

    let domain = launchd_domain(kind)?;
    if let Some(domain) = domain {
        if let Err(error) = bootstrap_launchd_job(&domain, &definition_path) {
            let _ = fs::remove_file(&definition_path);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_launchd_job(label: &str, kind: LaunchdJobKind) -> anyhow::Result<()> {
    use std::{fs, io::ErrorKind};

    validate_name(label, LIFECYCLE_NAME_PREFIX)?;
    let definition_path = launchd_definition_path(label, kind)?;
    if let Some(domain) = launchd_domain(kind)? {
        let target = format!("{domain}/{label}");
        if launchd_job_is_loaded(&target)? {
            run_launchctl(&["bootout", &target])?;
        }
    }
    match fs::remove_file(&definition_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| {
            format!(
                "remove fixed launchd definition {}",
                definition_path.display()
            )
        }),
    }
}

#[cfg(target_os = "macos")]
fn write_new_launchd_definition(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    use std::{
        fs::{self, OpenOptions, Permissions},
        io::{ErrorKind, Write},
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };

    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            bail!("launchd definition already exists; remove it before installing")
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("create fixed launchd definition {}", path.display()))
        }
    };

    let result = (|| -> anyhow::Result<()> {
        file.write_all(contents)?;
        file.set_permissions(Permissions::from_mode(0o644))?;
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error).context("write fixed launchd definition");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launchd_domain(kind: LaunchdJobKind) -> anyhow::Result<Option<String>> {
    use std::{fs, os::unix::fs::MetadataExt};

    match kind {
        LaunchdJobKind::Service => Ok(Some("system".into())),
        LaunchdJobKind::AutoStart => {
            let console_user_id = fs::metadata("/dev/console")
                .context("read the fixed macOS console device")?
                .uid();
            if console_user_id == 0 {
                Ok(None)
            } else {
                Ok(Some(format!("gui/{console_user_id}")))
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn bootstrap_launchd_job(domain: &str, definition_path: &Path) -> anyhow::Result<()> {
    use std::process::Command;

    let status = Command::new("/bin/launchctl")
        .arg("bootstrap")
        .arg(domain)
        .arg(definition_path)
        .status()
        .context("start fixed launchctl bootstrap action")?;
    if !status.success() {
        bail!("fixed launchctl bootstrap action failed with {status}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launchd_job_is_loaded(target: &str) -> anyhow::Result<bool> {
    use std::process::{Command, Stdio};

    Ok(Command::new("/bin/launchctl")
        .arg("print")
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("inspect fixed launchd job target")?
        .success())
}

#[cfg(target_os = "macos")]
fn run_launchctl(arguments: &[&str]) -> anyhow::Result<()> {
    use std::process::Command;

    let status = Command::new("/bin/launchctl")
        .args(arguments)
        .status()
        .context("start fixed launchctl lifecycle action")?;
    if !status.success() {
        bail!("fixed launchctl lifecycle action failed with {status}");
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn execute(_request: &HelperRequest) -> anyhow::Result<()> {
    bail!("elevated lifecycle helper rejects unsupported platforms; only Windows and macOS are allowed")
}

fn canonicalize_application_root(application_root: &Path) -> anyhow::Result<PathBuf> {
    let application_root = application_root
        .canonicalize()
        .context("canonicalize application root")?;
    if !application_root.is_dir() {
        bail!("installed application root is not a directory");
    }
    Ok(application_root)
}

fn validate_executable(application_root: &Path, executable: &Path) -> anyhow::Result<PathBuf> {
    let executable = executable
        .canonicalize()
        .context("canonicalize lifecycle executable")?;
    if !executable.starts_with(application_root) || !executable.is_file() {
        bail!("lifecycle executable is outside the installed application root");
    }
    Ok(executable)
}

fn validate_name(value: &str, prefix: &str) -> anyhow::Result<()> {
    if !value.starts_with(prefix)
        || value.len() > 96
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        bail!("lifecycle name is outside the Awesome Workflow namespace");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn helper_rejects_unknown_or_generic_command_shape() {
        let generic = r#"{
          "protocolVersion":1,
          "nonce":"abcdefghijklmnopqrstuvwxyz012345",
          "expiresAt":100,
          "applicationRoot":"C:/app",
          "action":{"kind":"run-command","command":"powershell.exe"}
        }"#;
        assert!(serde_json::from_str::<HelperRequest>(generic).is_err());
    }

    #[test]
    fn helper_rejects_lifecycle_binary_outside_application_root() {
        let directory = tempdir().unwrap();
        let app_root = directory.path().join("app");
        fs::create_dir(&app_root).unwrap();
        let outside = directory.path().join("outside.exe");
        fs::write(&outside, b"binary").unwrap();
        let nonce = "abcdefghijklmnopqrstuvwxyz012345";
        let request = HelperRequest {
            protocol_version: HELPER_PROTOCOL_VERSION,
            nonce: nonce.into(),
            expires_at: 110,
            application_root: app_root,
            action: LifecycleAction::InstallService {
                service_name: "AwesomeWorkflow.Agent".into(),
                executable: outside,
            },
        };
        assert!(validate_request(&request, nonce, 100).is_err());
    }

    #[test]
    fn helper_rejects_replayed_or_mismatched_nonce() {
        let directory = tempdir().unwrap();
        let executable = directory.path().join("agent.exe");
        fs::write(&executable, b"binary").unwrap();
        let request = HelperRequest {
            protocol_version: HELPER_PROTOCOL_VERSION,
            nonce: "abcdefghijklmnopqrstuvwxyz012345".into(),
            expires_at: 110,
            application_root: directory.path().to_path_buf(),
            action: LifecycleAction::InstallAutoStart {
                task_name: "AwesomeWorkflow.Agent".into(),
                executable,
            },
        };
        assert!(validate_request(&request, "different-nonce-value-0123456789", 100).is_err());
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn unsupported_platform_execution_fails_closed() {
        let request = HelperRequest {
            protocol_version: HELPER_PROTOCOL_VERSION,
            nonce: "abcdefghijklmnopqrstuvwxyz012345".into(),
            expires_at: 110,
            application_root: PathBuf::from("/opt/awesome-workflow"),
            action: LifecycleAction::RemoveService {
                service_name: "AwesomeWorkflow.Agent".into(),
            },
        };

        let error = execute(&request).unwrap_err().to_string();
        assert!(error.contains("unsupported platforms"));
    }
}
