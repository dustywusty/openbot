//! Claude Code's documented print-mode NDJSON transport inside the selected guest.
//! Authentication is deliberately not implemented here: bare mode does not load saved OAuth
//! credentials, and no host or guest credential environment is forwarded to Claude or its tools.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: usize = 2 * 1024 * 1024;
const MAX_OUTPUT: usize = 64 * 1024 * 1024;
const MAX_TEXT: usize = 4 * 1024 * 1024;
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Default)]
pub struct ClaudeCancellation(Arc<AtomicBool>);
impl ClaudeCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ClaudePermission {
    ReadOnly,
    WorkspaceWrite,
    VmFullAccess,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeTurnRequest {
    pub prompt: String,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission: ClaudePermission,
    pub developer_instructions: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaudeTurnEvent {
    Started {
        session_id: String,
    },
    AssistantDelta {
        session_id: String,
        message_id: String,
        delta: String,
    },
    Completed {
        session_id: String,
    },
    Cancelled {
        session_id: Option<String>,
    },
    Failed {
        message: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTurnResult {
    pub session_id: String,
    pub text: String,
}

fn valid_session(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn validate(request: &ClaudeTurnRequest) -> Result<(), String> {
    if request.prompt.trim().is_empty()
        || request.prompt.len() > 256 * 1024
        || request.prompt.contains('\0')
    {
        return Err("Enter a coding prompt of at most 256 KiB.".into());
    }
    if request
        .session_id
        .as_deref()
        .is_some_and(|id| !valid_session(id))
    {
        return Err("Choose a valid Claude Code session, not a file path.".into());
    }
    if request.model.as_deref().is_some_and(|model| {
        model.is_empty()
            || model.len() > 256
            || model.starts_with('-')
            || model.chars().any(char::is_control)
    }) {
        return Err("Choose a valid Claude Code model.".into());
    }
    if request
        .effort
        .as_deref()
        .is_some_and(|e| !["low", "medium", "high", "xhigh", "max"].contains(&e))
    {
        return Err("Choose an effort supported by Claude Code.".into());
    }
    if request
        .developer_instructions
        .as_deref()
        .is_some_and(|s| s.len() > 64 * 1024 || s.contains('\0'))
    {
        return Err("The coding instructions are too large or invalid.".into());
    }
    Ok(())
}

// No credentials, auth helper, configurable executable, or host path is accepted in this frame.
fn launch_frame(request: &ClaudeTurnRequest) -> Value {
    let mut settings = json!({"disableAllHooks":true,"permissions":{"defaultMode":"dontAsk"}});
    let mut args = vec![
        "--bare".to_owned(),
        "-p".into(),
        "--verbose".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--setting-sources".into(),
        "".into(),
        "--strict-mcp-config".into(),
        "--mcp-config".into(),
        "{\"mcpServers\":{}}".into(),
        "--no-chrome".into(),
    ];
    match request.permission {
        ClaudePermission::ReadOnly => args.extend([
            "--permission-mode".into(),
            "dontAsk".into(),
            "--tools".into(),
            "Read,Glob,Grep".into(),
            "--allowedTools".into(),
            "Read,Glob,Grep".into(),
        ]),
        ClaudePermission::WorkspaceWrite => {
            // Required sandbox fails closed when its OS dependencies are missing.
            settings["sandbox"] = json!({"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"excludedCommands":[]});
            args.extend([
                "--permission-mode".into(),
                "dontAsk".into(),
                "--tools".into(),
                "Read,Glob,Grep,Edit,Write,Bash".into(),
                "--allowedTools".into(),
                "Read,Glob,Grep,Edit(//workspace/project/**),Write(//workspace/project/**),Bash"
                    .into(),
            ]);
        }
        ClaudePermission::VmFullAccess => args.extend([
            "--permission-mode".into(),
            "bypassPermissions".into(),
            "--dangerously-skip-permissions".into(),
        ]),
    }
    args.extend(["--settings".into(), settings.to_string()]);
    if let Some(id) = &request.session_id {
        args.extend(["--resume".into(), id.clone()]);
    }
    if let Some(model) = &request.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &request.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    if let Some(instructions) = &request.developer_instructions {
        args.extend(["--append-system-prompt".into(), instructions.clone()]);
    }
    json!({"args":args,"prompt":request.prompt})
}

/// Owns the entire guest process group. SSH EOF, cancellation, timeout, or excess output stops it.
/// The environment is an allowlist assembled here, never the invoking shell's environment.
pub(crate) const GUEST_BOOTSTRAP: &str = r#"
import json, os, select, signal, subprocess, sys, threading, time
child = None
stopped = False
MAX_FRAME = 2097152
MAX_OUTPUT = 67108864
DEADLINE_SECONDS = 1800
def report(status, **values):
    print(json.dumps(dict(type='openbotTransport', status=status, **values)), flush=True)
def stop():
    global stopped
    if child is None or stopped: return
    stopped = True
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=0.5)
    except subprocess.TimeoutExpired: pass
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: child.wait(timeout=1)
    except subprocess.TimeoutExpired: pass
def interrupted(signum, frame): raise KeyboardInterrupt()
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(sig, interrupted)
try:
    first = bytearray()
    while not first.endswith(b'\n'):
        part = os.read(0, 1)
        if not part: raise RuntimeError()
        first.extend(part)
        if len(first) > MAX_FRAME: raise RuntimeError()
    request = json.loads(first)
    if set(request) != {'args','prompt'} or not isinstance(request['prompt'], str): raise RuntimeError()
    env = {'PATH':'/opt/openbot/node/bin:/opt/openbot/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
           'LANG':'C.UTF-8','CLAUDE_CONFIG_DIR':'/workspace/.openbot/claude',
           'DISABLE_AUTOUPDATER':'1','DISABLE_TELEMETRY':'1','DISABLE_ERROR_REPORTING':'1'}
    child = subprocess.Popen(['/opt/openbot/tools/node_modules/.bin/claude'] + request['args'],
        cwd='/workspace/project', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True)
    def prompt():
        try:
            child.stdin.write(request['prompt'].encode('utf-8'))
            child.stdin.close()
        except (BrokenPipeError, OSError): pass
    threading.Thread(target=prompt, daemon=True).start()
    deadline = time.monotonic() + DEADLINE_SECONDS
    pipes = {child.stdout.fileno():True, child.stderr.fileno():False}
    control = bytearray()
    total = 0
    while pipes or child.poll() is None:
        # A CLI exit must not leave background tools holding its output pipes open.
        if child.poll() is not None: stop()
        if time.monotonic() >= deadline:
            stop(); report('timeout'); break
        ready, _, _ = select.select([0] + list(pipes), [], [], 0.1)
        for fd in ready:
            chunk = os.read(fd, 65536)
            if fd == 0:
                if not chunk:
                    stop(); report('cancelled'); pipes.clear(); break
                control.extend(chunk)
                if len(control) > 4096: raise RuntimeError()
                if b'\n' in control:
                    if json.loads(control) != {'cancel':True}: raise RuntimeError()
                    stop(); report('cancelled'); pipes.clear(); break
            elif not chunk: del pipes[fd]
            else:
                total += len(chunk)
                if total > MAX_OUTPUT: raise RuntimeError()
                if pipes[fd]: sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
    if pipes == {} and child.poll() is not None:
        stop(); report('exited', code=child.returncode)
except (Exception, KeyboardInterrupt):
    stop(); report('failed')
finally:
    stop()
"#;

type WriteMessage = (Vec<u8>, mpsc::SyncSender<Result<(), ()>>);
struct Process {
    child: Child,
    writer: mpsc::SyncSender<WriteMessage>,
    events: mpsc::Receiver<Result<Value, String>>,
}
impl Process {
    fn spawn(mut command: Command) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Could not start Claude Code in this VM.")?;
        let mut input = child
            .stdin
            .take()
            .ok_or("Claude Code input is unavailable.")?;
        let output = child
            .stdout
            .take()
            .ok_or("Claude Code output is unavailable.")?;
        let mut errors = child
            .stderr
            .take()
            .ok_or("Claude Code diagnostics are unavailable.")?;
        let (writer, writes) = mpsc::sync_channel::<WriteMessage>(2);
        thread::spawn(move || {
            while let Ok((bytes, ack)) = writes.recv() {
                let result = input
                    .write_all(&bytes)
                    .and_then(|_| input.flush())
                    .map_err(|_| ());
                let failed = result.is_err();
                let _ = ack.send(result);
                if failed {
                    break;
                }
            }
        });
        let (events, receive) = mpsc::sync_channel(8);
        let error_events = events.clone();
        thread::spawn(move || {
            let mut output = BufReader::new(output);
            let mut total = 0;
            loop {
                let mut line = Vec::new();
                match output
                    .by_ref()
                    .take((MAX_FRAME + 1) as u64)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) => break,
                    Ok(_) => (),
                    Err(_) => {
                        let _ = events.send(Err("Claude Code output could not be read.".into()));
                        return;
                    }
                }
                total += line.len();
                let parsed = if line.len() > MAX_FRAME || total > MAX_OUTPUT {
                    Err("Claude Code exceeded its output limit.".into())
                } else {
                    serde_json::from_slice(&line)
                        .map_err(|_| "Claude Code returned an invalid stream frame.".into())
                };
                let failed = parsed.is_err();
                if events.send(parsed).is_err() || failed {
                    return;
                }
            }
        });
        thread::spawn(move || {
            let mut total = 0;
            let mut buffer = [0u8; 8192];
            while let Ok(size) = errors.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                total += size;
                if total > MAX_OUTPUT {
                    let _ = error_events.send(Err(
                        "Claude Code exceeded its diagnostic output limit.".into(),
                    ));
                    break;
                }
            }
        });
        Ok(Self {
            child,
            writer,
            events: receive,
        })
    }
    fn send(&self, value: Value, deadline: Instant) -> Result<(), String> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| "Could not prepare Claude Code input.")?;
        bytes.push(b'\n');
        if bytes.len() > MAX_FRAME {
            return Err("Claude Code input is too large.".into());
        }
        let (ack, receive) = mpsc::sync_channel(1);
        self.writer
            .try_send((bytes, ack))
            .map_err(|_| "Claude Code input is unavailable.")?;
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(3));
        receive
            .recv_timeout(timeout)
            .map_err(|_| "Claude Code stopped accepting input.")?
            .map_err(|_| "Claude Code input disconnected.".into())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Transcript {
    session: Option<String>,
    message: Option<String>,
    items: HashMap<String, String>,
    text: String,
    success: bool,
}
impl Transcript {
    fn session(
        &mut self,
        frame: &Value,
        emit: &mut impl FnMut(ClaudeTurnEvent),
    ) -> Result<(), String> {
        let Some(id) = frame.get("session_id").and_then(Value::as_str) else {
            return Ok(());
        };
        if !valid_session(id)
            || self
                .session
                .as_deref()
                .is_some_and(|expected| expected != id)
        {
            return Err("Claude Code returned a different or invalid session.".into());
        }
        if self.session.is_none() {
            self.session = Some(id.into());
            emit(ClaudeTurnEvent::Started {
                session_id: id.into(),
            });
        }
        Ok(())
    }
    fn append(
        &mut self,
        id: &str,
        raw: &str,
        emit: &mut impl FnMut(ClaudeTurnEvent),
    ) -> Result<(), String> {
        if raw.is_empty() {
            return Ok(());
        }
        if id.is_empty() || id.len() > 256 {
            return Err("Claude Code returned an invalid message identifier.".into());
        }
        let session_id = self
            .session
            .clone()
            .ok_or("Claude Code omitted its session identifier.")?;
        let mut delta = String::new();
        if !self.text.is_empty() && !self.items.contains_key(id) {
            let trailing = self
                .text
                .chars()
                .rev()
                .take_while(|c| *c == '\n')
                .take(2)
                .count();
            let leading = raw.chars().take_while(|c| *c == '\n').take(2).count();
            delta.push_str(&"\n".repeat(2usize.saturating_sub(trailing + leading)));
        }
        delta.push_str(raw);
        if self.text.len() + delta.len() > MAX_TEXT {
            return Err("Claude Code exceeded the assistant output limit.".into());
        }
        self.items.entry(id.into()).or_default().push_str(raw);
        self.text.push_str(&delta);
        emit(ClaudeTurnEvent::AssistantDelta {
            session_id,
            message_id: id.into(),
            delta,
        });
        Ok(())
    }
    fn frame(
        &mut self,
        frame: Value,
        emit: &mut impl FnMut(ClaudeTurnEvent),
    ) -> Result<Option<i32>, String> {
        if frame["type"].as_str() == Some("openbotTransport") {
            return match frame["status"].as_str() {
                Some("exited") => frame["code"]
                    .as_i64()
                    .and_then(|n| i32::try_from(n).ok())
                    .map(Some)
                    .ok_or("Claude Code returned an invalid exit status.".into()),
                Some("cancelled") => Err("Claude Code turn was cancelled.".into()),
                Some("timeout") => Err("Claude Code turn timed out.".into()),
                _ => Err("Claude Code could not run in this VM.".into()),
            };
        }
        // Subagent streams are not a second copy of the main assistant's response.
        if !frame["parent_tool_use_id"].is_null() {
            return Ok(None);
        }
        if frame["type"] == "result" && (frame["subtype"] != "success" || frame["is_error"] == true)
        {
            return Err("Claude Code could not finish this turn. Configure a supported Claude provider before trying again.".into());
        }
        self.session(&frame, emit)?;
        match frame["type"].as_str() {
            Some("stream_event") => {
                let event = &frame["event"];
                match event["type"].as_str() {
                    Some("message_start") => {
                        self.message = event["message"]["id"].as_str().map(str::to_owned);
                    }
                    Some("content_block_delta") if event["delta"]["type"].as_str() == Some("text_delta") => {
                        let id = self.message.clone().ok_or("Claude Code omitted its message start.")?;
                        let delta = event["delta"]["text"].as_str().ok_or("Claude Code returned an invalid text delta.")?;
                        self.append(&id, delta, emit)?;
                    }
                    _ => (),
                }
            }
            Some("assistant") => {
                let id = frame["message"]["id"].as_str().ok_or("Claude Code omitted its message identifier.")?;
                let content = frame["message"]["content"].as_array().ok_or("Claude Code returned invalid assistant content.")?;
                let full: String = content.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect();
                let raw = self.items.get(id).map(String::as_str).unwrap_or("");
                let remaining = full.strip_prefix(raw).ok_or("Claude Code returned conflicting assistant content.")?.to_owned();
                self.append(id, &remaining, emit)?;
            }
            Some("result") => {
                if frame["subtype"].as_str() != Some("success") || frame["is_error"].as_bool() == Some(true) {
                    return Err("Claude Code could not finish this turn. Configure a supported Claude provider before trying again.".into());
                }
                if self.success { return Err("Claude Code returned more than one result.".into()); }
                if self.text.is_empty() {
                    if let Some(text) = frame["result"].as_str() { self.append("result", text, emit)?; }
                }
                self.success = true;
            }
            Some("control_request") => return Err("Claude Code requested an interactive action that this coding Bot cannot handle yet.".into()),
            _ => (),
        }
        Ok(None)
    }
}

pub(crate) fn turn(
    command: Command,
    request: ClaudeTurnRequest,
    cancellation: ClaudeCancellation,
    mut emit: impl FnMut(ClaudeTurnEvent),
) -> Result<ClaudeTurnResult, String> {
    turn_with_timeout(command, request, cancellation, &mut emit, TURN_TIMEOUT)
}
fn turn_with_timeout(
    command: Command,
    request: ClaudeTurnRequest,
    cancellation: ClaudeCancellation,
    emit: &mut impl FnMut(ClaudeTurnEvent),
    timeout: Duration,
) -> Result<ClaudeTurnResult, String> {
    let mut transcript = Transcript::default();
    let result: Result<ClaudeTurnResult, String> = (|| {
        validate(&request)?;
        if cancellation.cancelled() {
            return Err("Claude Code turn was cancelled.".into());
        }
        let expected = request.session_id.clone();
        let process = Process::spawn(command)?;
        let deadline = Instant::now() + timeout;
        process.send(launch_frame(&request), deadline)?;
        let mut cancelled_at = None;
        loop {
            if cancellation.cancelled() && cancelled_at.is_none() {
                cancelled_at = Some(Instant::now());
                process.send(json!({"cancel":true}), deadline)?;
            }
            if Instant::now() >= deadline {
                return Err("Claude Code turn timed out.".into());
            }
            if cancelled_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(3)) {
                return Err("Claude Code turn was cancelled.".into());
            }
            match process.events.recv_timeout(Duration::from_millis(100)) {
                Ok(frame) => {
                    let code = transcript.frame(frame?, emit)?;
                    if expected.as_ref().is_some_and(|id| {
                        transcript
                            .session
                            .as_ref()
                            .is_some_and(|actual| actual != id)
                    }) {
                        return Err("Claude Code resumed a different session.".into());
                    }
                    if let Some(code) = code {
                        if cancellation.cancelled() {
                            return Err("Claude Code turn was cancelled.".into());
                        }
                        if code != 0 || !transcript.success {
                            return Err("Claude Code exited before completing this turn. Configure a supported Claude provider and try again.".into());
                        }
                        let session_id = transcript
                            .session
                            .clone()
                            .ok_or("Claude Code omitted its session identifier.")?;
                        emit(ClaudeTurnEvent::Completed {
                            session_id: session_id.clone(),
                        });
                        return Ok(ClaudeTurnResult {
                            session_id,
                            text: transcript.text.clone(),
                        });
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Claude Code disconnected before completing this turn.".into())
                }
            }
        }
    })();
    if let Err(message) = &result {
        if cancellation.cancelled() {
            emit(ClaudeTurnEvent::Cancelled {
                session_id: transcript.session,
            });
        } else {
            emit(ClaudeTurnEvent::Failed {
                message: message.clone(),
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "01234567-89ab-4cde-8fab-0123456789ab";
    fn request() -> ClaudeTurnRequest {
        ClaudeTurnRequest {
            prompt: "Inspect this project.".into(),
            session_id: None,
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            permission: ClaudePermission::ReadOnly,
            developer_instructions: Some("Keep changes local.".into()),
        }
    }
    fn fake(mode: &str) -> Command {
        let mut command = Command::new("python3");
        command.args(["-u","-c",r#"
import json, sys
mode = sys.argv[1]
request = json.loads(sys.stdin.readline())
args = request['args']
assert '--bare' in args and '--strict-mcp-config' in args
assert args[args.index('--output-format')+1] == 'stream-json'
assert args[args.index('--model')+1] == 'sonnet'
assert args[args.index('--effort')+1] == 'high'
assert args[args.index('--append-system-prompt')+1] == 'Keep changes local.'
assert request['prompt'] == 'Inspect this project.'
session = '01234567-89ab-4cde-8fab-0123456789ab'
if mode == 'resume': assert args[args.index('--resume')+1] == session
def event(kind, **fields): print(json.dumps(dict(type=kind,session_id=session,**fields)),flush=True)
if mode == 'oversized':
    print('x' * 2097153, flush=True)
    sys.stdin.read()
    raise SystemExit()
if mode == 'malformed':
    print('not JSON',flush=True)
    sys.stdin.read()
    raise SystemExit()
event('system', subtype='init')
if mode == 'timeout':
    sys.stdin.read()
    raise SystemExit()
event('stream_event',event={'type':'message_start','message':{'id':'message-1'}})
event('stream_event',event={'type':'content_block_delta','delta':{'type':'text_delta','text':'Hello'}})
if mode == 'cancel':
    assert json.loads(sys.stdin.readline()) == {'cancel':True}
    print(json.dumps({'type':'openbotTransport','status':'cancelled'}),flush=True)
    sys.stdin.read()
    raise SystemExit()
if mode == 'foreign-session':
    session = 'ffffffff-89ab-4cde-8fab-0123456789ab'
    event('system',subtype='init')
event('stream_event',parent_tool_use_id='subagent-call',event={'type':'content_block_delta','delta':{'type':'text_delta','text':'subagent must not leak'}})
event('stream_event',event={'type':'content_block_delta','delta':{'type':'text_delta','text':' world'}})
for unused in range(2): event('assistant',message={'id':'message-1','content':[{'type':'text','text':'Hello world'}]})
# Fallback assistant without deltas; duplicate completion must not duplicate its text.
for unused in range(2): event('assistant',message={'id':'message-2','content':[{'type':'text','text':'Final answer.'}]})
if mode != 'truncated': event('result',subtype='error_during_execution' if mode=='failure' else 'success',is_error=(mode=='failure'),result='Final answer.',errors=['synthetic-provider-secret'])
sys.stderr.write('synthetic-provider-secret')
print(json.dumps({'type':'openbotTransport','status':'exited','code':7 if mode=='exit-failure' else 0}),flush=True)
sys.stdin.read()
"#,mode]);
        command
    }
    #[test]
    fn streams_paragraphs_deduplicates_replays_and_resumes_with_explicit_settings() {
        for mode in ["success", "resume"] {
            let mut input = request();
            if mode == "resume" {
                input.session_id = Some(SESSION.into());
            }
            let mut events = Vec::new();
            let result = turn(fake(mode), input, ClaudeCancellation::default(), |event| {
                events.push(event)
            })
            .unwrap();
            assert_eq!(result.session_id, SESSION);
            assert_eq!(result.text, "Hello world\n\nFinal answer.");
            let deltas: Vec<_> = events
                .iter()
                .filter_map(|event| {
                    if let ClaudeTurnEvent::AssistantDelta { delta, .. } = event {
                        Some(delta.as_str())
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(deltas, ["Hello", " world", "\n\nFinal answer."]);
            assert_eq!(deltas.concat(), result.text);
            assert!(matches!(
                events.first(),
                Some(ClaudeTurnEvent::Started { .. })
            ));
            assert!(matches!(
                events.last(),
                Some(ClaudeTurnEvent::Completed { .. })
            ));
        }
    }
    #[test]
    fn cancellation_is_not_completion_and_interrupts_silent_timeout() {
        let cancellation = ClaudeCancellation::default();
        let mut events = Vec::new();
        let started = Instant::now();
        assert!(
            turn(fake("cancel"), request(), cancellation.clone(), |event| {
                if matches!(event, ClaudeTurnEvent::AssistantDelta { .. }) {
                    cancellation.cancel();
                }
                events.push(event);
            })
            .unwrap_err()
            .contains("cancelled")
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(matches!(
            events.last(),
            Some(ClaudeTurnEvent::Cancelled { .. })
        ));
        assert!(!events
            .iter()
            .any(|event| matches!(event, ClaudeTurnEvent::Completed { .. })));
        let mut events = Vec::new();
        assert!(turn_with_timeout(
            fake("timeout"),
            request(),
            ClaudeCancellation::default(),
            &mut |event| events.push(event),
            Duration::from_millis(150)
        )
        .unwrap_err()
        .contains("timed out"));
        assert!(matches!(
            events.last(),
            Some(ClaudeTurnEvent::Failed { .. })
        ));
    }
    #[test]
    fn failures_and_untrusted_output_are_bounded_and_never_report_success_or_raw_errors() {
        for mode in [
            "failure",
            "truncated",
            "foreign-session",
            "exit-failure",
            "malformed",
            "oversized",
        ] {
            let mut events = Vec::new();
            let error = turn(
                fake(mode),
                request(),
                ClaudeCancellation::default(),
                |event| events.push(event),
            )
            .unwrap_err();
            assert!(!error.contains("synthetic-provider-secret"), "{mode}");
            assert!(
                matches!(events.last(), Some(ClaudeTurnEvent::Failed { .. })),
                "{mode}"
            );
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, ClaudeTurnEvent::Completed { .. })),
                "{mode}"
            );
        }
    }
    #[test]
    fn permission_profiles_and_requests_do_not_silently_expand_authority() {
        let mut input = request();
        for mode in [
            ClaudePermission::ReadOnly,
            ClaudePermission::WorkspaceWrite,
            ClaudePermission::VmFullAccess,
        ] {
            input.permission = mode;
            let frame = launch_frame(&input);
            let args = frame["args"].as_array().unwrap();
            let strings: Vec<_> = args.iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(
                strings.contains(&"--dangerously-skip-permissions"),
                mode == ClaudePermission::VmFullAccess
            );
            let settings: Value = serde_json::from_str(
                strings[strings.iter().position(|v| *v == "--settings").unwrap() + 1],
            )
            .unwrap();
            assert_eq!(settings["disableAllHooks"], true);
            if mode == ClaudePermission::WorkspaceWrite {
                assert_eq!(settings["sandbox"]["enabled"], true);
                assert_eq!(settings["sandbox"]["failIfUnavailable"], true);
                assert_eq!(settings["sandbox"]["allowUnsandboxedCommands"], false);
                assert!(strings.contains(&"Read,Glob,Grep,Edit(//workspace/project/**),Write(//workspace/project/**),Bash"));
            }
            if mode == ClaudePermission::ReadOnly {
                assert!(strings.contains(&"Read,Glob,Grep"));
            }
        }
        input.session_id = Some("/some/session.jsonl".into());
        assert!(validate(&input).is_err());
        input.session_id = None;
        input.model = Some("--resume".into());
        assert!(validate(&input).is_err());
        assert!(serde_json::from_value::<ClaudeTurnRequest>(
            json!({"prompt":"x","permission":"read-only","accessToken":"forbidden"})
        )
        .is_err());
    }
    #[test]
    fn output_limit_includes_item_boundaries_and_cancelled_requests_do_not_spawn() {
        let mut transcript = Transcript {
            session: Some(SESSION.into()),
            text: "x".repeat(MAX_TEXT - 2),
            ..Default::default()
        };
        assert!(transcript.append("new", "y", &mut |_| {}).is_err());
        assert_eq!(transcript.text.len(), MAX_TEXT - 2);
        let cancellation = ClaudeCancellation::default();
        cancellation.cancel();
        let mut missing = Command::new("/this/executable/must/not/run");
        missing.arg("never");
        let mut events = Vec::new();
        assert!(
            turn(missing, request(), cancellation, |event| events.push(event))
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(matches!(
            events.last(),
            Some(ClaudeTurnEvent::Cancelled { session_id: None })
        ));
    }

    #[cfg(unix)]
    fn fixture() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "openbot-claude-supervisor-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[cfg(unix)]
    fn supervised_fixture(root: &std::path::Path) -> Command {
        use std::os::unix::fs::PermissionsExt;
        let script = root.join("fake-claude");
        std::fs::write(&script,format!(r#"#!/usr/bin/python3
import json, os, subprocess, sys, time
assert not any(key in os.environ for key in ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','SSH_AUTH_SOCK','OPENBOT_TEST_SECRET'])
assert '--bare' in sys.argv
prompt=sys.stdin.read()
session='{SESSION}'
def event(kind,**fields): print(json.dumps(dict(type=kind,session_id=session,**fields)),flush=True)
event('system',subtype='init')
if prompt in ['cancel descendants', 'exit descendants', 'close streams']:
    descendant=subprocess.Popen(['/usr/bin/python3','-c','import time;time.sleep(120)'], stdout=subprocess.DEVNULL if prompt=='close streams' else None, stderr=subprocess.DEVNULL if prompt=='close streams' else None)
    with open({pid_path:?},'w') as record: json.dump([os.getpid(),descendant.pid],record)
    event('stream_event',event={{'type':'message_start','message':{{'id':'ready'}}}})
    event('stream_event',event={{'type':'content_block_delta','delta':{{'type':'text_delta','text':'Ready'}}}})
    if prompt=='exit descendants': event('result',subtype='success',is_error=False,result='Ready')
    else:
        if prompt=='close streams':
            os.close(1); os.close(2)
        time.sleep(120)
else:
    event('result',subtype='success',is_error=False,result='Clean environment.')
"#,pid_path=root.join("pids.json").to_str().unwrap())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let bootstrap = GUEST_BOOTSTRAP
            .replace(
                "'/opt/openbot/tools/node_modules/.bin/claude'",
                &serde_json::to_string(script.to_str().unwrap()).unwrap(),
            )
            .replace(
                "cwd='/workspace/project'",
                &format!(
                    "cwd={}",
                    serde_json::to_string(root.to_str().unwrap()).unwrap()
                ),
            )
            .replace(
                "'/workspace/.openbot/claude'",
                &serde_json::to_string(root.join("config").to_str().unwrap()).unwrap(),
            );
        let mut command = Command::new("python3");
        command.args(["-u", "-c", &bootstrap]);
        command
            .env("ANTHROPIC_API_KEY", "synthetic-key-never-forward")
            .env("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-token-never-forward")
            .env("OPENBOT_TEST_SECRET", "synthetic-secret");
        command
    }
    #[cfg(unix)]
    #[test]
    fn guest_supervisor_clears_credential_environment_and_creates_no_auth_file() {
        let root = fixture();
        let result = turn(
            supervised_fixture(&root),
            request(),
            ClaudeCancellation::default(),
            |_| {},
        )
        .unwrap();
        assert_eq!(result.text, "Clean environment.");
        assert!(!root.join("config").exists());
        assert!(!root.join("auth.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn guest_supervisor_does_not_let_background_tools_hold_a_finished_turn_open() {
        let root = fixture();
        let mut input = request();
        input.prompt = "exit descendants".into();
        let started = Instant::now();
        let result = turn_with_timeout(
            supervised_fixture(&root),
            input,
            ClaudeCancellation::default(),
            &mut |_| {},
            Duration::from_secs(3),
        )
        .unwrap();
        assert_eq!(result.text, "Ready");
        assert!(started.elapsed() < Duration::from_secs(2));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn guest_supervisor_observes_cancel_and_ssh_eof_after_cli_closes_output() {
        for eof in [false, true] {
            let root = fixture();
            let mut input = request();
            input.prompt = "close streams".into();
            let started = Instant::now();
            if eof {
                let mut command = supervised_fixture(&root);
                let mut child = command
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let mut stdin = child.stdin.take().unwrap();
                serde_json::to_writer(&mut stdin, &launch_frame(&input)).unwrap();
                stdin.write_all(b"\n").unwrap();
                stdin.flush().unwrap();
                let mut output = BufReader::new(child.stdout.take().unwrap());
                for _ in 0..3 {
                    let mut line = String::new();
                    assert!(output.read_line(&mut line).unwrap() > 0);
                }
                drop(stdin);
                let deadline = Instant::now() + Duration::from_secs(3);
                while child.try_wait().unwrap().is_none() {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        panic!("SSH EOF did not stop guest supervisor");
                    }
                    thread::sleep(Duration::from_millis(20));
                }
            } else {
                let cancellation = ClaudeCancellation::default();
                assert!(turn(
                    supervised_fixture(&root),
                    input,
                    cancellation.clone(),
                    |event| {
                        if matches!(event, ClaudeTurnEvent::AssistantDelta { .. }) {
                            cancellation.cancel();
                        }
                    }
                )
                .unwrap_err()
                .contains("cancelled"));
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn guest_supervisor_cancellation_reaps_cli_and_stops_descendants() {
        let root = fixture();
        let mut input = request();
        input.prompt = "cancel descendants".into();
        let cancellation = ClaudeCancellation::default();
        assert!(turn(
            supervised_fixture(&root),
            input,
            cancellation.clone(),
            |event| {
                if matches!(event, ClaudeTurnEvent::AssistantDelta { .. }) {
                    cancellation.cancel();
                }
            }
        )
        .is_err());
        let pids: Vec<u32> =
            serde_json::from_slice(&std::fs::read(root.join("pids.json")).unwrap()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let living = pids.iter().any(|pid| {
                let result = Command::new("ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .unwrap();
                let state = String::from_utf8_lossy(&result.stdout);
                result.status.success()
                    && !state.trim().is_empty()
                    && !state.trim().starts_with('Z')
            });
            if !living {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "guest supervisor left a fixture process running"
            );
            thread::sleep(Duration::from_millis(20));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
