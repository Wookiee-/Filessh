mod crypto;
mod filezilla;
mod formats;
mod known_hosts;
mod sessions;
mod ssh;

use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, State};

type SharedState = Arc<ssh::AppStateInner>;

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Test-only guard that redirects HOME + XDG_CONFIG_HOME (dirs crate reads
/// both per call) and restores them on drop. Hold TEST_ENV_LOCK while alive.
#[cfg(test)]
pub(crate) struct EnvGuard {
    prev_home: Option<std::ffi::OsString>,
    prev_xdg: Option<std::ffi::OsString>,
}

#[cfg(test)]
impl EnvGuard {
    pub(crate) fn redirect(home: &std::path::Path, xdg: &std::path::Path) -> Self {
        let prev_home = std::env::var_os("HOME");
        let prev_xdg = std::env::var_os("XDG_CONFIG_HOME");
        std::env::set_var("HOME", home);
        std::env::set_var("XDG_CONFIG_HOME", xdg);
        Self { prev_home, prev_xdg }
    }
}

#[cfg(test)]
impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match &self.prev_xdg {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
    }
}

// ---- sessions ----
#[tauri::command]
fn sessions_list() -> Vec<Value> {
    sessions::load_store().iter().map(sessions::to_safe).collect()
}

#[tauri::command]
fn sessions_save(input: Value) -> Result<Value, String> {
    let parsed: sessions::SaveInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
    sessions::save_session(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn sessions_delete(id: String) -> Result<bool, String> {
    let store = sessions::load_store();
    let next: Vec<Value> = store
        .into_iter()
        .filter(|s| s.get("id").and_then(|v| v.as_str()) != Some(id.as_str()))
        .collect();
    sessions::save_store(&next).map_err(|e| e.to_string())?;
    Ok(true)
}

// ---- import / export ----
#[tauri::command]
fn import_filezilla_xml(xml: String) -> Result<Value, String> {
    import_xml_inner(&xml).map_err(|e| e.to_string())
}

fn import_xml_inner(xml: &str) -> anyhow::Result<Value> {
    let (parsed, skipped) = filezilla::parse_filezilla_xml(xml, false);
    let mut store = sessions::load_store();
    let mut keys: std::collections::HashSet<String> =
        store.iter().map(|s| format!("{}@{}:{}", s.get("username").and_then(|v| v.as_str()).unwrap_or(""), s.get("host").and_then(|v| v.as_str()).unwrap_or(""), s.get("port").and_then(|v| v.as_u64()).unwrap_or(22))).collect();
    let mut added = 0;
    for (i, fz) in parsed.iter().enumerate() {
        let key = format!("{}@{}:{}", fz.username, fz.host, fz.port);
        if keys.contains(&key) {
            continue;
        }
        let rec = serde_json::json!({
            "id": format!("fz-{}-{i}", chrono::Utc::now().timestamp_millis().to_string()),
            "name": fz.name, "host": fz.host, "port": fz.port,
            "username": fz.username,
            "authType": if fz.auth_type == "key" { "key" } else { "password" },
            "passwordEnc": if fz.password.is_empty() { String::new() } else { crypto::encrypt_pw(&fz.password) },
            "keyfile": fz.keyfile,
            "startupScript": "", "autoReconnect": true, "favorite": false,
            "source": "filezilla",
            "createdAt": chrono::Utc::now().to_rfc3339(),
        });
        store.push(rec);
        keys.insert(key);
        added += 1;
    }
    sessions::save_store(&store)?;
    Ok(serde_json::json!({ "added": added, "total": parsed.len(), "skipped": skipped }))
}

#[tauri::command]
fn import_json_file(text: String) -> Result<Value, String> {
    (|| -> anyhow::Result<Value> {
        let arr: Vec<Value> = serde_json::from_str(&text)?;
        if arr.is_empty() && !text.trim().starts_with('[') {
            anyhow::bail!("JSON must be an array of sessions");
        }
        let mut store = sessions::load_store();
        let mut ids: std::collections::HashSet<String> = store.iter().filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(|x| x.to_string())).collect();
        let mut keys: std::collections::HashSet<String> = store.iter().map(|s| format!("{}@{}:{}", s.get("username").and_then(|v| v.as_str()).unwrap_or(""), s.get("host").and_then(|v| v.as_str()).unwrap_or(""), s.get("port").and_then(|v| v.as_u64()).unwrap_or(22))).collect();
        let mut added = 0;
        for r in &arr {
            let host = r.get("host").and_then(|v| v.as_str()).unwrap_or("");
            if host.is_empty() {
                continue;
            }
            if let Some(id) = r.get("id").and_then(|v| v.as_str()) {
                if ids.contains(id) {
                    continue;
                }
            }
            let key = format!("{}@{}:{}", r.get("username").and_then(|v| v.as_str()).unwrap_or(""), host, r.get("port").and_then(|v| v.as_u64()).unwrap_or(22));
            if keys.contains(&key) {
                continue;
            }
            let mut rec = r.clone();
            if let Some(m) = rec.as_object_mut() {
                m.remove("password");
                if !m.contains_key("id") {
                    m.insert("id".into(), serde_json::json!(format!("s-{}-{added}", chrono::Utc::now().timestamp_millis().to_string())));
                }
            }
            if let Some(id) = rec.get("id").and_then(|v| v.as_str()).map(|x| x.to_string()) {
                ids.insert(id);
            }
            keys.insert(key);
            store.push(rec);
            added += 1;
        }
        sessions::save_store(&store)?;
        Ok(serde_json::json!({ "added": added, "total": arr.len(), "skipped": [] }))
    })()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn import_csv_file(text: String) -> Result<Value, String> {
    (|| -> anyhow::Result<Value> {
        let rows = formats::parse_csv(&text);
        let mut store = sessions::load_store();
        let mut keys: std::collections::HashSet<String> = store.iter().map(|s| format!("{}@{}:{}", s.get("username").and_then(|v| v.as_str()).unwrap_or(""), s.get("host").and_then(|v| v.as_str()).unwrap_or(""), s.get("port").and_then(|v| v.as_u64()).unwrap_or(22))).collect();
        let mut added = 0;
        for r in &rows {
            let host = r.get("host").cloned().unwrap_or_default();
            if host.is_empty() {
                continue;
            }
            let port: u16 = r.get("port").and_then(|v| v.parse().ok()).unwrap_or(22);
            let username = r.get("username").cloned().unwrap_or_else(|| "root".into());
            let key = format!("{username}@{host}:{port}");
            if keys.contains(&key) {
                continue;
            }
            let pw = r.get("password").cloned().unwrap_or_default();
            let kf = r.get("keyfile").cloned().unwrap_or_default();
            store.push(serde_json::json!({
                "id": format!("s-{}-{added}", chrono::Utc::now().timestamp_millis().to_string()),
                "name": r.get("name").cloned().unwrap_or_else(|| host.clone()),
                "host": host, "port": port, "username": username,
                "authType": if kf.is_empty() { "password" } else { "key" },
                "keyfile": kf,
                "passwordEnc": if pw.is_empty() { String::new() } else { crypto::encrypt_pw(&pw) },
                "startupScript": "", "autoReconnect": true, "source": "csv",
                "createdAt": chrono::Utc::now().to_rfc3339(),
            }));
            keys.insert(key);
            added += 1;
        }
        sessions::save_store(&store)?;
        Ok(serde_json::json!({ "added": added, "total": rows.len(), "skipped": [] }))
    })()
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_file_dialog(app: AppHandle) -> Result<Value, String> {
    let path = rfd::AsyncFileDialog::new()
        .add_filter("Session files", &["xml", "json", "csv"])
        .add_filter("All files", &["*"])
        .pick_file()
        .await;
    let Some(f) = path else { return Ok(Value::Null) };
    let text = std::fs::read_to_string(f.path()).map_err(|e| e.to_string())?;
    let ext = f.path().extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let _ = app;
    match ext.as_str() {
        "json" => import_json_file(text),
        "csv" => import_csv_file(text),
        _ => import_filezilla_xml(text),
    }
}

#[tauri::command]
fn import_autodetect() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    [home.join(".config").join("filezilla").join("sitemanager.xml"), home.join(".filezilla").join("sitemanager.xml")]
        .into_iter()
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn export_file_dialog(format: String) -> Result<Value, String> {
    let (def_name, label, exts) = match format.as_str() {
        "json" => ("filessh-sessions.json", "JSON backup", vec!["json"]),
        "csv" => ("filessh-sessions.csv", "CSV", vec!["csv"]),
        _ => ("filessh-sitemanager.xml", "FileZilla XML", vec!["xml"]),
    };
    let path = rfd::AsyncFileDialog::new()
        .set_file_name(def_name)
        .add_filter(label, &exts)
        .save_file()
        .await;
    let Some(f) = path else { return Ok(Value::Null) };
    let store = sessions::load_store();
    let text = if format == "json" {
        let safe: Vec<Value> = store.iter().map(|s| {
            let mut m = s.as_object().cloned().unwrap_or_default();
            m.remove("password");
            Value::Object(m)
        }).collect();
        serde_json::to_string_pretty(&safe).map_err(|e| e.to_string())?
    } else if format == "csv" {
        let rows: Vec<formats::ExportRow> = store.iter().map(|s| formats::ExportRow {
            name: s.get("name").and_then(|v| v.as_str()).unwrap_or("").into(),
            host: s.get("host").and_then(|v| v.as_str()).unwrap_or("").into(),
            port: s.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
            username: s.get("username").and_then(|v| v.as_str()).unwrap_or("").into(),
            password: crypto::decrypt_pw(s.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("")),
            keyfile: s.get("keyfile").and_then(|v| v.as_str()).unwrap_or("").into(),
        }).collect();
        formats::to_csv(&rows)
    } else {
        let rows: Vec<formats::ExportRow> = store.iter().map(|s| formats::ExportRow {
            name: s.get("name").and_then(|v| v.as_str()).unwrap_or("").into(),
            host: s.get("host").and_then(|v| v.as_str()).unwrap_or("").into(),
            port: s.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
            username: s.get("username").and_then(|v| v.as_str()).unwrap_or("").into(),
            password: crypto::decrypt_pw(s.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("")),
            keyfile: s.get("keyfile").and_then(|v| v.as_str()).unwrap_or("").into(),
        }).collect();
        formats::to_filezilla_xml(&rows)
    };
    std::fs::write(f.path(), text).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "filePath": f.path().to_string_lossy(), "count": store.len() }))
}

#[tauri::command]
async fn pick_file(title: Option<String>, save: Option<bool>, default_path: Option<String>) -> Result<Option<String>, String> {
    if save.unwrap_or(false) {
        let mut d = rfd::AsyncFileDialog::new();
        if let Some(t) = title { d = d.set_title(t); }
        if let Some(p) = default_path { d = d.set_file_name(p); }
        Ok(d.save_file().await.map(|f| f.path().to_string_lossy().to_string()))
    } else {
        let mut d = rfd::AsyncFileDialog::new();
        if let Some(t) = title { d = d.set_title(t); }
        Ok(d.pick_file().await.map(|f| f.path().to_string_lossy().to_string()))
    }
}

// ---- ssh ----
#[tauri::command]
async fn ssh_connect(app: AppHandle, state: State<'_, SharedState>, args: Value) -> Result<bool, String> {
    let parsed: ssh::ConnectArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let st: SharedState = (*state).clone();
    ssh::connect(app, st, parsed).await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn ssh_input(state: State<'_, SharedState>, tab_id: String, data: String) {
    ssh::send_input(&state, &tab_id, &data);
}

#[tauri::command]
fn ssh_resize(state: State<'_, SharedState>, tab_id: String, cols: u32, rows: u32) {
    ssh::resize(&state, &tab_id, cols, rows);
}

#[tauri::command]
fn ssh_disconnect(state: State<'_, SharedState>, tab_id: String) -> bool {
    ssh::disconnect(&state, &tab_id);
    true
}

#[tauri::command]
fn ssh_verify_response(state: State<'_, SharedState>, tab_id: String, decision: String) {
    ssh::respond_verify(&state, &tab_id, &decision);
}

#[tauri::command]
async fn sftp_list(session_id: String, remote_path: Option<String>) -> Result<Value, String> {
    let list = tokio::task::spawn_blocking(move || ssh::sftp_list(&session_id, remote_path.as_deref().unwrap_or(".")))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    serde_json::to_value(&list).map_err(|e| e.to_string())
}

fn main() {
    // WebKitGTK's DMABUF renderer hits "Error 71 (Protocol error)" on many
    // Wayland compositors (notably KDE/KWin + certain GPUs). Disable it
    // in-process so both `tauri dev` and the bundled app work on Wayland
    // without the user exporting anything. Respects an explicit user value.
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let state: SharedState = Arc::new(ssh::AppStateInner::default());
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            sessions_list, sessions_save, sessions_delete,
            import_filezilla_xml, import_json_file, import_csv_file,
            import_file_dialog, import_autodetect, export_file_dialog, pick_file,
            ssh_connect, ssh_input, ssh_resize, ssh_disconnect, ssh_verify_response,
            sftp_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
