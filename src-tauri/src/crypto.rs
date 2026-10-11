use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

fn key_path() -> PathBuf {
    // Must live next to sessions.json (which may be the host ~/.config copy
    // when running sandboxed), otherwise saved passwords won't decrypt.
    crate::sessions::stored_dir().join(".key")
}

fn fallback_key() -> anyhow::Result<[u8; 32]> {
    let p = key_path();
    if let Ok(b) = fs::read(&p) {
        if b.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&b);
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&p, k)?;
    let mut perm = fs::metadata(&p)?.permissions();
    perm.set_mode(0o600);
    fs::set_permissions(&p, perm)?;
    Ok(k)
}

pub fn aes_encrypt(plain: &str) -> anyhow::Result<String> {
    let key = fallback_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let ct = cipher
        .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    // ssh2-style split: last 16 bytes are tag
    let (data, tag) = ct.split_at(ct.len().saturating_sub(16).max(0));
    // Actually aes-gcm crate appends tag; we stored iv:tag:ct like JS.
    // JS used separate tag; here tag = last 16 bytes.
    Ok(format!(
        "aes:{}:{}:{}",
        B64.encode(iv),
        B64.encode(tag),
        B64.encode(data)
    ))
}

pub fn aes_decrypt(enc: &str) -> anyhow::Result<String> {
    let parts: Vec<&str> = enc.split(':').collect();
    anyhow::ensure!(parts.len() == 4 && parts[0] == "aes", "bad aes payload");
    let key = fallback_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let iv = B64.decode(parts[1])?;
    let tag = B64.decode(parts[2])?;
    let data = B64.decode(parts[3])?;
    let mut combined = data;
    combined.extend_from_slice(&tag);
    let pt = cipher
        .decrypt(Nonce::from_slice(&iv), combined.as_slice())
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    Ok(String::from_utf8(pt)?)
}

/// Mirrors main.js decryptPw: plain: > aes: > legacy base64.
pub fn decrypt_pw(enc: &str) -> String {
    if enc.is_empty() {
        return String::new();
    }
    if let Some(rest) = enc.strip_prefix("plain:") {
        return rest.to_string();
    }
    if enc.starts_with("aes:") {
        return aes_decrypt(enc).unwrap_or_default();
    }
    // legacy: base64 utf8 (Electron safeStorage off path)
    B64.decode(enc)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default()
}

pub fn encrypt_pw(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    aes_encrypt(plain).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aes_roundtrip_and_plain_compat() {
        // serialize with sessions::roundtrip_tests (both swap HOME/XDG)
        let _g = crate::TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("filessh-crypto-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let _env = crate::EnvGuard::redirect(&tmp, &tmp);
        let enc = aes_encrypt("hello-world").unwrap();
        assert!(enc.starts_with("aes:"));
        assert_eq!(aes_decrypt(&enc).unwrap(), "hello-world");
        assert_eq!(decrypt_pw("plain:testpw"), "testpw");
        assert_eq!(decrypt_pw(""), "");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
