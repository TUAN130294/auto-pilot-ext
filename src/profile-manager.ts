// === Profile Manager — swap Antigravity Google accounts ===
// KEY INSIGHT: Extension runs INSIDE the IDE. When we close IDE, extension dies too.
// Solution: spawn a detached relaunch helper script BEFORE closing IDE.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn, execSync } from 'child_process';
import { LsInstance, getSubscriptionStatus, getUserStatus } from './ls-api';

const PS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 3 folders that hold account-specific data
const SWAP_FOLDERS = [
    { name: 'Antigravity', source: () => path.join(process.env.APPDATA || '', 'Antigravity') },
    { name: '.gemini', source: () => path.join(os.homedir(), '.gemini') },
    { name: '.antigravity', source: () => path.join(os.homedir(), '.antigravity') },
];

const SKIP_DIRS = new Set(['Network', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'Service Worker', 'Cache_Data', 'Code Cache']);

export interface ProfileMeta {
    userName?: string;
    email?: string;
    tier?: string;
    plan?: string;
    savedAt?: string;
}

export interface ProfileEntry {
    name: string;
    meta: ProfileMeta | null;
}

// --- Settings persistence ---
let _extState: { activeProfile: string | null } = { activeProfile: null };
let _extStatePath: string = '';

export function initProfileState(context: vscode.ExtensionContext): void {
    const storageDir = context.globalStorageUri.fsPath;
    _extStatePath = path.join(storageDir, 'auto-pilot-state.json');
    fs.mkdirSync(storageDir, { recursive: true });

    // Read our state
    if (fs.existsSync(_extStatePath)) {
        try { _extState = JSON.parse(fs.readFileSync(_extStatePath, 'utf-8')); } catch { /* ignore */ }
    }

    // Sync from Deck settings.json
    if (!_extState.activeProfile) {
        const deckActive = readDeckActiveProfile();
        if (deckActive) { _extState.activeProfile = deckActive; saveExtState(); }
    }

    // Auto-detect first profile
    if (!_extState.activeProfile) {
        const profiles = listProfiles();
        if (profiles.length > 0) { _extState.activeProfile = profiles[0].name; saveExtState(); }
    }
}

function saveExtState(): void {
    try { fs.writeFileSync(_extStatePath, JSON.stringify(_extState, null, 2), 'utf-8'); } catch { /* ignore */ }
}

function readDeckActiveProfile(): string | null {
    const candidates = [
        'D:\\anti deck\\Antigravity-Deck\\settings.json',
        path.join(os.homedir(), 'Antigravity-Deck', 'settings.json'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (data.activeProfile) { return data.activeProfile; }
            } catch { /* ignore */ }
        }
    }
    return null;
}

function writeDeckActiveProfile(name: string | null): void {
    const candidates = [
        'D:\\anti deck\\Antigravity-Deck\\settings.json',
        path.join(os.homedir(), 'Antigravity-Deck', 'settings.json'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try {
                const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
                data.activeProfile = name;
                fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
            } catch { /* ignore */ }
        }
    }
}

function getProfilesDir(): string {
    const custom = vscode.workspace.getConfiguration('auto-pilot').get<string>('profilesDir');
    if (custom && custom.trim()) { return custom.trim(); }
    return path.join(process.env.APPDATA || os.homedir(), 'AntigravityDeck', 'profiles');
}

function runPs(cmd: string, timeout = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(`"${PS_PATH}" -NoProfile -Command "${cmd}"`, { timeout }, (err, stdout, stderr) => {
            if (err) { return reject(new Error(stderr || err.message)); }
            resolve(stdout.trim());
        });
    });
}

// --- List profiles ---
export function listProfiles(): ProfileEntry[] {
    const dir = getProfilesDir();
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, meta: getProfileMeta(d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getProfileMeta(name: string): ProfileMeta | null {
    const metaPath = path.join(getProfilesDir(), name, 'profile.json');
    if (!fs.existsSync(metaPath)) { return null; }
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return null; }
}

// --- Active profile ---
export function getActiveProfile(): string | null { return _extState.activeProfile; }

function setActiveProfile(name: string | null): void {
    _extState.activeProfile = name;
    saveExtState();
    writeDeckActiveProfile(name);
}

// --- Get IDE exe path ---
function getIdeExePath(): string {
    // Try to get from running process
    try {
        const result = execSync(
            `"${PS_PATH}" -NoProfile -Command "(Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.Path }).Path | Select-Object -First 1"`,
            { timeout: 5000, encoding: 'utf-8' }
        ).trim();
        if (result && fs.existsSync(result)) { return result; }
    } catch { /* ignore */ }

    // Fallback
    const fallback = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');
    return fallback;
}

// --- Kill Java zombies ---
async function killJavaZombies(): Promise<void> {
    if (os.platform() !== 'win32') { return; }
    try {
        await runPs(
            `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -match 'antigravity' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
            5000
        );
    } catch { /* OK */ }
}

// --- Move directory with retry ---
async function moveDirWithRetry(src: string, dst: string, maxRetries = 5): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            fs.renameSync(src, dst);
            return;
        } catch (err: any) {
            if (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EBUSY') {
                if (err.code !== 'EXDEV' && attempt < maxRetries) {
                    await killJavaZombies();
                    await new Promise(r => setTimeout(r, 2000 + attempt * 2000));
                    continue;
                }
                fs.mkdirSync(dst, { recursive: true });
                fs.cpSync(src, dst, { recursive: true, force: true });
                fs.rmSync(src, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
                return;
            }
            throw err;
        }
    }
}

// =====================================================================
// CRITICAL: Relaunch strategy for extension-inside-IDE
// Extension dies when IDE closes. So we:
// 1. Get IDE exe path BEFORE closing
// 2. Write a detached PowerShell script that:
//    a. Waits for IDE to fully exit
//    b. Runs folder swap operations
//    c. Relaunches IDE
// 3. Spawn the script detached
// 4. THEN close IDE (extension dies here, but script keeps running)
// =====================================================================

// Escape backslashes for embedding in PS single-quoted strings
function psPath(p: string): string { return p.replace(/'/g, "''"); }

function buildSwapScript(ops: {
    exePath: string;
    moves: Array<{ src: string; dst: string }>;
    restores: Array<{ src: string; dst: string }>;
    killJava: boolean;
}): string {
    const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'auto-pilot');
    const logFile = path.join(logDir, 'swap-log.txt');
    const fallbackExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');

    const lines: string[] = [
        '# Auto-Pilot swap script — auto-generated, safe to delete',
        '$ErrorActionPreference = "Continue"',
        '',
        '# Ensure log directory exists',
        `$logDir = '${psPath(logDir)}'`,
        'if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }',
        `$logFile = '${psPath(logFile)}'`,
        'function Log($msg) { try { $ts = Get-Date -Format "HH:mm:ss"; Add-Content -Path $logFile -Value "$ts $msg" -Encoding utf8 } catch {} }',
        '',
        '# Robust move: try rename, fallback to robocopy (handles locked files)',
        'function MoveDir($src, $dst) {',
        '  if (-not (Test-Path $src)) { Log "SKIP: $src does not exist"; return }',
        '  Log "Moving: $src -> $dst"',
        '  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }',
        '  # Try rename first (fastest)',
        '  try { Move-Item $src $dst -Force -ErrorAction Stop; Log "OK: renamed"; return } catch { Log "Rename failed: $_" }',
        '  # Fallback: robocopy (handles locked files gracefully)',
        '  New-Item -ItemType Directory -Path $dst -Force | Out-Null',
        '  $rc = robocopy $src $dst /E /MOVE /R:3 /W:2 /XF *.log /XD GPUCache GrShaderCache ShaderCache "Service Worker" Cache_Data "Code Cache" /NFL /NDL /NJH /NJS /NC /NS /NP 2>&1',
        '  Log "Robocopy done (exit=$LASTEXITCODE)"',
        '  # Clean up leftover locked files/dirs',
        '  if (Test-Path $src) { Remove-Item $src -Recurse -Force -ErrorAction SilentlyContinue }',
        '}',
        '',
        'Log "=== Swap script started ==="',
        '',
        '# Wait for IDE to fully exit (poll up to 30s)',
        'Log "Waiting for IDE to exit..."',
        '$exited = $false',
        'for ($i = 0; $i -lt 30; $i++) {',
        '  $proc = Get-Process -Name Antigravity -ErrorAction SilentlyContinue',
        '  if (-not $proc) { $exited = $true; Log "IDE exited after $($i)s"; break }',
        '  Start-Sleep -Seconds 1',
        '}',
        'if (-not $exited) { Log "WARNING: IDE still running after 30s, proceeding anyway" }',
        '',
        '# Wait for file handles to release',
        'Start-Sleep -Seconds 3',
        '',
    ];

    if (ops.killJava) {
        lines.push('# Kill Java zombies');
        lines.push('try {');
        lines.push('  Get-CimInstance Win32_Process -Filter "Name=\'java.exe\'" | Where-Object { $_.CommandLine -match "antigravity" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }');
        lines.push('  Log "Java zombies cleaned"');
        lines.push('} catch { Log "Java cleanup: $_" }');
        lines.push('Start-Sleep -Seconds 1');
        lines.push('');
    }

    // Phase A: save current folders
    if (ops.moves.length > 0) {
        lines.push('# Phase A: Save current folders');
        for (const m of ops.moves) {
            lines.push(`MoveDir '${psPath(m.src)}' '${psPath(m.dst)}'`);
            lines.push(`Log "Phase A: ${path.basename(m.src)} done"`);
        }
        lines.push('');
    }

    // Phase B: restore target folders
    if (ops.restores.length > 0) {
        lines.push('# Phase B: Restore target folders');
        for (const r of ops.restores) {
            lines.push(`MoveDir '${psPath(r.src)}' '${psPath(r.dst)}'`);
            lines.push(`Log "Phase B: ${path.basename(r.src)} restored"`);
        }
        lines.push('');
    }

    // Relaunch with fallback
    lines.push('# Relaunch IDE');
    lines.push(`$exePath = '${psPath(ops.exePath)}'`);
    lines.push(`$fallback = '${psPath(fallbackExe)}'`);
    lines.push('if (-not (Test-Path $exePath)) {');
    lines.push('  Log "Primary exe not found, trying fallback"');
    lines.push('  $exePath = $fallback');
    lines.push('}');
    lines.push('if (Test-Path $exePath) {');
    lines.push('  Start-Process $exePath');
    lines.push('  Log "IDE relaunched: $exePath"');
    lines.push('} else {');
    lines.push('  Log "ERROR: IDE exe not found!"');
    lines.push('}');
    lines.push('');
    lines.push('Log "=== Swap script completed ==="');
    lines.push('Remove-Item $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue');

    return lines.join('\r\n');
}

function spawnDetachedScript(script: string, log: vscode.OutputChannel): void {
    const tmpDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'auto-pilot');
    fs.mkdirSync(tmpDir, { recursive: true });

    // Clear old log for fresh run
    const logFile = path.join(tmpDir, 'swap-log.txt');
    try { fs.writeFileSync(logFile, '', 'utf-8'); } catch { /* ignore */ }

    const scriptPath = path.join(tmpDir, `swap-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, script, 'utf-8');

    log.appendLine(`[Profile] Spawning detached script: ${scriptPath}`);
    log.appendLine(`[Profile] Swap log: ${logFile}`);

    // Write a tiny WMI launcher script that creates a fully detached process.
    // Electron kills all child processes on exit, so we use WMI Win32_Process.Create
    // which starts the process under WmiPrvSE.exe — completely outside the IDE tree.
    const launcherPath = path.join(tmpDir, 'launcher.ps1');
    const launcherContent = [
        `$cmd = '"${PS_PATH}" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"'`,
        `([wmiclass]'Win32_Process').Create($cmd) | Out-Null`,
    ].join('\r\n');
    fs.writeFileSync(launcherPath, launcherContent, 'utf-8');

    try {
        execSync(
            `"${PS_PATH}" -NoProfile -ExecutionPolicy Bypass -File "${launcherPath}"`,
            { timeout: 5000, windowsHide: true, stdio: 'ignore' }
        );
        log.appendLine(`[Profile] Script launched via WMI (fully detached)`);
    } catch (err: any) {
        log.appendLine(`[Profile] WMI launch failed: ${err.message}`);
    }
}

// --- Swap Profile ---
export async function swapProfile(targetProfile: string, log: vscode.OutputChannel): Promise<void> {
    const currentProfile = getActiveProfile();
    if (!currentProfile) {
        throw new Error('No active profile. Save current account first (use "Auto-Pilot: Save Current Account").');
    }
    if (currentProfile === targetProfile) {
        throw new Error(`Already on profile "${targetProfile}".`);
    }

    const profilesDir = getProfilesDir();
    const currentDir = path.join(profilesDir, currentProfile);
    const targetDir = path.join(profilesDir, targetProfile);

    if (!fs.existsSync(targetDir)) {
        throw new Error(`Profile "${targetProfile}" not found.`);
    }

    const exePath = getIdeExePath();
    log.appendLine(`[Profile] Swapping: ${currentProfile} → ${targetProfile} (exe: ${exePath})`);

    // Build move operations
    const moves: Array<{ src: string; dst: string }> = [];
    const restores: Array<{ src: string; dst: string }> = [];

    fs.mkdirSync(currentDir, { recursive: true });
    for (const f of SWAP_FOLDERS) {
        moves.push({ src: f.source(), dst: path.join(currentDir, f.name) });
        restores.push({ src: path.join(targetDir, f.name), dst: f.source() });
    }

    // Update state BEFORE close (we're about to die)
    setActiveProfile(targetProfile);

    // Build and spawn detached script
    const script = buildSwapScript({ exePath, moves, restores, killJava: true });
    spawnDetachedScript(script, log);

    // Wait a moment for script to start
    await new Promise(r => setTimeout(r, 500));

    // Close IDE — this kills us too, but the detached script continues
    log.appendLine(`[Profile] Closing IDE... (detached script will swap folders and relaunch)`);
    try {
        await runPs(
            `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() } | Out-Null`,
            5000
        );
    } catch { /* OK */ }
}

// --- Save current account ---
export async function saveCurrentAccount(name: string, lsInstance: LsInstance | null, log: vscode.OutputChannel): Promise<void> {
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error('Invalid profile name (only alphanumeric, dash, underscore)');
    }

    const profilesDir = getProfilesDir();
    const dir = path.join(profilesDir, name);
    // If profile exists and we're in adding mode (no active), allow overwrite
    if (fs.existsSync(dir) && getActiveProfile()) {
        throw new Error(`Profile "${name}" already exists.`);
    }
    // Clean existing dir for fresh save
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    fs.mkdirSync(dir, { recursive: true });

    let copied = 0;
    for (const f of SWAP_FOLDERS) {
        const src = f.source();
        if (fs.existsSync(src)) {
            const dst = path.join(dir, f.name);
            try {
                fs.cpSync(src, dst, {
                    recursive: true,
                    force: true,
                    filter: (s) => {
                        const base = path.basename(s);
                        // Skip cache dirs and locked log files
                        if (SKIP_DIRS.has(base)) { return false; }
                        if (base.endsWith('.log')) { return false; }
                        return true;
                    },
                    errorOnExist: false,
                });
                copied++;
                log.appendLine(`[Profile] Copied ${f.name} (${src} → ${dst})`);
            } catch (err: any) {
                // Partial copy is OK — critical data (OAuth tokens, config) usually copies fine
                if (err.code === 'EPERM' || err.code === 'EBUSY') {
                    copied++;
                    log.appendLine(`[Profile] Partial copy ${f.name} (some files locked, OK)`);
                } else {
                    log.appendLine(`[Profile] Copy failed ${f.name}: ${err.message}`);
                }
            }
        } else {
            log.appendLine(`[Profile] Skip ${f.name}: source not found (${src})`);
        }
    }

    if (copied === 0) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error('No IDE data folders found. Make sure IDE has been opened.');
    }

    // Fetch metadata from LS
    let metadata: ProfileMeta = { savedAt: new Date().toISOString() };
    if (lsInstance) {
        try {
            const [subStatus, userStatus] = await Promise.all([
                getSubscriptionStatus(lsInstance).catch(() => null),
                getUserStatus(lsInstance).catch(() => null),
            ]);
            metadata.email = subStatus?.user?.email || userStatus?.userStatus?.email || undefined;
            metadata.userName = subStatus?.user?.name || userStatus?.userStatus?.name || undefined;
            metadata.tier = subStatus?.user?.userTier?.name || userStatus?.userStatus?.userTier?.name || undefined;
            metadata.plan = subStatus?.user?.planStatus?.planInfo?.planName || userStatus?.userStatus?.planStatus?.planInfo?.planName || undefined;
        } catch { /* ignore */ }
    }

    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    setActiveProfile(name);
    log.appendLine(`[Profile] ✅ Saved account "${name}" (${metadata.email || 'unknown'})`);
}

// --- Delete profile ---
export function deleteProfile(name: string): void {
    const active = getActiveProfile();
    if (name === active) {
        throw new Error('Cannot delete the active profile. Swap to another first.');
    }
    const dir = path.join(getProfilesDir(), name);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // If profile was in state but folder gone, that's OK — it's cleaned up
}

// --- Add Account flow ---
export async function startAddAccount(log: vscode.OutputChannel): Promise<void> {
    const currentProfile = getActiveProfile();
    if (!currentProfile) {
        throw new Error('No active profile. Save current account first.');
    }

    const exePath = getIdeExePath();
    log.appendLine(`[Profile] Add account: saving "${currentProfile}" → launching fresh IDE`);

    const profilesDir = getProfilesDir();
    const currentDir = path.join(profilesDir, currentProfile);
    fs.mkdirSync(currentDir, { recursive: true });

    // Build: save current folders → launch fresh (no restore phase)
    const moves: Array<{ src: string; dst: string }> = [];
    for (const f of SWAP_FOLDERS) {
        moves.push({ src: f.source(), dst: path.join(currentDir, f.name) });
    }

    // Set state to null (adding mode)
    setActiveProfile(null);

    const script = buildSwapScript({ exePath, moves, restores: [], killJava: true });
    spawnDetachedScript(script, log);

    await new Promise(r => setTimeout(r, 500));

    // Close IDE
    try {
        await runPs(
            `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() } | Out-Null`,
            5000
        );
    } catch { /* OK */ }
}

// --- Cancel Add Account ---
export async function cancelAddAccount(previousProfile: string, log: vscode.OutputChannel): Promise<void> {
    if (!previousProfile) { return; }

    const exePath = getIdeExePath();
    const profilesDir = getProfilesDir();
    const prevDir = path.join(profilesDir, previousProfile);

    // Clean up fresh-login folders, restore previous
    const moves: Array<{ src: string; dst: string }> = [];
    const restores: Array<{ src: string; dst: string }> = [];
    for (const f of SWAP_FOLDERS) {
        // Remove fresh login data
        const freshPath = f.source();
        if (fs.existsSync(freshPath)) {
            // Move to temp for cleanup (script will handle)
            const tmpDest = path.join(os.tmpdir(), 'auto-pilot', `fresh-${f.name}-${Date.now()}`);
            moves.push({ src: freshPath, dst: tmpDest });
        }
        // Restore previous
        restores.push({ src: path.join(prevDir, f.name), dst: f.source() });
    }

    setActiveProfile(previousProfile);

    const script = buildSwapScript({ exePath, moves, restores, killJava: true });
    spawnDetachedScript(script, log);

    await new Promise(r => setTimeout(r, 500));

    try {
        await runPs(
            `Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() } | Out-Null`,
            5000
        );
    } catch { /* OK */ }
}

// --- Auto-onboard: detect current IDE account and save as profile ---
// Triggers when: no profiles yet, OR no active profile (after add-account relaunch)
export async function autoOnboard(lsInstance: LsInstance | null, log: vscode.OutputChannel): Promise<string | null> {
    const profiles = listProfiles();
    const active = getActiveProfile();

    // Skip if already have an active profile
    if (active) { return null; }

    const hasData = SWAP_FOLDERS.some(f => fs.existsSync(f.source()));
    if (!hasData) { return null; }

    let autoName = 'default';
    if (lsInstance) {
        try {
            const [subStatus, userStatus] = await Promise.all([
                getSubscriptionStatus(lsInstance).catch(() => null),
                getUserStatus(lsInstance).catch(() => null),
            ]);
            const email = subStatus?.user?.email || userStatus?.userStatus?.email;
            if (email) {
                autoName = email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 30) || 'default';
            }
        } catch { /* ignore */ }
    }

    const profilesDir = getProfilesDir();
    let finalName = autoName;
    let i = 1;
    while (fs.existsSync(path.join(profilesDir, finalName))) {
        finalName = `${autoName}-${i++}`;
    }

    try {
        await saveCurrentAccount(finalName, lsInstance, log);
        return finalName;
    } catch (err: any) {
        log.appendLine(`[Profile] Auto-onboard failed: ${err.message}`);
        return null;
    }
}

// --- Tree Data Provider (kept for compatibility) ---
export class ProfileTreeProvider implements vscode.TreeDataProvider<ProfileEntry> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProfileEntry | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh(): void { this._onDidChangeTreeData.fire(undefined); }
    getTreeItem(element: ProfileEntry): vscode.TreeItem {
        const active = getActiveProfile();
        const isActive = element.name === active;
        const item = new vscode.TreeItem(`${isActive ? '⭐ ' : ''}${element.name}`, vscode.TreeItemCollapsibleState.None);
        item.description = element.meta?.email || '';
        item.contextValue = isActive ? 'activeProfile' : 'profile';
        return item;
    }
    getChildren(): ProfileEntry[] { return listProfiles(); }
}
