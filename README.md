<div align="center">

<img src="src-tauri/icons/128x128@2x.png" alt="Termifai" width="110" />

# Termifai

**A fast, beautiful, security-first SSH client and terminal emulator for your desktop.**

Built with Rust and Tauri 2 — native performance, tiny footprint, and your secrets never leave your machine unencrypted.

[![CI](https://github.com/rm1dev/termifai/actions/workflows/ci.yml/badge.svg)](https://github.com/rm1dev/termifai/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Backend-Rust-orange?logo=rust)](https://www.rust-lang.org)
[![Tauri 2](https://img.shields.io/badge/Desktop-Tauri%202-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![React 19](https://img.shields.io/badge/UI-React%2019-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Platforms](https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#installation)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Features](#features) · [Security](#security) · [Installation](#installation) · [Development](#development) · [Architecture](#architecture) · [Contributing](#contributing)

<!-- Screenshot: drop a hero screenshot at .github/assets/screenshot-main.png and uncomment -->
<!-- <img src=".github/assets/screenshot-main.png" alt="Termifai main window" width="820" /> -->

</div>

---

## Why Termifai?

Managing servers means trusting your tools with your most sensitive credentials. Termifai is built around a simple principle: **you should never have to take that trust on faith.**

- **Open source, end to end.** Every line of the crypto, sync, and SSH code is in this repository for you to audit.
- **Local-first.** Your hosts, keys, and passwords live on your machine — encrypted at rest. There is no Termifai server, no account, and no telemetry. Zero data collection.
- **Encrypted before it leaves.** Optional multi-device sync encrypts everything client-side with a key derived from your master password. Cloud providers only ever see ciphertext.
- **Real host key verification.** SSH host keys are checked against `known_hosts` and connections hard-fail on a key mismatch — for terminals, tunnels, SFTP, and dashboards alike.
- **Native and lightweight.** A Rust backend and system webview instead of a bundled browser engine — fast startup, low memory, and a real PTY under every tab.

## Features

### 🖥️ Terminal

- **Full PTY terminal** powered by xterm.js and `portable-pty` — spawns a real login shell with your environment intact
- **Tabs & multi-window** — drag to reorder, rename, split work across independent OS windows
- **Quick Terminal** — a Quake-style slide-in panel summoned from anywhere with a global hotkey, anchored to any screen edge. Powered by a tiny background daemon (`termifaid`) so the hotkey works even when the app is closed
- **Live SSH connection progress** — resolving → connecting → handshake → auth → established, parsed from verbose SSH output in real time
- **"Open in Termifai" context menu** (optional) — right-click a folder in macOS Finder or Windows Explorer to open it in a new local terminal tab

### 🗂️ Host Management

- **Host manager** with nested groups, grid/list views, search, and sort
- **One-click connect** with automatic vault-backed authentication
- **Connection testing** before you save

### 🔐 Credentials Vault

- **Master-password vault** for host passwords and secrets — Argon2id key derivation, ChaCha20-Poly1305 encryption ([details below](#security))
- **Flexible lock policies** — lock on app close, on screen lock, on restart, or never; unlock state is cached in the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service)
- **SSH key manager** — generate (Ed25519 / RSA), import, and organize keys

### ☁️ Encrypted Sync

- **Multi-device sync** of hosts, groups, snippets, port forwards, settings, and (optionally) SSH keys
- **Backends:** Google Drive, Dropbox, or any local/self-managed folder (Syncthing, network share, …)
- **End-to-end encrypted** — payloads are sealed with ChaCha20-Poly1305 before upload; the provider stores an opaque blob
- **Conflict-aware merging** — per-entity last-writer-wins with tombstones, so deletions propagate correctly across devices
- **OAuth 2.0 with PKCE** for cloud providers; tokens stored in the OS keychain

### 📁 SFTP

- **Dual-pane file browser** — local and remote side by side
- **Concurrent transfers** with progress, cancellation, and conflict resolution
- **Full remote file management** — rename, delete, mkdir, copy, chmod/chown with user/group picker
- **Edit remotely with local apps** — open a remote file in your editor; Termifai watches it and uploads changes automatically

### 🔀 Port Forwarding

- **Local, remote, and dynamic (SOCKS) tunnels** — saved, labeled, and toggled with one click
- **Live tunnel status** monitoring

### 📊 Server Dashboard

- **Real-time metrics over SSH** — CPU, memory, disk, and network graphs per host
- **Docker container overview** — see container states at a glance
- **Process list** — top processes on the remote machine

### ⚡ Snippets

- **Reusable command & script library** with groups and drag-to-reorder
- **OS-aware targets** — run against local shell or remote hosts
- **Safe remote execution** via SFTP upload or heredoc injection

### 🎨 Experience

- **12 built-in themes** — Termifai Dark/Light, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin Mocha, Solarized Dark/Light, One Dark, Rosé Pine, Kanagawa Wave
- **Customizable keyboard shortcuts**, terminal fonts, and appearance
- **System tray & background mode** with optional autostart
- **Single-instance** app with multi-window support

## Security

Security is a design constraint in Termifai, not a feature checkbox. The vault uses the same envelope-encryption (key-wrapping) architecture as established password managers like Bitwarden and 1Password: your master password never encrypts data directly — it unlocks a random key that does. Here is exactly how your data is protected — all of it verifiable in [`termifai-core/src/crypto.rs`](src-tauri/crates/termifai-core/src/crypto.rs) and [`termifai-core/src/sync/`](src-tauri/crates/termifai-core/src/sync/).

### Vault encryption

| Concern | Implementation |
|---|---|
| Key derivation | **Argon2id** (19 MiB memory, 2 iterations, 32-byte output — OWASP-recommended parameters) over your master password + a random 256-bit per-vault salt |
| Data encryption | **ChaCha20-Poly1305** (AEAD) with a fresh random 96-bit nonce per encryption |
| Key hierarchy | A random 256-bit Data Encryption Key (DEK) encrypts your secrets; the DEK is wrapped by the Argon2id-derived Key Encryption Key (KEK). Changing your master password re-wraps the DEK — no bulk re-encryption |
| Memory hygiene | Vault keys are zeroized on drop (`Zeroize` + `ZeroizeOnDrop`) so they don't linger in RAM |
| Password verification | An encrypted verifier token distinguishes a wrong password from data corruption — the master password itself is never stored |

### SSH trust

- Terminals and tunnels use your **system OpenSSH binary** with `StrictHostKeyChecking=accept-new`: new hosts are recorded, but a **changed host key hard-fails the connection** (trust-on-first-use, never trust-on-every-use).
- SFTP and dashboard sessions (libssh2) **verify the server key against your `~/.ssh/known_hosts`**, including hashed (`HashKnownHosts`) entries, and refuse mismatches with a clear warning.

### Sync encryption

- The sync payload is encrypted **on your device** with a key derived from your master password and a dedicated sync salt (same Argon2id parameters). The remote only ever stores ciphertext plus a manifest containing **no secrets** (format version, device id, KDF parameters, salt, SHA-256 of the encrypted blob).
- Cloud authorization uses **OAuth 2.0 + PKCE** over a loopback redirect; access/refresh tokens are kept in the **OS keychain**, never in plaintext files.

### Data safety

- All configuration is persisted through an atomic store: write to temp file → `fsync` → atomic rename. A crash or power loss can't corrupt your data.
- No telemetry, no analytics, no crash reporting, no network calls other than the connections you initiate.

Found a vulnerability? Please report it privately via [GitHub Security Advisories](https://github.com/rm1dev/termifai/security/advisories/new) rather than a public issue.

## Installation

### Download

Grab the latest build for your platform from the [Releases](https://github.com/rm1dev/termifai/releases) page:

| Platform | Package |
|---|---|
| macOS | `.dmg` |
| Windows | `.exe` NSIS installer (x64 / arm64) |
| Linux | `.deb` (x64 / arm64) |

### Build from source

Prerequisites: [Rust](https://rustup.rs) ≥ 1.77.2, [Bun](https://bun.sh), and the [Tauri 2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/rm1dev/termifai.git
cd termifai
bun install
bun tauri build
```

> **Note (required):** before the first build, copy
> `src-tauri/crates/termifai-core/src/sync/oauth_secrets.example.rs` to `oauth_secrets.rs`
> in the same directory — the sync module includes it at compile time. The placeholder
> values are fine unless you want Google Drive / Dropbox sync, in which case fill in your
> own OAuth client IDs (instructions inside the file). Local-folder sync works either way.

## Development

```bash
bun install          # install frontend dependencies
bun tauri dev        # run the app with hot reload
```

Quality checks (also enforced in CI):

```bash
bunx tsc --noEmit                                                          # typecheck frontend
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check                  # rust formatting
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings  # lints
cargo test --manifest-path src-tauri/Cargo.toml --all-targets              # backend tests
```

## Architecture

```
termifai/
├── src/                      # React 19 + TypeScript frontend (Tailwind v4, shadcn/ui, xterm.js)
├── src-tauri/
│   ├── src/                  # Tauri app: PTY, SFTP, tunnels, dashboard, vault, sync commands
│   ├── crates/
│   │   ├── termifai-core/    # Tauri-free core: crypto, atomic storage, models, sync engine
│   │   └── termifaid/        # Lightweight daemon for global hotkeys & background startup
│   └── finder-extension/     # macOS Finder "Open in Termifai" extension (Swift)
```

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (multi-window, tray, single-instance) |
| Backend | Rust — `tokio`, `portable-pty`, `ssh2`, `keyring` |
| Crypto | `argon2`, `chacha20poly1305`, `zeroize` |
| Frontend | React 19 + TypeScript, Tailwind CSS v4, shadcn/ui (Radix) |
| Terminal | xterm.js v6 |

Key design rules — atomic JSON persistence, granular per-session locking, and the vertical-slice module layout — are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## Contributing

Contributions are very welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, code style, and PR checklist. Look for issues labeled [`good first issue`](https://github.com/rm1dev/termifai/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) to get started.

## License

Termifai is released under the [MIT License](LICENSE).

---

<div align="center">
<sub>If Termifai is useful to you, consider giving it a ⭐ — it helps others find the project.</sub>
</div>
