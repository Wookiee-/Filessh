use crate::crypto::{decrypt_pw, encrypt_pw};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

fn candidates() -> Vec<PathBuf> {
    let mut out = vec![];
    if let Some(cfg) = dirs::config_dir() {
        out.push(cfg.join("filessh").join("sessions.json"));
        out.push(cfg.join("Filessh").join("sessions.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        // portable fallback next to binary
        out.push(exe.parent().unwrap_or(std::path::Path::new(".")).join("sessions.json"));
    }
    out
}

pub fn store_path() -> PathBuf {
    let c = candidates();
    for p in &c {
        if p.exists() {
            return p.clone();
        }
    }
    c.into_iter().next().unwrap()
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
