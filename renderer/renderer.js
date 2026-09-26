let sessions = [];
let activeTab = 'overview';
let term = null, fit = null, currentTabId = null;

const $ = (id) => document.getElementById(id);

// ---- terminal themes + emulation prefs (persisted) ----
const THEMES = {
  dark:      { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a' },
  light:     { background: '#fafafa', foreground: '#333333', cursor: '#e8641b', selectionBackground: '#cce0ff' },
  dracula:   { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#bfbfbf' },
  solarized: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5' },
  monokai:   { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e', black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2' },
  nord:      { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0' },
};
const TERM_TYPES = ['xterm-256color', 'xterm', 'vt100', 'screen', 'linux'];
let termPrefs = { theme: 'dark', term: 'xterm-256color', fontSize: 14, cursor: 'block', blink: true };
try { Object.assign(termPrefs, JSON.parse(localStorage.getItem('filessh-term-prefs') || '{}')); } catch {}
function saveTermPrefs() { localStorage.setItem('filessh-term-prefs', JSON.stringify(termPrefs)); }

function applyTermPrefs() {
  if (!term) return;
  term.options.theme = THEMES[termPrefs.theme] || THEMES.dark;
  term.options.fontSize = termPrefs.fontSize;
  term.options.cursorStyle = termPrefs.cursor;
  term.options.cursorBlink = termPrefs.blink;
  if (window.__fit) { try { window.__fit.fit(); } catch {} }
  term.focus();
}

async function refresh() {
  sessions = await window.filessh.listSessions();
  renderCards();
}

function renderCards() {
  const q = $('search').value.toLowerCase();
  const box = $('cards');
  box.innerHTML = '';
  for (const s of sessions) {
    if (q && !`${s.name} ${s.host} ${s.username}`.toLowerCase().includes(q)) continue;
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<h4>${esc(s.name)}</h4>
      <div class="meta">${esc(s.username)}@${esc(s.host)}:${esc(String(s.port || 22))}</div>
      <div class="meta">SSH/SFTP ${s.hasPassword ? '· saved login' : ''} ${s.source === 'filezilla' ? '· from FileZilla' : ''}</div>
      <div class="row"></div>`;
    const row = div.querySelector('.row');
    const bConnect = btn('Connect', () => openSession(s));
    const bEdit = btn('Edit', () => openEditor(s));
    const bDel = btn('Delete', async () => { await window.filessh.deleteSession(s.id); refresh(); });
    row.append(bConnect, bEdit, bDel);
    box.appendChild(div);
  }
}

function btn(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function openSession(s) {
  const tabId = `t-${Date.now().toString(36)}`;
  addTab(tabId, s.name);
  showTerminal(tabId, s.name);
  wireTerminal(tabId, s.id);
  try {
    await window.filessh.connect({ tabId, sessionId: s.id, termType: termPrefs.term });
  } catch (err) {
    $('termstatus').textContent = 'error: ' + (err.message || err);
    if (term) term.writeln('\r\n*** connection failed: ' + (err.message || err) + ' ***');
  }
}

async function quickConnect() {
  const host = $('q-host').value.trim() || $('search').value.trim();
  if (!host) return;
  let user = $('q-user').value.trim() || 'root';
  const password = $('q-pass').value || '';
  let port = Number($('q-port').value) || 22;
  const m = host.match(/^(?:(.*)@)?([^:]+)(?::(\d+))?$/);
  if (m && (m[1] || m[2])) { if (m[1]) user = m[1]; port = Number(m[3]) || port; }
  const target = m ? m[2] : host;
  const tabId = `t-${Date.now().toString(36)}`;
  addTab(tabId, `${user}@${target}`);
  showTerminal(tabId, `${user}@${target}`);
  wireTerminal(tabId, null);
  try {
    await window.filessh.connect({ tabId, quick: { host: target, username: user, password, port }, termType: termPrefs.term });
  } catch (err) {
    $('termstatus').textContent = 'error: ' + (err.message || err);
    if (term) term.writeln('\r\n*** connection failed: ' + (err.message || err) + ' ***');
  }
}

function addTab(tabId, label) {
  const tabs = $('tabs');
  const b = document.createElement('button');
  b.className = 'tab';
  b.textContent = label;
  b.dataset.tab = tabId;
  b.onclick = () => { activeTab = tabId; paintTabs(); };
  tabs.appendChild(b);
  activeTab = tabId;
  paintTabs();
}

function paintTabs() {
  document.querySelectorAll('#tabs .tab').forEach(t => {
    const on = (t.dataset.tab || 'overview') === (activeTab || 'overview');
    t.classList.toggle('active', on);
  });
  $('overview').classList.toggle('hidden', activeTab !== 'overview');
  $('termview').classList.toggle('hidden', activeTab === 'overview');
  if (window.__fit && activeTab !== 'overview') setTimeout(() => { window.__fit.fit(); if (term) term.focus(); }, 50);
  else if (activeTab === 'overview') setTimeout(() => $('search').focus(), 50);
}

function showTerminal(tabId, label) {
  currentTabId = tabId;
  activeTab = tabId;
  paintTabs();
  $('termstatus').textContent = 'connecting…';
  if (term) { term.dispose(); }
  term = new Terminal({
    cursorBlink: termPrefs.blink,
    cursorStyle: termPrefs.cursor,
    fontSize: termPrefs.fontSize,
    fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
    scrollback: 5000,
    theme: THEMES[termPrefs.theme] || THEMES.dark,
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('terminal'));
  fit.fit();
  window.__fit = fit;
  term.focus(); // cursor starts in the terminal
  $('terminal').onclick = () => term && term.focus();
  term.onData((d) => window.filessh.sendInput(tabId, btoa(unescape(encodeURIComponent(d)))));
  term.onResize(({ cols, rows }) => window.filessh.resize(tabId, cols, rows));
}

function wireTerminal(tabId, sessionId) {
  window.filessh.onData(tabId, (b64) => {
    try { term.write(new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)))); } catch {}
  });
  window.filessh.onStatus(tabId, (s) => {
    $('termstatus').textContent = s.status;
    $('termstatus').classList.toggle('error', /^(error|host key rejected)/i.test(s.status));
  });
  window.filessh.onClosed(tabId, () => { $('termstatus').textContent = 'disconnected'; });
  $('term-close').onclick = async () => {
    await window.filessh.disconnect(tabId);
    document.querySelector(`#tabs .tab[data-tab="${tabId}"]`)?.remove();
    activeTab = 'overview';
    paintTabs();
  };
  $('sftp-toggle').onclick = () => $('sftp').classList.toggle('hidden');
  $('sftp-go').onclick = async () => {
    if (!sessionId) { $('sftp-list').textContent = 'SFTP browser needs a saved session.'; return; }
    try {
      const list = await window.filessh.sftpList(sessionId, $('sftp-path').value || '.');
      $('sftp-list').innerHTML = list.map(f => `<div>${esc(f.filename)} <span style="color:#888">${esc(String(f.attrs.size))}</span></div>`).join('');
    } catch (err) {
      $('sftp-list').textContent = 'Error: ' + err.message;
    }
  };
}

function openEditor(s) {
  $('e-name').value = s?.name || '';
  $('e-host').value = s?.host || '';
  $('e-port').value = s?.port || 22;
  $('e-user').value = s?.username || '';
  $('e-auth').value = s?.authType || 'password';
  $('e-password').value = '';
  $('e-keyfile').value = s?.keyfile || '';
  $('e-script').value = s?.startupScript || '';
  $('e-reconnect').checked = s?.autoReconnect !== false;
  $('editor').showModal();
  $('e-save').onclick = async (ev) => {
    ev.preventDefault();
    await window.filessh.saveSession({
      id: s?.id,
      name: $('e-name').value.trim(),
      host: $('e-host').value.trim(),
      port: Number($('e-port').value) || 22,
      username: $('e-user').value.trim(),
      authType: $('e-auth').value,
      password: $('e-password').value || undefined,
      keyfile: $('e-keyfile').value.trim(),
      startupScript: $('e-script').value,
      autoReconnect: $('e-reconnect').checked,
    });
    $('editor').close();
    refresh();
  };
}

$('search').addEventListener('input', renderCards);
$('q-connect').onclick = quickConnect;
$('newtab').onclick = () => { activeTab = 'overview'; paintTabs(); $('search').focus(); };
$('manage').onclick = openManager;
document.querySelector('#tabs .tab').onclick = () => { activeTab = 'overview'; paintTabs(); };
$('import').onclick = async () => {
  const r = await window.filessh.importPath();
  if (!r) return;
  alert(`Imported ${r.added}/${r.total} SSH sessions. Skipped ${r.skipped.length} FTP-only entries.`);
  refresh();
};

// ---- host-key verify prompt (one global listener, routed per tab) ----
let pendingVerifyTab = null;
function ensureVerifyListener(tabId) {
  window.filessh.onVerify(tabId, (info) => showVerify(tabId, info));
}

function showVerify(tabId, info) {
  pendingVerifyTab = tabId;
  $('v-title').textContent = info.mode === 'changed'
    ? `WARNING: host key changed!`
    : `Unknown host: ${info.host}:${info.port}`;
  $('v-text').textContent = info.mode === 'changed'
    ? `The key presented does not match ~/.ssh/known_hosts. Possible MITM attack. Only accept if you changed the server key yourself. Known: ${(info.known || []).join(', ')}`
    : `No cached key for this host. Verify the fingerprint out-of-band, then accept. User + saved password will be sent automatically after you accept.`;
  $('v-keys').innerHTML = info.keys.map(k =>
    `<div><b>${esc(k.type)}</b><br><span style="font-family:monospace">${esc(k.sha256)}</span><br><span style="color:#666;font-size:12px">MD5:${esc(k.md5)}</span></div>`).join('<hr>');
  if (!$('verify').open) $('verify').showModal();
  ensureVerifyChoice(tabId);
}

function ensureVerifyChoice(tabId) {
  const done = (d) => { window.filessh.respondVerify(tabId, d); $('verify').close(); if (term) term.focus(); };
  $('v-save').onclick = () => done('save');
  $('v-once').onclick = () => done('once');
  $('v-reject').onclick = () => done('reject');
}

// hook verify listener into tab creation
const _wireTerminal = wireTerminal;
wireTerminal = function (tabId, sessionId) {
  ensureVerifyListener(tabId);
  _wireTerminal(tabId, sessionId);
};

// ---- Site Manager (FileZilla-style: modify sites) ----
let mgrSelected = null;

async function openManager() {
  await refresh();
  mgrSelected = sessions[0]?.id || null;
  renderMgrTree();
  renderMgrForm();
  if (!$('manager').open) $('manager').showModal();
}

function renderMgrTree() {
  const q = ($('m-search').value || '').toLowerCase();
  const tree = $('mgr-tree');
  tree.innerHTML = '';
  const groups = {};
  for (const s of sessions) {
    if (q && !`${s.name} ${s.host} ${s.username}`.toLowerCase().includes(q)) continue;
    const g = s.folder || s.group || '';
    (groups[g] = groups[g] || []).push(s);
  }
  for (const g of Object.keys(groups).sort()) {
    if (g) { const h = document.createElement('div'); h.className = 'mgr-folder'; h.textContent = g; tree.appendChild(h); }
    for (const s of groups[g]) {
      const b = document.createElement('button');
      b.className = 'mgr-item' + (s.id === mgrSelected ? ' selected' : '');
      b.innerHTML = `${esc(s.name)}<br><span class="sub">${esc(s.username)}@${esc(s.host)}:${esc(String(s.port || 22))}</span>`;
      b.onclick = () => { mgrSelected = s.id; renderMgrTree(); renderMgrForm(); };
      b.ondblclick = () => { $('manager').close(); openSession(s); };
      tree.appendChild(b);
    }
  }
}

function renderMgrForm() {
  const s = sessions.find(x => x.id === mgrSelected);
  $('m-status').textContent = '';
  for (const [id, val] of [
    ['m-name', s?.name || ''], ['m-group', s?.folder || s?.group || ''],
    ['m-host', s?.host || ''], ['m-port', s?.port || 22],
    ['m-user', s?.username || ''], ['m-keyfile', s?.keyfile || ''],
    ['m-script', s?.startupScript || ''],
  ]) $(id).value = val;
  $('m-proto').value = 'sftp';
  $('m-logon').value = s ? (s.keyfile ? '4' : (s.hasPassword ? '1' : '2')) : '1';
  $('m-password').value = '';
  $('m-reconnect').checked = s?.autoReconnect !== false;
  $('m-save').disabled = !s;
  $('m-connect').disabled = !s;
}

async function mgrCollect() {
  const s = sessions.find(x => x.id === mgrSelected);
  if (!s) return null;
  const logon = $('m-logon').value;
  const rec = {
    id: s.id,
    name: $('m-name').value.trim() || s.name,
    folder: $('m-group').value.trim(),
    host: $('m-host').value.trim(),
    port: Number($('m-port').value) || 22,
    username: logon === '0' ? 'anonymous' : $('m-user').value.trim(),
    keyfile: $('m-keyfile').value.trim(),
    startupScript: $('m-script').value,
    autoReconnect: $('m-reconnect').checked,
    source: s.source,
  };
  if (logon === '0') rec.password = '';
  else if ($('m-password').value) rec.password = $('m-password').value;
  else rec.password = undefined; // keep stored
  if (logon === '4' && !rec.keyfile) { $('m-status').textContent = 'Key file logon needs a key path.'; return null; }
  return rec;
}

$('m-search').addEventListener('input', renderMgrTree);
$('m-new').onclick = async () => {
  const rec = await window.filessh.saveSession({ name: 'New site', host: '', port: 22, username: 'root', authType: 'password', folder: '' });
  await refresh();
  mgrSelected = rec.id;
  renderMgrTree(); renderMgrForm();
};
$('m-folder').onclick = () => { $('m-group').focus(); };
$('m-dup').onclick = async () => {
  const s = sessions.find(x => x.id === mgrSelected);
  if (!s) return;
  const rec = await window.filessh.saveSession({ name: s.name + ' (copy)', host: s.host, port: s.port, username: s.username, authType: s.authType, folder: s.folder || s.group || '', keyfile: s.keyfile || '', startupScript: s.startupScript || '', autoReconnect: s.autoReconnect !== false });
  await refresh();
  mgrSelected = rec.id;
  renderMgrTree(); renderMgrForm();
};
$('m-del').onclick = async () => {
  if (!mgrSelected) return;
  await window.filessh.deleteSession(mgrSelected);
  await refresh();
  mgrSelected = sessions[0]?.id || null;
  renderMgrTree(); renderMgrForm();
};
$('m-save').onclick = async () => {
  const rec = await mgrCollect();
  if (!rec) return;
  await window.filessh.saveSession(rec);
  await refresh();
  $('m-status').textContent = 'Saved.';
  renderMgrTree(); renderMgrForm();
};
$('m-connect').onclick = async () => {
  const rec = await mgrCollect();
  if (!rec) return;
  await window.filessh.saveSession(rec);
  await refresh();
  $('manager').close();
  openSession(sessions.find(x => x.id === mgrSelected));
};
$('m-close').onclick = () => $('manager').close();

// ---- terminal appearance + emulation controls ----
(function initTermControls() {
  const themeSel = $('t-theme'), termSel = $('t-term'), cursorSel = $('t-cursor');
  for (const name of Object.keys(THEMES)) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name[0].toUpperCase() + name.slice(1);
    themeSel.appendChild(o);
  }
  for (const t of TERM_TYPES) {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    termSel.appendChild(o);
  }
  themeSel.value = termPrefs.theme;
  termSel.value = termPrefs.term;
  cursorSel.value = termPrefs.cursor;
  paintBlink();
  themeSel.onchange = () => { termPrefs.theme = themeSel.value; saveTermPrefs(); applyTermPrefs(); };
  termSel.onchange = () => { termPrefs.term = termSel.value; saveTermPrefs(); };
  cursorSel.onchange = () => { termPrefs.cursor = cursorSel.value; saveTermPrefs(); applyTermPrefs(); };
  $('t-blink').onclick = () => { termPrefs.blink = !termPrefs.blink; saveTermPrefs(); applyTermPrefs(); paintBlink(); };
  $('t-smaller').onclick = () => { termPrefs.fontSize = Math.max(9, termPrefs.fontSize - 1); saveTermPrefs(); applyTermPrefs(); };
  $('t-bigger').onclick = () => { termPrefs.fontSize = Math.min(24, termPrefs.fontSize + 1); saveTermPrefs(); applyTermPrefs(); };
  function paintBlink() { $('t-blink').style.opacity = termPrefs.blink ? '1' : '0.45'; }
})();

refresh();
