/**
 * WEPI Extension UI 工具：解析 pi 扩展经 RPC Extension UI 协议发来的请求。
 *
 * 两个内置扩展的私有契约：
 * - wepi-security-gate：confirm 的 title 带 [WEPI_SECURITY_CONFIRM] 前缀 +
 *   JSON 负载 {tool, level, detail}，渲染专用审批卡。
 * - wepi-todo：setWidget 的 widgetKey === 'wepi-todo'，widgetLines 首行是
 *   [[wepi:todo-plan:...]] 元数据行，其余行是 `☑/◐/☐ #id text`。
 */

import type { ExtensionUiRequest } from './piRpc';

export const SECURITY_CONFIRM_MARKER = '[WEPI_SECURITY_CONFIRM]';

export interface SecurityConfirmInfo {
  tool: string;
  level: string;
  detail: string;
}

/**
 * 解析安全确认请求标题；非安全确认返回 null。
 * JSON 损坏时兜底返回原始负载文本（tool/level 为空），避免解析失败让确认卡消失。
 */
export function parseSecurityConfirmTitle(title: unknown): SecurityConfirmInfo | null {
  if (typeof title !== 'string') return null;
  const raw = title.trim();
  if (!raw.startsWith(SECURITY_CONFIRM_MARKER)) return null;
  const payloadText = raw.slice(SECURITY_CONFIRM_MARKER.length).trim();
  try {
    const parsed = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      tool: typeof parsed.tool === 'string' ? parsed.tool : '',
      level: typeof parsed.level === 'string' ? parsed.level : '',
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
    };
  } catch {
    return { tool: '', level: '', detail: payloadText };
  }
}

/** 审批卡是否应由安全确认卡渲染（而非普通 select 卡）。
 *  安全门扩展用 ctx.ui.select（PiDeck 验证过的两参形式），带标记前缀。 */
export function isSecurityConfirm(request: ExtensionUiRequest): boolean {
  return request.method === 'select' && parseSecurityConfirmTitle(request.title) !== null;
}

/* ------------------------------------------------------------------ */
/*  Todo widget 行解析                                                  */
/* ------------------------------------------------------------------ */

export const TODO_WIDGET_KEY = 'wepi-todo';
const TODO_PLAN_METADATA_LINE = /^\[\[wepi:todo-plan:[^\]]+\]\]$/;

export interface TodoWidgetItem {
  id: number;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const TODO_LINE = /^([☑◐☐])\s+#(\d+)\s+(.*)$/;

const markerToStatus: Record<string, TodoWidgetItem['status']> = {
  '☑': 'completed',
  '◐': 'in_progress',
  '☐': 'pending',
};

/**
 * 把 wepi-todo widget 的行快照解析为条目列表。
 * 首行元数据行（计划身份）被过滤；无法解析的行静默跳过（行格式是私有契约，
 * 扩展升级时旧 UI 最多显示部分行，不崩溃）。
 */
export function parseTodoWidgetLines(lines: unknown): TodoWidgetItem[] {
  if (!Array.isArray(lines)) return [];
  const items: TodoWidgetItem[] = [];
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    if (TODO_PLAN_METADATA_LINE.test(line.trim())) continue;
    const match = TODO_LINE.exec(line.trim());
    if (!match) continue;
    const status = markerToStatus[match[1]];
    const id = Number(match[2]);
    if (!status || !Number.isSafeInteger(id) || id <= 0) continue;
    items.push({ id, text: match[3], status });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/*  历史会话 todo 快照解析（无活 runtime 时的兜底数据源）                */
/* ------------------------------------------------------------------ */

/**
 * 从会话 JSONL 条目中重建 todo 列表：找最后一个 type=custom 且
 * customType === 'wepi-todo' 的条目，读其 data.activePlan.todos。
 * 与扩展侧 decodeTodoState 同语义：只接受 version===3。
 */
export function todoItemsFromSessionEntries(entries: Record<string, unknown>[]): TodoWidgetItem[] {
  let lastData: unknown;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === TODO_WIDGET_KEY) {
      lastData = entry.data;
    }
  }
  const data = lastData as Record<string, unknown> | undefined;
  if (!data || data.version !== 3) return [];
  const plan = data.activePlan as Record<string, unknown> | undefined;
  if (!plan || !Array.isArray(plan.todos)) return [];
  const items: TodoWidgetItem[] = [];
  for (const raw of plan.todos) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = item.id;
    const text = item.text;
    const status = item.status;
    if (
      typeof id === 'number' && Number.isSafeInteger(id) && id > 0 &&
      typeof text === 'string' && text.length > 0 &&
      (status === 'pending' || status === 'in_progress' || status === 'completed')
    ) {
      items.push({ id, text, status });
    }
  }
  return items;
}
