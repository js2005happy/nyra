<div align="center">

<img src="desktop/icon-src/nyra-app-icon.svg" width="88" height="88" alt="Nyra">

# Nyra

**An open-source AI agent that runs on your own computer: it reads your project, edits code, runs commands and checks the web, and asks before it acts.**

[**Website**](https://js2005happy.github.io/nyra/) &nbsp;·&nbsp; [Download](#quick-start) &nbsp;·&nbsp; [中文](README.md)

Use it from a desktop window, the terminal or a browser, and pair your phone to follow along and approve steps.
Before it writes a file or runs a command, an approval card shows exactly what it is about to do.
Bring your own model key (or a local model); conversations, memory and keys stay on your machine.

[![Release](https://img.shields.io/github/v/release/js2005happy/nyra?label=release&color=7B7BFF)](https://github.com/js2005happy/nyra/releases/latest)
[![Node CI](https://github.com/js2005happy/nyra/actions/workflows/node-ci.yml/badge.svg?branch=main)](https://github.com/js2005happy/nyra/actions/workflows/node-ci.yml)
[![License](https://img.shields.io/github/license/js2005happy/nyra?color=0B0B0C)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-38d591)](CONTRIBUTING.md)

<br>

<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-windows-x64-setup.exe"><img src="https://img.shields.io/badge/%E2%AC%87%20Windows-x64%20installer%20.exe-0078D4?style=for-the-badge&labelColor=0B0B0C" alt="Download Nyra: Windows(Nyra-windows-x64-setup.exe)" height="40"></a>
&nbsp;
<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-macos-universal.dmg"><img src="https://img.shields.io/badge/%E2%AC%87%20macOS-universal%20.dmg-555555?style=for-the-badge&labelColor=0B0B0C" alt="Download Nyra: macOS(Nyra-macos-universal.dmg)" height="40"></a>
&nbsp;
<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-linux-x86_64.AppImage"><img src="https://img.shields.io/badge/%E2%AC%87%20Linux-AppImage-E95420?style=for-the-badge&labelColor=0B0B0C" alt="Download Nyra: Linux AppImage(Nyra-linux-x86_64.AppImage)" height="40"></a>
&nbsp;
<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-linux-amd64.deb"><img src="https://img.shields.io/badge/%E2%AC%87%20Debian%20%C2%B7%20Ubuntu-.deb-A81D33?style=for-the-badge&labelColor=0B0B0C" alt="Download Nyra: Debian/Ubuntu(Nyra-linux-amd64.deb)" height="40"></a>
&nbsp;
<a href="https://github.com/js2005happy/nyra/releases/latest/download/nyra-android.apk"><img src="https://img.shields.io/badge/%E2%AC%87%20Android-APK-3DDC84?style=for-the-badge&labelColor=0B0B0C" alt="Download Nyra: Android(nyra-android.apk)" height="40"></a>

<sub>Windows installers are **not code-signed** yet (SmartScreen: More info → Run anyway) · the macOS `.dmg` is ad-hoc signed and **not notarized** (right-click → Open the first time) · the Android APK is **temporarily debug-signed**; when release signing lands you will need to uninstall once and reinstall.</sub>

<br><br>

<img src="docs/assets/screenshots/hero-windows-approval.png" alt="Nyra on Windows: an approval card before running git status" width="900">

<sub>Real screenshots of the running app (set to Chinese); the demo conversation is scripted.</sub>

</div>

## Quick start

| Platform | Download |
|---|---|
| Windows x64 | [Nyra-windows-x64-setup.exe](https://github.com/js2005happy/nyra/releases/latest/download/Nyra-windows-x64-setup.exe) · [.msi](https://github.com/js2005happy/nyra/releases/latest/download/Nyra-windows-x64.msi) |
| macOS (Apple silicon & Intel) | [Nyra-macos-universal.dmg](https://github.com/js2005happy/nyra/releases/latest/download/Nyra-macos-universal.dmg) |
| Linux x64 | [AppImage](https://github.com/js2005happy/nyra/releases/latest/download/Nyra-linux-x86_64.AppImage) · [.deb](https://github.com/js2005happy/nyra/releases/latest/download/Nyra-linux-amd64.deb) |
| Android | [nyra-android.apk](https://github.com/js2005happy/nyra/releases/latest/download/nyra-android.apk) |

Command line only:

```bash
curl -fsSL https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.sh | bash        # Linux
curl -fsSL https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node-macos.sh | bash  # macOS
```

```powershell
irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex   # Windows
```

Then run `nyra setup`. The scripts verify each download against the release `SHA256SUMS` and refuse to install on a mismatch.

The full documentation is in Chinese: see [README.md](README.md) and [GUIDE.md](GUIDE.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
