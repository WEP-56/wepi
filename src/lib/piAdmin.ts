/**
 * Pi 管理能力的 IPC 封装：MCP / 技能 / 扩展 / Pi 运行时。
 *
 * 全部命令都要求桌面运行时（Tauri）；浏览器预览下调用会直接抛错，
 * 页面层用 `isDesktopRuntime()` 先行降级。
 */
import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './piRpc';

/* ---------------- MCP ---------------- */

export interface McpLayerInfo {
  kind: string;
  path: string;
  exists: boolean;
  writable: boolean;
}

export interface McpListItem {
  name: string;
  definition: McpServerDefinition;
  originPath: string;
  overridePath: string;
  ownedByWritable: boolean;
}

export interface McpServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  timeout?: number;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  description?: string;
  disabled?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: 'cimd';
  authServerMetadataUrl?: string;
}

export interface McpSnapshot {
  layers: McpLayerInfo[];
  writablePath: string;
  writableRaw: string;
  writableError?: string | null;
  writableFile: { mcpServers?: Record<string, McpServerDefinition>; [key: string]: unknown };
  servers: McpListItem[];
}

export interface McpImportCandidate {
  name: string;
  sourceLabel: string;
  definition: McpServerDefinition | null;
  transport?: string | null;
  warnings: string[];
  blocker?: string | null;
  importable: boolean;
}

export interface McpImportScan {
  sources: { label: string; path: string; exists: boolean; error?: string; count?: number }[];
  candidates: McpImportCandidate[];
}

export interface McpProbeResult {
  ok: boolean;
  transport?: string;
  detail?: string;
  error?: string;
}

export const mcpApi = {
  snapshot: () => invoke<McpSnapshot>('pi_mcp_snapshot'),
  save: (content: unknown) => invoke<void>('pi_mcp_save', { content }),
  importScan: () => invoke<McpImportScan>('pi_mcp_import_scan'),
  importApply: (entries: [string, McpServerDefinition][], overwrite: boolean) =>
    invoke<{ imported: number; skipped: string[] }>('pi_mcp_import_apply', { entries, overwrite }),
  probe: (definition: McpServerDefinition) => invoke<McpProbeResult>('pi_mcp_probe', { definition }),
  login: (server: string) => invoke<string>('pi_mcp_login', { server }),
};

/* ---------------- 技能 ---------------- */

export interface SkillLocation {
  id: string;
  label: string;
  path: string;
  rootMarkdownEnabled: boolean;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  dir: string;
  sourceId: string;
  sourceLabel: string;
  type: 'directory' | 'markdown';
  userOnly: boolean;
  enabled: boolean;
  warnings: string[];
}

export interface SkillListResult {
  locations: SkillLocation[];
  skills: SkillSummary[];
}

export interface SkillStoreItem {
  slug: string;
  name: string;
  description: string;
  installs: number;
  source: string;
}

export const skillsApi = {
  list: () => invoke<SkillListResult>('pi_skills_list'),
  read: (path: string) => invoke<{ content: string; skill: SkillSummary }>('pi_skills_read', { path }),
  create: (locationId: string, name: string, description: string, content?: string) =>
    invoke<SkillSummary>('pi_skills_create', { locationId, name, description, content: content ?? null }),
  write: (path: string, content: string) => invoke<void>('pi_skills_write', { path, content }),
  setUserOnly: (path: string, userOnly: boolean) => invoke<SkillSummary>('pi_skills_set_user_only', { path, userOnly }),
  rename: (path: string, newName: string) => invoke<SkillSummary>('pi_skills_rename', { path, newName }),
  remove: (path: string) => invoke<void>('pi_skills_delete', { path }),
  storeSearch: (query: string, limit = 50) =>
    invoke<{ query: string; total: number; items: SkillStoreItem[] }>('pi_skills_store_search', { query, limit }),
  storeInstall: (slug: string) =>
    invoke<{ success: boolean; slug: string; output: string }>('pi_skills_store_install', { slug }),
};

/* ---------------- 扩展 ---------------- */

export interface ExtensionSummary {
  id: string;
  source: string;
  path?: string;
  scope: string;
  filtered?: boolean;
  builtIn?: boolean;
  enabled: boolean;
  currentVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
}

export interface CatalogItem {
  name: string;
  description: string;
  author?: string;
  types: string[];
  downloadsPerMonth?: number;
  publishedAt?: number;
  npmUrl?: string;
  githubUrl?: string;
  installSource: string;
  pageUrl: string;
}

export interface CatalogResult {
  items: CatalogItem[];
  page: number;
  pageSize: number;
  total: number;
  lastPage: number;
  fromCache?: boolean;
}

export const extensionsApi = {
  list: (forceRefresh = false) => invoke<{ extensions: ExtensionSummary[]; raw: string }>('pi_extensions_list', { forceRefresh }),
  install: (source: string) => invoke<{ success: boolean; output: string }>('pi_extensions_install', { source }),
  uninstall: (source: string) => invoke<void>('pi_extensions_uninstall', { source }),
  setEnabled: (source: string, enabled: boolean) => invoke<void>('pi_extensions_set_enabled', { source, enabled }),
  updateOne: (source: string) => invoke<{ success: boolean; command: string; output: string }>('pi_extensions_update_one', { source }),
  updateAll: () => invoke<{ success: boolean; command: string; output: string }>('pi_extensions_update_all'),
  catalog: (options: { page?: number; query?: string; kind?: string; sort?: string; refresh?: boolean } = {}) =>
    invoke<CatalogResult>('pi_extensions_catalog', {
      page: options.page ?? 1,
      query: options.query ?? '',
      kind: options.kind ?? '',
      sort: options.sort ?? 'downloads',
      refresh: options.refresh ?? false,
    }),
};

/* ---------------- Pi 运行时 ---------------- */

export interface PiInstallation {
  source: string;
  path: string;
  version?: string | null;
  missing?: boolean;
  isNewest?: boolean;
}

export interface PiUpdateCheck {
  currentVersion?: string | null;
  latestVersion?: string | null;
  hasUpdate: boolean;
  error?: string;
}

export interface PiUpdateResult {
  command: string;
  output: string;
  updated: boolean;
}

export interface DiagnosticsResult {
  checks: { name: string; ok: boolean; purpose: string }[];
  agentDir: string;
  agentDirExists: boolean;
  mcpConfigExists: boolean;
  modelsConfigExists: boolean;
  skillsDirExists: boolean;
}

export const runtimeApi = {
  installations: () => invoke<{ installations: PiInstallation[] }>('pi_runtime_installations'),
  addPath: (path: string) => invoke<{ path: string; version: string }>('pi_runtime_add_path', { path }),
  removePath: (path: string) => invoke<void>('pi_runtime_remove_path', { path }),
  checkUpdate: () => invoke<PiUpdateCheck>('pi_runtime_check_update'),
  updatePi: () => invoke<PiUpdateResult>('pi_runtime_update_pi'),
  diagnostics: () => invoke<DiagnosticsResult>('pi_runtime_diagnostics'),
};

/** 统一的错误文案提取：IPC 错误可能是 string 或 Error。 */
export function adminErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/* ---------------- 系统打开能力 ---------------- */

export const shellApi = {
  /** 资源管理器打开（文件路径时高亮该文件） */
  showInExplorer: (path: string) => invoke<void>('shell_show_in_explorer', { path }),
  /** 系统默认应用打开文件 / 默认浏览器打开 URL */
  openWithSystem: (target: string) => invoke<void>('shell_open_with_system', { target }),
  /** VS Code 打开 */
  openInVscode: (path: string) => invoke<void>('shell_open_in_vscode', { path }),
  /** 能力探测（当前只有 vscode 可用性） */
  capabilities: () => invoke<{ vscodeAvailable: boolean }>('shell_open_capabilities'),
};

/** 打开外部链接的统一入口：桌面走系统默认浏览器，浏览器预览退回 window.open。 */
export function openExternal(url: string, onToast?: (message: string) => void): void {
  if (isDesktopRuntime()) {
    shellApi.openWithSystem(url).catch((error) => onToast?.(adminErrorMessage(error, '无法打开链接')));
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* ---------------- 关闭行为 / 托盘 ---------------- */

export type CloseBehavior = 'quit' | 'tray';

export const closeBehaviorApi = {
  get: () => invoke<{ behavior: CloseBehavior }>('close_behavior_get'),
  set: (behavior: CloseBehavior) => invoke<{ behavior: CloseBehavior }>('close_behavior_set', { behavior }),
};

/* ---------------- 应用更新检查（GitHub Release tag） ---------------- */

export interface AppUpdateCheck {
  currentVersion: string;
  latestVersion?: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  notes?: string;
  error?: string;
}

export const updateApi = {
  /** 检查最新 release；不做自动更新，用户自行前往 release 页下载。 */
  check: () => invoke<AppUpdateCheck>('app_update_check'),
};

/** 浏览器预览模式下的提示常量，页面据此显示降级 UI。 */
export const DESKTOP_ONLY_HINT = '此功能需要桌面版运行';

/** 便捷守卫：非桌面运行时时返回 null 而不是抛错，页面可按需忽略。 */
export async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!isDesktopRuntime()) return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}
