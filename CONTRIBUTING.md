# Contributing to Termifai

Thank you for your interest in contributing to Termifai! We welcome pull requests, bug reports, and feedback.

---

## Development Setup

### Prerequisites

To build and run Termifai locally, you need the following dependencies installed on your system:
- **Rust**: Minimum Supported Rust Version (MSRV) is **1.77.2**. Install via [rustup](https://rustup.rs/).
- **Bun**: Fast package manager. Install via [bun.sh](https://bun.sh/).
- **Node.js/npm**: Required implicitly for some ecosystem tools.
- **Tauri v2 dependencies**: Refer to the [Tauri v2 installation guide](https://v2.tauri.app/start/prerequisites/) for your operating system (specifically OS libraries like `webkit2gtk` on Linux).

### Running Locally

To start the React frontend dev server and native Tauri desktop shell with hot-reload enabled:

```bash
# Install dependencies
bun install

# Start Tauri development environment
bun tauri dev
```

If you only need to run the React frontend in the browser (for rapid UI layout work without backend PTY interaction):

```bash
bun run dev
```

---

## Code Verification & Quality

Before submitting a pull request, please ensure that your code complies with our style guidelines and passes the following check suite.

### Formatting (Rust)
Ensure that all Rust files conform to standard code formatting rules:

```bash
# Check formatting
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check

# Format code automatically
cargo fmt --manifest-path src-tauri/Cargo.toml
```

### Lints (Rust)
Lints are checked with warnings treated as errors. Your code must not generate any compiler or Clippy warnings:

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

### TypeScript Validation
Run the TypeScript compiler to ensure the frontend compiles without any type errors:

```bash
bunx tsc --noEmit
```

### Unit Tests
Verify all backend unit tests pass:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
```

---

## Contribution Guidelines

### Git Branching Model
- **Target Branch**: All feature and bugfix Pull Requests should target the **`develop`** branch.
- Only release-ready code is merged from `develop` into `main`.

### Commit Message Guidelines
Please write clear, meaningful commit messages. We prefer format prefixes for commits:
- `feat: ...` for new features
- `fix: ...` for bug fixes
- `docs: ...` for documentation changes
- `refactor: ...` for code cleanups
- `test: ...` for tests additions
