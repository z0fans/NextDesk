use russh::keys::ssh_key::PublicKey;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
    Changed { line: usize },
}

pub fn known_hosts_path() -> PathBuf {
    crate::config::get_user_config_dir().join("ssh_known_hosts")
}

pub fn host_key_status(
    identity_host: &str,
    identity_port: u16,
    public_key: &PublicKey,
    path: &Path,
) -> Result<HostKeyStatus, String> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "ssh_known_hosts_lock_failed".to_string())?;
    let known = russh::keys::known_hosts::known_host_keys_path(identity_host, identity_port, path)
        .map_err(|error| format!("ssh_known_hosts_read_failed:{error}"))?;
    if known.iter().any(|(_, recorded)| recorded == public_key) {
        return Ok(HostKeyStatus::Trusted);
    }
    Ok(known
        .first()
        .map(|(line, _)| HostKeyStatus::Changed { line: *line })
        .unwrap_or(HostKeyStatus::Unknown))
}

pub fn trust_host_key(
    identity_host: &str,
    identity_port: u16,
    public_key: &PublicKey,
    path: &Path,
) -> Result<(), String> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "ssh_known_hosts_lock_failed".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("ssh_known_hosts_create_failed:{error}"))?;
    }
    let host_token = if identity_port == 22 {
        identity_host.to_string()
    } else {
        format!("[{identity_host}]:{identity_port}")
    };
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut retained = existing
        .lines()
        .filter(|line| {
            line.split_whitespace()
                .next()
                .is_none_or(|hosts| !hosts.split(',').any(|host| host == host_token))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    let encoded = public_key
        .to_openssh()
        .map_err(|error| format!("ssh_host_key_encode_failed:{error}"))?;
    retained.push(format!("{host_token} {encoded}"));
    let mut contents = retained.join("\n");
    contents.push('\n');
    std::fs::write(path, contents).map_err(|error| format!("ssh_known_hosts_write_failed:{error}"))
}

pub fn fingerprint(public_key: &PublicKey) -> String {
    public_key.fingerprint(Default::default()).to_string()
}

#[cfg(test)]
mod tests {
    use super::{host_key_status, trust_host_key, HostKeyStatus};

    #[test]
    fn known_hosts_status_uses_original_identity_and_blocks_changes() {
        let path =
            std::env::temp_dir().join(format!("nextdesk-known-hosts-{}", rand::random::<u64>()));
        let original = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap();
        let changed = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti",
        )
        .unwrap();

        assert_eq!(
            host_key_status("server.example.com", 22, &original, &path).unwrap(),
            HostKeyStatus::Unknown
        );
        trust_host_key("server.example.com", 22, &original, &path).unwrap();
        assert_eq!(
            host_key_status("server.example.com", 22, &original, &path).unwrap(),
            HostKeyStatus::Trusted
        );
        assert!(matches!(
            host_key_status("server.example.com", 22, &changed, &path).unwrap(),
            HostKeyStatus::Changed { .. }
        ));
        assert_eq!(
            host_key_status("relay.example.com", 443, &original, &path).unwrap(),
            HostKeyStatus::Unknown
        );

        let _ = std::fs::remove_file(path);
    }
}
