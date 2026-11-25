[中文](installers.md) · **English**

# Installers and releases: installers are updated with every release

**Project rule (2026-11-20): installers for desktop and mobile must both be
ready, and every update must ship updated installers too.** This document is
how that rule is carried out: nobody uploads files by hand at release time.
Installers are attached to the Release automatically from the tag, and the
signing workflow signs everything once all of it has arrived.

## What happens at release time (after pushing a `v*` tag)

| Artifact | Workflow | Trigger | How it gets into the Release |
| --- | --- | --- | --- |
| 5 Node binaries | `node-binaries.yml` | tag / push to main / PR / manual | `release` job: creates the Release (writes the body, generates notes) and attaches `dist/*` |
| macOS universal `.dmg`, Windows `.msi` / NSIS `-setup.exe` | `desktop.yml` | tag / manual | `release` job: attaches files only, does not write the body (the body belongs to node-binaries) |
| Android APK (stable name `nyra-android.apk`; when debug-signed, also the old name `nyra-android-debug.apk`) | `mobile.yml` | tag / manual | `release` job: attaches files only, does not write the body |
| Stable-name copies of the desktop installers (`Nyra-windows-x64-setup.exe`, `Nyra-windows-x64.msi`, `Nyra-macos-universal.dmg`, `Nyra-linux-x86_64.AppImage`, `Nyra-linux-amd64.deb`) | `desktop.yml` | tag | `release` job: same content as the versioned file, used by the `releases/latest/download/<stable name>` download links |
| `SHA256SUMS` + `.sig` + `.pem` + `.bundle`, SLSA provenance | `release-sign.yml` | automatically after Node binaries finishes (`workflow_run`) / after a Release is created manually / manual with a tag | Waits for all 9 artifacts, then downloads them, computes hashes, signs and attaches the results; if they don't all arrive it fails rather than signing an incomplete list |

Timing: the three build workflows run in parallel, and whichever finishes
first creates the Release. `release-sign.yml` is triggered when Node binaries
finishes (`workflow_run`). The Release is created by CI with the default
`GITHUB_TOKEN`, and GitHub does not fire `release` workflows for that, so
relying only on `release: published` means signing never starts; that is how
v0.5.2–v0.5.11 lost their signatures. The signing workflow first waits for
all 9 artifacts (up to 50 minutes, since the Tauri desktop build is much
slower than the Node binaries). If they don't arrive it fails (fail-closed:
it never signs an incomplete list), and you rerun it later with
`workflow_dispatch` and the tag. `SHA256SUMS` exists only for v0.5.1; none
of the v0.5.2–v0.5.11 Releases have it (another root cause was a wrong
`gh --jq -r` invocation, see `docs/SIGNING.md`). It is back from 0.5.12 on,
and v0.5.2–v0.5.11 will not be backfilled.

A finished Release should have **13 assets**: 5 Node binaries + 3 desktop
installers (`.dmg`, `.msi`, `-setup.exe`) + 1 Android APK + `SHA256SUMS` +
`.sig` + `.pem` + `.bundle` (SLSA's `*.intoto.jsonl` is provenance only and is
not attached).

Mobile build prerequisite: the devDependencies in `mobile/package.json` must
include `typescript` (same version as the repository root), because
`capacitor.config.ts` is a TS file. When `bun x cap add android` reads it
without TypeScript available, it fails immediately and the build never reaches
Gradle (0.5.3 failed this way three times in a row).

## The default version pinned in the install scripts

The three install scripts (`scripts/install-node.sh`,
`scripts/install-node-macos.sh`, `scripts/install-node.ps1`) no longer default
to an unchecked `latest`. They pin `DEFAULT_VERSION` (currently `v0.5.15`,
written prominently at the top of each script). After downloading, they check
the file against the same Release's `SHA256SUMS` before installing. A hash
mismatch, a file missing from the list, or a `SHA256SUMS` that can't be
downloaded all mean the install is refused (fail-closed). `--version latest`
can still be passed explicitly, and it is checked the same way; `--from-file`
installs from a local file, without network access or checks. If the
requested version has not been released (the file isn't in the Release and
GitHub returns 404), the script says `版本 vX.Y.Z 还没发布`
("version vX.Y.Z has not been released yet") instead of suggesting you check your network.

**The default version may only point to a Release that is published with all
assets attached.** Release order: push the tag, wait until the Release has the
binaries, desktop installers, APK and `SHA256SUMS` (produced by the signing
workflow), then change the default version in all three scripts to the new
version in a separate commit. `installer-release-check` in the Release facts
workflow checks every asset of the default version's Release (including
`SHA256SUMS`) with a 1-byte GET, and fails if any one is missing.

The `SHA256SUMS` and signature for v0.5.11 were added on 2026-11-24 by running
the signing workflow manually. They attest to "these files as they were on the
Release at signing time", not to build-time provenance.

## Version numbers: six places (don't miss one when bumping)

Before a release, bump the version in all six places so they match:

1. Root `package.json`
2. `VERSION` in `src/config.ts`
3. `desktop/package.json`
4. `desktop/src-tauri/tauri.conf.json`
5. `desktop/src-tauri/Cargo.toml` (and the `nyra-desktop` entry in `Cargo.lock`)
6. `mobile/package.json`

The "Check versions match" step in `desktop.yml` checks the first five (the
6th is not part of that check; verify it by hand when bumping). The Android
APK's `versionName` / `versionCode` do not depend on the 6th: `mobile.yml`
writes them into `android/app/build.gradle` from the tag at build time
(`versionName` = the tag without `v`, `versionCode` = the workflow run
number).

During development, the root `package.json` and `src/config.ts` may carry a
`-dev` suffix ahead of the others (matching "Unreleased" at the top of the
CHANGELOG); at release time all six move to the same version together.

## Manual operations (outside a release)

- **Rebuild just one kind of installer**: run the matching workflow manually
  in Actions (`workflow_dispatch`). Without a tag it only produces Artifacts
  and does not attach anything to a Release.
- **Rerun only the signing**: Actions → "Sign release artifacts" → Run
  workflow, enter the tag (e.g. `v0.5.3`). It downloads all artifacts again,
  recomputes `SHA256SUMS`, signs again and re-attaches with `--clobber`.
- **`SHA256SUMS` is missing for v0.5.2–v0.5.11** (see `docs/SIGNING.md` for
  why): don't go back and change those Releases; it is back from 0.5.12 on.

## Signing status (plainly)

- The cosign keyless signature of `SHA256SUMS` and the SLSA provenance are
  automatic from 0.5.12 on, present on every Release, and users can check them
  with `scripts/verify-release.sh`. The v0.5.2–v0.5.11 Releases have no
  `SHA256SUMS` (see `docs/SIGNING.md`); only v0.5.1 has one. Without
  `SHA256SUMS`, `verify-release.sh` reports "no SHA256SUMS" and exits with
  code 1 rather than pointing at a file that doesn't exist.
- **Code signing** of the installers themselves is a separate matter, see
  `docs/SIGNING.md`: no certificate has been bought, so the Windows `.msi` /
  `.exe` and the macOS `.dmg` are currently unsigned and not notarized. The
  Android APK has been release-signed since 0.5.14 (signer CN=Nyra,
  certificate SHA-256 starting with `D3:CD:8C:92`). A release-tag build fails
  outright if the `ANDROID_KEYSTORE_*` secrets are missing instead of falling
  back to debug signing, and it also fails if signature verification fails
  (see layer 4 in `docs/SIGNING.md`). Upgrading from a debug-signed build
  (0.5.13 or earlier) needs one uninstall first; after that, updates install
  over it. There is no iOS installer (it needs an Apple Developer account and
  certificate, the same pending item as desktop signing).
