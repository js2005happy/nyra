<div align="center">

<img src="desktop/icon-src/nyra-app-icon.svg" width="88" height="88" alt="Nyra">

# Nyra

**An open-source AI agent that runs on your own computer: it reads your project, edits code, runs commands and checks the web, and asks before it acts.**

[Website](https://js2005happy.github.io/nyra/) &nbsp;·&nbsp; [Download](https://github.com/js2005happy/nyra/releases/latest) &nbsp;·&nbsp; [Getting started](docs/beta.en.md)

Nyra is an **open-source** AI agent that **runs on your own computer**. Use it from a **desktop window**, the **terminal** or a **browser**, and pair your **phone** to follow along and approve steps. Bring **your own model key** (or a local model); conversations, memory and keys **stay on your machine**.

Hand it a task and it reads the project, edits code, runs commands and checks the web on its own. Before it writes a file or runs a command, an approval card says exactly what it is about to do. Say what you need. Watch it work. Nothing important happens until you say yes.

[![language: TypeScript](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)](https://github.com/js2005happy/nyra)
[![desktop: Windows · macOS · Linux](https://img.shields.io/badge/desktop-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-7B7BFF)](https://github.com/js2005happy/nyra/releases/latest)
[![mobile: Android · mobile web](https://img.shields.io/badge/mobile-Android%20%C2%B7%20mobile%20web-3DDC84?logo=android&logoColor=white)](docs/mobile-pwa.md)
[![release](https://img.shields.io/github/v/release/js2005happy/nyra?label=release&color=7B7BFF)](https://github.com/js2005happy/nyra/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/js2005happy/nyra/node-ci.yml?branch=main&label=CI)](https://github.com/js2005happy/nyra/actions/workflows/node-ci.yml)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-38d591)](CONTRIBUTING.md)

<br>

<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-windows-x64-setup.exe"><img src="https://img.shields.io/github/v/release/js2005happy/nyra?style=for-the-badge&label=%E2%AC%87%EF%B8%8F%20Download%20for%20Windows&labelColor=070707&color=0078D4" alt="Download Nyra for Windows (Nyra-windows-x64-setup.exe)" height="36"></a>

<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-macos-universal.dmg"><img src="https://img.shields.io/github/v/release/js2005happy/nyra?style=for-the-badge&label=%E2%AC%87%EF%B8%8F%20Download%20for%20macOS&labelColor=070707&color=7B7BFF" alt="Download Nyra for macOS (Nyra-macos-universal.dmg)" height="36"></a>

<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-linux-x86_64.AppImage"><img src="https://img.shields.io/github/v/release/js2005happy/nyra?style=for-the-badge&label=%E2%AC%87%EF%B8%8F%20Download%20for%20Linux%20%28AppImage%29&labelColor=070707&color=E95420" alt="Download Nyra for Linux, AppImage (Nyra-linux-x86_64.AppImage)" height="36"></a>

<a href="https://github.com/js2005happy/nyra/releases/latest/download/Nyra-linux-amd64.deb"><img src="https://img.shields.io/github/v/release/js2005happy/nyra?style=for-the-badge&label=%E2%AC%87%EF%B8%8F%20Download%20for%20Linux%20%28.deb%29&labelColor=070707&color=A81D33" alt="Download Nyra for Linux, .deb (Nyra-linux-amd64.deb)" height="36"></a>

<a href="https://github.com/js2005happy/nyra/releases/latest/download/nyra-android.apk"><img src="https://img.shields.io/github/v/release/js2005happy/nyra?style=for-the-badge&label=%E2%AC%87%EF%B8%8F%20Download%20for%20Android&labelColor=070707&color=3DDC84" alt="Download Nyra for Android (nyra-android.apk)" height="36"></a>

<sub>[latest release](https://github.com/js2005happy/nyra/releases/latest) &nbsp;·&nbsp; Windows x64 installer: **not code-signed** yet (SmartScreen: More info → Run anyway) &nbsp;·&nbsp; macOS universal `.dmg` (Apple silicon & Intel): ad-hoc signed, **not notarized** (right-click → Open the first time) &nbsp;·&nbsp; Linux x64: AppImage or `.deb` &nbsp;·&nbsp; Android APK: **release-signed** (signer CN=Nyra); upgrading from an older debug-signed build needs one uninstall, later updates install over it &nbsp;·&nbsp; [all releases](https://github.com/js2005happy/nyra/releases) &nbsp;·&nbsp; [中文](README.md)</sub>

<br>

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

Full guide: [GUIDE.en.md](GUIDE.en.md) (Chinese: [README.md](README.md), [GUIDE.md](GUIDE.md)). Install details: [installers](docs/installers.en.md) · [macOS](docs/macos-install.en.md) · [Windows](docs/windows-install.en.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md).

## Contributing

Nyra is in beta. Try it, tell us what works and what doesn't, and help improve it:

- **Feedback**: [beta sign-up & feedback hub](https://github.com/js2005happy/nyra/issues/131) (pinned) · [report a bug / share feedback](https://github.com/js2005happy/nyra/issues/new/choose) (never paste API keys)
- **Discussions**: [Discussions](https://github.com/js2005happy/nyra/discussions) for beta feedback, ideas and show-and-tell
- **Start small**: [good first issues](https://github.com/js2005happy/nyra/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are self-contained tasks; comment to claim one
- **How to submit**: development setup, test commands and commit conventions are in [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
