let sessions = [];
let activeTab = 'overview';
let term = null, fit = null, currentTabId = null;

const $ = (id) => document.getElementById(id);

// ---- GUI theme (app chrome; terminal themes are separate) ----
const GUI_THEMES = { light: 'Light', dark: 'Dark', nord: 'Nord', dracula: 'Dracula', solar: 'Solarized', ocean: 'Ocean' };
let guiTheme = localStorage.getItem('filessh-gui-theme') || 'light';
if (!GUI_THEMES[guiTheme]) guiTheme = 'light';
function applyGuiTheme() {
  document.body.dataset.guitheme = guiTheme;
  localStorage.setItem('filessh-gui-theme', guiTheme);
  if ($('gui-theme')) $('gui-theme').value = guiTheme;
  if ($('s-guitheme') && $('s-guitheme').options.length) $('s-guitheme').value = guiTheme;
}
function setGuiTheme(name) {
  if (!GUI_THEMES[name]) return;
  guiTheme = name;
  applyGuiTheme();
}

// ---- terminal themes + emulation prefs (persisted) ----
// Groups: light schemes first, then dark + color variations.
// Groups: light schemes first, then dark + color variations.
const THEME_GROUPS = { Light: ['paper', 'github', 'solLight', 'latte'], Dark: ['dark', 'mocha', 'onedark', 'dracula', 'monokai', 'nord', 'solDark', 'gruvbox', 'tokyo', 'palenight'] };
const THEMES = {
  paper:    { label: 'Paper', background: '#ffffff', foreground: '#1f2328', cursor: '#e8641b', selectionBackground: '#c9e2ff' },
  github:   { label: 'GitHub Light', background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#c9e2ff', black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700', brightBlue: '#0969da', brightMagenta: '#8250df', brightCyan: '#1b7c83', brightWhite: '#8c959f' },
  solLight: { label: 'Solarized Light', background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  latte:    { label: 'Catppuccin Latte', background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selectionBackground: '#ccd0da', black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', magenta: '#ea76cb', cyan: '#179299', white: '#acb0be', brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b', brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#ea76cb', brightCyan: '#179299', brightWhite: '#bcc0cc' },
  dark:     { label: 'Dark', background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a' },
  mocha:    { label: 'Catppuccin Mocha', background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b70', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' },
  onedark:  { label: 'One Dark', background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451', black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf', brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' },
  dracula:  { label: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#bfbfbf', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
  monokai:  { label: 'Monokai', background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e', black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2', brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5' },
  nord:     { label: 'Nord', background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' },
  solDark:  { label: 'Solarized Dark', background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  gruvbox:  { label: 'Gruvbox', background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: '#504945', black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984', brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2' },
  tokyo:    { label: 'Tokyo Night', background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c', black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5' },
  palenight:{ label: 'Material Palenight', background: '#292d3e', foreground: '#a6accd', cursor: '#ffcc00', selectionBackground: '#444267', black: '#292d3e', red: '#f07178', green: '#c3e88d', yellow: '#ffcb6b', blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#d0d0d0', brightBlack: '#434758', brightRed: '#f07178', brightGreen: '#c3e88d', brightYellow: '#ffcb6b', brightBlue: '#82aaff', brightMagenta: '#c792ea', brightCyan: '#89ddff', brightWhite: '#ffffff' },
};
const TERM_TYPES = ['xterm-256color', 'xterm', 'vt100', 'screen', 'linux'];
let termPrefs = { theme: 'dark', term: 'xterm-256color', fontSize: 14, cursor: 'block', blink: true, scrollback: 5000 };
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
    await window.filessh.connect({ tabId, sessionId: s.id, termType: termPrefs.term, logDir: appSettings.logDir, autoLog: appSettings.autoLog });
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
    await window.filessh.connect({ tabId, quick: { host: target, username: user, password, port }, termType: termPrefs.term, logDir: appSettings.logDir, autoLog: appSettings.autoLog });
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
    scrollback: termPrefs.scrollback,
    theme: THEMES[termPrefs.theme] || THEMES.dark,
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('terminal'));
  fit.fit();
  window.__fit = fit;
  term.focus(); // cursor starts in the terminal
  $('terminal').onclick = () => term && term.focus();
  // clipboard behavior (Settings)
  $('terminal').oncontextmenu = async (ev) => {
    ev.preventDefault();
    if (!appSettings.pasteRight || !term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) window.filessh.sendInput(tabId, btoa(unescape(encodeURIComponent(text))));
    } catch {}
    term.focus();
  };
  term.onSelectionChange(() => {
    if (!appSettings.copySelect || !term) return;
    try { navigator.clipboard.writeText(term.getSelection()); } catch {}
  });
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
    const connected = $('termstatus').textContent === 'connected';
    if (connected && appSettings.confirmClose && !confirm(`Close ${document.querySelector(`#tabs .tab[data-tab="${tabId}"]`)?.textContent || 'tab'}?`)) return;
    await window.filessh.disconnect(tabId);
    document.querySelector(`#tabs .tab[data-tab="${tabId}"]`)?.remove();
    activeTab = 'overview';
    paintTabs();
  };
  $('sftp-toggle').onclick = () => $('sftp').classList.toggle('hidden');
  if ($('sftp-path').value === '.') $('sftp-path').value = appSettings.sftpPath || '.';
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
    ['m-ka-interval', s?.keepaliveInterval ?? ''], ['m-ka-count', s?.keepaliveCountMax ?? ''],
    ['m-ciphers', s?.ciphers || ''], ['m-kex', s?.kex || ''], ['m-hostkeys', s?.hostkeys || ''],
    ['m-logpath', s?.logPath || ''], ['m-x11screen', s?.x11Screen ?? 0],
  ]) $(id).value = val;
  $('m-proto').value = 'sftp';
  $('m-logon').value = s ? (s.keyfile ? '4' : (s.hasPassword ? '1' : '2')) : '1';
  $('m-password').value = '';
  $('m-keypass').value = '';
  $('m-agent').checked = s?.agentForward === true;
  $('m-x11').checked = s?.x11 === true;
  $('m-log').checked = s ? (s.logSession === true || (appSettings.autoLog && s.logSession !== false)) : appSettings.autoLog;
  $('m-reconnect').checked = s ? (s.autoReconnect !== false) : appSettings.defaultReconnect;
  // jump host options (any other saved site)
  const jump = $('m-jump');
  jump.innerHTML = '<option value="">Direct connection</option>';
  for (const o of sessions) {
    if (o.id === mgrSelected) continue;
    const el = document.createElement('option');
    el.value = o.id; el.textContent = `${o.name} (${o.username}@${o.host})`;
    jump.appendChild(el);
  }
  jump.value = s?.jumpSessionId || '';
  mgrFwRows = Array.isArray(s?.forwards) ? JSON.parse(JSON.stringify(s.forwards)) : [];
  renderFwRows();
  $('m-save').disabled = !s;
  $('m-connect').disabled = !s;
}

let mgrFwRows = [];

function renderFwRows() {
  const box = $('m-forwards');
  box.innerHTML = '';
  mgrFwRows.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'fw-row';
    row.innerHTML = `
      <select data-k="type">
        <option value="local">Local</option>
        <option value="remote">Remote</option>
        <option value="dynamic">SOCKS</option>
      </select>
      <input data-k="bindHost" placeholder="127.0.0.1" title="Bind address">
      <input data-k="bindPort" placeholder="port" title="Bind port">
      <input data-k="targetHost" placeholder="target host" title="Target host (local/remote)">
      <input data-k="targetPort" placeholder="port" title="Target port (local/remote)">
      <button type="button" title="Remove">×</button>`;
    const [typeSel, bh, bp, th, tp, del] = row.children;
    typeSel.value = f.type || 'local';
    bh.value = f.bindHost || ''; bp.value = f.bindPort ?? '';
    th.value = f.targetHost || ''; tp.value = f.targetPort ?? '';
    const isDyn = () => typeSel.value === 'dynamic';
    const paint = () => { th.disabled = isDyn(); tp.disabled = isDyn(); };
    paint();
    typeSel.onchange = () => { f.type = typeSel.value; paint(); };
    bh.oninput = () => f.bindHost = bh.value;
    bp.oninput = () => f.bindPort = bp.value;
    th.oninput = () => f.targetHost = th.value;
    tp.oninput = () => f.targetPort = tp.value;
    del.onclick = () => { mgrFwRows.splice(i, 1); renderFwRows(); };
    box.appendChild(row);
  });
  if (!mgrFwRows.length) box.innerHTML = '<div style="color:#888;font-size:12.5px">No tunnels. Local = -L, Remote = -R, SOCKS = -D.</div>';
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
  if ($('m-keypass').value) rec.keyPassphrase = $('m-keypass').value;
  else rec.keyPassphrase = undefined; // keep stored
  if (logon === '4' && !rec.keyfile) { $('m-status').textContent = 'Key file logon needs a key path.'; return null; }
  rec.agentForward = $('m-agent').checked;
  rec.keepaliveInterval = Number($('m-ka-interval').value) || 0;
  rec.keepaliveCountMax = Number($('m-ka-count').value) || 3;
  rec.jumpSessionId = $('m-jump').value || null;
  rec.forwards = mgrFwRows
    .filter(f => f.bindPort)
    .map(f => ({ type: f.type || 'local', bindHost: f.bindHost || '127.0.0.1', bindPort: Number(f.bindPort), targetHost: f.targetHost || 'localhost', targetPort: Number(f.targetPort) || 0 }));
  rec.x11 = $('m-x11').checked;
  rec.x11Screen = Number($('m-x11screen').value) || 0;
  rec.ciphers = $('m-ciphers').value.trim();
  rec.kex = $('m-kex').value.trim();
  rec.hostkeys = $('m-hostkeys').value.trim();
  rec.logSession = $('m-log').checked;
  rec.logPath = $('m-logpath').value.trim();
  return rec;
}

$('m-search').addEventListener('input', renderMgrTree);
$('m-new').onclick = async () => {
  const rec = await window.filessh.saveSession({ name: 'New site', host: '', port: 22, username: 'root', authType: 'password', folder: '', autoReconnect: appSettings.defaultReconnect, keepaliveInterval: appSettings.ka, logSession: appSettings.autoLog });
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
$('m-fwadd').onclick = () => { mgrFwRows.push({ type: 'local', bindHost: '', bindPort: '', targetHost: '', targetPort: '' }); renderFwRows(); };
$('m-keybrowse').onclick = async () => {
  const p = await window.filessh.pickFile({ title: 'Choose private key', filters: [{ name: 'Keys', extensions: ['*'] }] });
  if (p) $('m-keyfile').value = p;
};
$('m-logbrowse').onclick = async () => {
  const p = await window.filessh.pickFile({ title: 'Session log file', save: true, defaultPath: $('m-logpath').value || undefined });
  if (p) $('m-logpath').value = p;
};
$('e-keybrowse').onclick = async () => {
  const p = await window.filessh.pickFile({ title: 'Choose private key', filters: [{ name: 'Keys', extensions: ['*'] }] });
  if (p) $('e-keyfile').value = p;
};
$('m-close').onclick = () => $('manager').close();

// ---- terminal appearance + emulation controls ----
(function initTermControls() {
  const themeSel = $('t-theme'), termSel = $('t-term'), cursorSel = $('t-cursor');
  for (const [group, ids] of Object.entries(THEME_GROUPS)) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id; o.textContent = THEMES[id].label || id;
      og.appendChild(o);
    }
    themeSel.appendChild(og);
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

// ---- GUI theme pickers (overview + settings share state) ----
(function initGuiTheme() {
  const quick = $('gui-theme'), inSettings = $('s-guitheme');
  for (const [id, label] of Object.entries(GUI_THEMES)) {
    const a = document.createElement('option');
    a.value = id; a.textContent = label;
    quick.appendChild(a);
    const b = document.createElement('option');
    b.value = id; b.textContent = label;
    inSettings.appendChild(b);
  }
  quick.onchange = () => setGuiTheme(quick.value);
  applyGuiTheme();
})();

// ---- app settings (persisted) ----
let appSettings = { confirmClose: true, defaultReconnect: true, sftpPath: '.', copySelect: false, pasteRight: true, ka: 0, logDir: '', autoLog: false };
try { Object.assign(appSettings, JSON.parse(localStorage.getItem('filessh-settings') || '{}')); } catch {}
function saveAppSettings() { localStorage.setItem('filessh-settings', JSON.stringify(appSettings)); }

function openSettings() {
  const st = $('s-theme'), tm = $('s-term');
  if (!st.options.length) {
    for (const [group, ids] of Object.entries(THEME_GROUPS)) {
      const og = document.createElement('optgroup');
      og.label = group;
      for (const id of ids) {
        const o = document.createElement('option');
        o.value = id; o.textContent = THEMES[id].label || id;
        og.appendChild(o);
      }
      st.appendChild(og);
    }
    for (const t of TERM_TYPES) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      tm.appendChild(o);
    }
  }
  st.value = termPrefs.theme;
  tm.value = termPrefs.term;
  $('s-guitheme').value = guiTheme;
  $('s-fontsize').value = termPrefs.fontSize;
  $('s-confirm').checked = appSettings.confirmClose;
  $('s-reconnect').checked = appSettings.defaultReconnect;
  $('s-sftppath').value = appSettings.sftpPath;
  $('s-scrollback').value = termPrefs.scrollback;
  $('s-copyselect').checked = appSettings.copySelect;
  $('s-pasteclick').checked = appSettings.pasteRight;
  $('s-ka').value = appSettings.ka;
  $('s-logdir').value = appSettings.logDir;
  $('s-autolog').checked = appSettings.autoLog;
  if (!$('settings').open) $('settings').showModal();
}

$('s-save').onclick = (ev) => {
  ev.preventDefault();
  setGuiTheme($('s-guitheme').value);
  Object.assign(termPrefs, {
    theme: $('s-theme').value, term: $('s-term').value,
    fontSize: Math.min(24, Math.max(9, Number($('s-fontsize').value) || 14)),
    scrollback: Math.min(50000, Math.max(100, Number($('s-scrollback').value) || 5000)),
  });
  saveTermPrefs();
  $('t-theme').value = termPrefs.theme;
  $('t-term').value = termPrefs.term;
  applyTermPrefs();
  Object.assign(appSettings, {
    confirmClose: $('s-confirm').checked, defaultReconnect: $('s-reconnect').checked,
    sftpPath: $('s-sftppath').value.trim() || '.',
    copySelect: $('s-copyselect').checked, pasteRight: $('s-pasteclick').checked,
    ka: Number($('s-ka').value) || 0,
    logDir: $('s-logdir').value.trim(), autoLog: $('s-autolog').checked,
  });
  saveAppSettings();
  $('settings').close();
};

// ---- File menu actions ----
function doImport() {
  window.filessh.importPath().then((r) => {
    if (!r) return;
    alert(`Imported ${r.added}/${r.total} SSH sessions. Skipped ${r.skipped.length} FTP-only entries.`);
    refresh();
  });
}

function closeActiveTab() {
  if (activeTab === 'overview' || !currentTabId) return;
  $('term-close').click();
}

window.filessh.onMenu((action) => {
  if (action === 'manager') openManager();
  else if (action === 'import') doImport();
  else if (action === 'settings') openSettings();
  else if (action === 'close-tab') closeActiveTab();
});

refresh();
