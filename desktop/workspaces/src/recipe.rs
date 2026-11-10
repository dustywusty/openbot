use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub cpus: u8,
    pub memory_gib: u16,
    pub disk_gib: u16,
}

impl Default for Resources {
    fn default() -> Self {
        Self {
            cpus: 4,
            memory_gib: 8,
            disk_gib: 48,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewPort {
    pub guest: u16,
    pub host: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodingTools {
    pub codex: Option<String>,
    pub claude: Option<String>,
}

impl Default for CodingTools {
    fn default() -> Self {
        Self {
            codex: Some("0.163.0".into()),
            claude: Some("2.1.316".into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BaseImage {
    #[default]
    Debian13,
    Ubuntu2404,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipe {
    pub base_image: BaseImage,
    pub name: String,
    pub repository: String,
    pub git_ref: String,
    #[serde(default)]
    pub resources: Resources,
    #[serde(default)]
    pub packages: Vec<String>,
    #[serde(default)]
    pub tools: CodingTools,
    #[serde(default)]
    pub skills: Vec<crate::SkillSnapshot>,
    #[serde(default)]
    pub setup: Vec<String>,
    #[serde(default)]
    pub verify: Vec<String>,
    #[serde(default)]
    pub ports: Vec<PreviewPort>,
}

impl Recipe {
    pub fn openbot() -> Self {
        Self::for_image(BaseImage::Debian13)
    }
    pub fn for_image(base_image: BaseImage) -> Self {
        let mut packages = [
            "build-essential",
            "git",
            "curl",
            "ca-certificates",
            "unzip",
            "xz-utils",
            "openssl",
            "lsof",
            "python3",
            "pkg-config",
            "docker.io",
        ]
        .map(str::to_owned)
        .to_vec();
        packages.extend(
            match base_image {
                BaseImage::Debian13 => vec!["docker-cli", "docker-compose"],
                BaseImage::Ubuntu2404 => vec!["docker-compose-v2"],
            }
            .into_iter()
            .map(str::to_owned),
        );
        Self {
            base_image,
            name: "OpenBot".into(),
            repository: "https://github.com/CopilotKit/openbot.git".into(),
            git_ref: "main".into(),
            resources: Resources::default(),
            packages,
            tools: CodingTools::default(),
            skills: Vec::new(),
            setup: vec!["bun install --frozen-lockfile".into()],
            verify: vec!["bun run --cwd app build".into()],
            ports: vec![PreviewPort {
                guest: 3010,
                host: 3030,
            }],
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty()
            || self.name.len() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err("Enter a workspace name of at most 80 characters.".into());
        }
        // Public HTTPS sources only in the first version. No credential in a recipe or setup log.
        let rest = self
            .repository
            .strip_prefix("https://")
            .ok_or("Use an HTTPS repository URL.")?;
        let (host, path) = rest.split_once('/').ok_or("Include the repository path.")?;
        if host.is_empty()
            || path.is_empty()
            || host.contains(['@', ':'])
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            || self.repository.contains(['?', '#', '\\'])
            || self.repository.chars().any(char::is_whitespace)
            || self.repository.chars().any(char::is_control)
            || self.repository.chars().any(char::is_control)
        {
            return Err("Use an HTTPS repository URL without a credential or query string.".into());
        }
        if self.git_ref.is_empty()
            || self.git_ref.len() > 128
            || self.git_ref.starts_with('-')
            || self.git_ref.contains("..")
            || self.git_ref.contains("//")
            || !self
                .git_ref
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        {
            return Err("Enter a branch or tag name.".into());
        }
        if !(1..=16).contains(&self.resources.cpus)
            || !(2..=64).contains(&self.resources.memory_gib)
            || !(16..=512).contains(&self.resources.disk_gib)
        {
            return Err("Choose 1–16 CPUs, 2–64 GiB memory, and 16–512 GiB disk.".into());
        }
        if self.packages.len() > 64
            || self.packages.iter().any(|p| {
                p.is_empty()
                    || p.len() > 80
                    || p.starts_with('-')
                    || !p.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(&b)
                    })
            })
        {
            return Err("Use apt package names, one per entry.".into());
        }
        for version in [&self.tools.codex, &self.tools.claude]
            .into_iter()
            .flatten()
        {
            if version.is_empty()
                || version.len() > 40
                || !version
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b".-".contains(&b))
            {
                return Err("Pin each coding tool to a release version.".into());
            }
        }
        if self.setup.len() > 32
            || self.verify.len() > 32
            || self
                .setup
                .iter()
                .chain(&self.verify)
                .any(|s| s.trim().is_empty() || s.len() > 8000 || s.contains('\0'))
        {
            return Err(
                "Use at most 32 setup and verification commands, each at most 8000 characters."
                    .into(),
            );
        }
        crate::skills::validate(&self.skills)?;
        let mut hosts = std::collections::HashSet::new();
        if self.ports.len() > 8
            || self
                .ports
                .iter()
                .any(|p| p.guest == 0 || p.host < 1024 || !hosts.insert(p.host))
        {
            return Err("Choose distinct preview ports of 1024 or more on this computer.".into());
        }
        Ok(())
    }
}

/// For scripts sent to a guest shell, never a host shell.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn install_script(recipe: &Recipe) -> String {
    let packages = recipe
        .packages
        .iter()
        .map(String::as_str)
        .chain(
            (!recipe.skills.is_empty() && !recipe.packages.iter().any(|p| p == "python3"))
                .then_some("python3"),
        )
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let mut script = format!(
        r#"set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
sudo apt-get -o Acquire::Retries=3 update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils {packages}
sudo mkdir -p /opt/openbot /workspace
sudo chown "$(id -u):$(id -g)" /opt/openbot /workspace
arch=$(uname -m)
case "$arch" in aarch64) node_arch=arm64; bun_arch=aarch64 ;; x86_64) node_arch=x64; bun_arch=x64 ;; *) exit 1 ;; esac
if ! test -x /opt/openbot/node/bin/node; then
  cd /opt/openbot
  curl --fail --location --retry 3 --output node.tar.xz "https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-$node_arch.tar.xz"
  curl --fail --location --retry 3 --output SHASUMS256.txt https://nodejs.org/dist/v24.18.1/SHASUMS256.txt
  grep " node-v24.18.1-linux-$node_arch.tar.xz$" SHASUMS256.txt | sed 's@node-v24.18.1-linux-[^ ]*\.tar\.xz@node.tar.xz@' | sha256sum --check -
  mkdir -p node && tar -xJf node.tar.xz -C node --strip-components=1
  rm node.tar.xz SHASUMS256.txt
fi
export PATH=/opt/openbot/node/bin:/opt/openbot/bun/bin:$PATH
if ! test -x /opt/openbot/bun/bin/bun; then
  cd /opt/openbot
  curl --fail --location --retry 3 --output bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-$bun_arch.zip"
  unzip -qo bun.zip -d bun-unpack
  mkdir -p bun/bin && cp "bun-unpack/bun-linux-$bun_arch/bun" bun/bin/bun
  rm -rf bun-unpack bun.zip
fi
sudo ln -sf /opt/openbot/node/bin/node /usr/local/bin/node
sudo ln -sf /opt/openbot/node/bin/npm /usr/local/bin/npm
sudo ln -sf /opt/openbot/bun/bin/bun /usr/local/bin/bun
sudo ln -sf /opt/openbot/bun/bin/bun /usr/local/bin/bunx
"#
    );
    let mut tools = Vec::new();
    if let Some(version) = &recipe.tools.codex {
        tools.push(quote(&format!("@openai/codex@{version}")));
    }
    if let Some(version) = &recipe.tools.claude {
        tools.push(quote(&format!("@anthropic-ai/claude-code@{version}")));
    }
    if !tools.is_empty() {
        script.push_str(&format!(
            "npm install --prefix /opt/openbot/tools {}\n",
            tools.join(" ")
        ));
        for tool in ["codex", "claude"] {
            script.push_str(&format!("if test -e /opt/openbot/tools/node_modules/.bin/{tool}; then sudo ln -sf /opt/openbot/tools/node_modules/.bin/{tool} /usr/local/bin/{tool}; fi\n"));
        }
    }
    // Install the guest's shell PATH. No host HOME, account directory, or SSH agent is forwarded.
    script.push_str("printf '%s\\n' 'export PATH=/opt/openbot/node/bin:/opt/openbot/bun/bin:/opt/openbot/tools/node_modules/.bin:$PATH' | sudo tee /etc/profile.d/openbot.sh >/dev/null\n");
    if recipe.packages.iter().any(|p| p == "docker.io") {
        script.push_str(
            "sudo systemctl enable --now docker\nsudo usermod -aG docker \"$(id -un)\"\n",
        );
    }
    script.push_str("node --version\nbun --version\n");
    if recipe.tools.codex.is_some() {
        script.push_str("codex --version\n");
    }
    if recipe.tools.claude.is_some() {
        script.push_str("claude --version\n");
    }
    if recipe
        .packages
        .iter()
        .any(|p| p == "docker-cli" || p == "docker.io")
    {
        script.push_str("docker --version\n");
    }
    if recipe
        .packages
        .iter()
        .any(|p| p == "docker-compose" || p == "docker-compose-v2")
    {
        script.push_str("docker compose version\n");
    }
    script
}

pub fn clone_script(recipe: &Recipe) -> String {
    format!("set -euo pipefail\nif ! test -d /workspace/project/.git; then\n git clone --depth 1 --branch {} -- {} /workspace/project\nelse\n test \"$(git -C /workspace/project remote get-url origin)\" = {}\nfi\n", quote(&recipe.git_ref), quote(&recipe.repository), quote(&recipe.repository))
}

pub fn project_script(commands: &[String]) -> String {
    // Individual commands run inside the guest's project folder, with no inherited host environment.
    let mut script = "set -euo pipefail\nexport PATH=/opt/openbot/node/bin:/opt/openbot/bun/bin:/opt/openbot/tools/node_modules/.bin:$PATH\ncd /workspace/project\n".to_owned();
    for command in commands {
        script.push_str(command);
        script.push('\n');
    }
    script
}

#[cfg(test)]
mod image_tests {
    use super::*;

    #[test]
    fn debian_default_and_saved_os_are_stable() {
        assert_eq!(BaseImage::default(), BaseImage::Debian13);
        assert_eq!(Recipe::openbot(), Recipe::for_image(BaseImage::Debian13));
        for (image, value) in [
            (BaseImage::Debian13, "debian13"),
            (BaseImage::Ubuntu2404, "ubuntu2404"),
        ] {
            let recipe = Recipe::for_image(image);
            recipe.validate().unwrap();
            let serialized = serde_json::to_value(&recipe).unwrap();
            assert_eq!(serialized["baseImage"], value);
            let loaded: Recipe = serde_json::from_value(serialized).unwrap();
            assert_eq!(loaded.base_image, image);
            assert_eq!(loaded, recipe);
        }
    }

    #[test]
    fn package_presets_and_checks_match_the_selected_distribution() {
        let debian = Recipe::openbot();
        assert!(debian.packages.contains(&"docker-cli".into()));
        assert!(debian.packages.contains(&"docker-compose".into()));
        assert!(!debian.packages.contains(&"docker-compose-v2".into()));
        let ubuntu = Recipe::for_image(BaseImage::Ubuntu2404);
        assert!(ubuntu.packages.contains(&"docker.io".into()));
        assert!(ubuntu.packages.contains(&"docker-compose-v2".into()));
        assert!(!ubuntu.packages.contains(&"docker-cli".into()));
        assert!(!ubuntu.packages.contains(&"docker-compose".into()));
        for recipe in [debian, ubuntu] {
            let script = install_script(&recipe);
            assert!(script.contains("docker --version"));
            assert!(script.contains("docker compose version"));
            assert!(script.contains("sudo apt-get"));
        }
    }
}
