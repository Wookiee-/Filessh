const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { Client } = require('ssh2');
const { parseFileZillaXml, toFilesshSession } = require('./lib/filezilla');

let win;
const connections = new Map(); // tabId -> { client, stream, session, autoReconnect }

function storePath() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveStore(sessions) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(sessions, null, 2));
}

// Password encryption: Electron safeStorage (KWallet/gnome-keyring) when
// available, else local AES-256-GCM with a 0600 key file. No plaintext.
function fallbackKey() {
  const keyPath = path.join(os.homedir(), '.config', 'filessh', '.key');
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === 32) return existing;
  } catch { /* create below */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch {}
  return key;
}

function aesEncrypt(plain) {
  const key = fallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'aes:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

function aesDecrypt(enc) {
  const parts = String(enc).split(':');
  if (parts.length !== 4 || parts[0] !== 'aes') throw new Error('bad aes payload');
  const key = fallbackKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return decipher.update(Buffer.from(parts[3], 'base64')) + decipher.final('utf8');
}

function decryptPw(enc) {
  if (!enc) return '';
  try {
    if (String(enc).startsWith('plain:')) return String(enc).slice(6);
    if (String(enc).startsWith('aes:')) return aesDecrypt(enc);
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
    return Buffer.from(enc, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

function encryptPw(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(String(plain)).toString('base64');
    }
  } catch { /* fall through */ }
  return aesEncrypt(String(plain));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- sessions CRUD ----
ipcMain.handle('sessions:list', () => {
  return loadStore().map(s => ({ ...s, password: undefined, hasPassword: !!s.passwordEnc }));
});

ipcMain.handle('sessions:save', (e, input) => {
  const store = loadStore();
  const { password, ...rest } = input;
  const record = { ...rest, id: rest.id || `s-${Date.now().toString(36)}` };
  if (password !== undefined) record.passwordEnc = password ? encryptPw(password) : '';
  record.updatedAt = new Date().toISOString();
  const i = store.findIndex(s => s.id === record.id);
  if (i >= 0) store[i] = { ...store[i], ...record };
  else { record.createdAt = record.updatedAt; store.push(record); }
  saveStore(store);
  return { ...record, password: undefined, hasPassword: !!record.passwordEnc };
});

ipcMain.handle('sessions:delete', (e, id) => {
  saveStore(loadStore().filter(s => s.id !== id));
  return true;
});

// ---- FileZilla import ----
ipcMain.handle('import:filezilla-path', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import FileZilla sitemanager.xml',
    filters: [{ name: 'FileZilla XML', extensions: ['xml'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const xml = fs.readFileSync(filePaths[0], 'utf-8');
  return importXml(xml);
});

ipcMain.handle('import:filezilla-xml', (e, xml) => importXml(xml));

ipcMain.handle('import:filezilla-autodetect', () => {
  const candidates = [
    path.join(os.homedir(), '.config', 'filezilla', 'sitemanager.xml'),
    path.join(os.homedir(), '.filezilla', 'sitemanager.xml'),
  ];
  const found = candidates.filter(f => fs.existsSync(f));
  return found;
});

function importXml(xml) {
  const { sessions, skipped } = parseFileZillaXml(xml);
  const store = loadStore();
  let added = 0;
  const existingKeys = new Set(store.map(s => `${s.username}@${s.host}:${s.port}`));
  for (let i = 0; i < sessions.length; i++) {
    const fz = sessions[i];
    const key = `${fz.username}@${fz.host}:${fz.port}`;
    if (existingKeys.has(key)) continue;
    const rec = toFilesshSession(fz, i);
    rec.passwordEnc = rec.password ? encryptPw(rec.password) : '';
    delete rec.password;
    store.push(rec);
    existingKeys.add(key);
    added++;
  }
  saveStore(store);
  return { added, total: sessions.length, skipped };
}

// ---- SSH host-key verification (TOFU, PuTTY-style) ----
const pendingVerify = new Map(); // tabId -> resolve(decision)

ipcMain.on('ssh:verify-response', (e, { tabId, decision }) => {
  const r = pendingVerify.get(tabId);
  if (r) { pendingVerify.delete(tabId); r(decision); }
});

function sha256fp(buf) {
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

function md5fp(buf) {
  return crypto.createHash('md5').update(buf).digest('hex').replace(/(..)(?=.)/g, '$1:');
}

function knownHostsPath() {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

async function keyscan(host, port) {
  const { stdout } = await execFileAsync('ssh-keyscan', ['-p', String(port), '-t', 'rsa,ecdsa,ed25519', host], { timeout: 15000 });
  const keys = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(?:\S+)\s+(ssh-\S+)\s+([A-Za-z0-9+/=]+)(?:\s|$)/);
    if (!m) continue;
    const buf = Buffer.from(m[2], 'base64');
    keys.push({ type: m[1], b64: m[2], sha256: sha256fp(buf), md5: md5fp(buf), line: line.trim() });
  }
  return keys;
}

async function knownFingerprints(host, port) {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', ['-l', '-F', `[${host}]:${port}`, '-f', knownHostsPath()], { timeout: 10000 });
    const fps = new Set();
    for (const m of stdout.matchAll(/SHA256:[A-Za-z0-9+/]+/g)) fps.add(m[0]);
    return fps;
  } catch {
    return new Set();
  }
}

function saveKnownHost(lines) {
  const kh = knownHostsPath();
  fs.mkdirSync(path.dirname(kh), { recursive: true, mode: 0o700 });
  fs.appendFileSync(kh, lines.join('\n') + '\n', { mode: 0o644 });
}

function askVerify(tabId, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(`ssh-verify-${tabId}`, payload);
  return new Promise((resolve) => {
    pendingVerify.set(tabId, resolve);
    setTimeout(() => { if (pendingVerify.has(tabId)) { pendingVerify.delete(tabId); resolve('reject'); } }, 120000);
  });
}

// Returns Set of accepted SHA256 fingerprints, or throws { rejected: true } / Error.
async function verifyHostKey(tabId, host, port) {
  let scanned;
  try {
    scanned = await keyscan(host, port);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || /not found/i.test(String(err.message)))) {
      if (win && !win.isDestroyed()) win.webContents.send(`ssh-status-${tabId}`, { status: 'warning: ssh-keyscan missing, skipping host-key check' });
      return null; // no tools -> old behavior
    }
    return null; // host unreachable here; let connect surface the real error
  }
  if (!scanned.length) return null;
  const known = await knownFingerprints(host, port);
  const matched = scanned.filter(k => known.has(k.sha256));

  if (!known.size) {
    const d = await askVerify(tabId, { mode: 'new', host, port, keys: scanned.map(k => ({ type: k.type, sha256: k.sha256, md5: k.md5 })) });
    if (d === 'save') saveKnownHost(scanned.map(k => k.line));
    if (d === 'reject' || d === undefined) throw { rejected: true };
    return new Set(scanned.map(k => k.sha256));
  }
  if (matched.length) return new Set(matched.map(k => k.sha256));
  const d = await askVerify(tabId, { mode: 'changed', host, port, keys: scanned.map(k => ({ type: k.type, sha256: k.sha256, md5: k.md5 })), known: [...known] });
  if (d === 'save') saveKnownHost(scanned.map(k => k.line));
  if (d === 'reject' || d === undefined) throw { rejected: true };
  return new Set(scanned.map(k => k.sha256));
}

// ---- SSH connect ----
ipcMain.handle('ssh:connect', async (e, { tabId, sessionId, quick, termType }) => {
  const store = loadStore();
  let cfg;
  if (sessionId) {
    const s = store.find(x => x.id === sessionId);
    if (!s) throw new Error('session not found');
    cfg = {
      host: s.host, port: s.port || 22, username: s.username,
      password: decryptPw(s.passwordEnc), privateKey: s.keyfile ? fs.readFileSync(s.keyfile) : undefined,
      termType: termType || 'xterm-256color',
      session: s,
    };
  } else if (quick) {
    cfg = { host: quick.host, port: quick.port || 22, username: quick.username, password: quick.password, termType: termType || 'xterm-256color', session: { name: `${quick.username}@${quick.host}`, startupScript: '', autoReconnect: true } };
  } else {
    throw new Error('no session or quick-connect info');
  }

  await openShell(tabId, cfg);
  return true;
});

function openShell(tabId, cfg, attempt = 1, accepted = undefined) {
  const run = async () => {
    // TOFU host-key check on first attempt only; reuse result on reconnects.
    if (attempt === 1 && accepted === undefined) {
      accepted = await verifyHostKey(tabId, cfg.host, cfg.port);
    }
    return new Promise((resolve, reject) => {
      const client = new Client();
      const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

    client.on('ready', () => {
      client.shell({ term: cfg.termType || 'xterm-256color', cols: 120, rows: 30 }, (err, stream) => {
        if (err) { reject(err); return; }
        connections.set(tabId, { client, stream, session: cfg.session, cfg });
        stream.on('close', () => {
          send(`ssh-closed-${tabId}`, { code: 'closed' });
          client.end();
          // auto-reconnect (Solar-PuTTY parity)
          const st = connections.get(tabId);
          if (st && cfg.session.autoReconnect !== false && attempt <= 3) {
            setTimeout(() => {
              send(`ssh-status-${tabId}`, { status: `reconnecting (attempt ${attempt})…` });
              openShell(tabId, cfg, attempt + 1, accepted).catch(() => {});
            }, 2000 * attempt);
          }
        });
        stream.on('data', (d) => send(`ssh-data-${tabId}`, d.toString('base64')));
        // post-connection script (Solar-PuTTY parity)
        const script = (cfg.session.startupScript || '').split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of script) stream.write(line + '\n');
        send(`ssh-status-${tabId}`, { status: 'connected' });
        resolve(true);
      });
    });
    client.on('error', (err) => {
      if (win && !win.isDestroyed()) win.webContents.send(`ssh-status-${tabId}`, { status: 'error: ' + err.message });
      if (attempt === 1) reject(err);
    });
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish([cfg.password || '']);
    });
    client.connect({
      host: cfg.host, port: cfg.port, username: cfg.username,
      password: cfg.password || undefined,
      privateKey: cfg.privateKey,
      tryKeyboard: true,
      readyTimeout: 15000,
      algorithms: undefined,
      // Strict: handshake key must be one the user approved (or was already known).
      hostVerifier: accepted ? ((key) => accepted.has(sha256fp(Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex')))) : undefined,
    });
    });
  };
  return run().catch((err) => {
    if (err && err.rejected) {
      if (win && !win.isDestroyed()) win.webContents.send(`ssh-status-${tabId}`, { status: 'host key rejected by user' });
      throw new Error('host key rejected by user');
    }
    throw err;
  });
}

ipcMain.on('ssh:input', (e, { tabId, data }) => {
  const c = connections.get(tabId);
  if (c && c.stream) c.stream.write(Buffer.from(String(data), 'base64'));
});

ipcMain.on('ssh:resize', (e, { tabId, cols, rows }) => {
  const c = connections.get(tabId);
  if (c && c.stream) c.stream.setWindow(rows, cols);
});

ipcMain.handle('ssh:disconnect', (e, { tabId }) => {
  const c = connections.get(tabId);
  if (c) {
    connections.delete(tabId);
    try { c.stream.close(); } catch {}
    try { c.client.end(); } catch {}
  }
  return true;
});

// ---- graphical SFTP (Solar-PuTTY parity) ----
ipcMain.handle('sftp:list', (e, { sessionId, remotePath }) => {
  const s = loadStore().find(x => x.id === sessionId);
  if (!s) throw new Error('session not found');
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) { client.end(); reject(err); return; }
        sftp.readdir(remotePath || '.', (err2, list) => {
          client.end();
          if (err2) reject(err2);
          else resolve(list.map(f => ({ filename: f.filename, longname: f.longname, attrs: { size: f.attrs.size, mode: f.attrs.mode, mtime: f.attrs.mtime } })));
        });
      });
    });
    client.on('error', reject);
    client.connect({
      host: s.host, port: s.port || 22, username: s.username,
      password: decryptPw(s.passwordEnc) || undefined,
      privateKey: s.keyfile ? fs.readFileSync(s.keyfile) : undefined,
      tryKeyboard: true, readyTimeout: 15000,
    });
  });
});
