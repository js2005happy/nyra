[中文](beta.md) · **English**

# Nyra beta: getting started

Thanks for trying Nyra! This guide only covers what **works today**; anything not ready yet is marked "Coming soon".
If you hit a problem or have an idea, see "How to give feedback" at the end.

> Nyra is in early beta: the interface and features change often, and some parts are still rough.
> It reads and writes files and runs commands on your computer. By default it asks you before every action, so read the approval card before you click "Allow".

## 1. Install

All installers are in the [latest release](https://github.com/js2005happy/nyra/releases/latest).

| Platform | Download | Notes |
| --- | --- | --- |
| Windows 10/11 | `Nyra-windows-x64-setup.exe` (or `.msi`) | Double-click to install for the current user; no admin rights needed. The installer is **not code-signed**, so SmartScreen will say "Windows protected your PC": click "More info → Run anyway". |
| macOS (Apple silicon / Intel) | `Nyra-macos-universal.dmg` | Open the dmg and drag Nyra into Applications. The installer is **not notarized**: the first time, right-click Nyra in Applications → Open, then confirm once more. |
| Linux x64 | `Nyra-linux-x86_64.AppImage` or `Nyra-linux-amd64.deb` | AppImage: `chmod +x`, then run it. deb: `sudo apt install ./Nyra-linux-amd64.deb`. |
| Command line only | `nyra-windows-x64.exe` / `nyra-macos-arm64` / `nyra-macos-x64` / `nyra-linux-x64` / `nyra-linux-arm64` | A single file; no Node or Python needed. You can also use the one-line install scripts (below). |
| Android | `nyra-android.apk` | A launcher on your phone that connects to your computer at home (see section 3). Since 0.5.14 the APK is release-signed (signer CN=Nyra). Upgrading from a debug-signed build (0.5.13 or earlier) **needs one uninstall first**; after that, updates install over it. |
| iPhone | No installer | Open your computer's mobile web page in Safari (see section 3); you can "Add to Home Screen". |

One-line install for the command-line app:

```bash
# Linux
curl -fsSL https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.sh | bash
# macOS
curl -fsSL https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node-macos.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex
```

Once installed, run in a terminal:

```bash
nyra --version   # if it prints a version number, the install worked
nyra doctor      # self-check: key, network, folder permissions, disk
```

The desktop app already includes the matching command-line app, so if you only use the desktop app there is nothing else to install.

## 2. Set up a model

Nyra does not ship with a model; you use your own model API key (the key is stored only on your own computer).

- **Desktop app / web interface**: the first launch opens "Set up Nyra". Pick a model provider, paste your key, click "Test connection", then "Save and start". You can change the model or key later under **Settings → Model**.
- **Command line**: run `nyra setup` and follow the three-step wizard. You can also use an environment variable, for example `export DEEPSEEK_API_KEY=...`.
- **Local models**: if Ollama is installed on this computer, choose Ollama; no key needed.
- **Your own OpenAI-compatible service**: add it under `custom_providers` in `~/.nyra/config.json` with a `base_url` and `default_model`, then set `provider` to its name. Nyra uses that provider's own `default_model` (since 0.5.13 you no longer need to repeat `model` at the top level).

`nyra --list-providers` lists every built-in provider. Without a key configured, Nyra sends no model requests at all.

## 3. Connect your phone to your computer

Nyra itself does not run on the phone: the phone connects to Nyra on your computer, and tools still run on the computer. For now, the phone and the computer must be on the **same Wi-Fi network**.

1. On the computer, run in a terminal:

   ```bash
   nyra ui --pair
   ```

   The terminal shows a QR code, a mobile URL and a 6-digit pairing code (valid for 5 minutes, single use, void after 5 wrong attempts).
   The same QR code is also under **Settings → Phone & devices → Connect a phone** in the web interface.
   (The desktop app listens on this computer only by default; to connect a phone, start it with the command above.)
2. Connect from the phone:
   - **Android app**: open Nyra, expand "Connect to my computer", enter the computer's LAN address, port and pairing code, then tap Connect. Next time you can reconnect to the last computer in one tap.
   - **Mobile browser (Android / iPhone)**: scan the QR code with the camera, or open the URL shown in the terminal, and enter the pairing code. You can "Add to Home Screen" to use it like an app.
3. Once connected you can: see your conversation list, start new tasks, approve or reject requests under "Waiting for you", check automations, and tell the lead agent what needs doing.

Each phone gets its own long-lived credential, the computer stores only a hash of it, and you can revoke it any time under **Settings → Phone & devices**.

**Coming soon**: signing in on the phone with an account (Google, GitHub, email) and connecting when you are not on the same Wi-Fi. The sign-in buttons are already on the app's home screen, but the cloud service is not live yet, so they don't work for now.

## 4. Start using it

- Desktop app or `nyra ui`: describe the task in the input box and press Enter. Before it acts, an approval card appears: "Allow once" / "No, try another way".
- Command line: `nyra` starts interactive mode, `/help` lists all commands, `/exit` quits.
- Switch the permission mode under the input box: Read-only, Ask before writes (default), Full access.

## 5. How to give feedback

Go to [Issues → New issue](https://github.com/js2005happy/nyra/issues/new/choose) in the repository and pick a template:

- **Beta bug report**: won't install, won't open, errors, wrong results.
- **Beta feedback**: is it easy to use, what's confusing, what you'd like added.

Please include your platform, Nyra version (`nyra --version` or Settings → About) and steps to reproduce; screenshots help.

> **⚠️ Never paste API keys, passwords or pairing codes in an issue.** Check logs and screenshots before you post them.
> If you find a security problem, please don't file it publicly; report it privately as described in [SECURITY.md](../SECURITY.md).
