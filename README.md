# Filessh — Solar-PuTTY style SSH client for Linux

Tabbed GUI SSH client with FileZilla SFTP import.

## Stack — why both, not either/or

> **Paramiko (Python) / `ssh2` (Node) = transport. xterm.js = terminal emulator.**
> You need both: one speaks SSH, the other draws the terminal.

| Layer | Choice in this project | Why |
|---|---|---|
| SSH transport | Node `ssh2` (Electron) / Rust `ssh2` crate (Tauri) | Channels/shell/SFTP, key + password auth |
| Terminal emulation | `xterm.js` + `addon-fit` (vendored in `renderer/vendor/`, shared by both shells) | Full VT100/xterm parsing, colors, ncurses/vim/htop work |
| Shell | Electron (`main.js`) **or** Tauri v2 / Wry (`src-tauri/`) — same GUI | Linux-native; Tauri binary is ~15 MB vs ~108 MB Electron AppImage |

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

## Run (dev)

```bash
npm install
npm start          # Electron
npm run tauri:dev  # Tauri (same renderer/, Rust backend)
```

## Release

```bash
npm run dist         # Electron -> dist/Filessh-0.1.0.AppImage (108 MB)
npm run tauri:build  # Tauri -> src-tauri/target/release/bundle/ (~15 MB, webkit system)
```

## Tests

```bash
node test/e2e.js                                  # Electron SSH stack vs in-process fake server
npm run test:rust                                 # Rust: filezilla/csv/crypto round-trips (3 tests)
```

## Wayland note

On Wayland (e.g. KDE), WebKitGTK's DMABUF renderer can abort with
`Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`.
The Rust backend sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` in-process when
`WAYLAND_DISPLAY` is present, so no manual env is needed. If you still hit
compositor issues, fall back to XWayland for that run:

```bash
GDK_BACKEND=x11 npm run tauri:dev
```

Attach the AppImage to a GitHub Release. It bundles its own desktop entry
(`StartupWMClass=filessh`), so window managers associate it correctly.

## Import test

```bash
node lib/filezilla.js ./sample-filezilla-sitemanager.xml
```
