use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The single vault every install starts with. Multi-vault support (future
/// work) adds sibling directories under `vaults/` and a picker to choose
/// which one is active; every store path already resolves through this
/// function so that feature needs no second migration.
pub const DEFAULT_VAULT_ID: &str = "default";

/// Directory holding all per-vault data (hosts, snippets, port forwards,
/// vault crypto/settings, SSH keys) for the given vault id, rooted at the
/// app's data directory.
pub fn vault_dir(app_data_dir: &Path, vault_id: &str) -> PathBuf {
    app_data_dir.join("vaults").join(vault_id)
}

/// Legacy (pre-multi-vault) file and directory names that used to live
/// directly under `app_data_dir`.
const LEGACY_ENTRIES: &[&str] = &[
    "hosts.json",
    "vault.json",
    "vault_settings.json",
    "snippets.json",
    "port_forwards.json",
    "ssh-keys",
];

/// One-time migration: if the default vault directory doesn't exist yet but
/// legacy top-level files do, move them into `vaults/default/`. No-op on a
/// fresh install (nothing legacy to move) and no-op once already migrated
/// (idempotent — safe to call on every startup).
pub fn migrate_legacy_layout(app_data_dir: &Path) -> io::Result<()> {
    let default_dir = vault_dir(app_data_dir, DEFAULT_VAULT_ID);
    if default_dir.exists() {
        return Ok(());
    }

    let legacy_paths: Vec<PathBuf> = LEGACY_ENTRIES
        .iter()
        .map(|name| app_data_dir.join(name))
        .filter(|path| path.exists())
        .collect();

    if legacy_paths.is_empty() {
        return Ok(());
    }

    fs::create_dir_all(&default_dir)?;
    for path in legacy_paths {
        let file_name = path
            .file_name()
            .expect("legacy path always has a file name");
        fs::rename(&path, default_dir.join(file_name))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_moves_legacy_files_into_default_vault() {
        let tmp = std::env::temp_dir().join(format!("termifai-layout-test-{}", uuid_like()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("hosts.json"), "{}").unwrap();
        fs::create_dir_all(tmp.join("ssh-keys")).unwrap();
        fs::write(tmp.join("ssh-keys").join("k1.json"), "{}").unwrap();

        migrate_legacy_layout(&tmp).unwrap();

        let default_dir = vault_dir(&tmp, DEFAULT_VAULT_ID);
        assert!(default_dir.join("hosts.json").exists());
        assert!(default_dir.join("ssh-keys").join("k1.json").exists());
        assert!(!tmp.join("hosts.json").exists());

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn migrate_is_noop_on_fresh_install() {
        let tmp = std::env::temp_dir().join(format!("termifai-layout-test-{}", uuid_like()));
        fs::create_dir_all(&tmp).unwrap();

        migrate_legacy_layout(&tmp).unwrap();

        assert!(!vault_dir(&tmp, DEFAULT_VAULT_ID).exists());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn migrate_is_idempotent_once_default_vault_exists() {
        let tmp = std::env::temp_dir().join(format!("termifai-layout-test-{}", uuid_like()));
        let default_dir = vault_dir(&tmp, DEFAULT_VAULT_ID);
        fs::create_dir_all(&default_dir).unwrap();
        fs::write(tmp.join("hosts.json"), "{}").unwrap();

        migrate_legacy_layout(&tmp).unwrap();

        // Already-migrated installs must not touch a stray legacy file again.
        assert!(tmp.join("hosts.json").exists());
        fs::remove_dir_all(&tmp).ok();
    }

    fn uuid_like() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
