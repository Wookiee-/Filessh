const { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { Client } = require('ssh2');
const { parseFileZillaXml, toFilesshSession } = require('./lib/filezilla');

let win;
const connections = new Map(); // tabId -> { client, stream, session, autoReconnect }

// ---- debug trace (FILSESSH_DEBUG=1): JSON lines of shell/data events ----
const DEBUG = process.env.FILSESSH_DEBUG === '1';
let debugPath = null;
function dbg(obj) {
  if (!DEBUG) return;
  try {
    if (!debugPath) {
      debugPath = path.join(os.homedir(), '.config', 'filessh', `debug-${Date.now()}.log`);
      fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    }
    fs.appendFileSync(debugPath, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');
  } catch {}
}

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
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Site Manager', accelerator: 'Ctrl+M', click: () => win.webContents.send('menu:action', 'manager') },
      { label: 'Import FileZilla…', click: () => win.webContents.send('menu:action', 'import') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Ctrl+,', click: () => win.webContents.send('menu:action', 'settings') },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() },
    ]},
    { label: 'Session', submenu: [
      { label: 'Close Tab', accelerator: 'Ctrl+W', click: () => win.webContents.send('menu:action', 'close-tab') },
    ]},
  ]));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- sessions CRUD ----
ipcMain.handle('sessions:list', () => {
  return loadStore().map(s => ({ ...s, password: undefined, hasPassword: !!s.passwordEnc }));
});

ipcMain.handle('sessions:save', (e, input) => {
  const store = loadStore();
  const { password, keyPassphrase, ...rest } = input;
  const record = { ...rest, id: rest.id || `s-${Date.now().toString(36)}` };
  if (password !== undefined) record.passwordEnc = password ? encryptPw(password) : '';
  if (keyPassphrase !== undefined) record.keyPassphraseEnc = keyPassphrase ? encryptPw(keyPassphrase) : '';
  record.updatedAt = new Date().toISOString();
  const i = store.findIndex(s => s.id === record.id);
  if (i >= 0) store[i] = { ...store[i], ...record };
  else { record.createdAt = record.updatedAt; store.push(record); }
  saveStore(store);
  const { passwordEnc, keyPassphraseEnc, ...safe } = record;
  return { ...safe, password: undefined, hasPassword: !!record.passwordEnc, hasKeyPassphrase: !!record.keyPassphraseEnc };
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

// ---- generic file picker (key files, log paths) ----
ipcMain.handle('dialog:open-file', async (e, { title, filters, save, defaultPath }) => {
  if (save) {
    const r = await dialog.showSaveDialog(win, { title: title || 'Choose file', defaultPath });
    return r.canceled ? null : r.filePath;
  }
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose file',
    filters: filters || [{ name: 'All files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
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

async function knownFingerprints(host, port, file = knownHostsPath()) {
  const fps = new Set();
  // NOTE: `ssh-keygen -F [host]:port` does NOT match bare `host` lines
  // (which is what ssh-keyscan writes for port 22), so query both forms.
  const forms = [`[${host}]:${port}`];
  if (Number(port) === 22) forms.push(host);
  for (const form of forms) {
    try {
      const { stdout } = await execFileAsync('ssh-keygen', ['-l', '-F', form, '-f', file], { timeout: 10000 });
      for (const m of stdout.matchAll(/SHA256:[A-Za-z0-9+/]+/g)) fps.add(m[0]);
    } catch { /* no match in this form */ }
  }
  return fps;
}

function saveKnownHost(lines) {
  const kh = knownHostsPath();
  fs.mkdirSync(path.dirname(kh), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(kh) ? fs.readFileSync(kh, 'utf-8') : '';
  const keyOf = (l) => (l.trim().split(/\s+/)[2] || l); // key blob, or whole line
  const fresh = lines.filter(l => !existing.includes(keyOf(l)));
  if (!fresh.length) return;
  fs.appendFileSync(kh, fresh.join('\n') + '\n', { mode: 0o644 });
}

function askVerify(tabId, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(`ssh-verify-${tabId}`, payload);
  return new Promise((resolve) => {
    pendingVerify.set(tabId, resolve);
    setTimeout(() => { if (pendingVerify.has(tabId)) { pendingVerify.delete(tabId); resolve('reject'); } }, 120000);
  });
}

// Returns { known:Set<fp>, scanned:[keys] }, null (skip verification),
// or throws { rejected: true }.
async function verifyHostKey(tabId, host, port) {
  let scanned;
  try {
    scanned = await keyscan(host, port);
  } catch (err) {
    if (win && !win.isDestroyed()) {
      const missing = err && (err.code === 'ENOENT' || /not found/i.test(String(err.message)));
      win.webContents.send(`ssh-status-${tabId}`, { status: missing ? 'warning: ssh-keyscan missing, skipping host-key check' : 'warning: host-key prescan failed, will verify at handshake' });
    }
    scanned = [];
  }
  if (!scanned.length) {
    // Prescan failed (host unreachable here, or no keys) — let the real
    // connect surface errors, and verify strictly at handshake if possible.
    const known = await knownFingerprints(host, port);
    return known.size ? { known, matched: new Set(known), scanned: [] } : null;
  }
  const known = await knownFingerprints(host, port);
  if (!known.size) {
    // First contact: show every key, like OpenSSH does.
    const d = await askVerify(tabId, { mode: 'new', host, port, keys: scanned.map(k => ({ type: k.type, sha256: k.sha256, md5: k.md5 })) });
    if (d === 'save') saveKnownHost(scanned.map(k => k.line));
    if (d === 'reject' || d === undefined) throw { rejected: true };
    const fps = new Set(scanned.map(k => k.sha256));
    return { known: fps, matched: fps, scanned };
  }
  const matched = new Set(scanned.filter(k => known.has(k.sha256)).map(k => k.sha256));
  return { known, matched, scanned };
}

function parseKeyType(buf) {
  try {
    const len = buf.readUInt32BE(0);
    if (len > 0 && len < 64) return buf.slice(4, 4 + len).toString('ascii');
  } catch {}
  return 'ssh-unknown';
}

// Strict handshake verifier: known keys pass silently; an unknown presented
// key prompts (changed-key warning) instead of failing cryptically.
//
// Contract: deliver EXACTLY ONE verdict — either return a boolean (the
// wrapper forwards it) or call verify() later and return undefined.
// Doing both re-runs handshake completion and emits 'ready' twice,
// opening a duplicate shell (double prompt).
function makeHostVerifier(tabId, host, port, accepted) {
  return (key, verify) => {
    const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
    const fp = sha256fp(buf);
    if (accepted.matched.has(fp)) return true;
    const type = parseKeyType(buf);
    const presented = { type, sha256: fp, md5: md5fp(buf), line: `${Number(port) === 22 ? host : `[${host}]:${port}`} ${type} ${buf.toString('base64')}` };
    askVerify(tabId, { mode: 'changed', host, port, keys: [{ type, sha256: fp, md5: presented.md5 }], known: [...accepted.known] }).then((d) => {
      if (d === 'save') saveKnownHost([presented.line]);
      verify(d === 'save' || d === 'once');
    });
    return undefined; // async verdict
  };
}

// ---- SSH connect ----
ipcMain.handle('ssh:connect', async (e, { tabId, sessionId, quick, termType, logDir, autoLog, cols, rows }) => {
  const store = loadStore();
  let cfg;
  if (sessionId) {
    const s = store.find(x => x.id === sessionId);
    if (!s) throw new Error('session not found');
    if (autoLog && s.logSession !== true && !s.logPath) s.logSession = true;
    cfg = sessionToCfg(s, termType);
    cfg.logDirBase = logDir || undefined;
    cfg.cols = Number(cols) || 120;
    cfg.rows = Number(rows) || 30;
  } else if (quick) {
    cfg = { host: quick.host, port: quick.port || 22, username: quick.username, password: quick.password, termType: termType || 'xterm-256color', forwards: [], logSession: !!autoLog, logPath: '', logDirBase: logDir || undefined, cols: Number(cols) || 120, rows: Number(rows) || 30, session: { name: `${quick.username}@${quick.host}`, startupScript: '', autoReconnect: true } };
  } else {
    throw new Error('no session or quick-connect info');
  }

  // Guard: never run two shells for one tab (double-clicks, retries).
  closeTabResources(tabId);
  await openShell(tabId, cfg);
  return true;
});

function closeTabResources(tabId) {
  const c = connections.get(tabId);
  if (!c) return;
  connections.delete(tabId);
  if (c.teardown) { try { c.teardown(); } catch {} }
  if (c.stream) { try { c.stream.close(); } catch {} }
  if (c.client) { try { c.client.end(); } catch {} }
}

function splitList(str) {
  return String(str || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

function sessionAlgorithms(s) {
  const a = {};
  const c = splitList(s.ciphers), k = splitList(s.kex), h = splitList(s.hostkeys);
  if (c.length) a.cipher = c;
  if (k.length) a.kex = k;
  if (h.length) a.serverHostKey = h;
  return Object.keys(a).length ? a : undefined;
}

function sessionToCfg(s, termType) {
  return {
    host: s.host, port: s.port || 22, username: s.username,
    password: decryptPw(s.passwordEnc),
    privateKey: s.keyfile ? fs.readFileSync(s.keyfile) : undefined,
    passphrase: decryptPw(s.keyPassphraseEnc) || undefined,
    termType: termType || 'xterm-256color',
    keepaliveInterval: Number(s.keepaliveInterval) || 0,
    keepaliveCountMax: Number(s.keepaliveCountMax) || 3,
    agentForward: s.agentForward === true,
    agentSock: process.env.SSH_AUTH_SOCK || undefined,
    jumpSessionId: s.jumpSessionId || null,
    forwards: Array.isArray(s.forwards) ? s.forwards : [],
    x11: s.x11 === true, x11Screen: Number(s.x11Screen) || 0,
    algorithms: sessionAlgorithms(s),
    logSession: s.logSession === true, logPath: s.logPath || '',
    session: s,
  };
}

function resolveLogPath(cfg) {
  if (cfg.logPath) return cfg.logPath;
  const safe = String(cfg.session.name || `${cfg.username}@${cfg.host}`).replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = cfg.logDirBase || path.join(os.homedir(), '.config', 'filessh', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safe}-${stamp}.log`);
}

// Open a socket to the target through a saved jump-host session.
async function openJumpSock(tabId, jumpSessionId, destHost, destPort) {
  const store = loadStore();
  const js = store.find(x => x.id === jumpSessionId);
  if (!js) throw new Error('jump host session not found');
  const jcfg = sessionToCfg(js);
  const jc = new Client();
  await new Promise((resolve, reject) => {
    jc.on('ready', resolve);
    jc.on('error', reject);
    jc.on('keyboard-interactive', (n, i, l, p, finish) => finish([(jcfg.password || '')]));
    jc.connect({
      host: jcfg.host, port: jcfg.port, username: jcfg.username,
      password: jcfg.password || undefined, privateKey: jcfg.privateKey,
      tryKeyboard: true, readyTimeout: 15000,
      keepaliveInterval: jcfg.keepaliveInterval || 0, keepaliveCountMax: jcfg.keepaliveCountMax,
      algorithms: jcfg.algorithms,
    });
  });
  const sock = await new Promise((resolve, reject) => {
    jc.forwardOut('127.0.0.1', 0, destHost, destPort, (err, stream) => err ? reject(err) : resolve(stream));
  });
  return { jumpClient: jc, sock };
}

// Minimal SOCKS5 (no-auth, CONNECT only) fronting ssh forwardOut.
function startSocksServer(client, bindHost, bindPort, onStatus) {
  const server = net.createServer((socket) => {
    let stage = 0, buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        socket.write(Buffer.from([0x05, 0x00])); // no auth
        buf = buf.slice(2 + n); stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x01) { socket.write(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0])); socket.end(); return; }
        const atyp = buf[3];
        let addr, off;
        if (atyp === 0x01) { if (buf.length < 10) return; addr = [...buf.slice(4, 8)].join('.'); off = 8; }
        else if (atyp === 0x03) { const len = buf[4]; if (buf.length < 5 + len + 2) return; addr = buf.slice(5, 5 + len).toString(); off = 5 + len; }
        else if (atyp === 0x04) { if (buf.length < 22) return; addr = buf.slice(4, 20).toString('hex').replace(/(.{4})(?=.)/g, '$1:'); off = 20; }
        else { socket.write(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0])); socket.end(); return; }
        const port = buf.readUInt16BE(off);
        stage = 2;
        client.forwardOut('socks', 0, addr, port, (err, stream) => {
          if (err) { socket.write(Buffer.from([0x05, 0x04, 0, 1, 0, 0, 0, 0, 0, 0])); socket.end(); return; }
          socket.write(Buffer.from([0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]));
          socket.pipe(stream).pipe(socket);
          socket.on('error', () => { try { stream.close(); } catch {} });
          stream.on('close', () => { try { socket.end(); } catch {} });
        });
      }
    });
    socket.on('error', () => {});
  });
  server.on('error', (err) => onStatus(`tunnel error (socks ${bindPort}): ${err.message}`));
  server.listen(bindPort, bindHost || '127.0.0.1');
  return server;
}

function setupForwards(tabId, client, forwards, send) {
  const servers = [];
  const remoteRoutes = [];
  const status = (msg) => send(`ssh-status-${tabId}`, { status: msg });

  client.on('tcp connection', (details, accept, reject) => {
    const route = remoteRoutes.find(r => r.bindPort === details.destPort);
    if (!route) return reject();
    const out = net.connect(route.targetPort, route.targetHost, () => {
      const stream = accept();
      out.pipe(stream).pipe(out);
    });
    out.on('error', () => reject());
  });

  for (const f of forwards || []) {
    const type = f.type || 'local';
    try {
      if (type === 'local') {
        const srv = net.createServer((socket) => {
          client.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, f.targetHost, Number(f.targetPort), (err, stream) => {
            if (err) { socket.end(); return; }
            socket.pipe(stream).pipe(socket);
            socket.on('error', () => { try { stream.close(); } catch {} });
          });
        });
        srv.on('error', (err) => status(`tunnel error (local ${f.bindPort}): ${err.message}`));
        srv.listen(Number(f.bindPort), f.bindHost || '127.0.0.1');
        servers.push(srv);
      } else if (type === 'remote') {
        remoteRoutes.push({ bindHost: f.bindHost || '127.0.0.1', bindPort: Number(f.bindPort), targetHost: f.targetHost, targetPort: Number(f.targetPort) });
        client.forwardIn(f.bindHost || '127.0.0.1', Number(f.bindPort), (err) => {
          if (err) status(`tunnel error (remote ${f.bindPort}): ${err.message || err}`);
        });
      } else if (type === 'dynamic') {
        servers.push(startSocksServer(client, f.bindHost, Number(f.bindPort), status));
      }
    } catch (err) {
      status(`tunnel error (${type} ${f.bindPort}): ${err.message}`);
    }
  }
  // remote forwardIn needs the client-level listener registered before use; unforward on cleanup
  return {
    servers,
    cleanup() {
      for (const srv of servers) { try { srv.close(); } catch {} }
      for (const r of remoteRoutes) { try { client.unforwardIn(r.bindHost || '127.0.0.1', r.bindPort, () => {}); } catch {} }
    },
  };
}

function openShell(tabId, cfg, attempt = 1, accepted = undefined) {
  const run = async () => {
    dbg({ ev: 'openShell', tabId, attempt, host: cfg.host });
    // TOFU host-key check on first attempt only; reuse result on reconnects.
    if (attempt === 1 && accepted === undefined) {
      accepted = await verifyHostKey(tabId, cfg.host, cfg.port);
    }
    // Optional bastion/jump host.
    let jumpClient = null;
    let sock = undefined;
    const status0 = (msg) => { if (win && !win.isDestroyed()) win.webContents.send(`ssh-status-${tabId}`, { status: msg }); };
    if (cfg.jumpSessionId) {
      status0(`via jump host…`);
      const j = await openJumpSock(tabId, cfg.jumpSessionId, cfg.host, cfg.port);
      jumpClient = j.jumpClient; sock = j.sock;
    }
    // Session logging.
    let logStream = null;
    if (cfg.logSession) {
      try {
        const lp = resolveLogPath(cfg);
        logStream = fs.createWriteStream(lp, { flags: 'a' });
        logStream.write(`\n===== ${new Date().toISOString()} ${cfg.username}@${cfg.host}:${cfg.port} =====\n`);
        status0(`logging to ${lp}`);
      } catch (err) { status0(`logging disabled: ${err.message}`); }
    }
    return new Promise((resolve, reject) => {
      const client = new Client();
      const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };
      let fwd = null;
      dbg({ ev: 'client-created', tabId, attempt });

      const teardown = () => {
        if (fwd) { try { fwd.cleanup(); } catch {} fwd = null; }
        if (logStream) { try { logStream.end(); } catch {} logStream = null; }
        if (jumpClient) { try { jumpClient.end(); } catch {} jumpClient = null; }
      };

      client.on('ready', () => {
        dbg({ ev: 'client-ready', tabId, attempt });
        fwd = setupForwards(tabId, client, cfg.forwards, send);
        const shellOpts = {};
        if (cfg.x11) shellOpts.x11 = { single: false, screen: cfg.x11Screen || 0 };
        if (cfg.agentForward && cfg.agentSock) shellOpts.agentForward = true;
        dbg({ ev: 'shell-request', tabId, attempt });
        client.shell({ term: cfg.termType || 'xterm-256color', cols: cfg.cols || 120, rows: cfg.rows || 30 }, shellOpts, (err, stream) => {
          if (err) { teardown(); reject(err); return; }
          dbg({ ev: 'shell-open', tabId, attempt });
          connections.set(tabId, { client, stream, session: cfg.session, cfg, teardown });
          let sawExit = false;
          stream.on('exit', () => { sawExit = true; dbg({ ev: 'exit-status', tabId }); }); // remote reported exit-status: clean logout
          stream.on('close', () => {
            dbg({ ev: 'close', tabId, sawExit });
            send(`ssh-closed-${tabId}`, { code: 'closed' });
            teardown();
            client.end();
            if (sawExit) {
              // User logged out (exit/logout): close the tab, don't reconnect.
              connections.delete(tabId);
              send(`ssh-exited-${tabId}`, {});
              return;
            }
            // auto-reconnect (Solar-PuTTY parity)
            const st = connections.get(tabId);
            if (st && cfg.session.autoReconnect !== false && attempt <= 3) {
              setTimeout(() => {
                send(`ssh-status-${tabId}`, { status: `reconnecting (attempt ${attempt})…` });
                openShell(tabId, cfg, attempt + 1, accepted).catch(() => {});
              }, 2000 * attempt);
            }
          });
          stream.on('data', (d) => {
            dbg({ ev: 'data', tabId, n: d.length, head: d.toString('base64').slice(0, 120) });
            send(`ssh-data-${tabId}`, d.toString('base64'));
            if (logStream) logStream.write(d);
          });
          // post-connection script (Solar-PuTTY parity)
          const script = (cfg.session.startupScript || '').split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of script) stream.write(line + '\n');
          send(`ssh-status-${tabId}`, { status: 'connected' });
          resolve(true);
        });
      });

    client.on('error', (err) => {
      if (win && !win.isDestroyed()) win.webContents.send(`ssh-status-${tabId}`, { status: 'error: ' + err.message });
      if (attempt === 1) { teardown(); reject(err); }
    });
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish([cfg.password || '']);
    });
    client.connect({
      sock,
      host: cfg.host, port: cfg.port, username: cfg.username,
      password: cfg.password || undefined,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      agent: cfg.agentForward ? cfg.agentSock : undefined,
      agentForward: cfg.agentForward === true,
      tryKeyboard: true,
      readyTimeout: 15000,
      keepaliveInterval: cfg.keepaliveInterval || 0,
      keepaliveCountMax: cfg.keepaliveCountMax || 3,
      algorithms: cfg.algorithms,
      // Strict: known handshake keys pass silently; unknown ones prompt.
      hostVerifier: accepted ? makeHostVerifier(tabId, cfg.host, cfg.port, accepted) : undefined,
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
  dbg({ ev: 'input', tabId, n: String(data || '').length });
  if (c && c.stream) c.stream.write(Buffer.from(String(data), 'base64'));
});

ipcMain.on('ssh:resize', (e, { tabId, cols, rows }) => {
  dbg({ ev: 'resize', tabId, cols, rows });
  const c = connections.get(tabId);
  if (c && c.stream) c.stream.setWindow(rows, cols);
});

ipcMain.handle('ssh:disconnect', (e, { tabId }) => {
  closeTabResources(tabId);
  return true;
});

// Exported only when required (tests); no-op when run as the Electron entry.
if (typeof module !== 'undefined' && module.parent) {
  module.exports = { startSocksServer, setupForwards, sha256fp, md5fp, splitList, sessionAlgorithms, sessionToCfg, resolveLogPath, knownFingerprints, saveKnownHost, knownHostsPath, parseKeyType, makeHostVerifier };
}

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
      passphrase: decryptPw(s.keyPassphraseEnc) || undefined,
      tryKeyboard: true, readyTimeout: 15000,
      keepaliveInterval: Number(s.keepaliveInterval) || 0,
      keepaliveCountMax: Number(s.keepaliveCountMax) || 3,
      algorithms: sessionAlgorithms(s),
    });
  });
});
