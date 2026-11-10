//! A PTY for a workspace's guest shell. No host command or host path comes from the page.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Mutex, OnceLock},
};

struct Session {
    computer_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(Default::default)
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Output { bytes: Vec<u8> },
    Exit { code: u32 },
}

pub fn open(id: &str, on_event: tauri::ipc::Channel<Event>) -> Result<String, String> {
    let manager = openbot_workspaces::Manager::new(openbot_workspaces::default_root()?)?;
    let usage = manager.acquire_usage(id)?;
    let command = manager.shell_command(id)?;
    let mut builder = CommandBuilder::new(command.get_program());
    builder.env_clear();
    for (key, value) in command.get_envs() {
        if let Some(value) = value {
            builder.env(key, value);
        }
    }
    builder.args(command.get_args());
    builder.args(["bash", "--login"]);
    let mut entries = sessions()
        .lock()
        .map_err(|_| "The workspace terminal is unavailable.")?;
    if entries.len() >= 8 {
        return Err("Close a workspace terminal before opening another.".into());
    }
    let pair = native_pty_system()
        .openpty(PtySize::default())
        .map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let session = format!("wst-{:032x}", rand::random::<u128>());
    entries.insert(
        session.clone(),
        Session {
            computer_id: id.to_owned(),
            master: pair.master,
            writer,
            killer: child.clone_killer(),
        },
    );
    drop(entries);
    let read_session = session.clone();
    let read_events = on_event.clone();
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if read_events
                        .send(Event::Output {
                            bytes: bytes[..count].to_vec(),
                        })
                        .is_err()
                    {
                        let _ = close(&read_session);
                        break;
                    }
                }
            }
        }
    });
    let wait_session = session.clone();
    std::thread::spawn(move || {
        let _usage = usage;
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        if let Ok(mut sessions) = sessions().lock() {
            sessions.remove(&wait_session);
        }
        let _ = on_event.send(Event::Exit { code });
    });
    Ok(session)
}
pub fn active_for(id: &str) -> Result<bool, String> {
    Ok(sessions()
        .lock()
        .map_err(|_| "The VM terminal is unavailable.")?
        .values()
        .any(|session| session.computer_id == id))
}
pub fn write(session: &str, input: &str) -> Result<(), String> {
    if input.len() > 64 * 1024 {
        return Err("Terminal input is too large.".into());
    }
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "The workspace terminal is unavailable.")?;
    let session = sessions
        .get_mut(session)
        .ok_or("This terminal has closed.")?;
    session
        .writer
        .write_all(input.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| e.to_string())
}
pub fn resize(session: &str, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = sessions()
        .lock()
        .map_err(|_| "The workspace terminal is unavailable.")?;
    let session = sessions.get(session).ok_or("This terminal has closed.")?;
    session
        .master
        .resize(PtySize {
            rows: rows.clamp(2, 500),
            cols: cols.clamp(2, 500),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}
pub fn close(session: &str) -> Result<(), String> {
    let mut sessions = sessions()
        .lock()
        .map_err(|_| "The workspace terminal is unavailable.")?;
    if let Some(mut session) = sessions.remove(session) {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a running test VM named by OPENBOT_TEST_WORKSPACE"]
    fn native_pty_runs_in_the_guest_and_accepts_input_and_resize() {
        let id = std::env::var("OPENBOT_TEST_WORKSPACE").expect("Choose a running test workspace");
        let (sender, receiver) = std::sync::mpsc::channel();
        let events = tauri::ipc::Channel::<Event>::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let value: serde_json::Value = serde_json::from_str(&json).unwrap();
                if let Some(bytes) = value["bytes"].as_array() {
                    let _ = sender.send(
                        bytes
                            .iter()
                            .map(|byte| byte.as_u64().unwrap() as u8)
                            .collect::<Vec<_>>(),
                    );
                }
            }
            Ok(())
        });
        let session = open(&id, events).unwrap();
        resize(&session, 32, 100).unwrap();
        write(&session, "printf '\\nNATIVE_%s\\n' WORKSPACE_PTY_OK; uname -s; pwd; printf 'DONE_%s\\n' OPENBOT_PTY\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut output = Vec::new();
        while std::time::Instant::now() < deadline {
            if let Ok(bytes) = receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                output.extend(bytes);
            }
            if String::from_utf8_lossy(&output).contains("DONE_OPENBOT_PTY") {
                break;
            }
        }
        close(&session).unwrap();
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("NATIVE_WORKSPACE_PTY_OK"), "{output}");
        assert!(output.contains("Linux\r\n"), "{output}");
        assert!(output.contains("/workspace/project\r\n"), "{output}");
    }
}
