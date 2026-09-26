// Import/export formats for Filessh sessions.
// FileZilla XML (sitemanager), CSV, and JSON backup.

function escXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function toFileZillaXml(sessions) {
  const servers = (sessions || [])
    .filter((s) => s && s.host)
    .map((s) => {
      const pw = s.password || '';
      const logon = s.keyfile ? 4 : (pw ? 1 : 2);
      return [
        '    <Server>',
        `      <Host>${escXml(s.host)}</Host>`,
        `      <Port>${Number(s.port) || 22}</Port>`,
        '      <Protocol>1</Protocol>',
        '      <Type>0</Type>',
        `      <User>${escXml(s.username || '')}</User>`,
        `      <Pass encoding="base64">${pw ? Buffer.from(String(pw), 'utf8').toString('base64') : ''}</Pass>`,
        `      <Logontype>${logon}</Logontype>`,
        s.keyfile ? `      <Keyfile>${escXml(s.keyfile)}</Keyfile>` : null,
        `      <Name>${escXml(s.name || s.host)}</Name>`,
        '    </Server>',
      ].filter(Boolean).join('\n');
    }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<FileZilla3>\n  <Servers>\n${servers}\n  </Servers>\n</FileZilla3>\n`;
}

const CSV_COLS = ['name', 'host', 'port', 'username', 'password', 'keyfile'];

function csvEsc(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows || []) lines.push(CSV_COLS.map((c) => csvEsc(r[c])).join(','));
  return lines.join('\n') + '\n';
}

// Minimal RFC-4180 reader (quoted fields, doubled quotes, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const push = () => { row.push(field); field = ''; };
  for (let i = 0; i < (text || '').length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') push();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      push(); rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  return rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

if (require.main === module) {
  const rows = parseCsv('name,host,port,username,password,keyfile\na,1.2.3.4,22,root,"p,ss",\n');
  console.log(JSON.stringify(rows));
  console.log(toFileZillaXml([{ name: 'a', host: '1.2.3.4', username: 'root', password: 'p,ss' }]).split('\n').length + ' xml lines');
}

module.exports = { CSV_COLS, escXml, toFileZillaXml, csvEsc, toCsv, parseCsv };
