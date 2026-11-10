//! Guest Computer operations over the existing server's authenticated outbound connection.
//! No listener, host shell, host paths, or credentials are exposed by this worker.
use openbot_desktop_lib::computer_pairing::{Binding, PairingStore, Voucher};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_ACTIVE: usize = 4;
const MAX_REPLAY: usize = 4096;
const MAX_WIRE: u64 = 1024 * 1024;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn manager() -> Result<openbot_workspaces::Manager, String> {
    openbot_workspaces::Manager::new(openbot_workspaces::default_root()?)
}
pub fn auth_root() -> Result<std::path::PathBuf, String> {
    Ok(openbot_workspaces::default_root()?.join("auth"))
}
fn valid_id(value: &str) -> bool {
    value.len() == 20
        && value.starts_with("obw-")
        && value[4..]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_operation(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    ListFiles {
        path: String,
    },
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        content: String,
        #[serde(default)]
        append: bool,
    },
    RunCommand {
        command: String,
    },
    Models {
        runtime: String,
    },
    HarnessTurn {
        runtime: String,
        prompt: String,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        speed: Option<String>,
        permission: String,
        #[serde(rename = "developerInstructions")]
        developer_instructions: Option<String>,
    },
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    operation_id: String,
    computer_id: String,
    actor_id: String,
    bot_id: String,
    thread_id: String,
    run_id: String,
    expires_at: u64,
    action: Action,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Poll {
    connection_id: String,
    server_audience: String,
    installation_id: String,
    operations: Vec<Operation>,
    cancellations: Vec<String>,
    lease_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    computer: RegisteredComputer,
    owner_user_id: String,
    connection_id: String,
    reconnect: Reconnect,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reconnect {
    binding_id: String,
    server_audience: String,
    installation_id: String,
    voucher: Option<Voucher>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActorProof {
    owner_user_id: String,
    computer_id: String,
    installation_id: String,
    server_audience: String,
    connection_id: String,
    purpose: String,
    binding_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageProof {
    purpose: String,
    owner_user_id: String,
    installation_id: String,
    server_audience: String,
    connection_id: String,
    installation_visible: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredComputer {
    pub computer_id: String,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAuthStatus {
    #[serde(flatten)]
    status: openbot_desktop_lib::computer_auth::AuthStatus,
    allowed: bool,
    can_allow: bool,
    paired: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ack {
    accepted_sequence: u64,
    finished: bool,
}
#[derive(Clone, PartialEq, Eq)]
struct Pairing {
    binding_id: String,
    owner: String,
    connection: String,
}
struct AuthIntent {
    attempt: String,
    pairing: Pairing,
}
struct Active {
    computer_id: String,
    cancel: openbot_workspaces::CodexCancellation,
    finished: Arc<AtomicBool>,
    harness: bool,
    binding: Option<String>,
}
#[derive(Default)]
struct State {
    authority_generation: u64,
    deleting: HashSet<String>,
    connection: Option<String>,
    server_audience: Option<String>,
    pairings: HashMap<String, Pairing>,
    seen: HashSet<String>,
    active: HashMap<String, Active>,
    auth_intents: HashMap<String, AuthIntent>,
    auth_grants: HashMap<String, Pairing>,
}
impl State {
    fn revoke(&mut self) {
        self.authority_generation = self.authority_generation.saturating_add(1);
        for active in self.active.values() {
            active.cancel.cancel();
        }
        self.pairings.clear();
        self.auth_intents.clear();
        self.auth_grants.clear();
    }
    fn connection(&mut self, id: &str) {
        if self.connection.as_deref() != Some(id) {
            self.revoke();
            self.seen.clear();
            self.connection = Some(id.to_owned());
        }
    }
    fn authorized(&self, operation: &Operation) -> bool {
        !self.deleting.contains(&operation.computer_id)
            && self
                .pairings
                .get(&operation.computer_id)
                .is_some_and(|pairing| {
                    pairing.owner == operation.actor_id
                        && self.connection.as_deref() == Some(pairing.connection.as_str())
                })
    }
    fn coding_allowed(&self, operation: &Operation) -> bool {
        self.authorized(operation)
            && self
                .auth_grants
                .get(&operation.computer_id)
                .is_some_and(|grant| {
                    grant.owner == operation.actor_id
                        && self
                            .pairings
                            .get(&operation.computer_id)
                            .is_some_and(|pairing| pairing.binding_id == grant.binding_id)
                        && self.connection.as_deref() == Some(grant.connection.as_str())
                })
    }
    fn binding_busy(&self, binding: &str) -> bool {
        self.active.values().any(|active| {
            active.binding.as_deref() == Some(binding) && !active.finished.load(Ordering::SeqCst)
        })
    }
}
struct Inner {
    owner_scope: std::path::PathBuf,
    installation: String,
    store: Option<Arc<PairingStore>>,
    notify: Option<Arc<dyn Fn(String) + Send + Sync>>,
    base: String,
    token: String,
    client: Client,
    stopped: AtomicBool,
    state: Mutex<State>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    jobs: Mutex<Vec<thread::JoinHandle<()>>>,
    auth_action: Mutex<()>,
    pairing_action: Mutex<()>,
}
#[derive(Clone)]
pub struct ComputerWorker {
    inner: Arc<Inner>,
}
#[derive(Clone)]
struct QueuedEvent {
    connection: String,
    operation: String,
    sequence: u64,
    event: Value,
}

impl ComputerWorker {
    pub fn is_for(&self, root: &std::path::Path, port: u16, token: &str) -> bool {
        root.canonicalize()
            .is_ok_and(|root| self.inner.owner_scope == root.join("computer-identity"))
            && !self.inner.stopped.load(Ordering::SeqCst)
            && self.inner.base == format!("http://127.0.0.1:{port}/api/desktop-computers")
            && self.inner.token == token
    }
    fn paired(&self, id: &str) -> Result<Pairing, String> {
        if !valid_id(id) {
            return Err("Choose an existing Computer.".into());
        }
        manager()?.get(id)?;
        let state = self.inner.state.lock().unwrap();
        let pairing = state
            .pairings
            .get(id)
            .filter(|pairing| {
                !state.deleting.contains(id)
                    && state.connection.as_deref() == Some(pairing.connection.as_str())
            })
            .cloned()
            .ok_or("Pair this Computer with your account first.")?;
        Ok(pairing)
    }
    /// The browser supplies only a one-use server-authenticated current-actor proof.
    /// Inventory is public registration metadata, never Keychain or a host CLI login.
    pub fn service_usage(
        &self,
        ticket: &str,
    ) -> Result<openbot_desktop_lib::provider_usage::ServiceUsageSnapshot, String> {
        self.service_usage_with(ticket, |proof| {
            let root = self
                .inner
                .owner_scope
                .parent()
                .ok_or("OpenBot installation is unavailable.")?;
            openbot_desktop_lib::provider_usage::read_metadata(
                proof.installation_visible,
                || openbot_desktop_lib::saved_intent::SavedIntent::read(root).model,
                || {
                    openbot_desktop_lib::computer_auth::account_for_owner(
                        &auth_root()?,
                        &self.inner.owner_scope,
                        &proof.owner_user_id,
                    )
                },
            )
        })
    }
    fn service_usage_with(
        &self,
        ticket: &str,
        read: impl FnOnce(
            &UsageProof,
        )
            -> Result<openbot_desktop_lib::provider_usage::ServiceUsageSnapshot, String>,
    ) -> Result<openbot_desktop_lib::provider_usage::ServiceUsageSnapshot, String> {
        if ticket.len() != 64
            || !ticket
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Get a fresh model-connection authorization and try again.".into());
        }
        let response = self
            .inner
            .client
            .post(format!(
                "{}/desktop/model-connections/redeem",
                self.inner.base
            ))
            .bearer_auth(&self.inner.token)
            .json(&json!({"ticket":ticket}))
            .send()
            .map_err(|_| "Model-connection authorization could not be checked.")?;
        let proof: UsageProof = decode(response)?;
        self.check_usage_proof(&proof)?;
        let snapshot = read(&proof)?;
        // Discard the metadata if the trusted server authority changed during the read.
        self.check_usage_proof(&proof)?;
        Ok(snapshot)
    }
    fn check_usage_proof(&self, proof: &UsageProof) -> Result<(), String> {
        let state = self.inner.state.lock().unwrap();
        if self.inner.stopped.load(Ordering::SeqCst)
            || proof.purpose != "usage"
            || proof.owner_user_id.is_empty()
            || proof.owner_user_id.len() > 256
            || proof.owner_user_id.chars().any(char::is_control)
            || proof.installation_id != self.inner.installation
            || state.connection.as_deref() != Some(proof.connection_id.as_str())
            || state.server_audience.as_deref() != Some(proof.server_audience.as_str())
        {
            return Err("Model-connection authorization changed. Refresh and try again.".into());
        }
        Ok(())
    }
    fn actor_proof(&self, id: &str, ticket: &str, purpose: &str) -> Result<ActorProof, String> {
        if !valid_id(id)
            || ticket.len() != 64
            || !ticket
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Get a fresh workspace authorization and try again.".into());
        }
        let response = self
            .inner
            .client
            .post(format!("{}/desktop/actor-ticket/redeem", self.inner.base))
            .bearer_auth(&self.inner.token)
            .json(&json!({"ticket":ticket,"computerId":id,"purpose":purpose}))
            .send()
            .map_err(|_| "Workspace authorization could not be checked.")?;
        let proof: ActorProof = decode(response)?;
        let state = self.inner.state.lock().unwrap();
        if proof.computer_id != id
            || proof.purpose != purpose
            || proof.installation_id != self.inner.installation
            || proof.binding_id.len() != 36
            || !proof.binding_id.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
            || proof.owner_user_id.is_empty()
            || proof.owner_user_id.len() > 256
            || state.connection.as_deref() != Some(proof.connection_id.as_str())
            || state.server_audience.as_deref() != Some(proof.server_audience.as_str())
            || state.deleting.contains(id)
        {
            return Err("Workspace authorization changed. Refresh and try again.".into());
        }
        Ok(proof)
    }
    fn actor_pairing(&self, id: &str, ticket: &str, purpose: &str) -> Result<Pairing, String> {
        let proof = self.actor_proof(id, ticket, purpose)?;
        let pairing = self.paired(id)?;
        if pairing.owner != proof.owner_user_id
            || pairing.connection != proof.connection_id
            || pairing.binding_id != proof.binding_id
        {
            return Err("This workspace belongs to another OpenBot account.".into());
        }
        Ok(pairing)
    }
    fn current_pairing(&self, id: &str, pairing: &Pairing) -> bool {
        let state = self.inner.state.lock().unwrap();
        !state.deleting.contains(id)
            && state.connection.as_deref() == Some(pairing.connection.as_str())
            && state.pairings.get(id).is_some_and(|current| {
                current.owner == pairing.owner
                    && current.binding_id == pairing.binding_id
                    && current.connection == pairing.connection
            })
    }
    pub fn auth_start(
        &self,
        id: &str,
        ticket: &str,
    ) -> Result<openbot_desktop_lib::computer_auth::Authorization, String> {
        let _action = self
            .inner
            .auth_action
            .try_lock()
            .map_err(|_| "Computer sign-in is busy.")?;
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        let pairing = self.actor_pairing(id, ticket, "start")?;
        if openbot_desktop_lib::computer_auth::status(&auth_root()?)?.pending {
            return Err(
                "A ChatGPT sign-in is already in progress. Finish or cancel it first.".into(),
            );
        }
        if !self.current_pairing(id, &pairing) {
            return Err("The workspace connection changed. Refresh and try again.".into());
        }
        self.clear_auth_grants();
        let authorization = openbot_desktop_lib::computer_auth::start(&auth_root()?)?;
        let mut state = self.inner.state.lock().unwrap();
        if state.connection.as_deref() != Some(pairing.connection.as_str())
            || state.deleting.contains(id)
            || !state.pairings.get(id).is_some_and(|current| {
                current.owner == pairing.owner
                    && current.connection == pairing.connection
                    && current.binding_id == pairing.binding_id
            })
        {
            let _ = openbot_desktop_lib::computer_auth::cancel(
                &auth_root()?,
                &authorization.attempt_id,
            );
            return Err("The Computer connection changed. Pair it again.".into());
        }
        state.auth_intents.insert(
            id.to_owned(),
            AuthIntent {
                attempt: authorization.attempt_id.clone(),
                pairing,
            },
        );
        Ok(authorization)
    }
    pub fn auth_status(&self, id: &str, ticket: &str) -> Result<ComputerAuthStatus, String> {
        let _action = self
            .inner
            .auth_action
            .try_lock()
            .map_err(|_| "Computer sign-in is busy.")?;
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        let redacted = || ComputerAuthStatus {
            status: Default::default(),
            allowed: false,
            can_allow: false,
            paired: false,
        };
        let pairing = match self.actor_pairing(id, ticket, "status") {
            Ok(pairing) => pairing,
            Err(_) => return Ok(redacted()),
        };
        let auth_root = auth_root()?;
        let mut status = openbot_desktop_lib::computer_auth::status(&auth_root)?;
        if !self.current_pairing(id, &pairing) {
            return Ok(redacted());
        }
        let mut state = self.inner.state.lock().unwrap();
        if state.deleting.contains(id)
            || state.connection.as_deref() != Some(pairing.connection.as_str())
            || !state.pairings.get(id).is_some_and(|current| {
                current.owner == pairing.owner
                    && current.connection == pairing.connection
                    && current.binding_id == pairing.binding_id
            })
        {
            return Ok(redacted());
        }
        if status.connected && !status.pending && status.error.is_none() {
            if let Some(intent) = state.auth_intents.get(id) {
                if status.attempt_id.as_deref() == Some(intent.attempt.as_str())
                    && state.connection.as_deref() == Some(intent.pairing.connection.as_str())
                    && state.pairings.get(id).is_some_and(|pairing| {
                        pairing.owner == intent.pairing.owner
                            && pairing.binding_id == intent.pairing.binding_id
                            && pairing.connection == intent.pairing.connection
                    })
                {
                    let pairing = intent.pairing.clone();
                    openbot_desktop_lib::computer_auth::bind_owner(
                        &self.inner.owner_scope,
                        &auth_root,
                        &pairing.owner,
                        &intent.attempt,
                    )?;
                    state.auth_grants.insert(id.to_owned(), pairing);
                    state.auth_intents.remove(id);
                }
            }
        }
        let own_identity = openbot_desktop_lib::computer_auth::owner_matches(
            &self.inner.owner_scope,
            &auth_root,
            &pairing.owner,
        )
        .unwrap_or(false);
        let own_attempt = state.auth_intents.get(id).is_some_and(|intent| {
            intent.pairing.owner == pairing.owner
                && intent.pairing.binding_id == pairing.binding_id
                && intent.pairing.connection == pairing.connection
                && status.attempt_id.as_deref() == Some(intent.attempt.as_str())
        });
        let global_pending = status.pending;
        if !own_attempt {
            status.pending = false;
            status.attempt_id = None;
            status.error = None;
        }
        if !own_identity {
            status.connected = false;
            status.account_name = None;
            status.email = None;
            status.expires_at = None;
            if !own_attempt {
                status.pending = false;
                status.attempt_id = None;
                status.error = None;
            }
        }
        let allowed = status.connected
            && !global_pending
            && state.auth_grants.get(id).is_some_and(|grant| {
                openbot_desktop_lib::computer_auth::owner_matches(
                    &self.inner.owner_scope,
                    &auth_root,
                    &grant.owner,
                )
                .unwrap_or(false)
                    && state.connection.as_deref() == Some(grant.connection.as_str())
                    && grant.binding_id == pairing.binding_id
            });
        let pairing = state
            .pairings
            .get(id)
            .filter(|pairing| state.connection.as_deref() == Some(pairing.connection.as_str()));
        let paired = pairing.is_some();
        let can_allow = status.connected
            && !global_pending
            && pairing.is_some_and(|pairing| {
                openbot_desktop_lib::computer_auth::owner_matches(
                    &self.inner.owner_scope,
                    &auth_root,
                    &pairing.owner,
                )
                .unwrap_or(false)
            });
        Ok(ComputerAuthStatus {
            status,
            allowed,
            can_allow,
            paired,
        })
    }
    pub fn auth_allow(&self, id: &str, ticket: &str) -> Result<(), String> {
        let _action = self
            .inner
            .auth_action
            .try_lock()
            .map_err(|_| "Computer sign-in is busy.")?;
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        let pairing = self.actor_pairing(id, ticket, "allow")?;
        let status = openbot_desktop_lib::computer_auth::status(&auth_root()?)?;
        let mut state = self.inner.state.lock().unwrap();
        if !status.connected
            || status.pending
            || state.deleting.contains(id)
            || !state.pairings.get(id).is_some_and(|current| {
                current.owner == pairing.owner
                    && current.connection == pairing.connection
                    && current.binding_id == pairing.binding_id
            })
            || !openbot_desktop_lib::computer_auth::owner_matches(
                &self.inner.owner_scope,
                &auth_root()?,
                &pairing.owner,
            )?
            || state.connection.as_deref() != Some(pairing.connection.as_str())
        {
            return Err("Connect ChatGPT for this Computer and account first.".into());
        }
        state.auth_grants.insert(id.to_owned(), pairing);
        Ok(())
    }
    pub fn clear_auth_grants(&self) {
        self.cancel_coding_runs();
        let mut state = self.inner.state.lock().unwrap();
        state.auth_grants.clear();
        state.auth_intents.clear();
    }
    pub fn cancel_auth(&self, id: &str, ticket: &str, attempt_id: &str) -> Result<(), String> {
        let _action = self
            .inner
            .auth_action
            .try_lock()
            .map_err(|_| "Computer sign-in is busy.")?;
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        let pairing = self.actor_pairing(id, ticket, "cancel")?;
        let mut state = self.inner.state.lock().unwrap();
        let owned = state.auth_intents.get(id).is_some_and(|intent| {
            intent.attempt == attempt_id
                && intent.pairing.owner == pairing.owner
                && intent.pairing.connection == pairing.connection
                && intent.pairing.binding_id == pairing.binding_id
        });
        if !owned {
            return Err("That sign-in is not active for this workspace and account.".into());
        }
        state.auth_intents.remove(id);
        drop(state);
        openbot_desktop_lib::computer_auth::cancel(&auth_root()?, attempt_id)
    }
    pub fn abort_opening_auth(&self, id: &str, attempt_id: &str) {
        let mut state = self.inner.state.lock().unwrap();
        if state
            .auth_intents
            .get(id)
            .is_some_and(|intent| intent.attempt == attempt_id)
        {
            state.auth_intents.remove(id);
            drop(state);
            if let Ok(root) = auth_root() {
                let _ = openbot_desktop_lib::computer_auth::cancel(&root, attempt_id);
            }
        }
    }
    pub fn auth_logout(
        &self,
        id: &str,
        ticket: &str,
    ) -> Result<openbot_desktop_lib::computer_auth::LogoutStatus, String> {
        let _action = self
            .inner
            .auth_action
            .try_lock()
            .map_err(|_| "Computer sign-in is busy.")?;
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        let pairing = self.actor_pairing(id, ticket, "logout")?;
        let status = openbot_desktop_lib::computer_auth::status(&auth_root()?)?;
        if status.pending {
            return Err(
                "Finish or cancel the current ChatGPT sign-in before disconnecting.".into(),
            );
        }
        if !openbot_desktop_lib::computer_auth::owner_matches(
            &self.inner.owner_scope,
            &auth_root()?,
            &pairing.owner,
        )? || !self.current_pairing(id, &pairing)
        {
            return Err("This ChatGPT sign-in belongs to another OpenBot account.".into());
        }
        self.clear_auth_grants();
        openbot_desktop_lib::computer_auth::logout(&auth_root()?)
    }
    pub fn disconnect(&self, id: &str, ticket: &str) -> Result<(), String> {
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        let proof = self.actor_proof(id, ticket, "disconnect")?;
        let store = self
            .inner
            .store
            .as_ref()
            .ok_or("Workspace reconnection is unavailable.")?;
        let binding = store.get(id)?.ok_or("This workspace is not paired.")?;
        if binding.owner_user_id != proof.owner_user_id
            || binding.server_audience != proof.server_audience
            || binding.installation_id != proof.installation_id
            || binding.binding_id != proof.binding_id
        {
            return Err("This workspace belongs to another OpenBot account.".into());
        }
        let result = self.revoke_computer_locked(id);
        self.finish_deletion(id);
        result
    }
    pub fn cancel_coding_runs(&self) {
        for job in self.inner.state.lock().unwrap().active.values() {
            if job.harness {
                job.cancel.cancel();
            }
        }
    }
    pub fn start(
        root: &std::path::Path,
        port: u16,
        token: String,
        notify: Option<Arc<dyn Fn(String) + Send + Sync>>,
    ) -> Result<Self, String> {
        if port == 0 || token.is_empty() {
            return Err("The desktop Computer connection is unavailable.".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|_| "Could not prepare the desktop Computer connection.")?;
        let owner_scope = openbot_desktop_lib::computer_auth::owner_scope(root)?;
        let installation = openbot_desktop_lib::computer_auth::installation_id(root)?;
        let store = Arc::new(PairingStore::new(
            owner_scope.clone(),
            installation.clone(),
        )?);
        let inner = Arc::new(Inner {
            owner_scope,
            installation,
            store: Some(store),
            notify,
            base: format!("http://127.0.0.1:{port}/api/desktop-computers"),
            token,
            client,
            stopped: AtomicBool::new(false),
            state: Mutex::new(State::default()),
            worker: Mutex::new(None),
            jobs: Mutex::new(Vec::new()),
            auth_action: Mutex::new(()),
            pairing_action: Mutex::new(()),
        });
        let running = inner.clone();
        let join = thread::Builder::new()
            .name("openbot-computers".into())
            .spawn(move || worker_loop(running))
            .map_err(|_| "Could not start the desktop Computer connection.")?;
        *inner.worker.lock().unwrap() = Some(join);
        Ok(Self { inner })
    }
    /// The page supplies only a one-use server ticket and an existing local VM id.
    pub fn register(&self, id: &str, ticket: &str) -> Result<RegisteredComputer, String> {
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        if !valid_id(id) || ticket.len() != 64 || !ticket.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Choose a valid Computer pairing request.".into());
        }
        if self.inner.stopped.load(Ordering::SeqCst) {
            return Err("The desktop Computer connection stopped.".into());
        }
        if self.inner.state.lock().unwrap().deleting.contains(id) {
            return Err("This VM is being deleted.".into());
        }
        let workspace = manager()?.get(id)?;
        let response = self
            .inner
            .client
            .post(format!("{}/desktop/register", self.inner.base))
            .bearer_auth(&self.inner.token)
            .json(
                &json!({"ticket":ticket,"computer":{"computerId":id,"name":workspace.recipe.name}}),
            )
            .send()
            .map_err(|_| "The server could not pair this Computer.")?;
        let registration: Registration = decode(response)?;
        let binding = registration_binding(&self.inner, &registration, id)?;
        let voucher = registration
            .reconnect
            .voucher
            .as_ref()
            .ok_or("The server omitted workspace reconnect authorization.")?;
        let store = self
            .inner
            .store
            .as_ref()
            .ok_or("Workspace reconnect storage is unavailable.")?;
        if let Err(error) = store.save(&binding, voucher) {
            let _ = unregister(
                &self.inner,
                id,
                &binding.owner_user_id,
                &registration.connection_id,
                &binding.binding_id,
            );
            return Err(error);
        }
        install_pairing(&self.inner, &registration, &binding)?;
        Ok(registration.computer)
    }
    /// Remove local authority before deleting a VM and wait for only its jobs to stop.
    pub fn revoke_computer(&self, id: &str) -> Result<(), String> {
        let _transition = self
            .inner
            .pairing_action
            .try_lock()
            .map_err(|_| "A Computer connection action is still running. Finish any system credential prompt, then try again.")?;
        self.revoke_computer_locked(id)
    }
    fn revoke_computer_locked(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Choose an existing VM.".into());
        }
        let (jobs, attempt, pairing) = {
            let mut state = self.inner.state.lock().unwrap();
            state.deleting.insert(id.to_owned());
            let pairing = state.pairings.get(id).cloned();
            state.auth_grants.remove(id);
            let attempt = state.auth_intents.remove(id).map(|intent| intent.attempt);
            let jobs = state
                .active
                .values()
                .filter(|active| active.computer_id == id)
                .map(|active| {
                    active.cancel.cancel();
                    active.finished.clone()
                })
                .collect::<Vec<_>>();
            (jobs, attempt, pairing)
        };
        if let Some(attempt) = attempt {
            let _ = openbot_desktop_lib::computer_auth::cancel(&auth_root()?, &attempt);
        }
        let saved = match self.inner.store.as_ref() {
            Some(store) => store.get(id)?,
            None => None,
        };
        if let Some(binding) = saved.as_ref() {
            let connection = self
                .inner
                .state
                .lock()
                .unwrap()
                .connection
                .clone()
                .ok_or("Reconnect OpenBot before disconnecting this workspace.")?;
            unregister(
                &self.inner,
                id,
                &binding.owner_user_id,
                &connection,
                &binding.binding_id,
            )?;
            self.inner.store.as_ref().unwrap().remove(binding)?;
        } else if let Some(pairing) = pairing {
            unregister(
                &self.inner,
                id,
                &pairing.owner,
                &pairing.connection,
                &pairing.binding_id,
            )?;
        }
        self.inner.state.lock().unwrap().pairings.remove(id);
        notify(&self.inner, id);
        let deadline = Instant::now() + Duration::from_secs(8);
        while jobs.iter().any(|finished| !finished.load(Ordering::SeqCst)) {
            if Instant::now() >= deadline {
                return Err("The VM's active operations are still stopping. Its files were kept; try deleting it again shortly.".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }
    pub fn finish_deletion(&self, id: &str) {
        self.inner.state.lock().unwrap().deleting.remove(id);
    }
    pub fn stop(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        self.inner.state.lock().unwrap().revoke();
        if let Some(worker) = self.inner.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
        for job in self.inner.jobs.lock().unwrap().drain(..) {
            let _ = job.join();
        }
    }
}

fn notify(inner: &Inner, id: &str) {
    if let Some(notify) = inner.notify.as_ref() {
        notify(id.to_owned());
    }
}
fn registration_binding(
    inner: &Inner,
    registration: &Registration,
    id: &str,
) -> Result<Binding, String> {
    let binding = Binding {
        binding_id: registration.reconnect.binding_id.clone(),
        server_audience: registration.reconnect.server_audience.clone(),
        installation_id: registration.reconnect.installation_id.clone(),
        computer_id: registration.computer.computer_id.clone(),
        owner_user_id: registration.owner_user_id.clone(),
        name: registration.computer.name.clone(),
    };
    binding.validate(&inner.installation)?;
    if binding.computer_id != id
        || registration.connection_id.is_empty()
        || registration.connection_id.len() > 128
    {
        return Err("The server returned an invalid workspace pairing.".into());
    }
    let state = inner.state.lock().unwrap();
    if state.deleting.contains(id)
        || state
            .connection
            .as_deref()
            .is_some_and(|id| id != registration.connection_id)
        || state
            .server_audience
            .as_deref()
            .is_some_and(|audience| audience != binding.server_audience)
    {
        return Err("The workspace connection changed. Refresh and try again.".into());
    }
    Ok(binding)
}
fn install_pairing(
    inner: &Inner,
    registration: &Registration,
    binding: &Binding,
) -> Result<(), String> {
    install_pairing_at(inner, registration, binding, None)
}
fn install_pairing_at(
    inner: &Inner,
    registration: &Registration,
    binding: &Binding,
    expected_authority: Option<u64>,
) -> Result<(), String> {
    let mut state = inner.state.lock().unwrap();
    if expected_authority.is_some_and(|generation| generation != state.authority_generation) {
        return Err("The workspace authorization changed. Try again.".into());
    }
    if inner.stopped.load(Ordering::SeqCst)
        || state.deleting.contains(&binding.computer_id)
        || state
            .connection
            .as_deref()
            .is_some_and(|id| id != registration.connection_id)
        || state
            .server_audience
            .as_deref()
            .is_some_and(|audience| audience != binding.server_audience)
    {
        return Err("The workspace connection changed. Refresh and try again.".into());
    }
    state.connection(&registration.connection_id);
    state.server_audience = Some(binding.server_audience.clone());
    if state
        .pairings
        .get(&binding.computer_id)
        .is_some_and(|previous| previous.binding_id != binding.binding_id)
    {
        for active in state
            .active
            .values()
            .filter(|active| active.computer_id == binding.computer_id)
        {
            active.cancel.cancel();
        }
        state.auth_grants.remove(&binding.computer_id);
        state.auth_intents.remove(&binding.computer_id);
    }
    state.pairings.insert(
        binding.computer_id.clone(),
        Pairing {
            binding_id: binding.binding_id.clone(),
            owner: binding.owner_user_id.clone(),
            connection: registration.connection_id.clone(),
        },
    );
    drop(state);
    notify(inner, &binding.computer_id);
    Ok(())
}
fn unregister(
    inner: &Inner,
    id: &str,
    owner: &str,
    connection: &str,
    binding: &str,
) -> Result<(), String> {
    let mut body = json!({"computerId":id,"ownerUserId":owner,"connectionId":connection});
    if !binding.is_empty() {
        body["bindingId"] = json!(binding);
    }
    let response = inner
        .client
        .post(format!("{}/desktop/unregister", inner.base))
        .bearer_auth(&inner.token)
        .json(&body)
        .send()
        .map_err(|_| "The workspace could not disconnect. Its files were kept; try again.")?;
    let ack: Value = decode(response)?;
    if ack.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("OpenBot did not confirm the workspace disconnection.".into());
    }
    Ok(())
}
fn restore_pairings(inner: &Arc<Inner>, attempts: &mut HashMap<String, Instant>) -> bool {
    restore_pairings_with(inner, attempts, |id| {
        manager()
            .and_then(|manager| manager.get(id))
            .map(|workspace| workspace.recipe.name)
    })
}
// The resolver supplies only the existing VM's name; injected tests never touch Lima.
fn restore_pairings_with(
    inner: &Arc<Inner>,
    attempts: &mut HashMap<String, Instant>,
    resolve: impl Fn(&str) -> Result<String, String>,
) -> bool {
    restore_pairings_until(
        inner,
        attempts,
        resolve,
        Instant::now() + Duration::from_secs(30),
    )
}
fn restore_pairings_until(
    inner: &Arc<Inner>,
    attempts: &mut HashMap<String, Instant>,
    resolve: impl Fn(&str) -> Result<String, String>,
    deadline: Instant,
) -> bool {
    let Some(store) = inner.store.as_ref() else {
        return false;
    };
    let Ok(bindings) = store.list() else {
        return false;
    };
    let mut attempted = 0;
    let mut restored = false;
    for binding in bindings {
        if attempted >= 4 || inner.stopped.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break;
        }
        // Serialize the whole transition, including the response and persisted-generation check,
        // with explicit registration and revoke. No delayed response can revive a revoked binding.
        let Ok(_transition) = inner.pairing_action.try_lock() else {
            break;
        };
        let authority = {
            let state = inner.state.lock().unwrap();
            if state.server_audience.as_deref() != Some(binding.server_audience.as_str())
                || state.deleting.contains(&binding.computer_id)
                || state.pairings.contains_key(&binding.computer_id)
                || attempts
                    .get(&binding.computer_id)
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
            {
                continue;
            }
            state.authority_generation
        };
        if !store
            .get(&binding.computer_id)
            .ok()
            .flatten()
            .is_some_and(|current| current == binding)
        {
            continue;
        }
        let Ok(name) = resolve(&binding.computer_id) else {
            continue;
        };
        attempted += 1;
        attempts.insert(binding.computer_id.clone(), Instant::now());
        let Ok(Some(voucher)) = store.voucher(&binding) else {
            continue;
        };
        // Legacy macOS Keychain cannot cancel its system dialog. A late result is discarded,
        // and never starts a network reconnect after the logical deadline or worker stop.
        if inner.stopped.load(Ordering::SeqCst)
            || Instant::now() >= deadline
            || inner.state.lock().unwrap().authority_generation != authority
        {
            break;
        }
        let result = (|| {
            let response = inner.client.post(format!("{}/desktop/reconnect", inner.base)).bearer_auth(&inner.token)
                .json(&json!({"bindingId":binding.binding_id,"voucher":voucher.expose(),"computer":{"computerId":binding.computer_id,"name":name}}))
                .send().map_err(|_| "Workspace reconnect is unavailable.")?;
            let registration: Registration = decode(response)?;
            let returned = registration_binding(inner, &registration, &binding.computer_id)?;
            if returned.binding_id != binding.binding_id
                || returned.owner_user_id != binding.owner_user_id
                || returned.server_audience != binding.server_audience
                || returned.installation_id != binding.installation_id
                || !store
                    .get(&binding.computer_id)?
                    .is_some_and(|current| current == binding)
            {
                return Err("Workspace reconnect identity changed.".into());
            }
            if Instant::now() >= deadline {
                return Err("Workspace reconnect authorization took too long. Try again.".into());
            }
            install_pairing_at(inner, &registration, &returned, Some(authority))
        })();
        if result.is_ok() {
            attempts.remove(&binding.computer_id);
            restored = true;
        }
    }
    restored
}

fn decode<T: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!(
            "The desktop Computer server refused the request ({}).",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_WIRE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The desktop Computer response was interrupted.")?;
    if bytes.len() as u64 > MAX_WIRE {
        return Err("The desktop Computer response was too large.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The server returned an invalid desktop Computer response.".into())
}

// One legacy Keychain restore call may remain blocked inside macOS. Never spawn a second
// restore lane (including across worker replacement), never join it from stop(), and never
// claim that dropping the receiver cancels a system authorization dialog.
static RESTORE_LANE_BUSY: AtomicBool = AtomicBool::new(false);
struct RestorePermit;
impl Drop for RestorePermit {
    fn drop(&mut self) {
        RESTORE_LANE_BUSY.store(false, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct RestoreLane {
    result: Option<mpsc::Receiver<(Option<String>, HashMap<String, Instant>)>>,
}
impl RestoreLane {
    fn poll(&mut self, inner: &Arc<Inner>, attempts: &mut HashMap<String, Instant>) {
        if let Some(receiver) = self.result.as_ref() {
            match receiver.try_recv() {
                Ok((epoch, saved)) => {
                    if inner.state.lock().unwrap().connection == epoch {
                        *attempts = saved;
                    }
                    self.result = None;
                }
                Err(mpsc::TryRecvError::Disconnected) => self.result = None,
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
    }
    fn start(&mut self, inner: &Arc<Inner>, attempts: &HashMap<String, Instant>) {
        if self.result.is_some() || inner.stopped.load(Ordering::SeqCst) {
            return;
        }
        let Some(store) = inner.store.as_ref() else {
            return;
        };
        let Ok(bindings) = store.list() else {
            return;
        };
        let state = inner.state.lock().unwrap();
        let candidate = bindings.iter().any(|binding| {
            state.server_audience.as_deref() == Some(binding.server_audience.as_str())
                && !state.pairings.contains_key(&binding.computer_id)
                && !state.deleting.contains(&binding.computer_id)
                && !attempts
                    .get(&binding.computer_id)
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
        });
        drop(state);
        if candidate {
            self.launch(inner, attempts, |inner, attempts| {
                restore_pairings(inner, attempts);
            });
        }
    }
    fn launch(
        &mut self,
        inner: &Arc<Inner>,
        attempts: &HashMap<String, Instant>,
        task: impl FnOnce(&Arc<Inner>, &mut HashMap<String, Instant>) + Send + 'static,
    ) {
        if self.result.is_some()
            || RESTORE_LANE_BUSY
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return;
        }
        let permit = RestorePermit;
        let worker = inner.clone();
        let mut attempts = attempts.clone();
        let epoch = inner.state.lock().unwrap().connection.clone();
        let (send, receive) = mpsc::channel();
        match thread::Builder::new()
            .name("computer-reconnect".into())
            .spawn(move || {
                let _permit = permit;
                task(&worker, &mut attempts);
                let _ = send.send((epoch, attempts));
            }) {
            Ok(_detached) => self.result = Some(receive),
            Err(_) => { /* failed spawn drops the permit */ }
        }
    }
}

fn worker_loop(inner: Arc<Inner>) {
    let (send, receive) = mpsc::sync_channel::<QueuedEvent>(64);
    let mut pending = VecDeque::new();
    let mut polled = Instant::now() - Duration::from_secs(1);
    let mut lease = Instant::now() + Duration::from_secs(15);
    let mut next_post = Instant::now();
    let mut restore_attempts = HashMap::new();
    let mut restore_lane = RestoreLane::default();
    while !inner.stopped.load(Ordering::SeqCst) {
        if Instant::now() >= lease {
            let mut state = inner.state.lock().unwrap();
            let lost = state.pairings.keys().cloned().collect::<Vec<_>>();
            state.revoke();
            drop(state);
            for id in lost {
                notify(&inner, &id);
            }
        }
        restore_lane.poll(&inner, &mut restore_attempts);
        if polled.elapsed() >= Duration::from_millis(500) {
            polled = Instant::now();
            let poll_pairings = inner.state.lock().unwrap().pairings.clone();
            let response = inner
                .client
                .get(format!("{}/desktop/next", inner.base))
                .bearer_auth(&inner.token)
                .send()
                .map_err(|_| ())
                .and_then(|response| decode::<Poll>(response).map_err(|_| ()));
            if let Ok(poll) = response {
                if poll.installation_id == inner.installation
                    && poll.server_audience.len() == 36
                    && poll.connection_id.len() <= 128
                    && !poll.connection_id.is_empty()
                    && poll.operations.len() <= 4
                    && poll.cancellations.len() <= 128
                {
                    lease =
                        Instant::now() + Duration::from_millis(poll.lease_ms.clamp(1000, 15_000));
                    let mut state = inner.state.lock().unwrap();
                    let changed = state.connection.as_deref() != Some(poll.connection_id.as_str())
                        || state.server_audience.as_deref() != Some(poll.server_audience.as_str());
                    let lost = if changed {
                        state.pairings.keys().cloned().collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    if changed {
                        state.revoke();
                        restore_attempts.clear();
                    }
                    state.connection(&poll.connection_id);
                    state.server_audience = Some(poll.server_audience.clone());
                    for id in poll.cancellations {
                        if let Some(active) = state.active.get(&id) {
                            active.cancel.cancel();
                        }
                    }
                    state
                        .active
                        .retain(|_, active| !active.finished.load(Ordering::SeqCst));
                    drop(state);
                    for id in lost {
                        notify(&inner, &id);
                    }
                    restore_lane.start(&inner, &restore_attempts);
                    for operation in poll.operations {
                        let expected = poll_pairings.get(&operation.computer_id).cloned();
                        accept_if_current(
                            &inner,
                            &send,
                            &poll.connection_id,
                            operation,
                            Some(expected),
                        );
                    }
                }
            }
        }
        while pending.len() < 64 {
            match receive.try_recv() {
                Ok(event) => pending.push_back(event),
                Err(_) => break,
            }
        }
        let connection = inner.state.lock().unwrap().connection.clone();
        pending
            .retain(|event: &QueuedEvent| connection.as_deref() == Some(event.connection.as_str()));
        if Instant::now() >= next_post {
            if let Some(event) = pending.front() {
                let response = inner.client.post(format!("{}/desktop/events", inner.base)).bearer_auth(&inner.token)
                    .json(&json!({"operationId":event.operation,"events":[{"sequence":event.sequence,"event":event.event}]})).send();
                match response {
                    Ok(response) if response.status().as_u16() == 409 => {
                        pending.pop_front();
                    }
                    Ok(response) => match decode::<Ack>(response) {
                        Ok(ack) if ack.finished || ack.accepted_sequence >= event.sequence => {
                            pending.pop_front();
                        }
                        _ => {
                            next_post = Instant::now() + Duration::from_millis(500);
                        }
                    },
                    Err(_) => {
                        next_post = Instant::now() + Duration::from_millis(500);
                    }
                }
            }
        }
        let mut jobs = inner.jobs.lock().unwrap();
        let mut index = 0;
        while index < jobs.len() {
            if jobs[index].is_finished() {
                let _ = jobs.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        drop(jobs);
        thread::sleep(Duration::from_millis(20));
    }
    inner.state.lock().unwrap().revoke();
    drop(receive); // Release any job blocked while sending bounded output.
}

#[cfg(test)]
fn accept(
    inner: &Arc<Inner>,
    send: &mpsc::SyncSender<QueuedEvent>,
    connection: &str,
    operation: Operation,
) {
    accept_if_current(inner, send, connection, operation, None)
}
fn accept_if_current(
    inner: &Arc<Inner>,
    send: &mpsc::SyncSender<QueuedEvent>,
    connection: &str,
    operation: Operation,
    expected: Option<Option<Pairing>>,
) {
    if !valid_operation(&operation.operation_id) {
        return;
    }
    let mut state = inner.state.lock().unwrap();
    // A reconnect/re-pair cancels the server's prior jobs. Do not dispatch a stale poll
    // response for that VM, while unaffected VMs can continue during Keychain approval.
    if expected
        .is_some_and(|expected| expected.as_ref() != state.pairings.get(&operation.computer_id))
    {
        return;
    }
    if state.seen.contains(&operation.operation_id) {
        return;
    }
    if state.seen.len() >= MAX_REPLAY {
        // Never evict a replay id while its authorization session is live.
        state.revoke();
        return;
    }
    let needs_auth = matches!(operation.action, Action::HarnessTurn { .. });
    let auth_allowed = !needs_auth || state.coding_allowed(&operation);
    let allowed = state.authorized(&operation) && auth_allowed && state.active.len() < MAX_ACTIVE;
    let binding = needs_auth.then(|| binding_key(&operation));
    let busy = binding
        .as_ref()
        .is_some_and(|binding| state.binding_busy(binding));
    let allowed = allowed && !busy;
    state.seen.insert(operation.operation_id.clone());
    let cancellation = openbot_workspaces::CodexCancellation::default();
    let finished = Arc::new(AtomicBool::new(false));
    state.active.insert(
        operation.operation_id.clone(),
        Active {
            computer_id: operation.computer_id.clone(),
            cancel: cancellation.clone(),
            finished: finished.clone(),
            harness: matches!(operation.action, Action::HarnessTurn { .. }),
            binding: if allowed { binding } else { None },
        },
    );
    drop(state);
    let send = send.clone();
    let connection = connection.to_owned();
    let owner_scope = inner.owner_scope.clone();
    let job = thread::spawn(move || {
        let mut sequence = 0;
        let mut emit = |event: Value| {
            let event = if serde_json::to_vec(&event).map_or(true, |bytes| bytes.len() > 448 * 1024)
            {
                json!({"type":"failed","message":"The Computer result is too large to return. Read a smaller file."})
            } else {
                event
            };
            sequence += 1;
            let mut queued = QueuedEvent {
                connection: connection.clone(),
                operation: operation.operation_id.clone(),
                sequence,
                event,
            };
            loop {
                match send.try_send(queued) {
                    Ok(()) => break,
                    Err(mpsc::TrySendError::Disconnected(_)) => {
                        cancellation.cancel();
                        break;
                    }
                    Err(mpsc::TrySendError::Full(value)) => {
                        if cancellation.cancelled() {
                            break;
                        }
                        queued = value;
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        };
        let result = if busy {
            Err("This conversation already has a coding turn running.".into())
        } else if !allowed {
            Err("Pair this Computer with your account before a Bot uses it.".into())
        } else if operation.expires_at <= now_ms()
            || operation.expires_at > now_ms() + 2 * 60 * 60 * 1000
        {
            Err("This Computer operation expired or has an invalid deadline.".into())
        } else if [
            &operation.actor_id,
            &operation.bot_id,
            &operation.thread_id,
            &operation.run_id,
        ]
        .iter()
        .any(|value| value.is_empty() || value.len() > 256)
        {
            Err("This Computer operation has invalid owner or conversation information.".into())
        } else {
            emit(json!({"type":"started"}));
            execute(&owner_scope, &operation, &cancellation, &mut emit)
        };
        match result {
            Ok((code, session, result)) => {
                let mut completed = json!({"type":"completed","exitCode":code,"result":result});
                if let Some(session) = session {
                    completed["sessionId"] = json!(session);
                }
                emit(completed);
            }
            Err(error) => emit(
                json!({"type":"failed","message":error.chars().take(4096).collect::<String>()}),
            ),
        }
        finished.store(true, Ordering::SeqCst);
    });
    inner.jobs.lock().unwrap().push(job);
}

fn codex_permission(value: &str) -> Result<openbot_workspaces::CodexPermission, String> {
    match value {
        "read-only" => Ok(openbot_workspaces::CodexPermission::ReadOnly),
        "workspace-write" => Ok(openbot_workspaces::CodexPermission::WorkspaceWrite),
        "vm-full-access" => Ok(openbot_workspaces::CodexPermission::VmFullAccess),
        _ => Err("Choose supported VM permissions.".into()),
    }
}

fn execute(
    owner_scope: &std::path::Path,
    operation: &Operation,
    cancel: &openbot_workspaces::CodexCancellation,
    emit: &mut impl FnMut(Value),
) -> Result<(i32, Option<String>, Value), String> {
    if cancel.cancelled() {
        return Err("The Computer operation was stopped.".into());
    }
    if !valid_id(&operation.computer_id) {
        return Err("Choose an existing Computer.".into());
    }
    let manager = manager()?;
    let _usage = manager.acquire_usage(&operation.computer_id)?;
    manager.get(&operation.computer_id)?;
    match &operation.action {
        Action::Models { runtime } if runtime == "codex" => Ok((
            0,
            None,
            serde_json::to_value(manager.codex_models(&operation.computer_id)?)
                .map_err(|_| "Could not read Codex models.")?,
        )),
        Action::Models { .. } => Err("Claude Code model discovery is not available yet.".into()),
        Action::HarnessTurn {
            runtime,
            prompt,
            session_id,
            model,
            effort,
            speed,
            permission,
            developer_instructions,
        } => {
            if runtime != "codex" {
                return Err("Claude Code turns are not available yet.".into());
            }
            let permission = codex_permission(permission)?;
            let saved = load_session(operation)?;
            if session_id
                .as_ref()
                .is_some_and(|requested| saved.as_ref() != Some(requested))
            {
                return Err("This coding session does not belong to this conversation.".into());
            }
            let request = openbot_workspaces::CodexTurnRequest {
                prompt: prompt.clone(),
                thread_id: saved,
                model: model.clone(),
                effort: effort.clone(),
                speed: speed.clone(),
                permission,
                developer_instructions: developer_instructions.clone(),
            };
            let token = openbot_desktop_lib::computer_auth::access_token_for_owner(
                &auth_root()?,
                owner_scope,
                &operation.actor_id,
            )?;
            if cancel.cancelled() {
                return Err("The Computer operation was stopped.".into());
            }
            let auth = openbot_workspaces::CodexProviderAuth::chatgpt_plan(token.into_secret())?;
            let mut mapping_error = None;
            let result = manager.codex_turn(
                &operation.computer_id,
                request,
                Some(auth),
                cancel.clone(),
                |event| {
                    if let openbot_workspaces::CodexTurnEvent::ThreadStarted { thread_id } = &event
                    {
                        if let Err(error) = save_session(operation, thread_id) {
                            mapping_error = Some(error);
                            cancel.cancel();
                        }
                    }
                    if let openbot_workspaces::CodexTurnEvent::AssistantDelta { delta, .. } = event
                    {
                        for chunk in split_output(&delta) {
                            emit(json!({"type":"output","stream":"assistant","text":chunk}));
                        }
                    }
                },
            );
            if let Some(error) = mapping_error {
                return Err(error);
            }
            let result = result?;
            save_session(operation, &result.thread_id)?;
            Ok((0, Some(result.thread_id), Value::Null))
        }
        _ => guest_operation(&manager, operation, cancel, emit),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedSession {
    computer_id: String,
    actor_id: String,
    bot_id: String,
    thread_id: String,
    session_id: String,
}
fn binding_key(operation: &Operation) -> String {
    let identity = serde_json::to_vec(&[
        &operation.computer_id,
        &operation.actor_id,
        &operation.bot_id,
        &operation.thread_id,
    ])
    .expect("strings serialize");
    format!("{:x}", Sha256::digest(identity))
}
fn session_directory(operation: &Operation) -> Result<std::path::PathBuf, String> {
    if !valid_id(&operation.computer_id) {
        return Err("Choose an existing Computer.".into());
    }
    manager()?.get(&operation.computer_id)?;
    Ok(openbot_workspaces::default_root()?
        .join("records")
        .join(&operation.computer_id)
        .join("sessions"))
}
fn load_session(operation: &Operation) -> Result<Option<String>, String> {
    let path = session_directory(operation)?.join(format!("{}.json", binding_key(operation)));
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("The saved coding session could not be opened.".into()),
    };
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "The saved coding session could not be read.")?;
    if bytes.len() > 4096 {
        return Err("The saved coding session is invalid.".into());
    }
    let saved: SavedSession =
        serde_json::from_slice(&bytes).map_err(|_| "The saved coding session is invalid.")?;
    validate_session(operation, saved).map(Some)
}
fn validate_session(operation: &Operation, saved: SavedSession) -> Result<String, String> {
    if saved.computer_id != operation.computer_id
        || saved.actor_id != operation.actor_id
        || saved.bot_id != operation.bot_id
        || saved.thread_id != operation.thread_id
        || !valid_session_id(&saved.session_id)
    {
        return Err("The saved coding session does not belong to this conversation.".into());
    }
    Ok(saved.session_id)
}
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}
fn save_session(operation: &Operation, session_id: &str) -> Result<(), String> {
    if !valid_session_id(session_id) {
        return Err("Codex returned an invalid session identifier.".into());
    }
    let directory = session_directory(operation)?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "The coding session folder could not be created.")?;
    if std::fs::symlink_metadata(&directory)
        .map_err(|_| "The coding session folder is unavailable.")?
        .file_type()
        .is_symlink()
    {
        return Err("The coding session folder cannot be a link.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "The coding session folder could not be protected.")?;
    }
    let contents = serde_json::to_vec(&SavedSession {
        computer_id: operation.computer_id.clone(),
        actor_id: operation.actor_id.clone(),
        bot_id: operation.bot_id.clone(),
        thread_id: operation.thread_id.clone(),
        session_id: session_id.to_owned(),
    })
    .map_err(|_| "The coding session could not be saved.")?;
    let path = directory.join(format!("{}.json", binding_key(operation)));
    let temporary = directory.join(format!(".session-{:032x}.tmp", rand::random::<u128>()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&contents)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)
    })()
    .map_err(|_| "The coding session could not be saved.".to_owned());
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn split_output(text: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(32 * 1024);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&remaining[..end]);
        remaining = &remaining[end..];
    }
    chunks
}

// Files use openat + O_NOFOLLOW for every component, so concurrent symlink replacement cannot
// redirect a read or write outside the project. Shell commands intentionally run on the guest.
const GUEST_OPERATION: &str = r#"
import os,sys,json,subprocess,signal,threading,time,stat
job=json.load(sys.stdin)
try: os.setsid()
except PermissionError:
 if os.getpgrp()!=os.getpid(): raise
root='/workspace/project'
directory='/tmp/openbot-computer-jobs'
try: os.mkdir(directory,0o700)
except FileExistsError: pass
folder=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
if os.fstat(folder).st_uid!=os.geteuid() or stat.S_IMODE(os.fstat(folder).st_mode)!=0o700: raise RuntimeError('Unsafe job directory')
marker=job['operationId']+'.json'
fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=folder)
started=open('/proc/self/stat').read().rpartition(')')[2].split()[19]
with os.fdopen(fd,'w') as out: json.dump({'pid':os.getpid(),'started':started},out)
def expired():
 time.sleep(max(0,job['expiresAt']/1000-time.time()))
 try: os.unlink(marker,dir_fd=folder)
 except FileNotFoundError: pass
 os.killpg(os.getpid(),signal.SIGKILL)
threading.Thread(target=expired,daemon=True).start()
try:
 action=job['action']; kind=action['kind']
 if kind=='run_command':
  command=action['command']
  if not command or len(command)>8192 or '\x00' in command: raise RuntimeError('Invalid guest command')
  result=subprocess.run(['/bin/bash','-lc',command],cwd=root)
  sys.exit(max(0,min(255,result.returncode)))
 path=action['path']
 if not path or path.startswith('/') or '\x00' in path or '..' in path.split('/'): raise RuntimeError('Use a relative project path')
 parts=[part for part in path.split('/') if part and part!='.']
 current=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in parts[:-1]:
   following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
   os.close(current); current=following
  leaf=parts[-1] if parts else '.'
  if kind=='list_files':
   target=os.open(leaf,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
   try:
    entries=[]
    for name in sorted(os.listdir(target)):
     if len(entries)>=2048: break
     info=os.stat(name,dir_fd=target,follow_symlinks=False)
     entries.append({'name':name,'directory':stat.S_ISDIR(info.st_mode),'symlink':stat.S_ISLNK(info.st_mode),'bytes':info.st_size})
    print(json.dumps({'entries':entries}))
   finally: os.close(target)
  elif kind=='read_file':
   fd=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=current)
   with os.fdopen(fd,'rb') as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise RuntimeError('Choose a regular project file')
    content=source.read(262145)
    if len(content)>262144: raise RuntimeError('This project file is too large')
    print(json.dumps({'content':content.decode('utf8')}))
  elif kind=='write_file':
   content=action['content'].encode('utf8')
   if len(content)>262144: raise RuntimeError('This project file is too large')
   flags=os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK
   fd=os.open(leaf,flags,0o600,dir_fd=current)
   with os.fdopen(fd,'wb') as target:
    if not stat.S_ISREG(os.fstat(target.fileno()).st_mode): raise RuntimeError('Choose a regular project file')
    if action.get('append'): target.seek(0,2)
    else: target.truncate(0)
    target.write(content)
   print(json.dumps({'written':len(content)}))
  else: raise RuntimeError('Unsupported guest action')
 finally: os.close(current)
finally:
 try: os.unlink(marker,dir_fd=folder)
 except FileNotFoundError: pass
 os.close(folder)
"#;
const CANCEL_GUEST: &str = r#"
import os,sys,json,signal
try:
 directory=os.open('/tmp/openbot-computer-jobs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 fd=os.open(sys.argv[1]+'.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
 with os.fdopen(fd) as entry: job=json.load(entry)
 pid=job['pid']
 current=open('/proc/'+str(pid)+'/stat').read().rpartition(')')[2].split()[19]
 if current==job['started'] and os.getpgid(pid)==pid: os.killpg(pid,signal.SIGKILL)
 os.unlink(sys.argv[1]+'.json',dir_fd=directory)
except (FileNotFoundError,ProcessLookupError): pass
finally:
 try: os.unlink(sys.argv[1]+'.json',dir_fd=directory)
 except (FileNotFoundError,NameError): pass
"#;

fn guest_operation(
    manager: &openbot_workspaces::Manager,
    operation: &Operation,
    cancel: &openbot_workspaces::CodexCancellation,
    emit: &mut impl FnMut(Value),
) -> Result<(i32, Option<String>, Value), String> {
    let mut command = manager.shell_command(&operation.computer_id)?;
    command
        .args(["python3", "-c", GUEST_OPERATION])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "The Computer command could not start.")?;
    let payload = serde_json::to_vec(&json!({"operationId":operation.operation_id,"expiresAt":operation.expires_at,"action":operation.action})).map_err(|_| "Invalid Computer operation.")?;
    let mut input = child
        .stdin
        .take()
        .ok_or("The Computer command has no input.")?;
    // Provisioning/SSH can stall before reading stdin. Keep cancellation on the owning thread.
    let writer = thread::spawn(move || {
        let _ = input.write_all(&payload);
    });
    let (send, receive) = mpsc::sync_channel(32);
    let mut readers = Vec::new();
    for (stream, mut output) in [
        (
            "stdout",
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (
            "stderr",
            Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ),
    ] {
        let send = send.clone();
        readers.push(thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match output.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if send.send((stream, buffer[..count].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        }));
    }
    drop(send);
    let shell = matches!(operation.action, Action::RunCommand { .. });
    let mut contents = Vec::new();
    let mut bytes = 0;
    let result = loop {
        if cancel.cancelled() || operation.expires_at <= now_ms() {
            if let Ok(mut stop) = manager.shell_command(&operation.computer_id) {
                stop.args([
                    "timeout",
                    "5",
                    "python3",
                    "-c",
                    CANCEL_GUEST,
                    &operation.operation_id,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
                if let Ok(mut stopping) = stop.spawn() {
                    let began = Instant::now();
                    while began.elapsed() < Duration::from_secs(6) {
                        if stopping.try_wait().ok().flatten().is_some() {
                            break;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                    let _ = stopping.kill();
                    let _ = stopping.wait();
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            break Err("The Computer operation was stopped.".into());
        }
        match receive.recv_timeout(Duration::from_millis(25)) {
            Ok((stream, output)) => {
                bytes += output.len();
                if bytes > 8 * 1024 * 1024 {
                    cancel.cancel();
                    continue;
                }
                if shell {
                    emit(
                        json!({"type":"output","stream":stream,"text":String::from_utf8_lossy(&output)}),
                    );
                } else if stream == "stdout" {
                    contents.extend(output);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let Some(status) = child
                    .try_wait()
                    .map_err(|_| "The Computer command did not finish.")?
                else {
                    thread::sleep(Duration::from_millis(25));
                    continue;
                };
                if shell {
                    break Ok((status.code().unwrap_or(1), None, Value::Null));
                }
                if !status.success() {
                    break Err("The Computer file operation failed. Check its project path and permissions.".into());
                }
                break serde_json::from_slice(&contents)
                    .map(|result| (0, None, result))
                    .map_err(|_| "The Computer returned an invalid file result.".into());
            }
        }
    };
    drop(receive);
    let _ = writer.join();
    for reader in readers {
        let _ = reader.join();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemorySecrets {
        values: Mutex<HashMap<String, String>>,
        loads: std::sync::atomic::AtomicUsize,
    }
    impl openbot_desktop_lib::computer_pairing::Secrets for MemorySecrets {
        fn save(&self, key: &str, value: &str) -> Result<(), String> {
            self.values.lock().unwrap().insert(key.into(), value.into());
            Ok(())
        }
        fn load(&self, key: &str) -> Result<Option<String>, String> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            Ok(self.values.lock().unwrap().get(key).cloned())
        }
        fn remove(&self, key: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }
    fn durable_fixture(
        base: String,
    ) -> (std::path::PathBuf, Arc<MemorySecrets>, Arc<Inner>, Binding) {
        let root =
            std::env::temp_dir().join(format!("openbot-worker-pairing-{}", rand::random::<u64>()));
        std::fs::create_dir(&root).unwrap();
        let secrets = Arc::new(MemorySecrets::default());
        let binding = Binding {
            binding_id: "00000000-0000-4000-8000-000000000001".into(),
            server_audience: "00000000-0000-4000-8000-000000000002".into(),
            installation_id: "installation".into(),
            computer_id: operation().computer_id,
            owner_user_id: "alice".into(),
            name: "Project".into(),
        };
        let store =
            PairingStore::with_secrets(root.clone(), "installation".into(), secrets.clone())
                .unwrap();
        store
            .save(&binding, &Voucher::new("a".repeat(64)).unwrap())
            .unwrap();
        drop(store);
        // Reconstruct the store and worker from only persisted metadata and the injectable keychain.
        let store = Arc::new(
            PairingStore::with_secrets(root.clone(), "installation".into(), secrets.clone())
                .unwrap(),
        );
        let mut state = State::default();
        state.connection("restarted-epoch");
        state.server_audience = Some(binding.server_audience.clone());
        let inner = Arc::new(Inner {
            owner_scope: root.clone(),
            installation: "installation".into(),
            store: Some(store),
            notify: None,
            base,
            token: "test-native-bearer".into(),
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            stopped: AtomicBool::new(false),
            state: Mutex::new(state),
            worker: Mutex::new(None),
            jobs: Mutex::new(Vec::new()),
            auth_action: Mutex::new(()),
            pairing_action: Mutex::new(()),
        });
        (root, secrets, inner, binding)
    }
    fn read_http(stream: &mut std::net::TcpStream) -> (String, Value) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut byte = [0u8; 1];
        while !bytes.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
            assert!(bytes.len() < 8192);
        }
        let header = String::from_utf8(bytes).unwrap();
        let length = header
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|s| s.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        (
            header,
            if body.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&body).unwrap()
            },
        )
    }
    fn reply_http(stream: &mut std::net::TcpStream, value: Value) {
        use std::io::Write;
        let body = value.to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
    }
    fn restored_reply(binding: &Binding) -> Value {
        json!({"computer":{"computerId":binding.computer_id,"name":binding.name},"ownerUserId":binding.owner_user_id,"connectionId":"restarted-epoch","reconnect":{"bindingId":binding.binding_id,"serverAudience":binding.server_audience,"installationId":binding.installation_id}})
    }
    #[test]
    fn durable_restart_success_restores_owner_binding_epoch_without_model_grants() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (root, _, inner, binding) =
            durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
        let expected = binding.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (_, body) = read_http(&mut socket);
            assert_eq!(body["bindingId"], expected.binding_id);
            reply_http(&mut socket, restored_reply(&expected));
        });
        assert!(restore_pairings_with(&inner, &mut HashMap::new(), |_| Ok(
            "Project".into()
        )));
        server.join().unwrap();
        let state = inner.state.lock().unwrap();
        let pairing = state.pairings.get(&binding.computer_id).unwrap();
        assert_eq!(pairing.owner, "alice");
        assert_eq!(pairing.binding_id, binding.binding_id);
        assert_eq!(pairing.connection, "restarted-epoch");
        assert!(state.authorized(&operation()));
        assert!(!state.coding_allowed(&operation()));
        assert!(state.auth_grants.is_empty());
        assert!(state.auth_intents.is_empty());
        assert!(state.active.is_empty());
        drop(state);
        assert!(!restore_pairings_with(
            &inner,
            &mut HashMap::new(),
            |_| panic!("healthy presence must not reconnect")
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn durable_restart_restores_presence_only_and_disconnect_cannot_be_overtaken_by_response() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (root, secrets, inner, binding) =
            durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
        let (seen_tx, seen_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let expected = binding.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (header, body) = read_http(&mut socket);
            assert!(header.starts_with("POST /desktop/reconnect "));
            assert!(header
                .to_ascii_lowercase()
                .contains("authorization: bearer test-native-bearer"));
            assert_eq!(
                body,
                json!({"bindingId":expected.binding_id,"voucher":"a".repeat(64),"computer":{"computerId":expected.computer_id,"name":"Project"}})
            );
            seen_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            reply_http(&mut socket, restored_reply(&expected));
            let (mut socket, _) = listener.accept().unwrap();
            let (header, body) = read_http(&mut socket);
            assert!(header.starts_with("POST /desktop/unregister "));
            assert_eq!(
                body,
                json!({"computerId":expected.computer_id,"ownerUserId":"alice","connectionId":"restarted-epoch","bindingId":expected.binding_id})
            );
            reply_http(&mut socket, json!({"ok":true}));
        });
        let restore_inner = inner.clone();
        let restore = thread::spawn(move || {
            restore_pairings_with(
                &restore_inner,
                &mut HashMap::new(),
                |_| Ok("Project".into()),
            )
        });
        seen_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        // The lifecycle transition is not interrupted: UI revocation fails immediately,
        // then succeeds on retry after the pending system authorization/response completes.
        let worker = ComputerWorker {
            inner: inner.clone(),
        };
        let before = Instant::now();
        assert!(worker.revoke_computer(&binding.computer_id).is_err());
        assert!(before.elapsed() < Duration::from_millis(100));
        release_tx.send(()).unwrap();
        assert!(restore.join().unwrap());
        worker.revoke_computer(&binding.computer_id).unwrap();
        worker.finish_deletion(&binding.computer_id);
        server.join().unwrap();
        let state = inner.state.lock().unwrap();
        assert!(state.pairings.is_empty());
        assert!(state.auth_grants.is_empty());
        assert!(state.auth_intents.is_empty());
        assert!(!state.coding_allowed(&operation()));
        drop(state);
        assert!(inner
            .store
            .as_ref()
            .unwrap()
            .get(&binding.computer_id)
            .unwrap()
            .is_none());
        assert!(secrets.values.lock().unwrap().is_empty());
        assert!(!restore_pairings_with(
            &inner,
            &mut HashMap::new(),
            |_| panic!("revoked binding must not resolve")
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reconnect_wrong_audience_or_installation_never_loads_credential() {
        let (root, secrets, inner, binding) = durable_fixture("http://127.0.0.1:1".into());
        inner.state.lock().unwrap().server_audience =
            Some("ffffffff-0000-4000-8000-000000000002".into());
        assert!(!restore_pairings_with(
            &inner,
            &mut HashMap::new(),
            |_| panic!("wrong audience")
        ));
        assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
        let foreign = PairingStore::with_secrets(
            root.clone(),
            "another-installation".into(),
            secrets.clone(),
        )
        .unwrap();
        assert!(foreign.get(&binding.computer_id).is_err());
        assert!(foreign.list().unwrap().is_empty());
        assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn delayed_reconnect_cannot_install_a_replaced_persisted_generation() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (root, secrets, inner, binding) =
            durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
        let store = inner.store.as_ref().unwrap().clone();
        let expected = binding.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_http(&mut socket);
            // Simulate a replaced disk generation while the old response is in flight.
            // Production serializes this transition; the final CAS also rejects it independently.
            let mut newer = expected.clone();
            newer.binding_id = "ffffffff-0000-4000-8000-000000000001".into();
            store
                .save(&newer, &Voucher::new("b".repeat(64)).unwrap())
                .unwrap();
            reply_http(&mut socket, restored_reply(&expected));
        });
        assert!(!restore_pairings_with(&inner, &mut HashMap::new(), |_| Ok(
            "Project".into()
        )));
        server.join().unwrap();
        assert!(inner.state.lock().unwrap().pairings.is_empty());
        let current = inner
            .store
            .as_ref()
            .unwrap()
            .get(&binding.computer_id)
            .unwrap()
            .unwrap();
        assert_ne!(current.binding_id, binding.binding_id);
        assert!(inner
            .store
            .as_ref()
            .unwrap()
            .voucher(&binding)
            .unwrap()
            .is_none());
        assert_eq!(secrets.values.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disconnect_requires_fresh_matching_owner_and_generation_before_revoke() {
        for accepted in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let (root, secrets, inner, binding) =
                durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
            let expected = binding.clone();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (_, body) = read_http(&mut socket);
                assert_eq!(body["purpose"], "disconnect");
                reply_http(
                    &mut socket,
                    json!({"ownerUserId":if accepted{"alice"}else{"bob"},"computerId":expected.computer_id,"installationId":expected.installation_id,"serverAudience":expected.server_audience,"connectionId":"restarted-epoch","purpose":"disconnect","bindingId":expected.binding_id}),
                );
                if accepted {
                    let (mut socket, _) = listener.accept().unwrap();
                    let (header, body) = read_http(&mut socket);
                    assert!(header.starts_with("POST /desktop/unregister "));
                    assert_eq!(body["bindingId"], expected.binding_id);
                    reply_http(&mut socket, json!({"ok":true}));
                }
            });
            let worker = ComputerWorker {
                inner: inner.clone(),
            };
            assert_eq!(
                worker
                    .disconnect(&binding.computer_id, &"c".repeat(64))
                    .is_ok(),
                accepted
            );
            server.join().unwrap();
            assert_eq!(
                inner
                    .store
                    .as_ref()
                    .unwrap()
                    .get(&binding.computer_id)
                    .unwrap()
                    .is_none(),
                accepted
            );
            assert_eq!(secrets.values.lock().unwrap().is_empty(), accepted);
            assert!(!inner
                .state
                .lock()
                .unwrap()
                .deleting
                .contains(&binding.computer_id));
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn actor_proofs_require_native_installation_audience_epoch_computer_and_purpose() {
        for field in [
            "valid",
            "installationId",
            "serverAudience",
            "connectionId",
            "computerId",
            "purpose",
            "bindingId",
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let (root, secrets, inner, binding) =
                durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
            let mut proof = json!({"ownerUserId":"alice","computerId":binding.computer_id,"installationId":binding.installation_id,"serverAudience":binding.server_audience,"connectionId":"restarted-epoch","purpose":"status","bindingId":binding.binding_id});
            if field != "valid" {
                proof[field] = json!("different");
            }
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (header, body) = read_http(&mut socket);
                assert!(header.starts_with("POST /desktop/actor-ticket/redeem "));
                assert_eq!(body["purpose"], "status");
                assert_eq!(body["ticket"], "c".repeat(64));
                reply_http(&mut socket, proof);
            });
            let worker = ComputerWorker { inner };
            let result = worker.actor_proof(&binding.computer_id, &"c".repeat(64), "status");
            assert_eq!(result.is_ok(), field == "valid", "{field}");
            server.join().unwrap();
            assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn invalid_status_proof_returns_no_account_or_pending_metadata() {
        let (root, secrets, inner, binding) = durable_fixture("http://127.0.0.1:1".into());
        let worker = ComputerWorker { inner };
        let response = worker.auth_status(&binding.computer_id, "invalid").unwrap();
        assert!(!response.paired);
        assert!(!response.allowed);
        assert!(!response.can_allow);
        assert!(!response.status.connected);
        assert!(!response.status.pending);
        assert!(response.status.attempt_id.is_none());
        assert!(response.status.account_name.is_none());
        assert!(response.status.email.is_none());
        assert!(response.status.error.is_none());
        assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn global_usage_proof_is_owner_scoped_without_any_vm_and_rejects_changed_authority() {
        for field in [
            "valid",
            "purpose",
            "installationId",
            "serverAudience",
            "connectionId",
            "expired-during-read",
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let (root, _, inner, binding) =
                durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
            let mut proof = json!({"purpose":"usage","ownerUserId":"alice","installationId":binding.installation_id,"serverAudience":binding.server_audience,"connectionId":"restarted-epoch","installationVisible":false});
            if field != "valid" && field != "expired-during-read" {
                proof[field] = json!("different");
            }
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let (header, body) = read_http(&mut socket);
                assert!(header.starts_with("POST /desktop/model-connections/redeem "));
                assert_eq!(body, json!({"ticket":"d".repeat(64)}));
                reply_http(&mut socket, proof);
            });
            let worker = ComputerWorker {
                inner: inner.clone(),
            };
            let result = worker.service_usage_with(&"d".repeat(64), |proof| {
                assert!(
                    field == "valid" || field == "expired-during-read",
                    "invalid proof must not read metadata"
                );
                assert_eq!(proof.owner_user_id, "alice");
                assert!(!proof.installation_visible);
                if field == "expired-during-read" {
                    inner.state.lock().unwrap().connection("another-epoch");
                }
                Ok(openbot_desktop_lib::provider_usage::inventory(None, None))
            });
            assert_eq!(result.is_ok(), field == "valid", "{field}");
            assert!(inner.state.lock().unwrap().pairings.is_empty());
            server.join().unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn usage_without_ticket_never_reads_metadata_or_runs_cli() {
        let (root, _, inner, _) = durable_fixture("http://127.0.0.1:1".into());
        let worker = ComputerWorker { inner };
        for ticket in ["", "invalid"] {
            assert!(worker
                .service_usage_with(ticket, |_| panic!(
                    "missing actor proof must fail before metadata"
                ))
                .is_err());
        }
        assert!(!include_str!("lib.rs").contains("pub mod codex_usage"));
        std::fs::remove_dir_all(root).unwrap();
    }
    struct BlockingSecrets {
        memory: Arc<MemorySecrets>,
        entered: mpsc::SyncSender<()>,
        resume: Mutex<mpsc::Receiver<()>>,
    }
    impl openbot_desktop_lib::computer_pairing::Secrets for BlockingSecrets {
        fn save(&self, key: &str, value: &str) -> Result<(), String> {
            openbot_desktop_lib::computer_pairing::Secrets::save(self.memory.as_ref(), key, value)
        }
        fn load(&self, key: &str) -> Result<Option<String>, String> {
            self.entered.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            openbot_desktop_lib::computer_pairing::Secrets::load(self.memory.as_ref(), key)
        }
        fn remove(&self, key: &str) -> Result<(), String> {
            openbot_desktop_lib::computer_pairing::Secrets::remove(self.memory.as_ref(), key)
        }
    }
    #[test]
    fn blocked_keychain_restore_is_single_flight_and_does_not_block_poll_cancellation_or_stop() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let (root, memory, mut inner, binding) =
            durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        Arc::get_mut(&mut inner).unwrap().store = Some(Arc::new(
            PairingStore::with_secrets(
                root.clone(),
                "installation".into(),
                Arc::new(BlockingSecrets {
                    memory,
                    entered: entered_tx,
                    resume: Mutex::new(release_rx),
                }),
            )
            .unwrap(),
        ));
        let cancel = openbot_workspaces::CodexCancellation::default();
        inner.state.lock().unwrap().active.insert(
            "running-job".into(),
            Active {
                computer_id: binding.computer_id.clone(),
                cancel: cancel.clone(),
                finished: Arc::new(AtomicBool::new(false)),
                harness: false,
                binding: None,
            },
        );
        let mut lane = RestoreLane::default();
        lane.launch(&inner, &HashMap::new(), |inner, attempts| {
            restore_pairings_until(
                inner,
                attempts,
                |_| Ok("Project".into()),
                Instant::now() + Duration::from_millis(100),
            );
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(RESTORE_LANE_BUSY.load(Ordering::SeqCst));
        let mut replacement = RestoreLane::default();
        replacement.launch(&inner, &HashMap::new(), |_, _| {
            panic!("second credential lane must never start")
        });
        assert!(replacement.result.is_none());
        let server_done = Arc::new(AtomicBool::new(false));
        let done = server_done.clone();
        let audience = binding.server_audience.clone();
        let server = thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        let (header, _) = read_http(&mut socket);
                        assert!(
                            header.starts_with("GET /desktop/next "),
                            "late credential must not reconnect: {header}"
                        );
                        reply_http(
                            &mut socket,
                            json!({"connectionId":"restarted-epoch","serverAudience":audience,"installationId":"installation","operations":[],"cancellations":["running-job"],"leaseMs":15000}),
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        let running = inner.clone();
        let worker_thread = thread::spawn(move || worker_loop(running));
        *inner.worker.lock().unwrap() = Some(worker_thread);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !cancel.cancelled() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            cancel.cancelled(),
            "poll cancellations must continue while Keychain waits"
        );
        let worker = ComputerWorker {
            inner: inner.clone(),
        };
        let before = Instant::now();
        assert!(worker.revoke_computer(&binding.computer_id).is_err());
        assert!(before.elapsed() < Duration::from_millis(100));
        let before = Instant::now();
        worker.stop();
        assert!(
            before.elapsed() < Duration::from_secs(2),
            "stop must not join the credential lane"
        );
        assert!(
            RESTORE_LANE_BUSY.load(Ordering::SeqCst),
            "stopping native work does not cancel the OS dialog"
        );
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while lane.result.is_some() && Instant::now() < deadline {
            lane.poll(&inner, &mut HashMap::new());
            thread::sleep(Duration::from_millis(5));
        }
        assert!(lane.result.is_none());
        assert!(!RESTORE_LANE_BUSY.load(Ordering::SeqCst));
        assert!(inner.state.lock().unwrap().pairings.is_empty());
        server_done.store(true, Ordering::SeqCst);
        server.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn delayed_credential_is_discarded_on_epoch_or_lease_change_and_deadline() {
        for reason in ["epoch", "lease", "deadline"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let (root, memory, mut inner, _) =
                durable_fixture(format!("http://{}", listener.local_addr().unwrap()));
            let (entered_tx, entered_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::channel();
            Arc::get_mut(&mut inner).unwrap().store = Some(Arc::new(
                PairingStore::with_secrets(
                    root.clone(),
                    "installation".into(),
                    Arc::new(BlockingSecrets {
                        memory,
                        entered: entered_tx,
                        resume: Mutex::new(release_rx),
                    }),
                )
                .unwrap(),
            ));
            let delay = if reason == "deadline" {
                Duration::from_millis(20)
            } else {
                Duration::from_secs(5)
            };
            let running = inner.clone();
            let task = thread::spawn(move || {
                restore_pairings_until(
                    &running,
                    &mut HashMap::new(),
                    |_| Ok("Project".into()),
                    Instant::now() + delay,
                )
            });
            entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            match reason {
                "epoch" => inner.state.lock().unwrap().connection("new-server-epoch"),
                "lease" => inner.state.lock().unwrap().revoke(),
                _ => thread::sleep(Duration::from_millis(30)),
            };
            // Worker remains running; the epoch/lease cases complete well before their deadline.
            assert!(!inner.stopped.load(Ordering::SeqCst));
            release_tx.send(()).unwrap();
            assert!(!task.join().unwrap());
            assert!(
                matches!(listener.accept(),Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
                "stale read must never initiate reconnect ({reason})"
            );
            assert!(inner.state.lock().unwrap().pairings.is_empty());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn stale_poll_cannot_dispatch_after_pairing_generation_changes() {
        let (root, _, inner, binding) = durable_fixture("http://127.0.0.1:1".into());
        let old = Pairing {
            owner: "alice".into(),
            binding_id: binding.binding_id.clone(),
            connection: "restarted-epoch".into(),
        };
        let mut newer = old.clone();
        newer.binding_id = "ffffffff-0000-4000-8000-000000000001".into();
        inner
            .state
            .lock()
            .unwrap()
            .pairings
            .insert(binding.computer_id.clone(), newer);
        let (send, receive) = mpsc::sync_channel(4);
        accept_if_current(
            &inner,
            &send,
            "restarted-epoch",
            operation(),
            Some(Some(old)),
        );
        assert!(receive.try_recv().is_err());
        assert!(inner.state.lock().unwrap().active.is_empty());
        assert!(inner.state.lock().unwrap().seen.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn coding_permission_requires_the_explicit_vm_mode_and_rejects_host_or_internal_names() {
        use openbot_workspaces::CodexPermission;
        assert_eq!(
            codex_permission("read-only").unwrap(),
            CodexPermission::ReadOnly
        );
        assert_eq!(
            codex_permission("workspace-write").unwrap(),
            CodexPermission::WorkspaceWrite
        );
        assert_eq!(
            codex_permission("vm-full-access").unwrap(),
            CodexPermission::VmFullAccess
        );
        for permission in ["danger-full-access", "host-full-access", "full-access", ""] {
            assert!(codex_permission(permission).is_err());
        }
    }

    #[test]
    fn deletion_revokes_only_the_selected_vm_and_requires_server_acknowledgement() {
        use std::net::TcpListener;
        for accepted in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let body = loop {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        assert!(
                            header.starts_with("post /api/desktop-computers/desktop/unregister ")
                        );
                        assert!(header.contains("authorization: bearer fixture-desktop-token"));
                        let length: usize = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break serde_json::from_slice::<Value>(
                                &bytes[end + 4..end + 4 + length],
                            )
                            .unwrap();
                        }
                    }
                };
                let body_text = if accepted {
                    r#"{"ok":true}"#
                } else {
                    r#"{"error":"fixture refusal"}"#
                };
                let status = if accepted { "200 OK" } else { "403 Forbidden" };
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_text}",body_text.len()).unwrap();
                body
            });
            let selected = "obw-0123456789abcdef";
            let other = "obw-fedcba9876543210";
            let mut state = State::default();
            state.connection("connection-one");
            let selected_cancel = openbot_workspaces::CodexCancellation::default();
            let other_cancel = openbot_workspaces::CodexCancellation::default();
            for (id, cancel) in [
                (selected, selected_cancel.clone()),
                (other, other_cancel.clone()),
            ] {
                let pairing = Pairing {
                    binding_id: String::new(),
                    owner: "alice".into(),
                    connection: "connection-one".into(),
                };
                state.pairings.insert(id.into(), pairing.clone());
                state.auth_grants.insert(id.into(), pairing);
                state.active.insert(
                    id.into(),
                    Active {
                        computer_id: id.into(),
                        cancel,
                        finished: Arc::new(AtomicBool::new(true)),
                        harness: true,
                        binding: None,
                    },
                );
            }
            let worker = ComputerWorker {
                inner: Arc::new(Inner {
                    owner_scope: std::path::PathBuf::new(),
                    installation: String::new(),
                    store: None,
                    notify: None,
                    base: format!("http://{address}/api/desktop-computers"),
                    token: "fixture-desktop-token".into(),
                    client: Client::builder()
                        .timeout(Duration::from_secs(2))
                        .build()
                        .unwrap(),
                    stopped: AtomicBool::new(false),
                    state: Mutex::new(state),
                    worker: Mutex::new(None),
                    jobs: Mutex::new(Vec::new()),
                    auth_action: Mutex::new(()),
                    pairing_action: Mutex::new(()),
                }),
            };
            assert_eq!(worker.revoke_computer(selected).is_ok(), accepted);
            assert_eq!(
                server.join().unwrap(),
                json!({"computerId":selected,"ownerUserId":"alice","connectionId":"connection-one"})
            );
            assert!(selected_cancel.cancelled());
            assert!(!other_cancel.cancelled());
            let state = worker.inner.state.lock().unwrap();
            assert!(state.deleting.contains(selected));
            assert!(!state.auth_grants.contains_key(selected));
            assert!(state.auth_grants.contains_key(other));
            assert!(state.pairings.contains_key(other));
            assert_eq!(state.pairings.contains_key(selected), !accepted);
            assert!(!state.authorized(&operation()));
            drop(state);
            worker.finish_deletion(selected);
        }
    }

    fn operation() -> Operation {
        Operation {
            operation_id: "01234567-0123-4567-89ab-0123456789ab".into(),
            computer_id: "obw-0123456789abcdef".into(),
            actor_id: "alice".into(),
            bot_id: "bot".into(),
            thread_id: "thread".into(),
            run_id: "run".into(),
            expires_at: now_ms() + 60_000,
            action: Action::RunCommand {
                command: "pwd".into(),
            },
        }
    }
    #[test]
    fn a_pairing_authorizes_only_its_server_session_owner_and_computer() {
        let mut state = State::default();
        state.connection("session1");
        let operation = operation();
        assert!(!state.authorized(&operation));
        state.pairings.insert(
            operation.computer_id.clone(),
            Pairing {
                binding_id: String::new(),
                owner: "alice".into(),
                connection: "session1".into(),
            },
        );
        assert!(state.authorized(&operation));
        let mut other = operation.clone();
        other.actor_id = "bob".into();
        assert!(!state.authorized(&other));
        state.connection("session2");
        assert!(!state.authorized(&operation));
        assert!(state.pairings.is_empty());
    }
    #[test]
    fn coding_sessions_are_bound_to_owner_bot_computer_and_conversation() {
        let original = operation();
        for field in 0..4 {
            let mut other = original.clone();
            match field {
                0 => other.actor_id = "other".into(),
                1 => other.bot_id = "other".into(),
                2 => other.computer_id = "obw-fedcba9876543210".into(),
                _ => other.thread_id = "other".into(),
            };
            assert_ne!(binding_key(&original), binding_key(&other));
            let saved = SavedSession {
                computer_id: original.computer_id.clone(),
                actor_id: original.actor_id.clone(),
                bot_id: original.bot_id.clone(),
                thread_id: original.thread_id.clone(),
                session_id: "codex-thread".into(),
            };
            assert!(validate_session(&other, saved).is_err());
        }
        let saved = SavedSession {
            computer_id: original.computer_id.clone(),
            actor_id: original.actor_id.clone(),
            bot_id: original.bot_id.clone(),
            thread_id: original.thread_id.clone(),
            session_id: "codex-thread".into(),
        };
        assert_eq!(validate_session(&original, saved).unwrap(), "codex-thread");
    }
    #[test]
    fn repaired_pairing_after_restart_or_reconnect_still_requires_explicit_vm_allow() {
        let request = operation();
        let mut state = State::default();
        state.connection("first-server-session");
        let pairing = Pairing {
            binding_id: String::new(),
            owner: request.actor_id.clone(),
            connection: "first-server-session".into(),
        };
        state
            .pairings
            .insert(request.computer_id.clone(), pairing.clone());
        state
            .auth_grants
            .insert(request.computer_id.clone(), pairing);
        assert!(state.coding_allowed(&request));
        state.connection("second-server-session");
        state.pairings.insert(
            request.computer_id.clone(),
            Pairing {
                binding_id: String::new(),
                owner: request.actor_id.clone(),
                connection: "second-server-session".into(),
            },
        );
        assert!(state.authorized(&request));
        assert!(
            !state.coding_allowed(&request),
            "new connection must not restore a VM grant"
        );
        let mut restarted = State::default();
        restarted.connection("third-server-session");
        restarted.pairings.insert(
            request.computer_id.clone(),
            Pairing {
                binding_id: String::new(),
                owner: request.actor_id.clone(),
                connection: "third-server-session".into(),
            },
        );
        assert!(restarted.authorized(&request));
        assert!(
            !restarted.coding_allowed(&request),
            "new worker must not restore a VM grant"
        );
    }
    #[test]
    fn coding_grants_are_specific_to_the_paired_vm_and_conversation_runs_are_exclusive() {
        let mut state = State::default();
        state.connection("server");
        let request = operation();
        let pairing = Pairing {
            binding_id: String::new(),
            owner: request.actor_id.clone(),
            connection: "server".into(),
        };
        state
            .pairings
            .insert(request.computer_id.clone(), pairing.clone());
        assert!(!state.coding_allowed(&request));
        state
            .auth_grants
            .insert(request.computer_id.clone(), pairing.clone());
        assert!(state.coding_allowed(&request));
        let mut other = request.clone();
        other.computer_id = "obw-fedcba9876543210".into();
        state.pairings.insert(other.computer_id.clone(), pairing);
        assert!(state.authorized(&other));
        assert!(!state.coding_allowed(&other));
        let finished = Arc::new(AtomicBool::new(false));
        let binding = binding_key(&request);
        state.active.insert(
            request.operation_id.clone(),
            Active {
                computer_id: request.computer_id.clone(),
                cancel: openbot_workspaces::CodexCancellation::default(),
                finished: finished.clone(),
                harness: true,
                binding: Some(binding.clone()),
            },
        );
        assert!(state.binding_busy(&binding));
        assert!(!state.binding_busy(&binding_key(&other)));
        finished.store(true, Ordering::SeqCst);
        assert!(!state.binding_busy(&binding));
        state.revoke();
        assert!(!state.coding_allowed(&request));
    }
    #[test]
    fn revocation_cancels_running_jobs_and_removes_authority() {
        let mut state = State::default();
        let cancel = openbot_workspaces::CodexCancellation::default();
        state.active.insert(
            "job".into(),
            Active {
                computer_id: "obw-0123456789abcdef".into(),
                cancel: cancel.clone(),
                finished: Arc::new(AtomicBool::new(false)),
                harness: true,
                binding: None,
            },
        );
        state.revoke();
        assert!(cancel.cancelled());
    }
    #[test]
    fn text_chunks_preserve_unicode_and_bound_wire_frames() {
        let text = "🦦".repeat(20_000);
        let chunks = split_output(&text);
        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 32 * 1024));
        assert!(valid_id("obw-0123456789abcdef"));
        assert!(!valid_id("../host"));
    }

    #[test]
    fn redelivering_an_operation_does_not_enqueue_or_execute_it_twice() {
        let inner = Arc::new(Inner {
            owner_scope: std::path::PathBuf::new(),
            installation: String::new(),
            store: None,
            notify: None,
            base: "http://127.0.0.1:1".into(),
            token: "test".into(),
            client: Client::builder().no_proxy().build().unwrap(),
            stopped: AtomicBool::new(false),
            state: Mutex::new(State::default()),
            worker: Mutex::new(None),
            jobs: Mutex::new(Vec::new()),
            auth_action: Mutex::new(()),
            pairing_action: Mutex::new(()),
        });
        inner.state.lock().unwrap().connection("session");
        let (send, receive) = mpsc::sync_channel(8);
        let request = operation();
        accept(&inner, &send, "session", request.clone());
        let rejected = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(rejected.sequence, 1);
        assert_eq!(rejected.event["type"], "failed");
        accept(&inner, &send, "session", request);
        assert!(receive.recv_timeout(Duration::from_millis(50)).is_err());
        for job in inner.jobs.lock().unwrap().drain(..) {
            job.join().unwrap();
        }
    }

    #[test]
    #[ignore = "requires OPENBOT_TEST_WORKSPACE naming an already-running Debian Computer"]
    fn guest_operations_stream_real_output_and_cancel_silent_commands() {
        let id = std::env::var("OPENBOT_TEST_WORKSPACE").expect("OPENBOT_TEST_WORKSPACE");
        let manager = manager().unwrap();
        manager.get(&id).unwrap();
        let mut request = operation();
        request.computer_id = id;
        request.thread_id = format!("native-worker-proof-{}", rand::random::<u64>());
        assert!(load_session(&request).unwrap().is_none());
        save_session(&request, "codex-local-resumption-proof").unwrap();
        assert_eq!(
            load_session(&request).unwrap().as_deref(),
            Some("codex-local-resumption-proof")
        );
        let session_path = session_directory(&request)
            .unwrap()
            .join(format!("{}.json", binding_key(&request)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&session_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_file(session_path).unwrap();
        request.operation_id = format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u32>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u64>() & 0xffffffffffff
        );
        request.action = Action::RunCommand {
            command: "printf openbot-native-worker-proof; uname -s; pwd".into(),
        };
        let mut text = String::new();
        let result = guest_operation(
            &manager,
            &request,
            &openbot_workspaces::CodexCancellation::default(),
            &mut |event| {
                text.push_str(event["text"].as_str().unwrap_or_default());
            },
        )
        .unwrap();
        assert_eq!(result.0, 0);
        assert!(text.contains("openbot-native-worker-proofLinux"));
        assert!(text.contains("/workspace/project"));
        let nonce = rand::random::<u64>();
        let fixture = format!(".openbot-worker-proof-{nonce}");
        let link = format!(".openbot-worker-link-{nonce}");
        let renew = |request: &mut Operation| {
            request.operation_id = format!(
                "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
                rand::random::<u32>(),
                rand::random::<u16>(),
                rand::random::<u16>(),
                rand::random::<u16>(),
                rand::random::<u64>() & 0xffffffffffff
            );
        };
        renew(&mut request);
        request.action = Action::WriteFile {
            path: fixture.clone(),
            content: "native Computer file proof".into(),
            append: false,
        };
        guest_operation(
            &manager,
            &request,
            &openbot_workspaces::CodexCancellation::default(),
            &mut |_| {},
        )
        .unwrap();
        renew(&mut request);
        request.action = Action::ReadFile {
            path: fixture.clone(),
        };
        let read = guest_operation(
            &manager,
            &request,
            &openbot_workspaces::CodexCancellation::default(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(read.2["content"], "native Computer file proof");
        renew(&mut request);
        request.action = Action::RunCommand {
            command: format!("ln -s /etc/hostname {link}"),
        };
        guest_operation(
            &manager,
            &request,
            &openbot_workspaces::CodexCancellation::default(),
            &mut |_| {},
        )
        .unwrap();
        renew(&mut request);
        request.action = Action::ReadFile { path: link.clone() };
        assert!(guest_operation(
            &manager,
            &request,
            &openbot_workspaces::CodexCancellation::default(),
            &mut |_| {}
        )
        .is_err());
        renew(&mut request);
        request.action = Action::RunCommand {
            command: format!("rm -- {fixture} {link}"),
        };
        guest_operation(
            &manager,
            &request,
            &openbot_workspaces::CodexCancellation::default(),
            &mut |_| {},
        )
        .unwrap();
        request.operation_id = format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u32>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u64>() & 0xffffffffffff
        );
        request.action = Action::RunCommand {
            command: "sleep 60".into(),
        };
        let cancel = openbot_workspaces::CodexCancellation::default();
        let stopping = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(600));
            stopping.cancel();
        });
        let began = Instant::now();
        assert!(guest_operation(&manager, &request, &cancel, &mut |_| {})
            .unwrap_err()
            .contains("stopped"));
        assert!(began.elapsed() < Duration::from_secs(9));
    }
}
