use crate::crypto::{decrypt_pw, encrypt_pw};
use crate::known_hosts::{self, ScannedKey};
use crate::sessions;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{mpsc as stdmpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct TabHandle {
    pub input_tx: stdmpsc::Sender<Vec<u8>>,
    pub resize_tx: stdmpsc::Sender<(u32, u32)>,
    pub stop_tx: stdmpsc::Sender<()>,
}

#[derive(Default)]
pub struct AppStateInner {
    pub tabs: Mutex<HashMap<String, TabHandle>>,
    pub verify: Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>,
}
pub type AppState = Arc<AppStateInner>;

fn emit_status(app: &AppHandle, tab: &str, status: &str) {
    let _ = app.emit(&format!("ssh-status-{tab}"), json!({ "status": status }));
}

fn emit_data(app: &AppHandle, tab: &str, bytes: &[u8]) {
    let _ = app.emit(&format!("ssh-data-{tab}"), B64.encode(bytes));
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyKey {
    #[serde(rename = "type")]
    pub key_type: String,
    pub sha256: String,
    pub md5: String,
}

async fn ask_verify(
    app: &AppHandle,
    state: &AppState,
    tab: &str,
    payload: Value,
) -> String {
    let _ = app.emit(&format!("ssh-verify-{tab}"), payload);
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    state.verify.lock().unwrap().insert(tab.to_string(), tx);
    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.verify.lock().unwrap().remove(tab);
            "reject".into()
        }
    }
}

pub fn respond_verify(state: &AppState, tab: &str, decision: &str) {
    if let Some(tx) = state.verify.lock().unwrap().remove(tab) {
        let _ = tx.send(decision.to_string());
    }
}

#[derive(Debug, Deserialize)]
pub struct QuickConnect {
    pub host: String,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    pub tab_id: String,
    pub session_id: Option<String>,
    pub quick: Option<QuickConnect>,
    pub term_type: Option<String>,
    pub log_dir: Option<String>,
    pub auto_log: Option<bool>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

struct Cfg {
    tab_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    keyfile: String,
    key_passphrase: String,
    term: String,
    cols: u32,
    rows: u32,
    log_path: Option<String>,
    startup_script: Vec<String>,
    auto_reconnect: bool,
    keepalive_interval: u64,
}

fn session_to_cfg(tab_id: &str, s: &Value, term: Option<String>, log_dir: Option<String>, auto_log: Option<bool>, cols: u32, rows: u32) -> Cfg {
    let strf = |k: &str| s.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let log_session = s.get("logSession").and_then(|v| v.as_bool()).unwrap_or(false)
        || (auto_log.unwrap_or(false) && s.get("logSession").and_then(|v| v.as_bool()).is_none()
            && s.get("logPath").and_then(|v| v.as_str()).map(|x| x.is_empty()).unwrap_or(true));
    let log_path = if log_session {
        Some(resolve_log_path(s.get("logPath").and_then(|v| v.as_str()).unwrap_or(""), &strf("name"), log_dir.as_deref()))
    } else {
        None
    };
    Cfg {
        tab_id: tab_id.to_string(),
        host: strf("host"),
        port: s.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
        username: strf("username"),
        password: decrypt_pw(s.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("")),
        keyfile: strf("keyfile"),
        key_passphrase: decrypt_pw(s.get("keyPassphraseEnc").and_then(|v| v.as_str()).unwrap_or("")),
        term: term.unwrap_or_else(|| "xterm-256color".into()),
        cols, rows,
        log_path,
        startup_script: strf("startupScript").lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        auto_reconnect: s.get("autoReconnect").and_then(|v| v.as_bool()).unwrap_or(true),
        keepalive_interval: s.get("keepaliveInterval").and_then(|v| v.as_u64()).unwrap_or(0),
    }
}

fn resolve_log_path(explicit: &str, name: &str, base: Option<&str>) -> String {
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect();
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let dir = base.map(|s| s.to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| {
        crate::sessions::stored_dir().join("logs").to_string_lossy().to_string()
    });
    let _ = fs::create_dir_all(&dir);
    format!("{dir}/{safe}-{stamp}.log")
}

pub async fn connect(app: AppHandle, state: AppState, args: ConnectArgs) -> anyhow::Result<()> {
    // stop any existing shell for this tab
    disconnect(&state, &args.tab_id);
    let cols = args.cols.unwrap_or(120);
    let rows = args.rows.unwrap_or(30);
    let cfg = if let Some(sid) = &args.session_id {
        let store = sessions::load_store();
        let s = store.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(sid.as_str())).cloned()
            .ok_or_else(|| anyhow::anyhow!("session not found"))?;
        session_to_cfg(&args.tab_id, &s, args.term_type.clone(), args.log_dir.clone(), args.auto_log, cols, rows)
    } else if let Some(q) = &args.quick {
        Cfg {
            tab_id: args.tab_id.clone(),
            host: q.host.clone(), port: q.port.unwrap_or(22),
            username: q.username.clone().unwrap_or_else(|| "root".into()),
            password: q.password.clone().unwrap_or_default(),
            keyfile: String::new(), key_passphrase: String::new(),
            term: args.term_type.clone().unwrap_or_else(|| "xterm-256color".into()),
            cols, rows,
            log_path: if args.auto_log.unwrap_or(false) { Some(resolve_log_path("", &format!("{}@{}", q.username.clone().unwrap_or_default(), q.host), args.log_dir.as_deref())) } else { None },
            startup_script: vec![],
            auto_reconnect: true,
            keepalive_interval: 0,
        }
    } else {
        anyhow::bail!("no session or quick-connect info");
    };
    if cfg.host.is_empty() {
        anyhow::bail!("empty host");
    }
    let (input_tx, input_rx) = stdmpsc::channel::<Vec<u8>>();
    let (resize_tx, resize_rx) = stdmpsc::channel::<(u32, u32)>();
    let (stop_tx, stop_rx) = stdmpsc::channel::<()>();
    state.tabs.lock().unwrap().insert(cfg.tab_id.clone(), TabHandle { input_tx, resize_tx, stop_tx });
    let app2 = app.clone();
    let state2 = state.clone();
    std::thread::spawn(move || run_shell_blocking(app2, state2, cfg, input_rx, resize_rx, stop_rx));
    Ok(())
}

pub fn disconnect(state: &AppState, tab_id: &str) {
    if let Some(h) = state.tabs.lock().unwrap().remove(tab_id) {
        let _ = h.stop_tx.send(());
    }
}

pub fn send_input(state: &AppState, tab_id: &str, b64: &str) {
    let bytes = B64.decode(b64).unwrap_or_default();
    if let Some(h) = state.tabs.lock().unwrap().get(tab_id) {
        let _ = h.input_tx.send(bytes);
    }
}

pub fn resize(state: &AppState, tab_id: &str, cols: u32, rows: u32) {
    if let Some(h) = state.tabs.lock().unwrap().get(tab_id) {
        let _ = h.resize_tx.send((cols, rows));
    }
}

fn verify_hostkey_blocking(app: &AppHandle, state: &AppState, tab: &str, host: &str, port: u16) -> anyhow::Result<Option<(HashSet<String>, Vec<ScannedKey>)>> {
    // run async keyscan/known_hosts from blocking thread via mini runtime
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    rt.block_on(verify_hostkey_async(app, state, tab, host, port))
}

async fn verify_hostkey_async(app: &AppHandle, state: &AppState, tab: &str, host: &str, port: u16) -> anyhow::Result<Option<(HashSet<String>, Vec<ScannedKey>)>> {
    let scanned = match known_hosts::keyscan(host, port).await {
        Ok(k) => k,
        Err(_) => {
            emit_status(app, tab, "warning: host-key prescan failed, will verify at handshake");
            vec![]
        }
    };
    if scanned.is_empty() {
        let known = known_hosts::known_fingerprints(host, port).await;
        if known.is_empty() {
            return Ok(None);
        }
        return Ok(Some((known.clone(), vec![])));
    }
    let known = known_hosts::known_fingerprints(host, port).await;
    if known.is_empty() {
        let keys: Vec<VerifyKey> = scanned.iter().map(|k| VerifyKey { key_type: k.key_type.clone(), sha256: k.sha256.clone(), md5: k.md5.clone() }).collect();
        let d = ask_verify(app, state, tab, serde_json::json!({ "mode": "new", "host": host, "port": port, "keys": keys })).await;
        if d == "save" {
            let _ = known_hosts::save_known_host(&scanned.iter().map(|k| k.line.clone()).collect::<Vec<_>>());
        }
        if d == "reject" {
            anyhow::bail!("host key rejected by user");
        }
        let fps: HashSet<String> = scanned.iter().map(|k| k.sha256.clone()).collect();
        return Ok(Some((fps.clone(), scanned)));
    }
    Ok(Some((known, scanned)))
}

fn run_shell_blocking(
    app: AppHandle,
    state: AppState,
    cfg: Cfg,
    input_rx: stdmpsc::Receiver<Vec<u8>>,
    resize_rx: stdmpsc::Receiver<(u32, u32)>,
    stop_rx: stdmpsc::Receiver<()>,
) {
    let tab = cfg.tab_id.clone();
    emit_status(&app, &tab, "connecting…");
    // TOFU prescan
    let accepted = match verify_hostkey_blocking(&app, &state, &tab, &cfg.host, cfg.port) {
        Ok(a) => a,
        Err(e) => {
            emit_status(&app, &tab, &format!("error: {e}"));
            let _ = app.emit(&format!("ssh-closed-{tab}"), json!({ "code": "closed" }));
            state.tabs.lock().unwrap().remove(&tab);
            return;
        }
    };
    let mut log_file: Option<fs::File> = cfg.log_path.as_ref().and_then(|p| {
        fs::OpenOptions::new().create(true).append(true).open(p).ok()
    });
    if let Some(p) = &cfg.log_path {
        if log_file.is_some() {
            emit_status(&app, &tab, &format!("logging to {p}"));
        }
    }

    for attempt in 1..=4 {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match shell_once(&app, &cfg, &accepted, &input_rx, &resize_rx, &stop_rx, &mut log_file) {
            Ok(ShellEnd::CleanExit) => {
                let _ = app.emit(&format!("ssh-closed-{tab}"), json!({ "code": "closed" }));
                let _ = app.emit(&format!("ssh-exited-{tab}"), json!({}));
                break;
            }
            Ok(ShellEnd::Closed) => {
                let _ = app.emit(&format!("ssh-closed-{tab}"), json!({ "code": "closed" }));
                if cfg.auto_reconnect && attempt < 4 {
                    emit_status(&app, &tab, &format!("reconnecting (attempt {attempt})…"));
                    std::thread::sleep(Duration::from_secs(2 * attempt as u64));
                    continue;
                }
                break;
            }
            Err(e) => {
                // first-attempt errors surface to connect(); later ones show status
                emit_status(&app, &tab, &format!("error: {e}"));
                let _ = app.emit(&format!("ssh-closed-{tab}"), json!({ "code": "closed" }));
                if cfg.auto_reconnect && attempt < 4 && attempt > 1 {
                    std::thread::sleep(Duration::from_secs(2 * attempt as u64));
                    continue;
                }
                break;
            }
        }
    }
    state.tabs.lock().unwrap().remove(&tab);
}

enum ShellEnd {
    CleanExit,
    Closed,
}

fn shell_once(
    app: &AppHandle,
    cfg: &Cfg,
    accepted: &Option<(HashSet<String>, Vec<ScannedKey>)>,
    input_rx: &stdmpsc::Receiver<Vec<u8>>,
    resize_rx: &stdmpsc::Receiver<(u32, u32)>,
    stop_rx: &stdmpsc::Receiver<()>,
    log_file: &mut Option<fs::File>,
) -> anyhow::Result<ShellEnd> {
    let tab = &cfg.tab_id;
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let tcp = TcpStream::connect(&addr)?;
    tcp.set_read_timeout(Some(Duration::from_millis(50)))?;
    let mut sess = ssh2::Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.handshake()?;
    // strict post-handshake host-key check (mirrors makeHostVerifier)
    if let Some((known, _)) = accepted {
        if let Some((key, _kt)) = sess.host_key() {
            let fp = known_hosts::sha256fp(&key);
            if !known.contains(&fp) {
                anyhow::bail!("unknown host key {fp} (rejected)");
            }
        }
    }
    if cfg.keepalive_interval > 0 {
        sess.set_keepalive(true, cfg.keepalive_interval as u32);
    }
    // auth: key first if present, else password
    let mut authed = false;
    if !cfg.keyfile.is_empty() {
        let pass = if cfg.key_passphrase.is_empty() { None } else { Some(cfg.key_passphrase.as_str()) };
        if sess.userauth_pubkey_file(&cfg.username, None, std::path::Path::new(&cfg.keyfile), pass).is_ok() && sess.authenticated() {
            authed = true;
        }
    }
    if !authed {
        if !cfg.password.is_empty() {
            sess.userauth_password(&cfg.username, &cfg.password)?;
        } else {
            anyhow::bail!("no password or key for authentication");
        }
    }
    if !sess.authenticated() {
        anyhow::bail!("authentication failed");
    }
    let mut channel = sess.channel_session()?;
    channel.request_pty(&cfg.term, None, Some((cfg.cols, cfg.rows, 0, 0)))?;
    channel.shell()?;
    sess.set_blocking(false);
    emit_status(app, tab, "connected");
    if let Some(f) = log_file {
        let _ = writeln!(f, "\n===== {} {}@{}:{} =====", chrono::Utc::now().to_rfc3339(), cfg.username, cfg.host, cfg.port);
    }
    for line in &cfg.startup_script {
        let _ = channel.write_all(format!("{line}\n").as_bytes());
    }
    let mut buf = [0u8; 8192];
    loop {
        if stop_rx.try_recv().is_ok() {
            let _ = channel.send_eof();
            let _ = channel.close();
            return Ok(ShellEnd::Closed);
        }
        while let Ok((c, r)) = resize_rx.try_recv() {
            let _ = channel.request_pty_size(c, r, None, None);
        }
        while let Ok(data) = input_rx.try_recv() {
            let _ = channel.write_all(&data);
        }
        match channel.read(&mut buf) {
            Ok(0) => {
                std::thread::sleep(Duration::from_millis(30));
            }
            Ok(n) => {
                emit_data(app, tab, &buf[..n]);
                if let Some(f) = log_file {
                    let _ = f.write_all(&buf[..n]);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        if channel.eof() {
            // drain exit status
            let _ = channel.wait_close();
            // Heuristic matching main.js: if remote sent exit-status, treat as clean logout.
            let saw_exit = channel.exit_status().unwrap_or(-1) == 0 || channel.eof();
            if saw_exit {
                return Ok(ShellEnd::CleanExit);
            }
            return Ok(ShellEnd::Closed);
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SftpEntry {
    pub filename: String,
    pub longname: Option<String>,
    pub attrs: SftpAttrs,
}
#[derive(Debug, Serialize)]
pub struct SftpAttrs {
    pub size: u64,
    pub mode: u32,
    pub mtime: u64,
}

pub fn sftp_list(session_id: &str, remote_path: &str) -> anyhow::Result<Vec<SftpEntry>> {
    let store = sessions::load_store();
    let s = store.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(session_id)).cloned()
        .ok_or_else(|| anyhow::anyhow!("session not found"))?;
    let host = s.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let port = s.get("port").and_then(|v| v.as_u64()).unwrap_or(22);
    let username = s.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let password = decrypt_pw(s.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or(""));
    let keyfile = s.get("keyfile").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let key_pp = decrypt_pw(s.get("keyPassphraseEnc").and_then(|v| v.as_str()).unwrap_or(""));
    let tcp = TcpStream::connect(format!("{host}:{port}"))?;
    let mut sess = ssh2::Session::new()?;
    sess.set_tcp_stream(tcp);
    sess.handshake()?;
    if !keyfile.is_empty() {
        let pp = if key_pp.is_empty() { None } else { Some(key_pp.as_str()) };
        sess.userauth_pubkey_file(&username, None, std::path::Path::new(&keyfile), pp)?;
    } else {
        sess.userauth_password(&username, &password)?;
    }
    if !sess.authenticated() {
        anyhow::bail!("authentication failed");
    }
    let sftp = sess.sftp()?;
    let path = if remote_path.is_empty() { "." } else { remote_path };
    let entries = sftp.readdir(std::path::Path::new(path))?;
    Ok(entries.into_iter().map(|(p, st)| SftpEntry {
        filename: p.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string(),
        longname: None,
        attrs: SftpAttrs { size: st.size.unwrap_or(0), mode: st.perm.unwrap_or(0), mtime: st.mtime.unwrap_or(0) as u64 },
    }).collect())
}

pub fn _encrypt_wrap(p: &str) -> String {
    encrypt_pw(p)
}
