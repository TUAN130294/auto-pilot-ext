// === LS API Client — Connect Protocol for Antigravity Language Server ===
import * as http from 'http';
import * as https from 'https';

export interface LsInstance {
    pid: number;
    port: number;
    csrfToken: string;
    useTls: boolean;
    tls?: boolean; // alias from detector
    workspaceId?: string;
}

interface ApiResponse {
    ok: boolean;
    status: number;
    data: string;
}

function makeRequest(inst: LsInstance, method: string, body: Record<string, unknown> = {}, timeout = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const protocol = inst.useTls ? 'https' : 'http';
        const host = inst.useTls ? '127.0.0.1' : 'localhost';
        const data = JSON.stringify(body);
        const transport = inst.useTls ? https : http;

        const req = transport.request({
            hostname: host,
            port: inst.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': inst.csrfToken,
                'Content-Length': Buffer.byteLength(data),
            },
            timeout,
            rejectUnauthorized: false,
        } as https.RequestOptions, (res) => {
            const chunks: string[] = [];
            res.on('data', (c: Buffer) => chunks.push(c.toString()));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`API ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(chunks.join('')));
                } catch (e) {
                    reject(new Error(`API parse error: ${(e as Error).message}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
        req.write(data);
        req.end();
    });
}

function fireAndForget(inst: LsInstance, method: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
    return new Promise((resolve) => {
        const host = inst.useTls ? '127.0.0.1' : 'localhost';
        const data = JSON.stringify(body);
        const transport = inst.useTls ? https : http;

        const req = transport.request({
            hostname: host,
            port: inst.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': inst.csrfToken,
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 5000,
            rejectUnauthorized: false,
        } as https.RequestOptions, (res) => {
            const chunks: string[] = [];
            res.on('data', (c: Buffer) => chunks.push(c.toString()));
            res.on('end', () => resolve({ ok: (res.statusCode || 500) < 400, status: res.statusCode || 0, data: chunks.join('') }));
        });
        // Connection close/reset = LS processed the request and closed the stream → success
        req.on('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'ECONNRESET' || e.message.includes('socket hang up')) {
                resolve({ ok: true, status: 0, data: 'stream_closed' });
            } else {
                resolve({ ok: false, status: 0, data: e.message });
            }
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: 'timeout' }); });
        req.write(data);
        req.end();
    });
}

// --- Public API wrappers ---

export interface TrajectorySummary {
    trajectoryId: string;
    status: string;
    stepCount: number;
    summary?: string;
}

export interface TrajectoryStep {
    type?: string;
    status?: string | number;
    runCommand?: { commandLine?: string; command?: string };
    codeAction?: Record<string, unknown>;
    viewFile?: Record<string, unknown>;
    listDirectory?: Record<string, unknown>;
    sendCommandInput?: { input?: string };
    openBrowserUrl?: { url?: string };
    metadata?: { toolCall?: { argumentsJson?: string } };
    [key: string]: unknown;
}

export async function getAllTrajectories(inst: LsInstance): Promise<Record<string, TrajectorySummary>> {
    const result = await makeRequest(inst, 'GetAllCascadeTrajectories') as { trajectorySummaries?: Record<string, TrajectorySummary> };
    return result?.trajectorySummaries || {};
}

export async function getTrajectorySteps(inst: LsInstance, cascadeId: string, startIndex: number, endIndex: number): Promise<TrajectoryStep[]> {
    const result = await makeRequest(inst, 'GetCascadeTrajectorySteps', { cascadeId, startIndex, endIndex }) as { steps?: TrajectoryStep[] };
    return result?.steps || [];
}

export async function sendInteraction(inst: LsInstance, cascadeId: string, body: Record<string, unknown>): Promise<boolean> {
    // Body should be { cascadeId, interaction: { trajectoryId, stepIndex, ...payload } }
    const result = await fireAndForget(inst, 'HandleCascadeUserInteraction', body);
    return result.ok;
}

export async function getSubscriptionStatus(inst: LsInstance): Promise<{ user?: { email?: string; name?: string; userTier?: { name?: string }; planStatus?: { planInfo?: { planName?: string } } } }> {
    return await makeRequest(inst, 'GetSubscriptionStatus', {}) as any;
}

export async function getUserStatus(inst: LsInstance): Promise<{ userStatus?: { email?: string; name?: string; userTier?: { name?: string }; planStatus?: { planInfo?: { planName?: string } } } }> {
    return await makeRequest(inst, 'GetUserStatus', {}) as any;
}

/**
 * Send a "Continue" message to a finished cascade to resume AI work.
 * Uses AddCascadeTurn to inject a new user turn into the existing cascade.
 */
export async function sendContinueMessage(inst: LsInstance, cascadeId: string, workspaceId?: string): Promise<boolean> {
    const body: Record<string, unknown> = {
        cascadeId,
        newUserTurnParams: {
            userMessage: 'Continue',
        },
    };
    if (workspaceId) {
        body.workspaceId = workspaceId;
    }
    const result = await fireAndForget(inst, 'AddCascadeTurn', body);
    return result.ok;
}
