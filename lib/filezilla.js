// No external deps — tiny regex parser for FileZilla's simple schema.
const PROTOCOL_MAP = {
  0: 'ftp',    // plain FTP — not usable in SSH client
  1: 'sftp',   // SSH File Transfer Protocol — importable
  2: 'ftps',
  3: 'ftpes',
  4: 'sftp',
  6: 'sftp',
};

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(\\s+[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!m) return '';
  return (m[2] ?? '').trim();
}

function tagAttr(block, name, attr) {
  const m = block.match(new RegExp(`<${name}\\s+[^>]*${attr}\\s*=\\s*"([^"]*)"[^>]*>`, 'i'));
  return m ? m[1] : '';
}

// FileZilla Logontype: 0=Anonymous, 1=Normal (stored pw), 2=Ask, 3=Interactive, 4=Key file
function decodePass(raw, encoding) {
  if (!raw) return { password: '', protected: false };
  if (String(encoding || '').toLowerCase() !== 'base64') {
    // Master-password-encrypted entries are not plain base64
    return { password: '', protected: true };
  }
  try {
    return { password: Buffer.from(String(raw).trim(), 'base64').toString('utf-8'), protected: false };
  } catch {
    return { password: '', protected: true };
  }
}

function parseFileZillaXml(xmlText, opts = {}) {
  const { includeFtp = false } = opts;
  const blocks = [...xmlText.matchAll(/<Server>([\s\S]*?)<\/Server>/gi)].map(m => m[1]);

  const sessions = [];
  const skipped = [];

  for (const b of blocks) {
    const protoNum = Number(tag(b, 'Protocol') || '1');
    const proto = PROTOCOL_MAP[protoNum] ?? `unknown(${protoNum})`;
    const name = tag(b, 'Name') || tag(b, 'Host') || 'unnamed';
    const host = tag(b, 'Host');
    const port = Number(tag(b, 'Port') || (proto === 'sftp' ? 22 : 21));
    const user = tag(b, 'User');
    const logontype = Number(tag(b, 'Logontype') || '1');
    const keyfile = tag(b, 'Keyfile');
    const passRaw = tag(b, 'Pass');
    const passEnc = tagAttr(b, 'Pass', 'encoding');
    const { password, protected: pwProtected } = decodePass(passRaw, passEnc);

    if (!host) {
      skipped.push({ name, reason: 'missing host' });
      continue;
    }
    const isSsh = proto === 'sftp';
    if (!isSsh && !includeFtp) {
      skipped.push({ name, host, reason: `protocol ${proto} is not SSH — FTP-only entry, skipped` });
      continue;
    }
    sessions.push({
      name,
      host,
      port,
      username: logontype === 0 ? 'anonymous' : user,
      authType: keyfile ? 'key' : (logontype === 1 && password ? 'password' : (logontype === 4 || keyfile ? 'key' : 'ask')),
      password: logontype === 1 ? password : '',
      passwordProtected: pwProtected,
      keyfile,
      logontype,
      protocol: proto,
      source: 'filezilla',
    });
  }
  return { sessions, skipped };
}

function toFilesshSession(fz, i = 0) {
  return {
    id: `fz-${Date.now().toString(36)}-${i}`,
    name: fz.name,
    host: fz.host,
    port: fz.port || 22,
    username: fz.username,
    authType: fz.authType === 'key' ? 'key' : 'password',
    password: fz.password || '',
    keyfile: fz.keyfile || '',
    startupScript: '',
    autoReconnect: true,
    favorite: false,
    source: 'filezilla',
    createdAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const fs = require('fs');
  const f = process.argv[2];
  if (!f) { console.error('usage: node lib/filezilla.js <sitemanager.xml>'); process.exit(1); }
  const xml = fs.readFileSync(f, 'utf-8');
  const { sessions, skipped } = parseFileZillaXml(xml);
  console.log(`importable SSH/SFTP: ${sessions.length}`);
  for (const s of sessions) console.log(`  [ok] ${s.name} ${s.username}@${s.host}:${s.port} auth=${s.authType}${s.passwordProtected ? ' (pw protected!)' : ''}`);
  console.log(`skipped (non-SSH): ${skipped.length}`);
  for (const s of skipped) console.log(`  [skip] ${s.name} (${s.reason})`);
}

module.exports = { parseFileZillaXml, toFilesshSession };
