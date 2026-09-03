use std::{
    env,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::{bail, Context};
use awesome_workflow_agent::{
    authorize_runner_request, resolve_contained, RunnerRequest, RuntimeKind, RPC_PROTOCOL_VERSION,
};
use awesome_workflow_runner::filtered_environment;

fn main() -> anyhow::Result<()> {
    let request_path = request_path_from_args()?;
    let request_bytes =
        fs::read(&request_path).with_context(|| format!("read {}", request_path.display()))?;
    fs::remove_file(&request_path)
        .with_context(|| format!("remove one-time request {}", request_path.display()))?;
    let request: RunnerRequest = serde_json::from_slice(&request_bytes)?;
    validate_request(&request)?;
    authorize_runner_request(&request).context("authorize Runner launch with the Agent")?;
    let exit_code = execute(&request)?;
    std::process::exit(exit_code);
}

fn request_path_from_args() -> anyhow::Result<PathBuf> {
    let mut arguments = env::args_os().skip(1);
    match (
        arguments.next().as_deref(),
        arguments.next(),
        arguments.next(),
    ) {
        (Some(flag), Some(path), None) if flag == "--request" => Ok(path.into()),
        _ => bail!("usage: awesome-workflow-runner --request <runner-request.json>"),
    }
}

fn validate_request(request: &RunnerRequest) -> anyhow::Result<()> {
    if request.protocol_version != RPC_PROTOCOL_VERSION {
        bail!("unsupported runner protocol version");
    }
    request.manifest.validate()?;
    if request.manifest.app_id != request.app_id {
        bail!("request appId does not match manifest id");
    }
    if request.lease.len() < 32 {
        bail!("runner lease is missing or malformed");
    }
    if !matches!(request.locale.as_str(), "en-US" | "zh-CN")
        || request
            .fallback_locales
            .iter()
            .any(|locale| !matches!(locale.as_str(), "en-US" | "zh-CN"))
    {
        bail!("runner locale is unsupported");
    }
    request.manifest.runtime_for(request.target)?;
    ensure_contained_existing(&request.work_dir, &request.log_path)?;
    Ok(())
}

fn execute(request: &RunnerRequest) -> anyhow::Result<i32> {
    let runtime = request.manifest.runtime_for(request.target)?;
    let entry = resolve_contained(&request.package_dir, runtime.entry())?;
    let (program, entry_argument) = match &runtime.runtime {
        RuntimeKind::Python { .. } => {
            let interpreter = request
                .python_runtime
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Host did not provide a fixed Python runtime"))?
                .canonicalize()
                .context("canonicalize Host-managed Python runtime")?;
            if !interpreter.is_file() {
                bail!("Host-managed Python runtime is not a file");
            }
            (OsProgram::Path(interpreter), Some(entry))
        }
        RuntimeKind::Native => (OsProgram::Path(entry), None),
        RuntimeKind::WebUi { .. } => {
            bail!("web-ui runtimes are opened by the Tauri host, not the process runner")
        }
    };

    let mut log = OpenOptions::new().append(true).open(&request.log_path)?;
    writeln!(
        log,
        "[runner] starting {} task {}",
        request.app_id, request.task_id
    )?;
    let stdout = File::options().append(true).open(&request.log_path)?;
    let stderr = stdout.try_clone()?;

    let mut command = match program {
        OsProgram::Path(path) => Command::new(path),
    };
    if let Some(entry) = entry_argument {
        command.arg(entry);
    }
    command
        .args(&request.args)
        .current_dir(&request.work_dir)
        .env_clear()
        .envs(filtered_environment(env::vars_os()))
        .env("AW_PROTOCOL_VERSION", request.protocol_version.to_string())
        .env("AW_APP_ID", &request.app_id)
        .env("AW_TASK_ID", &request.task_id)
        .env("AW_LEASE", &request.lease)
        .env("AW_RPC_ENDPOINT", &request.rpc_endpoint)
        .env("AW_WORK_DIRECTORY", &request.work_dir)
        .env("AW_LOCALE", &request.locale)
        .env("AW_FALLBACK_LOCALES", request.fallback_locales.join(","))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    let status = command.status().context("start applet process")?;
    writeln!(log, "[runner] exit status {status}")?;
    Ok(status.code().unwrap_or(1))
}

enum OsProgram {
    Path(PathBuf),
}

fn ensure_contained_existing(root: &Path, candidate: &Path) -> anyhow::Result<()> {
    let root = root.canonicalize()?;
    let candidate = candidate.canonicalize()?;
    if !candidate.starts_with(root) {
        bail!("runner path escapes task work directory");
    }
    Ok(())
}
