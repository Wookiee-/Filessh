use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

fn esc_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExportRow {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub keyfile: String,
}

/// Port of lib/formats.js toFileZillaXml.
pub fn to_filezilla_xml(rows: &[ExportRow]) -> String {
    let mut servers = String::new();
    for s in rows.iter().filter(|s| !s.host.is_empty()) {
        let pw = &s.password;
        let logon = if !s.keyfile.is_empty() {
            4
        } else if !pw.is_empty() {
            1
        } else {
            2
        };
        servers.push_str("    <Server>\n");
        servers.push_str(&format!("      <Host>{}</Host>\n", esc_xml(&s.host)));
        servers.push_str(&format!("      <Port>{}</Port>\n", if s.port == 0 { 22 } else { s.port }));
        servers.push_str("      <Protocol>1</Protocol>\n");
        servers.push_str("      <Type>0</Type>\n");
        servers.push_str(&format!("      <User>{}</User>\n", esc_xml(&s.username)));
        let b64 = if pw.is_empty() { String::new() } else { B64.encode(pw.as_bytes()) };
        servers.push_str(&format!("      <Pass encoding=\"base64\">{}</Pass>\n", b64));
        servers.push_str(&format!("      <Logontype>{}</Logontype>\n", logon));
        if !s.keyfile.is_empty() {
            servers.push_str(&format!("      <Keyfile>{}</Keyfile>\n", esc_xml(&s.keyfile)));
        }
        servers.push_str(&format!("      <Name>{}</Name>\n", esc_xml(if s.name.is_empty() { &s.host } else { &s.name })));
        servers.push_str("    </Server>\n");
    }
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<FileZilla3>\n  <Servers>\n{servers}  </Servers>\n</FileZilla3>\n")
}

pub const CSV_COLS: [&str; 6] = ["name", "host", "port", "username", "password", "keyfile"];

/// Port of parseCsv (minimal RFC-4180).
pub fn parse_csv(text: &str) -> Vec<std::collections::HashMap<String, String>> {
    let mut rdr = csv::ReaderBuilder::new()
        .trim(csv::Trim::All)
        .flexible(true)
        .from_reader(text.as_bytes());
    let headers: Vec<String> = match rdr.headers() {
        Ok(h) => h.iter().map(|s| s.trim().to_lowercase()).collect(),
        Err(_) => return vec![],
    };
    let mut out = vec![];
    for rec in rdr.records().flatten() {
        let mut m = std::collections::HashMap::new();
        let mut empty = true;
        for (i, h) in headers.iter().enumerate() {
            let v = rec.get(i).unwrap_or("").trim().to_string();
            if !v.is_empty() {
                empty = false;
            }
            m.insert(h.clone(), v);
        }
        if !empty {
            out.push(m);
        }
    }
    out
}

pub fn to_csv(rows: &[ExportRow]) -> String {
    let mut wtr = csv::Writer::from_writer(vec![]);
    let _ = wtr.write_record(CSV_COLS);
    for r in rows {
        let _ = wtr.write_record([
            &r.name,
            &r.host,
            &r.port.to_string(),
            &r.username,
            &r.password,
            &r.keyfile,
        ]);
    }
    String::from_utf8(wtr.into_inner().unwrap_or_default()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_roundtrip_with_comma() {
        let rows = vec![ExportRow { name: "a".into(), host: "1.2.3.4".into(), port: 22, username: "root".into(), password: "p,ss".into(), keyfile: String::new() }];
        let csv = to_csv(&rows);
        let back = parse_csv(&csv);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].get("password").unwrap(), "p,ss");
        let xml = to_filezilla_xml(&rows);
        assert!(xml.contains("<Host>1.2.3.4</Host>"));
    }
}
