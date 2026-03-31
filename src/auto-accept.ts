// === Auto-Accept Engine — ported from Antigravity-Deck auto-accept.js ===
import * as vscode from 'vscode';
import { LsInstance, TrajectoryStep, getAllTrajectories, getTrajectorySteps, sendInteraction } from './ls-api';
import { detectLsInstances } from './detector';
import { detectDanger, DangerResult } from './danger-detector';
import * as fs from 'fs';
import * as path from 'path';

const DEBOUNCE_TTL = 15000;

// Antigravity LS API startIndex workaround:
// JSON API may ignore startIndex and return from 0.
// If we got more steps than expected range, API started at 0.
function detectApiStartIndex(stepsLength: number, expectedRange: number, requestedFrom: number): number {
    return stepsLength > expectedRange ? 0 : requestedFrom;
}

export interface AcceptEvent {
    cascadeId: string;
    stepIndex: number;
    stepType: string;
    success: boolean;
    ts: number;
    blocked?: boolean;     // true if blocked by danger detector
    dangerCategory?: string;
    commandText?: string;  // the raw command for log display
}

export class AutoAcceptEngine {
    private enabled = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private debounceSet = new Map<string, number>();
    private statusBar: vscode.StatusBarItem;
    private log: vscode.OutputChannel;
    private instances: LsInstance[] = [];
    private isRunning = false;
    private acceptedCount = 0;
    private _onAcceptEvent = new vscode.EventEmitter<AcceptEvent>();
    readonly onAcceptEvent = this._onAcceptEvent.event;

    constructor(log: vscode.OutputChannel) {
        this.log = log;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.command = 'auto-pilot.toggleAutoAccept';
        this.statusBar.show();
        this.updateStatusBar();
    }

    get isEnabled(): boolean { return this.enabled; }

    getInstances(): LsInstance[] { return this.instances; }

    getAcceptedCount(): number { return this.acceptedCount; }

    toggle(): void {
        this.enabled = !this.enabled;
        if (this.enabled) { this.start(); } else { this.stop(); }
        vscode.workspace.getConfiguration('auto-pilot').update('autoAcceptEnabled', this.enabled, vscode.ConfigurationTarget.Global);
        this.updateStatusBar();
        vscode.window.showInformationMessage(`Auto-Pilot: Auto-Accept ${this.enabled ? 'ENABLED ✅' : 'DISABLED ❌'}`);
    }

    setEnabled(val: boolean): void {
        this.enabled = val;
        if (this.enabled) { this.start(); } else { this.stop(); }
        this.updateStatusBar();
    }

    start(): void {
        if (this.timer) { clearInterval(this.timer); }
        const interval = vscode.workspace.getConfiguration('auto-pilot').get<number>('pollIntervalMs') || 1500;
        this.timer = setInterval(() => this.poll(), interval);
        this.log.appendLine(`[AutoAccept] Started polling every ${interval}ms`);
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.debounceSet.clear();
        this.log.appendLine(`[AutoAccept] Stopped`);
    }

    dispose(): void {
        this.stop();
        this.statusBar.dispose();
        this._onAcceptEvent.dispose();
    }

    private updateStatusBar(): void {
        const connected = this.instances.length > 0;
        if (this.enabled) {
            this.statusBar.text = connected ? '$(check) Auto-Accept ON' : '$(warning) Auto-Accept ON (no LS)';
        } else {
            this.statusBar.text = '$(x) Auto-Accept OFF';
        }
        this.statusBar.tooltip = `Auto-Pilot: ${this.enabled ? 'ON' : 'OFF'} | ${this.instances.length} LS | ${this.acceptedCount} accepted`;
    }

    private isDuplicate(key: string): boolean {
        const now = Date.now();
        for (const [k, expiry] of this.debounceSet) {
            if (expiry < now) { this.debounceSet.delete(k); }
        }
        if (this.debounceSet.has(key)) { return true; }
        this.debounceSet.set(key, now + DEBOUNCE_TTL);
        return false;
    }

    private removeDuplicate(key: string): void {
        this.debounceSet.delete(key);
    }

    private async poll(): Promise<void> {
        if (!this.enabled || this.isRunning) { return; }
        this.isRunning = true;

        try {
            // Re-detect LS instances
            this.instances = await detectLsInstances();
            this.updateStatusBar();
            if (this.instances.length === 0) { return; }

            // Poll EACH LS instance independently (same as Deck)
            for (const inst of this.instances) {
                try {
                    const trajectories = await getAllTrajectories(inst);
                    for (const [cascadeId, info] of Object.entries(trajectories)) {
                        if (info.status !== 'CASCADE_RUN_STATUS_RUNNING' &&
                            info.status !== 'CASCADE_RUN_STATUS_WAITING_FOR_USER') { continue; }

                        const stepCount = info.stepCount || 0;
                        if (stepCount === 0) { continue; }

                        const trajectoryId = info.trajectoryId;
                        const from = Math.max(0, stepCount - 5);

                        try {
                            const steps = await getTrajectorySteps(inst, cascadeId, from, stepCount);

                            // CRITICAL: Antigravity LS API startIndex workaround
                            const expectedRange = stepCount - from;
                            const apiStartedAt = detectApiStartIndex(steps.length, expectedRange, from);

                            // Search from end (most recent step first)
                            for (let i = steps.length - 1; i >= 0; i--) {
                                const realIdx = apiStartedAt + i;
                                if (realIdx < from) { continue; } // skip steps outside requested range

                                const step = steps[i];
                                if (step.status === 'CORTEX_STEP_STATUS_WAITING' || step.status === 9) {
                                    await this.acceptStep(inst, cascadeId, trajectoryId, realIdx, step);
                                    break; // Only accept latest WAITING step per cascade
                                }
                            }
                        } catch { /* skip cascade */ }
                    }
                } catch { /* skip instance */ }
            }
        } finally {
            this.isRunning = false;
        }
    }

    private async acceptStep(inst: LsInstance, cascadeId: string, trajectoryId: string, stepIndex: number, step: TrajectoryStep): Promise<void> {
        const debounceKey = `${cascadeId}:${inst.port}:${stepIndex}`;

        // Build interaction BEFORE debounce check (same as Deck)
        const interaction = this.buildInteraction(trajectoryId, stepIndex, step);
        if (!interaction) {
            // Build failed — don't debounce, allow retry
            return;
        }

        // Now check debounce
        if (this.isDuplicate(debounceKey)) { return; }

        const stepType = ((step.type || '') as string).replace('CORTEX_STEP_TYPE_', '');

        // --- Danger detection for commands ---
        const commandText = this.extractCommandText(step, stepType);
        if (commandText) {
            const danger = detectDanger(commandText);
            if (danger.isDangerous) {
                const userChoice = await this.showDangerWarning(danger);
                if (!userChoice) {
                    // User rejected — skip this step, don't auto-accept
                    this.log.appendLine(`[AutoAccept] ⛔ BLOCKED by user: ${cascadeId.substring(0, 8)} step[${stepIndex}] — ${danger.category}`);
                    this._onAcceptEvent.fire({ cascadeId, stepIndex, stepType, success: false, ts: Date.now(), blocked: true, dangerCategory: danger.category, commandText });
                    return;
                }
                this.log.appendLine(`[AutoAccept] ⚠️ User approved dangerous command: ${cascadeId.substring(0, 8)} step[${stepIndex}]`);
            }
        }

        this.log.appendLine(`[AutoAccept] >>> Accepting ${cascadeId.substring(0, 8)} step[${stepIndex}] (${stepType})`);

        const ok = await sendInteraction(inst, cascadeId, { cascadeId, interaction });
        if (ok) {
            this.acceptedCount++;
            this.log.appendLine(`[AutoAccept] +++ ACCEPTED ${cascadeId.substring(0, 8)} step[${stepIndex}]`);
        } else {
            this.log.appendLine(`[AutoAccept] --- FAILED ${cascadeId.substring(0, 8)} step[${stepIndex}]`);
            this.removeDuplicate(debounceKey); // Allow retry
        }
        this._onAcceptEvent.fire({ cascadeId, stepIndex, stepType, success: ok, ts: Date.now(), commandText });
    }

    /** Extract the raw command text from a step for danger scanning */
    private extractCommandText(step: TrajectoryStep, stepType: string): string {
        if (stepType === 'RUN_COMMAND') {
            return step.runCommand?.commandLine || step.runCommand?.command || '';
        }
        if (stepType === 'SEND_COMMAND_INPUT') {
            return step.sendCommandInput?.input || '';
        }
        return '';
    }

    /** Show a modal warning for dangerous commands. Returns true if user approves. */
    private async showDangerWarning(danger: DangerResult): Promise<boolean> {
        const icon = danger.level === 'critical' ? '🚨' : '⚠️';
        const levelText = danger.level === 'critical' ? 'NGUY HIỂM' : 'CẢNH BÁO';

        // Truncate command for display (keep first 120 chars)
        const cmdPreview = danger.command.length > 120
            ? danger.command.substring(0, 120) + '...'
            : danger.command;

        const message = [
            `${icon} ${levelText}: ${danger.category}`,
            '',
            danger.explanation,
            '',
            `Lệnh: ${cmdPreview}`,
        ].join('\n');

        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true, detail: `${danger.explanation}\n\nBạn có muốn cho phép chạy lệnh này không?` },
            'Cho phép chạy',
            'Bỏ qua (Skip)'
        );

        return choice === 'Cho phép chạy';
    }

    private buildInteraction(trajectoryId: string, stepIndex: number, step: TrajectoryStep): Record<string, unknown> | null {
        const interaction: Record<string, unknown> = { trajectoryId, stepIndex };
        const stepType = ((step.type || '') as string).replace('CORTEX_STEP_TYPE_', '');

        switch (stepType) {
            case 'RUN_COMMAND': {
                const cmd = step.runCommand?.commandLine || step.runCommand?.command || '';
                interaction.runCommand = {
                    confirm: true,
                    proposedCommandLine: cmd,
                    submittedCommandLine: cmd,
                };
                break;
            }
            case 'CODE_ACTION': {
                const filePath = this.extractFilePath(step);
                if (filePath) {
                    if (this.validateWorkspacePath(filePath)) {
                        interaction.filePermission = {
                            allow: true,
                            scope: 'PERMISSION_SCOPE_ONCE',
                            absolutePathUri: filePath,
                        };
                    } else {
                        // Auto-accept mode: skip out-of-workspace (same as Deck)
                        this.log.appendLine(`[AutoAccept] Skipping (outside workspace): ${filePath}`);
                        return null;
                    }
                } else {
                    interaction.codeAction = { confirm: true };
                }
                break;
            }
            case 'VIEW_FILE':
            case 'LIST_DIRECTORY':
            case 'READ_URL_CONTENT':
            case 'VIEW_CONTENT_CHUNK':
            case 'SEARCH': {
                // Read-only — always safe
                const readPath = this.extractReadPath(step, stepType);
                if (readPath) {
                    let uri = readPath;
                    if (!uri.startsWith('file://')) {
                        const normalized = uri.replace(/\\/g, '/');
                        uri = 'file:///' + (normalized.startsWith('/') ? normalized.substring(1) : normalized);
                    }
                    interaction.filePermission = {
                        allow: true,
                        scope: 'PERMISSION_SCOPE_ONCE',
                        absolutePathUri: uri,
                    };
                } else {
                    interaction.confirm = true;
                }
                break;
            }
            case 'SEND_COMMAND_INPUT': {
                const input = step.sendCommandInput?.input || '';
                interaction.sendCommandInput = {
                    confirm: true,
                    proposedInput: input,
                    submittedInput: input,
                };
                break;
            }
            case 'OPEN_BROWSER_URL':
            case 'BROWSER_ACTION':
            case 'BROWSER_SUBAGENT': {
                interaction.browserAction = { confirm: true };
                break;
            }
            default: {
                const fp = this.extractFilePath(step);
                if (fp) {
                    if (this.validateWorkspacePath(fp)) {
                        interaction.filePermission = { allow: true, scope: 'PERMISSION_SCOPE_ONCE', absolutePathUri: fp };
                    } else {
                        this.log.appendLine(`[AutoAccept] Skipping (outside workspace, default): ${fp}`);
                        return null;
                    }
                } else {
                    interaction.confirm = true;
                }
                break;
            }
        }

        return interaction;
    }

    private extractFilePath(step: TrajectoryStep): string {
        const ca = step.codeAction || {};
        let fp = (ca.targetFile || ca.filePath || '') as string;

        // From actionSpec
        if (!fp) {
            const actionSpec = ca.actionSpec as Record<string, unknown> | undefined;
            const cmd = actionSpec?.command as Record<string, unknown> | undefined;
            const chunks = cmd?.replacementChunks as Array<Record<string, unknown>> | undefined;
            if (chunks?.[0]?.targetFile) { fp = chunks[0].targetFile as string; }
        }

        // From metadata
        if (!fp && step.metadata?.toolCall?.argumentsJson) {
            try {
                const args = JSON.parse(step.metadata.toolCall.argumentsJson);
                fp = args.TargetFile || args.AbsolutePath || args.FilePath || '';
            } catch { /* ignore */ }
        }

        // Binary-decoded numeric fields
        if (!fp && ca['25'] && typeof ca['25'] === 'string') {
            const cleaned = (ca['25'] as string).replace(/[\x00-\x1f]/g, '').trim();
            const winMatch = cleaned.match(/([A-Za-z]:\\[^\x00]+)/);
            const macMatch = cleaned.match(/(\/[^\x00]+)/);
            if (winMatch) { fp = winMatch[1]; }
            else if (macMatch) { fp = macMatch[1]; }
        }
        if (!fp && ca['1'] && typeof ca['1'] === 'string') {
            const uriMatch = (ca['1'] as string).match(/file:\/\/(\/[^\s\x00]+)/);
            if (uriMatch) {
                let extracted = uriMatch[1];
                if (/^\/[A-Za-z]:/.test(extracted)) { extracted = extracted.substring(1); }
                fp = 'file://' + (extracted.startsWith('/') ? '' : '/') + extracted;
            }
        }

        return fp;
    }

    private extractReadPath(step: TrajectoryStep, stepType: string): string {
        const vf = step.viewFile as Record<string, unknown> | undefined;
        const ld = step.listDirectory as Record<string, unknown> | undefined;

        let readPath = '';
        if (vf?.absolutePathUri) { readPath = vf.absolutePathUri as string; }
        else if ((vf as any)?.filePermissionRequest?.absolutePathUri) { readPath = (vf as any).filePermissionRequest.absolutePathUri; }
        else if (ld?.directoryPathUri) { readPath = ld.directoryPathUri as string; }

        if (!readPath && step.metadata?.toolCall?.argumentsJson) {
            try {
                const args = JSON.parse(step.metadata.toolCall.argumentsJson);
                readPath = args.AbsolutePath || args.DirectoryPath || args.SearchPath || args.Url || '';
            } catch { /* ignore */ }
        }

        return readPath;
    }

    private uriToFsPath(uri: string): string | null {
        if (!uri) { return null; }
        try {
            const url = new URL(uri);
            let p = decodeURIComponent(url.pathname);
            if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) { p = p.substring(1); }
            return p;
        } catch { return null; }
    }

    private validateWorkspacePath(filePath: string): boolean {
        let fsPath = filePath;
        if (fsPath.startsWith('file://')) {
            const converted = this.uriToFsPath(fsPath);
            if (converted) { fsPath = converted; }
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            // No workspace open — allow all (same as Deck with no workspace)
            return true;
        }

        let realPath: string;
        try { realPath = fs.realpathSync(fsPath); }
        catch { realPath = path.resolve(fsPath); }

        for (const folder of workspaceFolders) {
            const root = folder.uri.fsPath;
            let normalizedRoot: string;
            try { normalizedRoot = fs.realpathSync(root); }
            catch { normalizedRoot = path.resolve(root); }

            const isInside = process.platform === 'win32'
                ? realPath.toLowerCase() === normalizedRoot.toLowerCase() ||
                  realPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + path.sep)
                : realPath === normalizedRoot ||
                  realPath.startsWith(normalizedRoot + path.sep);

            if (isInside) { return true; }
        }

        return false;
    }
}
