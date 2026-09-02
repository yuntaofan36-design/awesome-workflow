use std::{env, process::ExitCode, thread, time::Duration};

fn require_host_environment(name: &str) -> Result<(), String> {
    env::var_os(name)
        .map(|_| ())
        .ok_or_else(|| format!("missing Host-provided environment: {name}"))
}

fn run() -> Result<(), String> {
    for name in [
        "AW_APP_ID",
        "AW_TASK_ID",
        "AW_LEASE",
        "AW_RPC_ENDPOINT",
        "AW_WORK_DIRECTORY",
    ] {
        require_host_environment(name)?;
    }

    println!(r#"AW_EVENT {{"type":"log","level":"info","message":"Rust native task started"}}"#);
    for step in 1..=5 {
        thread::sleep(Duration::from_millis(100));
        let progress = f64::from(step) / 5.0;
        println!(r#"AW_EVENT {{"type":"progress","value":{progress:.1},"label":"step {step}/5"}}"#);
    }
    println!(r#"AW_EVENT {{"type":"result","data":{{"message":"Hello from the native Runner"}}}}"#);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("native applet failed: {error}");
            ExitCode::FAILURE
        }
    }
}
