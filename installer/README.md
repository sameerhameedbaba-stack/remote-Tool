# Windows Agent Installer

The remote-support agent's screen capture, input injection, DPAPI token storage,
and auto-start registration are **Windows-native**. They are built and packaged
on a real Windows runner in CI — not on the Linux dev host — and the resulting
installer is uploaded as a downloadable artifact.

## Where to download it

Every push that touches `agent-rust/**` or `installer/**` runs the
**"Windows agent installer"** GitHub Actions workflow
(`.github/workflows/windows-agent.yml`) on `windows-latest`. It uploads two
artifacts you can download from the run's **Summary** page:

- **`remote-agent-installer`** — `remote-agent-setup-<version>.exe` (the installer)
- **`remote-agent-exe`** — the raw `remote-agent.exe` (if you prefer manual setup)

To get a build:

1. Open the repo's **Actions** tab → **Windows agent installer** → the latest run
   (or trigger one via **Run workflow**).
2. Download the **`remote-agent-installer`** artifact and unzip it.
3. Run `remote-agent-setup-<version>.exe` on the target Windows machine.

Tagged releases also attach the installer to the GitHub Release automatically.

## What the installer does

1. Installs `remote-agent.exe` under `%LOCALAPPDATA%`-scoped Program Files
   (per-user, so screen capture runs in the interactive desktop session).
2. Asks for your **Backend API URL**, **WebSocket URL**, and a one-time
   **enrollment token**.
3. Enrolls the device once — persisting a **DPAPI-protected** device token. The
   enrollment token itself is never written to disk.
4. Registers the agent to **auto-start at logon** (`remote-agent install`, an
   HKCU `Run` entry with the backend URLs baked in — no secret in the registry).

Uninstalling removes the auto-start entry and the binary.

## Building the installer locally (on Windows)

```powershell
cd agent-rust
cargo build --release
# Inno Setup 6 required (choco install innosetup)
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" ..\installer\remote-agent.iss
# → installer\Output\remote-agent-setup-<version>.exe
```

## Manual setup (no installer)

```powershell
remote-agent.exe enroll  --api-base https://YOUR_BACKEND --ws-base wss://YOUR_BACKEND --enrollment-token YOUR_TOKEN
remote-agent.exe install --api-base https://YOUR_BACKEND --ws-base wss://YOUR_BACKEND
# `install` registers auto-start; `remote-agent.exe service` runs it now.
```

## Honest status

The agent's control plane (enrollment, presence, signaling, WebRTC data
channels, audit) and the screen/input pipeline are verified end-to-end on Linux
CI (with a synthetic capture source). The **real Windows GDI capture, SendInput
injection, DPAPI, and the registry auto-start are compile-verified for Windows**
but their runtime behavior must be confirmed on a real Windows machine — that is
exactly what this installer is for. Please report issues from a real run.
