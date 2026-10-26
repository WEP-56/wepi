import type { TurnBlock } from '../data';

/**
 * `show` 工具的参数解析与卡片数据模型。
 *
 * 为什么前端要重新解析：Pi 的 toolResult 只落 content 文本，不落 details
 * （见 piSession.ts），所以历史会话里拿不到后端返回的结构化目标。工具参数
 * 本身会随 toolCall 一起保存，是唯一可靠的来源；后端只负责校验它们。
 */

export type ShowKind = 'web' | 'text' | 'image' | 'pdf' | 'office' | 'file';

export interface ShowTarget {
  kind: ShowKind;
  /** 本地文件绝对路径（相对路径已按会话 cwd 解析） */
  path?: string;
  /** 网页地址 */
  url?: string;
  /** 卡片主标题：文件名或 URL 的主机/路径 */
  name: string;
  /** 卡片副标题：完整路径或 URL */
  detail: string;
}

export interface ShowRequest {
  /** 对应 tool block id：同一条消息里多次调用 show 时用来区分卡片 */
  id: string;
  title?: string;
  targets: ShowTarget[];
}

/** 右栏 `show_preview` 命令的返回形状（与 src-tauri/src/show.rs 对齐）。 */
export type ShowPreview =
  | { kind: 'text'; path: string; content: string; size: number }
  | { kind: 'image'; path: string; dataUrl: string; size: number }
  | { kind: 'pdf'; path: string; data: string; size: number }
  | { kind: 'html'; path: string; html: string; size: number; renderer?: string }
  | { kind: 'unsupported'; path: string; size: number; message: string };

// 与 src-tauri/src/show.rs::kind_of_path 保持同一份清单。
const OFFICE = new Set(['docx', 'docm', 'doc', 'pptx', 'pptm', 'ppt', 'xlsx', 'xlsm', 'xls', 'odt', 'odp', 'ods']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const TEXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss',
  'sass', 'less', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'rs', 'py', 'go', 'java', 'kt',
  'kts', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'rb', 'php', 'swift', 'dart', 'lua', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'vue', 'svelte', 'astro', 'log', 'csv', 'tsv', 'tex',
  'rst', 'diff', 'patch',
]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const parseJson = (value: string): Record<string, unknown> | null => {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
};

const basename = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;

export function kindOfPath(value: string): ShowKind {
  // 只处理本地路径；URL 在 toShowTarget 里已经提前分流，不参与扩展名判断。
  const extension = /\.([a-z0-9]+)$/i.exec(value)?.[1]?.toLowerCase() ?? '';
  if (OFFICE.has(extension)) return 'office';
  if (extension === 'pdf') return 'pdf';
  if (IMAGE.has(extension)) return 'image';
  if (TEXT.has(extension)) return 'text';
  return 'file';
}

/** 相对路径按会话工作目录补齐；后端会再 canonicalize 一次。 */
export function resolveShowPath(value: string, cwd?: string | null): string {
  let path = value.trim().replace(/^<|>$/g, '');
  if (/^file:\/\//i.test(path)) {
    const rest = path.replace(/^file:\/\//i, '');
    // file:///C:/x → C:/x；file://server/share → \\server\share（UNC）。
    path = rest.startsWith('/') ? rest.slice(1) : `\\\\${rest.replace(/\//g, '\\')}`;
    try {
      path = decodeURIComponent(path);
    } catch { /* 保留原始百分号 */ }
  }
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') || path.startsWith('/')) return path;
  if (!cwd) return path;
  const base = cwd.replace(/[\\/]+$/, '');
  return `${base}${base.includes('\\') ? '\\' : '/'}${path.replace(/^[\\/]+/, '')}`;
}

function urlName(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return path && path !== '/' ? `${parsed.host}${path}` : parsed.host;
  } catch {
    return url;
  }
}

export function toShowTarget(value: string, cwd?: string | null): ShowTarget | null {
  const raw = value.trim().replace(/^<|>$/g, '').replace(/^["'`]|["'`]$/g, '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'web', url: raw, name: urlName(raw), detail: raw };
  }
  const path = resolveShowPath(raw, cwd);
  if (!path) return null;
  return { kind: kindOfPath(path), path, name: basename(path), detail: path };
}

function pushTarget(out: string[], value: unknown) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const key of ['path', 'url', 'file', 'href', 'target']) {
    const text = object[key];
    if (typeof text === 'string' && text.trim()) {
      out.push(text.trim());
      return;
    }
  }
}

/** 容忍模型常见的几种写法：targets 数组/单值、items、单 path/url。 */
export function showTargetsFromArgs(args: unknown): string[] {
  const object = record(args) ?? (typeof args === 'string' ? parseJson(args) : null);
  if (!object) return [];
  const out: string[] = [];
  const targets = object.targets;
  if (Array.isArray(targets)) targets.forEach((value) => pushTarget(out, value));
  else if (targets !== undefined) pushTarget(out, targets);
  if (!out.length && Array.isArray(object.items)) object.items.forEach((value) => pushTarget(out, value));
  if (!out.length) {
    for (const key of ['path', 'url', 'file', 'href']) {
      const text = object[key];
      if (typeof text === 'string' && text.trim()) {
        out.push(text.trim());
        break;
      }
    }
  }
  return [...new Set(out)];
}

/** 从回合 blocks 里找出成功执行的 show 调用；streaming 期间调用方不渲染卡片。 */
export function showRequests(blocks: TurnBlock[] | undefined, cwd?: string | null): ShowRequest[] {
  const requests: ShowRequest[] = [];
  for (const block of blocks ?? []) {
    if (block.kind !== 'tool' || block.toolName !== 'show' || block.running || block.isError || block.result === undefined) continue;
    const raw = showTargetsFromArgs(block.args);
    if (!raw.length) continue;
    const seen = new Set<string>();
    const targets = raw
      .map((value) => toShowTarget(value, cwd))
      .filter((target): target is ShowTarget => !!target)
      .filter((target) => {
        const key = `${target.kind}:${target.path ?? target.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!targets.length) continue;
    const args = record(block.args);
    const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
    requests.push({ id: block.id, title, targets });
  }
  return requests;
}
