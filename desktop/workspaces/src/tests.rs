use super::*;

struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "openbot-native-workspace-{:016x}",
            rand::random::<u64>()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn recipe_accepts_project_configuration_and_rejects_credential_urls_and_shell_packages() {
    Recipe::openbot().validate().unwrap();
    for repository in [
        "file:///Users/person/project",
        "https://secret@github.com/project/repo",
        "https://github.com/repo?token=secret",
        "https://github.com/repo#credential",
        "https://github.com:443/repo",
    ] {
        let mut recipe = Recipe::openbot();
        recipe.repository = repository.into();
        assert!(recipe.validate().is_err());
    }
    for package in ["git; touch /host/file", "--option", "$(id)", "foo bar"] {
        let mut recipe = Recipe::openbot();
        recipe.packages.push(package.into());
        assert!(recipe.validate().is_err());
    }
    let mut recipe = Recipe::openbot();
    recipe.git_ref = "main;touch x".into();
    assert!(recipe.validate().is_err());
    let mut recipe = Recipe::openbot();
    recipe.resources.memory_gib = 0;
    assert!(recipe.validate().is_err());
    let mut recipe = Recipe::openbot();
    recipe.ports.push(recipe.ports[0].clone());
    assert!(recipe.validate().is_err());
}

#[test]
fn template_disables_host_sharing_and_only_forwards_explicit_loopback_previews() {
    let yaml = lima::template(&Recipe::openbot()).unwrap();
    for fragment in [
        "plain: true",
        "mounts: []",
        "forwardAgent: false",
        "loadDotSSHPubKeys: false",
        "propagateProxyEnv: false",
        "hostLoopback: false",
        "static: true",
        "hostIP: 127.0.0.1",
        "digest: \"sha512:",
        "debian-13-genericcloud-",
    ] {
        assert!(yaml.contains(fragment), "missing {fragment}");
    }
    assert!(!yaml.contains("location: \"~"));
    assert!(!yaml.contains("0.0.0.0"));
}

#[test]
fn recipes_and_status_survive_restart_with_private_permissions() {
    let temporary = Temporary::new();
    let manager = Manager::new(temporary.0.clone()).unwrap();
    let created = manager.create(Recipe::openbot()).unwrap();
    let restarted = Manager::new(temporary.0.clone()).unwrap();
    assert_eq!(created, restarted.get(&created.id).unwrap());
    assert_eq!(restarted.list().unwrap(), vec![created.clone()]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(manager.path(&created.id).unwrap().join("workspace.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&temporary.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}

#[test]
fn no_workspace_operation_accepts_a_host_path_or_an_unknown_workspace() {
    let temporary = Temporary::new();
    let manager = Manager::new(temporary.0.clone()).unwrap();
    for id in [
        "../host",
        "obw-../../../../host",
        "/etc/passwd",
        "--option",
        "obw-zzzzzzzzzzzzzzzz",
    ] {
        assert!(manager.get(id).is_err());
        assert!(manager.stop(id, |_| {}).is_err());
        assert!(manager.shell_command(id).is_err());
    }
}

#[test]
fn lock_prevents_overlapping_setup_stop_and_rebuild_operations() {
    let temporary = Temporary::new();
    let manager = Manager::new(temporary.0.clone()).unwrap();
    let workspace = manager.create(Recipe::openbot()).unwrap();
    let lock = manager.lock(&workspace.id).unwrap();
    assert!(manager.lock(&workspace.id).is_err());
    drop(lock);
    assert!(manager.lock(&workspace.id).is_ok());
}

#[cfg(unix)]
fn deletion_fixture() -> (Temporary, Manager, Workspace, Workspace) {
    use std::os::unix::fs::PermissionsExt;
    let temporary = Temporary::new();
    let mut manager = Manager::new(temporary.0.clone()).unwrap();
    let executable = temporary.0.join("fake-delete-lima");
    fs::write(
        &executable,
        r#"#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['LIMA_HOME'])
args = sys.argv[1:]
with (root / 'operations').open('a') as output: output.write(json.dumps(args) + '\n')
if args[0] == 'list':
    for state in root.glob('instance-obw-*'):
        print(json.dumps({'name':state.name.removeprefix('instance-'),'status':state.read_text()}))
elif args[0] in ['stop', 'delete']:
    assert args[1] == ('--tty=false' if args[0] == 'stop' else '--force')
    assert len(args) == 3 and args[2].startswith('obw-')
    state = root / ('instance-' + args[2])
    if (root / ('fail-' + args[0])).exists():
        print('fixture operation refused', file=sys.stderr)
        sys.exit(7)
    if args[0] == 'stop': state.write_text('Stopped')
    elif not (root / 'keep-after-delete').exists(): state.unlink()
else: sys.exit(9)
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    manager.executable = executable;
    let selected = manager.create(Recipe::openbot()).unwrap();
    let other = manager.create(Recipe::openbot()).unwrap();
    (temporary, manager, selected, other)
}

#[cfg(unix)]
fn deletion_mutations(root: &Path) -> Vec<Vec<String>> {
    fs::read_to_string(root.join("vms/operations"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Vec<String>>(line).unwrap())
        .filter(|args| args[0] != "list")
        .collect()
}

#[cfg(unix)]
#[test]
fn deletion_refuses_active_usage_and_setup_without_touching_any_vm() {
    let (temporary, manager, selected, _) = deletion_fixture();
    let first = manager.acquire_usage(&selected.id).unwrap();
    let second = manager.acquire_usage(&selected.id).unwrap();
    assert!(manager
        .delete(&selected.id)
        .unwrap_err()
        .contains("active commands"));
    drop(first);
    assert!(manager.delete(&selected.id).is_err());
    drop(second);
    let operation = manager.lock(&selected.id).unwrap();
    assert!(manager
        .delete(&selected.id)
        .unwrap_err()
        .contains("in progress"));
    drop(operation);
    assert!(deletion_mutations(&temporary.0).is_empty());
    assert_eq!(manager.get(&selected.id).unwrap(), selected);
}

#[cfg(unix)]
#[test]
fn deletion_stops_and_removes_only_the_selected_guest_then_removes_its_record() {
    let (temporary, manager, selected, other) = deletion_fixture();
    fs::write(
        temporary
            .0
            .join("vms")
            .join(format!("instance-{}", selected.id)),
        "Running",
    )
    .unwrap();
    let other_state = temporary
        .0
        .join("vms")
        .join(format!("instance-{}", other.id));
    fs::write(&other_state, "Stopped").unwrap();
    manager.delete(&selected.id).unwrap();
    assert_eq!(
        deletion_mutations(&temporary.0),
        vec![
            vec!["stop".to_owned(), "--tty=false".into(), selected.id.clone()],
            vec!["delete".into(), "--force".into(), selected.id.clone()],
        ]
    );
    assert!(manager.get(&selected.id).is_err());
    assert!(!manager.path(&selected.id).unwrap().exists());
    assert_eq!(manager.get(&other.id).unwrap(), other);
    assert_eq!(fs::read_to_string(other_state).unwrap(), "Stopped");
}

#[cfg(unix)]
#[test]
fn deletion_failures_keep_the_record_and_never_proceed_after_a_failed_stop() {
    for failure in ["stop", "delete"] {
        let (temporary, manager, selected, other) = deletion_fixture();
        let selected_state = temporary
            .0
            .join("vms")
            .join(format!("instance-{}", selected.id));
        fs::write(
            &selected_state,
            if failure == "stop" {
                "Running"
            } else {
                "Stopped"
            },
        )
        .unwrap();
        fs::write(temporary.0.join("vms").join(format!("fail-{failure}")), "").unwrap();
        assert!(manager.delete(&selected.id).is_err());
        assert_eq!(manager.get(&selected.id).unwrap(), selected);
        assert_eq!(manager.get(&other.id).unwrap(), other);
        assert!(selected_state.exists());
        assert!(manager
            .logs(&selected.id)
            .unwrap()
            .contains("fixture operation refused"));
        assert_eq!(
            deletion_mutations(&temporary.0)
                .iter()
                .map(|args| args[0].as_str())
                .collect::<Vec<_>>(),
            vec![failure]
        );
    }
}

#[cfg(unix)]
#[test]
fn deletion_does_not_remove_metadata_when_lima_claims_success_but_guest_remains() {
    let (temporary, manager, selected, _) = deletion_fixture();
    fs::write(
        temporary
            .0
            .join("vms")
            .join(format!("instance-{}", selected.id)),
        "Stopped",
    )
    .unwrap();
    fs::write(temporary.0.join("vms/keep-after-delete"), "").unwrap();
    assert!(manager
        .delete(&selected.id)
        .unwrap_err()
        .contains("was not deleted"));
    assert_eq!(manager.get(&selected.id).unwrap(), selected);
}

#[cfg(unix)]
#[test]
fn an_uncreated_guest_can_be_removed_without_a_stop_or_delete_command() {
    let (temporary, manager, selected, other) = deletion_fixture();
    manager.delete(&selected.id).unwrap();
    assert!(manager.get(&selected.id).is_err());
    assert_eq!(manager.list().unwrap(), vec![other]);
    assert!(deletion_mutations(&temporary.0).is_empty());
    for id in ["../outside", "/host", "obw-zzzzzzzzzzzzzzzz"] {
        assert!(manager.delete(id).is_err());
    }
}

#[test]
fn guest_commands_are_quoted_and_keep_project_work_inside_the_guest() {
    assert_eq!(recipe::quote("a'b"), "'a'\\''b'");
    let recipe = Recipe::openbot();
    let clone = recipe::clone_script(&recipe);
    assert!(clone.contains("git clone --depth 1 --branch 'main' -- 'https://github.com/CopilotKit/openbot.git' /workspace/project"));
    assert!(!clone.contains("/Users/"));
    assert!(recipe::project_script(&recipe.setup).contains("cd /workspace/project"));
    let args = lima::shell_args("obw-0123456789abcdef");
    assert_eq!(args[0], "shell");
    assert_eq!(args[1], "--preserve-env=false");
    assert_eq!(args[2], "--workdir=/workspace/project");
}

#[cfg(unix)]
#[test]
fn controller_environment_does_not_forward_host_keys_or_ssh_agent() {
    let temporary = Temporary::new();
    let command = lima::command(&temporary.0, Path::new("/usr/bin/true"));
    let environment = command
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| {
                (
                    key.to_string_lossy().to_string(),
                    value.to_string_lossy().to_string(),
                )
            })
        })
        .collect::<std::collections::HashMap<_, _>>();
    assert!(!environment.contains_key("SSH_AUTH_SOCK"));
    assert!(!environment.contains_key("OPENAI_API_KEY"));
    assert!(!environment.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
    assert_eq!(
        environment.get("LIMA_HOME").unwrap(),
        &temporary.0.join("vms").to_string_lossy()
    );
}

#[cfg(target_os = "macos")]
#[test]
fn prepares_in_stages_resumes_without_replaying_setup_and_keeps_failures_reviewable() {
    use std::os::unix::fs::PermissionsExt;
    let temporary = Temporary::new();
    let mut manager = Manager::new(temporary.0.clone()).unwrap();
    let executable = temporary.0.join("fake-lima");
    fs::write(&executable, r#"#!/bin/sh
set -eu
case "$1" in
 --version) echo 'limactl version 2.3.0' ;;
 list) if test -e "$LIMA_HOME/running"; then printf '{"name":"%s","status":"Running"}\n' "$(cat "$LIMA_HOME/running")"; fi ;;
 start) if test "$3" = '--name'; then echo "$4" > "$LIMA_HOME/running"; else echo "$3" > "$LIMA_HOME/running"; fi ;;
 shell) input=$(cat); printf '%s\n' "$input" >> "$LIMA_HOME/guest-scripts"; if printf '%s\n' "$input" | grep -q '^false$'; then echo 'example setup failure' >&2; exit 7; fi ;;
 stop) rm -f "$LIMA_HOME/running" ;;
 *) exit 9 ;;
esac
"#).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    manager.executable = executable;
    let mut recipe = Recipe::openbot();
    recipe.setup = vec!["echo prepared".into()];
    let workspace = manager.create(recipe).unwrap();
    let mut events = Vec::new();
    let ready = manager
        .prepare(&workspace.id, |event| events.push(event))
        .unwrap();
    assert_eq!(ready.phase, Phase::Ready);
    assert_eq!(
        ready.completed,
        vec!["packages", "source", "setup", "verify"]
    );
    assert!(events.iter().any(|event| event.stage == "ready"));
    let scripts = fs::read_to_string(temporary.0.join("vms/guest-scripts")).unwrap();
    manager.prepare(&workspace.id, |_| {}).unwrap();
    assert_eq!(
        scripts,
        fs::read_to_string(temporary.0.join("vms/guest-scripts")).unwrap()
    );
    manager.stop(&workspace.id, |_| {}).unwrap();
    assert_eq!(manager.get(&workspace.id).unwrap().phase, Phase::Stopped);
    let mut snapshot = SkillSnapshot {
        id: "stage-order".into(),
        slug: "stage-order".into(),
        name: "Stage order".into(),
        description: "Check preparation order.".into(),
        instructions: "Keep these instructions local.".into(),
        origin: "yours".into(),
        sha256: String::new(),
    };
    {
        use sha2::{Digest, Sha256};
        let canonical = serde_json::to_vec(&[
            "openbot.workspace-skill.v1",
            &snapshot.id,
            &snapshot.slug,
            &snapshot.name,
            &snapshot.description,
            &snapshot.instructions,
            &snapshot.origin,
        ])
        .unwrap();
        snapshot.sha256 = format!("{:x}", Sha256::digest(canonical));
    }
    let mut selected = Recipe::openbot();
    selected.skills = vec![snapshot];
    let selected = manager.create(selected).unwrap();
    let mut selected_events = Vec::new();
    let ready = manager
        .prepare(&selected.id, |event| selected_events.push(event))
        .unwrap();
    assert_eq!(
        ready.completed,
        vec!["packages", "source", "skills", "setup", "verify"]
    );
    let source = selected_events
        .iter()
        .position(|event| event.stage == "source" && event.message == "Completed.")
        .unwrap();
    let skills = selected_events
        .iter()
        .position(|event| event.stage == "skills" && event.message == "Started.")
        .unwrap();
    let setup = selected_events
        .iter()
        .position(|event| event.stage == "setup" && event.message == "Started.")
        .unwrap();
    assert!(source < skills && skills < setup);
    let scripts = fs::read_to_string(temporary.0.join("vms/guest-scripts")).unwrap();
    manager.prepare(&selected.id, |_| {}).unwrap();
    assert_eq!(
        scripts,
        fs::read_to_string(temporary.0.join("vms/guest-scripts")).unwrap()
    );
    let mut broken = Recipe::openbot();
    broken.setup = vec!["false".into()];
    let failed = manager.create(broken).unwrap();
    assert!(manager.prepare(&failed.id, |_| {}).is_err());
    let saved = manager.get(&failed.id).unwrap();
    assert_eq!(saved.phase, Phase::Failed);
    assert!(saved.completed.contains(&"source".into()));
    assert!(!saved.completed.contains(&"setup".into()));
    assert!(manager
        .logs(&failed.id)
        .unwrap()
        .contains("example setup failure"));
}
