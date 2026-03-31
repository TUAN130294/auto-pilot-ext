# Auto-Pilot Extension for Antigravity IDE

Auto-accept WAITING steps and quick-swap Google accounts — all from within the IDE.

## Features

### ⚡ Auto-Accept
- Automatically accepts WAITING steps (commands, file edits, read ops, browser actions)
- Security: validates file paths are within workspace before auto-accepting writes
- Status bar toggle: click to enable/disable
- Configurable poll interval

### 👤 Account Swap
- Sidebar tree view showing all saved Google accounts
- One-click swap between accounts (graceful close → swap → relaunch)
- Save current account, add new accounts
- Profile metadata (email, tier, plan) auto-detected from IDE

## Commands

| Command | Description |
|---------|-------------|
| `Auto-Pilot: Toggle Auto-Accept` | Enable/disable auto-accept |
| `Auto-Pilot: Swap Account` | Switch to another saved account |
| `Auto-Pilot: Save Current Account` | Save current IDE account as profile |
| `Auto-Pilot: Add Account` | Start fresh login flow for new account |
| `Auto-Pilot: Delete Account` | Remove a saved profile |
| `Auto-Pilot: Show LS Status` | Show connection status |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `auto-pilot.autoAcceptEnabled` | `false` | Enable auto-accept |
| `auto-pilot.pollIntervalMs` | `1500` | Poll interval in ms |
| `auto-pilot.profilesDir` | `%APPDATA%/AntigravityDeck/profiles` | Custom profiles directory |

## Install

```bash
# Build & package
npm install
npm run package

# Install in Antigravity IDE
antigravity --install-extension auto-pilot-1.0.0.vsix
```
