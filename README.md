<p align="center">
  <a href="https://auralisys.com/">
    <img src="desktop/assets/logo-auralisys.svg" width="72" height="72" alt="Auralisys" />
  </a>
</p>

<h1 align="center">AuraChat</h1>

<p align="center">
  Your AI workspace on your computer. Your conversations in your pocket.
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#getting-started">Get started</a> ·
  <a href="desktop/RELEASING.md">Release runbook</a> ·
  <a href="https://auralisys.com/">Auralisys</a>
</p>

---

AuraChat connects a desktop AI gateway to a Flutter mobile companion. Bring your
own OpenAI-compatible provider, work with local projects, and follow the same
conversations from your phone. Model calls and local tools run on the selected
computer, with explicit project permissions.

**Development preview.** Windows desktop and Android companion are the primary
tested platforms. macOS build configuration and desktop updating are included;
the macOS update flow still needs verification on a real Mac. The iOS project is
present, but building and testing it requires macOS and Xcode.

## Made for work that moves between devices

- **One conversation, multiple screens.** Shared account, conversation history,
  live progress, approvals and completion notifications.
- **Your provider, your models.** DeepSeek presets or an OpenAI-compatible
  endpoint, with provider configuration managed by the desktop.
- **Local project tools.** Files, commands, Git and MCP integrations operate on
  the gateway computer, within the permissions you grant.
- **A desktop app that stays out of the way.** System tray operation, local
  dictation, Markdown responses and an activity panel.
- **Signed desktop updates.** Startup checks, automatic installation when a new
  version is available and automatic restart. Windows updates do not recreate
  desktop shortcuts.

## How it works

```text
Flutter companion  <---- Firebase relay ---->  Desktop gateway
Android / iOS        Auth · Firestore · FCM    Tauri 2 · Rust
                                                    |
                                           Model provider APIs
                                           Local project tools
```

The companion does not execute tools on your phone or receive model-provider
API keys. It sends requests to the selected gateway and displays progress and
results. The gateway must remain online for remote execution.

**This is not an offline-only system.** Account data, provider configuration,
conversation history and relay data use Firebase. Model requests go to the
configured provider. Local tools run as the desktop user's account, not inside
an operating-system sandbox.

## Getting started

### Desktop

Prerequisites: Rust stable, Tauri CLI 2 and the
[Tauri platform requirements](https://v2.tauri.app/start/prerequisites/).
Windows needs the Microsoft C++ build tools and WebView2; macOS needs Xcode
Command Line Tools.

From the repository root on Windows:

```powershell
Set-Location desktop
cargo tauri dev
```

On macOS, from the repository root:

```sh
cd desktop
cargo tauri dev --config src-tauri/tauri.macos.conf.json
```

Sign in with an account enabled for the configured Firebase project, then
configure your model provider. The repository contains public Firebase client
identifiers, not administrative access. Running your own deployment also
requires your own Firebase project configuration and owner-scoped rules.

See the [desktop documentation](desktop/README.md) for permissions, integrations,
builds and platform details.

### Mobile companion

Install the Flutter SDK and Android development tools. From the repository root:

```powershell
Set-Location mobile
flutter pub get
flutter run
```

Use the same account as the desktop and select the gateway computer. iOS builds
require a Mac, Xcode and Apple signing/provisioning; iOS push also requires APNs
configuration.

See the [mobile documentation](mobile/README.md) for Firebase setup, notifications
and the relay protocol.

## Repository

- [`desktop/`](desktop/) — Tauri/Rust gateway and static web frontend.
- [`mobile/`](mobile/) — Flutter companion for Android and iOS.
- [`functions/`](functions/) — Firebase notification delivery.
- [`AuraChat's vault/`](<AuraChat's vault/>) — architecture, design decisions and
  development notes, readable as Markdown or in Obsidian.

The desktop and mobile versions are independent. Keeping both apps in this
repository does not require building or releasing them together.

## Builds and updates

Build locally on the target operating system; GitHub hosts the release files
but does not have to compile them. The
[release runbook](desktop/RELEASING.md) covers versioning, signing keys, generated
`latest.json`, Windows/macOS publishing and first-install requirements.
The Windows-first workflow includes a Mac handoff: after pulling the repository,
run `bash desktop/scripts/release-macos.command`. It builds the exact Windows
release commit and adds the Mac packages to the same release. Initial tool
authorizations and a secure, one-time transfer of the signing key are required.

A normal source push does **not** publish an app update. Updates use public
release downloads, so the installed app needs no GitHub account or token.
Publishing still requires repository write access. Never embed a GitHub token
or the private update-signing key in the app.

## Project status and distribution

AuraChat is under active development, not a hardened multi-tenant service.
Review project permissions before allowing local commands or installing MCP
servers and skills.

Before redistributing the source or binaries, complete the publication checklist
in the release runbook, including Git history privacy and third-party asset
licensing. This repository does not yet declare a project-wide license; bundled
dependencies retain their own licenses and notices.

---

Built by [Auralisys](https://auralisys.com/) — custom apps, websites and software.
