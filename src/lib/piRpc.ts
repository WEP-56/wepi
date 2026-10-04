import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type PiRpcRecord = Record<string, unknown> & { type?: string; id?: string; command?: string; success?: boolean };
export type PiRpcEvent = PiRpcRecord;

export function isDesktopRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/* ------------------------------------------------------------------ */
/* 事件订阅                                                            */
/* ------------------------------------------------------------------ */

type PiEventHandler = (record: PiRpcEvent, sessionKey: string | undefined) => void;

const eventHandlers = new Set<PiEventHandler>();
let eventListenerReady: Promise<() => void> | null = null;
const exitHandlers = new Map<string, Set<() => void>>();

/**
 * 全局事件分发：Rust 侧 `pi-rpc-event` 是所有会话共享的总线。
 * `pi-rpc-exit` 携带退出的 sessionKey，前端据此清理对应会话状态。
 */
function ensureEventListener() {
  if (eventListenerReady) return eventListenerReady;
  eventListenerReady = (async () => {
    const unlisteners: UnlistenFn[] = [];
    unlisteners.push(await listen<PiRpcEvent>('pi-rpc-event', (event) => {
      for (const handler of eventHandlers) {
        try {
          handler(event.payload, (event.payload as Record<string, unknown>).__sessionKey as string | undefined);
        } catch { /* handler 异常不影响其他订阅者 */ }
      }
    }));
    unlisteners.push(await listen<string>('pi-rpc-error', (event) => {
      for (const handler of eventHandlers) {
        try {
          handler({ type: 'pi_rpc_error', message: event.payload }, undefined);
        } catch { /* ignore */ }
      }
    }));
    unlisteners.push(await listen<string>('pi-rpc-exit', (event) => {
      const key = event.payload;
      const handlers = key ? exitHandlers.get(key) : undefined;
      if (handlers) {
        for (const handler of [...handlers]) {
          try { handler(); } catch { /* ignore */ }
        }
        exitHandlers.delete(key);
      }
      for (const handler of eventHandlers) {
        try { handler({ type: 'pi_rpc_exit', sessionKey: key }, key); } catch { /* ignore */ }
      }
    }));
    unlisteners.push(await listen<string>('pi-rpc-log', (event) => {
      for (const handler of eventHandlers) {
        try { handler({ type: 'pi_rpc_log', line: event.payload }, undefined); } catch { /* ignore */ }
      }
    }));
    return () => unlisteners.forEach((unlisten) => unlisten());
  })();
  return eventListenerReady;
}

/**
 * 订阅 Pi RPC 事件。
 *
 * 关键：本函数**同步**返回取消订阅函数，不等待底层 listener 建立。
 * React StrictMode 下 effect 会「挂载→卸载→再挂载」，若取消订阅依赖
 * 异步建立完成，第一次订阅就永远无法移除，事件会被处理两次——
 * 表现为流式输出每一段都被拼接两遍。
 */
export function listenPiRpc(handlers: {
  event?: PiEventHandler;
  error?: (message: string) => void;
  exit?: (sessionKey?: string) => void;
  log?: (line: string) => void;
}): () => void {
  if (!isDesktopRuntime()) return () => {};
  const handler: PiEventHandler = (record, sessionKey) => {
    if (record.type === 'pi_rpc_error') {
      handlers.error?.(String((record as Record<string, unknown>).message ?? ''));
      return;
    }
    if (record.type === 'pi_rpc_exit') {
      handlers.exit?.(sessionKey);
      return;
    }
    if (record.type === 'pi_rpc_log') {
      handlers.log?.(String((record as Record<string, unknown>).line ?? ''));
      return;
    }
    handlers.event?.(record, sessionKey);
  };
  eventHandlers.add(handler);
  void ensureEventListener();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    eventHandlers.delete(handler);
  };
}

/** 订阅某个会话进程退出（sessionKey 级别）。 */
export function onRpcExit(sessionKey: string, handler: () => void): () => void {
  let set = exitHandlers.get(sessionKey);
  if (!set) {
    set = new Set();
    exitHandlers.set(sessionKey, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

/* ------------------------------------------------------------------ */
/*  会话进程管理                                                        */
/* ------------------------------------------------------------------ */

export interface PiSessionHandle {
  /** WEPI 内部会话键，用于多进程隔离 */
  sessionKey: string;
  /** Pi session 文件绝对路径（已有会话时传入 --session 恢复） */
  sessionPath: string | null;
}

const startedSessions = new Map<string, { sessionPath: string | null; generation: number }>();
let sessionGeneration = 0;

/**
 * 启动（或复用）一个绑定到指定工作目录与 Pi 会话文件的 RPC 进程。
 * 相同 sessionKey 复用已有进程；cwd / sessionPath 变化时自动重启。
 */
export async function ensurePiSession(options: {
  sessionKey: string;
  cwd?: string | null;
  sessionPath?: string | null;
  executable?: string;
}): Promise<void> {
  if (!isDesktopRuntime()) throw new Error('Pi RPC 只能在桌面应用中启动');
  const { sessionKey, cwd, sessionPath, executable } = options;
  const existing = startedSessions.get(sessionKey);
  if (existing && existing.sessionPath === (sessionPath ?? null)) {
    return; // 进程已在运行且绑定相同会话文件
  }
  if (existing) {
    await invoke('pi_rpc_stop', { sessionKey });
  }
  startedSessions.set(sessionKey, { sessionPath: sessionPath ?? null, generation: ++sessionGeneration });
  await invoke('pi_rpc_start', {
    sessionKey,
    executable: executable ?? 'pi',
    cwd: cwd ?? null,
    sessionPath: sessionPath ?? null,
  });
  await invoke('pi_rpc_wait_ready', { timeoutMs: 20_000 });
}

export async function sendPiRpc(record: PiRpcRecord, sessionKey?: string) {
  if (!isDesktopRuntime()) throw new Error('Pi RPC 只能在桌面应用中使用');
  await invoke('pi_rpc_send', { record, sessionKey: sessionKey ?? 'default' });
}

export async function stopPiSession(sessionKey: string) {
  if (!isDesktopRuntime()) return;
  startedSessions.delete(sessionKey);
  await invoke('pi_rpc_stop', { sessionKey }).catch(() => {});
}

export async function stopPiRpc() {
  if (!isDesktopRuntime()) return;
  startedSessions.clear();
  await invoke('pi_rpc_stop_all').catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  请求 / 响应                                                         */
/* ------------------------------------------------------------------ */

let rpcSequence = 0;

export async function requestPiRpc<T = unknown>(
  record: PiRpcRecord,
  timeoutMs = 10_000,
  sessionKey?: string,
): Promise<T> {
  const id = `wepi-${Date.now()}-${++rpcSequence}`;
  const key = sessionKey ?? 'default';
  let resolveRef: ((value: T) => void) | undefined;
  let rejectRef: ((reason?: unknown) => void) | undefined;
  const response = new Promise<T>((resolve, reject) => {
    resolveRef = resolve;
    rejectRef = reject;
  });
  const cleanup = listenPiRpc({
    event: (event) => {
      if (event.type !== 'rpc_message' || event.message === undefined) return;
      const message = event.message as PiRpcRecord;
      if (message.id !== id) return;
      if (message.success === false) rejectRef?.(new Error(String(message.error ?? 'Pi RPC 请求失败')));
      else resolveRef?.(message.data as T);
    },
    error: (message) => rejectRef?.(new Error(message)),
  });
  const timer = window.setTimeout(() => rejectRef?.(new Error('Pi RPC 请求超时')), timeoutMs);
  try {
    await sendPiRpc({ ...record, id }, key);
    return await response;
  } finally {
    window.clearTimeout(timer);
    cleanup();
  }
}

export function promptRecord(id: string, message: string) {
  return { id, type: 'prompt', message } satisfies PiRpcRecord;
}

/* ------------------------------------------------------------------ */
/*  Pi 配置                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Pi 会话索引（~/.pi/agent/sessions 扫描）                            */
/* ------------------------------------------------------------------ */

export interface PiSessionIndexEntry {
  sessionPath: string;
  sessionId: string | null;
  cwd: string | null;
  createdAt: string | null;
  modifiedAt: number;
  fileSize: number;
  name: string | null;
  preview: string | null;
  messageCount: number;
}

export function scanPiSessions() {
  if (!isDesktopRuntime()) return Promise.resolve<PiSessionIndexEntry[]>([]);
  return invoke<{ sessions: PiSessionIndexEntry[] }>('pi_sessions_scan').then((r) => r.sessions ?? []);
}

/**
 * 直接读取会话 JSONL 全文（不启动 Pi 进程）。
 * 打开历史会话时用它渲染消息，避免为「看一眼」拉起 Node 进程造成卡顿。
 */
export function readPiSession(path: string) {
  if (!isDesktopRuntime()) return Promise.resolve<Record<string, unknown>[]>([]);
  return invoke<{ entries: Record<string, unknown>[] }>('pi_session_read', { path }).then((r) => r.entries ?? []);
}

/* ------------------------------------------------------------------ */
/*  Pi 状态类型（get_state / get_entries 响应）                          */
/* ------------------------------------------------------------------ */

export interface PiAgentState {
  model?: { id?: string; name?: string; provider?: string };
  thinkingLevel?: string;
  sessionFile?: string;
  sessionId?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  isStreaming?: boolean;
  isCompacting?: boolean;
}

export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}
