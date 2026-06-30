use argon2::{Algorithm, Argon2, Params, Version};

pub const ARGON2_MEM_KIB: u32 = 19456;
pub const ARGON2_ITERS: u32 = 2;
pub const ARGON2_PARALLELISM: u32 = 1;

#[derive(Debug)]
pub enum CryptoError {
    Argon2,
    BadToken,
    Decrypt,
    WrongPassword,
}

/// Derive the 32-byte Key Encryption Key (KEK) from the master password and
/// the per-vault salt using Argon2id with fixed, cross-platform parameters.
pub fn derive_kek(master_password: &str, salt: &[u8]) -> Result<[u8; 32], CryptoError> {
    let params = Params::new(ARGON2_MEM_KIB, ARGON2_ITERS, ARGON2_PARALLELISM, Some(32))
        .map_err(|_| CryptoError::Argon2)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = [0u8; 32];
    argon
        .hash_password_into(master_password.as_bytes(), salt, &mut kek)
        .map_err(|_| CryptoError::Argon2)?;
    Ok(kek)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_kek_is_deterministic_for_same_inputs() {
        let salt = [7u8; 32];
        let a = derive_kek("hunter2", &salt).unwrap();
        let b = derive_kek("hunter2", &salt).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn derive_kek_differs_for_different_password_or_salt() {
        let salt = [7u8; 32];
        let other_salt = [9u8; 32];
        let base = derive_kek("hunter2", &salt).unwrap();
        assert_ne!(base, derive_kek("hunter3", &salt).unwrap());
        assert_ne!(base, derive_kek("hunter2", &other_salt).unwrap());
    }
}
