use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FzSession {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType")]
    pub auth_type: String,
    pub password: String,
    #[serde(rename = "passwordProtected")]
    pub password_protected: bool,
    pub keyfile: String,
    pub logontype: i32,
    pub protocol: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FzSkipped {
    pub name: String,
    pub host: Option<String>,
    pub reason: String,
}

fn protocol_map(n: i32) -> String {
    match n {
        0 => "ftp".into(),
        1 | 4 | 6 => "sftp".into(),
        2 => "ftps".into(),
        3 => "ftpes".into(),
        _ => format!("unknown({n})"),
    }
}

fn decode_pass(raw: &str, encoding: &str) -> (String, bool) {
    if raw.is_empty() {
        return (String::new(), false);
    }
    if encoding.to_lowercase() != "base64" {
        return (String::new(), true);
    }
    match B64.decode(raw.trim()) {
        Ok(b) => match String::from_utf8(b) {
            Ok(s) => (s, false),
            Err(_) => (String::new(), true),
        },
        Err(_) => (String::new(), true),
    }
}

/// Port of lib/filezilla.js parseFileZillaXml using quick-xml.
pub fn parse_filezilla_xml(xml: &str, include_ftp: bool) -> (Vec<FzSession>, Vec<FzSkipped>) {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut sessions = vec![];
    let mut skipped = vec![];
    let mut in_server = false;
    let mut cur: std::collections::HashMap<String, String> = Default::default();
    let mut cur_pass_enc = String::new();
    let mut cur_tag = String::new();
    let mut buf = Vec::new();

    let mut flush = |cur: &mut std::collections::HashMap<String, String>, cur_pass_enc: &mut String| {
        let proto_num: i32 = cur.get("Protocol").and_then(|s| s.parse().ok()).unwrap_or(1);
        let proto = protocol_map(proto_num);
        let host = cur.get("Host").cloned().unwrap_or_default();
        let name = cur.get("Name").cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| host.clone());
        let name = if name.is_empty() { "unnamed".into() } else { name };
        if host.is_empty() {
            skipped.push(FzSkipped { name, host: None, reason: "missing host".into() });
            return;
        }
        let is_ssh = proto == "sftp";
        if !is_ssh && !include_ftp {
            skipped.push(FzSkipped {
                name,
                host: Some(host),
                reason: format!("protocol {proto} is not SSH — FTP-only entry, skipped"),
            });
            return;
        }
        let port: u16 = cur
            .get("Port")
            .and_then(|s| s.parse().ok())
            .unwrap_or(if proto == "sftp" { 22 } else { 21 });
        let user = cur.get("User").cloned().unwrap_or_default();
        let logontype: i32 = cur.get("Logontype").and_then(|s| s.parse().ok()).unwrap_or(1);
        let keyfile = cur.get("Keyfile").cloned().unwrap_or_default();
        let pass_raw = cur.get("Pass").cloned().unwrap_or_default();
        let (password, protected) = decode_pass(&pass_raw, cur_pass_enc);
        let auth_type = if !keyfile.is_empty() {
            "key"
        } else if logontype == 1 && !password.is_empty() {
            "password"
        } else if logontype == 4 || !keyfile.is_empty() {
            "key"
        } else {
            "ask"
        };
        sessions.push(FzSession {
            name,
            host,
            port,
            username: if logontype == 0 { "anonymous".into() } else { user },
            auth_type: auth_type.into(),
            password: if logontype == 1 { password } else { String::new() },
            password_protected: protected,
            keyfile,
            logontype,
            protocol: proto,
            source: "filezilla".into(),
        });
    };

    loop {
        match reader.read_event_into(&mut buf) {
            Err(_) => break,
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let n = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if n.eq_ignore_ascii_case("Server") {
                    in_server = true;
                    cur.clear();
                    cur_pass_enc.clear();
                } else if in_server {
                    cur_tag = n.clone();
                    if cur_tag.eq_ignore_ascii_case("Pass") {
                        cur_pass_enc = e
                            .attributes()
                            .filter_map(|a| a.ok())
                            .find(|a| String::from_utf8_lossy(a.key.as_ref()).eq_ignore_ascii_case("encoding"))
                            .and_then(|a| a.unescape_value().ok().map(|v| v.to_string()))
                            .unwrap_or_default();
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_server && !cur_tag.is_empty() {
                    if let Ok(s) = e.unescape() {
                        cur.insert(cur_tag.clone(), s.trim().to_string());
                    }
                }
            }
            Ok(Event::End(e)) => {
                let n = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if n.eq_ignore_ascii_case("Server") {
                    in_server = false;
                    flush(&mut cur, &mut cur_pass_enc);
                    cur.clear();
                }
                cur_tag.clear();
            }
            _ => {}
        }
        buf.clear();
    }
    (sessions, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_sftp_and_skips_ftp() {
        let xml = r#"<?xml version="1.0"?><FileZilla3><Servers>
        <Server><Host>example.com</Host><Port>22</Port><Protocol>1</Protocol><User>bob</User><Pass encoding="base64">c2VjcmV0</Pass><Logontype>1</Logontype><Name>demo</Name></Server>
        <Server><Host>ftp.example.com</Host><Port>21</Port><Protocol>0</Protocol><User>a</User><Pass encoding="base64"></Pass><Logontype>1</Logontype><Name>ftp-only</Name></Server>
        </Servers></FileZilla3>"#;
        let (sessions, skipped) = parse_filezilla_xml(xml, false);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].host, "example.com");
        assert_eq!(sessions[0].password, "secret");
        assert_eq!(skipped.len(), 1);
    }
}
