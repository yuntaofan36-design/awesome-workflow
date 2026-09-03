use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{blocking::Client, redirect::Policy, Method};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;
use uuid::Uuid;

const CREDENTIAL_SERVICE: &str = "dev.awesome-workflow.desktop";
const CREDENTIAL_ACCOUNT: &str = "desktop-session-v1";
const DEFAULT_API_BASE: &str = "http://127.0.0.1:4100/api/v1";
const DESKTOP_PUBLIC_CLIENT_ID: &str = "awesome-workflow-desktop";
const DESKTOP_OFFLINE_SCOPE: &str = "openid profile email offline_access";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);
const MIN_SESSION_REMAINING_SECONDS: i64 = 30;
const MAX_SESSION_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
const MAX_HTTP_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_DEVICE_REGISTRATION_BODY_BYTES: usize = 32 * 1024;
const MAX_CALLBACK_HEADER_BYTES: usize = 8 * 1024;

pub type AuthResult<T> = Result<T, AuthError>;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("secure credential storage is unavailable")]
    CredentialUnavailable,
    #[error("the secure credential is invalid; sign in again")]
    InvalidCredential,
    #[error("the authentication server returned an invalid response")]
    InvalidResponse,
    #[error("the authentication request was rejected with status {0}")]
    Rejected(u16),
    #[error("the configured API URL is not allowed")]
    InvalidApiBase,
    #[error("the authorization callback was rejected")]
    InvalidCallback,
    #[error("timed out waiting for the browser authorization callback")]
    CallbackTimeout,
    #[error("unable to open the system browser")]
    BrowserUnavailable,
    #[error("authenticated API endpoint is not allowed")]
    EndpointNotAllowed,
    #[error("authenticated API response is too large")]
    ResponseTooLarge,
    #[error("authentication transport failed")]
    Transport,
    #[error("authentication is not supported on this platform without a secure credential store")]
    UnsupportedPlatform,
    #[error("unsupported desktop locale")]
    UnsupportedLocale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopLocale {
    EnUs,
    ZhCn,
}

impl DesktopLocale {
    pub(crate) fn parse(value: &str) -> AuthResult<Self> {
        match value {
            "en-US" => Ok(Self::EnUs),
            "zh-CN" => Ok(Self::ZhCn),
            _ => Err(AuthError::UnsupportedLocale),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::EnUs => "en-US",
            Self::ZhCn => "zh-CN",
        }
    }

    fn callback_rejected(self) -> &'static str {
        match self {
            Self::EnUs => "Authorization response rejected.",
            Self::ZhCn => "授权响应已被拒绝。",
        }
    }

    fn callback_completed(self) -> &'static str {
        match self {
            Self::EnUs => "Awesome Workflow sign-in completed. You can close this window.",
            Self::ZhCn => "Awesome Workflow 登录已完成，你可以关闭此窗口。",
        }
    }
}

/// Stores one opaque serialized credential. Implementations must use an OS-backed
/// secret store and must never fall back to plaintext files.
pub trait CredentialStore: Send + Sync {
    fn load(&self) -> AuthResult<Option<String>>;
    fn save(&self, secret: &str) -> AuthResult<()>;
    fn delete(&self) -> AuthResult<()>;
}

pub struct HttpRequest {
    method: HttpMethod,
    url: Url,
    bearer: Option<String>,
    body: Option<Value>,
    form: Option<Vec<(String, String)>>,
    accept_language: Option<String>,
}

pub struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

/// The transport is replaceable so tests can prove that the bearer token is
/// injected only inside Rust and never supplied by the WebView.
pub trait HttpTransport: Send + Sync {
    fn send(&self, request: HttpRequest) -> AuthResult<HttpResponse>;
}

/// Browser launching is also replaceable. URLs are validated before this trait
/// is called and are always passed as an argv element, never through a shell.
pub trait BrowserLauncher: Send + Sync {
    fn open(&self, url: &Url) -> AuthResult<()>;
}

trait AuthorizationReceiver {
    fn redirect_uri(&self) -> &Url;
    fn receive(
        &self,
        expected_state: &str,
        timeout: Duration,
        locale: DesktopLocale,
    ) -> AuthResult<String>;
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSession {
    pub user: DesktopUser,
    pub expires_at: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthProviderDescriptor {
    pub id: String,
    pub label: String,
    pub protocol: String,
    pub status: String,
    pub strategy: Option<String>,
    pub authorize_url: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopUser {
    pub id: String,
    pub email: String,
    pub display_name: String,
    #[serde(default)]
    pub platform_roles: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatedApiInput {
    pub method: DesktopApiMethod,
    pub path: String,
    pub locale: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DesktopApiMethod {
    Get,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedApiResponse {
    pub status: u16,
    pub body: Value,
}

/// One-time enrollment material for the trusted Rust host. Deliberately does
/// not implement `Serialize`, so it cannot cross a Tauri command boundary.
pub struct DeviceEnrollmentSecret {
    pub device_id: String,
    pub credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRegistrationResult {
    device: RegisteredDevice,
    credential: String,
}

#[derive(Deserialize)]
struct RegisteredDevice {
    id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCredential {
    api_base_url: String,
    access_token: String,
    refresh_token: String,
    expires_at: String,
    user: DesktopUser,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationInput<'a> {
    redirect_uri: &'a str,
    code_challenge: &'a str,
    code_challenge_method: &'static str,
    scope: &'static str,
    state: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizationResult {
    authorization_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenInput<'a> {
    code: &'a str,
    code_verifier: &'a str,
    redirect_uri: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenResult {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_at: String,
    user: DesktopUser,
}

#[derive(Deserialize)]
struct RefreshTokenResult {
    access_token: String,
    refresh_token: String,
    token_type: String,
    expires_in: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    data: T,
}

struct LoginMaterial {
    verifier: String,
    challenge: String,
    state: String,
}

pub struct DesktopAuth {
    api_base: Url,
    credentials: Arc<dyn CredentialStore>,
    http: Arc<dyn HttpTransport>,
    browser: Arc<dyn BrowserLauncher>,
    credential_lock: Mutex<()>,
}

impl DesktopAuth {
    pub fn production() -> AuthResult<Self> {
        Ok(Self::new(
            configured_api_base()?,
            platform_credential_store(),
            Arc::new(ReqwestTransport::new()?),
            Arc::new(SystemBrowser),
        ))
    }

    fn new(
        api_base: Url,
        credentials: Arc<dyn CredentialStore>,
        http: Arc<dyn HttpTransport>,
        browser: Arc<dyn BrowserLauncher>,
    ) -> Self {
        Self {
            api_base,
            credentials,
            http,
            browser,
            credential_lock: Mutex::new(()),
        }
    }

    pub fn current(&self, locale: &str) -> AuthResult<Option<DesktopSession>> {
        let locale = DesktopLocale::parse(locale)?;
        let _guard = self
            .credential_lock
            .lock()
            .map_err(|_| AuthError::Transport)?;
        let Some(mut credential) = self.load_ready_credential(locale)? else {
            return Ok(None);
        };
        let mut response = self.http.send(HttpRequest {
            method: HttpMethod::Get,
            url: self.api_url("auth/session")?,
            bearer: Some(credential.access_token.clone()),
            body: None,
            form: None,
            accept_language: Some(locale.as_str().to_owned()),
        })?;
        if response.status == 401 {
            credential = self.refresh_or_clear(&credential, locale)?;
            response = self.http.send(HttpRequest {
                method: HttpMethod::Get,
                url: self.api_url("auth/session")?,
                bearer: Some(credential.access_token.clone()),
                body: None,
                form: None,
                accept_language: Some(locale.as_str().to_owned()),
            })?;
        }
        if response.status == 401 {
            self.credentials.delete()?;
            return Ok(None);
        }
        let user: DesktopUser = decode_success(response)?;
        validate_user(&user)?;
        Ok(Some(DesktopSession {
            user,
            expires_at: credential.expires_at,
        }))
    }

    pub fn providers(&self, locale: &str) -> AuthResult<Vec<AuthProviderDescriptor>> {
        let locale = DesktopLocale::parse(locale)?;
        let response = self.http.send(HttpRequest {
            method: HttpMethod::Get,
            url: self.api_url("auth/providers")?,
            bearer: None,
            body: None,
            form: None,
            accept_language: Some(locale.as_str().to_owned()),
        })?;
        let providers: Vec<AuthProviderDescriptor> = decode_success(response)?;
        for provider in &providers {
            validate_provider(provider)?;
        }
        Ok(providers)
    }

    pub fn login(&self, locale: &str) -> AuthResult<DesktopSession> {
        let locale = DesktopLocale::parse(locale)?;
        let _guard = self
            .credential_lock
            .lock()
            .map_err(|_| AuthError::Transport)?;
        let receiver = LoopbackReceiver::bind()?;
        self.login_with_receiver(&receiver, LoginMaterial::generate()?, locale)
    }

    fn login_with_receiver(
        &self,
        receiver: &dyn AuthorizationReceiver,
        material: LoginMaterial,
        locale: DesktopLocale,
    ) -> AuthResult<DesktopSession> {
        let redirect_uri = receiver.redirect_uri().as_str();
        let authorization: AuthorizationResult = self.post_public(
            "auth/cli/authorize",
            &AuthorizationInput {
                redirect_uri,
                code_challenge: &material.challenge,
                code_challenge_method: "S256",
                scope: DESKTOP_OFFLINE_SCOPE,
                state: &material.state,
            },
            locale,
        )?;
        let authorization_url = validate_authorization_url(&authorization.authorization_url)?;
        self.browser.open(&authorization_url)?;
        let code = receiver.receive(&material.state, LOGIN_TIMEOUT, locale)?;
        validate_pkce_value(&code)?;

        let token: TokenResult = self.post_public(
            "auth/cli/token",
            &TokenInput {
                code: &code,
                code_verifier: &material.verifier,
                redirect_uri,
            },
            locale,
        )?;
        validate_token_result(&token)?;
        let credential = StoredCredential {
            api_base_url: self.api_base.to_string(),
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_at.clone(),
            user: token.user.clone(),
        };
        self.save_credential(&credential)?;
        Ok(DesktopSession {
            user: token.user,
            expires_at: token.expires_at,
        })
    }

    pub fn logout(&self, locale: &str) -> AuthResult<()> {
        let locale = DesktopLocale::parse(locale)?;
        let _guard = self
            .credential_lock
            .lock()
            .map_err(|_| AuthError::Transport)?;
        let stored = self.credentials.load()?;
        // Local deletion happens first, so a crash or an unavailable API cannot
        // leave the desktop signed in on this machine.
        self.credentials.delete()?;
        let Some(secret) = stored else { return Ok(()) };
        let Ok(credential) = serde_json::from_str::<StoredCredential>(&secret) else {
            return Ok(());
        };
        if credential.api_base_url != self.api_base.to_string() {
            return Ok(());
        }
        let _ = self.http.send(HttpRequest {
            method: HttpMethod::Post,
            url: self.api_url("auth/logout")?,
            bearer: Some(credential.access_token),
            body: None,
            form: None,
            accept_language: Some(locale.as_str().to_owned()),
        });
        Ok(())
    }

    pub fn authenticated_request(
        &self,
        input: AuthenticatedApiInput,
    ) -> AuthResult<AuthenticatedApiResponse> {
        let locale = DesktopLocale::parse(&input.locale)?;
        validate_broker_endpoint(input.method, &input.path)?;
        let _guard = self
            .credential_lock
            .lock()
            .map_err(|_| AuthError::Transport)?;
        let Some(mut credential) = self.load_ready_credential(locale)? else {
            return Err(AuthError::InvalidCredential);
        };
        let path = input.path.trim_start_matches('/');
        let url = self.api_url(path)?;
        let mut response = self.http.send(HttpRequest {
            method: HttpMethod::Get,
            url: url.clone(),
            bearer: Some(credential.access_token.clone()),
            body: None,
            form: None,
            accept_language: Some(locale.as_str().to_owned()),
        })?;
        if response.status == 401 {
            credential = self.refresh_or_clear(&credential, locale)?;
            response = self.http.send(HttpRequest {
                method: HttpMethod::Get,
                url,
                bearer: Some(credential.access_token),
                body: None,
                form: None,
                accept_language: Some(locale.as_str().to_owned()),
            })?;
        }
        if response.status == 401 {
            self.credentials.delete()?;
            return Err(AuthError::InvalidCredential);
        }
        let status = response.status;
        let body = if response.body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&response.body).map_err(|_| AuthError::InvalidResponse)?
        };
        Ok(AuthenticatedApiResponse { status, body })
    }

    pub fn register_device(&self, body: Value, locale: &str) -> AuthResult<DeviceEnrollmentSecret> {
        let locale = DesktopLocale::parse(locale)?;
        if !body.is_object()
            || serde_json::to_vec(&body)
                .map_err(|_| AuthError::InvalidResponse)?
                .len()
                > MAX_DEVICE_REGISTRATION_BODY_BYTES
        {
            return Err(AuthError::EndpointNotAllowed);
        }
        let _guard = self
            .credential_lock
            .lock()
            .map_err(|_| AuthError::Transport)?;
        let Some(mut credential) = self.load_ready_credential(locale)? else {
            return Err(AuthError::InvalidCredential);
        };
        let url = self.api_url("devices")?;
        let mut response = self.http.send(HttpRequest {
            method: HttpMethod::Post,
            url: url.clone(),
            bearer: Some(credential.access_token.clone()),
            body: Some(body.clone()),
            form: None,
            accept_language: Some(locale.as_str().to_owned()),
        })?;
        if response.status == 401 {
            credential = self.refresh_or_clear(&credential, locale)?;
            response = self.http.send(HttpRequest {
                method: HttpMethod::Post,
                url,
                bearer: Some(credential.access_token),
                body: Some(body),
                form: None,
                accept_language: Some(locale.as_str().to_owned()),
            })?;
        }
        if response.status == 401 {
            self.credentials.delete()?;
            return Err(AuthError::InvalidCredential);
        }
        let result: DeviceRegistrationResult = decode_success(response)?;
        Uuid::parse_str(&result.device.id).map_err(|_| AuthError::InvalidResponse)?;
        if result.credential.len() != 47
            || !result.credential.starts_with("awd_")
            || !result.credential[4..]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(AuthError::InvalidResponse);
        }
        Ok(DeviceEnrollmentSecret {
            device_id: result.device.id,
            credential: result.credential,
        })
    }

    pub fn api_base_url(&self) -> String {
        self.api_base.to_string()
    }

    fn refresh_credential(
        &self,
        credential: &StoredCredential,
        locale: DesktopLocale,
    ) -> AuthResult<StoredCredential> {
        let response = self.http.send(HttpRequest {
            method: HttpMethod::Post,
            url: self.api_url("auth/cli/token")?,
            bearer: None,
            body: None,
            form: Some(vec![
                ("grant_type".into(), "refresh_token".into()),
                ("refresh_token".into(), credential.refresh_token.clone()),
                ("client_id".into(), DESKTOP_PUBLIC_CLIENT_ID.into()),
            ]),
            accept_language: Some(locale.as_str().to_owned()),
        })?;
        let token: RefreshTokenResult = decode_oauth_success(response)?;
        validate_refresh_token_result(&token)?;
        let expires_at = OffsetDateTime::now_utc()
            .checked_add(time::Duration::seconds(token.expires_in))
            .ok_or(AuthError::InvalidResponse)?
            .format(&Rfc3339)
            .map_err(|_| AuthError::InvalidResponse)?;
        let next = StoredCredential {
            api_base_url: credential.api_base_url.clone(),
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at,
            user: credential.user.clone(),
        };
        self.save_credential(&next)?;
        Ok(next)
    }

    fn refresh_or_clear(
        &self,
        credential: &StoredCredential,
        locale: DesktopLocale,
    ) -> AuthResult<StoredCredential> {
        match self.refresh_credential(credential, locale) {
            Ok(next) => Ok(next),
            Err(error) => {
                self.credentials.delete()?;
                Err(error)
            }
        }
    }

    fn load_ready_credential(&self, locale: DesktopLocale) -> AuthResult<Option<StoredCredential>> {
        let Some(credential) = self.load_stored_credential()? else {
            return Ok(None);
        };
        let remaining = parse_timestamp(&credential.expires_at)? - unix_timestamp()?;
        if remaining <= MIN_SESSION_REMAINING_SECONDS {
            return self.refresh_or_clear(&credential, locale).map(Some);
        }
        Ok(Some(credential))
    }

    fn post_public<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
        locale: DesktopLocale,
    ) -> AuthResult<T> {
        let response = self.http.send(HttpRequest {
            method: HttpMethod::Post,
            url: self.api_url(path)?,
            bearer: None,
            body: Some(serde_json::to_value(body).map_err(|_| AuthError::InvalidResponse)?),
            form: None,
            accept_language: Some(locale.as_str().to_owned()),
        })?;
        decode_success(response)
    }

    fn api_url(&self, path: &str) -> AuthResult<Url> {
        if path.contains(['\\', '?', '#']) || path.starts_with('/') || path.contains("..") {
            return Err(AuthError::EndpointNotAllowed);
        }
        let mut base = self.api_base.clone();
        let base_path = base.path().trim_end_matches('/');
        base.set_path(&format!("{base_path}/{path}"));
        Ok(base)
    }

    fn load_stored_credential(&self) -> AuthResult<Option<StoredCredential>> {
        let Some(secret) = self.credentials.load()? else {
            return Ok(None);
        };
        let credential = match serde_json::from_str::<StoredCredential>(&secret) {
            Ok(value) => value,
            Err(_) => {
                self.credentials.delete()?;
                return Ok(None);
            }
        };
        if credential.api_base_url != self.api_base.to_string()
            || validate_stored_credential(&credential).is_err()
        {
            self.credentials.delete()?;
            return Ok(None);
        }
        Ok(Some(credential))
    }

    fn save_credential(&self, credential: &StoredCredential) -> AuthResult<()> {
        let secret = serde_json::to_string(credential).map_err(|_| AuthError::InvalidCredential)?;
        if let Err(error) = self.credentials.save(&secret) {
            let _ = self.credentials.delete();
            return Err(error);
        }
        Ok(())
    }
}

fn decode_success<T: DeserializeOwned>(response: HttpResponse) -> AuthResult<T> {
    if !(200..300).contains(&response.status) {
        return Err(AuthError::Rejected(response.status));
    }
    serde_json::from_slice::<Envelope<T>>(&response.body)
        .map(|envelope| envelope.data)
        .map_err(|_| AuthError::InvalidResponse)
}

fn decode_oauth_success<T: DeserializeOwned>(response: HttpResponse) -> AuthResult<T> {
    if !(200..300).contains(&response.status) {
        return Err(AuthError::Rejected(response.status));
    }
    serde_json::from_slice(&response.body).map_err(|_| AuthError::InvalidResponse)
}

fn validate_stored_credential(credential: &StoredCredential) -> AuthResult<()> {
    if !valid_token_length(&credential.access_token)
        || !valid_refresh_token(&credential.refresh_token)
    {
        return Err(AuthError::InvalidCredential);
    }
    validate_user(&credential.user)?;
    let expires = parse_timestamp(&credential.expires_at)?;
    if expires - unix_timestamp()? > MAX_SESSION_LIFETIME_SECONDS {
        return Err(AuthError::InvalidCredential);
    }
    Ok(())
}

fn validate_token_result(token: &TokenResult) -> AuthResult<()> {
    if !valid_token_length(&token.access_token)
        || !valid_refresh_token(&token.refresh_token)
        || token.token_type != "Bearer"
    {
        return Err(AuthError::InvalidResponse);
    }
    validate_user(&token.user)?;
    let remaining = parse_timestamp(&token.expires_at)? - unix_timestamp()?;
    if !(MIN_SESSION_REMAINING_SECONDS..=MAX_SESSION_LIFETIME_SECONDS).contains(&remaining) {
        return Err(AuthError::InvalidResponse);
    }
    Ok(())
}

fn validate_refresh_token_result(token: &RefreshTokenResult) -> AuthResult<()> {
    if !valid_token_length(&token.access_token)
        || !valid_refresh_token(&token.refresh_token)
        || token.token_type != "Bearer"
        || !(MIN_SESSION_REMAINING_SECONDS..=MAX_SESSION_LIFETIME_SECONDS)
            .contains(&token.expires_in)
    {
        return Err(AuthError::InvalidResponse);
    }
    Ok(())
}

fn valid_token_length(value: &str) -> bool {
    (32..=16_384).contains(&value.len())
}

fn valid_refresh_token(value: &str) -> bool {
    (43..=16_384).contains(&value.len())
}

fn validate_user(user: &DesktopUser) -> AuthResult<()> {
    Uuid::parse_str(&user.id).map_err(|_| AuthError::InvalidResponse)?;
    if user.email.len() > 254
        || !user.email.contains('@')
        || user.display_name.is_empty()
        || user.display_name.len() > 120
        || user
            .platform_roles
            .iter()
            .any(|role| role != "platform_admin" && role != "official_reviewer")
    {
        return Err(AuthError::InvalidResponse);
    }
    Ok(())
}

fn validate_provider(provider: &AuthProviderDescriptor) -> AuthResult<()> {
    if !matches!(
        provider.id.as_str(),
        "email" | "password" | "google" | "feishu" | "wechat"
    ) || provider.label.is_empty()
        || !matches!(
            provider.protocol.as_str(),
            "email_otp" | "password" | "oidc"
        )
        || !matches!(
            provider.status.as_str(),
            "active" | "configured" | "disabled"
        )
    {
        return Err(AuthError::InvalidResponse);
    }
    if let Some(url) = &provider.authorize_url {
        validate_authorization_url(url)?;
    }
    Ok(())
}

fn parse_timestamp(value: &str) -> AuthResult<i64> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|value| value.unix_timestamp())
        .map_err(|_| AuthError::InvalidResponse)
}

fn unix_timestamp() -> AuthResult<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .map_err(|_| AuthError::Transport)
}

fn validate_broker_endpoint(method: DesktopApiMethod, path: &str) -> AuthResult<()> {
    if !matches!(method, DesktopApiMethod::Get)
        || !path.starts_with('/')
        || path.contains(['\\', '?', '#'])
        || path.contains("..")
    {
        return Err(AuthError::EndpointNotAllowed);
    }
    let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
    let allowed = matches!(
        segments.as_slice(),
        ["auth", "session"] | ["auth", "providers"] | ["workspaces"] | ["catalog"]
    ) || matches!(segments.as_slice(), ["workspaces", id, "applications"] if Uuid::parse_str(id).is_ok())
        || matches!(segments.as_slice(), ["releases", id, "status"] if Uuid::parse_str(id).is_ok());
    if allowed {
        Ok(())
    } else {
        Err(AuthError::EndpointNotAllowed)
    }
}

impl LoginMaterial {
    fn generate() -> AuthResult<Self> {
        let verifier = random_base64url(48)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Ok(Self {
            verifier,
            challenge,
            state: random_base64url(32)?,
        })
    }
}

fn random_base64url(bytes: usize) -> AuthResult<String> {
    let mut value = vec![0_u8; bytes];
    // Failure means the operating system cannot provide cryptographic entropy;
    // continuing with weaker randomness would break the PKCE/state boundary.
    getrandom::fill(&mut value).map_err(|_| AuthError::Transport)?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

fn validate_pkce_value(value: &str) -> AuthResult<()> {
    if !(43..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AuthError::InvalidCallback);
    }
    Ok(())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    let longest = left.len().max(right.len());
    for index in 0..longest {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn validate_authorization_url(value: &str) -> AuthResult<Url> {
    let url = Url::parse(value).map_err(|_| AuthError::InvalidResponse)?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AuthError::InvalidResponse);
    }
    Ok(url)
}

fn configured_api_base() -> AuthResult<Url> {
    let configured = if cfg!(debug_assertions) {
        std::env::var("AW_API_BASE_URL").ok()
    } else {
        option_env!("AW_API_BASE_URL").map(str::to_owned)
    };
    let mut url = Url::parse(configured.as_deref().unwrap_or(DEFAULT_API_BASE))
        .map_err(|_| AuthError::InvalidApiBase)?;
    let local_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AuthError::InvalidApiBase);
    }
    let normalized = url.path().trim_end_matches('/').to_owned();
    if normalized.is_empty() || normalized == "/" {
        return Err(AuthError::InvalidApiBase);
    }
    url.set_path(&normalized);
    Ok(url)
}

struct ReqwestTransport {
    client: Client,
}

impl ReqwestTransport {
    fn new() -> AuthResult<Self> {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .build()
            .map(|client| Self { client })
            .map_err(|_| AuthError::Transport)
    }
}

impl HttpTransport for ReqwestTransport {
    fn send(&self, request: HttpRequest) -> AuthResult<HttpResponse> {
        let method = match request.method {
            HttpMethod::Get => Method::GET,
            HttpMethod::Post => Method::POST,
        };
        let mut builder = self
            .client
            .request(method, request.url)
            .header("accept", "application/json");
        if let Some(locale) = request.accept_language {
            builder = builder.header("accept-language", locale);
        }
        if let Some(token) = request.bearer {
            builder = builder.bearer_auth(token);
        }
        match (request.body, request.form) {
            (Some(body), None) => builder = builder.json(&body),
            (None, Some(form)) => builder = builder.form(&form),
            (None, None) => {}
            (Some(_), Some(_)) => return Err(AuthError::InvalidResponse),
        }
        let response = builder.send().map_err(|_| AuthError::Transport)?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES)
        {
            return Err(AuthError::ResponseTooLarge);
        }
        let mut body = Vec::new();
        response
            .take(MAX_HTTP_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| AuthError::Transport)?;
        if body.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
            return Err(AuthError::ResponseTooLarge);
        }
        Ok(HttpResponse { status, body })
    }
}

struct SystemBrowser;

impl BrowserLauncher for SystemBrowser {
    fn open(&self, url: &Url) -> AuthResult<()> {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler").arg(url.as_str());
            command
        } else if cfg!(target_os = "macos") {
            let mut command = Command::new("/usr/bin/open");
            command.arg(url.as_str());
            command
        } else {
            return Err(AuthError::UnsupportedPlatform);
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut command);
        command
            .spawn()
            .map(|_| ())
            .map_err(|_| AuthError::BrowserUnavailable)
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

struct LoopbackReceiver {
    listener: TcpListener,
    redirect_uri: Url,
}

impl LoopbackReceiver {
    fn bind() -> AuthResult<Self> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| AuthError::Transport)?;
        listener
            .set_nonblocking(true)
            .map_err(|_| AuthError::Transport)?;
        let port = listener
            .local_addr()
            .map_err(|_| AuthError::Transport)?
            .port();
        let redirect_uri = Url::parse(&format!("http://127.0.0.1:{port}/callback"))
            .map_err(|_| AuthError::Transport)?;
        Ok(Self {
            listener,
            redirect_uri,
        })
    }
}

impl AuthorizationReceiver for LoopbackReceiver {
    fn redirect_uri(&self) -> &Url {
        &self.redirect_uri
    }

    fn receive(
        &self,
        expected_state: &str,
        timeout: Duration,
        locale: DesktopLocale,
    ) -> AuthResult<String> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.listener.accept() {
                Ok((mut stream, _)) => return read_callback(&mut stream, expected_state, locale),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(AuthError::CallbackTimeout);
                    }
                    thread::sleep(Duration::from_millis(15));
                }
                Err(_) => return Err(AuthError::Transport),
            }
        }
    }
}

fn read_callback(
    stream: &mut TcpStream,
    expected_state: &str,
    locale: DesktopLocale,
) -> AuthResult<String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| AuthError::Transport)?;
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    while request.len() <= MAX_CALLBACK_HEADER_BYTES {
        let count = stream
            .read(&mut buffer)
            .map_err(|_| AuthError::InvalidCallback)?;
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if request.len() > MAX_CALLBACK_HEADER_BYTES {
        write_callback_response(stream, 400, locale.callback_rejected());
        return Err(AuthError::InvalidCallback);
    }
    let request = std::str::from_utf8(&request).map_err(|_| AuthError::InvalidCallback)?;
    let first_line = request.lines().next().ok_or(AuthError::InvalidCallback)?;
    let mut parts = first_line.split_ascii_whitespace();
    let method = parts.next();
    let target = parts.next();
    let version = parts.next();
    if method != Some("GET") || version != Some("HTTP/1.1") || parts.next().is_some() {
        write_callback_response(stream, 400, locale.callback_rejected());
        return Err(AuthError::InvalidCallback);
    }
    let target = target.ok_or(AuthError::InvalidCallback)?;
    let url =
        Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| AuthError::InvalidCallback)?;
    let state = url
        .query_pairs()
        .find_map(|(key, value)| (key == "state").then(|| value.into_owned()))
        .ok_or(AuthError::InvalidCallback)?;
    let code = url
        .query_pairs()
        .find_map(|(key, value)| (key == "code").then(|| value.into_owned()))
        .ok_or(AuthError::InvalidCallback)?;
    if url.path() != "/callback"
        || !constant_time_eq(expected_state, &state)
        || validate_pkce_value(&code).is_err()
    {
        write_callback_response(stream, 400, locale.callback_rejected());
        return Err(AuthError::InvalidCallback);
    }
    write_callback_response(stream, 200, locale.callback_completed());
    Ok(code)
}

fn write_callback_response(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
struct NativeCredentialStore;

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl NativeCredentialStore {
    fn entry(&self) -> AuthResult<keyring::Entry> {
        keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
            .map_err(|_| AuthError::CredentialUnavailable)
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
impl CredentialStore for NativeCredentialStore {
    fn load(&self) -> AuthResult<Option<String>> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AuthError::CredentialUnavailable),
        }
    }

    fn save(&self, secret: &str) -> AuthResult<()> {
        self.entry()?
            .set_password(secret)
            .map_err(|_| AuthError::CredentialUnavailable)
    }

    fn delete(&self) -> AuthResult<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AuthError::CredentialUnavailable),
        }
    }
}

#[cfg(any(test, not(any(target_os = "windows", target_os = "macos"))))]
struct UnsupportedCredentialStore;

#[cfg(any(test, not(any(target_os = "windows", target_os = "macos"))))]
impl CredentialStore for UnsupportedCredentialStore {
    fn load(&self) -> AuthResult<Option<String>> {
        Err(AuthError::UnsupportedPlatform)
    }

    fn save(&self, _secret: &str) -> AuthResult<()> {
        Err(AuthError::UnsupportedPlatform)
    }

    fn delete(&self) -> AuthResult<()> {
        Err(AuthError::UnsupportedPlatform)
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn platform_credential_store() -> Arc<dyn CredentialStore> {
    Arc::new(NativeCredentialStore)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn platform_credential_store() -> Arc<dyn CredentialStore> {
    Arc::new(UnsupportedCredentialStore)
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;

    const USER_ID: &str = "6b20f21b-c5d7-48ee-8bce-15d07e631f35";

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);

    impl CredentialStore for MemoryStore {
        fn load(&self) -> AuthResult<Option<String>> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn save(&self, secret: &str) -> AuthResult<()> {
            *self.0.lock().unwrap() = Some(secret.to_owned());
            Ok(())
        }

        fn delete(&self) -> AuthResult<()> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    struct MockHttp {
        responses: Mutex<VecDeque<HttpResponse>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl MockHttp {
        fn new(responses: Vec<HttpResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl HttpTransport for MockHttp {
        fn send(&self, request: HttpRequest) -> AuthResult<HttpResponse> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(AuthError::Transport)
        }
    }

    #[derive(Default)]
    struct MockBrowser(Mutex<Vec<String>>);

    impl BrowserLauncher for MockBrowser {
        fn open(&self, url: &Url) -> AuthResult<()> {
            self.0.lock().unwrap().push(url.to_string());
            Ok(())
        }
    }

    struct FixedReceiver {
        redirect_uri: Url,
        code: String,
        callback_state: String,
    }

    impl AuthorizationReceiver for FixedReceiver {
        fn redirect_uri(&self) -> &Url {
            &self.redirect_uri
        }

        fn receive(
            &self,
            expected_state: &str,
            _timeout: Duration,
            _locale: DesktopLocale,
        ) -> AuthResult<String> {
            if !constant_time_eq(expected_state, &self.callback_state) {
                return Err(AuthError::InvalidCallback);
            }
            Ok(self.code.clone())
        }
    }

    fn response(status: u16, body: Value) -> HttpResponse {
        HttpResponse {
            status,
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    fn user_json() -> Value {
        serde_json::json!({
            "id": USER_ID,
            "email": "desktop@example.test",
            "displayName": "Desktop User",
            "platformRoles": ["official_reviewer"]
        })
    }

    fn future_expiry() -> String {
        expiry_after(60 * 60)
    }

    fn expiry_after(seconds: i64) -> String {
        (OffsetDateTime::now_utc() + time::Duration::seconds(seconds))
            .format(&Rfc3339)
            .unwrap()
    }

    fn stored_credential(
        access_token: &str,
        refresh_token: &str,
        expires_at: String,
    ) -> StoredCredential {
        StoredCredential {
            api_base_url: "https://api.example.test/api/v1".into(),
            access_token: access_token.into(),
            refresh_token: refresh_token.into(),
            expires_at,
            user: DesktopUser {
                id: USER_ID.into(),
                email: "desktop@example.test".into(),
                display_name: "Desktop User".into(),
                platform_roles: vec![],
            },
        }
    }

    #[test]
    fn pkce_uses_s256_and_state_comparison_is_strict() {
        let verifier = "v".repeat(64);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge.len(), 43);
        assert!(constant_time_eq("fixed-state", "fixed-state"));
        assert!(!constant_time_eq("fixed-state", "fixed-statf"));
        assert!(!constant_time_eq("fixed-state", "fixed-state-longer"));
    }

    #[test]
    fn desktop_locale_is_allowlisted_and_callback_copy_is_frozen() {
        assert_eq!(DesktopLocale::parse("zh-CN").unwrap(), DesktopLocale::ZhCn);
        assert_eq!(
            DesktopLocale::ZhCn.callback_completed(),
            "Awesome Workflow 登录已完成，你可以关闭此窗口。"
        );
        assert!(matches!(
            DesktopLocale::parse("fr-FR"),
            Err(AuthError::UnsupportedLocale)
        ));
    }

    #[test]
    fn concrete_loopback_receiver_accepts_only_the_expected_callback_shape() {
        let receiver = LoopbackReceiver::bind().unwrap();
        let address = receiver.listener.local_addr().unwrap();
        let state = "s".repeat(48);
        let code = "c".repeat(64);
        let state_for_request = state.clone();
        let code_for_request = code.clone();
        let sender = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            let target = format!("/callback?code={code_for_request}&state={state_for_request}");
            write!(
                stream,
                "GET {target} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.starts_with("HTTP/1.1 200 OK"));
        });
        assert_eq!(
            receiver
                .receive(&state, Duration::from_secs(2), DesktopLocale::EnUs)
                .unwrap(),
            code
        );
        sender.join().unwrap();
    }

    #[test]
    fn login_keeps_token_in_credential_store_and_returns_only_public_session() {
        let store = Arc::new(MemoryStore::default());
        let http = Arc::new(MockHttp::new(vec![
            response(
                200,
                serde_json::json!({"data": {"authorizationUrl": "https://login.example.test/approve"}}),
            ),
            response(
                200,
                serde_json::json!({"data": {
                    "accessToken": "secret-session-token-that-never-enters-the-webview",
                    "refreshToken": "secret-refresh-token-that-never-enters-the-webview-1234567890",
                    "tokenType": "Bearer",
                    "expiresAt": future_expiry(),
                    "user": user_json()
                }}),
            ),
        ]));
        let browser = Arc::new(MockBrowser::default());
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store.clone(),
            http.clone(),
            browser.clone(),
        );
        let material = LoginMaterial {
            verifier: "v".repeat(64),
            challenge: URL_SAFE_NO_PAD.encode(Sha256::digest("v".repeat(64).as_bytes())),
            state: "s".repeat(48),
        };
        let receiver = FixedReceiver {
            redirect_uri: Url::parse("http://127.0.0.1:54321/callback").unwrap(),
            code: "c".repeat(64),
            callback_state: material.state.clone(),
        };

        let session = auth
            .login_with_receiver(&receiver, material, DesktopLocale::ZhCn)
            .unwrap();
        let public = serde_json::to_string(&session).unwrap();
        assert!(!public.contains("secret-session-token"));
        assert!(!public.contains("secret-refresh-token"));
        assert!(store
            .0
            .lock()
            .unwrap()
            .as_deref()
            .unwrap()
            .contains("secret-session-token"));
        assert!(store
            .0
            .lock()
            .unwrap()
            .as_deref()
            .unwrap()
            .contains("secret-refresh-token"));
        assert_eq!(
            browser.0.lock().unwrap().as_slice(),
            ["https://login.example.test/approve"]
        );

        let requests = http.requests.lock().unwrap();
        assert!(requests[0].bearer.is_none());
        assert!(requests[1].bearer.is_none());
        assert_eq!(requests[0].accept_language.as_deref(), Some("zh-CN"));
        assert_eq!(requests[1].accept_language.as_deref(), Some("zh-CN"));
        let authorize = requests[0].body.as_ref().unwrap();
        assert_eq!(authorize["codeChallengeMethod"], "S256");
        assert_eq!(authorize["scope"], DESKTOP_OFFLINE_SCOPE);
        let token = requests[1].body.as_ref().unwrap();
        assert_eq!(token["codeVerifier"], "v".repeat(64));
    }

    #[test]
    fn session_provider_and_logout_requests_forward_the_selected_locale() {
        let store = Arc::new(MemoryStore::default());
        store
            .save(
                &serde_json::to_string(&stored_credential(
                    &"a".repeat(64),
                    &"r".repeat(64),
                    future_expiry(),
                ))
                .unwrap(),
            )
            .unwrap();
        let http = Arc::new(MockHttp::new(vec![
            response(200, serde_json::json!({"data": user_json()})),
            response(
                200,
                serde_json::json!({"data": [{
                    "id": "email",
                    "label": "Email",
                    "protocol": "email_otp",
                    "status": "active",
                    "strategy": "local_email_otp"
                }]}),
            ),
            response(204, Value::Null),
        ]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store,
            http.clone(),
            Arc::new(MockBrowser::default()),
        );

        assert!(auth.current("zh-CN").unwrap().is_some());
        assert_eq!(auth.providers("zh-CN").unwrap().len(), 1);
        auth.logout("zh-CN").unwrap();

        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests
            .iter()
            .all(|request| request.accept_language.as_deref() == Some("zh-CN")));
    }

    #[test]
    fn wrong_callback_state_never_persists_a_credential() {
        let store = Arc::new(MemoryStore::default());
        let http = Arc::new(MockHttp::new(vec![response(
            200,
            serde_json::json!({"data": {"authorizationUrl": "https://login.example.test/approve"}}),
        )]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store.clone(),
            http,
            Arc::new(MockBrowser::default()),
        );
        let receiver = FixedReceiver {
            redirect_uri: Url::parse("http://127.0.0.1:54321/callback").unwrap(),
            code: "c".repeat(64),
            callback_state: "attacker-state".into(),
        };
        let result = auth.login_with_receiver(
            &receiver,
            LoginMaterial {
                verifier: "v".repeat(64),
                challenge: "x".repeat(43),
                state: "s".repeat(48),
            },
            DesktopLocale::EnUs,
        );
        assert!(matches!(result, Err(AuthError::InvalidCallback)));
        assert!(store.0.lock().unwrap().is_none());
    }

    #[test]
    fn authenticated_broker_injects_bearer_and_rejects_open_proxy_paths() {
        let store = Arc::new(MemoryStore::default());
        let credential = StoredCredential {
            api_base_url: "https://api.example.test/api/v1".into(),
            access_token: "a".repeat(64),
            refresh_token: "r".repeat(64),
            expires_at: future_expiry(),
            user: DesktopUser {
                id: USER_ID.into(),
                email: "desktop@example.test".into(),
                display_name: "Desktop User".into(),
                platform_roles: vec![],
            },
        };
        store
            .save(&serde_json::to_string(&credential).unwrap())
            .unwrap();
        let http = Arc::new(MockHttp::new(vec![response(
            200,
            serde_json::json!({"data": []}),
        )]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store,
            http.clone(),
            Arc::new(MockBrowser::default()),
        );
        auth.authenticated_request(AuthenticatedApiInput {
            method: DesktopApiMethod::Get,
            path: "/workspaces".into(),
            locale: "zh-CN".into(),
        })
        .unwrap();
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].bearer.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(requests[0].accept_language.as_deref(), Some("zh-CN"));
        drop(requests);
        assert!(matches!(
            auth.authenticated_request(AuthenticatedApiInput {
                method: DesktopApiMethod::Get,
                path: "https://attacker.example/collect".into(),
                locale: "zh-CN".into(),
            }),
            Err(AuthError::EndpointNotAllowed)
        ));
    }

    #[test]
    fn near_expiry_refresh_rotates_keyring_secret_without_exposing_tokens() {
        let store = Arc::new(MemoryStore::default());
        store
            .save(
                &serde_json::to_string(&stored_credential(
                    &"a".repeat(64),
                    &"r".repeat(64),
                    expiry_after(5),
                ))
                .unwrap(),
            )
            .unwrap();
        let http = Arc::new(MockHttp::new(vec![
            response(
                200,
                serde_json::json!({
                    "access_token": "b".repeat(64),
                    "refresh_token": "s".repeat(64),
                    "token_type": "Bearer",
                    "expires_in": 3600
                }),
            ),
            response(200, serde_json::json!({"data": user_json()})),
        ]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store.clone(),
            http.clone(),
            Arc::new(MockBrowser::default()),
        );

        let session = auth.current("zh-CN").unwrap().unwrap();
        let public = serde_json::to_string(&session).unwrap();
        assert!(!public.contains(&"b".repeat(32)));
        assert!(!public.contains(&"s".repeat(43)));
        let persisted = store.0.lock().unwrap().clone().unwrap();
        assert!(persisted.contains(&"b".repeat(64)));
        assert!(persisted.contains(&"s".repeat(64)));
        assert!(!persisted.contains(&"r".repeat(64)));

        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert!(requests[0].bearer.is_none());
        assert!(requests[0].body.is_none());
        let form = requests[0].form.as_ref().unwrap();
        assert!(form.contains(&("grant_type".into(), "refresh_token".into())));
        assert!(form.contains(&("refresh_token".into(), "r".repeat(64))));
        assert!(form.contains(&("client_id".into(), DESKTOP_PUBLIC_CLIENT_ID.into())));
        assert_eq!(requests[1].bearer.as_deref(), Some("b".repeat(64).as_str()));
        assert!(requests
            .iter()
            .all(|request| request.accept_language.as_deref() == Some("zh-CN")));
    }

    #[test]
    fn unauthorized_request_refreshes_once_and_retries_with_rotated_access_token() {
        let store = Arc::new(MemoryStore::default());
        store
            .save(
                &serde_json::to_string(&stored_credential(
                    &"a".repeat(64),
                    &"r".repeat(64),
                    future_expiry(),
                ))
                .unwrap(),
            )
            .unwrap();
        let http = Arc::new(MockHttp::new(vec![
            response(401, serde_json::json!({"code": "unauthorized"})),
            response(
                200,
                serde_json::json!({
                    "access_token": "b".repeat(64),
                    "refresh_token": "s".repeat(64),
                    "token_type": "Bearer",
                    "expires_in": 3600
                }),
            ),
            response(200, serde_json::json!({"data": []})),
        ]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store,
            http.clone(),
            Arc::new(MockBrowser::default()),
        );

        let result = auth
            .authenticated_request(AuthenticatedApiInput {
                method: DesktopApiMethod::Get,
                path: "/workspaces".into(),
                locale: "zh-CN".into(),
            })
            .unwrap();
        assert_eq!(result.status, 200);
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].bearer.as_deref(), Some("a".repeat(64).as_str()));
        assert!(requests[1].form.is_some());
        assert_eq!(requests[2].bearer.as_deref(), Some("b".repeat(64).as_str()));
        assert!(requests
            .iter()
            .all(|request| request.accept_language.as_deref() == Some("zh-CN")));
    }

    #[test]
    fn refresh_failure_deletes_the_entire_local_credential() {
        let store = Arc::new(MemoryStore::default());
        store
            .save(
                &serde_json::to_string(&stored_credential(
                    &"a".repeat(64),
                    &"r".repeat(64),
                    expiry_after(5),
                ))
                .unwrap(),
            )
            .unwrap();
        let http = Arc::new(MockHttp::new(vec![response(
            400,
            serde_json::json!({"error": "invalid_grant"}),
        )]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store.clone(),
            http,
            Arc::new(MockBrowser::default()),
        );

        assert!(matches!(
            auth.current("zh-CN"),
            Err(AuthError::Rejected(400))
        ));
        assert!(store.0.lock().unwrap().is_none());
    }

    #[test]
    fn device_enrollment_secret_stays_on_the_dedicated_rust_path() {
        let store = Arc::new(MemoryStore::default());
        store
            .save(
                &serde_json::to_string(&stored_credential(
                    &"a".repeat(64),
                    &"r".repeat(64),
                    future_expiry(),
                ))
                .unwrap(),
            )
            .unwrap();
        let device_id = "fc2fb593-252b-4e72-b0de-0260bf6d66f2";
        let device_credential = format!("awd_{}", "d".repeat(43));
        let http = Arc::new(MockHttp::new(vec![response(
            201,
            serde_json::json!({"data": {
                "device": {"id": device_id},
                "credential": device_credential
            }}),
        )]));
        let auth = DesktopAuth::new(
            Url::parse("https://api.example.test/api/v1").unwrap(),
            store,
            http.clone(),
            Arc::new(MockBrowser::default()),
        );
        let body = serde_json::json!({
            "workspaceId": "9877598e-d5d5-4a19-a34c-2e78c2823345",
            "name": "Workstation",
            "os": "windows",
            "arch": "x64",
            "agentVersion": "0.1.0",
            "publicKeyThumbprint": "a".repeat(64)
        });

        let secret = auth.register_device(body.clone(), "zh-CN").unwrap();
        assert_eq!(secret.device_id, device_id);
        assert_eq!(secret.credential, device_credential);
        assert_eq!(auth.api_base_url(), "https://api.example.test/api/v1");
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].method, HttpMethod::Post);
        assert_eq!(requests[0].body.as_ref(), Some(&body));
        assert_eq!(requests[0].accept_language.as_deref(), Some("zh-CN"));
        drop(requests);
        assert!(matches!(
            auth.authenticated_request(AuthenticatedApiInput {
                method: DesktopApiMethod::Get,
                path: "/devices".into(),
                locale: "zh-CN".into(),
            }),
            Err(AuthError::EndpointNotAllowed)
        ));
    }

    #[test]
    fn unsupported_store_fails_closed() {
        assert!(matches!(
            UnsupportedCredentialStore.load(),
            Err(AuthError::UnsupportedPlatform)
        ));
        assert!(matches!(
            UnsupportedCredentialStore.save("secret"),
            Err(AuthError::UnsupportedPlatform)
        ));
    }
}
