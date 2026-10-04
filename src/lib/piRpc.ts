import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type PiRpcRecord = Record<string, unknown> & { type?: string; id?: string; command?: string; success?: boolean };
export type PiRpcEvent = PiRpcRecord;

export function isDesktopRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function startPiRpc(options: { executable?: string; cwd?: string } = {}) {
  if (!isDesktopRuntime()) throw new Error('Pi RPC 只能在桌面应用中启动');
  await invoke('pi_rpc_start', { executable: options.executable ?? 'pi', cwd: options.cwd ?? null });
}

export async function sendPiRpc(record: PiRpcRecord) {
  if (!isDesktopRuntime()) throw new Error('Pi RPC 只能在桌面应用中使用');
  await invoke('pi_rpc_send', { record });
}

export async function requestPiRpc<T = unknown>(record: PiRpcRecord, timeoutMs = 10000): Promise<T> {
  const id = `wepi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let timer: number | undefined;
  let responseCleanup: (() => void) | undefined;
  const response = new Promise<T>((resolve, reject) => {
    void listenPiRpc({
      event: (event) => {
        if (event.type !== 'rpc_message' || event.message === undefined) return;
        const message = event.message as PiRpcRecord;
        if (message.id !== id) return;
        if (message.success === false) reject(new Error(String(message.error ?? 'Pi RPC 请求失败')));
        else resolve(message.data as T);
      },
      error: (message) => reject(new Error(message)),
    }).then((unlisten) => {
      timer = window.setTimeout(() => reject(new Error('Pi RPC 请求超时')), timeoutMs);
      void sendPiRpc({ ...record, id }).catch(reject);
      // The cleanup is attached after listener setup, avoiding a send/listener race.
      responseCleanup = unlisten;
    }).catch(reject);
  });
  try {
    return await response;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    responseCleanup?.();
  }
}

export async function stopPiRpc() {
  if (isDesktopRuntime()) await invoke('pi_rpc_stop');
}

export type PiConfigSnapshot = {
  agentDir: string;
  piPath?: string;
  cwd?: string;
  models: { providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string; headers?: Record<string, string>; compat?: Record<string, unknown>; models?: { id: string; name?: string; reasoning?: boolean; [key: string]: unknown }[] }> };
  auth: Record<string, { key?: string; type?: string }>;
  settings: Record<string, unknown>;
  mcp: Record<string, unknown>;
  skillsCount: number;
  extensionsCount: number;
  skills?: string[];
  extensions?: string[];
};

export function readPiConfig() {
  if (!isDesktopRuntime()) return Promise.resolve<PiConfigSnapshot | null>(null);
  return invoke<PiConfigSnapshot>('pi_config_read');
}

export function writePiConfig(file: 'models.json' | 'auth.json' | 'settings.json' | 'mcp.json', content: unknown) {
  if (!isDesktopRuntime()) return Promise.reject(new Error('Pi 配置只能在桌面应用中写入'));
  return invoke('pi_config_write', { file, content });
}

export async function listenPiRpc(handlers: {
  event?: (record: PiRpcEvent) => void;
  error?: (message: string) => void;
  exit?: () => void;
}) {
  if (!isDesktopRuntime()) return () => {};
  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(await listen<PiRpcEvent>('pi-rpc-event', (event) => handlers.event?.(event.payload)));
  unlisteners.push(await listen<string>('pi-rpc-error', (event) => handlers.error?.(event.payload)));
  unlisteners.push(await listen('pi-rpc-exit', () => handlers.exit?.()));
  return () => unlisteners.forEach((unlisten) => unlisten());
}

export function promptRecord(id: string, message: string) {
  return { id, type: 'prompt', message } satisfies PiRpcRecord;
}

