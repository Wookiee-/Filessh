use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub fn sha256fp(buf: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(buf);
    format!("SHA256:{}", B64.encode(h.finalize()).trim_end_matches('='))
}

pub fn md5fp(buf: &[u8]) -> String {
    let d = md5::compute(buf);
    hex::encode(d.0)
        .as_bytes()
        .chunks(2)
        .map(|c| String::from_utf8_lossy(c).to_string())
        .collect::<Vec<_>>()
        .join(":")
}

pub fn known_hosts_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh").join("known_hosts")
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ScannedKey {
    pub key_type: String,
    pub b64: String,
    pub sha256: String,
    pub md5: String,
    pub line: String,
}

pub async fn keyscan(host: &str, port: u16) -> anyhow::Result<Vec<ScannedKey>> {
    let out = timeout(
        Duration::from_secs(15),
        Command::new("ssh-keyscan")
            .args(["-p", &port.to_string(), "-t", "rsa,ecdsa,ed25519", host])
            .output(),
    )
    .await??;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut keys = vec![];
    for line in stdout.lines() {
        let t = line.trim();
        // "<host> <type> <b64>"
        let mut parts = t.split_whitespace();
        let _host = parts.next();
        let typ = parts.next().unwrap_or("");
        let b64 = parts.next().unwrap_or("");
        if typ.is_empty() || b64.is_empty() {
            continue;
        }
        if B64.decode(b64).is_err() {
            continue;
        }
        let buf = B64.decode(b64).unwrap();
        keys.push(ScannedKey {
            key_type: typ.to_string(),
            b64: b64.to_string(),
            sha256: sha256fp(&buf),
            md5: md5fp(&buf),
            line: t.to_string(),
        });
    }
    Ok(keys)
}

pub async fn known_fingerprints(host: &str, port: u16) -> HashSet<String> {
    let mut fps = HashSet::new();
    let path = known_hosts_path();
    let path_s = path.to_string_lossy().to_string();
    let mut forms = vec![format!("[{host}]:{port}")];
    if port == 22 {
        forms.push(host.to_string());
    }
    for form in forms {
        let r = timeout(
            Duration::from_secs(10),
            Command::new("ssh-keygen")
                .args(["-l", "-F", &form, "-f", &path_s])
                .output(),
        )
        .await;
        if let Ok(Ok(out)) = r {
            let s = String::from_utf8_lossy(&out.stdout);
            for cap in s.split_whitespace() {
                if cap.starts_with("SHA256:") {
                    fps.insert(cap.trim().to_string());
                }
            }
        }
    }
    fps
}

pub fn save_known_host(lines: &[String]) -> anyhow::Result<()> {
    let kh = known_hosts_path();
    if let Some(p) = kh.parent() {
        fs::create_dir_all(p)?;
    }
    let existing = fs::read_to_string(&kh).unwrap_or_default();
    let fresh: Vec<&String> = lines
        .iter()
        .filter(|l| {
            let key = l.trim().split_whitespace().nth(2).unwrap_or(l.as_str());
            !existing.contains(key)
        })
        .collect();
    if fresh.is_empty() {
        return Ok(());
    }
    use std::io::Write;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&kh)?;
    for l in fresh {
        writeln!(f, "{l}")?;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn parse_key_type(buf: &[u8]) -> String {
    if buf.len() >= 4 {
        let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if len > 0 && len < 64 && buf.len() >= 4 + len {
            if let Ok(s) = std::str::from_utf8(&buf[4..4 + len]) {
                return s.to_string();
            }
        }
    }
    "ssh-unknown".into()
}

/// Key types already cached for host:port in known_hosts (unhashed lines).
/// Used to order the handshake preference so the server presents a key we
/// can verify silently — the same reason the Electron client rarely prompts.
pub fn cached_key_types(host: &str, port: u16) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let Ok(text) = std::fs::read_to_string(known_hosts_path()) else {
        return out;
    };
    let bracket = format!("[{host}]:{port}");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let first = parts.next().unwrap_or("");
        // strip @cert-authority / @revoked markers
        let (hosts_field, type_field) = if first.starts_with('@') {
            (parts.next().unwrap_or(""), parts.next().unwrap_or(""))
        } else {
            (first, parts.next().unwrap_or(""))
        };
        if (type_field.starts_with("ssh-")
            || type_field.starts_with("ecdsa-")
            || type_field.starts_with("sk-"))
            && hosts_field.split(',').any(|h| h == host || h == bracket)
            && !out.iter().any(|t: &String| t == type_field)
        {
            out.push(type_field.to_string());
        }
    }
    out
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    #[test]
    fn parses_cached_types_per_host() {
        let _g = crate::TEST_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("filessh-kh-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let fake_home = tmp.join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        let _env = crate::EnvGuard::redirect(&fake_home, &tmp);
        let sshdir = fake_home.join(".ssh");
        std::fs::create_dir_all(&sshdir).unwrap();
        std::fs::write(
            sshdir.join("known_hosts"),
            "example.com ssh-rsa AAAAB3NzaC1yc2E=\nexample.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\n[example.com]:2222 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=\n|1|salt|hash ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAH\n",
        )
        .unwrap();
        let t22 = cached_key_types("example.com", 22);
        assert!(t22.contains(&"ssh-rsa".to_string()), "{t22:?}");
        assert!(t22.contains(&"ssh-ed25519".to_string()), "{t22:?}");
        assert!(!t22.iter().any(|t| t.contains("ecdsa")), "{t22:?}");
        let t2222 = cached_key_types("example.com", 2222);
        assert!(t2222.contains(&"ecdsa-sha2-nistp256".to_string()), "{t2222:?}");
        assert!(cached_key_types("other.example", 22).is_empty());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
