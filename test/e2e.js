// End-to-end test of Filessh's SSH stack (main.js) against an in-process
// fake SSH server. No sudo, no network, no Electron window needed.
//
// Usage: node test/e2e.js
// Pass criteria printed at the end; exit code 0 = all green.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'filessh-e2e-'));
process.env.HOME = HOME; // known_hosts + logs land here

// ---------- stub electron (capture IPC, fake window) ----------
const events = [];
const handlers = {};
const listeners = {};
const win = null; // main.js owns the real window; stub BrowserWindow captures sends
const electronStub = {
  app: { getPath: (n) => (n === 'userData' ? path.join(HOME, '.config', 'Filessh') : HOME), whenReady: () => ({ then(fn) { fn(); } }), on: () => {}, commandLine: { appendSwitch: () => {} } },
  BrowserWindow: function () {
    this.loadFile = () => {};
    this.isDestroyed = () => false;
    this.webContents = { send: (ch, data) => events.push({ ch, data, seq: (global.__evSeq = (global.__evSeq || 0) + 1) }) };
  },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { listeners[ch] = fn; } },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).replace(/^enc:/, '') },
  dialog: {},
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return electronStub;
  return origLoad.call(this, req, parent, isMain);
};

// ---------- fake SSH server: one prompt, echo, exit ----------
// Real servers carry rsa+ecdsa+ed25519 host keys; keyscan probes each type.
const { execFileSync } = require('child_process');
function genHostKey(kind, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filessh-e2e-key-'));
  execFileSync('ssh-keygen', ['-t', kind, ...args, '-f', path.join(dir, 'key'), '-N', '', '-q']);
  return fs.readFileSync(path.join(dir, 'key'));
}
const hostKeys = [
  genHostKey('rsa', ['-b', '2048']),
  genHostKey('ecdsa', ['-b', '256']),
  genHostKey('ed25519', []),
];
const { Server } = require(path.join(REPO, 'node_modules', 'ssh2'));

function startServer(port) {
  return new Promise((resolve) => {
    const srv = new Server({ hostKeys }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'testpw') ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (a) => a());
        session.on('shell', (acceptFn) => {
          const stream = acceptFn();
          stream.write('tester@test:~$ '); // prompt sent EXACTLY once
          let line = '';
          stream.on('data', (d) => {
            stream.write(d); // pty echo
            line += d.toString();
            const idx = line.indexOf('\n');
            if (idx >= 0) {
              const cmd = line.slice(0, idx).trim();
              line = line.slice(idx + 1);
              if (cmd === 'exit') { stream.write('logout\n'); stream.exit(0); stream.end(); return; }
              if (cmd.startsWith('echo ')) stream.write(cmd.slice(5) + '\n');
              stream.write('tester@test:~$ ');
            }
          });
        });
      }));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeout, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = pred();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timeout waiting for ' + what);
}
const dataFor = (tab) => events.filter((e) => e.ch === `ssh-data-${tab}`).map((e) => Buffer.from(e.data, 'base64').toString()).join('');

(async () => {
  require(path.join(REPO, 'main.js')); // loads handlers into stubs
  const srv = await startServer(2222);

  // seed known_hosts via real ssh-keyscan (same path as the app).
  // NB: async spawn only — execFileSync would block the loop and starve
  // the in-process test server mid-handshake.
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true });
  let ks = '';
  for (let i = 0; i < 20 && !ks; i++) {
    try {
      const { stdout } = await execFileAsync('ssh-keyscan', ['-p', '2222', '-t', 'rsa,ecdsa,ed25519', '127.0.0.1'], { timeout: 5000 });
      ks = stdout.split('\n').filter((l) => l && !l.startsWith('#')).join('\n') + '\n';
    } catch { ks = ''; await sleep(250); }
  }
  assert.ok(ks.trim(), 'ssh-keyscan produced no keys');
  fs.writeFileSync(path.join(HOME, '.ssh', 'known_hosts'), ks);

  // seed one saved session (plaintext marker pw, accepted by decryptPw)
  const ud = path.join(HOME, '.config', 'Filessh');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'sessions.json'), JSON.stringify([{
    id: 's1', name: 'e2e', host: '127.0.0.1', port: 2222, username: 'tester',
    passwordEnc: 'plain:testpw', autoReconnect: true,
  }]));

  // 1. connect: exactly ONE prompt must arrive
  await handlers['ssh:connect']({}, { tabId: 't1', sessionId: 's1', cols: 80, rows: 24 });
  await waitFor(() => dataFor('t1').includes('tester@test'), 8000, 'prompt');
  await sleep(400); // let any duplicate arrive
  const first = dataFor('t1');
  if (process.env.E2E_DUMP) {
    console.log('EVENTS:', JSON.stringify(events.map((e) => ({ ch: e.ch, seq: e.seq, n: String(e.data).length, head: String(e.data).slice(0, 40) })), null, 1));
  }
  assert.strictEqual(first, 'tester@test:~$ ', `initial bytes must be exactly one prompt, got ${JSON.stringify(first)}`);
  console.log('PASS: single prompt on connect');

  // 2. echo works once
  listeners['ssh:input']({}, { tabId: 't1', data: Buffer.from('echo hi\n').toString('base64') });
  await waitFor(() => dataFor('t1').includes('hi\n'), 5000, 'echo');
  const count = (dataFor('t1').match(/tester@test:~\$ /g) || []).length;
  assert.strictEqual(count, 2, `expected 2 prompts total, got ${count}`);
  console.log('PASS: echo round-trip single');

  // 3. exit closes tab (ssh-exited) and does NOT reconnect
  events.length = 0;
  listeners['ssh:input']({}, { tabId: 't1', data: Buffer.from('exit\n').toString('base64') });
  await waitFor(() => events.some((e) => e.ch === 'ssh-exited-t1'), 5000, 'ssh-exited');
  console.log('PASS: exit closes tab, no reconnect');
  await sleep(4500); // reconnect window (2s * attempt1) must stay silent
  const reopened = events.filter((e) => e.ch === 'ssh-data-t1').map((e) => Buffer.from(e.data, 'base64').toString()).join('');
  assert.ok(!reopened.includes('tester@test'), `reconnected after exit: ${JSON.stringify(reopened)}`);
  console.log('PASS: no reconnect after clean exit');

  srv.close();
  console.log('E2E_ALL_OK');
  process.exit(0);
})().catch((e) => { console.error('E2E_FAIL:', e.message); process.exit(1); });
