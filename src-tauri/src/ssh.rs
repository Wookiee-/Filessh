use crate::crypto::{decrypt_pw, encrypt_pw};
use crate::known_hosts::{self, ScannedKey};
use crate::sessions;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc as stdmpsc, Arc, Mutex};
use std::thread::JoinHandle;
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

/// Phase tracing: visible with FILESSH_DEBUG=1
/// (`flatpak run tech.wookiee.filessh 2>&1 | grep filessh-dbg`).
macro_rules! phasedbg {
    ($tab:expr, $($arg:tt)*) => {
        if std::env::var_os("FILESSH_DEBUG").is_some() {
            eprintln!("filessh-dbg [{}] {}", $tab, format!($($arg)*));
        }
    };
}

/// TCP dial with a hard ceiling: a filtered host must surface "error: …"
/// instead of freezing the tab on "connecting…" forever.
fn dial(host: &str, port: u16) -> anyhow::Result<TcpStream> {
    use std::net::ToSocketAddrs;
    let addr = format!("{host}:{port}")
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("DNS resolution failed for {host}"))?;
    Ok(TcpStream::connect_timeout(&addr, Duration::from_secs(15))?)
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
    jump: Option<JumpCfg>,
    forwards: Vec<Forward>,
}

/// Port-forward rule. `ftype`: local (-L), remote (-R), dynamic (SOCKS -D).
#[derive(Debug, Clone, Default)]
pub struct Forward {
    pub ftype: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

/// Bastion/jump-host credentials (one level; a jump record's own jump is ignored).
#[derive(Debug, Clone, Default)]
pub struct JumpCfg {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub keyfile: String,
    pub key_passphrase: String,
    pub keepalive_interval: u64,
}

fn parse_forwards(s: &Value) -> Vec<Forward> {
    s.get("forwards")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let bind_port = f.get("bindPort").and_then(|v| v.as_u64())? as u16;
                    if bind_port == 0 {
                        return None;
                    }
                    Some(Forward {
                        ftype: f.get("type").and_then(|v| v.as_str()).unwrap_or("local").to_string(),
                        bind_host: f.get("bindHost").and_then(|v| v.as_str()).unwrap_or("127.0.0.1").to_string(),
                        bind_port,
                        target_host: f.get("targetHost").and_then(|v| v.as_str()).unwrap_or("localhost").to_string(),
                        target_port: f.get("targetPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_jump(s: &Value) -> Option<JumpCfg> {
    let jid = s.get("jumpSessionId").and_then(|v| v.as_str()).filter(|id| !id.is_empty())?;
    let store = sessions::load_store();
    let js = store.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(jid))?;
    let j = JumpCfg {
        host: js.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        port: js.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
        username: js.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        password: decrypt_pw(js.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("")),
        keyfile: js.get("keyfile").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        key_passphrase: decrypt_pw(js.get("keyPassphraseEnc").and_then(|v| v.as_str()).unwrap_or("")),
        keepalive_interval: js.get("keepaliveInterval").and_then(|v| v.as_u64()).unwrap_or(0),
    };
    if j.host.is_empty() {
        return None;
    }
    Some(j)
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
        jump: parse_jump(s),
        forwards: parse_forwards(s),
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
            jump: None,
            forwards: vec![],
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

/// libssh2's "try again" sentinel. LIBSSH2_ERROR_EAGAIN is ABI-stable
/// (-37, also visible in trace logs) and the ssh2 crate doesn't re-export
/// the constant, so compare numerically.
fn is_again(e: &ssh2::Error) -> bool {
    matches!(e.code(), ssh2::ErrorCode::Session(-37))
}

enum NbFail {
    Timeout(String),
    Op(ssh2::Error),
}

impl NbFail {
    fn anyhow(self, what: &str) -> anyhow::Error {
        match self {
            NbFail::Timeout(_) => anyhow::anyhow!("{what} timed out"),
            NbFail::Op(e) => anyhow::anyhow!("{what} failed: {e}"),
        }
    }
}

/// Drive one libssh2 call to completion in nonblocking mode: EAGAIN is
/// re-polled until `deadline`. Unlike socket/API timeouts (which libssh2 may
/// ignore in blocking waits), this cannot hang past the deadline.
fn nb<T>(
    deadline: std::time::Instant,
    what: &str,
    mut f: impl FnMut() -> Result<T, ssh2::Error>,
) -> Result<T, NbFail> {
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if is_again(&e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(NbFail::Timeout(format!("{what} timed out")));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(NbFail::Op(e)),
        }
    }
}

/// Key-first, then password, then keyboard-interactive answering every
/// prompt with the password (Electron tryKeyboard parity). Failures fall
/// through to the next method; only a deadline aborts the whole attempt.
fn auth_session(
    sess: &ssh2::Session,
    username: &str,
    password: &str,
    keyfile: &str,
    key_pp: &str,
    deadline: std::time::Instant,
) -> anyhow::Result<()> {
    if !keyfile.is_empty() {
        phasedbg!("auth", "try pubkey file");
        let pp = if key_pp.is_empty() { None } else { Some(key_pp) };
        match nb(deadline, "key auth", || {
            sess.userauth_pubkey_file(username, None, std::path::Path::new(keyfile), pp)
        }) {
            Ok(()) if sess.authenticated() => {
                phasedbg!("auth", "pubkey ok");
                return Ok(());
            }
            Ok(()) => phasedbg!("auth", "pubkey partial, trying password"),
            Err(NbFail::Timeout(t)) => anyhow::bail!("{t}"),
            Err(NbFail::Op(_)) => phasedbg!("auth", "pubkey failed, trying password"),
        }
    }
    if password.is_empty() {
        if keyfile.is_empty() {
            anyhow::bail!("no password or key for authentication");
        }
    } else {
        phasedbg!("auth", "try password");
        match nb(deadline, "password auth", || sess.userauth_password(username, password)) {
            Ok(()) if sess.authenticated() => {
                phasedbg!("auth", "password ok");
                return Ok(());
            }
            Ok(()) => phasedbg!("auth", "password partial, trying keyboard-interactive"),
            Err(NbFail::Timeout(t)) => anyhow::bail!("{t}"),
            Err(NbFail::Op(_)) => phasedbg!("auth", "password failed, trying keyboard-interactive"),
        }
        let mut prompter = PasswordPrompter { password };
        match nb(deadline, "keyboard-interactive auth", || {
            sess.userauth_keyboard_interactive(username, &mut prompter)
        }) {
            Ok(()) if sess.authenticated() => {
                phasedbg!("auth", "keyboard-interactive ok");
                return Ok(());
            }
            Ok(()) => {}
            Err(NbFail::Timeout(t)) => anyhow::bail!("{t}"),
            Err(NbFail::Op(e)) => anyhow::bail!("authentication failed: {e}"),
        }
    }
    if !sess.authenticated() {
        anyhow::bail!("authentication failed");
    }
    Ok(())
}

struct PasswordPrompter<'a> {
    password: &'a str,
}

impl ssh2::KeyboardInteractivePrompt for PasswordPrompter<'_> {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[ssh2::Prompt<'a>],
    ) -> Vec<String> {
        prompts.iter().map(|_| self.password.to_string()).collect()
    }
}

/// Open a direct-tcpip channel through the nonblocking driver (deadline-
/// bounded like everything else; the old fixed-retry loop is subsumed).
fn open_direct(sess: &ssh2::Session, host: &str, port: u16) -> anyhow::Result<ssh2::Channel> {
    let dl = std::time::Instant::now() + Duration::from_secs(30);
    nb(dl, "tunnel channel", || sess.channel_direct_tcpip(host, port, None))
        .map_err(|f| f.anyhow("tunnel channel"))
}

/// Bidirectional copy between a local TCP socket and an SSH channel.
/// Both sides owned; exits on EOF/error or stop flag. Serves -L, -R, -D
/// forwards and the jump-host relay alike.
fn bridge(sock: TcpStream, chan: ssh2::Channel, stop: &AtomicBool) {
    let _ = sock.set_read_timeout(Some(Duration::from_millis(50)));
    let _ = sock.set_write_timeout(Some(Duration::from_secs(5)));
    let mut reader = match sock.try_clone() {
        Ok(r) => r,
        Err(_) => return,
    };
    let _ = reader.set_read_timeout(Some(Duration::from_millis(50)));
    let mut writer = sock;
    let mut ch = chan;
    let mut buf = [0u8; 16384];
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => {
                let _ = ch.send_eof();
                break;
            }
            Ok(n) => {
                if ch.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
            }
            Err(_) => {
                let _ = ch.send_eof();
                break;
            }
        }
        match ch.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                if writer.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        if ch.eof() {
            while let Ok(n) = ch.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if writer.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
            break;
        }
    }
    let _ = ch.close();
}

/// Minimal SOCKS5 (no-auth, CONNECT only) handshake. Returns the requested
/// target; the caller opens the channel and bridges. Mirrors main.js.
fn socks_target(sock: &TcpStream) -> anyhow::Result<(String, u16)> {
    let mut s = sock.try_clone()?;
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut hdr = [0u8; 2];
    s.read_exact(&mut hdr)?;
    if hdr[0] != 0x05 {
        anyhow::bail!("not socks5");
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    s.read_exact(&mut methods)?;
    s.write_all(&[0x05, 0x00])?; // no auth
    let mut req = [0u8; 4];
    s.read_exact(&mut req)?;
    if req[0] != 0x05 || req[1] != 0x01 {
        let _ = s.write_all(&[0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0]);
        anyhow::bail!("only CONNECT supported");
    }
    let (addr, port) = match req[3] {
        0x01 => {
            let mut b = [0u8; 6];
            s.read_exact(&mut b)?;
            (
                format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3]),
                u16::from_be_bytes([b[4], b[5]]),
            )
        }
        0x03 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l)?;
            let mut b = vec![0u8; l[0] as usize + 2];
            s.read_exact(&mut b)?;
            let p = u16::from_be_bytes([b[b.len() - 2], b[b.len() - 1]]);
            (String::from_utf8_lossy(&b[..b.len() - 2]).to_string(), p)
        }
        0x04 => {
            let mut b = [0u8; 18];
            s.read_exact(&mut b)?;
            let groups: Vec<String> = b[..16]
                .chunks(2)
                .map(|g| format!("{:02x}{:02x}", g[0], g[1]))
                .collect();
            (
                groups.join(":"),
                u16::from_be_bytes([b[16], b[17]]),
            )
        }
        _ => {
            let _ = s.write_all(&[0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0]);
            anyhow::bail!("unsupported address type");
        }
    };
    s.write_all(&[0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])?;
    Ok((addr, port))
}

/// Start one thread per forward rule; each accepted connection gets its own
/// thread with its own Session clone (cheap Arc). Returns rule handles for
/// joining on disconnect. Mirrors setupForwards in main.js.
fn setup_forwards(
    app: &AppHandle,
    tab: &str,
    sess: &ssh2::Session,
    forwards: &[Forward],
    stop: &Arc<AtomicBool>,
) -> Vec<JoinHandle<()>> {
    let mut handles = vec![];
    for f in forwards {
        if f.bind_port == 0 {
            continue;
        }
        if f.ftype == "remote" {
            if f.target_port == 0 {
                emit_status(app, tab, &format!("tunnel error (remote {}): missing target port", f.bind_port));
                continue;
            }
            let (listener, _bound) = match sess.channel_forward_listen(f.bind_port, Some(f.bind_host.as_str()), None) {
                Ok(x) => x,
                Err(e) => {
                    emit_status(app, tab, &format!("tunnel error (remote {}): {e}", f.bind_port));
                    continue;
                }
            };
            let (th, tp) = (f.target_host.clone(), f.target_port);
            let stop2 = stop.clone();
            handles.push(std::thread::spawn(move || {
                let mut listener = listener;
                loop {
                    if stop2.load(Ordering::Relaxed) {
                        break;
                    }
                    match listener.accept() {
                        Ok(mut chan) => match dial(&th, tp) {
                            Ok(sock) => {
                                let stop3 = stop2.clone();
                                std::thread::spawn(move || bridge(sock, chan, &stop3));
                            }
                            Err(_) => {
                                let _ = chan.close();
                            }
                        },
                        // EAGAIN on the nonblocking session: no pending connection yet
                        Err(_) => std::thread::sleep(Duration::from_millis(50)),
                    }
                }
            }));
        } else {
            // local (-L) and dynamic SOCKS (-D) share the local listener
            if f.ftype != "dynamic" && f.target_port == 0 {
                emit_status(app, tab, &format!("tunnel error (local {}): missing target port", f.bind_port));
                continue;
            }
            let listener = match TcpListener::bind((f.bind_host.as_str(), f.bind_port)) {
                Ok(l) => l,
                Err(e) => {
                    emit_status(app, tab, &format!("tunnel error ({} {}): {e}", f.ftype, f.bind_port));
                    continue;
                }
            };
            if listener.set_nonblocking(true).is_err() {
                continue;
            }
            let s2 = sess.clone();
            let stop2 = stop.clone();
            let f2 = f.clone();
            handles.push(std::thread::spawn(move || {
                loop {
                    if stop2.load(Ordering::Relaxed) {
                        break;
                    }
                    match listener.accept() {
                        Ok((sock, _)) => {
                            let s3 = s2.clone();
                            let stop3 = stop2.clone();
                            let f3 = f2.clone();
                            std::thread::spawn(move || {
                                if f3.ftype == "dynamic" {
                                    if let Ok((h, p)) = socks_target(&sock) {
                                        if let Ok(ch) = open_direct(&s3, &h, p) {
                                            bridge(sock, ch, &stop3);
                                        }
                                    }
                                } else if let Ok(ch) = open_direct(&s3, &f3.target_host, f3.target_port) {
                                    bridge(sock, ch, &stop3);
                                }
                            });
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(30))
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(30)),
                    }
                }
            }));
        }
    }
    handles
}

struct JumpGuard {
    handle: Option<JoinHandle<()>>,
}

/// Open the target stream through a bastion host: a loopback relay port
/// bridged to a direct-tcpip channel on the jump session, which lives in
/// the relay thread for the duration of the connection.
fn open_jump(
    app: &AppHandle,
    tab: &str,
    jump: &JumpCfg,
    dest_host: &str,
    dest_port: u16,
) -> anyhow::Result<(TcpStream, JumpGuard)> {
    emit_status(app, tab, "via jump host…");
    phasedbg!(tab, "jump dial {}:{}", jump.host, jump.port);
    let tcp = dial(&jump.host, jump.port)?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut jsess = ssh2::Session::new()?;
    jsess.set_timeout(30_000);
    jsess.set_tcp_stream(tcp);
    jsess.set_blocking(false);
    let jdl = std::time::Instant::now() + Duration::from_secs(60);
    nb(jdl, "jump handshake", || jsess.handshake()).map_err(|f| f.anyhow("jump handshake"))?;
    if jump.keepalive_interval > 0 {
        jsess.set_keepalive(true, jump.keepalive_interval as u32);
    }
    auth_session(&jsess, &jump.username, &jump.password, &jump.keyfile, &jump.key_passphrase, jdl)?;
    phasedbg!(tab, "jump authenticated, opening relay");
    let relay = TcpListener::bind("127.0.0.1:0")?;
    let port = relay.local_addr()?.port();
    relay.set_nonblocking(true)?;
    let (dh, dp) = (dest_host.to_string(), dest_port);
    let handle = std::thread::spawn(move || {
        // the target side dials immediately; deadline avoids leaking the
        // thread (and its authenticated session) if it never does
        let start = std::time::Instant::now();
        loop {
            match relay.accept() {
                Ok((sock, _)) => {
                    if let Ok(ch) = open_direct(&jsess, &dh, dp) {
                        let stop = AtomicBool::new(false);
                        bridge(sock, ch, &stop);
                    }
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if start.elapsed() > Duration::from_secs(15) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });
    let stream = TcpStream::connect(("127.0.0.1", port))?;
    Ok((stream, JumpGuard { handle: Some(handle) }))
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
    phasedbg!(tab, "run start (build: dial-timeout+api-timeout+kbdint+auth-watchdog)");
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
        // Transport per attempt: jump relay re-established each time, like the
        // Electron client opening a fresh forwardOut per attempt.
        let mut jguard: Option<JumpGuard> = None;
        let outcome: anyhow::Result<ShellEnd> = (|| {
            let stream = match &cfg.jump {
                Some(j) => {
                    let (s, g) = open_jump(&app, &tab, j, &cfg.host, cfg.port)?;
                    jguard = Some(g);
                    s
                }
                None => {
                    phasedbg!(tab, "dial {}:{}", cfg.host, cfg.port);
                    dial(&cfg.host, cfg.port)?
                }
            };
            shell_once(&app, &state, &cfg, stream, &accepted, &input_rx, &resize_rx, &stop_rx, &mut log_file)
        })();
        if let Some(mut g) = jguard.take() {
            if let Some(h) = g.handle.take() {
                let _ = h.join();
            }
        }
        match outcome {
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
    state: &AppState,
    cfg: &Cfg,
    stream: TcpStream,
    accepted: &Option<(HashSet<String>, Vec<ScannedKey>)>,
    input_rx: &stdmpsc::Receiver<Vec<u8>>,
    resize_rx: &stdmpsc::Receiver<(u32, u32)>,
    stop_rx: &stdmpsc::Receiver<()>,
    log_file: &mut Option<fs::File>,
) -> anyhow::Result<ShellEnd> {
    let tab = &cfg.tab_id;
    // Generous timeouts for handshake/auth round-trips (WAN RTTs dwarf the
    // interactive latency budget). try_clone shares the same socket, so the
    // timeout can be tightened once the shell is interactive below.
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let tuner = stream.try_clone()?;
    let mut sess = ssh2::Session::new()?;
    sess.set_timeout(30_000); // backstop; the nb() driver below is the real ceiling
    sess.set_tcp_stream(stream);
    // Nonblocking from the start: every setup call below is EAGAIN-polled
    // with our own deadline, so no libssh2 wait can wedge the tab.
    sess.set_blocking(false);
    let setup_dl = std::time::Instant::now() + Duration::from_secs(60);
    phasedbg!(tab, "handshake");
    nb(setup_dl, "handshake", || sess.handshake()).map_err(|f| f.anyhow("handshake"))?;
    phasedbg!(tab, "handshake ok");
    // Strict post-handshake host-key check. Known prescan keys pass silently;
    // an unknown presented key prompts (changed-key warning) like makeHostVerifier.
    if let Some((known, _)) = accepted {
        if let Some((key, _kt)) = sess.host_key() {
            let fp = known_hosts::sha256fp(&key);
            if !known.contains(&fp) {
                let ktype = known_hosts::parse_key_type(&key);
                let b64 = B64.encode(key);
                let known_list: Vec<&String> = known.iter().collect();
                let payload = json!({
                    "mode": "changed", "host": cfg.host, "port": cfg.port,
                    "keys": [{ "type": ktype, "sha256": fp.clone(), "md5": known_hosts::md5fp(key) }],
                    "known": known_list,
                });
                let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
                let d = rt.block_on(ask_verify(app, state, tab, payload));
                if d == "save" {
                    let line = if cfg.port == 22 {
                        format!("{} {ktype} {b64}", cfg.host)
                    } else {
                        format!("[{}]:{} {ktype} {b64}", cfg.host, cfg.port)
                    };
                    let _ = known_hosts::save_known_host(&[line]);
                }
                if d != "save" && d != "once" {
                    anyhow::bail!("host key rejected by user");
                }
                phasedbg!(tab, "changed key accepted once");
            } else {
                phasedbg!(tab, "host key matches");
            }
        }
    }
    if cfg.keepalive_interval > 0 {
        sess.set_keepalive(true, cfg.keepalive_interval as u32);
    }
    // Auth runs through the same nonblocking driver (deadline-bounded).
    // The old helper-thread watchdog is gone: nb() cannot hang, so there is
    // nothing to outlive the attempt and wedge the shared session lock.
    auth_session(&sess, &cfg.username, &cfg.password, &cfg.keyfile, &cfg.key_passphrase, setup_dl)?;
    phasedbg!(tab, "authenticated");
    let mut channel = nb(setup_dl, "open channel", || sess.channel_session()).map_err(|f| f.anyhow("open channel"))?;
    phasedbg!(tab, "channel open");
    nb(setup_dl, "pty request", || {
        channel.request_pty(&cfg.term, None, Some((cfg.cols, cfg.rows, 0, 0)))
    })
    .map_err(|f| f.anyhow("pty request"))?;
    phasedbg!(tab, "pty ok");
    nb(setup_dl, "shell request", || channel.shell()).map_err(|f| f.anyhow("shell request"))?;
    phasedbg!(tab, "shell ok");
    // Interactive phase: tight latency budget for the shell/forward loops.
    let _ = tuner.set_read_timeout(Some(Duration::from_millis(50)));
    emit_status(app, tab, "connected");
    phasedbg!(tab, "shell open");
    if let Some(f) = log_file {
        let _ = writeln!(f, "\n===== {} {}@{}:{} =====", chrono::Utc::now().to_rfc3339(), cfg.username, cfg.host, cfg.port);
    }
    for line in &cfg.startup_script {
        let _ = channel.write_all(format!("{line}\n").as_bytes());
    }
    let stop_flag = Arc::new(AtomicBool::new(false));
    let fwd_handles = setup_forwards(app, tab, &sess, &cfg.forwards, &stop_flag);
    let mut buf = [0u8; 8192];
    let end = loop {
        if stop_rx.try_recv().is_ok() {
            let _ = channel.send_eof();
            let _ = channel.close();
            break ShellEnd::Closed;
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
                break ShellEnd::CleanExit;
            }
            break ShellEnd::Closed;
        }
    };
    stop_flag.store(true, Ordering::Relaxed);
    for h in fwd_handles {
        let _ = h.join();
    }
    Ok(end)
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
    let tcp = dial(&host, port as u16)?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut sess = ssh2::Session::new()?;
    sess.set_timeout(30_000);
    sess.set_tcp_stream(tcp);
    sess.set_blocking(false);
    let sdl = std::time::Instant::now() + Duration::from_secs(60);
    nb(sdl, "sftp handshake", || sess.handshake()).map_err(|f| f.anyhow("sftp handshake"))?;
    auth_session(&sess, &username, &password, &keyfile, &key_pp, sdl)?;
    let sftp = nb(sdl, "sftp open", || sess.sftp()).map_err(|f| f.anyhow("sftp open"))?;
    let path = if remote_path.is_empty() { "." } else { remote_path };
    let entries = nb(sdl, "sftp list", || sftp.readdir(std::path::Path::new(path))).map_err(|f| f.anyhow("sftp list"))?;
    Ok(entries.into_iter().map(|(p, st)| SftpEntry {
        filename: p.file_name().and_then(|x| x.to_str()).unwrap_or("").to_string(),
        longname: None,
        attrs: SftpAttrs { size: st.size.unwrap_or(0), mode: st.perm.unwrap_or(0), mtime: st.mtime.unwrap_or(0) as u64 },
    }).collect())
}

pub fn _encrypt_wrap(p: &str) -> String {
    encrypt_pw(p)
}

#[cfg(test)]
mod forward_tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parse_forwards_filters_and_defaults() {
        let v = serde_json::json!({"forwards": [
            {"type": "local", "bindHost": "127.0.0.1", "bindPort": 8080, "targetHost": "example.com", "targetPort": 80},
            {"type": "dynamic", "bindPort": 1080},
            {"type": "local", "bindPort": 0, "targetHost": "x", "targetPort": 1},
            {"type": "remote", "bindHost": "0.0.0.0", "bindPort": 2222, "targetHost": "localhost", "targetPort": 22},
        ]});
        let f = parse_forwards(&v);
        assert_eq!(f.len(), 3); // bindPort 0 dropped
        assert_eq!(f[0].ftype, "local");
        assert_eq!(f[0].target_host, "example.com");
        assert_eq!(f[1].ftype, "dynamic");
        assert_eq!(f[1].bind_port, 1080);
        assert_eq!(f[2].ftype, "remote");
    }

    #[test]
    fn socks_handshake_domain_connect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (server_sock, _) = listener.accept().unwrap();
            socks_target(&server_sock).unwrap()
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        c.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut resp = [0u8; 2];
        c.read_exact(&mut resp).unwrap();
        assert_eq!(resp, [0x05, 0x00]);
        let mut req = vec![0x05, 0x01, 0x00, 0x03, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&8080u16.to_be_bytes());
        c.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        c.read_exact(&mut rep).unwrap();
        assert_eq!(&rep[..2], &[0x05, 0x00]);
        let (host, p) = h.join().unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(p, 8080);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    /// Live round-trip through connect auth + PTY shell against the same
    /// fake ssh2 server test/e2e.js uses (tester/testpw). Guards the
    /// auth_session refactor and shell plumbing.
    #[test]
    fn live_password_shell_echo() {
        let server_js = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test")
            .join("fake-server.js");
        assert!(server_js.is_file());
        let mut child = Command::new("node")
            .arg(&server_js)
            .arg("2224")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("node fake server");
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let mut up = false;
        for _ in 0..100 {
            match lines.next() {
                Some(Ok(l)) if l.contains("FAKE_SSH_UP") => {
                    up = true;
                    break;
                }
                _ => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        assert!(up, "fake server did not start");
        // drop the reader (closes our copy of the pipe) so the child never blocks on stdout
        drop(lines);

        let result = (|| -> anyhow::Result<()> {
            let tcp = TcpStream::connect("127.0.0.1:2224")?;
            tcp.set_read_timeout(Some(Duration::from_secs(5)))?;
            let mut sess = ssh2::Session::new()?;
            sess.set_tcp_stream(tcp);
            sess.set_blocking(false); // mirror production: everything below goes through nb()
            let dl = std::time::Instant::now() + Duration::from_secs(30);
            nb(dl, "handshake", || sess.handshake()).map_err(|f| f.anyhow("handshake"))?;
            auth_session(&sess, "tester", "testpw", "", "", dl)?;
            let mut channel = nb(dl, "open channel", || sess.channel_session()).map_err(|f| f.anyhow("open channel"))?;
            nb(dl, "pty", || channel.request_pty("xterm-256color", None, Some((80, 24, 0, 0))))
                .map_err(|f| f.anyhow("pty"))?;
            nb(dl, "shell", || channel.shell()).map_err(|f| f.anyhow("shell"))?;
            channel.write_all(b"echo hi\n")?;
            let mut out = String::new();
            let mut buf = [0u8; 1024];
            let start = std::time::Instant::now();
            while start.elapsed() < Duration::from_secs(10) {
                match channel.read(&mut buf) {
                    Ok(n) => {
                        out.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if out.contains("hi\n") {
                            return Ok(());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(e) => anyhow::bail!("read: {e}"),
                }
            }
            anyhow::bail!("no echo, got: {out:?}")
        })();
        let _ = child.kill();
        let _ = child.wait();
        result.unwrap();
    }
}


#[cfg(test)]
mod pwprobe_tests {
    use super::*;
    #[test]
    #[ignore]
    fn time_wrong_password_wan() {
        // Safe: single failed attempt, exercises the exact hanging call.
        let start = std::time::Instant::now();
        let tcp = TcpStream::connect("74.91.114.239:22").unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let mut sess = ssh2::Session::new().unwrap();
        sess.set_timeout(20_000);
        sess.set_tcp_stream(tcp);
        sess.handshake().unwrap();
        eprintln!("handshake took {:?}", start.elapsed());
        let r = sess.userauth_password("root", "definitely-wrong-pw-12345");
        eprintln!("userauth_password returned after {:?}: {:?}", start.elapsed(), r.map(|_| "ok").map_err(|e| e.to_string()));
        assert!(start.elapsed() < Duration::from_secs(25), "HUNG in password auth");
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    /// Traced handshake + auth-method query against a real WAN host (no
    /// credentials: "none" auth only). Diagnoses transport/auth-layer stalls
    /// that localhost tests can't reproduce.
    /// WAN-dependent: ignored by default, run explicitly for diagnosis.
    #[test]
    #[ignore]
    fn traced_auth_methods_wan() {
        let (tx, rx) = stdmpsc::channel();
        std::thread::spawn(move || {
            let r = (|| -> anyhow::Result<String> {
                let tcp = TcpStream::connect("74.91.114.239:22")?;
                tcp.set_read_timeout(Some(Duration::from_secs(10)))?;
                let mut sess = ssh2::Session::new()?;
                sess.trace(
                    ssh2::TraceFlags::AUTH
                        | ssh2::TraceFlags::TRANS
                        | ssh2::TraceFlags::KEX
                        | ssh2::TraceFlags::ERROR
                        | ssh2::TraceFlags::SOCKET,
                );
                sess.set_tcp_stream(tcp);
                sess.handshake()?;
                Ok(sess.auth_methods("root")?.to_string())
            })();
            let _ = tx.send(format!("{r:?}"));
        });
        match rx.recv_timeout(Duration::from_secs(25)) {
            Ok(s) => {
                println!("AUTH_METHODS: {s}");
                assert!(s.starts_with("Ok"), "auth query failed: {s}");
            }
            Err(_) => panic!("HUNG in handshake/auth_methods (see libssh2 trace above)"),
        }
    }
}

#[cfg(test)]
mod handshake_bisect_tests {
    use super::*;

    fn variant(name: &str, setup: fn(TcpStream) -> ssh2::Session, secs: u64) -> bool {
        let (tx, rx) = stdmpsc::channel();
        std::thread::spawn(move || {
            let r = (|| -> anyhow::Result<()> {
                let tcp = TcpStream::connect("74.91.114.239:22")?;
                let mut sess = setup(tcp);
                sess.handshake()?;
                Ok(())
            })();
            let _ = tx.send(format!("{r:?}"));
        });
        match rx.recv_timeout(Duration::from_secs(secs)) {
            Ok(s) => {
                eprintln!("{name}: finished -> {s}");
                s.starts_with("Ok")
            }
            Err(_) => {
                eprintln!("{name}: HUNG past {secs}s");
                false
            }
        }
    }

    fn plain(tcp: TcpStream) -> ssh2::Session {
        tcp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut s = ssh2::Session::new().unwrap();
        s.set_tcp_stream(tcp);
        s
    }
    fn with_big_timeout(tcp: TcpStream) -> ssh2::Session {
        tcp.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let _tuner = tcp.try_clone().unwrap();
        std::mem::forget(_tuner);
        let mut s = ssh2::Session::new().unwrap();
        s.set_tcp_stream(tcp);
        s
    }
    fn with_api_timeout(tcp: TcpStream) -> ssh2::Session {
        tcp.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let _tuner = tcp.try_clone().unwrap();
        std::mem::forget(_tuner);
        let mut s = ssh2::Session::new().unwrap();
        s.set_timeout(30_000);
        s.set_tcp_stream(tcp);
        s
    }

    #[test]
    #[ignore]
    fn bisect_handshake_hang() {
        assert!(variant("V1 plain", plain, 25), "control failed?!");
        assert!(variant("V2 +30s+tuner", with_big_timeout, 40));
        assert!(variant("V3 +api_timeout", with_api_timeout, 45));
    }
}
