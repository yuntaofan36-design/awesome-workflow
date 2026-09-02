use std::{env, path::PathBuf, sync::Arc};

use awesome_workflow_agent::{
    run_agent_daemon, Agent, AgentConfig, AgentEndpoint, Ed25519Verifier, RejectUnsignedVerifier,
    SignatureVerifier, TargetPlatform,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::VerifyingKey;

fn main() -> anyhow::Result<()> {
    let data_root = env::var_os("AW_AGENT_DATA_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("AW_AGENT_DATA_ROOT is required"))?;
    let runner_path = env::var_os("AW_RUNNER_PATH")
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("AW_RUNNER_PATH is required"))?;
    let endpoint = AgentEndpoint::from_data_root(&data_root)?;
    let rpc_endpoint = endpoint.task_rpc_endpoint();
    let agent = Arc::new(Agent::open(AgentConfig {
        data_root,
        runner_path,
        python_runtime: env::var_os("AW_PYTHON_RUNTIME").map(PathBuf::from),
        rpc_endpoint,
        target: TargetPlatform::current()?,
        developer_mode: env::var("AW_DEVELOPER_MODE").as_deref() == Ok("1")
            || cfg!(debug_assertions),
    })?);
    run_agent_daemon(endpoint, agent, load_signature_verifier())?;
    Ok(())
}

fn load_signature_verifier() -> Arc<dyn SignatureVerifier> {
    let Ok(key_id) = env::var("AW_SIGNING_KEY_ID") else {
        return Arc::new(RejectUnsignedVerifier);
    };
    let Ok(encoded_key) = env::var("AW_SIGNING_PUBLIC_KEY") else {
        return Arc::new(RejectUnsignedVerifier);
    };
    let Ok(bytes) = STANDARD.decode(encoded_key) else {
        return Arc::new(RejectUnsignedVerifier);
    };
    let Ok(bytes) = <[u8; 32]>::try_from(bytes) else {
        return Arc::new(RejectUnsignedVerifier);
    };
    let Ok(key) = VerifyingKey::from_bytes(&bytes) else {
        return Arc::new(RejectUnsignedVerifier);
    };
    Arc::new(Ed25519Verifier { key_id, key })
}
