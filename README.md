# Filessh — Solar-PuTTY style SSH client for Linux

Tabbed GUI SSH client with FileZilla SFTP import.

## Stack — why both, not either/or

> **Paramiko (Python) / `ssh2` (Node) = transport. xterm.js = terminal emulator.**
> You need both: one speaks SSH, the other draws the terminal.

| Layer | Choice in this project | Why |
|---|---|---|
| SSH transport | Node `ssh2` (equivalent of Paramiko) | Actively maintained, channels/shell/SFTP, key + password auth, port forwarding |
| Terminal emulation | `xterm.js` + `addon-fit` | Full VT100/xterm parsing, colors, ncurses/vim/htop work. A Qt text box or Paramiko-only shell can't do this reliably |
| Shell | Electron | Linux-native, one codebase, `safeStorage` for encrypted passwords |

If you insisted on pure Python, you'd still embed xterm.js in a `QWebEngineView` and keep Paramiko only for transport — same split, more glue code.

## Features (v0.1 MVP)

- Solar-PuTTY layout: left session tree + search, top tabs, quick-connect bar
- Saved sessions in `~/.config/filessh/sessions.json`, passwords via Electron `safeStorage`
- SSH password + key-file auth, StrictHostKeyChecking prompt + known_hosts
- SFTP browser panel (list/download/upload) per tab
- FileZilla import: `sitemanager.xml` + `recentservers.xml`
  - Host, port, user, protocol filter (SFTP/SSH only or all)
  - Base64 password decode (Logontype=Normal). Warns on master-password-protected entries
  - Keyfile path carry-over
  - Auto-detects `~/.config/filezilla/` and `~/.filezilla/`

## Settings reference

Per-site (Site Manager → Advanced sections):

- Connection: keep-alive interval / max misses (`ServerAliveInterval`), jump-host/bastion session
- Authentication: key-file picker, encrypted key passphrase, SSH agent forwarding toggle
- Tunnels: Local (`-L`), Remote (`-R`), Dynamic SOCKS (`-D`) forwarding matrix
- X11 forwarding checkbox + display screen
- Crypto: cipher / KEX / host-key algorithm allow-lists (blank = ssh2 defaults)
- Logging: per-session terminal log file (blank = auto `~/.config/filessh/logs/`)

App Settings (File → Settings):

- Terminal theme default, TERM emulation, font size, scrollback rows
- Copy-on-select, right-click paste, close-tab confirm
- SFTP initial path, log directory, log-all default, keep-alive + auto-reconnect defaults

## FileZilla paths probed

- `~/.config/filezilla/sitemanager.xml`
- `~/.filezilla/sitemanager.xml`
- custom file via Browse button

## Run

```bash
npm install
npm start
```

## Import test

```bash
node lib/filezilla.js ./sample-filezilla-sitemanager.xml
```
