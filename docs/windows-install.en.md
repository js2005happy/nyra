[中文](windows-install.md) · **English**

# Installing Nyra on Windows

Two ways to install: the **Node binary, a single exe** (no Python needed,
recommended), or the **`scripts/install-node.ps1` one-line script** (downloads
the exe from GitHub Releases, sets it up and creates desktop shortcuts). If
you want the desktop app with a window (not the command line), install the
`.msi` / `-setup.exe` from the Release; see [docs/desktop.md](desktop.md).
For a manual step-by-step install, see the install panel on the website
(the Windows · PowerShell tab); it doesn't conflict with the options below.

> **Plainly (2026-11-19)**: the Node binary exe is cross-compiled with Bun by
> the `node-binaries` workflow on `ubuntu-latest`. Its format has been checked
> (PE32+ x86-64), and `--version` / `--example` smoke tests run on
> `windows-latest` in CI, but it has not yet been run on a real Windows
> computer. The exe is unsigned, so SmartScreen warns on first run: click
> "More info" → "Run anyway". Your computer may be the first real machine: if
> it won't install, paste the exact error into an issue in the repository.

> Note for 0.4.0: the old Python exe (packaged with PyInstaller, produced by
> the `build-windows.yml` workflow) was removed along with Python, and
> `scripts/install.ps1` (install from source, needed Python) was removed too
> (since 0.4.0). The command line still has only one install method, the Node
> binary. Since 0.5.1 the Release also has desktop installers (`.msi` /
> `-setup.exe`, see [docs/desktop.md](desktop.md)); that is the desktop app
> with a window, not the command line.

## Option 1: Node binary, single exe (no Python needed, recommended)

1. Go to the repository's [Releases](https://github.com/js2005happy/nyra/releases),
   get the latest version and download `nyra-windows-x64.exe` (only present
   when a `v*` tag was pushed; without a tag, go to Actions → Node binaries →
   the latest run and download the `nyra-binaries` artifact).
   Or use the one-line install (see option 2).
2. Put `nyra.exe` in a permanent folder (e.g. `C:\Tools\nyra\`) and add that
   folder to PATH (Settings → System → About → Advanced system settings →
   Environment Variables, add a line under Path), or run it by its full path
   each time.
3. Set a model key (DeepSeek as an example; this only lasts for the current
   PowerShell window; to keep it, add it to the system environment variables):

   ```powershell
   $env:DEEPSEEK_API_KEY="sk-..."
   ```

4. Check: `nyra.exe --version` should print `nyra 0.5.14 (node runtime)`;
   then run `nyra.exe setup` for the first-run wizard.

The Node exe is a single-file console program built with Bun `--compile`. It
includes its own runtime, needs no admin rights, and doesn't write to the
registry or install services. Your sessions, memory and config are stored in
`%USERPROFILE%\.nyra`.

## Option 2: one-line script (download from Releases and set up)

```powershell
irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex
```

Or download `scripts/install-node.ps1` and right-click → "Run with PowerShell"
(if it complains about the execution policy, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once first).

What the script does:

- Downloads `nyra-windows-x64.exe` from GitHub Releases into `~\nyra`
  (latest by default; pick a version with `-Version v0.5.2`);
- Adds the install folder to your user PATH (takes effect in a new terminal);
- Creates two desktop shortcuts: **Nyra 终端** (Nyra terminal, `nyra.exe`)
  and **Nyra 网页界面** (Nyra web interface, `nyra.exe ui --open`), using
  `nyra.ico` from the install folder as the icon (only if it exists; otherwise
  it skips the icon without an error);
- Runs `nyra.exe --version` as a self-check;
- Doesn't write to the registry, install services or need admin rights.

After installing, set a key first (same as step 3 of option 1), then
double-click a desktop shortcut to start. Check: `nyra --version` should print
`nyra 0.5.2 (node runtime)`.

## FAQ

- **The shortcut has the default icon, not the Nyra icon**: expected. The
  icon file `branding/nyra.ico` hasn't been pushed to the repository yet
  (2026-11-18), so the script skips the icon and only creates the shortcut;
  once the icon is pushed, run the script again to pick it up.
- **PowerShell says "cannot be loaded because running scripts is disabled on
  this system"**: that's the execution policy. Run
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and try again; the
  `irm | iex` method isn't affected by the execution policy.
- **Double-clicking the exe flashes a window and closes it**: the exe is a
  console program. Run `nyra.exe` in PowerShell or a terminal instead of
  double-clicking it.
- **Is the remote script safe?** `irm | iex` runs code fetched from the web
  directly. It only fetches from the official repository URL
  `raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1`;
  if you'd rather be sure, download it and read it before running it.
