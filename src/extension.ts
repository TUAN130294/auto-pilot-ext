// === Auto-Pilot Extension — main entry point ===
import * as vscode from 'vscode';
import { AutoAcceptEngine } from './auto-accept';
import { SidebarProvider } from './sidebar-provider';
import {
    initProfileState,
    swapProfile,
    saveCurrentAccount,
    deleteProfile,
    startAddAccount,
    listProfiles,
    getActiveProfile,
} from './profile-manager';

let autoAcceptEngine: AutoAcceptEngine | undefined;
let sidebarProvider: SidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Auto-Pilot');
    log.appendLine('[Auto-Pilot] Extension activating...');

    // Init profile state
    initProfileState(context);

    // --- Auto-Accept Engine ---
    autoAcceptEngine = new AutoAcceptEngine(log);
    const initialEnabled = vscode.workspace.getConfiguration('auto-pilot').get<boolean>('autoAcceptEnabled') || false;
    autoAcceptEngine.setEnabled(initialEnabled);

    // Watch config changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('auto-pilot.autoAcceptEnabled')) {
                const val = vscode.workspace.getConfiguration('auto-pilot').get<boolean>('autoAcceptEnabled') || false;
                autoAcceptEngine?.setEnabled(val);
                sidebarProvider?.refresh();
            }
            if (e.affectsConfiguration('auto-pilot.pollIntervalMs')) {
                if (autoAcceptEngine?.isEnabled) {
                    autoAcceptEngine.stop();
                    autoAcceptEngine.start();
                }
            }
        })
    );

    // --- Sidebar Webview Provider ---
    sidebarProvider = new SidebarProvider(context.extensionUri, log, autoAcceptEngine);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider)
    );

    // --- Periodic refresh for sidebar (LS status + accepted count) ---
    const refreshTimer = setInterval(() => {
        sidebarProvider?.refreshStats();
    }, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.toggleAutoAccept', () => {
            autoAcceptEngine?.toggle();
            sidebarProvider?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.refreshProfiles', () => {
            sidebarProvider?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.swapProfile', async (item?: { name: string }) => {
            let targetName = item?.name;
            if (!targetName) {
                const profiles = listProfiles();
                const active = getActiveProfile();
                const picks = profiles
                    .filter(p => p.name !== active)
                    .map(p => ({ label: p.name, description: p.meta?.email || '' }));
                if (picks.length === 0) {
                    vscode.window.showWarningMessage('No other profiles to swap to.');
                    return;
                }
                const selected = await vscode.window.showQuickPick(picks, { placeHolder: 'Select account to swap to' });
                if (!selected) { return; }
                targetName = selected.label;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Swap to "${targetName}"? IDE will close and relaunch.`,
                { modal: true }, 'Swap'
            );
            if (confirm !== 'Swap') { return; }
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `Swapping to ${targetName}...`, cancellable: false },
                    () => swapProfile(targetName!, log)
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`Swap failed: ${err.message}`);
            }
            sidebarProvider?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.saveAccount', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'Profile name (alphanumeric, dash, underscore)',
                placeHolder: 'e.g. my-work-account',
                validateInput: (v) => {
                    if (!v.trim()) { return 'Name required'; }
                    if (!/^[a-zA-Z0-9_-]+$/.test(v)) { return 'Only alphanumeric, dash, underscore'; }
                    return null;
                },
            });
            if (!name) { return; }
            try {
                const instances = autoAcceptEngine?.getInstances() || [];
                await saveCurrentAccount(name, instances[0] || null, log);
                vscode.window.showInformationMessage(`✅ Account saved as "${name}"`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Save failed: ${err.message}`);
            }
            sidebarProvider?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.deleteProfile', async (item?: { name: string }) => {
            let targetName = item?.name;
            if (!targetName) {
                const profiles = listProfiles();
                const active = getActiveProfile();
                const picks = profiles.filter(p => p.name !== active).map(p => ({ label: p.name }));
                const selected = await vscode.window.showQuickPick(picks, { placeHolder: 'Select profile to delete' });
                if (!selected) { return; }
                targetName = selected.label;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Delete "${targetName}"? This cannot be undone.`, { modal: true }, 'Delete'
            );
            if (confirm !== 'Delete') { return; }
            try {
                deleteProfile(targetName);
                vscode.window.showInformationMessage(`Deleted "${targetName}"`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Delete failed: ${err.message}`);
            }
            sidebarProvider?.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.addAccount', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Add new account? IDE will close and relaunch for fresh login.',
                { modal: true }, 'Continue'
            );
            if (confirm !== 'Continue') { return; }
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Preparing...', cancellable: false },
                    () => startAddAccount(log)
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`Add account failed: ${err.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('auto-pilot.showStatus', async () => {
            const instances = autoAcceptEngine?.getInstances() || [];
            const active = getActiveProfile();
            const lines = [
                `Auto-Accept: ${autoAcceptEngine?.isEnabled ? '✅ ON' : '❌ OFF'}`,
                `Accepted: ${autoAcceptEngine?.getAcceptedCount() || 0}`,
                `LS Instances: ${instances.length}`,
                ...instances.map((inst, i) => `  [${i}] pid=${inst.pid} port=${inst.port} tls=${inst.useTls}`),
                `Active Profile: ${active || '(none)'}`,
                `Profiles: ${listProfiles().map(p => p.name).join(', ') || '(none)'}`,
            ];
            const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'text' });
            vscode.window.showTextDocument(doc);
        })
    );

    // Cleanup
    context.subscriptions.push(autoAcceptEngine);
    context.subscriptions.push(log);

    log.appendLine('[Auto-Pilot] Ready ✅');
}

export function deactivate() {
    autoAcceptEngine?.dispose();
}
