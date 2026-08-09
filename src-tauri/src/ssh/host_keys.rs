use russh::keys::ssh_key::PublicKey;
use serde::Serialize;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::types::SshKnownHostEntry;

static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());
const KNOWN_HOSTS_SIZE_LIMIT: usize = 1024 * 1024;
const KNOWN_HOSTS_ENTRY_LIMIT: usize = 4096;

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
        .filter_map(|line| retain_known_host_line(line, &[host_token.as_str()]))
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

fn read_known_hosts(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) if contents.len() <= KNOWN_HOSTS_SIZE_LIMIT => Ok(contents),
        Ok(_) => Err("ssh_known_hosts_too_large".to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("ssh_known_hosts_read_failed:{error}")),
    }
}

fn parse_entry_line(line: &str) -> Result<Option<(String, PublicKey, String)>, String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return Ok(None);
    }
    let mut fields = line.split_whitespace();
    let hosts = fields
        .next()
        .filter(|value| !value.is_empty() && value.len() <= 2048)
        .ok_or_else(|| "ssh_known_hosts_import_invalid".to_string())?;
    if hosts.starts_with('@') || hosts.split(',').any(|host| host.is_empty()) {
        return Err("ssh_known_hosts_import_invalid".to_string());
    }
    let algorithm = fields
        .next()
        .ok_or_else(|| "ssh_known_hosts_import_invalid".to_string())?;
    let encoded = fields
        .next()
        .ok_or_else(|| "ssh_known_hosts_import_invalid".to_string())?;
    let public_key_text = format!("{algorithm} {encoded}");
    let public_key = PublicKey::from_openssh(&public_key_text)
        .map_err(|_| "ssh_known_hosts_import_invalid".to_string())?;
    let normalized = public_key
        .to_openssh()
        .map_err(|_| "ssh_known_hosts_import_invalid".to_string())?;
    Ok(Some((hosts.to_string(), public_key, normalized)))
}

fn retain_known_host_line(line: &str, removed_hosts: &[&str]) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return Some(line.to_string());
    }
    let mut fields = trimmed.splitn(2, char::is_whitespace);
    let hosts = fields.next().unwrap_or_default();
    let remainder = fields.next().unwrap_or_default().trim_start();
    let retained = hosts
        .split(',')
        .filter(|host| !removed_hosts.contains(host))
        .collect::<Vec<_>>();
    if retained.len() == hosts.split(',').count() {
        return Some(line.to_string());
    }
    if retained.is_empty() {
        return None;
    }
    Some(format!("{} {remainder}", retained.join(",")))
}

pub fn list_known_hosts(path: &Path) -> Result<Vec<SshKnownHostEntry>, String> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "ssh_known_hosts_lock_failed".to_string())?;
    let contents = read_known_hosts(path)?;
    let mut entries = Vec::new();
    for line in contents.lines() {
        let Some((hosts, public_key, normalized)) = parse_entry_line(line)? else {
            continue;
        };
        for host in hosts.split(',') {
            entries.push(SshKnownHostEntry {
                host: host.to_string(),
                algorithm: public_key.algorithm().to_string(),
                fingerprint: fingerprint(&public_key),
                public_key: normalized.clone(),
            });
            if entries.len() > KNOWN_HOSTS_ENTRY_LIMIT {
                return Err("ssh_known_hosts_too_many_entries".to_string());
            }
        }
    }
    Ok(entries)
}

pub fn remove_known_host(host: &str, path: &Path) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() || host.len() > 2048 || host.chars().any(char::is_whitespace) {
        return Err("ssh_known_host_invalid".to_string());
    }
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "ssh_known_hosts_lock_failed".to_string())?;
    let contents = read_known_hosts(path)?;
    let retained = contents
        .lines()
        .filter_map(|line| retain_known_host_line(line, &[host]))
        .collect::<Vec<_>>();
    let unchanged = retained.join("\n") == contents.trim_end_matches('\n');
    if unchanged {
        return Ok(());
    }
    let mut updated = retained.join("\n");
    if !updated.is_empty() {
        updated.push('\n');
    }
    std::fs::write(path, updated).map_err(|error| format!("ssh_known_hosts_write_failed:{error}"))
}

pub fn import_known_hosts(imported: &str, path: &Path) -> Result<usize, String> {
    if imported.len() > KNOWN_HOSTS_SIZE_LIMIT {
        return Err("ssh_known_hosts_too_large".to_string());
    }
    let mut normalized_entries = Vec::new();
    let mut imported_hosts = Vec::new();
    for line in imported.lines() {
        let Some((hosts, _public_key, normalized)) = parse_entry_line(line)? else {
            continue;
        };
        imported_hosts.extend(hosts.split(',').map(str::to_string));
        normalized_entries.push(format!("{hosts} {normalized}"));
        if normalized_entries.len() > KNOWN_HOSTS_ENTRY_LIMIT {
            return Err("ssh_known_hosts_too_many_entries".to_string());
        }
    }
    if normalized_entries.is_empty() {
        return Err("ssh_known_hosts_import_empty".to_string());
    }

    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "ssh_known_hosts_lock_failed".to_string())?;
    let existing = read_known_hosts(path)?;
    let removed_hosts = imported_hosts
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut retained = existing
        .lines()
        .filter_map(|line| retain_known_host_line(line, &removed_hosts))
        .collect::<Vec<_>>();
    retained.extend(normalized_entries);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("ssh_known_hosts_create_failed:{error}"))?;
    }
    let mut updated = retained.join("\n");
    updated.push('\n');
    std::fs::write(path, updated)
        .map_err(|error| format!("ssh_known_hosts_write_failed:{error}"))?;
    Ok(imported_hosts.len())
}

pub fn export_known_hosts(path: &Path) -> Result<String, String> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "ssh_known_hosts_lock_failed".to_string())?;
    read_known_hosts(path)
}

#[cfg(test)]
mod tests {
    use super::{
        export_known_hosts, host_key_status, import_known_hosts, list_known_hosts,
        remove_known_host, trust_host_key, HostKeyStatus,
    };

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

    #[test]
    fn lists_imports_exports_and_removes_managed_host_keys() {
        let path = std::env::temp_dir().join(format!(
            "nextdesk-known-hosts-manager-{}",
            rand::random::<u64>()
        ));
        let imported = "server.example.com,[server.example.com]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n";

        assert_eq!(import_known_hosts(imported, &path).unwrap(), 2);
        let entries = list_known_hosts(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host, "server.example.com");
        assert!(entries[0].fingerprint.starts_with("SHA256:"));
        assert!(export_known_hosts(&path).unwrap().contains("ssh-ed25519"));

        remove_known_host("server.example.com", &path).unwrap();
        let entries = list_known_hosts(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host, "[server.example.com]:2222");
        let _ = std::fs::remove_file(path);
    }
}
