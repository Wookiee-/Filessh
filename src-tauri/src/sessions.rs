use crate::crypto::{decrypt_pw, encrypt_pw};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

/// Config bases in priority order. Flatpak redirects XDG_CONFIG_HOME into
/// ~/.var/..., so dirs::config_dir() alone misses the real sessions even
/// though --filesystem=home keeps them readable. $HOME/.config always wins
/// when it holds the store; otherwise fall back to the platform config dir
/// (Electron-era capital-F dir, then portable exe dir, included as leaves).
fn candidate_bases() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![];
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".config"));
    }
    if let Some(cfg) = dirs::config_dir() {
        if !out.contains(&cfg) {
            out.push(cfg);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if !out.contains(&parent.to_path_buf()) {
                out.push(parent.to_path_buf());
            }
        }
    }
    out
}

pub(crate) fn stored_dir() -> PathBuf {
    for base in candidate_bases() {
        for leaf in ["filessh", "Filessh"] {
            if base.join(leaf).join("sessions.json").is_file() {
                return base.join(leaf);
            }
        }
    }
    // portable installs keep sessions.json next to the binary (old behavior)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if parent.join("sessions.json").is_file() {
                return parent.to_path_buf();
            }
        }
    }
    candidate_bases()
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("filessh")
}

pub fn store_path() -> PathBuf {
    stored_dir().join("sessions.json")
}

pub fn load_store() -> Vec<Value> {
    let p = store_path();
    match fs::read_to_string(&p) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => vec![],
    }
}

pub fn save_store(sessions: &[Value]) -> anyhow::Result<()> {
    let p = store_path();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&p, serde_json::to_string_pretty(sessions)?)?;
    Ok(())
}

fn get_str(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Safe copy for the UI: strip secrets, add hasPassword flags.
/// Mirrors sessions:list in main.js.
pub fn to_safe(v: &Value) -> Value {
    let mut m = v.as_object().cloned().unwrap_or_default();
    let has_pw = m
        .get("passwordEnc")
        .and_then(|x| x.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let has_kp = m
        .get("keyPassphraseEnc")
        .and_then(|x| x.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    m.remove("passwordEnc");
    m.remove("keyPassphraseEnc");
    m.insert("password".into(), Value::Null);
    m.insert("hasPassword".into(), Value::Bool(has_pw));
    m.insert("hasKeyPassphrase".into(), Value::Bool(has_kp));
    Value::Object(m)
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SaveInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// Mirrors sessions:save in main.js.
pub fn save_session(input: SaveInput) -> anyhow::Result<Value> {
    let mut store = load_store();
    let id = input.id.clone().unwrap_or_else(|| {
        format!("s-{}", chrono::Utc::now().timestamp_millis().to_string())
    });
    // find existing
    let pos = store.iter().position(|s| s.get("id").and_then(|x| x.as_str()) == Some(id.as_str()));
    let mut rec: Map<String, Value> = if let Some(i) = pos {
        store[i].as_object().cloned().unwrap_or_default()
    } else {
        Map::new()
    };
    rec.insert("id".into(), Value::String(id.clone()));
    if let Some(v) = input.name { rec.insert("name".into(), Value::String(v)); }
    if let Some(v) = input.host { rec.insert("host".into(), Value::String(v)); }
    if let Some(v) = input.port { rec.insert("port".into(), Value::Number(v.into())); }
    if let Some(v) = input.username { rec.insert("username".into(), Value::String(v)); }
    if let Some(v) = input.auth_type { rec.insert("authType".into(), Value::String(v)); }
    for (k, v) in input.rest {
        if k == "passwordEnc" || k == "keyPassphraseEnc" || k == "password" || k == "keyPassphrase" {
            continue;
        }
        rec.insert(k, v);
    }
    if let Some(pw) = input.password {
        rec.insert(
            "passwordEnc".into(),
            Value::String(if pw.is_empty() { String::new() } else { encrypt_pw(&pw) }),
        );
    }
    if let Some(kp) = input.key_passphrase {
        // JS uses keyPassphrase -> keyPassphraseEnc
        rec.insert(
            "keyPassphraseEnc".into(),
            Value::String(if kp.is_empty() { String::new() } else { encrypt_pw(&kp) }),
        );
    }
    // Frontend sends keyPassphrase under snake? accept both via flatten already handled;
    // also accept camelCase keyPassphrase from JSON flattened rest:
    if let Some(Value::String(kp)) = rec.get("keyPassphrase").cloned() {
        rec.insert("keyPassphraseEnc".into(), Value::String(if kp.is_empty() { String::new() } else { encrypt_pw(&kp) }));
        rec.remove("keyPassphrase");
    }
    rec.remove("password");
    let now = Utc::now().to_rfc3339();
    rec.insert("updatedAt".into(), Value::String(now.clone()));
    if !rec.contains_key("createdAt") {
        rec.insert("createdAt".into(), Value::String(now));
    }
    let val = Value::Object(rec);
    if let Some(i) = pos {
        store[i] = val.clone();
    } else {
        store.push(val.clone());
    }
    save_store(&store)?;
    Ok(to_safe(&val))
}

#[allow(dead_code)]
pub fn session_password(s: &Value) -> String {
    decrypt_pw(s.get("passwordEnc").and_then(|x| x.as_str()).unwrap_or(""))
}

#[allow(dead_code)]
pub fn session_key_passphrase(s: &Value) -> String {
    decrypt_pw(s.get("keyPassphraseEnc").and_then(|x| x.as_str()).unwrap_or(""))
}

#[allow(dead_code)]
pub fn _get_str(v: &Value, k: &str) -> String {
    get_str(v, k)
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct ImportResult {
    pub added: usize,
    pub total: usize,
    pub skipped: Vec<Value>,
}

#[cfg(test)]
mod roundtrip_tests {
    use super::*;
    #[test]
    fn edit_user_and_password_persist() {
        // isolate store + key file via HOME+XDG (mirrors openEditor save payload)
        let _g = crate::TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("filessh-edit-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let _env = crate::EnvGuard::redirect(&tmp, &tmp);
        let created = save_session(
            serde_json::from_value(serde_json::json!({
                "name": "ls", "host": "96.30.196.167", "port": 22,
                "username": "mbiiez", "authType": "password", "password": "oldpw"
            }))
            .unwrap(),
        )
        .unwrap();
        let id = created.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let updated = save_session(
            serde_json::from_value(serde_json::json!({
                "id": id, "name": "ls", "host": "96.30.196.167", "port": 22,
                "username": "newuser", "authType": "password", "password": "newpw",
                "keyfile": "", "startupScript": "", "autoReconnect": true
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(updated.get("username").and_then(|v| v.as_str()), Some("newuser"));
        let store = load_store();
        let rec = store
            .iter()
            .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            .unwrap();
        assert_eq!(rec.get("username").and_then(|v| v.as_str()), Some("newuser"));
        let enc = rec.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("");
        assert!(!enc.is_empty());
        assert_eq!(crate::crypto::decrypt_pw(enc), "newpw");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn flatpak_layout_finds_host_store() {
        // Flatpak redirects XDG_CONFIG_HOME to ~/.var/... while $HOME keeps
        // the real sessions + key. stored_dir() must prefer the host copy.
        let _g = crate::TEST_ENV_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join(format!("filessh-fp-{}", std::process::id()));
        let fake_home = base.join("home");
        let fake_var = base.join("var-config"); // redirected, stays empty
        std::fs::create_dir_all(&fake_var).unwrap();
        {
            let _env = crate::EnvGuard::redirect(&fake_home, &fake_home.join(".config"));
            save_session(
                serde_json::from_value(serde_json::json!({
                    "name": "host-site", "host": "example.com", "port": 22,
                    "username": "u", "authType": "password", "password": "secretpw"
                }))
                .unwrap(),
            )
            .unwrap();
            assert!(fake_home.join(".config").join("filessh").join("sessions.json").is_file());
        }
        {
            let _env = crate::EnvGuard::redirect(&fake_home, &fake_var);
            assert_eq!(
                store_path(),
                fake_home.join(".config").join("filessh").join("sessions.json")
            );
            let store = load_store();
            assert_eq!(store.len(), 1);
            let enc = store[0].get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("");
            // key file followed the store, so the password still decrypts
            assert_eq!(crate::crypto::decrypt_pw(enc), "secretpw");
        }
        std::fs::remove_dir_all(&base).ok();
    }
}
