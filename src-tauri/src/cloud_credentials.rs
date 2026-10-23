//! Cloud token storage and the transition from legacy device credentials.
//! New tokens use immutable vault entries; config publication is the commit point.

use crate::config;
use keyring_core::{Entry, Error};
use rand::RngCore;
use std::path::{Path, PathBuf};

const SERVICE: &str = "com.nextdesk.cloud";
#[cfg(target_os = "macos")]
const LEGACY_SERVICE: &str = "NextDesk Connect Gateway";

trait TokenStore {
    fn read(&self, reference: &str) -> Result<String, String>;
    fn write(&self, reference: &str, token: &str) -> Result<(), String>;
    fn remove(&self, reference: &str) -> Result<(), String>;
    fn legacy_read(&self, device_id: &str) -> Result<String, String>;
    fn legacy_remove(&self, device_id: &str) -> Result<(), String>;
}

struct SystemStore;

fn entry(reference: &str) -> Result<Entry, String> {
    if reference.len() != 64 || !reference.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("cloud_credential_reference_invalid".into());
    }
    Entry::new(SERVICE, reference).map_err(|_| "cloud_credential_vault_unavailable".into())
}

fn legacy_path(root: &Path, device_id: &str) -> Result<PathBuf, String> {
    if device_id.is_empty()
        || device_id.len() > 128
        || !device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        return Err("cloud_device_id_invalid".into());
    }
    Ok(root.join(format!("cloud_device_{device_id}.token")))
}

impl TokenStore for SystemStore {
    fn read(&self, reference: &str) -> Result<String, String> {
        let bytes = entry(reference)?
            .get_secret()
            .map_err(|_| "cloud_credential_read_failed")?;
        String::from_utf8(bytes).map_err(|_| "cloud_credential_encoding_invalid".into())
    }
    fn write(&self, reference: &str, token: &str) -> Result<(), String> {
        entry(reference)?
            .set_secret(token.as_bytes())
            .map_err(|_| "cloud_credential_write_failed".into())
    }
    fn remove(&self, reference: &str) -> Result<(), String> {
        match entry(reference)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err("cloud_credential_delete_failed".into()),
        }
    }
    fn legacy_read(&self, device_id: &str) -> Result<String, String> {
        let path = legacy_path(&config::get_user_config_dir(), device_id)?;
        #[cfg(target_os = "macos")]
        {
            let result = std::process::Command::new("/usr/bin/security")
                .args([
                    "find-generic-password",
                    "-s",
                    LEGACY_SERVICE,
                    "-a",
                    device_id,
                    "-w",
                ])
                .output()
                .map_err(|_| "cloud_legacy_keychain_unavailable")?;
            if result.status.success() {
                return String::from_utf8(result.stdout)
                    .map(|value| value.trim().to_string())
                    .map_err(|_| "cloud_credential_encoding_invalid".into());
            }
            // A locked/denied keychain must not be interpreted as an absent credential.
            if result.status.code() != Some(44) {
                return Err("cloud_legacy_keychain_read_failed".into());
            }
        }
        std::fs::read_to_string(path)
            .map(|value| value.trim().to_string())
            .map_err(|_| "cloud_legacy_credential_not_found".into())
    }
    fn legacy_remove(&self, device_id: &str) -> Result<(), String> {
        let path = legacy_path(&config::get_user_config_dir(), device_id)?;
        #[cfg(target_os = "macos")]
        let keychain_removed = std::process::Command::new("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-s",
                LEGACY_SERVICE,
                "-a",
                device_id,
            ])
            .output()
            .is_ok_and(|result| result.status.success() || result.status.code() == Some(44));
        #[cfg(not(target_os = "macos"))]
        let keychain_removed = true;
        // A denied legacy keychain item must not prevent removing the plaintext copy.
        let file_removed = match std::fs::remove_file(path) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
        if keychain_removed && file_removed {
            Ok(())
        } else {
            Err("cloud_legacy_credential_delete_failed".into())
        }
    }
}

fn stage_and_commit<T>(
    store: &impl TokenStore,
    token: &str,
    commit: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    if token.trim().is_empty() || token.len() > 64 * 1024 {
        return Err("cloud_credential_invalid".into());
    }
    let mut random = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let reference: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let result = (|| {
        store.write(&reference, token)?;
        if store.read(&reference)? != token {
            return Err("cloud_credential_verification_failed".into());
        }
        commit(&reference)
    })();
    if result.is_err() && store.remove(&reference).is_err() {
        log::warn!("[cloud-auth] Uncommitted vault entry could not be removed");
    }
    result
}

pub fn store_and_commit<T>(
    token: &str,
    commit: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    stage_and_commit(&SystemStore, token, commit)
}

fn migrate(
    store: &impl TokenStore,
    device_id: &str,
    commit: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    let token = store.legacy_read(device_id)?;
    stage_and_commit(store, &token, commit)?;
    // The published vault reference is authoritative even if old-storage cleanup fails.
    if store.legacy_remove(device_id).is_err() {
        log::warn!("[cloud-auth] Legacy credential cleanup pending; retrying on next vault read");
    }
    Ok(token)
}

fn load_with_store(
    store: &impl TokenStore,
    device_id: &str,
    reference: &str,
    commit: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    if reference.is_empty() {
        return migrate(store, device_id, commit);
    }
    let token = store.read(reference)?;
    if store.legacy_remove(device_id).is_err() {
        log::warn!("[cloud-auth] Legacy credential cleanup pending");
    }
    Ok(token)
}

pub fn load(
    device_id: &str,
    reference: &str,
    commit: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    load_with_store(&SystemStore, device_id, reference, commit)
}

fn cleanup_legacy(device_id: &str) {
    if !device_id.is_empty() && SystemStore.legacy_remove(device_id).is_err() {
        log::warn!("[cloud-auth] Legacy credential cleanup pending");
    }
}

pub fn retire(reference: &str, device_id: &str) {
    if !reference.is_empty() && SystemStore.remove(reference).is_err() {
        log::warn!("[cloud-auth] Retired vault credential cleanup pending");
    }
    cleanup_legacy(device_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    #[derive(Default)]
    struct Store {
        vault: RefCell<HashMap<String, String>>,
        legacy: RefCell<HashMap<String, String>>,
        fail_write: Cell<bool>,
        fail_read: Cell<bool>,
        fail_cleanup: Cell<bool>,
    }
    impl TokenStore for Store {
        fn read(&self, reference: &str) -> Result<String, String> {
            if self.fail_read.get() {
                return Err("read failed".into());
            }
            self.vault
                .borrow()
                .get(reference)
                .cloned()
                .ok_or("missing".into())
        }
        fn write(&self, reference: &str, token: &str) -> Result<(), String> {
            if self.fail_write.get() {
                return Err("vault locked".into());
            }
            self.vault
                .borrow_mut()
                .insert(reference.into(), token.into());
            Ok(())
        }
        fn remove(&self, reference: &str) -> Result<(), String> {
            self.vault.borrow_mut().remove(reference);
            Ok(())
        }
        fn legacy_read(&self, device: &str) -> Result<String, String> {
            self.legacy
                .borrow()
                .get(device)
                .cloned()
                .ok_or("missing".into())
        }
        fn legacy_remove(&self, device: &str) -> Result<(), String> {
            if self.fail_cleanup.get() {
                return Err("cleanup failed".into());
            }
            self.legacy.borrow_mut().remove(device);
            Ok(())
        }
    }

    #[test]
    fn failed_config_commit_preserves_the_active_token_and_removes_staged_token() {
        let store = Store::default();
        store
            .vault
            .borrow_mut()
            .insert("old-reference".into(), "old-token".into());
        let result = stage_and_commit(&store, "new-token", |reference| {
            assert_eq!(store.read(reference).unwrap(), "new-token");
            assert_eq!(store.read("old-reference").unwrap(), "old-token");
            Err::<(), _>("config disk full".into())
        });
        assert_eq!(result.unwrap_err(), "config disk full");
        assert_eq!(store.vault.borrow().len(), 1);
        assert_eq!(store.read("old-reference").unwrap(), "old-token");
    }

    #[test]
    fn published_config_contains_a_verified_reference_and_never_the_token() {
        let store = Store::default();
        let fixture = crate::config::tests::TestConfig::new();
        stage_and_commit(&store, "private-cloud-token", |reference| {
            crate::config::update_saved_config_at(&fixture.path, |saved| {
                saved.cloud_credential_reference = reference.to_string();
                Ok(())
            })
        })
        .unwrap();
        let raw = std::fs::read_to_string(&fixture.path).unwrap();
        assert!(!raw.contains("private-cloud-token"));
        let saved: crate::config::SavedConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            store.read(&saved.cloud_credential_reference).unwrap(),
            "private-cloud-token"
        );
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_commit_failure_preserves_the_previous_config_and_vault_entry() {
        use std::os::unix::fs::PermissionsExt;
        let store = Store::default();
        let fixture = crate::config::tests::TestConfig::new();
        store
            .vault
            .borrow_mut()
            .insert("old-reference".into(), "old-token".into());
        crate::config::update_saved_config_at(&fixture.path, |saved| {
            saved.cloud_credential_reference = "old-reference".into();
            Ok(())
        })
        .unwrap();
        let before = std::fs::read(&fixture.path).unwrap();
        let parent = fixture.path.parent().unwrap();
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = stage_and_commit(&store, "new-token", |reference| {
            crate::config::update_saved_config_at(&fixture.path, |saved| {
                saved.cloud_credential_reference = reference.to_string();
                Ok(())
            })
        });
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&fixture.path).unwrap(), before);
        assert_eq!(store.vault.borrow().len(), 1);
        assert_eq!(store.read("old-reference").unwrap(), "old-token");
    }

    #[test]
    fn failed_vault_write_or_readback_never_publishes_a_reference() {
        for fail_write in [true, false] {
            let store = Store::default();
            store.fail_write.set(fail_write);
            store.fail_read.set(!fail_write);
            assert!(
                stage_and_commit(&store, "token", |_| -> Result<(), String> {
                    panic!("must not commit")
                })
                .is_err()
            );
            assert!(store.vault.borrow().is_empty());
        }
    }

    #[test]
    fn migration_keeps_legacy_until_verified_vault_and_config_commit_succeed() {
        let store = Store::default();
        store
            .legacy
            .borrow_mut()
            .insert("device".into(), "legacy-token".into());
        assert!(migrate(&store, "device", |_| Err("write failed".into())).is_err());
        assert!(store.vault.borrow().is_empty());
        assert_eq!(store.legacy_read("device").unwrap(), "legacy-token");
        let mut published = String::new();
        let token = migrate(&store, "device", |reference| {
            assert_eq!(store.read(reference).unwrap(), "legacy-token");
            assert_eq!(store.legacy_read("device").unwrap(), "legacy-token");
            published = reference.into();
            Ok(())
        })
        .unwrap();
        assert_eq!(store.read(&published).unwrap(), token);
        assert!(store.legacy.borrow().is_empty());
    }

    #[test]
    fn legacy_cleanup_failure_leaves_a_usable_published_vault_token() {
        let store = Store::default();
        store.fail_cleanup.set(true);
        store
            .legacy
            .borrow_mut()
            .insert("device".into(), "token".into());
        let mut published = String::new();
        assert_eq!(
            migrate(&store, "device", |r| {
                published = r.into();
                Ok(())
            })
            .unwrap(),
            "token"
        );
        assert_eq!(store.read(&published).unwrap(), "token");
        assert_eq!(store.legacy_read("device").unwrap(), "token");
    }

    #[test]
    fn vault_failure_never_falls_back_to_legacy_after_migration() {
        let store = Store::default();
        store
            .legacy
            .borrow_mut()
            .insert("device".into(), "obsolete-token".into());
        store.fail_read.set(true);
        assert!(
            load_with_store(&store, "device", "published-reference", |_| panic!(
                "must not migrate"
            ))
            .is_err()
        );
        assert_eq!(store.legacy_read("device").unwrap(), "obsolete-token");
    }

    #[test]
    fn legacy_device_ids_cannot_escape_the_config_directory() {
        let root = Path::new("fixture");
        for device in ["../other", "a/b", "a\\b", "", "/absolute"] {
            assert!(legacy_path(root, device).is_err());
        }
        assert_eq!(
            legacy_path(root, "device_1-2").unwrap(),
            root.join("cloud_device_device_1-2.token")
        );
        assert!(entry("arbitrary-service-reference").is_err());
    }
}
