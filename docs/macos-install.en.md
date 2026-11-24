[中文](macos-install.md) · **English**

# Installing Nyra on macOS (one-line script)

> Status: the Node script was written on Linux and has only had syntax and
> placeholder-substitution checks. **It has not yet been run successfully on a
> real Mac.** If you get an error the first time you run it on a Mac, please
> post the error and the script will be fixed. For Linux see
> [docs/linux-install.md](linux-install.md); for Windows see
> [docs/windows-install.en.md](windows-install.en.md).

## Option 1 (recommended): Node single-file binary

`scripts/install-node-macos.sh` downloads the binary for your architecture from
GitHub Releases (`nyra-macos-arm64` for arm64, `nyra-macos-x64` for Intel).
**No root, no Python, and no Node/Bun needed** (the runtime is built in).

```bash
bash scripts/install-node-macos.sh
bash scripts/install-node-macos.sh --version v0.5.2 --with-launchd
```

Note: the binary is unsigned and not notarized, so macOS Gatekeeper blocks it
on first run; right-click the binary and choose "Open" to allow it once.
`.dmg` / `.pkg` installers can't be built on this machine and are a to-do
(see below); don't pretend they are provided.

> Note for 0.5.2: the binary is the full build (agent core, web interface,
> plugin marketplace and creation mode are all included). `--with-launchd`
> only installs the plist file and does not run `launchctl load`; once you
> have checked it, run `launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist`
> yourself to enable it (see "Scheduler").

### .dmg installer (desktop app, built in CI, not in the Release)

- There is a `.dmg`, but only as a GitHub Actions build artifact: open the
  repository's **Actions → Build desktop app**, pick a successful run (the
  `v0.5.2` tag run works), and download `Nyra-macos-universal` under
  **Artifacts** at the bottom of the page (it unzips to
  `Nyra_<version>_universal.dmg`, universal for Apple silicon and Intel).
  Downloading artifacts requires signing in to GitHub. The `.dmg` is the
  desktop app (with a window), not the command-line app; installing the
  desktop app and opening an unsigned app are covered in
  [docs/desktop.md](desktop.md).
- There is no `.pkg` (installer package), and none is planned: macOS only gets
  drag-and-drop installation from a `.dmg`.
- Building the `.dmg` locally is a to-do: this development machine runs
  Linux, so it can't build or verify macOS installers. Until it can, don't
  write "provided" in the docs.

## What it does

- Installs the binary to `~/.local/share/nyra/nyra` (change with `--prefix`);
- Puts a symlink at `~/.local/bin/nyra`;
- Creates `~/.nyra` (permissions 0700, the config and data folder);
- Runs `nyra --version` after installing as a self-check, and reports an error if it fails;
- With `--with-launchd`, also installs the scheduler plist to
  `~/Library/LaunchAgents/ai.nyra.scheduler.plist` (installs the file only,
  doesn't load it; see "Scheduler").

Running it again upgrades: the old installation is replaced entirely, and the
data in `~/.nyra` is left alone.

## Requirements

- macOS (the script refuses to run on anything else rather than half-installing);
- `curl` (for downloading);
- Optional: `launchctl` (only used with `--with-launchd`; built into macOS).

The script installs nothing from the network (apart from downloading the binary).

## Install

```bash
# Option 1: download and install straight from GitHub Releases (latest by default)
bash scripts/install-node-macos.sh

# Option 2: already cloned; install from a locally built binary (no second download)
bash scripts/build-binaries.sh --only macos-arm64   # or macos-x64
bash scripts/install-node-macos.sh --from-file dist/nyra-macos-arm64

# Option 3: also install the scheduler plist (file only, not loaded; see "Scheduler")
bash scripts/install-node-macos.sh --from-file dist/nyra-macos-arm64 --with-launchd
```

If it says `~/.local/bin 不在 PATH 里` ("~/.local/bin is not on PATH") after installing, add the line it
suggests. The default macOS shell is zsh; to make it permanent, add it to
`~/.zshrc`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then open a new terminal and run `nyra --version`; if you see
`nyra 0.5.2 (node runtime)`, the install worked.
Before first use, set a key (DeepSeek as an example):

```bash
export DEEPSEEK_API_KEY=your-key
nyra "Explain the structure of this project"
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--version TAG` | `v0.5.14` (pinned) | Version to download from GitHub Releases (with the `v` prefix, e.g. `v0.5.2`; without `v` also works and the script adds it; `latest` can be passed explicitly) |
| `--from-file PATH` | — | Install from a locally built binary (no download) |
| `--prefix DIR` | `~/.local/share/nyra` | Install location (can't be `/`, can't be `$HOME` itself, can't contain spaces) |
| `--bin-dir DIR` | `~/.local/bin` | Launcher location |
| `--with-launchd` | off | Also install the launchd user agent file (installed, not loaded) |
| `--uninstall` | — | Uninstall (see below) |
| `--help` | — | Show help |

After downloading, the script checks the file against the same Release's
`SHA256SUMS` before installing. A hash mismatch, a file missing from the list,
or a `SHA256SUMS` that can't be downloaded all mean the install is refused.
`--from-file` installs from a local file, without network access or checks.

## Upgrade

Just run the install command again, for example:

```bash
bash scripts/install-node-macos.sh --from-file dist/nyra-macos-arm64
```

## Uninstall

```bash
bash scripts/install-node-macos.sh --uninstall
```

This stops and removes the launchd agent and deletes the install folder and
the launcher. **`~/.nyra` is kept**, along with your sessions, tasks and
config; to remove the data too, delete `~/.nyra` yourself.

## Scheduler (launchd user agent)

`--with-launchd` installs `launchd/ai.nyra.scheduler.plist` to
`~/Library/LaunchAgents/ai.nyra.scheduler.plist`, **file only, not loaded**.
Load it yourself once you have checked it. It is the macOS equivalent of
`systemd/nyra-scheduler.service` on Linux:

| systemd (Linux) | launchd (macOS) |
| --- | --- |
| `WantedBy=default.target` (starts at login) | `RunAtLoad=true` |
| `Restart=on-failure` (restart after a crash) | `KeepAlive` + `SuccessfulExit=false` (restart only on a non-zero exit) |
| `WorkingDirectory=%h` | `WorkingDirectory` = the home folder of the installing user |

It only keeps `nyra schedule daemon` running; the daemon itself checks the
schedule every 60 seconds and runs only the tasks that are due (see
`nyra schedule list` / `nyra schedule add`). Logs are in
`~/.nyra/logs/scheduler.out.log` and `scheduler.err.log`.

Common commands:

```bash
launchctl list ai.nyra.scheduler   # is the agent running? (any output means yes)
launchctl start ai.nyra.scheduler  # start it once by hand
launchctl stop ai.nyra.scheduler   # stop it (it starts again at login unless unloaded)
launchctl unload ~/Library/LaunchAgents/ai.nyra.scheduler.plist  # disable start at login
launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist    # enable it again
tail -f ~/.nyra/logs/scheduler.err.log  # watch the daemon's errors
```

Note: `__NYRA_BIN__` / `__NYRA_HOME__` in the plist template are placeholders
that the install script replaces with the actual paths of this installation.
Don't edit the installed plist by hand; reinstalling overwrites it.

## Troubleshooting

The install script prints its messages in Chinese; each one is quoted below with a translation.

- `这个脚本只在 macOS 上运行` ("this script only runs on macOS"): you ran it on Linux/Windows; use
  `scripts/install-node.sh` on Linux and `scripts/install-node.ps1` on Windows.
- `下载失败` ("download failed"): check your network and the repository URL; if you
  already have a built binary, use `--from-file` and skip the network.
- "load 失败" ("load failed") after `--with-launchd`: the install itself succeeded, only the
  agent didn't start. Follow "Scheduler" above to run `launchctl load` and
  `list` by hand, or just run `nyra schedule daemon` in a terminal.
- `nyra: command not found` after installing: `~/.local/bin` is not on PATH;
  see the PATH note under "Install" above, or use the full path
  `~/.local/bin/nyra`.
- `launchctl list` prints nothing: the agent isn't running; run
  `launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist` first, then
  `list`; if it still fails, check `~/.nyra/logs/scheduler.err.log`.
- `launchctl load` complains about dubious ownership or similar: the plist's
  owner or permissions are wrong; delete it and reinstall (the script writes
  it as 644, owned by you). Don't `chmod` it to 777 by hand.

## Security notes

The script only writes to four places in `$HOME` (the install folder, the
launcher folder, `~/.nyra`, and `~/Library/LaunchAgents/` with
`--with-launchd`). It never reads or stores any API key (you still provide the
key yourself through an environment variable). The launchd agent only runs the
scheduler daemon; it doesn't listen on any port or connect out on its own (the
daemon goes online only as far as each task needs, the same as the systemd
service on Linux).
