//! Frozen instruction-only skills. No tools, permission rules, credentials, or executable assets
//! are accepted in this schema. Guest writes are confined to reserved paths in its checkout.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_SKILLS: usize = 16;
const MAX_SNAPSHOT: usize = 64 * 1024;
const MAX_TOTAL: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillSnapshot {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub origin: String,
    pub sha256: String,
}
impl SkillSnapshot {
    fn canonical(&self) -> Result<Vec<u8>, String> {
        serde_json::to_vec(&[
            "openbot.workspace-skill.v1",
            &self.id,
            &self.slug,
            &self.name,
            &self.description,
            &self.instructions,
            &self.origin,
        ])
        .map_err(|_| "Could not encode the frozen skill instructions.".into())
    }
    fn validate(&self) -> Result<usize, String> {
        let scalar = |value: &str, max: usize, required: bool| {
            value.len() <= max
                && (!required || !value.trim().is_empty())
                && !value.chars().any(char::is_control)
        };
        if !scalar(&self.id, 128, true)
            || !scalar(&self.name, 160, true)
            || !scalar(&self.description, 2048, false)
            || !scalar(&self.origin, 128, true)
            || !(2..=40).contains(&self.slug.len())
            || !self
                .slug
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !self.slug.as_bytes()[0].is_ascii_alphanumeric()
            || !self.slug.as_bytes()[self.slug.len() - 1].is_ascii_alphanumeric()
            || self.instructions.trim().is_empty()
            || self.instructions.contains('\0')
        {
            return Err("The selected skill has invalid or oversized snapshot fields.".into());
        }
        let bytes = self.canonical()?;
        if bytes.len() > MAX_SNAPSHOT {
            return Err("Each frozen skill must fit within 64 KiB.".into());
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || format!("{:x}", Sha256::digest(&bytes)) != self.sha256
        {
            return Err("The selected skill snapshot digest does not match its instructions and provenance.".into());
        }
        Ok(bytes.len())
    }
}
pub(crate) fn validate(skills: &[SkillSnapshot]) -> Result<(), String> {
    if skills.len() > MAX_SKILLS {
        return Err("Choose at most 16 instruction skills for this VM.".into());
    }
    let mut slugs = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    let mut total = 0;
    for skill in skills {
        total += skill.validate()?;
        if !slugs.insert(&skill.slug) || !ids.insert(&skill.id) {
            return Err("Choose each instruction skill only once.".into());
        }
    }
    if total > MAX_TOTAL {
        return Err("The selected skill snapshots must fit within 256 KiB in total.".into());
    }
    Ok(())
}
pub(crate) fn install_script(skills: &[SkillSnapshot]) -> Result<String, String> {
    validate(skills)?;
    // The compact JSON is one line; embedded newlines are escaped, so it cannot terminate this
    // fixed heredoc. The body is stdin data, never a shell command or a process argument.
    let data =
        serde_json::to_string(skills).map_err(|_| "Could not encode the selected skills.")?;
    Ok(format!("set -euo pipefail\npython3 -c {} <<'OPENBOT_FROZEN_SKILL_SNAPSHOTS'\n{}\nOPENBOT_FROZEN_SKILL_SNAPSHOTS\n",crate::recipe::quote(INSTALLER),data))
}

const INSTALLER: &str = r#"
import fcntl, hashlib, json, os, re, stat, sys, uuid
ROOT = '/workspace/project'
NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
MANIFEST = '.openbot-managed.json'
LIMIT = 512 * 1024
def fail(message): raise RuntimeError(message)
def scalar(value, maximum, required=True):
    return isinstance(value,str) and len(value.encode('utf-8')) <= maximum and (not required or bool(value.strip())) and not any(ord(c)<32 or 127<=ord(c)<160 for c in value)
def encode(value): return json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf-8')
def snapshot(skill): return encode(['openbot.workspace-skill.v1',skill['id'],skill['slug'],skill['name'],skill['description'],skill['instructions'],skill['origin']])
def digest(data): return hashlib.sha256(data).hexdigest()
def regular(fd):
    meta=os.fstat(fd)
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid(): fail('A managed skill path is not a regular owned file.')
def directory(parent,name,create=False):
    if create:
        try: os.mkdir(name,0o700,dir_fd=parent)
        except FileExistsError: pass
    fd=os.open(name,DIRECTORY,dir_fd=parent)
    if os.fstat(fd).st_uid != os.geteuid(): os.close(fd); fail('A skill directory is not owned by the VM user.')
    return fd
def project():
    fd=os.open('/',DIRECTORY)
    try:
        for part in ROOT.split('/'):
            if not part: continue
            child=os.open(part,DIRECTORY,dir_fd=fd);os.close(fd);fd=child
        return fd
    except: os.close(fd);raise
def exists(parent,name):
    try: os.stat(name,dir_fd=parent,follow_symlinks=False);return True
    except FileNotFoundError:return False
def read(parent,name,maximum=LIMIT):
    fd=os.open(name,os.O_RDONLY|os.O_NONBLOCK|NOFOLLOW,dir_fd=parent)
    try:
        regular(fd)
        if os.fstat(fd).st_size>maximum:fail('A managed skill file is oversized.')
        with os.fdopen(os.dup(fd),'rb') as stream: data=stream.read(maximum+1)
        if len(data)>maximum:fail('A managed skill file is oversized.')
        return data
    finally:os.close(fd)
def publish(parent,name,data):
    temporary='.openbot-skill.'+uuid.uuid4().hex+'.tmp'
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600,dir_fd=parent)
    try:
        with os.fdopen(fd,'wb',closefd=True) as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.link(temporary,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
    finally:
        try:os.unlink(temporary,dir_fd=parent)
        except FileNotFoundError:pass
    os.fsync(parent)
def add_excludes(info,patterns):
    flags=os.O_RDWR|os.O_NONBLOCK|os.O_APPEND|os.O_CREAT|NOFOLLOW
    fd=os.open('exclude',flags,0o600,dir_fd=info)
    try:
        regular(fd)
        if os.fstat(fd).st_nlink!=1 or os.fstat(fd).st_size>LIMIT:fail('The local git exclude file is unsafe or oversized.')
        os.lseek(fd,0,os.SEEK_SET)
        with os.fdopen(os.dup(fd),'rb') as stream:existing=stream.read(LIMIT+1)
        if len(existing)>LIMIT:fail('The local git exclude file is oversized.')
        lines=existing.splitlines();missing=[p.encode() for p in patterns if p.encode() not in lines]
        if missing:
            addition=(b'\n' if existing and not existing.endswith(b'\n') else b'')+b'\n'.join(missing)+b'\n'
            if len(existing)+len(addition)>LIMIT:fail('The local git exclude file cannot fit the skill entries.')
            with os.fdopen(os.dup(fd),'ab') as stream:stream.write(addition);stream.flush();os.fsync(stream.fileno())
    finally:os.close(fd)
def install():
    raw=sys.stdin.buffer.read(LIMIT+1)
    if len(raw)>LIMIT:fail('The selected skill snapshots are oversized.')
    skills=json.loads(raw)
    if not isinstance(skills,list) or len(skills)>16:fail('Choose at most 16 instruction skills.')
    total=0;seen=set();ids=set();expected={};files={}
    for skill in skills:
        if not isinstance(skill,dict) or set(skill)!={'id','slug','name','description','instructions','origin','sha256'}:fail('The skill snapshot schema is invalid.')
        if not scalar(skill['id'],128) or not scalar(skill['name'],160) or not scalar(skill['description'],2048,False) or not scalar(skill['origin'],128):fail('The skill snapshot metadata is invalid.')
        if not isinstance(skill['slug'],str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,38}[a-z0-9]',skill['slug']):fail('The skill slug is invalid.')
        if not isinstance(skill['instructions'],str) or not skill['instructions'].strip() or '\0' in skill['instructions']:fail('The skill instructions are invalid.')
        canonical=snapshot(skill);total+=len(canonical)
        if len(canonical)>65536 or total>262144:fail('The selected skill snapshots are oversized.')
        if not isinstance(skill['sha256'],str) or not re.fullmatch('[a-f0-9]{64}',skill['sha256']) or digest(canonical)!=skill['sha256']:fail('The frozen skill digest does not match.')
        if skill['slug'] in seen or skill['id'] in ids:fail('Choose each instruction skill once.')
        seen.add(skill['slug']);ids.add(skill['id'])
        name='openbot-'+skill['slug']
        # JSON string quoting is valid YAML double-quoted scalar syntax. No tool/permission keys
        # from a source skill enter the generated frontmatter.
        content=('---\nname: '+json.dumps(name,ensure_ascii=False)+'\ndescription: '+json.dumps(skill['description'] or skill['name'],ensure_ascii=False)+'\n---\n\n'+skill['instructions']+'\n').encode('utf-8')
        expected[name]={'id':skill['id'],'sha256':skill['sha256'],'fileSha256':digest(content),'origin':skill['origin']}
        files[name]=content
    if not skills:return
    root=project()
    agents=store=git=info=lock=workspace=metadata=None
    try:
        # Check Git metadata before any skill publication; linked worktree gitfiles are not
        # followed outside this checkout by this first installer.
        git=directory(root,'.git');info=directory(git,'info',True)
        # Ownership lives outside the clone, so a repository cannot forge a managed manifest.
        workspace=directory(root,'..');metadata=directory(workspace,'.openbot',True)
        lock=os.open('skill-snapshots.lock',os.O_RDWR|os.O_NONBLOCK|os.O_CREAT|NOFOLLOW,0o600,dir_fd=metadata);regular(lock)
        if os.fstat(lock).st_nlink!=1:fail('The skill installation lock is unsafe.')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        owner_name='skill-snapshots-owner.json'
        ownership={'version':1,'skills':expected}
        owned=exists(metadata,owner_name)
        if owned and json.loads(read(metadata,owner_name))!=ownership:fail('The original VM skill snapshots changed. Create another VM for different snapshots.')
        agents=directory(root,'.agents',True);store=directory(agents,'skills',True)
        previous=None
        if exists(store,MANIFEST):
            if not owned:fail('A repository-provided skill manifest cannot claim OpenBot ownership.')
            previous=json.loads(read(store,MANIFEST))
            if previous!={'version':1,'skills':expected}:fail('The managed skill snapshots changed. Keep the original snapshots or create another VM.')
        # Existing unmanaged target folders are never adopted, even with matching contents.
        if not owned:
            for name in files:
                if exists(store,name):fail('A project skill already uses this reserved OpenBot folder. It was not overwritten.')
        for name,content in files.items():
            if exists(store,name):
                target=directory(store,name)
                try:
                    if exists(target,'SKILL.md') and digest(read(target,'SKILL.md'))!=digest(content):fail('A managed skill was edited. It was not overwritten.')
                finally:os.close(target)
        if not owned:publish(metadata,owner_name,encode(ownership))
        if previous is None:publish(store,MANIFEST,encode(ownership))
        add_excludes(info,['/.agents/skills/'+MANIFEST,'/.agents/skills/.openbot-managed.lock','/.agents/skills/.openbot-skill.*.tmp']+['/.agents/skills/'+name+'/' for name in sorted(files)])
        for name,content in files.items():
            if not exists(store,name):os.mkdir(name,0o700,dir_fd=store)
            target=directory(store,name)
            try:
                if exists(target,'SKILL.md'):
                    if digest(read(target,'SKILL.md'))!=digest(content):fail('A managed skill was edited. It was not overwritten.')
                else:publish(target,'SKILL.md',content)
            finally:os.close(target)
        print('Installed '+str(len(files))+' frozen instruction skills. No tool permissions were granted.')
    finally:
        for fd in [lock,store,agents,metadata,workspace,info,git,root]:
            if fd is not None:os.close(fd)
try:install()
except (Exception,KeyboardInterrupt) as error:
    # Do not print snapshot bodies, raw OS paths, or arbitrary exception representations.
    message=str(error) if isinstance(error,RuntimeError) else 'The frozen instruction skills could not be installed safely.'
    print(message,file=sys.stderr);sys.exit(1)
"#;

#[cfg(test)]
mod tests {
    use super::*;
    const MANIFEST: &str = ".openbot-managed.json";
    use std::{
        fs,
        io::Write,
        path::PathBuf,
        process::{Command, Stdio},
    };
    fn skill() -> SkillSnapshot {
        let mut value = SkillSnapshot {
            id: "skill-fixture".into(),
            slug: "sample-skill".into(),
            name: "Sample \"quoted\" skill".into(),
            description: "Use docs: #instructions \"quoted\" 🦦".into(),
            instructions:
                "Read the project instructions.\n\nKeep changes local.\nprivate-skill-body-canary"
                    .into(),
            origin: "builtin".into(),
            sha256: String::new(),
        };
        value.sha256 = format!("{:x}", Sha256::digest(value.canonical().unwrap()));
        value
    }
    fn resign(value: &mut SkillSnapshot) {
        value.sha256 = format!("{:x}", Sha256::digest(value.canonical().unwrap()));
    }
    struct Fixture {
        root: PathBuf,
        project: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "openbot-frozen-skills-{:016x}",
                rand::random::<u64>()
            ));
            let project = root.join("project");
            fs::create_dir_all(project.join(".git/info")).unwrap();
            Self {
                root: root.canonicalize().unwrap(),
                project: project.canonicalize().unwrap(),
            }
        }
        fn run(&self, skills: &[SkillSnapshot]) -> std::process::Output {
            self.raw(serde_json::to_vec(skills).unwrap(), None)
        }
        fn raw(&self, payload: Vec<u8>, modified: Option<String>) -> std::process::Output {
            let installer = modified.unwrap_or_else(|| INSTALLER.into()).replace(
                "ROOT = '/workspace/project'",
                &format!(
                    "ROOT = {}",
                    serde_json::to_string(self.project.to_str().unwrap()).unwrap()
                ),
            );
            let mut child = Command::new("python3")
                .args(["-c", &installer])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&payload).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while child.try_wait().unwrap().is_none() {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("Skill fixture installer blocked");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            child.wait_with_output().unwrap()
        }
        fn store(&self) -> PathBuf {
            self.project.join(".agents/skills")
        }
        fn installed(&self) -> PathBuf {
            self.store().join("openbot-sample-skill/SKILL.md")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn snapshots_are_bounded_frozen_and_old_recipes_default_to_none() {
        let mut recipe = crate::Recipe::openbot();
        assert!(recipe.skills.is_empty());
        let mut old = serde_json::to_value(&recipe).unwrap();
        old.as_object_mut().unwrap().remove("skills");
        assert!(serde_json::from_value::<crate::Recipe>(old)
            .unwrap()
            .skills
            .is_empty());
        recipe.skills = vec![skill()];
        recipe.validate().unwrap();
        recipe.skills[0].name.push('!');
        assert!(recipe.validate().is_err());
        let mut value = skill();
        value.slug = "../escape".into();
        resign(&mut value);
        assert!(validate(&[value]).is_err());
        assert!(validate(&[skill(), skill()]).is_err());
        let mut value = skill();
        value.instructions = "🦦".repeat(17000);
        resign(&mut value);
        assert!(validate(&[value]).is_err());
        let mut value = serde_json::to_value(skill()).unwrap();
        value["allowedTools"] = serde_json::json!(["Bash"]);
        assert!(serde_json::from_value::<SkillSnapshot>(value).is_err());
        let mut value = skill();
        value.instructions = "a".repeat(60000);
        resign(&mut value);
        let mut skills = Vec::new();
        for i in 0..5 {
            let mut entry = value.clone();
            entry.id = format!("skill-{i}");
            entry.slug = format!("sample-{i}");
            resign(&mut entry);
            skills.push(entry);
        }
        assert!(validate(&skills).is_err());
    }
    #[test]
    fn digest_matches_the_server_javascript_utf8_corpus() {
        let mut value=SkillSnapshot{id:"review-code".into(),slug:"review-code".into(),name:"Review café 😀".into(),description:"Check Unicode and quoting.".into(),instructions:"héllo 😀\nTabs\there; quote \" slash / backslash \\\nLine separator \u{2028} paragraph \u{2029} end.".into(),origin:"yours".into(),sha256:"a24b032502ca80ea033efee9640f51d38eff4dc8d0f645157c62444ca2bc2fc3".into()};
        assert_eq!(value.canonical().unwrap().len(), 211);
        value.validate().unwrap();
        value.origin = "other".into();
        assert!(value.validate().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn forged_repository_manifest_and_fifos_cannot_claim_ownership_or_block_reads() {
        let fixture = Fixture::new();
        assert!(fixture.run(&[skill()]).status.success());
        let manifest = fs::read(fixture.store().join(MANIFEST)).unwrap();
        let forged = Fixture::new();
        fs::create_dir_all(forged.store()).unwrap();
        fs::write(forged.store().join(MANIFEST), manifest).unwrap();
        assert!(!forged.run(&[skill()]).status.success());
        assert!(!forged.installed().exists());
        for target in ["manifest", "skill", "exclude"] {
            let fixture = Fixture::new();
            assert!(fixture.run(&[skill()]).status.success());
            let path = match target {
                "manifest" => fixture.store().join(MANIFEST),
                "skill" => fixture.installed(),
                _ => fixture.project.join(".git/info/exclude"),
            };
            fs::remove_file(&path).unwrap();
            assert!(Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success());
            let start = std::time::Instant::now();
            assert!(!fixture.run(&[skill()]).status.success());
            assert!(start.elapsed() < std::time::Duration::from_secs(2));
        }
    }

    #[test]
    fn git_exclude_append_refuses_oversize_without_changing_existing_content() {
        let fixture = Fixture::new();
        let exclude = fixture.project.join(".git/info/exclude");
        let original = vec![b'x'; 512 * 1024];
        fs::write(&exclude, &original).unwrap();
        assert!(!fixture.run(&[skill()]).status.success());
        assert_eq!(fs::read(exclude).unwrap(), original);
        assert!(!fixture.installed().exists());
    }

    #[test]
    fn installs_exact_body_safe_frontmatter_and_manifest_then_retries_without_rewriting() {
        let fixture = Fixture::new();
        let value = skill();
        let first = fixture.run(&[value.clone()]);
        assert!(
            first.status.success(),
            "{}",
            String::from_utf8_lossy(&first.stderr)
        );
        let content = fs::read_to_string(fixture.installed()).unwrap();
        assert!(content.starts_with("---\nname: \"openbot-sample-skill\"\ndescription: \"Use docs: #instructions \\\"quoted\\\" 🦦\"\n---\n\n"));
        assert!(content.ends_with(&format!("{}\n", value.instructions)));
        assert!(!String::from_utf8_lossy(&first.stdout).contains("private-skill-body-canary"));
        let manifest = fs::read(fixture.store().join(MANIFEST)).unwrap();
        let modified = fs::metadata(fixture.installed())
            .unwrap()
            .modified()
            .unwrap();
        assert!(fixture.run(&[value]).status.success());
        assert_eq!(manifest, fs::read(fixture.store().join(MANIFEST)).unwrap());
        assert_eq!(
            modified,
            fs::metadata(fixture.installed())
                .unwrap()
                .modified()
                .unwrap()
        );
        let exclude = fs::read_to_string(fixture.project.join(".git/info/exclude")).unwrap();
        assert_eq!(
            exclude
                .matches("/.agents/skills/openbot-sample-skill/")
                .count(),
            1
        );
    }
    #[test]
    fn interrupted_publication_resumes_from_manifest_and_never_replaces_user_edits() {
        let fixture = Fixture::new();
        let interruption = INSTALLER.replace(
            "add_excludes(info,[",
            "fail('Synthetic interrupted install')\n        add_excludes(info,[",
        );
        let first = fixture.raw(
            serde_json::to_vec(&vec![skill()]).unwrap(),
            Some(interruption),
        );
        assert!(!first.status.success());
        assert!(fixture.store().join(MANIFEST).is_file());
        assert!(!fixture.installed().exists());
        assert!(fixture.run(&[skill()]).status.success());
        fs::write(fixture.installed(), "User-edited instructions").unwrap();
        let failed = fixture.run(&[skill()]);
        assert!(!failed.status.success());
        assert_eq!(
            fs::read_to_string(fixture.installed()).unwrap(),
            "User-edited instructions"
        );
        assert!(!String::from_utf8_lossy(&failed.stderr).contains("private-skill-body-canary"));
        let mut changed = skill();
        changed.instructions.push_str("\nChanged snapshot");
        resign(&mut changed);
        assert!(!fixture.run(&[changed]).status.success());
    }
    #[test]
    fn independent_guest_validation_rejects_digest_and_schema_tampering_before_writes() {
        let fixture = Fixture::new();
        let mut value = serde_json::to_value(skill()).unwrap();
        value["instructions"] = serde_json::json!("Tampered body");
        assert!(!fixture
            .raw(serde_json::to_vec(&vec![value]).unwrap(), None)
            .status
            .success());
        assert!(!fixture.store().exists());
        let mut value = serde_json::to_value(skill()).unwrap();
        value["credentials"] = serde_json::json!("forbidden");
        assert!(!fixture
            .raw(serde_json::to_vec(&vec![value]).unwrap(), None)
            .status
            .success());
        assert!(!fixture.store().exists());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_unmanaged_targets_and_every_symlink_parent_without_outside_writes() {
        use std::os::unix::fs::symlink;
        for target in [
            ".agents",
            ".agents/skills",
            ".agents/skills/openbot-sample-skill",
            ".git",
            ".git/info",
            ".git/info/exclude",
        ] {
            let fixture = Fixture::new();
            let outside = fixture.root.join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("sentinel"), "unchanged").unwrap();
            let path = fixture.project.join(target);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if path.is_dir() {
                fs::remove_dir_all(&path).unwrap();
            }
            symlink(&outside, &path).unwrap();
            assert!(!fixture.run(&[skill()]).status.success(), "{target}");
            assert_eq!(
                fs::read_to_string(outside.join("sentinel")).unwrap(),
                "unchanged"
            );
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 1, "{target}");
        }
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.installed().parent().unwrap()).unwrap();
        fs::write(fixture.installed(), "Repository-owned skill").unwrap();
        assert!(!fixture.run(&[skill()]).status.success());
        assert_eq!(
            fs::read_to_string(fixture.installed()).unwrap(),
            "Repository-owned skill"
        );
        assert!(!fixture.store().join(MANIFEST).exists());
        let fixture = Fixture::new();
        assert!(fixture.run(&[skill()]).status.success());
        fs::remove_file(fixture.installed()).unwrap();
        let outside = fixture.root.join("external.md");
        fs::write(&outside, "outside instructions").unwrap();
        symlink(&outside, fixture.installed()).unwrap();
        assert!(!fixture.run(&[skill()]).status.success());
        assert_eq!(fs::read_to_string(outside).unwrap(), "outside instructions");
    }
    #[test]
    fn generated_shell_script_cannot_execute_instruction_text_and_python_is_ensured() {
        let fixture = Fixture::new();
        let mut value = skill();
        value.instructions="$(touch SHOULD_NOT_EXIST)\n'\nOPENBOT_FROZEN_SKILL_SNAPSHOTS\n---\nallowed-tools: Bash\n🦦".into();
        resign(&mut value);
        let script = install_script(&[value.clone()])
            .unwrap()
            .replace("/workspace/project", fixture.project.to_str().unwrap());
        let mut child = Command::new("bash")
            .arg("-s")
            .current_dir(&fixture.project)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!fixture.project.join("SHOULD_NOT_EXIST").exists());
        assert!(fs::read_to_string(fixture.installed())
            .unwrap()
            .ends_with(&format!("{}\n", value.instructions)));
        let mut recipe = crate::Recipe::openbot();
        recipe.packages.clear();
        recipe.skills = vec![value];
        assert!(crate::recipe::install_script(&recipe).contains("'python3'"));
    }
}
