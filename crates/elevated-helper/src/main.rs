use std::{
    env, fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use awesome_workflow_elevated_helper::{execute, validate_request, HelperRequest};

fn main() -> anyhow::Result<()> {
    let request_path = request_path_from_args()?;
    let bytes = fs::read(&request_path)?;
    fs::remove_file(&request_path)?;
    let request: HelperRequest = serde_json::from_slice(&bytes)?;
    let expected_nonce =
        env::var("AW_HELPER_NONCE").map_err(|_| anyhow::anyhow!("AW_HELPER_NONCE is required"))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    validate_request(&request, &expected_nonce, now)?;
    execute(&request)
}

fn request_path_from_args() -> anyhow::Result<PathBuf> {
    let mut arguments = env::args_os().skip(1);
    match (
        arguments.next().as_deref(),
        arguments.next(),
        arguments.next(),
    ) {
        (Some(flag), Some(path), None) if flag == "--request" => Ok(path.into()),
        _ => Err(anyhow::anyhow!(
            "usage: awesome-workflow-elevated-helper --request <request.json>"
        )),
    }
}
