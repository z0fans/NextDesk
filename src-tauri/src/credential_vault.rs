use keyring_core::{Entry, Error};

const SERVICE_NAME: &str = "com.nextdesk.ssh";

pub fn initialize() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let store = apple_native_keyring_store::keychain::Store::new()
            .map_err(|error| format!("credential_vault_unavailable:{error}"))?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let store = windows_native_keyring_store::Store::new()
            .map_err(|error| format!("credential_vault_unavailable:{error}"))?;
        keyring_core::set_default_store(store);
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("credential_vault_unsupported_platform".to_string())
}

fn entry(reference: &str) -> Result<Entry, String> {
    validate_reference(reference)?;
    Entry::new(SERVICE_NAME, reference).map_err(vault_error)
}

fn validate_reference(reference: &str) -> Result<(), String> {
    let reference = reference.trim();
    if reference.is_empty() || reference.len() > 128 {
        return Err("credential_reference_invalid".to_string());
    }
    if !reference
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("credential_reference_invalid".to_string());
    }
    Ok(())
}

pub fn store(reference: &str, secret: &str) -> Result<(), String> {
    if secret.is_empty() || secret.len() > 64 * 1024 {
        return Err("credential_secret_invalid".to_string());
    }
    entry(reference)?.set_password(secret).map_err(vault_error)
}

pub fn load(reference: &str) -> Result<String, String> {
    entry(reference)?.get_password().map_err(vault_error)
}

pub fn exists(reference: &str) -> Result<bool, String> {
    match entry(reference)?.get_password() {
        Ok(_) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(vault_error(error)),
    }
}

pub fn delete(reference: &str) -> Result<(), String> {
    match entry(reference)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(vault_error(error)),
    }
}

fn vault_error(error: Error) -> String {
    match error {
        Error::NoEntry => "credential_not_found".to_string(),
        other => format!("credential_vault_error:{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{delete, exists, load, store};

    #[test]
    fn credential_vault_round_trips_without_persisting_in_app_state() {
        keyring_core::set_default_store(
            keyring_core::mock::Store::new().expect("mock keyring should initialize"),
        );
        let reference = "ssh-test-password";

        store(reference, "correct horse battery staple").unwrap();
        assert!(exists(reference).unwrap());
        assert_eq!(load(reference).unwrap(), "correct horse battery staple");

        delete(reference).unwrap();
        assert!(!exists(reference).unwrap());
    }
}
