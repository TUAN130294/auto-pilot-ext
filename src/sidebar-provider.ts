// === Sidebar Webview Provider — full UI port from Antigravity-Deck ===
import * as vscode from 'vscode';
import {
    listProfiles,
    getActiveProfile,
    swapProfile,
    saveCurrentAccount,
    deleteProfile,
    startAddAccount,
    cancelAddAccount,
    autoOnboard,
    ProfileEntry,
} from './profile-manager';
import { AutoAcceptEngine, AcceptEvent, ContinueEvent } from './auto-accept';

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'autoPilot.mainPanel';
    private _view?: vscode.WebviewView;
    private _log: vscode.OutputChannel;
    private _engine: AutoAcceptEngine;
    private _extensionUri: vscode.Uri;
    private _eventSub?: vscode.Disposable;
    private _continueSub?: vscode.Disposable;

    constructor(extensionUri: vscode.Uri, log: vscode.OutputChannel, engine: AutoAcceptEngine) {
        this._extensionUri = extensionUri;
        this._log = log;
        this._engine = engine;

        // Forward accept events to webview
        this._eventSub = this._engine.onAcceptEvent((evt: AcceptEvent) => {
            this._view?.webview.postMessage({ type: 'acceptEvent', data: evt });
        });

        // Forward continue events to webview
        this._continueSub = this._engine.onContinueEvent((evt: ContinueEvent) => {
            this._view?.webview.postMessage({ type: 'continueEvent', data: evt });
        });
    }

    public refresh(): void {
        if (this._view) {
            // Full re-render to reflect profile changes
            this._view.webview.html = this._getHtml(this._view.webview);
        }
    }

    public refreshStats(): void {
        if (this._view) {
            // Lightweight update for stats only
            this._view.webview.postMessage({ type: 'stats', data: this._getState() });
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
        };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'toggleAutoAccept':
                    this._engine.toggle();
                    this.refresh();
                    break;
                case 'toggleAutoContinue':
                    this._engine.toggleContinue();
                    this.refresh();
                    break;
                case 'refresh':
                    this.refresh();
                    break;
                case 'autoOnboard':
                    await this._handleAutoOnboard();
                    break;
                case 'swapProfile':
                    await this._handleSwap(msg.profileName);
                    break;
                case 'saveAccount':
                    await this._handleSave(msg.profileName);
                    break;
                case 'addAccount':
                    await this._handleAddAccount();
                    break;
                case 'cancelAdd':
                    await this._handleCancelAdd(msg.previousProfile);
                    break;
                case 'deleteProfile':
                    await this._handleDelete(msg.profileName);
                    break;
            }
        });
    }

    // --- Handlers ---

    private async _handleAutoOnboard(): Promise<void> {
        this._postStatus('info', 'Detecting IDE account...');
        try {
            const instances = this._engine.getInstances();
            const result = await autoOnboard(instances[0] || null, this._log);
            if (result) {
                this._postStatus('success', `Account "${result}" saved automatically`);
            } else {
                this._postStatus('', '');
            }
        } catch (err: any) {
            this._postStatus('error', err.message);
        }
        this.refresh();
    }

    private async _handleSwap(target: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Switch to "${target}"? This will close and restart Antigravity IDE (~10s).`,
            { modal: true }, 'Switch'
        );
        if (confirm !== 'Switch') { return; }
        this._view?.webview.postMessage({ type: 'swapping', active: true });
        try {
            await swapProfile(target, this._log);
            this._postStatus('success', `Switched to ${target}`);
            vscode.window.showInformationMessage(`✅ Switched to "${target}". IDE is relaunching.`);
        } catch (err: any) {
            this._postStatus('error', err.message);
            vscode.window.showErrorMessage(`Swap failed: ${err.message}`);
        }
        this._view?.webview.postMessage({ type: 'swapping', active: false });
        this.refresh();
    }

    private async _handleSave(name?: string): Promise<void> {
        if (!name) {
            name = await vscode.window.showInputBox({
                prompt: 'Profile name (e.g. work, personal)',
                placeHolder: 'my-account',
                validateInput: (v) => {
                    if (!v.trim()) { return 'Name required'; }
                    if (!/^[a-zA-Z0-9_-]+$/.test(v)) { return 'Only alphanumeric, dash, underscore'; }
                    return null;
                },
            }) || undefined;
        }
        if (!name) { return; }
        try {
            const instances = this._engine.getInstances();
            await saveCurrentAccount(name, instances[0] || null, this._log);
            this._postStatus('success', `Account saved as "${name}"`);
            vscode.window.showInformationMessage(`✅ Account saved as "${name}"`);
        } catch (err: any) {
            this._postStatus('error', err.message);
            vscode.window.showErrorMessage(`Save failed: ${err.message}`);
        }
        this.refresh();
    }

    private async _handleAddAccount(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'This will close Antigravity IDE and open a fresh login. Continue?',
            { modal: true }, 'Continue'
        );
        if (confirm !== 'Continue') { return; }
        this._view?.webview.postMessage({ type: 'swapping', active: true });
        try {
            const prev = getActiveProfile();
            await startAddAccount(this._log);
            this._view?.webview.postMessage({ type: 'awaitingLogin', previousProfile: prev });
            this._postStatus('success', 'IDE launched for new login. Log in, then save below.');
        } catch (err: any) {
            this._postStatus('error', err.message);
            vscode.window.showErrorMessage(`Add account failed: ${err.message}`);
        }
        this._view?.webview.postMessage({ type: 'swapping', active: false });
        this.refresh();
    }

    private async _handleCancelAdd(previousProfile: string): Promise<void> {
        if (!previousProfile) { return; }
        this._view?.webview.postMessage({ type: 'swapping', active: true });
        try {
            await cancelAddAccount(previousProfile, this._log);
            this._postStatus('success', 'Restored previous account');
        } catch (err: any) {
            this._postStatus('error', err.message);
        }
        this._view?.webview.postMessage({ type: 'swapping', active: false });
        this._view?.webview.postMessage({ type: 'awaitingLogin', previousProfile: null });
        this.refresh();
    }

    private async _handleDelete(target: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete profile "${target}"? This removes all saved data for this account.`,
            { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }
        try {
            deleteProfile(target);
            this._postStatus('success', `Profile "${target}" deleted`);
        } catch (err: any) {
            this._postStatus('error', err.message);
        }
        this.refresh();
    }

    private _postStatus(type: string, msg: string): void {
        this._view?.webview.postMessage({ type: 'status', statusType: type, statusMsg: msg });
    }

    private _getState() {
        return {
            autoAcceptEnabled: this._engine.isEnabled,
            autoContinueEnabled: this._engine.isContinueEnabled,
            lsCount: this._engine.getInstances().length,
            profiles: listProfiles(),
            activeProfile: getActiveProfile(),
            acceptedCount: this._engine.getAcceptedCount(),
            continueCount: this._engine.getContinueCount(),
        };
    }

    private _getHtml(webview: vscode.Webview): string {
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'claudible-logo.jpg'));
        const s = this._getState();
        const activeP = s.profiles.find((p: ProfileEntry) => p.name === s.activeProfile);
        const otherPs = s.profiles.filter((p: ProfileEntry) => p.name !== s.activeProfile);

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --bg: var(--vscode-sideBar-background);
  --fg: var(--vscode-sideBar-foreground);
  --border: var(--vscode-sideBarSectionHeader-border, rgba(255,255,255,0.08));
  --card: var(--vscode-editor-background);
  --hover: var(--vscode-list-hoverBackground);
  --btn-bg: var(--vscode-button-background);
  --btn-fg: var(--vscode-button-foreground);
  --btn-hover: var(--vscode-button-hoverBackground);
  --muted: var(--vscode-descriptionForeground, rgba(255,255,255,0.5));
  --emerald: #10b981;
  --indigo: #818cf8;
  --purple: #c084fc;
  --amber: #f59e0b;
  --red: #ef4444;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--vscode-font-family,'Segoe UI',sans-serif);font-size:13px;color:var(--fg);background:var(--bg);display:flex;flex-direction:column;min-height:100vh}
.container{padding:12px;flex:1}

/* Section */
.sec{margin-bottom:16px}
.sec-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:10px}
.sec-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);display:flex;align-items:center;gap:5px}
.divider{flex:1;height:1px;background:var(--border);margin-left:8px}

/* Auto-Accept */
.aa-card{background:var(--card);border-radius:10px;padding:14px;border:1px solid var(--border)}
.aa-row{display:flex;align-items:center;justify-content:space-between}
.aa-label{display:flex;align-items:center;gap:8px;font-weight:500;font-size:13px}
.aa-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.aa-dot.on{background:var(--emerald);box-shadow:0 0 8px rgba(16,185,129,.5)}
.aa-dot.off{background:var(--red);opacity:.6}
.aa-status{font-size:11px;color:var(--muted);margin-top:8px}
.aa-stats{display:flex;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid var(--border)}
.stat{flex:1;text-align:center}
.stat-val{font-size:20px;font-weight:700;color:var(--indigo)}
.stat-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-top:2px}

/* Toggle */
.toggle{position:relative;width:42px;height:22px;cursor:pointer;flex-shrink:0}
.toggle input{display:none}
.toggle-sl{position:absolute;inset:0;background:rgba(255,255,255,.12);border-radius:11px;transition:.25s}
.toggle-sl::before{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:3px;left:3px;transition:.25s}
.toggle input:checked+.toggle-sl{background:var(--emerald)}
.toggle input:checked+.toggle-sl::before{transform:translateX(20px)}

/* Profile Active Card */
.active-card{padding:12px 14px;border-radius:10px;border:1px solid rgba(16,185,129,.2);background:linear-gradient(135deg,rgba(16,185,129,.06),transparent);margin-bottom:8px}
.active-row{display:flex;align-items:center;gap:10px}
.avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0}
.avatar.active{background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(129,140,248,.2));color:var(--emerald);border:2px solid rgba(16,185,129,.3)}
.avatar.other{background:rgba(255,255,255,.06);color:var(--muted);border:2px solid var(--border)}
.pinfo{flex:1;min-width:0}
.pname{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pemail{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.badge{font-size:9px;padding:2px 7px;border-radius:4px;font-weight:600;letter-spacing:.3px;display:inline-block;line-height:1.4}
.badge-active{background:rgba(16,185,129,.15);color:var(--emerald);border:1px solid rgba(16,185,129,.25)}
.badge-tier{background:rgba(129,140,248,.12);color:var(--indigo);border:1px solid rgba(129,140,248,.2)}
.badge-plan{background:rgba(192,132,252,.1);color:var(--purple);border:1px solid rgba(192,132,252,.2)}

/* Other Profile */
.other-card{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.02);margin-bottom:6px;transition:all .15s}
.other-card:hover{background:var(--hover);border-color:rgba(255,255,255,.1)}
.other-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.other-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;opacity:0;transition:opacity .15s}
.other-card:hover .other-actions{opacity:1}

/* Buttons */
.btn{padding:5px 10px;border:1px solid var(--border);background:var(--card);color:var(--fg);border-radius:6px;cursor:pointer;font-size:11px;font-family:inherit;display:inline-flex;align-items:center;gap:4px;transition:all .15s;white-space:nowrap}
.btn:hover{background:var(--hover)}
.btn-swap{font-size:10px;padding:4px 8px}
.btn-danger{color:var(--red);opacity:.5}
.btn-danger:hover{opacity:1;background:rgba(239,68,68,.1)}
.btn-primary{background:var(--btn-bg);color:var(--btn-fg);border-color:var(--btn-bg)}
.btn-primary:hover{background:var(--btn-hover)}
.btn-row{display:flex;gap:6px;margin-top:10px}
.btn-row .btn{flex:1;justify-content:center}

/* Status Toast */
.toast{padding:8px 12px;border-radius:8px;font-size:11px;font-weight:500;margin-bottom:10px;display:none;border:1px solid}
.toast.success{display:block;background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.2);color:var(--emerald)}
.toast.error{display:block;background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.2);color:var(--red)}
.toast.info{display:block;background:rgba(129,140,248,.08);border-color:rgba(129,140,248,.2);color:var(--indigo)}

/* Swapping Overlay */
.swap-banner{display:none;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;border:1px solid rgba(245,158,11,.2);background:rgba(245,158,11,.06);margin-bottom:10px}
.swap-banner.show{display:flex}
.spinner{width:14px;height:14px;border:2px solid rgba(245,158,11,.3);border-top-color:var(--amber);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Awaiting Login */
.await-box{padding:12px;border-radius:8px;border:1px solid rgba(245,158,11,.2);background:rgba(245,158,11,.04);margin-top:10px}
.await-box p{font-size:11px;color:var(--amber);font-weight:500;margin-bottom:8px}
.await-row{display:flex;gap:6px}
.await-row input{flex:1;background:var(--card);border:1px solid var(--border);color:var(--fg);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit;outline:none}
.await-row input:focus{border-color:var(--indigo)}

/* Empty */
.empty{text-align:center;padding:20px 12px}
.empty-icon{font-size:28px;margin-bottom:6px;opacity:.4}
.empty-sub{font-size:11px;color:var(--muted);margin-top:4px}

/* Activity Log */
.log-wrap{max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;background:var(--card);padding:4px 0;scroll-behavior:smooth}
.log-wrap::-webkit-scrollbar{width:4px}
.log-wrap::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:2px}
.log-entry{display:flex;align-items:center;gap:6px;padding:3px 10px;font-size:10px;color:var(--muted);border-bottom:1px solid rgba(255,255,255,.03)}
.log-entry:last-child{border-bottom:none}
.log-entry .le-icon{flex-shrink:0;font-size:11px}
.log-entry .le-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-entry .le-time{flex-shrink:0;font-size:9px;opacity:.6}
.log-entry.ok .le-text{color:var(--emerald)}
.log-entry.fail .le-text{color:var(--red)}
.log-entry.blocked{background:rgba(239,68,68,.06);border-left:2px solid var(--red)}
.log-entry.blocked .le-text{color:var(--amber);font-weight:600}
.log-empty{text-align:center;padding:12px;font-size:10px;color:var(--muted);opacity:.5}

/* Footer */
.footer{padding:12px;text-align:center;border-top:1px solid var(--border)}
.footer-logo{width:90px;border-radius:4px;margin-bottom:3px}
.footer-text{font-size:9px;color:var(--muted);letter-spacing:.3px}
</style>
</head>
<body>
<div class="container">

  <!-- Auto-Accept -->
  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">⚡ Auto-Accept</span>
    </div>
    <div class="aa-card">
      <div class="aa-row">
        <div class="aa-label">
          <span class="aa-dot ${s.autoAcceptEnabled ? 'on' : 'off'}"></span>
          <span id="aaText">${s.autoAcceptEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <label class="toggle">
          <input type="checkbox" id="aaToggle" ${s.autoAcceptEnabled ? 'checked' : ''}>
          <span class="toggle-sl"></span>
        </label>
      </div>
      <div class="aa-status" id="aaStatus">
        ${s.lsCount > 0 ? `🟢 Connected to ${s.lsCount} LS instance(s)` : '🔴 No LS detected — waiting...'}
      </div>
      <div class="aa-stats">
        <div class="stat"><div class="stat-val" id="lsCount">${s.lsCount}</div><div class="stat-lbl">LS Instances</div></div>
        <div class="stat"><div class="stat-val" id="acceptCount">${s.acceptedCount}</div><div class="stat-lbl">Accepted</div></div>
      </div>
    </div>
  </div>

  <!-- Auto-Continue -->
  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">🔄 Auto-Continue</span>
    </div>
    <div class="aa-card">
      <div class="aa-row">
        <div class="aa-label">
          <span class="aa-dot ${s.autoContinueEnabled ? 'on' : 'off'}"></span>
          <span id="acText">${s.autoContinueEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <label class="toggle">
          <input type="checkbox" id="acToggle" ${s.autoContinueEnabled ? 'checked' : ''}>
          <span class="toggle-sl"></span>
        </label>
      </div>
      <div class="aa-status" id="acStatus" style="font-size:10px;margin-top:6px;color:var(--muted)">
        Tự động gửi "Continue" khi AI bị ngắt do token limit
      </div>
      <div class="aa-stats">
        <div class="stat"><div class="stat-val" id="continueCount" style="color:var(--purple)">${s.continueCount}</div><div class="stat-lbl">Continued</div></div>
      </div>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="sec">
    <div class="sec-hdr">
      <span class="sec-title">📋 Activity Log</span>
      <button class="btn btn-swap" onclick="clearLog()" style="font-size:9px">Clear</button>
    </div>
    <div class="log-wrap" id="logWrap">
      <div class="log-empty" id="logEmpty">No activity yet</div>
    </div>
  </div>

  <!-- Profile Swap (hidden — feature not ready yet) -->
  <div id="toast" class="toast"></div>
</div>

<div class="footer">
  <img src="${logoUri}" class="footer-logo" alt="Claudible">
  <div class="footer-text">Developed by Claudible.io Team</div>
</div>

<script>
const vscode = acquireVsCodeApi();
let previousProfile = null;

function send(cmd, name) {
  vscode.postMessage({ command: cmd, profileName: name, previousProfile });
}

document.getElementById('aaToggle')?.addEventListener('change', () => send('toggleAutoAccept'));
document.getElementById('acToggle')?.addEventListener('change', () => send('toggleAutoContinue'));

// --- Activity Log with auto-scroll ---
const MAX_LOG = 50;
let logEntries = [];
const logWrap = document.getElementById('logWrap');
const logEmpty = document.getElementById('logEmpty');

function addLogEntry(evt) {
  if (logEmpty) logEmpty.style.display = 'none';
  const el = document.createElement('div');
  const isBlocked = evt.blocked;
  el.className = 'log-entry ' + (isBlocked ? 'blocked' : evt.success ? 'ok' : 'fail');
  const icon = isBlocked ? '⛔' : evt.success ? '✅' : '❌';
  const time = new Date(evt.ts).toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const type = (evt.stepType || 'UNKNOWN').replace('CORTEX_STEP_TYPE_','');
  // Show command preview for blocked or command steps
  let label = type + ' [' + evt.stepIndex + ']';
  if (isBlocked && evt.dangerCategory) {
    label = evt.dangerCategory;
  } else if (evt.commandText) {
    const preview = evt.commandText.length > 40 ? evt.commandText.substring(0,40)+'…' : evt.commandText;
    label = preview;
  }
  el.innerHTML = '<span class="le-icon">'+icon+'</span><span class="le-text" title="'+(evt.commandText||'').replace(/"/g,'&quot;')+'">'+label+'</span><span class="le-time">'+time+'</span>';
  logWrap.appendChild(el);
  logEntries.push(el);
  // Cap at MAX_LOG
  while (logEntries.length > MAX_LOG) {
    const old = logEntries.shift();
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  // Auto-scroll: check if user is near bottom (within 60px)
  const atBottom = logWrap.scrollHeight - logWrap.scrollTop - logWrap.clientHeight < 60;
  if (atBottom || logEntries.length <= 5) {
    logWrap.scrollTop = logWrap.scrollHeight;
  }
}

function clearLog() {
  logEntries.forEach(el => { if (el.parentNode) el.parentNode.removeChild(el); });
  logEntries = [];
  if (logEmpty) logEmpty.style.display = 'block';
}

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'stats') {
    const d = m.data;
    const dot = document.querySelector('.aa-dot');
    if (dot) { dot.className = 'aa-dot ' + (d.autoAcceptEnabled ? 'on' : 'off'); }
    const aaText = document.getElementById('aaText');
    if (aaText) aaText.textContent = d.autoAcceptEnabled ? 'Enabled' : 'Disabled';
    const aaT = document.getElementById('aaToggle');
    if (aaT) aaT.checked = d.autoAcceptEnabled;
    const aaS = document.getElementById('aaStatus');
    if (aaS) aaS.innerHTML = d.lsCount > 0 ? '🟢 Connected to '+d.lsCount+' LS instance(s)' : '🔴 No LS detected — waiting...';
    const lc = document.getElementById('lsCount');
    if (lc) lc.textContent = d.lsCount;
    const ac = document.getElementById('acceptCount');
    if (ac) ac.textContent = d.acceptedCount;
    // Auto-Continue stats
    const acDot = document.querySelector('.sec:nth-child(2) .aa-dot');
    if (acDot) acDot.className = 'aa-dot ' + (d.autoContinueEnabled ? 'on' : 'off');
    const acText = document.getElementById('acText');
    if (acText) acText.textContent = d.autoContinueEnabled ? 'Enabled' : 'Disabled';
    const acT = document.getElementById('acToggle');
    if (acT) acT.checked = d.autoContinueEnabled;
    const cc = document.getElementById('continueCount');
    if (cc) cc.textContent = d.continueCount;
  }
  if (m.type === 'status') {
    const t = document.getElementById('toast');
    if (t) {
      t.className = 'toast ' + (m.statusType || '');
      t.textContent = m.statusMsg || '';
      if (m.statusType) setTimeout(() => { t.className = 'toast'; }, 5000);
    }
  }
  if (m.type === 'acceptEvent') {
    addLogEntry(m.data);
  }
  if (m.type === 'continueEvent') {
    addLogEntry({ stepType: 'AUTO_CONTINUE', stepIndex: 0, success: m.data.success, ts: m.data.ts, commandText: 'Sent "Continue"', cascadeId: m.data.cascadeId });
  }
});

</script>
</body>
</html>`;
    }
}
