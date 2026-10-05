/**
 * WEPI Security Gate Extension
 *
 * 安全门执行器：按 WEPI 桌面端写入的策略快照（WEPI_SECURITY_CONFIG 指向的 JSON）
 * 在 tool_call 事件上执行拦截/确认。
 *
 * 设计约束（对齐 PiDeck pi-deck-security-gate）：
 * - 本文件必须自包含：只能依赖 @earendil-works/pi-coding-agent 类型与 node 内置模块，
 *   不允许 import WEPI 源码（扩展在 pi 进程内加载，不共享打包产物）。
 * - 与宿主的契约 = 策略快照 schema（Rust 侧 wepi_security::SecurityPolicySnapshot）。
 *   schemaVersion 不匹配时保守降级：enabled=false / 快照不可读 → 放行。
 * - 运行时热更新：每次 tool_call 前 stat 快照文件，mtime 变化即重读（2s 节流），
 *   WEPI 切换会话等级无需重启 agent。
 *
 * 动作语义（与 Rust 侧 wepi_security 保持一致）：
 * - 工具动作：level.toolActions[tool] ?? level.defaultAction
 * - 危险 bash 命令（命中 denyBashPatterns）：
 *   toolActions.bash === "allow" → 放行；defaultAction === "deny" → 直接拒绝；
 *   其余 → 弹窗确认（先确认再放行）。
 * - 文件访问：denyDirs 黑名单 > 敏感文件保护 > pathPolicy 目录边界，命中即拒绝。
 * - 只管控内置工具（read/write/edit/bash/grep/find/ls），其它自定义工具
 *   （todo / web_search 等）不受影响，避免破坏用户其它扩展。
 *
 * 审批走 pi 原生 RPC Extension UI 协议：ctx.ui.confirm() 在 RPC 模式下变成
 * extension_ui_request，WEPI 桌面端渲染审批卡并回 extension_ui_response。
 * 带 30 秒超时（pi 侧到期自动结算为 false = 拒绝，fail-safe）。
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// ── 快照 schema（与 Rust 侧 wepi_security.rs 对齐；扩展侧自包含副本） ──

type SecurityAction = "allow" | "ask" | "deny";
type SecurityPathPolicy = "unrestricted" | "workspace" | "custom";

type SecurityLevelConfig = {
	id: string;
	name: string;
	description: string;
	builtin?: boolean;
	toolActions: Partial<Record<string, SecurityAction>>;
	denyBashPatterns: string[];
	pathPolicy: SecurityPathPolicy;
	customAllowDirs: string[];
	denyDirs: string[];
	protectSensitivePaths: boolean;
	defaultAction: SecurityAction;
};

type SecurityPolicySnapshot = {
	schemaVersion: number;
	enabled: boolean;
	defaultLevelId: string;
	levels: SecurityLevelConfig[];
	sessionLevels: Record<string, string>;
};

// ── 常量 ──

const SCHEMA_VERSION = 1;
/** 受管控的内置工具（其它自定义工具一律放行） */
const MANAGED_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
/** 敏感路径模式（与 Rust 侧 SENSITIVE_PATH_PATTERNS 对齐） */
const SENSITIVE_PATH_PATTERNS = [
	"(^|[\\\\/])\\.env([.$]|$)",
	"(^|[\\\\/])\\.git([\\\\/]|$)",
	"(^|[\\\\/])(id_rsa|id_ed25519|id_ecdsa)(\\.pub)?$",
	"(^|[\\\\/])\\.(npmrc|yarnrc|pnpm-workspace)([.$]|$)",
	"(\\.pem|\\.key|\\.p12)$",
];
/** 审批选项文案（渲染层响应按选项字符串原样回传，这里的字面值就是契约） */
const UI_ALLOW = "允许执行";
const UI_DENY = "拒绝";

// ── 快照加载（带 mtime 热更新） ──

let snapshot: SecurityPolicySnapshot | null = null;
let snapshotPath = "";
let sessionId = "";
let lastLoadedAt = 0;
let lastLoadedMtime = 0;
/** 节流窗口：快照文件小，stat 每 2s 最多一次，避免高频工具调用时反复读盘 */
const RELOAD_THROTTLE_MS = 2000;

function loadSnapshot(): SecurityPolicySnapshot | null {
	const now = Date.now();
	try {
		if (!snapshotPath || !existsSync(snapshotPath)) {
			snapshot = null;
			return null;
		}
		const mtime = statSync(snapshotPath).mtimeMs;
		if (snapshot && mtime === lastLoadedMtime && now - lastLoadedAt < RELOAD_THROTTLE_MS) {
			return snapshot;
		}
		lastLoadedAt = now;
		lastLoadedMtime = mtime;
		const raw = readFileSync(snapshotPath, "utf8");
		const parsed = JSON.parse(raw) as SecurityPolicySnapshot;
		if (parsed.schemaVersion !== SCHEMA_VERSION) {
			// schema 升级：旧快照不再可信，fail-safe 放行（配置语义由宿主迁移保证）
			snapshot = null;
			return null;
		}
		snapshot = parsed;
		return snapshot;
	} catch {
		snapshot = null;
		return null;
	}
}

// ── 纯规则求值（与 Rust 侧 wepi_security.rs 语义一致） ──

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInsideRoot(target: string, root: string): boolean {
	const t = normalizePath(target).toLowerCase();
	const r = normalizePath(root).toLowerCase();
	if (!r || r === "/") return true;
	if (t === r) return true;
	return t.startsWith(r + "/");
}

function matchesSensitivePath(filePath: string): boolean {
	const normalized = normalizePath(filePath);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => {
		try {
			return new RegExp(pattern).test(normalized);
		} catch {
			return false;
		}
	});
}

function resolveLevel(config: SecurityPolicySnapshot, levelId: string): SecurityLevelConfig | null {
	return (
		config.levels.find((level) => level.id === levelId) ??
		config.levels.find((level) => level.id === "standard") ??
		config.levels[0] ??
		null
	);
}

/** 文件访问边界求值：命中黑名单/敏感/越界 → deny；否则 null（交给工具动作决定） */
function evaluatePathAction(
	level: SecurityLevelConfig,
	filePath: string,
	cwd: string,
): SecurityAction | null {
	for (const dir of level.denyDirs) {
		if (isPathInsideRoot(filePath, dir)) return "deny";
	}
	if (level.protectSensitivePaths && matchesSensitivePath(filePath)) return "deny";
	if (level.pathPolicy === "unrestricted") return null;
	if (cwd && isPathInsideRoot(filePath, cwd)) return null;
	if (level.pathPolicy === "custom") {
		for (const dir of level.customAllowDirs) {
			if (isPathInsideRoot(filePath, dir)) return null;
		}
	}
	return "deny";
}

/** bash 危险命令求值：命中返回 true */
function matchesBashDeny(level: SecurityLevelConfig, command: string): boolean {
	return level.denyBashPatterns.some((pattern) => {
		try {
			return new RegExp(pattern).test(command);
		} catch {
			return false;
		}
	});
}

/** 计算 bash 命令最终动作 */
function bashAction(level: SecurityLevelConfig, command: string): SecurityAction {
	const dangerous = matchesBashDeny(level, command);
	const toolAction = level.toolActions["bash"] ?? level.defaultAction;
	if (!dangerous) return toolAction;
	// 危险命令：显式放行 bash → 放行；严格兜底(deny) → 直接拒绝；其余 → 先确认
	if (toolAction === "allow") return "allow";
	if (level.defaultAction === "deny") return "deny";
	return "ask";
}

/** 计算文件工具最终动作：路径边界优先，其次工具动作 */
function fileToolAction(
	level: SecurityLevelConfig,
	tool: string,
	filePath: string | undefined,
	cwd: string,
): SecurityAction {
	if (filePath) {
		const pathAction = evaluatePathAction(level, filePath, cwd);
		if (pathAction) return pathAction;
	}
	return level.toolActions[tool] ?? level.defaultAction;
}

/**
 * 从工具入参中提取文件路径（read/write/edit 有路径字段；grep/find/ls 可选 path）。
 *
 * pi 各工具的文件字段名不一致（read 与 write/edit 用 filePath，grep/find/ls 用
 * path）：这里做白名单 + 多字段兜底，漏提取 = 目录边界策略被跳过。
 */
function extractFilePath(tool: string, input: Record<string, unknown>): string | undefined {
	const firstString = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = input[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
		return undefined;
	};
	switch (tool) {
		case "read":
			return firstString("filePath", "path", "file");
		case "write":
		case "edit":
			return firstString("filePath", "path", "file");
		case "grep":
		case "find":
		case "ls":
			return firstString("path", "directory", "filePath");
		default:
			return undefined;
	}
}

/** 绝对路径化：相对路径基于 cwd 解析（与 pi 工具语义一致） */
function absolutize(p: string, cwd: string): string {
	if (isAbsolute(p)) return p;
	return resolve(cwd, p);
}

// ── UI 确认（原生 RPC Extension UI：ctx.ui.select → extension_ui_request） ──

/**
 * WEPI 桌面端识别安全确认请求的标题前缀：渲染层据此渲染专用审批卡
 * （工具名 + 等级 + 详情 + 允许/拒绝），而不是当成普通 select。
 * 前缀后跟 JSON 负载 {tool, level, detail}。
 */
const SECURITY_CONFIRM_MARKER = "[WEPI_SECURITY_CONFIRM]";

/**
 * 弹窗确认。RPC 模式下取消/无 UI/超时一律拒绝（fail-safe）。
 *
 * 与 PiDeck security-gate 同款形态：ctx.ui.select(title, [允许, 拒绝])。
 * 用 select 而非 confirm 的理由：PiDeck 已在真实 RPC 链路上验证过
 * select 两参形式（响应经 extension_ui_response.value 回传选项字符串），
 * confirm 的三参 options 签名未被验证，不走未验证路径。
 * 30 秒超时由 WEPI 渲染层计时，超时未点按拒绝处理（发送 cancelled）。
 */
async function confirmAction(
	ctx: ExtensionContext,
	tool: string,
	detail: string,
	levelName: string,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	try {
		const payload = JSON.stringify({
			tool,
			level: levelName,
			detail: detail.slice(0, 2000),
		});
		const choice = await ctx.ui.select(`${SECURITY_CONFIRM_MARKER}${payload}`, [
			UI_ALLOW,
			UI_DENY,
		]);
		return choice === UI_ALLOW;
	} catch {
		// UI 通道异常（桌面端已关窗 / 会话终止）→ 拒绝，宁可错杀不可放过
		return false;
	}
}

// ── 系统提示注入：让 agent 提前知道边界，减少无效尝试 ──

function buildSecurityHint(level: SecurityLevelConfig): string | undefined {
	if (level.id === "off") return undefined;
	const lines: string[] = [
		`当前会话启用了 WEPI 安全管理（等级: ${level.name}）。`,
	];
	if (level.pathPolicy === "workspace" || level.pathPolicy === "custom") {
		lines.push(
			`文件读写仅限工作目录${level.pathPolicy === "custom" ? "及显式允许的目录" : ""}，工作目录之外的文件访问会被拒绝。`,
		);
	}
	if (level.denyBashPatterns.length > 0) {
		lines.push("部分危险命令（如 rm -rf、chmod 777、sudo、git push 等）会被拦截或要求用户确认。");
	}
	if (level.protectSensitivePaths) {
		lines.push(".env / .git / 密钥文件等敏感路径受保护，读写会被拒绝。");
	}
	return lines.join("\n");
}

// ── 入口 ──

export default async function securityGateExtension(pi: ExtensionAPI) {
	snapshotPath = process.env.WEPI_SECURITY_CONFIG ?? "";
	sessionId = process.env.WEPI_SESSION_ID ?? "";

	if (!snapshotPath) {
		// WEPI 未注入配置路径（独立 CLI 运行）：完全放行
		return;
	}

	pi.on("before_agent_start", (_event, ctx) => {
		const config = loadSnapshot();
		if (!config?.enabled) return undefined;
		const levelId = config.sessionLevels[sessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level) return undefined;
		const hint = buildSecurityHint(level);
		if (!hint) return undefined;
		return { systemPrompt: (ctx.getSystemPrompt?.() ?? "") + "\n\n" + hint };
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		// 热更新：快照 mtime 变化即重读（≤2s），等级切换无需重启
		const config = loadSnapshot();
		if (!config?.enabled) return undefined;

		const tool = event.toolName;
		// 只管控内置工具；自定义工具（todo 等）放行，避免破坏用户扩展
		if (!MANAGED_TOOLS.has(tool)) return undefined;

		const levelId = config.sessionLevels[sessionId] ?? config.defaultLevelId;
		const level = resolveLevel(config, levelId);
		if (!level || level.id === "off") return undefined;

		const input = event.input as Record<string, unknown>;
		let action: SecurityAction;

		if (tool === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			action = bashAction(level, command);
		} else {
			const filePath = extractFilePath(tool, input);
			action = fileToolAction(
				level,
				tool,
				filePath ? absolutize(filePath, ctx.cwd) : undefined,
				ctx.cwd,
			);
		}

		if (action === "allow") return undefined;

		const target =
			tool === "bash"
				? typeof input.command === "string"
					? input.command
					: ""
				: typeof input.filePath === "string" || typeof input.path === "string"
					? String(input.filePath ?? input.path)
					: "";

		if (action === "deny") {
			return {
				block: true,
				reason: `[安全管理·${level.name}] ${tool} 调用被拒绝${target ? `: ${target}` : ""}`,
			};
		}

		// action === "ask"：弹窗确认
		const allowed = await confirmAction(ctx, tool, target, level.name);
		if (allowed) return undefined;
		return {
			block: true,
			reason: `[安全管理·${level.name}] ${tool} 调用已被用户拒绝${target ? `: ${target}` : ""}`,
		};
	});
}
