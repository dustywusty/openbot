//! Durable native-only VM reconnect vouchers. The index contains no credential; vouchers stay
//! in a separate OS keychain service and are never serialized into webview or guest requests.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    sync::{Arc, Mutex},
};
const SERVICE: &str = "ai.copilotkit.openbot.computer-pairing";
const LIMIT: u64 = 64 * 1024;
pub struct Voucher(String);
impl Voucher {
    pub fn new(value: String) -> Result<Self, String> {
        if value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            Ok(Self(value))
        } else {
            Err("OpenBot returned an invalid workspace reconnect credential.".into())
        }
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl<'de> Deserialize<'de> for Voucher {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub binding_id: String,
    pub server_audience: String,
    pub installation_id: String,
    pub computer_id: String,
    pub owner_user_id: String,
    pub name: String,
}
pub fn computer_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("obw-")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl Binding {
    pub fn validate(&self, installation: &str) -> Result<(), String> {
        let text = |s: &str, max: usize| {
            !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
        };
        if !uuid(&self.binding_id)
            || !uuid(&self.server_audience)
            || self.installation_id != installation
            || !computer_id(&self.computer_id)
            || !text(&self.owner_user_id, 256)
            || !text(&self.name, 100)
        {
            Err("The saved workspace pairing does not match this installation.".into())
        } else {
            Ok(())
        }
    }
}
/// Injectable only for native tests; production always uses SystemSecrets and OS keychain.
pub trait Secrets: Send + Sync {
    fn save(&self, key: &str, value: &str) -> Result<(), String>;
    fn load(&self, key: &str) -> Result<Option<String>, String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}
struct SystemSecrets;
fn keychain_error() -> String {
    "OpenBot could not save workspace pairing in the system credential store. Unlock it and pair the workspace again.".into()
}
impl Secrets for SystemSecrets {
    fn save(&self, key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, key)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| keychain_error())
    }
    fn load(&self, key: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(SERVICE, key)
            .map_err(|_| keychain_error())?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(keychain_error()),
        }
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, key)
            .map_err(|_| keychain_error())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(keychain_error()),
        }
    }
}
pub struct PairingStore {
    scope: PathBuf,
    installation: String,
    secrets: Arc<dyn Secrets>,
    lock: Mutex<()>,
}
impl PairingStore {
    pub fn new(scope: PathBuf, installation: String) -> Result<Self, String> {
        Self::with_secrets(scope, installation, Arc::new(SystemSecrets))
    }
    pub fn with_secrets(
        scope: PathBuf,
        installation: String,
        secrets: Arc<dyn Secrets>,
    ) -> Result<Self, String> {
        let scope = scope
            .canonicalize()
            .map_err(|_| "The native installation identity is unavailable.")?;
        let directory = scope.join("pairings");
        fs::create_dir_all(&directory).map_err(|_| "Workspace pairings could not be prepared.")?;
        let meta = fs::symlink_metadata(&directory)
            .map_err(|_| "Workspace pairings could not be inspected.")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("Workspace pairings must use a private directory.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Workspace pairings could not be protected.")?;
        }
        Ok(Self {
            scope,
            installation,
            secrets,
            lock: Mutex::new(()),
        })
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if !computer_id(id) {
            return Err("Choose an existing workspace.".into());
        }
        Ok(self.scope.join("pairings").join(format!("{id}.json")))
    }
    fn key(&self, binding: &Binding) -> String {
        let tuple = serde_json::to_vec(&[
            self.scope.to_string_lossy().as_ref(),
            &self.installation,
            &binding.server_audience,
            &binding.computer_id,
            &binding.owner_user_id,
            &binding.binding_id,
        ])
        .expect("string tuple");
        format!("reconnect-{:x}", Sha256::digest(tuple))
    }
    pub fn get(&self, id: &str) -> Result<Option<Binding>, String> {
        let path = self.path(id)?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        // Anchor the read to the verified private directory, so replacing a parent with
        // a symlink cannot redirect index reads between metadata inspection and open.
        #[cfg(unix)]
        let opened = (|| -> std::io::Result<fs::File> {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::fs::{MetadataExt, OpenOptionsExt},
            };
            let directory = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(self.scope.join("pairings"))?;
            let meta = directory.metadata()?;
            if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
                return Err(std::io::Error::other(
                    "Workspace pairing directory is not private.",
                ));
            }
            let name =
                std::ffi::CString::new(format!("{id}.json")).expect("validated workspace id");
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(unsafe { fs::File::from_raw_fd(fd) })
            }
        })();
        #[cfg(not(unix))]
        let opened = options.open(&path);
        #[cfg(unix)]
        let _ = path;
        let file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Workspace pairing could not be opened safely.".into()),
        };
        let meta = file
            .metadata()
            .map_err(|_| "Workspace pairing could not be inspected.")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > LIMIT {
            return Err("The saved workspace pairing is invalid.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
                || meta.nlink() != 1
            {
                return Err("Workspace pairing metadata must be a private owned file.".into());
            }
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Workspace pairing could not be read.")?;
        if bytes.len() as u64 > LIMIT {
            return Err("The saved workspace pairing is oversized.".into());
        }
        let binding: Binding = serde_json::from_slice(&bytes)
            .map_err(|_| "The saved workspace pairing is invalid.")?;
        binding.validate(&self.installation)?;
        if binding.computer_id != id {
            return Err("The saved workspace pairing does not match its index.".into());
        }
        Ok(Some(binding))
    }
    pub fn list(&self) -> Result<Vec<Binding>, String> {
        let mut result = Vec::new();
        for (scanned, entry) in fs::read_dir(self.scope.join("pairings"))
            .map_err(|_| "Workspace pairings could not be listed.")?
            .enumerate()
        {
            if scanned >= 512 {
                break;
            }
            if result.len() >= 128 {
                return Err("Too many workspace pairings were saved.".into());
            }
            let entry = entry.map_err(|_| "Workspace pairings could not be listed.")?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(id) = name.strip_suffix(".json") {
                if computer_id(id) {
                    if let Ok(Some(binding)) = self.get(id) {
                        result.push(binding);
                    }
                }
            }
        }
        Ok(result)
    }
    pub fn save(&self, binding: &Binding, voucher: &Voucher) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "Workspace pairing is busy.")?;
        binding.validate(&self.installation)?;
        let previous = self.get(&binding.computer_id)?;
        let key = self.key(binding);
        self.secrets.save(&key, voucher.expose())?;
        let bytes =
            serde_json::to_vec(binding).map_err(|_| "Workspace pairing could not be encoded.")?;
        if crate::env::write_private_file(&self.path(&binding.computer_id)?, &bytes).is_err() {
            let _ = self.secrets.remove(&key);
            return Err("Workspace pairing could not be saved. Pair it again.".into());
        }
        if let Some(previous) = previous {
            if self.key(&previous) != key {
                let _ = self.secrets.remove(&self.key(&previous));
            }
        }
        Ok(())
    }
    pub fn voucher(&self, binding: &Binding) -> Result<Option<Voucher>, String> {
        binding.validate(&self.installation)?;
        self.secrets
            .load(&self.key(binding))?
            .map(Voucher::new)
            .transpose()
    }
    /// CAS protects a newly re-paired binding from a late disconnect acknowledgment.
    pub fn remove(&self, binding: &Binding) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "Workspace pairing is busy.")?;
        if self.get(&binding.computer_id)?.as_ref() != Some(binding) {
            return Err("Workspace pairing changed. Refresh before disconnecting.".into());
        }
        self.secrets.remove(&self.key(binding))?;
        fs::remove_file(self.path(&binding.computer_id)?)
            .map_err(|_| "The workspace pairing index could not be removed.".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    #[derive(Default)]
    struct Memory {
        values: Mutex<HashMap<String, String>>,
        fail: Mutex<bool>,
    }
    impl Secrets for Memory {
        fn save(&self, k: &str, v: &str) -> Result<(), String> {
            if *self.fail.lock().unwrap() {
                return Err("locked".into());
            }
            self.values.lock().unwrap().insert(k.into(), v.into());
            Ok(())
        }
        fn load(&self, k: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(k).cloned())
        }
        fn remove(&self, k: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(k);
            Ok(())
        }
    }
    fn fixture() -> (PathBuf, Arc<Memory>, PairingStore, Binding) {
        let root =
            std::env::temp_dir().join(format!("openbot-pairing-test-{}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        let memory = Arc::new(Memory::default());
        let store =
            PairingStore::with_secrets(root.clone(), "installation-one".into(), memory.clone())
                .unwrap();
        let binding = Binding {
            binding_id: "00000000-0000-4000-8000-000000000001".into(),
            server_audience: "00000000-0000-4000-8000-000000000002".into(),
            installation_id: "installation-one".into(),
            computer_id: "obw-0123456789abcdef".into(),
            owner_user_id: "alice".into(),
            name: "Project".into(),
        };
        (root, memory, store, binding)
    }
    #[test]
    fn invalid_or_mismatched_index_does_not_hide_valid_other_workspace() {
        let (root, _, store, binding) = fixture();
        store
            .save(&binding, &Voucher::new("a".repeat(64)).unwrap())
            .unwrap();
        let other = "obw-fedcba9876543210";
        crate::env::write_private_file(
            &store.path(other).unwrap(),
            &serde_json::to_vec(&binding).unwrap(),
        )
        .unwrap();
        assert!(store.get(other).is_err());
        assert_eq!(store.list().unwrap().len(), 1);
        crate::env::write_private_file(&store.path(other).unwrap(), b"not json").unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn index_reads_refuse_symlink_fifo_and_redirected_directory() {
        use std::os::unix::fs::symlink;
        let (root, _, store, binding) = fixture();
        let path = store.path(&binding.computer_id).unwrap();
        symlink("missing-target", &path).unwrap();
        assert!(store.get(&binding.computer_id).is_err());
        fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let before = std::time::Instant::now();
        assert!(store.get(&binding.computer_id).is_err());
        assert!(before.elapsed() < std::time::Duration::from_secs(1));
        fs::remove_file(&path).unwrap();
        fs::rename(root.join("pairings"), root.join("moved")).unwrap();
        symlink(root.join("moved"), root.join("pairings")).unwrap();
        assert!(store.get(&binding.computer_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn voucher_is_only_in_secret_store_and_all_identity_fields_scope_it() {
        let (root, memory, store, binding) = fixture();
        let voucher = Voucher::new("a".repeat(64)).unwrap();
        store.save(&binding, &voucher).unwrap();
        let serialized = fs::read_to_string(store.path(&binding.computer_id).unwrap()).unwrap();
        assert!(!serialized.contains(voucher.expose()));
        let restarted =
            PairingStore::with_secrets(root.clone(), "installation-one".into(), memory.clone())
                .unwrap();
        assert_eq!(
            restarted
                .voucher(&restarted.get(&binding.computer_id).unwrap().unwrap())
                .unwrap()
                .unwrap()
                .expose(),
            voucher.expose()
        );
        for field in 0..3 {
            let mut other = binding.clone();
            match field {
                0 => other.owner_user_id = "bob".into(),
                1 => other.server_audience = "ffffffff-0000-4000-8000-000000000002".into(),
                _ => other.binding_id = "ffffffff-0000-4000-8000-000000000001".into(),
            };
            assert!(store.voucher(&other).unwrap().is_none());
        }
        assert_eq!(memory.values.lock().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn keychain_failure_never_commits_pairing_and_old_cas_cannot_remove_repair() {
        let (root, memory, store, binding) = fixture();
        *memory.fail.lock().unwrap() = true;
        assert!(store
            .save(&binding, &Voucher::new("a".repeat(64)).unwrap())
            .is_err());
        assert!(store.get(&binding.computer_id).unwrap().is_none());
        *memory.fail.lock().unwrap() = false;
        store
            .save(&binding, &Voucher::new("a".repeat(64)).unwrap())
            .unwrap();
        let mut newer = binding.clone();
        newer.binding_id = "ffffffff-0000-4000-8000-000000000001".into();
        store
            .save(&newer, &Voucher::new("b".repeat(64)).unwrap())
            .unwrap();
        assert!(store.remove(&binding).is_err());
        assert!(store.voucher(&newer).unwrap().is_some());
        store.remove(&newer).unwrap();
        assert!(store.get(&binding.computer_id).unwrap().is_none());
        assert!(memory.values.lock().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
