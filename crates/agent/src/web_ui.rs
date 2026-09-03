use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use url::Url;

use crate::{
    ipc::dispatch_task_rpc_with_arguments, now_unix, Agent, AgentError, AgentResult, IssuedLease,
    RpcEnvelope, TaskRecord, RPC_PROTOCOL_VERSION,
};

pub(crate) const WEB_UI_RPC_PATH: &str = "/__awesome_workflow/rpc";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_RPC_BODY_BYTES: usize = 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const CSP: &str = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'none'; manifest-src 'self'; media-src 'self'";

pub(crate) struct WebUiServerHandle {
    shutdown: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl WebUiServerHandle {
    pub(crate) fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    pub(crate) fn stop(mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.join_inner();
    }

    pub(crate) fn join(mut self) {
        self.join_inner();
    }

    fn join_inner(&mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WebUiServerHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.join_inner();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebUiBootstrap<'a> {
    protocol_version: u16,
    app_id: &'a str,
    task_id: &'a str,
    lease: &'a str,
    rpc_endpoint: &'static str,
    work_directory: String,
    locale: String,
    fallback_locales: Vec<String>,
}

struct ServerContext {
    agent: Agent,
    static_root: PathBuf,
    entry_relative: PathBuf,
    task_id: String,
    app_id: String,
    origin: String,
    host: String,
    expires_at: u64,
    arguments: Vec<String>,
}

pub(crate) fn start(
    agent: Agent,
    static_root: &Path,
    entry_path: &Path,
    task: &TaskRecord,
    lease: &IssuedLease,
    arguments: Vec<String>,
) -> AgentResult<(WebUiServerHandle, String)> {
    let static_root = static_root.canonicalize()?;
    let entry_path = entry_path.canonicalize()?;
    if !entry_path.starts_with(&static_root) || !entry_path.is_file() {
        return Err(AgentError::PathEscape(entry_path.display().to_string()));
    }
    let entry_relative = entry_path
        .strip_prefix(&static_root)
        .map_err(|_| AgentError::PathEscape(entry_path.display().to_string()))?
        .to_path_buf();
    validate_relative_components(&entry_relative)?;

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let SocketAddr::V4(address) = address else {
        return Err(AgentError::State(
            "web UI listener did not bind an IPv4 loopback address".into(),
        ));
    };
    if *address.ip() != Ipv4Addr::LOCALHOST {
        return Err(AgentError::AccessDenied(
            "web UI listener escaped the loopback interface".into(),
        ));
    }
    let origin = format!("http://127.0.0.1:{}", address.port());
    let host = format!("127.0.0.1:{}", address.port());
    let work_directory = task
        .log_path
        .parent()
        .ok_or_else(|| AgentError::PathEscape(task.log_path.display().to_string()))?
        .to_string_lossy()
        .into_owned();
    let locale_context = agent.task_context(&task.app_id, &task.task_id)?;
    let bootstrap = serde_json::to_vec(&WebUiBootstrap {
        protocol_version: RPC_PROTOCOL_VERSION,
        app_id: &task.app_id,
        task_id: &task.task_id,
        lease: &lease.value,
        rpc_endpoint: WEB_UI_RPC_PATH,
        work_directory,
        locale: locale_context.locale,
        fallback_locales: locale_context.fallback_locales,
    })?;
    let encoded_bootstrap = URL_SAFE_NO_PAD.encode(bootstrap);
    let mut launch_url = Url::parse(&origin)
        .map_err(|_| AgentError::State("failed to build web UI origin".into()))?;
    {
        let mut segments = launch_url
            .path_segments_mut()
            .map_err(|_| AgentError::State("web UI origin cannot contain a path".into()))?;
        for component in entry_relative.components() {
            let Component::Normal(segment) = component else {
                return Err(AgentError::PathEscape(entry_relative.display().to_string()));
            };
            let segment = segment.to_str().ok_or_else(|| {
                AgentError::InvalidManifest("web UI entry path must be UTF-8".into())
            })?;
            segments.push(segment);
        }
    }
    launch_url.set_fragment(Some(&format!("aw-task={encoded_bootstrap}")));

    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = Arc::clone(&shutdown);
    let context = ServerContext {
        agent,
        static_root,
        entry_relative,
        task_id: task.task_id.clone(),
        app_id: task.app_id.clone(),
        origin,
        host,
        expires_at: lease.expires_at,
        arguments,
    };
    let thread_name = format!("aw-web-ui-{}", &task.task_id[..task.task_id.len().min(8)]);
    let thread = thread::Builder::new()
        .name(thread_name)
        .spawn(move || serve(listener, context, thread_shutdown))
        .map_err(|error| AgentError::State(format!("start web UI server: {error}")))?;

    Ok((
        WebUiServerHandle {
            shutdown,
            thread: Some(thread),
        },
        launch_url.to_string(),
    ))
}

fn serve(listener: TcpListener, context: ServerContext, shutdown: Arc<AtomicBool>) {
    let mut failed = false;
    while !shutdown.load(Ordering::Acquire) && now_unix() < context.expires_at {
        match listener.accept() {
            Ok((stream, peer)) => {
                if peer.ip().is_loopback() {
                    let _ = serve_connection(stream, &context);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(POLL_INTERVAL);
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    if !shutdown.load(Ordering::Acquire) {
        context
            .agent
            .finish_web_ui_task(&context.task_id, if failed { "failed" } else { "stopped" });
    }
}

fn serve_connection(mut stream: TcpStream, context: &ServerContext) -> std::io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(failure) => return write_failure(&mut stream, failure),
    };
    if request.headers.get("host").map(String::as_str) != Some(context.host.as_str()) {
        return write_failure(&mut stream, HttpFailure::Forbidden);
    }
    let path = request
        .path
        .split('?')
        .next()
        .unwrap_or_default()
        .to_owned();
    if path == WEB_UI_RPC_PATH {
        return serve_rpc(&mut stream, context, request);
    }
    serve_static(&mut stream, context, request, &path)
}

fn serve_rpc(
    stream: &mut TcpStream,
    context: &ServerContext,
    request: ParsedRequest,
) -> std::io::Result<()> {
    if request.method != "POST" {
        return write_failure_with_allow(stream, HttpFailure::MethodNotAllowed, "POST");
    }
    if request.path != WEB_UI_RPC_PATH
        || request.headers.get("origin").map(String::as_str) != Some(context.origin.as_str())
    {
        return write_failure(stream, HttpFailure::Forbidden);
    }
    let content_type = request
        .headers
        .get("content-type")
        .map(|value| value.split(';').next().unwrap_or_default().trim());
    if content_type != Some("application/json") {
        return write_failure(stream, HttpFailure::UnsupportedMediaType);
    }
    let envelope = match serde_json::from_slice::<RpcEnvelope<serde_json::Value>>(&request.body) {
        Ok(envelope) => envelope,
        Err(_) => return write_failure(stream, HttpFailure::BadRequest),
    };
    if envelope.app_id != context.app_id || envelope.task_id != context.task_id {
        return write_failure(stream, HttpFailure::Forbidden);
    }
    let response =
        dispatch_task_rpc_with_arguments(envelope, &context.agent, Some(&context.arguments));
    let body = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
    write_bytes(
        stream,
        "200 OK",
        "application/json; charset=utf-8",
        &body,
        &[],
    )
}

fn serve_static(
    stream: &mut TcpStream,
    context: &ServerContext,
    request: ParsedRequest,
    path: &str,
) -> std::io::Result<()> {
    if !matches!(request.method.as_str(), "GET" | "HEAD") {
        return write_failure_with_allow(stream, HttpFailure::MethodNotAllowed, "GET, HEAD");
    }
    if !request.body.is_empty() {
        return write_failure(stream, HttpFailure::BadRequest);
    }
    let path = match resolve_static_file(&context.static_root, &context.entry_relative, path) {
        Ok(path) => path,
        Err(failure) => return write_failure(stream, failure),
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(_) => return write_failure(stream, HttpFailure::NotFound),
    };
    let length = match file.metadata() {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        _ => return write_failure(stream, HttpFailure::NotFound),
    };
    let content_type = content_type(&path);
    write_file_response(
        stream,
        file,
        length,
        content_type,
        request.method == "HEAD",
        content_type.starts_with("text/html"),
    )
}

struct ParsedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<ParsedRequest, HttpFailure> {
    let mut bytes = Vec::with_capacity(2048);
    let header_end = loop {
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err(HttpFailure::HeadersTooLarge);
        }
        let mut chunk = [0_u8; 2048];
        let read = stream
            .read(&mut chunk)
            .map_err(|_| HttpFailure::BadRequest)?;
        if read == 0 {
            return Err(HttpFailure::BadRequest);
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&bytes) {
            if end > MAX_HEADER_BYTES {
                return Err(HttpFailure::HeadersTooLarge);
            }
            break end;
        }
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err(HttpFailure::HeadersTooLarge);
        }
    };

    let (method, path, headers) = {
        let mut parsed_headers = [httparse::EMPTY_HEADER; 48];
        let mut request = httparse::Request::new(&mut parsed_headers);
        let parsed = request
            .parse(&bytes[..header_end])
            .map_err(|_| HttpFailure::BadRequest)?;
        if !parsed.is_complete() || request.version != Some(1) {
            return Err(HttpFailure::BadRequest);
        }
        let method = request.method.ok_or(HttpFailure::BadRequest)?.to_owned();
        let path = request.path.ok_or(HttpFailure::BadRequest)?.to_owned();
        if !path.starts_with('/') {
            return Err(HttpFailure::BadRequest);
        }
        let mut headers = HashMap::new();
        for header in request.headers {
            let name = header.name.to_ascii_lowercase();
            let value = std::str::from_utf8(header.value)
                .map_err(|_| HttpFailure::BadRequest)?
                .trim()
                .to_owned();
            if headers.insert(name, value).is_some() {
                return Err(HttpFailure::BadRequest);
            }
        }
        (method, path, headers)
    };
    if headers.contains_key("transfer-encoding") {
        return Err(HttpFailure::BadRequest);
    }
    let content_length = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| HttpFailure::BadRequest)?,
        None => 0,
    };
    if content_length > MAX_RPC_BODY_BYTES {
        return Err(HttpFailure::PayloadTooLarge);
    }
    let required = header_end
        .checked_add(content_length)
        .ok_or(HttpFailure::PayloadTooLarge)?;
    while bytes.len() < required {
        let mut chunk = [0_u8; 8192];
        let remaining = required - bytes.len();
        let read_length = remaining.min(chunk.len());
        let read = stream
            .read(&mut chunk[..read_length])
            .map_err(|_| HttpFailure::BadRequest)?;
        if read == 0 {
            return Err(HttpFailure::BadRequest);
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    if bytes.len() > required {
        return Err(HttpFailure::BadRequest);
    }
    Ok(ParsedRequest {
        method,
        path,
        headers,
        body: bytes[header_end..required].to_vec(),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn resolve_static_file(
    root: &Path,
    entry_relative: &Path,
    request_path: &str,
) -> Result<PathBuf, HttpFailure> {
    let relative = if request_path == "/" {
        entry_relative.to_path_buf()
    } else {
        let decoded = percent_decode_str(request_path)
            .decode_utf8()
            .map_err(|_| HttpFailure::BadRequest)?;
        if decoded.contains('\0')
            || decoded.contains('\\')
            || decoded.contains(':')
            || decoded.contains("//")
        {
            return Err(HttpFailure::BadRequest);
        }
        let decoded = decoded.strip_prefix('/').ok_or(HttpFailure::BadRequest)?;
        if decoded.is_empty() || decoded.ends_with('/') {
            return Err(HttpFailure::NotFound);
        }
        let path = PathBuf::from(decoded);
        validate_relative_components(&path).map_err(|_| HttpFailure::BadRequest)?;
        path
    };
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| HttpFailure::NotFound)?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(HttpFailure::NotFound);
    }
    Ok(canonical)
}

fn validate_relative_components(path: &Path) -> AgentResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(value) if !value.to_string_lossy().starts_with('.'))
        })
    {
        return Err(AgentError::PathEscape(path.display().to_string()));
    }
    Ok(())
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[derive(Clone, Copy)]
enum HttpFailure {
    BadRequest,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    PayloadTooLarge,
    UnsupportedMediaType,
    HeadersTooLarge,
}

impl HttpFailure {
    fn status(self) -> &'static str {
        match self {
            Self::BadRequest => "400 Bad Request",
            Self::Forbidden => "403 Forbidden",
            Self::NotFound => "404 Not Found",
            Self::MethodNotAllowed => "405 Method Not Allowed",
            Self::PayloadTooLarge => "413 Payload Too Large",
            Self::UnsupportedMediaType => "415 Unsupported Media Type",
            Self::HeadersTooLarge => "431 Request Header Fields Too Large",
        }
    }
}

fn write_failure(stream: &mut TcpStream, failure: HttpFailure) -> std::io::Result<()> {
    write_bytes(
        stream,
        failure.status(),
        "text/plain; charset=utf-8",
        b"request rejected",
        &[],
    )
}

fn write_failure_with_allow(
    stream: &mut TcpStream,
    failure: HttpFailure,
    allow: &str,
) -> std::io::Result<()> {
    write_bytes(
        stream,
        failure.status(),
        "text/plain; charset=utf-8",
        b"request rejected",
        &[("Allow", allow)],
    )
}

fn write_bytes(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) -> std::io::Result<()> {
    write_headers(
        stream,
        status,
        content_type,
        body.len() as u64,
        extra_headers,
    )?;
    stream.write_all(body)
}

fn write_file_response(
    stream: &mut TcpStream,
    mut file: File,
    length: u64,
    content_type: &str,
    head_only: bool,
    clear_site_data: bool,
) -> std::io::Result<()> {
    let extra =
        clear_site_data.then_some(("Clear-Site-Data", "\"cache\", \"cookies\", \"storage\""));
    write_headers(stream, "200 OK", content_type, length, extra.as_slice())?;
    if !head_only {
        std::io::copy(&mut file, stream)?;
    }
    Ok(())
}

fn write_headers(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    content_length: u64,
    extra_headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: {CSP}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Resource-Policy: same-origin\r\nPermissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()\r\n"
    );
    for (name, value) in extra_headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    stream.write_all(response.as_bytes())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        fs,
        io::{Read, Write},
        net::{Shutdown, TcpStream},
        path::PathBuf,
        time::Duration,
    };

    use tempfile::{tempdir, TempDir};

    use crate::{
        manifest::{
            Ed25519Algorithm, Integrity, ManifestArtifact, ManifestKind, PublisherSignature,
            Sha256Algorithm,
        },
        AgentConfig, AgentMethod, AppletManifest, RpcEnvelope, RunMode, RunOutcome, RuntimeKind,
        RuntimeSpec, TargetPlatform, TaskRecord, RPC_PROTOCOL_VERSION,
    };

    use super::*;

    struct Fixture {
        agent: Agent,
        _temp: TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempdir().unwrap();
            let applet_root = temp.path().join("web-ui-applet");
            fs::create_dir_all(applet_root.join("assets")).unwrap();
            fs::write(
                applet_root.join("index.html"),
                b"<!doctype html><script src=\"/app.js\"></script>",
            )
            .unwrap();
            fs::write(applet_root.join("app.js"), b"globalThis.awReady = true;\n").unwrap();
            fs::write(applet_root.join("assets").join("note.txt"), b"asset").unwrap();

            let manifest = AppletManifest {
                schema_version: 1,
                app_id: "web-ui-test".into(),
                version: semver::Version::new(1, 0, 0),
                artifacts: vec![ManifestArtifact {
                    name: "web-ui".into(),
                    file_name: PathBuf::from("web-ui.awpkg"),
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
                name: "Web UI Test".into(),
                description: String::new(),
                default_locale: "en-US".into(),
                localizations: Default::default(),
                runtimes: vec![RuntimeSpec {
                    platform: TargetPlatform::WINDOWS_X64,
                    artifact: "web-ui".into(),
                    entry: PathBuf::from("index.html"),
                    runtime: RuntimeKind::WebUi {
                        allowed_origins: vec![],
                    },
                }],
                dependencies: vec![],
                capabilities: vec![],
                run_mode: RunMode::Parallel,
                min_host_version: semver::Version::new(0, 1, 0),
            };
            fs::write(
                applet_root.join("applet.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();

            let agent = Agent::open(AgentConfig {
                data_root: temp.path().join("data"),
                runner_path: PathBuf::from("missing-runner"),
                python_runtime: None,
                rpc_endpoint: "unused-in-web-ui-test".into(),
                target: TargetPlatform::WINDOWS_X64,
                developer_mode: true,
            })
            .unwrap();
            agent.register_dev_directory(&applet_root).unwrap();
            Self { agent, _temp: temp }
        }

        fn run(&self) -> RunningWebUi {
            self.run_with_arguments(vec![])
        }

        fn run_with_arguments(&self, arguments: Vec<String>) -> RunningWebUi {
            match self.agent.run("web-ui-test", None, arguments).unwrap() {
                RunOutcome::WebUi { task, launch_url } => {
                    let url = Url::parse(&launch_url).unwrap();
                    let encoded = url.fragment().unwrap().strip_prefix("aw-task=").unwrap();
                    let bootstrap: serde_json::Value =
                        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
                    RunningWebUi {
                        task,
                        url,
                        bootstrap,
                    }
                }
                RunOutcome::Process { .. } => panic!("expected web UI runtime"),
            }
        }
    }

    struct RunningWebUi {
        task: TaskRecord,
        url: Url,
        bootstrap: serde_json::Value,
    }

    impl RunningWebUi {
        fn origin(&self) -> String {
            self.url.origin().ascii_serialization()
        }

        fn host(&self) -> String {
            format!(
                "{}:{}",
                self.url.host_str().unwrap(),
                self.url.port().unwrap()
            )
        }

        fn lease(&self) -> &str {
            self.bootstrap["lease"].as_str().unwrap()
        }
    }

    struct HttpResponse {
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    #[test]
    fn isolates_each_task_serves_hardened_assets_and_stops_cleanly() {
        let fixture = Fixture::new();
        let first = fixture.run();
        let second = fixture.run();

        assert_ne!(first.origin(), second.origin());
        assert_ne!(first.task.task_id, second.task.task_id);

        let html = send_request(&first.url, "GET", "/", &first.host(), &[], b"");
        assert_eq!(html.status, 200);
        assert_eq!(
            html.headers.get("content-type").map(String::as_str),
            Some("text/html; charset=utf-8")
        );
        assert!(html
            .headers
            .get("content-security-policy")
            .unwrap()
            .contains("default-src 'self'"));
        assert_eq!(
            html.headers
                .get("x-content-type-options")
                .map(String::as_str),
            Some("nosniff")
        );
        assert_eq!(
            html.headers.get("x-frame-options").map(String::as_str),
            Some("DENY")
        );
        assert_eq!(
            html.headers.get("clear-site-data").map(String::as_str),
            Some("\"cache\", \"cookies\", \"storage\"")
        );
        assert!(String::from_utf8(html.body)
            .unwrap()
            .contains("doctype html"));

        let script = send_request(&first.url, "GET", "/app.js", &first.host(), &[], b"");
        assert_eq!(script.status, 200);
        assert_eq!(
            script.headers.get("content-type").map(String::as_str),
            Some("text/javascript; charset=utf-8")
        );
        assert!(!script.headers.contains_key("clear-site-data"));

        let head = send_request(&first.url, "HEAD", "/app.js", &first.host(), &[], b"");
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        assert_eq!(
            head.headers.get("content-length").map(String::as_str),
            Some("27")
        );

        let task_directory = first.task.log_path.parent().unwrap();
        assert!(!task_directory.join("runner-request.json").exists());
        assert!(!fs::read_to_string(&first.task.log_path)
            .unwrap()
            .contains(first.lease()));

        let revoked = RpcEnvelope {
            protocol_version: RPC_PROTOCOL_VERSION,
            app_id: first.task.app_id.clone(),
            task_id: first.task.task_id.clone(),
            lease: first.lease().to_owned(),
            method: AgentMethod::ContextRead,
            payload: serde_json::json!({}),
        };
        fixture.agent.stop(&first.task.task_id).unwrap();
        assert!(TcpStream::connect(("127.0.0.1", first.url.port().unwrap())).is_err());
        assert!(fixture.agent.authorize_rpc(&revoked).is_err());
        let stopped = fixture
            .agent
            .snapshot()
            .unwrap()
            .tasks
            .into_iter()
            .find(|task| task.task_id == first.task.task_id)
            .unwrap();
        assert_eq!(stopped.status, "stopped");

        fixture.agent.stop(&second.task.task_id).unwrap();
    }

    #[test]
    fn dropping_the_agent_releases_the_server_without_a_handle_cycle() {
        let port = {
            let fixture = Fixture::new();
            fixture.run().url.port().unwrap()
        };
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn rejects_invalid_hosts_methods_bodies_and_static_paths() {
        let fixture = Fixture::new();
        let running = fixture.run();

        for (path, expected) in [
            ("/%2e%2e/index.html", 400),
            ("/.hidden", 400),
            ("/assets/", 404),
            ("/missing.txt", 404),
            ("//app.js", 400),
            ("/C:/secret.txt", 400),
        ] {
            assert_eq!(
                send_request(&running.url, "GET", path, &running.host(), &[], b"").status,
                expected,
                "unexpected status for {path}"
            );
        }

        let wrong_host = send_request(&running.url, "GET", "/", "localhost:1", &[], b"");
        assert_eq!(wrong_host.status, 403);

        let post = send_request(
            &running.url,
            "POST",
            "/app.js",
            &running.host(),
            &[("Content-Type", "text/plain")],
            b"x",
        );
        assert_eq!(post.status, 405);
        assert_eq!(
            post.headers.get("allow").map(String::as_str),
            Some("GET, HEAD")
        );

        let get_with_body =
            send_request(&running.url, "GET", "/app.js", &running.host(), &[], b"x");
        assert_eq!(get_with_body.status, 400);

        fixture.agent.stop(&running.task.task_id).unwrap();
    }

    #[test]
    fn binds_rpc_to_server_origin_task_lease_protocol_and_method() {
        let fixture = Fixture::new();
        let expected_arguments = vec!["--trigger".to_owned(), "schedule".to_owned()];
        let first = fixture.run_with_arguments(expected_arguments.clone());
        let second = fixture.run();

        let valid = rpc_envelope(&first, serde_json::json!("context-read"));
        let response = send_json_rpc(&first, &first.origin(), &valid);
        assert_eq!(response.status, 200);
        let body: serde_json::Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["data"]["appId"], "web-ui-test");
        assert_eq!(body["data"]["taskId"], first.task.task_id);
        assert_eq!(
            body["data"]["arguments"],
            serde_json::json!(expected_arguments)
        );

        assert_eq!(
            send_json_rpc(&first, "http://127.0.0.1:1", &valid).status,
            403
        );

        let wrong_lease = with_field(&valid, "lease", serde_json::json!("wrong-lease"));
        let body: serde_json::Value =
            serde_json::from_slice(&send_json_rpc(&first, &first.origin(), &wrong_lease).body)
                .unwrap();
        assert_eq!(body["ok"], false);

        let wrong_protocol = with_field(&valid, "protocolVersion", serde_json::json!(99));
        let body: serde_json::Value =
            serde_json::from_slice(&send_json_rpc(&first, &first.origin(), &wrong_protocol).body)
                .unwrap();
        assert_eq!(body["ok"], false);

        let wrong_task = with_field(
            &valid,
            "taskId",
            serde_json::json!(second.task.task_id.clone()),
        );
        assert_eq!(
            send_json_rpc(&first, &first.origin(), &wrong_task).status,
            403
        );

        let first_scope_on_second = send_json_rpc(&second, &second.origin(), &valid);
        assert_eq!(first_scope_on_second.status, 403);

        let unknown_method = with_field(&valid, "method", serde_json::json!("shell-exec"));
        assert_eq!(
            send_json_rpc(&first, &first.origin(), &unknown_method).status,
            400
        );

        let encoded = serde_json::to_vec(&valid).unwrap();
        assert_eq!(
            send_request(
                &first.url,
                "POST",
                WEB_UI_RPC_PATH,
                &first.host(),
                &[
                    ("Origin", first.origin().as_str()),
                    ("Content-Type", "text/plain")
                ],
                &encoded,
            )
            .status,
            415
        );
        assert_eq!(
            send_request(
                &first.url,
                "GET",
                WEB_UI_RPC_PATH,
                &first.host(),
                &[("Origin", first.origin().as_str())],
                b"",
            )
            .status,
            405
        );
        assert_eq!(
            send_request(
                &first.url,
                "POST",
                &format!("{WEB_UI_RPC_PATH}?unexpected=true"),
                &first.host(),
                &[
                    ("Origin", first.origin().as_str()),
                    ("Content-Type", "application/json"),
                ],
                &encoded,
            )
            .status,
            403
        );

        fixture.agent.stop(&first.task.task_id).unwrap();
        fixture.agent.stop(&second.task.task_id).unwrap();
    }

    fn rpc_envelope(running: &RunningWebUi, method: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": RPC_PROTOCOL_VERSION,
            "appId": running.task.app_id,
            "taskId": running.task.task_id,
            "lease": running.lease(),
            "method": method,
            "payload": {},
        })
    }

    fn with_field(
        value: &serde_json::Value,
        field: &str,
        replacement: serde_json::Value,
    ) -> serde_json::Value {
        let mut value = value.clone();
        value
            .as_object_mut()
            .unwrap()
            .insert(field.into(), replacement);
        value
    }

    fn send_json_rpc(
        running: &RunningWebUi,
        origin: &str,
        body: &serde_json::Value,
    ) -> HttpResponse {
        let body = serde_json::to_vec(body).unwrap();
        send_request(
            &running.url,
            "POST",
            WEB_UI_RPC_PATH,
            &running.host(),
            &[("Origin", origin), ("Content-Type", "application/json")],
            &body,
        )
    }

    fn send_request(
        url: &Url,
        method: &str,
        path: &str,
        host: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> HttpResponse {
        let mut stream =
            TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (name, value) in headers {
            request.push_str(name);
            request.push_str(": ");
            request.push_str(value);
            request.push_str("\r\n");
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        parse_response(response)
    }

    fn parse_response(response: Vec<u8>) -> HttpResponse {
        let header_end = find_header_end(&response).unwrap();
        let header_text = std::str::from_utf8(&response[..header_end - 4]).unwrap();
        let mut lines = header_text.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .map(|line| {
                let (name, value) = line.split_once(':').unwrap();
                (name.to_ascii_lowercase(), value.trim().to_owned())
            })
            .collect();
        HttpResponse {
            status,
            headers,
            body: response[header_end..].to_vec(),
        }
    }
}
