# Build for Windows (from macOS)

این راهنما نحوه cross-compile کردن Termifai برای ویندوز از روی macOS را توضیح می‌دهد.

## پیش‌نیازها

### ۱. نصب Rust target ویندوز

```bash
rustup target add x86_64-pc-windows-gnu
```

### ۲. نصب MinGW-w64 (cross-compiler)

```bash
brew install mingw-w64
```

### ۳. نصب NSIS (برای ساخت installer)

```bash
brew install nsis
```

---

## بیلد

### فقط فایل `.exe` (بدون installer)

```bash
bun run tauri build -- --target x86_64-pc-windows-gnu --bundles none
```

خروجی:
```
src-tauri/target/x86_64-pc-windows-gnu/release/termifai.exe
```

### با installer کامل (NSIS setup)

```bash
bun run tauri build -- --target x86_64-pc-windows-gnu
```

خروجی:
```
src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/Termifai_x.x.x_x64-setup.exe
```

---

## نکات مهم

- **Cross-compilation تجربی است** — Tauri هشدار می‌دهد که این ویژگی experimental است و ممکن است همه قابلیت‌ها پشتیبانی نشوند.
- **Signing پشتیبانی نمی‌شود** — امضای دیجیتال installer فقط روی ویندوز امکان‌پذیر است. برای release رسمی از Windows runner استفاده کن.
- **Target GNU vs MSVC** — از `x86_64-pc-windows-gnu` استفاده کن (نه `msvc`)، چون MSVC linker فقط روی ویندوز وجود دارد.

---

## بیلد روی GitHub Actions (توصیه‌شده برای release)

برای release رسمی، بهتر است از GitHub Actions با `windows-latest` runner استفاده شود تا signing و compatibility کامل داشته باشی.

```yaml
# .github/workflows/build-windows.yml
name: Build Windows

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        run: bun install

      - name: Build
        run: bun run tauri build

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: termifai-windows
          path: src-tauri/target/release/bundle/nsis/*.exe
```
