// === Danger Detector — flags risky commands before auto-accept ===
// Shows human-friendly warnings for non-tech users

export interface DangerResult {
    isDangerous: boolean;
    level: 'critical' | 'warning' | 'safe';
    command: string;           // the raw command
    explanation: string;       // plain-language explanation for non-tech users
    category: string;          // short category label
}

interface DangerPattern {
    pattern: RegExp;
    level: 'critical' | 'warning';
    category: string;
    explain: (cmd: string, match: RegExpMatchArray) => string;
}

// --- Danger patterns with human-friendly explanations ---
const PATTERNS: DangerPattern[] = [
    // === CRITICAL: Database destruction ===
    {
        pattern: /\bDROP\s+(DATABASE|SCHEMA)\s+(\w+)/i,
        level: 'critical',
        category: '🗄️ Xóa Database',
        explain: (_cmd, m) => `Lệnh này sẽ XÓA TOÀN BỘ database "${m[2]}". Tất cả dữ liệu sẽ mất vĩnh viễn!`,
    },
    {
        pattern: /\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?(\w+)/i,
        level: 'critical',
        category: '🗄️ Xóa bảng dữ liệu',
        explain: (_cmd, m) => `Lệnh này sẽ XÓA bảng "${m[2]}" trong database. Toàn bộ dữ liệu trong bảng sẽ bị mất!`,
    },
    {
        pattern: /\bTRUNCATE\s+TABLE\s+(\w+)/i,
        level: 'critical',
        category: '🗄️ Xóa sạch dữ liệu',
        explain: (_cmd, m) => `Lệnh này sẽ XÓA TẤT CẢ dữ liệu trong bảng "${m[1]}" (giữ lại bảng rỗng).`,
    },
    {
        pattern: /\bDELETE\s+FROM\s+(\w+)(?!\s+WHERE)/i,
        level: 'critical',
        category: '🗄️ Xóa toàn bộ dữ liệu',
        explain: (_cmd, m) => `Lệnh này sẽ XÓA TẤT CẢ hàng trong bảng "${m[1]}" vì không có điều kiện WHERE!`,
    },
    {
        pattern: /\bALTER\s+TABLE\s+(\w+)\s+DROP\s+(COLUMN\s+)?(\w+)/i,
        level: 'warning',
        category: '🗄️ Xóa cột dữ liệu',
        explain: (_cmd, m) => `Lệnh này sẽ xóa cột "${m[3]}" khỏi bảng "${m[1]}". Dữ liệu trong cột sẽ mất.`,
    },

    // === CRITICAL: File/folder deletion (broad scope) ===
    {
        pattern: /\brm\s+(-[rfRF]+\s+)?[/~]\S*/,
        level: 'critical',
        category: '📁 Xóa file/folder hệ thống',
        explain: (cmd) => `Lệnh này sẽ XÓA file/folder ngoài thư mục dự án: "${extractPath(cmd)}"`,
    },
    {
        pattern: /\brm\s+-[rfRF]*\s+\.\.\//,
        level: 'critical',
        category: '📁 Xóa folder cha',
        explain: (cmd) => `Lệnh này sẽ XÓA file/folder BÊN NGOÀI dự án hiện tại: "${extractPath(cmd)}"`,
    },
    {
        pattern: /\bRemove-Item\s+.*(-Recurse|-Force)/i,
        level: 'warning',
        category: '📁 Xóa file (PowerShell)',
        explain: (cmd) => `Lệnh PowerShell này sẽ xóa file/folder: "${extractPsPath(cmd)}"`,
    },
    {
        pattern: /\brmdir\s+\/[sS]\s+/,
        level: 'critical',
        category: '📁 Xóa folder (Windows)',
        explain: (cmd) => `Lệnh này sẽ XÓA TOÀN BỘ folder và nội dung bên trong: "${extractPath(cmd)}"`,
    },
    {
        pattern: /\bdel\s+\/[fFsS]\s+/,
        level: 'warning',
        category: '📁 Xóa file (Windows)',
        explain: (cmd) => `Lệnh Windows này sẽ xóa file: "${extractPath(cmd)}"`,
    },

    // === CRITICAL: System-level commands ===
    {
        pattern: /\bformat\s+[a-zA-Z]:/i,
        level: 'critical',
        category: '💻 Format ổ đĩa',
        explain: (cmd) => `Lệnh này sẽ FORMAT (xóa sạch) ổ đĩa! Tất cả dữ liệu trên ổ sẽ mất!`,
    },
    {
        pattern: /\bshutdown\s+/i,
        level: 'warning',
        category: '💻 Tắt máy',
        explain: () => `Lệnh này sẽ TẮT hoặc KHỞI ĐỘNG LẠI máy tính.`,
    },
    {
        pattern: /\bkill\s+(-9\s+)?-1\b/,
        level: 'critical',
        category: '💻 Kill tất cả process',
        explain: () => `Lệnh này sẽ DỪNG TẤT CẢ chương trình đang chạy trên máy!`,
    },

    // === WARNING: Git destructive ===
    {
        pattern: /\bgit\s+push\s+.*--force/,
        level: 'warning',
        category: '🔀 Git Force Push',
        explain: () => `Lệnh này sẽ GHI ĐÈ code trên server. Code của đồng nghiệp có thể bị mất!`,
    },
    {
        pattern: /\bgit\s+reset\s+--hard/,
        level: 'warning',
        category: '🔀 Git Reset Hard',
        explain: () => `Lệnh này sẽ XÓA tất cả thay đổi code chưa commit. Không thể khôi phục!`,
    },
    {
        pattern: /\bgit\s+clean\s+-[fdxFDX]+/,
        level: 'warning',
        category: '🔀 Git Clean',
        explain: () => `Lệnh này sẽ XÓA các file chưa được theo dõi bởi git.`,
    },

    // === WARNING: Package/deploy ===
    {
        pattern: /\bnpm\s+publish\b/,
        level: 'warning',
        category: '📦 Publish package',
        explain: () => `Lệnh này sẽ PUBLISH package lên npm registry công khai.`,
    },
    {
        pattern: /\bcurl\s+.*\|\s*(sh|bash)\b/,
        level: 'critical',
        category: '⚠️ Chạy script từ internet',
        explain: () => `Lệnh này tải và CHẠY NGAY script từ internet. Có thể chứa mã độc!`,
    },
    {
        pattern: /\bwget\s+.*\|\s*(sh|bash)\b/,
        level: 'critical',
        category: '⚠️ Chạy script từ internet',
        explain: () => `Lệnh này tải và CHẠY NGAY script từ internet. Có thể chứa mã độc!`,
    },

    // === WARNING: Environment/credentials ===
    {
        pattern: /\bcat\s+.*\.(env|pem|key|secret)\b/,
        level: 'warning',
        category: '🔑 Đọc file bí mật',
        explain: (cmd) => `Lệnh này sẽ đọc file chứa thông tin nhạy cảm (mật khẩu, API key...).`,
    },
    {
        pattern: /\bchmod\s+777\b/,
        level: 'warning',
        category: '🔓 Mở quyền truy cập',
        explain: () => `Lệnh này sẽ cho phép BẤT KỲ AI cũng có thể đọc/ghi/chạy file này.`,
    },
];

// Helper: extract path from rm/del commands
function extractPath(cmd: string): string {
    const parts = cmd.split(/\s+/);
    // Find the first argument that looks like a path (not a flag)
    for (let i = 1; i < parts.length; i++) {
        if (!parts[i].startsWith('-') && parts[i].length > 0) {
            return parts[i];
        }
    }
    return cmd;
}

function extractPsPath(cmd: string): string {
    const match = cmd.match(/Remove-Item\s+["']?([^"'\s]+)/i);
    return match?.[1] || cmd;
}

/**
 * Check a command string for dangerous patterns.
 * Returns DangerResult with human-friendly explanation.
 */
export function detectDanger(command: string): DangerResult {
    if (!command || !command.trim()) {
        return { isDangerous: false, level: 'safe', command, explanation: '', category: '' };
    }

    for (const p of PATTERNS) {
        const match = command.match(p.pattern);
        if (match) {
            return {
                isDangerous: true,
                level: p.level,
                command,
                explanation: p.explain(command, match),
                category: p.category,
            };
        }
    }

    return { isDangerous: false, level: 'safe', command, explanation: '', category: '' };
}
