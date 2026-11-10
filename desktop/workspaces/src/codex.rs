//! Codex's native JSON-lines protocol over the guest's SSH stdio connection.
//! No listener, host authentication file, or host credential enters this transport.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Default)]
pub struct CodexCancellation(Arc<AtomicBool>);

impl CodexCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CodexPermission {
    ReadOnly,
    WorkspaceWrite,
    /// Disables Codex's inner sandbox inside an already isolated guest, never on the host.
    VmFullAccess,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexTurnRequest {
    pub prompt: String,
    pub thread_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub speed: Option<String>,
    pub permission: CodexPermission,
    pub developer_instructions: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CodexTurnEvent {
    ThreadStarted {
        thread_id: String,
    },
    TurnStarted {
        thread_id: String,
        turn_id: String,
    },
    AssistantDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    Completed {
        thread_id: String,
        turn_id: String,
    },
    Cancelled {
        thread_id: String,
        turn_id: Option<String>,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnResult {
    pub thread_id: String,
    pub turn_id: String,
    pub text: String,
}

/// An in-memory, short-lived provider grant. Never include it in a serializable job/request.
pub struct CodexProviderAuth {
    access_token: String,
}
impl std::fmt::Debug for CodexProviderAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodexProviderAuth([REDACTED])")
    }
}
impl CodexProviderAuth {
    pub fn chatgpt_plan(access_token: String) -> Result<Self, String> {
        if access_token.is_empty()
            || access_token.len() > 32768
            || access_token.chars().any(char::is_control)
        {
            return Err(
                "The desktop's ChatGPT access token is invalid. Connect ChatGPT again.".into(),
            );
        }
        Ok(Self { access_token })
    }
}

// Read exactly one frame without Python buffered read-ahead swallowing the following RPC frame.
// All argv/config values are public constants. The token travels only through the SSH stdin pipe.
pub(crate) const GUEST_BOOTSTRAP: &str = r#"
import json, os
frame = bytearray()
while True:
    byte = os.read(0, 1)
    if not byte or len(frame) > 65536:
        raise SystemExit('OpenBot provider grant was not received.')
    if byte == b'\n': break
    frame.extend(byte)
grant = json.loads(frame)
token = grant.get('accessToken')
if not isinstance(token, str) or not token or len(token) > 32768:
    raise SystemExit('OpenBot provider grant is invalid.')
os.environ['ACCESS_TOKEN'] = token
os.environ['CODEX_HOME'] = '/workspace/.openbot/codex'
os.makedirs(os.environ['CODEX_HOME'], mode=0o700, exist_ok=True)
args = ['/opt/openbot/tools/node_modules/.bin/codex', 'app-server',
    '-c', 'model_provider="openbot_chatgpt_plan"',
    '-c', 'model_providers.openbot_chatgpt_plan.name="ChatGPT plan"',
    '-c', 'model_providers.openbot_chatgpt_plan.base_url="https://api.openai.com/v1"',
    '-c', 'model_providers.openbot_chatgpt_plan.env_key="ACCESS_TOKEN"',
    '-c', 'model_providers.openbot_chatgpt_plan.wire_api="responses"',
    '-c', 'model_providers.openbot_chatgpt_plan.requires_openai_auth=false',
    '-c', 'model_providers.openbot_chatgpt_plan.supports_websockets=false',
    '-c', 'cli_auth_credentials_store="ephemeral"',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.exclude=["*TOKEN*","*KEY*","*SECRET*"]',
    '-c', 'shell_environment_policy.include_only=["PATH","HOME","USER","LOGNAME","LANG","LC_*","TERM","TMPDIR","TZ"]',
    '-c', 'shell_environment_policy.set={}',
    '-c', 'mcp_servers={}',
    '-c', 'sandbox_workspace_write.network_access=true']
os.execv(args[0], args)
"#;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningEffort {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexServiceTier {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub supported_reasoning_efforts: Vec<CodexReasoningEffort>,
    pub default_reasoning_effort: String,
    #[serde(default)]
    pub service_tiers: Vec<CodexServiceTier>,
    #[serde(default)]
    pub default_service_tier: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPage {
    data: Vec<CodexModel>,
    next_cursor: Option<String>,
}

struct Rpc {
    child: Child,
    input: Option<SyncSender<(Vec<u8>, SyncSender<Result<(), String>>)>>,
    messages: Option<Receiver<Result<Vec<u8>, String>>>,
    deadline: Instant,
    next_id: u64,
    received_bytes: usize,
    output_limit: usize,
    notifications: VecDeque<Value>,
    cancellation: CodexCancellation,
}

impl Rpc {
    fn spawn(mut command: Command, timeout: Duration) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Diagnostic output is discarded rather than collected or forwarded to a chat.
            // A malformed or noisy tool therefore cannot fill host memory or expose secrets.
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start Codex in this computer: {error}"))?;
        let mut pipe = child.stdin.take().expect("piped child stdin");
        let (input, writes) = mpsc::sync_channel::<(Vec<u8>, SyncSender<Result<(), String>>)>(1);
        thread::spawn(move || {
            while let Ok((bytes, acknowledge)) = writes.recv() {
                let result = pipe
                    .write_all(&bytes)
                    .map_err(|_| "Could not send a request to Codex.".to_owned());
                let failed = result.is_err();
                let _ = acknowledge.send(result);
                if failed {
                    break;
                }
            }
        });
        let output = child.stdout.take().expect("piped child stdout");
        let (sender, receiver) = mpsc::sync_channel(8);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let read = reader
                    .by_ref()
                    .take((MAX_FRAME_BYTES + 1) as u64)
                    .read_until(b'\n', &mut line);
                let frame = match read {
                    Ok(0) => break,
                    Ok(_) if line.len() > MAX_FRAME_BYTES => {
                        Err("Codex exceeded the protocol frame limit.".to_owned())
                    }
                    Ok(_) => Ok(line),
                    Err(_) => Err("Could not read Codex's protocol response.".to_owned()),
                };
                let failed = frame.is_err();
                if sender.send(frame).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input),
            messages: Some(receiver),
            deadline: Instant::now() + timeout,
            next_id: 1,
            received_bytes: 0,
            output_limit: MAX_RESPONSE_BYTES,
            notifications: VecDeque::new(),
            cancellation: CodexCancellation::default(),
        })
    }

    fn send(&mut self, message: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let (acknowledge, written) = mpsc::sync_channel(1);
        self.input
            .as_ref()
            .ok_or("Codex's input is closed.")?
            .try_send((bytes, acknowledge))
            .map_err(|_| "Could not send a request to Codex.".to_owned())?;
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or("Codex operation timed out.")?
            .min(Duration::from_secs(5));
        written
            .recv_timeout(remaining)
            .map_err(|_| "Codex operation timed out.".to_owned())?
    }

    fn receive(&mut self, wait: Duration) -> Result<Option<Value>, String> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or("Codex operation timed out.")?;
        let line = match self
            .messages
            .as_ref()
            .expect("active receiver")
            .recv_timeout(remaining.min(wait))
        {
            Ok(line) => line?,
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Codex closed its connection before answering.".into())
            }
        };
        self.received_bytes += line.len();
        if self.received_bytes > self.output_limit {
            return Err("Codex exceeded the operation output limit.".into());
        }
        serde_json::from_slice(&line)
            .map(Some)
            .map_err(|_| "Codex returned an invalid protocol response.".to_owned())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"id": id, "method": method, "params": params}))?;
        loop {
            if self.cancellation.cancelled() {
                return Err("Codex turn was cancelled.".into());
            }
            let Some(response) = self.receive(Duration::from_millis(100))? else {
                continue;
            };
            // Notifications can precede the requested response. Discovery does not surface them.
            if response.get("id").is_none() && response.get("method").is_some() {
                if self.notifications.len() >= 128 {
                    return Err("Codex sent too many pending notifications.".into());
                }
                self.notifications.push_back(response);
                continue;
            }
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                return Err("Codex returned an unexpected response id.".into());
            }
            if response.get("error").is_some() {
                // Do not relay arbitrary diagnostic payloads from the guest into the host UI.
                return Err(format!("Codex rejected the {method} request."));
            }
            return response
                .get("result")
                .cloned()
                .ok_or_else(|| "Codex returned a response without a result.".into());
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        // EOF asks app-server to exit; killing and reaping the local SSH client also covers
        // hung/malformed guests. Drop the bounded receiver so its reader cannot stay blocked.
        self.input.take();
        self.messages.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn models(command: Command) -> Result<Vec<CodexModel>, String> {
    discover(command, DISCOVERY_TIMEOUT)
}

fn discover(command: Command, timeout: Duration) -> Result<Vec<CodexModel>, String> {
    let mut rpc = Rpc::spawn(command, timeout)?;
    rpc.request(
        "initialize",
        json!({"clientInfo": {"name": "openbot", "version": env!("CARGO_PKG_VERSION")}}),
    )?;
    rpc.send(json!({"method": "initialized"}))?;
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..16 {
        let page: ModelPage = serde_json::from_value(rpc.request(
            "model/list",
            json!({"cursor": cursor, "includeHidden": false, "limit": 100}),
        )?)
        .map_err(|_| "Codex returned an invalid model catalogue.".to_owned())?;
        models.extend(page.data.into_iter().filter(|model| !model.hidden));
        if models.len() > 256 {
            return Err("Codex exceeded the model catalogue limit.".into());
        }
        match page.next_cursor {
            None => return Ok(models),
            Some(next) if Some(&next) == cursor.as_ref() || next.len() > 4096 => {
                return Err("Codex returned an invalid model catalogue cursor.".into());
            }
            Some(next) => cursor = Some(next),
        }
    }
    Err("Codex exceeded the model catalogue page limit.".into())
}

fn validate_turn(request: &CodexTurnRequest) -> Result<(), String> {
    if request.prompt.trim().is_empty()
        || request.prompt.len() > 256 * 1024
        || request.prompt.contains('\0')
    {
        return Err("Enter a coding message of at most 256 KiB.".into());
    }
    for value in [&request.thread_id, &request.model, &request.effort]
        .into_iter()
        .flatten()
    {
        if value.is_empty()
            || value.len() > 256
            || value.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err("The coding thread, model or effort choice is invalid.".into());
        }
    }
    if request
        .speed
        .as_deref()
        .is_some_and(|speed| !["standard", "fast"].contains(&speed))
    {
        return Err("Choose standard or fast coding speed.".into());
    }
    if request
        .developer_instructions
        .as_ref()
        .is_some_and(|text| text.len() > 64 * 1024 || text.contains('\0'))
    {
        return Err("Coding instructions must be at most 64 KiB.".into());
    }
    Ok(())
}

pub(crate) fn turn(
    command: Command,
    request: CodexTurnRequest,
    auth: Option<CodexProviderAuth>,
    cancellation: CodexCancellation,
    mut emit: impl FnMut(CodexTurnEvent),
) -> Result<CodexTurnResult, String> {
    let mut current_thread = request.thread_id.clone().unwrap_or_default();
    let mut current_turn = None;
    let result = (|| {
        validate_turn(&request)?;
        let auth = auth
            .ok_or("Connect ChatGPT in the OpenBot desktop app before starting this coding Bot.")?;
        let mut rpc = Rpc::spawn(command, TURN_TIMEOUT)?;
        rpc.output_limit = 64 * 1024 * 1024;
        rpc.cancellation = cancellation.clone();
        rpc.send(json!({"accessToken": auth.access_token}))?;
        run_turn(&mut rpc, &request, &mut |event| {
            match &event {
                CodexTurnEvent::ThreadStarted { thread_id } => current_thread = thread_id.clone(),
                CodexTurnEvent::TurnStarted { turn_id, .. } => current_turn = Some(turn_id.clone()),
                _ => {}
            }
            emit(event);
        })
    })();
    if let Err(message) = &result {
        if cancellation.cancelled() {
            emit(CodexTurnEvent::Cancelled {
                thread_id: current_thread,
                turn_id: current_turn,
            });
        } else {
            emit(CodexTurnEvent::Failed {
                message: message.clone(),
            });
        }
    }
    result
}

fn result_id(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| "Codex returned an invalid thread or turn id.".into())
}

fn run_turn(
    rpc: &mut Rpc,
    request: &CodexTurnRequest,
    emit: &mut impl FnMut(CodexTurnEvent),
) -> Result<CodexTurnResult, String> {
    rpc.request("initialize", json!({"clientInfo":{"name":"openbot","title":"OpenBot","version":env!("CARGO_PKG_VERSION")}}))?;
    rpc.send(json!({"method":"initialized"}))?;
    let effective = rpc.request(
        "config/read",
        json!({"cwd":crate::PROJECT_PATH,"includeLayers":false}),
    )?;
    if effective["config"]["mcp_servers"]
        .as_object()
        .is_some_and(|servers| {
            servers
                .values()
                .any(|server| server.get("enabled").and_then(Value::as_bool) != Some(false))
        })
    {
        return Err("This coding Bot does not enable project MCP servers yet. Disable them in the VM before starting a turn.".into());
    }
    let sandbox = match request.permission {
        CodexPermission::ReadOnly => "read-only",
        CodexPermission::WorkspaceWrite => "workspace-write",
        CodexPermission::VmFullAccess => "danger-full-access",
    };
    let mut params = json!({
        "cwd":crate::PROJECT_PATH,"model":request.model,"approvalPolicy":"never",
        "sandbox":sandbox,"developerInstructions":request.developer_instructions,
    });
    let method = if let Some(thread_id) = &request.thread_id {
        params["threadId"] = json!(thread_id);
        params["excludeTurns"] = json!(true);
        "thread/resume"
    } else {
        "thread/start"
    };
    let thread_response = rpc.request(method, params)?;
    let thread_id = result_id(&thread_response["thread"], "id")?;
    emit(CodexTurnEvent::ThreadStarted {
        thread_id: thread_id.clone(),
    });
    // thread/start may notify before its reply. Its response above is the canonical thread.
    rpc.notifications.clear();
    let turn_response = rpc.request("turn/start", json!({
        "threadId":thread_id,"cwd":crate::PROJECT_PATH,
        "input":[{"type":"text","text":request.prompt}],
        "model":request.model,"effort":request.effort,"approvalPolicy":"never",
        "serviceTierForTurn":request.speed.as_deref().map(|speed| if speed == "fast" { "priority" } else { "default" }),
    }))?;
    let turn_id = result_id(&turn_response["turn"], "id")?;
    emit(CodexTurnEvent::TurnStarted {
        thread_id: thread_id.clone(),
        turn_id: turn_id.clone(),
    });
    let mut text = String::new();
    let mut items = std::collections::HashMap::<String, String>::new();
    let mut interrupt_id = None;
    let mut interrupt_deadline = None;
    loop {
        if rpc.cancellation.cancelled() && interrupt_id.is_none() {
            let id = rpc.next_id;
            rpc.next_id += 1;
            rpc.send(json!({"id":id,"method":"turn/interrupt","params":{"threadId":thread_id,"turnId":turn_id}}))?;
            interrupt_id = Some(id);
            interrupt_deadline = Some(Instant::now() + Duration::from_secs(3));
        }
        if interrupt_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err("Codex turn was cancelled.".into());
        }
        let message = match rpc.notifications.pop_front() {
            Some(message) => message,
            None => match rpc.receive(Duration::from_millis(100))? {
                Some(message) => message,
                None => continue,
            },
        };
        if message.get("id").and_then(Value::as_u64) == interrupt_id && interrupt_id.is_some() {
            continue;
        }
        if message.get("id").is_some() && message.get("method").is_some() {
            rpc.send(json!({"id":message["id"],"error":{"code":-32601,"message":"Interactive requests are not enabled for this Bot."}}))?;
            return Err(
                "Codex requested an interactive action that this coding Bot cannot handle yet."
                    .into(),
            );
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Err("Codex returned an unexpected turn response.".into());
        };
        let params = &message["params"];
        if params
            .get("threadId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != thread_id)
        {
            continue;
        }
        match method {
            "item/agentMessage/delta" if params["turnId"].as_str() == Some(&turn_id) => {
                let item_id = result_id(params, "itemId")?;
                let delta = params["delta"]
                    .as_str()
                    .ok_or("Codex returned an invalid assistant delta.")?;
                if let Some(delta) = append_assistant_text(&mut text, &mut items, &item_id, delta)?
                {
                    emit(CodexTurnEvent::AssistantDelta {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        item_id,
                        delta,
                    });
                }
            }
            "item/completed"
                if params["turnId"].as_str() == Some(&turn_id)
                    && params["item"]["type"].as_str() == Some("agentMessage") =>
            {
                let item_id = result_id(&params["item"], "id")?;
                // Some app-server transports emit a completed item without deltas.
                if !items.contains_key(&item_id) {
                    if let Some(delta) = params["item"]["text"].as_str() {
                        if let Some(delta) =
                            append_assistant_text(&mut text, &mut items, &item_id, delta)?
                        {
                            emit(CodexTurnEvent::AssistantDelta {
                                thread_id: thread_id.clone(),
                                turn_id: turn_id.clone(),
                                item_id,
                                delta,
                            });
                        }
                    }
                }
            }
            "turn/completed" if params["turn"]["id"].as_str() == Some(&turn_id) => {
                match params["turn"]["status"].as_str() {
                    Some("completed") if interrupt_id.is_none() => {
                        emit(CodexTurnEvent::Completed { thread_id:thread_id.clone(),turn_id:turn_id.clone() });
                        return Ok(CodexTurnResult { thread_id,turn_id,text });
                    }
                    Some("interrupted") | Some("completed") if interrupt_id.is_some() => return Err("Codex turn was cancelled.".into()),
                    Some("interrupted") => return Err("Codex interrupted this turn before it finished.".into()),
                    _ => return Err("Codex could not finish this turn. Check the ChatGPT connection in the desktop app and try again.".into()),
                }
            }
            _ => {}
        }
    }
}

// Keep item boundaries in the rendered stream and the returned transcript identical.
// Raw item text stays separate so completed-item replays cannot duplicate streamed content.
fn append_assistant_text(
    text: &mut String,
    items: &mut std::collections::HashMap<String, String>,
    item_id: &str,
    delta: &str,
) -> Result<Option<String>, String> {
    if delta.is_empty() {
        return Ok(None);
    }
    let mut rendered = String::new();
    if !text.is_empty() && !items.contains_key(item_id) {
        let trailing = text
            .chars()
            .rev()
            .take_while(|c| *c == '\n')
            .take(2)
            .count();
        let leading = delta.chars().take_while(|c| *c == '\n').take(2).count();
        rendered.push_str(&"\n".repeat(2usize.saturating_sub(trailing + leading)));
    }
    rendered.push_str(delta);
    if text.len() + rendered.len() > 4 * 1024 * 1024 {
        return Err("Codex exceeded the assistant output limit.".into());
    }
    text.push_str(&rendered);
    items.entry(item_id.into()).or_default().push_str(delta);
    Ok(Some(rendered))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coding_request() -> CodexTurnRequest {
        CodexTurnRequest {
            prompt: "Inspect the current project.".into(),
            thread_id: None,
            model: Some("example-model".into()),
            effort: Some("high".into()),
            speed: Some("standard".into()),
            permission: CodexPermission::ReadOnly,
            developer_instructions: Some("Keep changes local.".into()),
        }
    }

    fn fake_coding_server(mode: &str) -> Command {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", r#"
import json, sys
mode = sys.argv[1]
def receive(): return json.loads(sys.stdin.readline())
def respond(id, result): print(json.dumps({'id':id,'result':result}), flush=True)
def notify(method, params): print(json.dumps({'method':method,'params':params}), flush=True)
assert receive() == {'accessToken':'test-grant-not-real'}
first = receive()
assert first['method'] == 'initialize'
respond(first['id'], {})
assert receive()['method'] == 'initialized'
config = receive()
assert config['method'] == 'config/read'
assert config['params']['cwd'] == '/workspace/project'
respond(config['id'], {'config':{'mcp_servers': {'unsafe': {'env_vars':['ACCESS_TOKEN']}} if mode == 'mcp' else {}}})
if mode == 'mcp':
    assert not sys.stdin.readline()
    raise SystemExit(0)
thread = receive()
resuming = mode in ['resume', 'vm-full-resume', 'write-resume']
assert thread['method'] == ('thread/resume' if resuming else 'thread/start')
assert thread['params']['cwd'] == '/workspace/project'
assert thread['params']['approvalPolicy'] == 'never'
expected_sandbox = 'danger-full-access' if mode.startswith('vm-full') else 'workspace-write' if mode in ['write', 'write-resume'] else 'read-only'
assert thread['params']['sandbox'] == expected_sandbox
assert thread['params']['developerInstructions'] == 'Keep changes local.'
if resuming: assert thread['params']['threadId'] == 'thread-1'
respond(thread['id'], {'thread':{'id':'thread-1'}})
turn = receive()
assert turn['method'] == 'turn/start'
assert turn['params']['input'][0]['text'] == 'Inspect the current project.'
assert turn['params']['model'] == 'example-model'
assert turn['params']['effort'] == 'high'
assert turn['params']['serviceTierForTurn'] == ('priority' if mode == 'resume' else 'default')
# Early notifications must survive the turn/start response, including a different thread.
notify('item/agentMessage/delta', {'threadId':'another-thread','turnId':'turn-1','itemId':'item-x','delta':'Wrong'})
notify('item/agentMessage/delta', {'threadId':'thread-1','turnId':'turn-1','itemId':'item-1','delta':'Hello'})
respond(turn['id'], {'turn':{'id':'turn-1','status':'inProgress'}})
if mode == 'cancel':
    interrupt = receive()
    assert interrupt['method'] == 'turn/interrupt'
    assert interrupt['params'] == {'threadId':'thread-1','turnId':'turn-1'}
    respond(interrupt['id'], {})
    status = 'interrupted'
else:
    notify('item/agentMessage/delta', {'threadId':'thread-1','turnId':'turn-1','itemId':'item-1','delta':' world'})
    notify('item/completed', {'threadId':'thread-1','turnId':'turn-1','item':{'id':'item-1','type':'agentMessage','text':'Hello world'}})
    if mode == 'multiple-items':
        notify('item/agentMessage/delta', {'threadId':'thread-1','turnId':'turn-1','itemId':'item-2','delta':'The sidebar'})
        notify('item/agentMessage/delta', {'threadId':'thread-1','turnId':'turn-1','itemId':'item-2','delta':' now works.'})
        for unused in range(2):
            notify('item/completed', {'threadId':'thread-1','turnId':'turn-1','item':{'id':'item-2','type':'agentMessage','text':'The sidebar now works.'}})
            notify('item/completed', {'threadId':'thread-1','turnId':'turn-1','item':{'id':'item-3','type':'agentMessage','text':'\nFallback message.'}})
        notify('item/agentMessage/delta', {'threadId':'thread-1','turnId':'turn-1','itemId':'item-4','delta':''})
        notify('item/completed', {'threadId':'thread-1','turnId':'turn-1','item':{'id':'item-4','type':'agentMessage','text':'Last message.'}})
    status = 'failed' if mode == 'failure' else 'completed'
notify('turn/completed', {'threadId':'thread-1','turn':{'id':'turn-1','status':status,'error':{'message':'test-grant-not-real'}}})
sys.stdin.read()
"#, mode]);
        command
    }

    #[test]
    fn coding_turn_streams_actual_protocol_and_can_resume_with_new_settings() {
        for mode in [
            "success",
            "resume",
            "write",
            "write-resume",
            "vm-full",
            "vm-full-resume",
        ] {
            let mut request = coding_request();
            if ["resume", "write-resume", "vm-full-resume"].contains(&mode) {
                request.thread_id = Some("thread-1".into());
            }
            if mode == "resume" {
                request.speed = Some("fast".into());
            }
            if ["write", "write-resume"].contains(&mode) {
                request.permission = CodexPermission::WorkspaceWrite;
            }
            if mode.starts_with("vm-full") {
                request.permission = CodexPermission::VmFullAccess;
            }
            let mut events = Vec::new();
            let result = turn(
                fake_coding_server(mode),
                request,
                Some(CodexProviderAuth::chatgpt_plan("test-grant-not-real".into()).unwrap()),
                CodexCancellation::default(),
                |event| events.push(event),
            )
            .unwrap();
            assert_eq!(result.text, "Hello world");
            assert_eq!(result.thread_id, "thread-1");
            assert_eq!(result.turn_id, "turn-1");
            assert!(
                matches!(&events[0], CodexTurnEvent::ThreadStarted { thread_id } if thread_id == "thread-1")
            );
            assert!(
                matches!(&events[1], CodexTurnEvent::TurnStarted { turn_id, .. } if turn_id == "turn-1")
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event, CodexTurnEvent::AssistantDelta { .. }))
                    .count(),
                2
            );
            assert!(matches!(
                events.last(),
                Some(CodexTurnEvent::Completed { .. })
            ));
        }
    }

    #[test]
    fn distinct_assistant_items_keep_paragraphs_in_stream_and_result_without_completion_replays() {
        let mut deltas = Vec::new();
        let result = turn(
            fake_coding_server("multiple-items"),
            coding_request(),
            Some(CodexProviderAuth::chatgpt_plan("test-grant-not-real".into()).unwrap()),
            CodexCancellation::default(),
            |event| {
                if let CodexTurnEvent::AssistantDelta { delta, .. } = event {
                    deltas.push(delta);
                }
            },
        )
        .unwrap();
        assert_eq!(
            deltas,
            [
                "Hello",
                " world",
                "\n\nThe sidebar",
                " now works.",
                "\n\nFallback message.",
                "\n\nLast message."
            ]
        );
        assert_eq!(
            result.text,
            "Hello world\n\nThe sidebar now works.\n\nFallback message.\n\nLast message."
        );
        assert_eq!(deltas.concat(), result.text);
    }

    #[test]
    fn assistant_boundaries_preserve_existing_paragraphs_and_count_toward_output_limit() {
        let mut text = String::from("First\n\n");
        let mut items = std::collections::HashMap::new();
        assert_eq!(
            append_assistant_text(&mut text, &mut items, "next", "Second").unwrap(),
            Some("Second".into())
        );
        assert_eq!(text, "First\n\nSecond");
        text = "x".repeat(4 * 1024 * 1024 - 2);
        let before = text.len();
        assert!(append_assistant_text(&mut text, &mut items, "new", "y").is_err());
        assert_eq!(text.len(), before);
        assert!(!items.contains_key("new"));
    }

    #[test]
    fn coding_cancellation_interrupts_the_guest_turn_without_reporting_success() {
        let cancellation = CodexCancellation::default();
        let mut events = Vec::new();
        let start = Instant::now();
        let result = turn(
            fake_coding_server("cancel"),
            coding_request(),
            Some(CodexProviderAuth::chatgpt_plan("test-grant-not-real".into()).unwrap()),
            cancellation.clone(),
            |event| {
                if matches!(&event, CodexTurnEvent::AssistantDelta { .. }) {
                    cancellation.cancel();
                }
                events.push(event);
            },
        );
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(
            matches!(events.last(),Some(CodexTurnEvent::Cancelled { thread_id, turn_id:Some(turn_id) }) if thread_id == "thread-1" && turn_id == "turn-1")
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, CodexTurnEvent::Completed { .. })));
    }

    #[test]
    fn failed_and_unauthenticated_turns_are_actionable_and_do_not_leak_diagnostics() {
        let mut events = Vec::new();
        let result = turn(
            fake_coding_server("failure"),
            coding_request(),
            Some(CodexProviderAuth::chatgpt_plan("test-grant-not-real".into()).unwrap()),
            CodexCancellation::default(),
            |event| events.push(event),
        );
        let error = result.unwrap_err();
        assert!(error.contains("ChatGPT connection"));
        assert!(!error.contains("test-grant"));
        assert!(matches!(events.last(), Some(CodexTurnEvent::Failed { .. })));
        assert!(!events
            .iter()
            .any(|event| matches!(event, CodexTurnEvent::Completed { .. })));
        assert!(turn(
            Command::new("must-not-spawn"),
            coding_request(),
            None,
            CodexCancellation::default(),
            |_| {}
        )
        .unwrap_err()
        .contains("Connect ChatGPT"));
        let auth = CodexProviderAuth::chatgpt_plan("test-grant-not-real".into()).unwrap();
        assert!(!format!("{auth:?}").contains("test-grant"));
    }

    #[test]
    fn provider_bootstrap_keeps_grants_out_of_argv_and_filters_child_environments() {
        assert!(GUEST_BOOTSTRAP.contains("os.read(0, 1)"));
        assert!(GUEST_BOOTSTRAP.contains("shell_environment_policy.inherit=\"core\""));
        assert!(GUEST_BOOTSTRAP.contains("shell_environment_policy.ignore_default_excludes=false"));
        assert!(GUEST_BOOTSTRAP.contains("shell_environment_policy.include_only="));
        assert!(GUEST_BOOTSTRAP
            .contains("shell_environment_policy.exclude=[\"*TOKEN*\",\"*KEY*\",\"*SECRET*\"]"));
        assert!(GUEST_BOOTSTRAP.contains("cli_auth_credentials_store=\"ephemeral\""));
        let request = coding_request();
        let serialized = serde_json::to_string(&request).unwrap();
        assert!(!serialized.contains("accessToken"));
        assert!(!serialized.contains("access_token"));
    }

    #[test]
    fn full_access_is_named_for_the_vm_and_never_accepts_the_internal_host_sandbox_name() {
        assert_eq!(
            serde_json::to_string(&CodexPermission::VmFullAccess).unwrap(),
            "\"vm-full-access\""
        );
        for (name, expected) in [
            ("read-only", CodexPermission::ReadOnly),
            ("workspace-write", CodexPermission::WorkspaceWrite),
            ("vm-full-access", CodexPermission::VmFullAccess),
        ] {
            assert_eq!(
                serde_json::from_str::<CodexPermission>(&format!("\"{name}\"")).unwrap(),
                expected
            );
        }
        for name in ["danger-full-access", "host-full-access", "full-access"] {
            assert!(serde_json::from_str::<CodexPermission>(&format!("\"{name}\"")).is_err());
        }
    }

    #[test]
    fn configured_mcp_servers_cannot_opt_into_the_ephemeral_provider_grant() {
        let result = turn(
            fake_coding_server("mcp"),
            coding_request(),
            Some(CodexProviderAuth::chatgpt_plan("test-grant-not-real".into()).unwrap()),
            CodexCancellation::default(),
            |_| {},
        );
        assert!(result
            .unwrap_err()
            .contains("does not enable project MCP servers"));
    }

    // Real pipes and a subprocess exercise initialization ordering, notifications and paging.
    #[test]
    fn discovery_waits_for_initialization_and_reads_paginated_capabilities() {
        let mut command = Command::new("python3");
        command.args(["-c", r#"
import json, sys
def receive(): return json.loads(sys.stdin.readline())
def respond(id, result): print(json.dumps({'id':id,'result':result}), flush=True)
first = receive()
assert first['method'] == 'initialize'
respond(first['id'], {'userAgent':'test'})
assert receive()['method'] == 'initialized'
for page in range(2):
    request = receive()
    assert request['method'] == 'model/list'
    assert request['params']['cursor'] == (None if page == 0 else 'next')
    print(json.dumps({'method':'notice','params':{}}), flush=True)
    model = {'id':str(page),'model':str(page),'displayName':'Test','description':'Test model',
      'hidden':False,'isDefault':page == 0,'supportedReasoningEfforts':[{'reasoningEffort':'high','description':'Think'}],
      'defaultReasoningEffort':'high','serviceTiers':[{'id':'priority','name':'Fast','description':'Fast'}]}
    respond(request['id'], {'data':[model],'nextCursor':'next' if page == 0 else None})
sys.stdin.read()
"#]);
        let models = discover(command, Duration::from_secs(3)).unwrap();
        assert_eq!(models.len(), 2);
        assert!(models[0].is_default);
        assert_eq!(
            models[0].supported_reasoning_efforts[0].reasoning_effort,
            "high"
        );
        assert_eq!(models[0].service_tiers[0].id, "priority");
    }

    #[test]
    fn discovery_times_out_and_reaps_the_child() {
        let mut command = Command::new("python3");
        command.args(["-c", "import time; time.sleep(20)"]);
        let started = Instant::now();
        assert!(discover(command, Duration::from_millis(75))
            .unwrap_err()
            .contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn discovery_rejects_oversized_protocol_frames() {
        let mut command = Command::new("python3");
        command.args(["-c", "import sys; sys.stdin.readline(); print('x' * (2*1024*1024+1), flush=True); sys.stdin.read()"]);
        assert!(discover(command, Duration::from_secs(3))
            .unwrap_err()
            .contains("frame limit"));
    }

    #[test]
    #[ignore = "requires OPENBOT_TEST_WORKSPACE and a running guest with Codex installed"]
    fn live_guest_model_discovery() {
        let id = std::env::var("OPENBOT_TEST_WORKSPACE").expect("OPENBOT_TEST_WORKSPACE");
        let manager = crate::Manager::new(crate::default_root().unwrap()).unwrap();
        let models = manager.codex_models(&id).unwrap();
        assert!(!models.is_empty());
        assert!(models.iter().any(|model| model.is_default));
        assert!(models
            .iter()
            .all(|model| !model.id.is_empty() && !model.supported_reasoning_efforts.is_empty()));
    }

    #[test]
    #[ignore = "requires OPENBOT_TEST_WORKSPACE and installed guest Codex; uses only a dummy grant, no inference"]
    fn live_guest_provider_bootstrap_and_effective_security_configuration() {
        let id = std::env::var("OPENBOT_TEST_WORKSPACE").expect("OPENBOT_TEST_WORKSPACE");
        let manager = crate::Manager::new(crate::default_root().unwrap()).unwrap();
        let mut command = manager.shell_command(&id).unwrap();
        command.args(["python3", "-u", "-c", GUEST_BOOTSTRAP]);
        let mut rpc = Rpc::spawn(command, Duration::from_secs(15)).unwrap();
        rpc.send(json!({"accessToken":"test-grant-not-real"}))
            .unwrap();
        rpc.request(
            "initialize",
            json!({"clientInfo":{"name":"openbot-test","version":"0.1.0"}}),
        )
        .unwrap();
        rpc.send(json!({"method":"initialized"})).unwrap();
        let result = rpc
            .request(
                "config/read",
                json!({"cwd":crate::PROJECT_PATH,"includeLayers":false}),
            )
            .unwrap();
        let config = &result["config"];
        assert_eq!(config["model_provider"], "openbot_chatgpt_plan");
        assert_eq!(
            config["model_providers"]["openbot_chatgpt_plan"]["env_key"],
            "ACCESS_TOKEN"
        );
        assert_eq!(config["shell_environment_policy"]["inherit"], "core");
        assert_eq!(
            config["shell_environment_policy"]["ignore_default_excludes"],
            false
        );
        assert_eq!(config["cli_auth_credentials_store"], "ephemeral");
        assert!(!serde_json::to_string(config)
            .unwrap()
            .contains("test-grant-not-real"));
        rpc.request(
            "thread/start",
            json!({"cwd":crate::PROJECT_PATH,"approvalPolicy":"never","sandbox":"read-only"}),
        )
        .unwrap();
        let output = manager
            .shell_command(&id)
            .unwrap()
            .args(["test", "!", "-e", "/workspace/.openbot/codex/auth.json"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "The ephemeral provider must not write a guest auth file."
        );
    }
}
