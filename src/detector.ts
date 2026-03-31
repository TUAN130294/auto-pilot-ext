// === LS Detector — find running Antigravity Language Server instances ===
// Ported from Antigravity-Deck detector.js — detect process, find ports via netstat, probe API
import { exec } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import type { LsInstance } from './ls-api';

const platform = os.platform();

interface RawInstance {
    pid: number;
    csrfToken: string;
    workspaceId: string | null;
}

// --- Step 1: Find language_server processes ---
function findLsProcesses(): Promise<RawInstance[]> {
    return new Promise((resolve) => {
        let cmd: string;
        if (platform === 'win32') {
            const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            cmd = `"${ps}" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' } | Select-Object ProcessId, CommandLine | Format-List"`;
        } else {
            cmd = `ps aux | grep -E 'language_server|csrf_token' | grep -v grep`;
        }

        exec(cmd, { timeout: 10000 }, (err, stdout) => {
            if (err || !stdout.trim()) { resolve([]); return; }

            const instances: RawInstance[] = [];
            if (platform === 'win32') {
                const blocks = stdout.split(/\r?\n\r?\n/);
                for (const block of blocks) {
                    if (!block.trim()) { continue; }
                    const pidMatch = block.match(/ProcessId\s*:\s*(\d+)/);
                    const csrfMatch = block.match(/--csrf_token\s+([a-f0-9-]+)/);
                    const wsMatch = block.match(/--workspace_id\s+(\S+)/);
                    if (pidMatch && csrfMatch) {
                        instances.push({
                            pid: parseInt(pidMatch[1], 10),
                            csrfToken: csrfMatch[1],
                            workspaceId: wsMatch ? wsMatch[1] : null,
                        });
                    }
                }
            } else {
                for (const line of stdout.split('\n')) {
                    if (!line.trim()) { continue; }
                    const pidMatch = line.match(/\S+\s+(\d+)/);
                    const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/);
                    const wsMatch = line.match(/--workspace_id\s+(\S+)/);
                    if (pidMatch && csrfMatch) {
                        instances.push({
                            pid: parseInt(pidMatch[1], 10),
                            csrfToken: csrfMatch[1],
                            workspaceId: wsMatch ? wsMatch[1] : null,
                        });
                    }
                }
            }
            resolve(instances);
        });
    });
}

// --- Step 2: Find listening ports for a PID via netstat ---
function detectPorts(pid: number): Promise<number[]> {
    return new Promise((resolve) => {
        const cmd = platform === 'win32' ? 'netstat -ano' : `lsof -iTCP -sTCP:LISTEN -P -n -p ${pid} 2>/dev/null`;
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout.trim()) { resolve([]); return; }
            const ports: number[] = [];
            const pidStr = String(pid);
            for (const line of stdout.split('\n')) {
                if (!line.trim()) { continue; }
                if (platform === 'win32') {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 4 && parts[parts.length - 1] === pidStr) {
                        const addrPort = parts[1];
                        if (addrPort) {
                            const port = parseInt(addrPort.split(':').pop() || '', 10);
                            if (!isNaN(port)) { ports.push(port); }
                        }
                    }
                } else {
                    const cols = line.trim().split(/\s+/);
                    if (cols.length >= 2 && cols[1] === pidStr) {
                        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
                        if (m) { ports.push(parseInt(m[1], 10)); }
                    }
                }
            }
            resolve([...new Set(ports)].sort((a, b) => a - b));
        });
    });
}

// --- Step 3: Probe port with Connect Protocol to find working API ---
function connectPost(url: string, headers: Record<string, string>, body: string, timeoutMs = 3000): Promise<{ ok: boolean; status: number }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;
        const opts: http.RequestOptions = {
            hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
            timeout: timeoutMs,
        };
        if (isHttps) { (opts as https.RequestOptions).rejectUnauthorized = false; }

        const req = transport.request(opts, (res) => {
            res.resume(); // drain
            resolve({ ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300, status: res.statusCode || 0 });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

async function findApiPort(ports: number[], csrfToken: string): Promise<{ port: number; useTls: boolean } | null> {
    const headers = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrfToken,
    };
    const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

    const probes = [
        { url: (p: number) => `https://127.0.0.1:${p}${endpoint}`, tls: true },
        { url: (p: number) => `http://localhost:${p}${endpoint}`, tls: false },
        { url: (p: number) => `https://[::1]:${p}${endpoint}`, tls: true },
        { url: (p: number) => `http://[::1]:${p}${endpoint}`, tls: false },
    ];

    for (const port of ports) {
        for (const probe of probes) {
            try {
                const res = await connectPost(probe.url(port), headers, '{}');
                if (res.ok) {
                    return { port, useTls: probe.tls };
                }
            } catch { /* skip */ }
        }
    }
    return null;
}

// --- Main: full detection pipeline ---
export async function detectLsInstances(): Promise<LsInstance[]> {
    const rawInstances = await findLsProcesses();
    if (rawInstances.length === 0) { return []; }

    const results: LsInstance[] = [];
    for (const raw of rawInstances) {
        const ports = await detectPorts(raw.pid);
        if (ports.length === 0) { continue; }

        const found = await findApiPort(ports, raw.csrfToken);
        if (found) {
            results.push({
                pid: raw.pid,
                port: found.port,
                csrfToken: raw.csrfToken,
                useTls: found.useTls,
                workspaceId: raw.workspaceId || undefined,
            });
        }
    }

    return results;
}
