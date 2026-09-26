const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('filessh', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  importPath: () => ipcRenderer.invoke('import:filezilla-path'),
  importXml: (xml) => ipcRenderer.invoke('import:filezilla-xml', xml),
  autodetect: () => ipcRenderer.invoke('import:filezilla-autodetect'),
  pickFile: (opts) => ipcRenderer.invoke('dialog:open-file', opts || {}),
  connect: (args) => ipcRenderer.invoke('ssh:connect', args),
  disconnect: (tabId) => ipcRenderer.invoke('ssh:disconnect', { tabId }),
  sendInput: (tabId, b64) => ipcRenderer.send('ssh:input', { tabId, data: b64 }),
  resize: (tabId, cols, rows) => ipcRenderer.send('ssh:resize', { tabId, cols, rows }),
  sftpList: (sessionId, remotePath) => ipcRenderer.invoke('sftp:list', { sessionId, remotePath }),
  onData: (tabId, cb) => ipcRenderer.on(`ssh-data-${tabId}`, (e, b64) => cb(b64)),
  onStatus: (tabId, cb) => ipcRenderer.on(`ssh-status-${tabId}`, (e, s) => cb(s)),
  onClosed: (tabId, cb) => ipcRenderer.on(`ssh-closed-${tabId}`, (e, s) => cb(s)),
  onVerify: (tabId, cb) => ipcRenderer.on(`ssh-verify-${tabId}`, (e, info) => cb(info)),
  respondVerify: (tabId, decision) => ipcRenderer.send('ssh:verify-response', { tabId, decision }),
  onMenu: (cb) => ipcRenderer.on('menu:action', (e, a) => cb(a)),
});
