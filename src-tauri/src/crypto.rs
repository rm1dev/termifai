use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD as B64;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use rand::RngCore;
use zeroize::{Zeroize, ZeroizeOnDrop};

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

/// The symmetric Data Encryption Key (DEK) that protects host passwords.
/// Held only in memory while the vault is unlocked; zeroized on drop.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct VaultKey([u8; 32]);

impl VaultKey {
    pub fn from_bytes(bytes: [u8; 32]) -> VaultKey {
        VaultKey(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Encrypt one password into a `"v1:nonce:ciphertext"` token (ChaCha20-Poly1305,
/// fresh 12-byte random nonce per call).
pub fn encrypt_field(key: &VaultKey, plaintext: &str) -> Result<String, CryptoError> {
    let cipher = ChaCha20Poly1305::new(key.as_bytes().into());
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| CryptoError::Decrypt)?;
    Ok(format!(
        "v1:{}:{}",
        B64.encode(nonce_bytes),
        B64.encode(ciphertext)
    ))
}

/// Decrypt a `"v1:nonce:ciphertext"` token back to plaintext.
pub fn decrypt_field(key: &VaultKey, token: &str) -> Result<String, CryptoError> {
    let mut parts = token.splitn(3, ':');
    let version = parts.next().ok_or(CryptoError::BadToken)?;
    let nonce_b64 = parts.next().ok_or(CryptoError::BadToken)?;
    let ct_b64 = parts.next().ok_or(CryptoError::BadToken)?;
    if version != "v1" {
        return Err(CryptoError::BadToken);
    }
    let nonce_bytes = B64.decode(nonce_b64).map_err(|_| CryptoError::BadToken)?;
    let ciphertext = B64.decode(ct_b64).map_err(|_| CryptoError::BadToken)?;
    if nonce_bytes.len() != 12 {
        return Err(CryptoError::BadToken);
    }
    let cipher = ChaCha20Poly1305::new(key.as_bytes().into());
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| CryptoError::Decrypt)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::Decrypt)
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

    #[test]
    fn encrypt_then_decrypt_roundtrips() {
        let key = VaultKey::from_bytes([3u8; 32]);
        let token = encrypt_field(&key, "s3cr3t-p@ss").unwrap();
        assert!(token.starts_with("v1:"));
        assert_eq!(decrypt_field(&key, &token).unwrap(), "s3cr3t-p@ss");
    }

    #[test]
    fn encrypt_uses_fresh_nonce_each_call() {
        let key = VaultKey::from_bytes([3u8; 32]);
        let a = encrypt_field(&key, "same").unwrap();
        let b = encrypt_field(&key, "same").unwrap();
        assert_ne!(a, b, "nonce reuse — tokens must differ");
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let key = VaultKey::from_bytes([3u8; 32]);
        let token = encrypt_field(&key, "secret").unwrap();
        let wrong = VaultKey::from_bytes([4u8; 32]);
        assert!(matches!(decrypt_field(&wrong, &token), Err(CryptoError::Decrypt)));
    }

    #[test]
    fn decrypt_rejects_malformed_token() {
        let key = VaultKey::from_bytes([3u8; 32]);
        assert!(matches!(decrypt_field(&key, "not-a-token"), Err(CryptoError::BadToken)));
        assert!(matches!(decrypt_field(&key, "v1:only-one-part"), Err(CryptoError::BadToken)));
    }
}
