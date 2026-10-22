// Tauri bridge: implements the same window.filessh API as preload.js (Electron)
// using the Tauri v2 global (window.__TAURI__). Loaded only when running
// under Tauri; under Electron the file no-ops because __TAURI__ is absent.
// GUI (index.html/styles.css/renderer.js) is unchanged — exact look preserved.
(function () {
  var T = window.__TAURI__;
  if (!T || !T.core) return; // Electron: keep preload bridge
  var invoke = T.core.invoke;
  var listen = T.event.listen;
  var unlistens = {};

  function on(evt, cb) {
    listen(evt, function (e) { cb(e.payload); }).then(function (u) {
      (unlistens[evt] = unlistens[evt] || []).push(u);
    });
  }

  window.filessh = {
    listSessions: function () { return invoke('sessions_list'); },
    saveSession: function (s) { return invoke('sessions_save', { input: s }); },
    deleteSession: function (id) { return invoke('sessions_delete', { id: id }); },
    importPath: function () { return invoke('import_file_dialog'); },
    importFile: function () { return invoke('import_file_dialog'); },
    exportFile: function (format) { return invoke('export_file_dialog', { format: format }); },
    importXml: function (xml) { return invoke('import_filezilla_xml', { xml: xml }); },
    autodetect: function () { return invoke('import_autodetect'); },
    pickFile: function (opts) {
      opts = opts || {};
      return invoke('pick_file', { title: opts.title || null, save: !!opts.save, defaultPath: opts.defaultPath || null });
    },
    connect: function (args) { return invoke('ssh_connect', { args: args }); },
    disconnect: function (tabId) { return invoke('ssh_disconnect', { tabId: tabId }); },
    sendInput: function (tabId, b64) { invoke('ssh_input', { tabId: tabId, data: b64 }); },
    resize: function (tabId, cols, rows) { invoke('ssh_resize', { tabId: tabId, cols: cols, rows: rows }); },
    sftpList: function (sessionId, remotePath) { return invoke('sftp_list', { sessionId: sessionId, remotePath: remotePath || '.' }); },
    onData: function (tabId, cb) { on('ssh-data-' + tabId, cb); },
    onStatus: function (tabId, cb) { on('ssh-status-' + tabId, function (s) { cb(s); }); },
    onClosed: function (tabId, cb) { on('ssh-closed-' + tabId, function (s) { cb(s); }); },
    onExited: function (tabId, cb) { on('ssh-exited-' + tabId, function (s) { cb(s); }); },
    onVerify: function (tabId, cb) { on('ssh-verify-' + tabId, function (s) { cb(s); }); },
    respondVerify: function (tabId, decision) { invoke('ssh_verify_response', { tabId: tabId, decision: decision }); },
    onMenu: function () {},
    clipboard: {
      readText: function () { return T.clipboardManager.readText(); },
      writeText: function (text) { return T.clipboardManager.writeText(text); },
    },
  };
})();
