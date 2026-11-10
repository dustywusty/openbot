//! Native project VMs. This crate opens no HTTP listener and holds no model credential.
//! The desktop calls it directly; the development CLI exercises the same implementation.
mod claude;
mod codex;
mod lima;
mod recipe;
mod services;
mod skills;
mod usage;
pub use claude::{
    ClaudeCancellation, ClaudePermission, ClaudeTurnEvent, ClaudeTurnRequest, ClaudeTurnResult,
};
pub use codex::{
    CodexCancellation, CodexModel, CodexPermission, CodexProviderAuth, CodexReasoningEffort,
    CodexServiceTier, CodexTurnEvent, CodexTurnRequest, CodexTurnResult,
};
pub use recipe::{BaseImage, CodingTools, PreviewPort, Recipe, Resources};
pub use services::ListeningPort;
pub use skills::SkillSnapshot;
pub use usage::{
    CodexUsageAdapter, DailyUsage, ServiceUsage, TokenActivity, UsageProvider, UsageReason,
    UsageState, UsageWindow,
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

pub const PROJECT_PATH: &str = "/workspace/project";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub workspace_id: String,
    pub stage: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Created,
    Starting,
    Packages,
    Source,
    Setup,
    Verify,
    Ready,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub recipe: Recipe,
    pub phase: Phase,
    pub completed: Vec<String>,
    pub problem: Option<String>,
    pub created_at: u64,
}

pub struct Manager {
    root: PathBuf,
    executable: PathBuf,
}

struct OperationLock(File);
impl Drop for OperationLock {
    fn drop(&mut self) {
        // Release explicitly: another thread may briefly fork a subprocess while this file
        // is open. Its close-on-exec descriptor must not extend the operation's lock lifetime.
        let _ = FileExt::unlock(&self.0);
    }
}

/// Keep this guard alive for a guest command or interactive shell's entire process lifetime.
pub struct WorkspaceUseGuard(File);
impl Drop for WorkspaceUseGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", rand::random::<u64>()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn default_root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        std::env::var_os("HOME").ok_or("This computer's home folder is unavailable.")?,
    )
    .join(".openbot/workspaces"))
}

impl Manager {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        private_directory(&root)?;
        private_directory(&root.join("records"))?;
        private_directory(&root.join("vms"))?;
        Ok(Self {
            root,
            executable: lima::executable(),
        })
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if !id.starts_with("obw-")
            || id.len() != 20
            || !id[4..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid workspace id.".into());
        }
        Ok(self.root.join("records").join(id))
    }
    fn lock(&self, id: &str) -> Result<OperationLock, String> {
        let path = self.path(id)?;
        if !path.is_dir() {
            return Err("Workspace not found.".into());
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.join("operation.lock"))
            .map_err(|error| error.to_string())?;
        file.try_lock_exclusive()
            .map_err(|_| "This workspace already has an operation in progress.".to_owned())?;
        Ok(OperationLock(file))
    }
    fn usage_file(&self, id: &str) -> Result<File, String> {
        let path = self.path(id)?;
        if !path.is_dir() {
            return Err("VM not found.".into());
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(path.join("usage.lock"))
            .map_err(|error| error.to_string())
    }
    pub fn acquire_usage(&self, id: &str) -> Result<WorkspaceUseGuard, String> {
        let file = self.usage_file(id)?;
        FileExt::try_lock_shared(&file).map_err(|_| {
            "This VM is being deleted. Wait for that operation to finish.".to_owned()
        })?;
        let guard = WorkspaceUseGuard(file);
        // Recheck after acquiring: a deletion may have removed a previously opened record.
        self.get(id)?;
        Ok(guard)
    }
    fn save(&self, workspace: &Workspace) -> Result<(), String> {
        write_private(
            &self.path(&workspace.id)?.join("workspace.json"),
            &serde_json::to_vec_pretty(workspace).map_err(|error| error.to_string())?,
        )
    }
    pub fn get(&self, id: &str) -> Result<Workspace, String> {
        let bytes = fs::read(self.path(id)?.join("workspace.json"))
            .map_err(|_| "Workspace not found.".to_owned())?;
        let workspace: Workspace = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read this workspace: {error}"))?;
        if workspace.id != id {
            return Err("This workspace's saved id does not match its folder.".into());
        }
        workspace.recipe.validate()?;
        Ok(workspace)
    }
    pub fn list(&self) -> Result<Vec<Workspace>, String> {
        let mut workspaces = Vec::new();
        for entry in fs::read_dir(self.root.join("records")).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                let id = entry.file_name().to_string_lossy().into_owned();
                workspaces.push(self.get(&id)?);
            }
        }
        workspaces.sort_by_key(|workspace| workspace.created_at);
        Ok(workspaces)
    }
    pub fn create(&self, recipe: Recipe) -> Result<Workspace, String> {
        recipe.validate()?;
        let id = format!("obw-{:016x}", rand::random::<u64>());
        let directory = self.path(&id)?;
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        private_directory(&directory)?;
        let workspace = Workspace {
            id,
            recipe,
            phase: Phase::Created,
            completed: vec![],
            problem: None,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_secs(),
        };
        self.save(&workspace)?;
        Ok(workspace)
    }
    pub fn prerequisites(&self) -> Result<String, String> {
        if !cfg!(target_os = "macos") {
            return Err("Project VMs currently require macOS. Other execution targets are not implemented yet.".into());
        }
        let output = self
            .command()
            .arg("--version")
            .output()
            .map_err(|_| "Install Lima 2.3 or newer to create project VMs.".to_owned())?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let number = version
            .split_whitespace()
            .last()
            .unwrap_or_default()
            .trim_start_matches('v');
        let parts = number
            .split('.')
            .take(2)
            .filter_map(|part| part.parse::<u32>().ok())
            .collect::<Vec<_>>();
        if !output.status.success()
            || parts.len() < 2
            || parts[0] < 2
            || (parts[0] == 2 && parts[1] < 3)
        {
            return Err("Install Lima 2.3 or newer to create project VMs.".into());
        }
        Ok(version)
    }
    fn command(&self) -> Command {
        lima::command(&self.root, &self.executable)
    }
    pub fn vm_status(&self, id: &str) -> Result<String, String> {
        self.get(id)?;
        let output = self
            .command()
            .args(["list", "--json"])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Could not read the VM's status: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        for line in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let value: serde_json::Value =
                serde_json::from_str(line).map_err(|error| error.to_string())?;
            if value["name"].as_str() == Some(id) {
                return Ok(value["status"].as_str().unwrap_or("Unknown").into());
            }
        }
        Ok("Not created".into())
    }
    pub fn logs(&self, id: &str) -> Result<String, String> {
        self.get(id)?;
        let path = self.path(id)?.join("setup.log");
        let bytes = fs::read(path).unwrap_or_default();
        // The UI gets the tail, never an unbounded history.
        Ok(String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(256 * 1024)..]).into_owned())
    }
    fn event(&self, id: &str, stage: &str, message: &str, emit: &mut impl FnMut(Event)) {
        let event = Event {
            workspace_id: id.into(),
            stage: stage.into(),
            message: message.into(),
        };
        if let Ok(path) = self.path(id) {
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            if let Ok(mut log) = options.open(path.join("setup.log")) {
                let _ = writeln!(log, "[{stage}] {message}");
            }
        }
        emit(event);
    }
    fn run(
        &self,
        workspace: &Workspace,
        stage: &str,
        command: Command,
        script: Option<&str>,
        emit: &mut impl FnMut(Event),
    ) -> Result<(), String> {
        lima::run(command, script, &workspace.id, stage, &mut |event| {
            self.event(&event.workspace_id, &event.stage, &event.message, emit)
        })
    }
    fn guest_script(&self, id: &str) -> Command {
        let mut command = self.command();
        command.args([
            "shell",
            "--preserve-env=false",
            "--workdir=/",
            id,
            "--",
            "bash",
            "-se",
        ]);
        command
    }
    pub fn prepare(&self, id: &str, mut emit: impl FnMut(Event)) -> Result<Workspace, String> {
        let _lock = self.lock(id)?;
        self.prerequisites()?;
        let mut workspace = self.get(id)?;
        let result = (|| -> Result<(), String> {
            workspace.phase = Phase::Starting;
            workspace.problem = None;
            self.save(&workspace)?;
            self.event(
                id,
                "starting",
                "Starting the project VM. No host folders or account files are mounted.",
                &mut emit,
            );
            if self.vm_status(id)? == "Not created" {
                let template_path = self.path(id)?.join("lima.yaml");
                write_private(
                    &template_path,
                    lima::template(&workspace.recipe)?.as_bytes(),
                )?;
                let mut command = self.command();
                command
                    .args(["start", "--tty=false", "--name", id])
                    .arg(template_path);
                self.run(&workspace, "starting", command, None, &mut emit)?;
            } else {
                let mut command = self.command();
                command.args(["start", "--tty=false", id]);
                self.run(&workspace, "starting", command, None, &mut emit)?;
            }
            let mut stages = vec![
                (
                    "packages",
                    Phase::Packages,
                    recipe::install_script(&workspace.recipe),
                ),
                (
                    "source",
                    Phase::Source,
                    recipe::clone_script(&workspace.recipe),
                ),
            ];
            if !workspace.recipe.skills.is_empty() {
                stages.push((
                    "skills",
                    Phase::Source,
                    skills::install_script(&workspace.recipe.skills)?,
                ));
            }
            stages.extend([
                (
                    "setup",
                    Phase::Setup,
                    recipe::project_script(&workspace.recipe.setup),
                ),
                (
                    "verify",
                    Phase::Verify,
                    recipe::project_script(&workspace.recipe.verify),
                ),
            ]);
            for (stage, phase, script) in stages {
                if workspace.completed.iter().any(|done| done == stage) {
                    continue;
                }
                workspace.phase = phase;
                self.save(&workspace)?;
                self.event(id, stage, "Started.", &mut emit);
                self.run(
                    &workspace,
                    stage,
                    self.guest_script(id),
                    Some(&script),
                    &mut emit,
                )?;
                workspace.completed.push(stage.into());
                self.save(&workspace)?;
                self.event(id, stage, "Completed.", &mut emit);
            }
            workspace.phase = Phase::Ready;
            workspace.problem = None;
            self.save(&workspace)?;
            self.event(id, "ready", "The project workspace is ready.", &mut emit);
            Ok(())
        })();
        if let Err(error) = result {
            workspace.phase = Phase::Failed;
            workspace.problem = Some(error.clone());
            self.save(&workspace)?;
            self.event(id, "failed", &error, &mut emit);
            return Err(error);
        }
        Ok(workspace)
    }
    pub fn stop(&self, id: &str, mut emit: impl FnMut(Event)) -> Result<Workspace, String> {
        let _lock = self.lock(id)?;
        let mut workspace = self.get(id)?;
        let mut command = self.command();
        command.args(["stop", "--tty=false", id]);
        self.run(&workspace, "stopping", command, None, &mut emit)?;
        workspace.phase = Phase::Stopped;
        self.save(&workspace)?;
        Ok(workspace)
    }
    /// Delete exactly one local guest. A failed Lima operation always retains its saved record.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _operation = self.lock(id)?;
        let usage = self.usage_file(id)?;
        FileExt::try_lock_exclusive(&usage).map_err(|_| "Close this VM's terminals and wait for its active commands or coding turns to stop before deleting it.".to_owned())?;
        let _usage = WorkspaceUseGuard(usage);
        let mut workspace = self.get(id)?;
        let status = self.vm_status(id)?;
        if !["Running", "Stopped", "Not created"].contains(&status.as_str()) {
            return Err("Wait for this VM to finish changing state before deleting it.".into());
        }
        if status == "Running" {
            let mut command = self.command();
            command.args(["stop", "--tty=false", id]);
            self.run(&workspace, "deleting", command, None, &mut |_| {})?;
            if self.vm_status(id)? != "Stopped" {
                return Err("The VM did not stop. Its saved record was kept.".into());
            }
            workspace.phase = Phase::Stopped;
            self.save(&workspace)?;
        }
        if status != "Not created" {
            let mut command = self.command();
            command.args(["delete", "--force", id]);
            self.run(&workspace, "deleting", command, None, &mut |_| {})?;
            if self.vm_status(id)? != "Not created" {
                return Err("The VM was not deleted. Its saved record was kept.".into());
            }
        }
        let record = self.path(id)?;
        if let Err(error) = fs::remove_dir_all(&record) {
            // Keep the operation reviewable/retryable even if local metadata cleanup fails.
            private_directory(&record)?;
            self.save(&workspace)?;
            return Err(format!(
                "The VM was deleted, but its local record could not be removed: {error}"
            ));
        }
        Ok(())
    }
    /// Arguments are executed in the guest. This never invokes a host shell or accepts a host path.
    pub fn shell_command(&self, id: &str) -> Result<Command, String> {
        self.get(id)?;
        if self.vm_status(id)? != "Running" {
            return Err("Start this workspace before opening its shell.".into());
        }
        let mut command = self.command();
        let mut args = lima::shell_args(id);
        if !self
            .get(id)?
            .completed
            .iter()
            .any(|stage| stage == "source")
        {
            args[2] = "--workdir=/".into();
        }
        command.args(args);
        Ok(command)
    }
    /// Discover model, effort and speed choices from the installed guest Codex CLI.
    /// This makes no model request and does not access or copy desktop credentials.
    pub fn codex_models(&self, id: &str) -> Result<Vec<CodexModel>, String> {
        let _usage = self.acquire_usage(id)?;
        let mut command = self.shell_command(id)?;
        command.args(["/opt/openbot/tools/node_modules/.bin/codex", "app-server"]);
        codex::models(command)
    }
    /// Run one coding turn in the selected guest. Provider credentials stay in process memory.
    pub fn codex_turn(
        &self,
        id: &str,
        request: CodexTurnRequest,
        auth: Option<CodexProviderAuth>,
        cancellation: CodexCancellation,
        emit: impl FnMut(CodexTurnEvent),
    ) -> Result<CodexTurnResult, String> {
        let _usage = self.acquire_usage(id)?;
        let mut command = self.shell_command(id)?;
        command.args(["python3", "-u", "-c", codex::GUEST_BOOTSTRAP]);
        codex::turn(command, request, auth, cancellation, emit)
    }
    /// Guest-only Claude print-mode transport. Provider authentication is not connected yet.
    /// Bare mode never loads the user's existing Claude login or keychain credentials.
    pub fn claude_turn(
        &self,
        id: &str,
        request: ClaudeTurnRequest,
        cancellation: ClaudeCancellation,
        emit: impl FnMut(ClaudeTurnEvent),
    ) -> Result<ClaudeTurnResult, String> {
        let _usage = self.acquire_usage(id)?;
        let mut command = self.shell_command(id)?;
        command.args(["python3", "-u", "-c", claude::GUEST_BOOTSTRAP]);
        claude::turn(command, request, cancellation, emit)
    }
    pub fn execute(
        &self,
        id: &str,
        args: &[String],
        emit: &mut impl FnMut(Event),
    ) -> Result<(), String> {
        let _usage = self.acquire_usage(id)?;
        if args.is_empty() {
            return Err("Choose a guest command.".into());
        }
        let workspace = self.get(id)?;
        let mut command = self.shell_command(id)?;
        command.args(args);
        self.run(&workspace, "shell", command, None, emit)
    }
    pub fn ports(&self, id: &str) -> Result<Vec<ListeningPort>, String> {
        let _usage = self.acquire_usage(id)?;
        let workspace = self.get(id)?;
        let output = self
            .shell_command(id)?
            .args([
                "ss",
                "--no-header",
                "--listening",
                "--tcp",
                "--numeric",
                "--processes",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Could not read guest ports: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(services::parse(
            &String::from_utf8_lossy(&output.stdout),
            &workspace.recipe.ports,
        ))
    }
    /// An interactive shell for the native terminal or the development CLI.
    pub fn shell(&self, id: &str) -> Result<(), String> {
        let _usage = self.acquire_usage(id)?;
        let status = self
            .shell_command(id)?
            .arg("bash")
            .arg("--login")
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("The workspace shell ended with {status}."))
        }
    }
}

#[cfg(test)]
mod tests;
