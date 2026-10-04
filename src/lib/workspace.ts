import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './piRpc';

export type TabKind = 'new' | 'files' | 'diff' | 'terminal' | 'web';
export type ReviewScope = 'working' | 'staged' | 'branch' | 'turn';
export interface PanelTarget { kind: TabKind; path?: string; line?: number; url?: string; reviewId?: string; n: number }
export interface FileEntry { name: string; path: string; directory: boolean; symlink: boolean }
export interface FilePreview { path: string; kind: 'text' | 'image' | 'pdf' | 'binary'; content: string; size: number }
export interface Change { file: string; add: number; del: number; status: string; staged?: boolean; binary?: boolean }
export interface Review { files: Change[]; branch?: string; branches?: string[]; upstream?: string; base?: string; ahead?: number; behind?: number; skipped?: number; undone?: boolean }
export interface TurnResult extends Review { id: string }

export async function workspace<T>(action: string, root: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isDesktopRuntime()) throw new Error('请在 WEPI 桌面端打开本地工作区');
  if (!root) throw new Error('请先选择工作区');
  return invoke<T>('workspace_request', { action, root, args });
}

export function fileTarget(value: string): Omit<PanelTarget, 'n'> | null {
  let path = value.trim().replace(/^<|>$/g, '');
  if (/^https?:\/\//i.test(path)) return { kind: 'web', url: path };
  if (/^(javascript|data|mailto|tel|tauri|asset):/i.test(path)) return null;
  if (path.startsWith('wepi://review')) {
    const url = new URL(path);
    return { kind: 'diff', reviewId: url.searchParams.get('id') ?? undefined, path: url.searchParams.get('path') ?? undefined };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !path.startsWith('file:')) return null;
  try { path = decodeURIComponent(path); } catch { /* Keep literal percent characters. */ }
  path = path.replace(/^file:\/\/\/([a-z]:)/i, '$1').replace(/^file:\/\//i, '').replace(/^\/([a-z]:[\\/])/i, '$1');
  const location = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(path);
  const line = location ? Number(location[1] ?? location[2]) : undefined;
  if (location) path = path.slice(0, location.index);
  if (!path || /[\r\n]/.test(path)) return null;
  return { kind: 'files', path, line };
}

export function looksLikeFile(value: string) {
  return /^(?:[a-z]:[\\/]|\/|\.\.?[\\/])[^\n]+$/i.test(value) || /^(?:[\w.@-]+[\\/])*[\w.@-]+\.[\w-]+(?::\d+(?::\d+)?|#L\d+)?$/.test(value);
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
