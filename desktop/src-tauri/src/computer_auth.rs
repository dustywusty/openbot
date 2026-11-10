//! Desktop-owned ChatGPT authorization for VM coding harnesses.
//!
//! Registration follows https://developers.openai.com/siwc/token-sharing-open-source/sign-in.
//! Credentials are held in the operating system credential store, never the VM or webview.
//! The only listener is a short-lived loopback OAuth callback started by an explicit Connect.
//! No existing Codex credentials, OpenBot model credentials, or deployment `.env` are imported.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rand::RngCore;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "provider_oauth_lock.rs"]
mod credential_lock;

const REGISTRATION: &str = "computer-chatgpt-registration.json";
const SERVICE: &str = "ai.copilotkit.openbot.computer-chatgpt";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT_SCOPE: &str = "chatgpt.tokens.use.direct";
const CALLBACK_PATH: &str = "/auth/callback";
const SIGN_IN_TTL: Duration = Duration::from_secs(600);
const MAX_RESPONSE: u64 = 1024 * 1024;

/// Deliberately neither Serialize nor Clone. It may only cross the native guest-stdio boundary.
pub struct AccessToken(String);
impl AccessToken {
    pub fn into_secret(self) -> String {
        self.0
    }
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccessToken([REDACTED])")
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub attempt_id: String,
    pub authorization_url: String,
    pub expires_at: u64,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub connected: bool,
    pub pending: bool,
    pub attempt_id: Option<String>,
    pub account_name: Option<String>,
    pub email: Option<String>,
    pub expires_at: Option<u64>,
    pub error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutStatus {
    pub remote_revocation_confirmed: bool,
    pub warning: Option<String>,
}

// Nonsecret registration remains after logout; each desktop has its own stable host ID.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    host_id: String,
    #[serde(default)]
    grant_id: Option<String>,
    client_id: Option<String>,
    subject: Option<String>,
    account_name: Option<String>,
    email: Option<String>,
    connected: bool,
    expires_at: Option<u64>,
}
// Do not derive Debug: even error formatting must not expose the renewable grant.
#[derive(Serialize, Deserialize)]
struct Credentials {
    client_id: String,
    subject: String,
    access_token: String,
    refresh_token: String,
    id_token: String,
    expires_at: u64,
    scope: String,
}
struct Attempt {
    id: String,
    canceled: AtomicBool,
    completed: AtomicBool,
    error: Mutex<Option<String>>,
}
type Attempts = HashMap<PathBuf, Arc<Attempt>>;
static ATTEMPTS: OnceLock<Mutex<Attempts>> = OnceLock::new();
fn attempts() -> &'static Mutex<Attempts> {
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
struct Issuer {
    issuer: String,
    authorize: String,
    token: String,
    jwks: String,
    revoke: String,
}
impl Default for Issuer {
    fn default() -> Self {
        Self {
            issuer: "https://auth.openai.com".into(),
            authorize: "https://auth.openai.com/api/accounts/authorize".into(),
            token: "https://auth.openai.com/api/accounts/oauth/token".into(),
            jwks: "https://auth.openai.com/.well-known/jwks.json".into(),
            revoke: "https://auth.openai.com/api/accounts/oauth/revoke".into(),
        }
    }
}
trait CredentialStore: Send + Sync {
    fn load(&self, root: &Path) -> Result<Option<Credentials>, String>;
    fn save(&self, root: &Path, credentials: &Credentials) -> Result<(), String>;
    fn remove(&self, root: &Path) -> Result<(), String>;
}
struct SystemStore;
fn keyring_entry(root: &Path) -> Result<keyring::Entry, String> {
    let account = format!(
        "desktop-{:x}",
        Sha256::digest(root.as_os_str().to_string_lossy().as_bytes())
    );
    keyring::Entry::new(SERVICE, &account).map_err(|_| store_error())
}
fn store_error() -> String {
    "OpenBot could not access the system credential store. Unlock your keychain or credential manager, then connect ChatGPT again.".into()
}
impl CredentialStore for SystemStore {
    fn load(&self, root: &Path) -> Result<Option<Credentials>, String> {
        match keyring_entry(root)?.get_password() {
            Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
                "The saved computer sign-in is unreadable. Disconnect it and connect again.".into()
            }),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(store_error()),
        }
    }
    fn save(&self, root: &Path, credentials: &Credentials) -> Result<(), String> {
        let value = serde_json::to_string(credentials).map_err(|_| store_error())?;
        keyring_entry(root)?
            .set_password(&value)
            .map_err(|_| store_error())
    }
    fn remove(&self, root: &Path) -> Result<(), String> {
        match keyring_entry(root)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(store_error()),
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn new_host_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "urn:uuid:{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
fn prepare_host_id(registration: &mut Registration) -> bool {
    // Migrate only the old unregistered random-string format. Never replace a registered identity.
    if registration.client_id.is_none()
        && !registration.connected
        && (registration.host_id.is_empty() || Url::parse(&registration.host_id).is_err())
    {
        registration.host_id = new_host_id();
        true
    } else {
        false
    }
}

fn http() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not start the ChatGPT sign-in connection.".into())
}
fn read_registration(root: &Path) -> Result<Registration, String> {
    let path = root.join(REGISTRATION);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            return Err("The computer sign-in registration must be a regular file.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Registration::default())
        }
        Err(_) => return Err("Could not read the computer sign-in registration.".into()),
        _ => (),
    }
    let bytes =
        std::fs::read(path).map_err(|_| "Could not read the computer sign-in registration.")?;
    if bytes.len() > 16 * 1024 {
        return Err("The computer sign-in registration is too large.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The computer sign-in registration is unreadable.".into())
}
// This association contains no credentials. Its root comes only from the native deployment.
#[derive(Serialize, Deserialize)]
struct OwnerBinding {
    version: u8,
    installation_id: String,
    root_hash: String,
    owner: String,
    identity: String,
}
#[derive(Serialize, Deserialize)]
struct InstallationIdentity {
    id: String,
    root_hash: String,
}
fn read_metadata<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read the desktop sign-in association.".into()),
        Ok(meta) => meta,
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 16 * 1024 {
        return Err("The desktop sign-in association must be a small regular file.".into());
    }
    serde_json::from_slice(
        &std::fs::read(path).map_err(|_| "Could not read the desktop sign-in association.")?,
    )
    .map(Some)
    .map_err(|_| "The desktop sign-in association is unreadable.".into())
}
fn metadata_hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
/// Native-only deployment scope. Never accept this path from a webview command.
pub fn owner_scope(deployment_root: &Path) -> Result<PathBuf, String> {
    let deployment = deployment_root
        .canonicalize()
        .map_err(|_| "Could not locate this OpenBot installation.")?;
    let scope = ensure_root(&deployment.join("computer-identity"))?;
    let _lock = locked(&scope)?;
    let root_hash = metadata_hash(deployment.as_os_str().to_string_lossy().as_bytes());
    let path = scope.join("installation.json");
    match read_metadata::<InstallationIdentity>(&path)? {
        Some(saved) if saved.root_hash == root_hash && !saved.id.is_empty() => (),
        _ => {
            let identity = InstallationIdentity {
                id: random(),
                root_hash,
            };
            crate::env::write_private_file(
                &path,
                &serde_json::to_vec(&identity)
                    .map_err(|_| "Could not save this installation identity.")?,
            )
            .map_err(|_| "Could not save this installation identity.")?;
        }
    }
    Ok(scope)
}
/// Native-owned deployment identity; never accept an installation identifier from a webview.
pub fn installation_id(deployment_root: &Path) -> Result<String, String> {
    let scope = owner_scope(deployment_root)?;
    read_metadata::<InstallationIdentity>(&scope.join("installation.json"))?
        .map(|identity| identity.id)
        .ok_or("This OpenBot installation identity is missing.".into())
}

fn oauth_identity(registration: &Registration) -> Option<String> {
    if !registration.connected {
        return None;
    }
    let values = (
        &registration.host_id,
        registration.client_id.as_ref()?,
        registration.subject.as_ref()?,
        registration.grant_id.as_ref()?,
    );
    Some(metadata_hash(&serde_json::to_vec(&values).ok()?))
}
fn binding_matches(scope: &Path, registration: &Registration, owner: &str) -> Result<bool, String> {
    let Some(identity) = oauth_identity(registration) else {
        return Ok(false);
    };
    let Some(installation) =
        read_metadata::<InstallationIdentity>(&scope.join("installation.json"))?
    else {
        return Ok(false);
    };
    let Some(binding) = read_metadata::<OwnerBinding>(&scope.join("owner.json"))? else {
        return Ok(false);
    };
    Ok(binding.version == 1
        && binding.installation_id == installation.id
        && binding.root_hash == installation.root_hash
        && binding.owner == owner
        && binding.identity == identity)
}
/// Does not open the OS keychain. A saved association never grants any VM access itself.
pub fn owner_matches(scope: &Path, auth_root: &Path, owner: &str) -> Result<bool, String> {
    binding_matches(scope, &read_registration(auth_root)?, owner)
}
/// Call only after matching a completed native OAuth attempt to a current server-owned pairing.
pub fn bind_owner(
    scope: &Path,
    auth_root: &Path,
    owner: &str,
    completed_attempt: &str,
) -> Result<(), String> {
    let _lock = locked(auth_root)?;
    let registration = read_registration(auth_root)?;
    if registration.grant_id.as_deref() != Some(completed_attempt) {
        return Err("The ChatGPT sign-in changed. Connect again for this OpenBot account.".into());
    }
    let identity = oauth_identity(&registration)
        .ok_or("Connect ChatGPT again to associate this OpenBot installation.")?;
    let installation = read_metadata::<InstallationIdentity>(&scope.join("installation.json"))?
        .ok_or("This OpenBot installation identity is missing.")?;
    let binding = OwnerBinding {
        version: 1,
        installation_id: installation.id,
        root_hash: installation.root_hash,
        owner: owner.into(),
        identity,
    };
    crate::env::write_private_file(
        &scope.join("owner.json"),
        &serde_json::to_vec(&binding)
            .map_err(|_| "Could not save the desktop sign-in association.")?,
    )
    .map_err(|_| "Could not save the desktop sign-in association.".into())
}

fn save_registration(root: &Path, registration: &Registration) -> Result<(), String> {
    let bytes = serde_json::to_vec(registration)
        .map_err(|_| "Could not save the computer sign-in registration.")?;
    crate::env::write_private_file(&root.join(REGISTRATION), &bytes)
        .map_err(|_| "Could not save the computer sign-in registration.".into())
}
fn ensure_root(root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root)
        .map_err(|_| "Could not create the computer sign-in directory.")?;
    let meta = std::fs::symlink_metadata(root)
        .map_err(|_| "Could not inspect the computer sign-in directory.")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("The computer sign-in directory must be a regular directory.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not make the computer sign-in directory private.")?;
    }
    root.canonicalize()
        .map_err(|_| "Could not locate the computer sign-in directory.".into())
}
fn locked(root: &Path) -> Result<std::fs::File, String> {
    credential_lock::acquire(&root.join(REGISTRATION))
        .map_err(|_| "Another computer sign-in is being saved. Try again shortly.".into())
}
fn active(attempt: &Attempt) -> Result<(), String> {
    if attempt.canceled.load(Ordering::SeqCst) {
        Err("ChatGPT sign-in was canceled.".into())
    } else {
        Ok(())
    }
}

/// Only call in response to Connect. The caller opens authorization_url in the system browser.
/// It contains authorization parameters, never a token, code, or PKCE verifier.
pub fn start(root: &Path) -> Result<Authorization, String> {
    start_with(root, Issuer::default(), Arc::new(SystemStore))
}
fn start_with(
    root: &Path,
    issuer: Issuer,
    store: Arc<dyn CredentialStore>,
) -> Result<Authorization, String> {
    let root = ensure_root(root)?;
    let mut slots = attempts()
        .lock()
        .map_err(|_| "Could not start ChatGPT sign-in.")?;
    if let Some(previous) = slots.get(&root) {
        if !previous.completed.load(Ordering::SeqCst) {
            return Err(
                "ChatGPT sign-in is already open. Finish it or cancel it before trying again."
                    .into(),
            );
        }
    }
    let _lock = locked(&root)?;
    let mut registration = read_registration(&root)?;
    if prepare_host_id(&mut registration) {
        save_registration(&root, &registration)?;
    }
    if registration.host_id.is_empty() {
        return Err("The saved ChatGPT registration has no host identity. Disconnect it before connecting again.".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "Could not open the local ChatGPT sign-in callback.")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not start the ChatGPT sign-in callback.")?;
    let redirect = format!(
        "http://127.0.0.1:{}{CALLBACK_PATH}",
        listener
            .local_addr()
            .map_err(|_| "Could not read the ChatGPT callback port.")?
            .port()
    );
    let state = random();
    let nonce = random();
    let verifier = random();
    let mut url = Url::parse(&issuer.authorize)
        .map_err(|_| "The ChatGPT authorization address is invalid.")?;
    let client_id = registration
        .client_id
        .as_deref()
        .unwrap_or("dynamic_agent_client");
    {
        let mut params = url.query_pairs_mut();
        params
            .append_pair("client_id", client_id)
            .append_pair("ext_agent_host_id", &registration.host_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect)
            .append_pair("scope", SCOPE)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            );
        if client_id == "dynamic_agent_client" {
            params.append_pair("agent_name_hint", "OpenBot");
        }
        // No id_token_hint crosses the webview. Account selection remains in the system browser.
        if let Some(email) = registration.email.as_deref() {
            params.append_pair("login_hint", email);
        }
    }
    let attempt = Arc::new(Attempt {
        id: random(),
        canceled: AtomicBool::new(false),
        completed: AtomicBool::new(false),
        error: Mutex::new(None),
    });
    let result = Authorization {
        attempt_id: attempt.id.clone(),
        authorization_url: url.into(),
        expires_at: now() + SIGN_IN_TTL.as_secs(),
    };
    slots.insert(root.clone(), attempt.clone());
    drop(_lock);
    drop(slots);
    std::thread::spawn(move || {
        let result = finish(
            &root,
            &issuer,
            store.as_ref(),
            &attempt,
            listener,
            registration,
            &redirect,
            &state,
            &nonce,
            &verifier,
        );
        if let Err(error) = result {
            if let Ok(mut slot) = attempt.error.lock() {
                *slot = Some(error);
            }
        }
        attempt.completed.store(true, Ordering::SeqCst);
    });
    Ok(result)
}

/// Passive status reads nonsecret metadata only; it never opens the system credential store.
pub fn status(root: &Path) -> Result<AuthStatus, String> {
    let root = ensure_root(root)?;
    let registration = read_registration(&root)?;
    let slots = attempts()
        .lock()
        .map_err(|_| "Could not read ChatGPT sign-in status.")?;
    let attempt = slots.get(&root);
    Ok(AuthStatus {
        connected: registration.connected,
        pending: attempt.is_some_and(|a| !a.completed.load(Ordering::SeqCst)),
        attempt_id: attempt.map(|a| a.id.clone()),
        account_name: registration.account_name,
        email: registration.email,
        expires_at: registration.expires_at,
        error: attempt.and_then(|a| a.error.lock().ok().and_then(|e| e.clone())),
    })
}
/// Metadata-only account inventory. Validate the owner against this exact registration
/// snapshot before returning identity; never open Keychain or expose another pending account.
pub fn account_for_owner(
    root: &Path,
    scope: &Path,
    owner: &str,
) -> Result<Option<AuthStatus>, String> {
    let registration = read_registration(root)?;
    if !binding_matches(scope, &registration, owner)? {
        return Ok(None);
    }
    Ok(Some(AuthStatus {
        connected: registration.connected,
        account_name: registration.account_name,
        email: registration.email,
        expires_at: registration.expires_at,
        ..Default::default()
    }))
}
/// Cancel is idempotent and cannot cancel a newer attempt.
pub fn cancel(root: &Path, attempt_id: &str) -> Result<(), String> {
    let root = ensure_root(root)?;
    if let Some(attempt) = attempts()
        .lock()
        .map_err(|_| "Could not cancel ChatGPT sign-in.")?
        .get(&root)
    {
        if attempt.id == attempt_id {
            attempt.canceled.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

fn callback(
    stream: &mut TcpStream,
    state: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    stream
        .set_nonblocking(false)
        .map_err(|_| "Could not read the ChatGPT callback.")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Could not read the ChatGPT callback.")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Could not answer the ChatGPT callback.")?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 512];
    while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        let size = stream
            .read(&mut buffer)
            .map_err(|_| "Could not read the ChatGPT callback.")?;
        if size == 0 {
            return Ok(None);
        }
        bytes.extend_from_slice(&buffer[..size]);
        if bytes.len() > 8192 {
            return Ok(None);
        }
    }
    let request = std::str::from_utf8(&bytes).map_err(|_| "Invalid ChatGPT callback.")?;
    let mut line = request.lines().next().unwrap_or("").split_whitespace();
    let method = line.next().unwrap_or("");
    let target = line.next().unwrap_or("");
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "Invalid ChatGPT callback.")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let values = |key: &str| {
        pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.to_string())
            .collect::<Vec<_>>()
    };
    if method != "GET" || url.path() != CALLBACK_PATH || values("state") != [state] {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return Ok(None);
    }
    // Static page only: provider-controlled text, query parameters, and secrets are never echoed.
    let body = "ChatGPT sign-in received. You can return to OpenBot.";
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
    if !values("error").is_empty() {
        return Err("ChatGPT sign-in was declined or unavailable. Try Connect again.".into());
    }
    let codes = values("code");
    let clients = values("client_id");
    if codes.len() != 1 || codes[0].is_empty() || clients.len() > 1 {
        return Err("ChatGPT returned an incomplete authorization. Try Connect again.".into());
    }
    Ok(Some((codes[0].clone(), clients.first().cloned())))
}

#[allow(clippy::too_many_arguments)]
fn finish(
    root: &Path,
    issuer: &Issuer,
    store: &dyn CredentialStore,
    attempt: &Attempt,
    listener: TcpListener,
    mut registration: Registration,
    redirect: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + SIGN_IN_TTL;
    let (code, issued) = loop {
        active(attempt)?;
        if Instant::now() >= deadline {
            return Err("ChatGPT sign-in timed out. Choose Connect to try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, peer)) if peer.ip().is_loopback() => {
                if let Some(result) = callback(&mut stream, state)? {
                    break result;
                }
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(_) => return Err("The ChatGPT sign-in callback stopped. Try Connect again.".into()),
        }
    };
    drop(listener);
    active(attempt)?;
    let client_id = match registration.client_id.as_deref() {
        Some(saved) if issued.as_deref().is_none_or(|id| id == saved) => saved.to_owned(),
        Some(_) => return Err("ChatGPT returned a different registration. The existing account was kept.".into()),
        None => issued.filter(|id| id.starts_with("oaiapp_") && id.len() <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
            .ok_or("ChatGPT did not issue an OpenBot registration. Registration may be unavailable for this account. Try Connect again.")?,
    };
    if registration.client_id.is_none() {
        // An issued registration survives an invalid/expired code. Retrying must reuse this
        // public client ID rather than register another client for the same desktop host.
        let _lock = locked(root)?;
        active(attempt)?;
        let current = read_registration(root)?;
        if current
            .client_id
            .as_deref()
            .is_some_and(|id| id != client_id)
        {
            return Err("Another ChatGPT registration completed. Try Connect again.".into());
        }
        registration.client_id = Some(client_id.clone());
        save_registration(root, &registration)?;
    }
    let client = http()?;
    let tokens = token_request(
        &client,
        &issuer.token,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &client_id),
            ("code", &code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
            ("resource", RESOURCE),
        ],
    )?;
    let claims = verify_identity(&client, issuer, &tokens.id_token, &client_id, Some(nonce))?;
    if registration
        .subject
        .as_deref()
        .is_some_and(|subject| subject != claims.sub)
    {
        return Err(
            "The ChatGPT account changed during sign-in. The existing account was kept.".into(),
        );
    }
    let credentials = credentials(tokens, &client_id, &claims.sub, None)?;
    let _lock = locked(root)?;
    active(attempt)?;
    let current = read_registration(root)?;
    if current.client_id.as_deref() != Some(&client_id)
        || current
            .subject
            .as_deref()
            .is_some_and(|subject| subject != claims.sub)
    {
        return Err("The ChatGPT registration changed during sign-in. Try Connect again.".into());
    }
    store.save(root, &credentials)?;
    // The account becomes active only after signed identity and required scopes are verified.
    registration.client_id = Some(client_id);
    registration.subject = Some(claims.sub);
    registration.account_name = claims.name;
    registration.email = claims.email;
    registration.connected = true;
    registration.grant_id = Some(attempt.id.clone());
    registration.expires_at = Some(credentials.expires_at);
    save_registration(root, &registration)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: String,
    expires_in: u64,
    #[serde(default)]
    scope: Option<String>,
    token_type: String,
}
fn token_request(
    client: &Client,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<TokenResponse, String> {
    let response = client
        .post(endpoint)
        .form(form)
        .send()
        .map_err(|_| "Could not reach ChatGPT. Check your connection and try again.")?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            400 | 401 | 403 => "ChatGPT could not authorize OpenBot. Connect again; registration or plan usage may be unavailable for this account.",
            429 => "ChatGPT sign-in is busy. Wait a moment, then try again.",
            _ => "ChatGPT sign-in is temporarily unavailable. Try again shortly.",
        }.into());
    }
    let bytes = bounded_body(response)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "ChatGPT returned an incomplete token response. Connect again.".into())
}
fn bounded_body(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read ChatGPT's response.")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("ChatGPT returned an oversized response.".into());
    }
    Ok(bytes)
}
#[derive(Deserialize)]
struct Identity {
    sub: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
}
fn verify_identity(
    client: &Client,
    issuer: &Issuer,
    token: &str,
    client_id: &str,
    nonce: Option<&str>,
) -> Result<Identity, String> {
    let invalid = || "ChatGPT account verification failed. Connect again.".to_string();
    let header = decode_header(token).map_err(|_| invalid())?;
    if header.alg != Algorithm::RS256 {
        return Err(invalid());
    }
    let response = client.get(&issuer.jwks).send().map_err(|_| invalid())?;
    if !response.status().is_success() {
        return Err(invalid());
    }
    let keys: JwkSet = serde_json::from_slice(&bounded_body(response)?).map_err(|_| invalid())?;
    let key = keys
        .find(header.kid.as_deref().ok_or_else(invalid)?)
        .ok_or_else(invalid)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = 15;
    validation.set_issuer(&[&issuer.issuer]);
    validation.set_audience(&[client_id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let identity = decode::<Identity>(
        token,
        &DecodingKey::from_jwk(key).map_err(|_| invalid())?,
        &validation,
    )
    .map_err(|_| invalid())?
    .claims;
    if identity.sub.is_empty()
        || identity.sub.len() > 512
        || nonce.is_some_and(|expected| identity.nonce.as_deref() != Some(expected))
    {
        return Err(invalid());
    }
    Ok(identity)
}
fn credentials(
    tokens: TokenResponse,
    client_id: &str,
    subject: &str,
    old: Option<&Credentials>,
) -> Result<Credentials, String> {
    let scope = tokens
        .scope
        .or_else(|| old.map(|c| c.scope.clone()))
        .unwrap_or_default();
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.access_token.is_empty()
        || tokens.access_token.len() > 64 * 1024
        || tokens.expires_in == 0
        || tokens.expires_in > 7 * 24 * 3600
        || !scope.split_whitespace().any(|s| s == DIRECT_SCOPE)
    {
        return Err("ChatGPT did not grant plan usage to OpenBot. Connect again and allow ChatGPT plan usage.".into());
    }
    let refresh_token = tokens
        .refresh_token
        .or_else(|| old.map(|c| c.refresh_token.clone()))
        .filter(|t| !t.is_empty())
        .ok_or("ChatGPT did not provide a renewable session. Connect again.")?;
    let id_token = if tokens.id_token.is_empty() {
        old.map(|c| c.id_token.clone()).unwrap_or_default()
    } else {
        tokens.id_token
    };
    Ok(Credentials {
        client_id: client_id.into(),
        subject: subject.into(),
        access_token: tokens.access_token,
        refresh_token,
        id_token,
        expires_at: now() + tokens.expires_in,
        scope,
    })
}

/// Called only for an explicitly authorized coding turn. Refresh rotation is serialized across
/// threads and desktop processes. Only the current short-lived access token leaves this module.
pub fn access_token(root: &Path) -> Result<AccessToken, String> {
    access_token_with(root, &Issuer::default(), &SystemStore)
}
/// Checks the installation, OpenBot owner, and current OAuth account under the credential lock.
pub fn access_token_for_owner(
    root: &Path,
    scope: &Path,
    owner: &str,
) -> Result<AccessToken, String> {
    access_token_bound(root, &Issuer::default(), &SystemStore, Some((scope, owner)))
}

fn access_token_with(
    root: &Path,
    issuer: &Issuer,
    store: &dyn CredentialStore,
) -> Result<AccessToken, String> {
    access_token_bound(root, issuer, store, None)
}
fn access_token_bound(
    root: &Path,
    issuer: &Issuer,
    store: &dyn CredentialStore,
    owner: Option<(&Path, &str)>,
) -> Result<AccessToken, String> {
    let root = ensure_root(root)?;
    let _lock = locked(&root)?;
    let mut registration = read_registration(&root)?;
    if let Some((scope, owner)) = owner {
        if !binding_matches(scope, &registration, owner)? {
            return Err(
                "Connect ChatGPT for this OpenBot account and installation, then allow this VM."
                    .into(),
            );
        }
    }
    if !registration.connected {
        return Err("Connect ChatGPT in Computers before running this coding Bot.".into());
    }
    let saved = store
        .load(&root)?
        .ok_or("The ChatGPT computer sign-in is missing. Connect ChatGPT again.")?;
    if registration.client_id.as_deref() != Some(&saved.client_id)
        || registration.subject.as_deref() != Some(&saved.subject)
        || !saved.scope.split_whitespace().any(|s| s == DIRECT_SCOPE)
    {
        return Err(
            "The ChatGPT computer sign-in does not match this desktop. Connect again.".into(),
        );
    }
    if saved.expires_at > now() + 90 {
        return Ok(AccessToken(saved.access_token));
    }
    let client = http()?;
    let tokens = token_request(
        &client,
        &issuer.token,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", &saved.client_id),
            ("refresh_token", &saved.refresh_token),
            ("resource", RESOURCE),
        ],
    )?;
    if !tokens.id_token.is_empty() {
        let identity = verify_identity(&client, issuer, &tokens.id_token, &saved.client_id, None)?;
        if identity.sub != saved.subject {
            return Err(
                "ChatGPT returned a different account during renewal. Connect again.".into(),
            );
        }
    }
    let next = credentials(tokens, &saved.client_id, &saved.subject, Some(&saved))?;
    // Persist rotated credentials before returning the token. Never race a second refresh.
    store.save(&root, &next)?;
    registration.expires_at = Some(next.expires_at);
    save_registration(&root, &registration)?;
    Ok(AccessToken(next.access_token))
}

pub fn logout(root: &Path) -> Result<LogoutStatus, String> {
    logout_with(root, &Issuer::default(), &SystemStore)
}
fn logout_with(
    root: &Path,
    issuer: &Issuer,
    store: &dyn CredentialStore,
) -> Result<LogoutStatus, String> {
    let root = ensure_root(root)?;
    if let Some(attempt) = attempts()
        .lock()
        .map_err(|_| "Could not stop ChatGPT sign-in.")?
        .get(&root)
    {
        attempt.canceled.store(true, Ordering::SeqCst);
    }
    let _lock = locked(&root)?;
    let saved = store.load(&root)?;
    let mut confirmed = saved.is_none();
    if let Some(saved) = saved {
        if let Ok(client) = http() {
            confirmed = client
                .post(&issuer.revoke)
                .form(&[
                    ("token", saved.refresh_token.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", saved.client_id.as_str()),
                ])
                .send()
                .is_ok_and(|r| r.status().as_u16() == 200);
        }
    }
    store.remove(&root)?;
    let mut registration = read_registration(&root)?;
    registration.connected = false;
    registration.expires_at = None;
    save_registration(&root, &registration)?;
    Ok(LogoutStatus { remote_revocation_confirmed: confirmed,
        warning: (!confirmed).then(|| "Signed out on this desktop. Remote revocation was not confirmed; disconnect OpenBot in ChatGPT Settings to end the remote session.".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    const TEST_KEY: &str = r#"-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEAx2Rb2NAWc93BKjhxdtotriEqh9POJtS6jNGbJReRoEO2jqIY
rWebW/kXYtL9QkQRmnhnkT8ZDFUjJZHRluBtSac/Nzir8/H/vXSPAAFXrm4lXR8l
K8JZ0YwZYsY4DkZTr0+TBiWcI3wdvaVg7ta9jdxTAD7apWzOYSagalfUrWgf05Z8
HlspjrV5gL/UHu6PyFepa2WwDtbKYTkcTweXrTwPodZgBVZ76iIjY4GhkF9rWPwg
0AOecYg0G47eeU7w3il+8SHLrEnVaho/hKSoPegglvde75fYYXrFSN/9T2t8IiLw
Ef5khFuSxoQNi9+dTSMTCChTdeE7tzyHZNaRdwIDAQABAoIBAQCfRwwXpiJJbFth
3rTEvITBFL1kw01qt4RN+SJ1/t3VqEGsrtAHtTvlvJVx3BlzVey5+HTDEiRwNZJd
8J38aErlCzT0Z9D0jdw8+19AIdJpBJPUT4zh597YBZJB1RXyUTuIT4ii4GhZ8EvR
sso8AE5rhBTJnWwLuV8jPDfou0CpQ5j7kn5fgzUUEeUTtKsxppwdh7esGPV+Hpoc
P6S6Q2yFkUpGPKOkrfzetkTWmczK4aYC9zsSCPaIl0mY858NeDwlmUvjb79WcpjR
y+aKrzy2JbeDfTyA/bEULQ3oKCK3+bT/Uk/tfWfwaBW4ztLTctdNGbN7WKZgoG3f
8p4mIPwBAoGBAPxoRK+//RiUaRuaeOJ9KoKVF62cWNmBHI/lXSjudydSsJjYN2uh
aLcIgDnzK+IHIeiIxy843XInmVe00/0JRht5MMGUIMvE4J0KbbqFIa/4tnl7apIL
aHoaSk+zmvJXMsmEyhauwbStkbFUyHWcdE5J9DSJor3c9l7thXI4xCudAoGBAMo6
6UzAALQ6a7I25P5Gm5zT73MbBIlz93MnjCQ6f/myz0xsU1OuA4MZFsjUBNTza0bb
9Mv9d4ATaSOFGb8Bwl7zQ0t2X/gMuMshNzKUX5HABK0qUGY/6QVPfegFq6PZaZy9
2+d4xBfUhP/0DsiW0wB1zJjqHsTjDiflaNo3B5cjAoGACDv2ka03uoeM7kOZ0fm3
W0812IoTM/VMUz1uTpmI9ZVzAWl8VVyMp/v1Au717YfCCW384YN/Zev4yq2xhL26
tca8WnRUpZEkqrreXYleUflRKqFmFqGcpO8aoYMAeQtzMrPMS/UjiJto91oGuB+E
g9FR0Cz1TDBbMTmacuF7NNkCgYEAov60h23Bo4Hqx6tDCkcyqUaQmn/OOlNDwIbB
h3m3KDScrIYq6yk4H3QbTybD9jdz4ZrrRXc31/zNIxnmVHNAjHMZbDsuwqjOULqm
2JeKJ9lSa5fNUXx1fhhB7L6VRuy3GORV180Yj/R0di/psncN/jL0AtPAlQREppda
2Xa9IW0CgYEA+Oc7hXSkiKIkwugN2pnfLhseTlxT/9kjKEvsoCecq3kfKFWzfHFn
n8UJFaR4kzbizC3NMvcxs8g2vO9cDzLwrP0K/Pw3WctLN6giaoNBdwAAMyeJSboh
owvndzP6BwldvG9uxu7FHVEtr/+LMEC3lG3G9q/9Z58KjdtrnMpf9+g=
-----END RSA PRIVATE KEY-----
"#;
    const TEST_N: &str = "x2Rb2NAWc93BKjhxdtotriEqh9POJtS6jNGbJReRoEO2jqIYrWebW_kXYtL9QkQRmnhnkT8ZDFUjJZHRluBtSac_Nzir8_H_vXSPAAFXrm4lXR8lK8JZ0YwZYsY4DkZTr0-TBiWcI3wdvaVg7ta9jdxTAD7apWzOYSagalfUrWgf05Z8HlspjrV5gL_UHu6PyFepa2WwDtbKYTkcTweXrTwPodZgBVZ76iIjY4GhkF9rWPwg0AOecYg0G47eeU7w3il-8SHLrEnVaho_hKSoPegglvde75fYYXrFSN_9T2t8IiLwEf5khFuSxoQNi9-dTSMTCChTdeE7tzyHZNaRdw";
    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);
    impl CredentialStore for MemoryStore {
        fn load(&self, _: &Path) -> Result<Option<Credentials>, String> {
            self.0
                .lock()
                .unwrap()
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| "bad test credential".into())
        }
        fn save(&self, _: &Path, credentials: &Credentials) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(serde_json::to_string(credentials).unwrap());
            Ok(())
        }
        fn remove(&self, _: &Path) -> Result<(), String> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }
    struct FakeIssuer {
        endpoints: Issuer,
        token: Arc<Mutex<serde_json::Value>>,
        requests: Arc<Mutex<Vec<(String, String)>>>,
        stop: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl FakeIssuer {
        fn new() -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let endpoints = Issuer {
                issuer: base.clone(),
                authorize: format!("{base}/authorize"),
                token: format!("{base}/token"),
                jwks: format!("{base}/jwks"),
                revoke: format!("{base}/revoke"),
            };
            let token = Arc::new(Mutex::new(serde_json::json!({})));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (next_token, seen, done) = (token.clone(), requests.clone(), stop.clone());
            let worker = std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(value) => value,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(_) => break,
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut bytes = Vec::new();
                    let (path, body) = loop {
                        let mut buffer = [0u8; 4096];
                        let size = stream.read(&mut buffer).unwrap();
                        assert_ne!(size, 0);
                        bytes.extend_from_slice(&buffer[..size]);
                        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let header = std::str::from_utf8(&bytes[..end]).unwrap();
                            let length = header
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|s| s.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break (
                                    header
                                        .lines()
                                        .next()
                                        .unwrap()
                                        .split_whitespace()
                                        .nth(1)
                                        .unwrap()
                                        .to_owned(),
                                    String::from_utf8(bytes[end + 4..end + 4 + length].to_vec())
                                        .unwrap(),
                                );
                            }
                        }
                    };
                    seen.lock().unwrap().push((path.clone(), body));
                    let body = match path.as_str() {
                        "/jwks" => serde_json::json!({"keys":[{"kty":"RSA","kid":"test-key","use":"sig","alg":"RS256","n":TEST_N,"e":"AQAB"}]}).to_string(),
                        "/token" => next_token.lock().unwrap().to_string(),
                        "/revoke" => String::new(),
                        _ => "{}".into(),
                    };
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                }
            });
            Self {
                endpoints,
                token,
                requests,
                stop,
                worker: Some(worker),
            }
        }
        fn jwt(&self, nonce: &str) -> String {
            self.sign(serde_json::json!({"iss":self.endpoints.issuer,"aud":"oaiapp_test","exp":now()+3600,"sub":"account-test","nonce":nonce,"name":"Test Person","email":"test@example.invalid"}))
        }
        fn sign(&self, claims: serde_json::Value) -> String {
            let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
            header.kid = Some("test-key".into());
            jsonwebtoken::encode(
                &header,
                &claims,
                &jsonwebtoken::EncodingKey::from_rsa_pem(TEST_KEY.as_bytes()).unwrap(),
            )
            .unwrap()
        }
        fn set_tokens(&self, nonce: &str, expires: u64) {
            *self.token.lock().unwrap() = serde_json::json!({"access_token":"synthetic-access","refresh_token":"synthetic-refresh","id_token":self.jwt(nonce),"expires_in":expires,"scope":SCOPE,"token_type":"Bearer"});
        }
    }
    impl Drop for FakeIssuer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(worker) = self.worker.take() {
                worker.join().unwrap();
            }
        }
    }
    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("openbot-computer-auth-test-{}", random()));
        ensure_root(&path).unwrap()
    }
    fn query(url: &str) -> HashMap<String, String> {
        Url::parse(url)
            .unwrap()
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }
    fn visit_callback(authorization: &Authorization, correct_state: bool) {
        let values = query(&authorization.authorization_url);
        let mut url = Url::parse(&values["redirect_uri"]).unwrap();
        url.query_pairs_mut()
            .append_pair(
                "state",
                if correct_state {
                    &values["state"]
                } else {
                    "wrong-state"
                },
            )
            .append_pair("code", "synthetic-code")
            .append_pair("client_id", "oaiapp_test");
        let response = http().unwrap().get(url).send().unwrap();
        assert_eq!(
            response.status().as_u16(),
            if correct_state { 200 } else { 400 }
        );
    }
    fn completed(root: &Path) -> AuthStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = status(root).unwrap();
            if !status.pending {
                return status;
            }
            assert!(Instant::now() < deadline, "OAuth worker did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn host_identity_is_a_stable_uuid_v4_uri_and_migrates_only_unregistered_legacy_ids() {
        let mut registration = Registration::default();
        assert!(prepare_host_id(&mut registration));
        let id = registration.host_id.clone();
        assert!(id.starts_with("urn:uuid:"));
        assert!(Url::parse(&id).is_ok());
        let uuid = id.strip_prefix("urn:uuid:").unwrap();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
        assert!(matches!(&uuid[19..20], "8" | "9" | "a" | "b"));
        assert_eq!(uuid.chars().filter(|c| *c == '-').count(), 4);
        assert!(uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert!(!prepare_host_id(&mut registration));
        assert_eq!(registration.host_id, id);
        registration.host_id = "old_base64_random_host".into();
        assert!(prepare_host_id(&mut registration));
        registration.host_id = "registered_legacy_identity".into();
        registration.client_id = Some("registered-client".into());
        assert!(!prepare_host_id(&mut registration));
        assert_eq!(registration.host_id, "registered_legacy_identity");
        registration.host_id.clear();
        assert!(!prepare_host_id(&mut registration));
        assert!(registration.host_id.is_empty());
        registration.client_id = None;
        registration.connected = true;
        assert!(!prepare_host_id(&mut registration));
    }

    #[test]
    fn usage_account_metadata_is_visible_only_to_bound_owner_without_keychain() {
        let deployment = root();
        let auth = root();
        let scope = owner_scope(&deployment).unwrap();
        let mut registration = Registration {
            host_id: new_host_id(),
            client_id: Some("synthetic-client".into()),
            subject: Some("subject-a".into()),
            grant_id: Some("completed".into()),
            connected: true,
            account_name: Some("Owner".into()),
            email: Some("owner@example.test".into()),
            ..Default::default()
        };
        save_registration(&auth, &registration).unwrap();
        assert!(account_for_owner(&auth, &scope, "alice").unwrap().is_none());
        bind_owner(&scope, &auth, "alice", "completed").unwrap();
        let account = account_for_owner(&auth, &scope, "alice").unwrap().unwrap();
        assert_eq!(account.email.as_deref(), Some("owner@example.test"));
        assert!(!account.pending);
        assert!(account.attempt_id.is_none());
        assert!(account_for_owner(&auth, &scope, "bob").unwrap().is_none());
        registration.subject = Some("another-account".into());
        save_registration(&auth, &registration).unwrap();
        assert!(account_for_owner(&auth, &scope, "alice").unwrap().is_none());
        for path in [deployment, auth] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    #[test]
    fn owner_association_survives_reload_but_is_bound_to_installation_account_and_oauth_grant() {
        let deployment = root();
        let auth = root();
        let scope = owner_scope(&deployment).unwrap();
        let mut registration = Registration {
            host_id: new_host_id(),
            client_id: Some("client".into()),
            subject: Some("subject-a".into()),
            grant_id: Some("completed-attempt".into()),
            connected: true,
            ..Default::default()
        };
        save_registration(&auth, &registration).unwrap();
        assert!(
            !owner_matches(&scope, &auth, "alice").unwrap(),
            "old metadata must not be adopted"
        );
        assert!(bind_owner(&scope, &auth, "alice", "different-attempt").is_err());
        bind_owner(&scope, &auth, "alice", "completed-attempt").unwrap();
        let reloaded = owner_scope(&deployment).unwrap();
        assert!(owner_matches(&reloaded, &auth, "alice").unwrap());
        assert!(!owner_matches(&reloaded, &auth, "bob").unwrap());
        let other = root();
        let other_scope = owner_scope(&other).unwrap();
        std::fs::copy(scope.join("owner.json"), other_scope.join("owner.json")).unwrap();
        assert!(!owner_matches(&other_scope, &auth, "alice").unwrap());
        registration.subject = Some("subject-b".into());
        save_registration(&auth, &registration).unwrap();
        assert!(!owner_matches(&scope, &auth, "alice").unwrap());
        registration.subject = Some("subject-a".into());
        registration.grant_id = Some("new-sign-in".into());
        save_registration(&auth, &registration).unwrap();
        assert!(!owner_matches(&scope, &auth, "alice").unwrap());
        registration.grant_id = Some("completed-attempt".into());
        registration.connected = false;
        save_registration(&auth, &registration).unwrap();
        assert!(!owner_matches(&scope, &auth, "alice").unwrap());
        for path in [deployment, auth, other] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn bound_access_checks_owner_before_loading_credentials_and_rejects_legacy_metadata() {
        let deployment = root();
        let auth = root();
        let scope = owner_scope(&deployment).unwrap();
        let mut registration = Registration {
            host_id: new_host_id(),
            client_id: Some("client".into()),
            subject: Some("subject".into()),
            connected: true,
            ..Default::default()
        };
        save_registration(&auth, &registration).unwrap();
        assert!(bind_owner(&scope, &auth, "alice", "legacy").is_err());
        registration.grant_id = Some("fresh".into());
        save_registration(&auth, &registration).unwrap();
        bind_owner(&scope, &auth, "alice", "fresh").unwrap();
        let store = MemoryStore::default();
        let denied = access_token_bound(&auth, &Issuer::default(), &store, Some((&scope, "bob")));
        assert!(denied.err().unwrap().contains("this OpenBot account"));
        let allowed =
            access_token_bound(&auth, &Issuer::default(), &store, Some((&scope, "alice")));
        assert!(allowed.err().unwrap().contains("sign-in is missing"));
        for path in [deployment, auth] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn oauth_validates_identity_scopes_pkce_and_keeps_tokens_out_of_metadata() {
        let root = root();
        let issuer = FakeIssuer::new();
        let store = Arc::new(MemoryStore::default());
        let authorization = start_with(&root, issuer.endpoints.clone(), store.clone()).unwrap();
        let params = query(&authorization.authorization_url);
        assert_eq!(params["client_id"], "dynamic_agent_client");
        assert_eq!(params["agent_name_hint"], "OpenBot");
        assert_eq!(params["resource"], RESOURCE);
        issuer.set_tokens(&params["nonce"], 3600);
        visit_callback(&authorization, false);
        assert!(
            status(&root).unwrap().pending,
            "foreign state consumed the attempt"
        );
        visit_callback(&authorization, true);
        let status = completed(&root);
        assert!(status.connected, "{:?}", status.error);
        assert_eq!(status.account_name.as_deref(), Some("Test Person"));
        assert_eq!(
            access_token_with(&root, &issuer.endpoints, store.as_ref())
                .unwrap()
                .expose_secret(),
            "synthetic-access"
        );
        let requests = issuer.requests.lock().unwrap();
        let exchange = query(&format!(
            "http://test.invalid/?{}",
            requests.iter().find(|(p, _)| p == "/token").unwrap().1
        ));
        assert_eq!(exchange["client_id"], "oaiapp_test");
        assert_eq!(exchange["redirect_uri"], params["redirect_uri"]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(exchange["code_verifier"].as_bytes())),
            params["code_challenge"]
        );
        drop(requests);
        let registration = std::fs::read_to_string(root.join(REGISTRATION)).unwrap();
        for secret in [
            "synthetic-access",
            "synthetic-refresh",
            "id_token",
            "code_verifier",
        ] {
            assert!(!registration.contains(secret));
        }
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains("synthetic"));
        assert_eq!(
            format!("{:?}", AccessToken("do-not-print".into())),
            "AccessToken([REDACTED])"
        );
        let logout = logout_with(&root, &issuer.endpoints, store.as_ref()).unwrap();
        assert!(logout.remote_revocation_confirmed);
        assert!(store.load(&root).unwrap().is_none());
        assert!(!status.connected || !self::status(&root).unwrap().connected);
        assert!(access_token_with(&root, &issuer.endpoints, store.as_ref()).is_err());
        let returning = start_with(&root, issuer.endpoints.clone(), store.clone()).unwrap();
        let returning_params = query(&returning.authorization_url);
        assert_eq!(returning_params["client_id"], "oaiapp_test");
        assert_eq!(
            returning_params["ext_agent_host_id"],
            params["ext_agent_host_id"]
        );
        assert!(!returning_params.contains_key("agent_name_hint"));
        assert!(!returning_params.contains_key("id_token_hint"));
        cancel(&root, &returning.attempt_id).unwrap();
        completed(&root);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn identity_rejects_wrong_signature_nonce_audience_issuer_and_expiry() {
        let issuer = FakeIssuer::new();
        let client = http().unwrap();
        assert!(verify_identity(
            &client,
            &issuer.endpoints,
            &issuer.jwt("expected"),
            "oaiapp_test",
            Some("expected")
        )
        .is_ok());
        assert!(verify_identity(
            &client,
            &issuer.endpoints,
            &issuer.jwt("wrong"),
            "oaiapp_test",
            Some("expected")
        )
        .is_err());
        for (field, value) in [
            ("aud", serde_json::json!("foreign-client")),
            ("iss", serde_json::json!("https://foreign.invalid")),
            ("exp", serde_json::json!(now() - 120)),
        ] {
            let mut claims = serde_json::json!({"iss":issuer.endpoints.issuer,"aud":"oaiapp_test","exp":now()+3600,"sub":"account-test","nonce":"expected"});
            claims[field] = value;
            assert!(verify_identity(
                &client,
                &issuer.endpoints,
                &issuer.sign(claims),
                "oaiapp_test",
                Some("expected")
            )
            .is_err());
        }
        let jwt = issuer.jwt("expected");
        let mut parts: Vec<_> = jwt.split('.').map(str::to_owned).collect();
        parts[2] = URL_SAFE_NO_PAD.encode([0u8; 256]);
        assert!(verify_identity(
            &client,
            &issuer.endpoints,
            &parts.join("."),
            "oaiapp_test",
            Some("expected")
        )
        .is_err());
    }
    #[test]
    fn missing_direct_plan_scope_does_not_save_credentials() {
        let root = root();
        let issuer = FakeIssuer::new();
        let store = Arc::new(MemoryStore::default());
        let authorization = start_with(&root, issuer.endpoints.clone(), store.clone()).unwrap();
        issuer.set_tokens(&query(&authorization.authorization_url)["nonce"], 3600);
        issuer.token.lock().unwrap()["scope"] = serde_json::json!("openid profile email");
        visit_callback(&authorization, true);
        let status = completed(&root);
        assert!(!status.connected);
        assert!(status.error.unwrap().contains("plan usage"));
        assert!(store.load(&root).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refresh_rotation_is_serialized_and_latest_refresh_is_saved() {
        let root = root();
        let issuer = FakeIssuer::new();
        let store = Arc::new(MemoryStore::default());
        let authorization = start_with(&root, issuer.endpoints.clone(), store.clone()).unwrap();
        issuer.set_tokens(&query(&authorization.authorization_url)["nonce"], 1);
        visit_callback(&authorization, true);
        assert!(completed(&root).connected);
        *issuer.token.lock().unwrap() = serde_json::json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600,"token_type":"bearer"});
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (root, endpoints, store) =
                    (root.clone(), issuer.endpoints.clone(), store.clone());
                std::thread::spawn(move || {
                    access_token_with(&root, &endpoints, store.as_ref())
                        .unwrap()
                        .into_secret()
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), "rotated-access");
        }
        let requests = issuer.requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|(p, _)| p == "/token").count(), 2);
        let refresh = query(&format!(
            "http://test.invalid/?{}",
            requests
                .iter()
                .rev()
                .find(|(p, _)| p == "/token")
                .unwrap()
                .1
        ));
        assert_eq!(refresh["grant_type"], "refresh_token");
        assert_eq!(refresh["client_id"], "oaiapp_test");
        assert!(!refresh.contains_key("scope"));
        assert_eq!(
            store.load(&root).unwrap().unwrap().refresh_token,
            "rotated-refresh"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn canceled_attempt_closes_listener_and_cannot_replace_account() {
        let root = root();
        let issuer = FakeIssuer::new();
        let store = Arc::new(MemoryStore::default());
        let authorization = start_with(&root, issuer.endpoints.clone(), store.clone()).unwrap();
        assert!(start_with(&root, issuer.endpoints.clone(), store.clone()).is_err());
        cancel(&root, "foreign-attempt").unwrap();
        assert!(status(&root).unwrap().pending);
        cancel(&root, &authorization.attempt_id).unwrap();
        let status = completed(&root);
        assert!(!status.connected);
        assert!(status.error.unwrap().contains("canceled"));
        let callback =
            Url::parse(&query(&authorization.authorization_url)["redirect_uri"]).unwrap();
        assert!(TcpStream::connect(("127.0.0.1", callback.port().unwrap())).is_err());
        assert!(store.load(&root).unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
