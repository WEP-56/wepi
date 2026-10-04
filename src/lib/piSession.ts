import type { Message, Step, TermLine } from '../data';
import type { PiSessionIndexEntry } from './piRpc';

/**
 * Pi 会话历史 → WEPI 消息模型的投影。
 *
 * Pi JSONL 是唯一事实来源；这里只做只读投影：
 * - message(user/assistant) → Message
 * - toolcall 在 assistant content 中(toolCall block) + 对应 toolResult → Step
 */

export interface PiEntry {
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  type?: string;
  message?: PiEntryMessage;
  [key: string]: unknown;
}

export interface PiEntryMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { input?: number; output?: number; totalTokens?: number };
  stopReason?: string;
  [key: string]: unknown;
}

const textOfContent = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
    : typeof value === 'string'
      ? value
      : '';

/** Pi 的 thinking block 把文本放在 `thinking` 字段（不是 `text`）。 */
const thinkingOfContent = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && block.type === 'thinking')
        .map((block) => {
          if (typeof block.thinking === 'string') return block.thinking;
          return typeof block.text === 'string' ? block.text : '';
        })
        .join('')
    : '';

interface ToolBlock {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Pi 落盘的工具调用 block 形如 {type:"toolCall", id, name, arguments}。 */
const toolCallsOfContent = (value: unknown): ToolBlock[] =>
  Array.isArray(value)
    ? value
        .filter((block): block is Record<string, unknown> => {
          if (!block || typeof block !== 'object') return false;
          const type = block.type;
          return type === 'toolCall' || type === 'toolcall' || type === 'tool_call';
        })
        .map((block) => ({
          toolCallId: String(block.id ?? block.toolCallId ?? ''),
          toolName: String(block.name ?? block.toolName ?? 'tool'),
          args: (block.arguments ?? block.args ?? {}) as Record<string, unknown>,
        }))
        .filter((call) => call.toolCallId)
    : [];

function resultText(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return textOfContent(result);
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>;
    return textOfContent(record.content ?? record.output ?? record.text ?? '');
  }
  return String(result);
}

function describeCommand(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'bash' || toolName === 'powershell') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    return cmd || `${toolName} 命令`;
  }
  if (typeof args.path === 'string') return args.path;
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.pattern === 'string') return args.pattern;
  const first = Object.values(args)[0];
  return typeof first === 'string' ? first : toolName;
}

/** Step icon by tool name (mirrors PiDeck-style classification). */
function stepIcon(toolName: string): Step['icon'] {
  if (toolName === 'bash' || toolName === 'powershell' || toolName === 'shell') return 'command';
  if (toolName === 'read' || toolName === 'ls' || toolName === 'find') return 'file';
  if (toolName === 'edit' || toolName === 'write') return 'edit';
  if (toolName === 'grep') return 'search';
  return 'agent';
}

/** 把 toolcall/toolResult 对折叠为时间线步骤，文本块保留为正文。 */
function stepsFromAssistant(
  entry: PiEntry,
  resultsById: Map<string, { result: unknown; isError?: boolean }>,
): { content: string; thinking: string; steps: Step[]; edits: Message['edits'] } {
  const content = entry.message?.content;
  const text = textOfContent(content);
  const thinking = thinkingOfContent(content);
  const calls = toolCallsOfContent(content);
  const steps: Step[] = [];
  const edits: Message['edits'] = [];
  for (const call of calls) {
    const outcome = resultsById.get(call.toolCallId);
    const output = resultText(outcome?.result);
    const label0 = describeCommand(call.toolName, call.args);
    const isEdit = call.toolName === 'edit' || call.toolName === 'write';
    const lines: TermLine[] = output ? output.split('\n').slice(-50).map((s) => ({ s })) : [];
    steps.push({
      id: call.toolCallId,
      kind: 'action',
      icon: stepIcon(call.toolName),
      label: `${call.toolName === 'bash' ? '已运行' : '已调用'} ${label0}`,
      detail: {
        kind: 'command',
        command: label0,
        lines: outcome?.isError ? lines.map((l) => ({ ...l, t: 'err' as const })) : lines,
      },
    });
    if (isEdit && typeof call.args.path === 'string') {
      edits.push({ file: call.args.path, add: 0, del: 0 });
    }
  }
  return { content: text, thinking, steps, edits };
}

let seq = 0;
const nextId = () => `pi-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * 将 Pi session entries（get_entries 返回的原始记录数组）投影为 WEPI 消息列表。
 * 遵循 parentId 链取活动分支；user/assistant 消息成对输出，toolcall
 * 结果折叠进 assistant 消息的 steps。
 */
export function projectPiEntries(entries: PiEntry[]): Message[] {
  // 活动分支：沿 parentId 回溯（Pi 的写入顺序即分支顺序，最后一条为叶子）。
  const byId = new Map<string, PiEntry>();
  let leaf: PiEntry | null = null;
  for (const entry of entries) {
    if (typeof entry.id === 'string' && entry.id) {
      byId.set(entry.id, entry);
      leaf = entry;
    }
  }
  const branch: PiEntry[] = [];
  if (leaf) {
    let current: PiEntry | undefined = leaf;
    const seen = new Set<string>();
    while (current && !seen.has(current.id ?? '')) {
      seen.add(current.id ?? '');
      branch.push(current);
      const parentId: string | undefined = current.parentId ?? undefined;
      current = parentId ? byId.get(parentId) : undefined;
    }
    branch.reverse();
  } else {
    branch.push(...entries);
  }

  // toolResult 消息：toolCallId 挂在 message 上（不在 content block 内）。
  const resultsById = new Map<string, { result: unknown; isError?: boolean }>();
  for (const entry of branch) {
    const message = entry.message;
    if (!message || message.role !== 'toolResult') continue;
    const callId = typeof message.toolCallId === 'string' && message.toolCallId
      ? message.toolCallId
      : Array.isArray(message.content)
        ? (message.content.find((b): b is Record<string, unknown> => !!b && typeof b === 'object' && typeof b.toolCallId === 'string')?.toolCallId as string | undefined)
        : undefined;
    if (callId) resultsById.set(callId, { result: message.content, isError: message.isError === true });
  }

  const messages: Message[] = [];
  for (const entry of branch) {
    const message = entry.message;
    if (!message?.role) continue;
    if (message.role === 'user') {
      const text = textOfContent(message.content).trim();
      if (text) messages.push({ id: nextId(), role: 'user', content: text });
    } else if (message.role === 'assistant') {
      const { content, thinking, steps, edits } = stepsFromAssistant(entry, resultsById);
      // 一个回合内 Pi 会写入多条 assistant 消息（每次工具调用一轮）。
      // 与 pilo 的 ensure_assistant_start / PiDeck 的回合分组一致：
      // 两条 user 消息之间的所有 assistant 内容合并为同一个气泡，
      // 这样历史渲染与实时流式的观感才一致。
      const previous = messages[messages.length - 1];
      const canMerge = previous?.role === 'assistant';
      const mergedText = canMerge && content
        ? (previous.content ? `${previous.content}\n\n${content}` : content)
        : content;
      if (canMerge) {
        messages[messages.length - 1] = {
          ...previous,
          content: mergedText,
          thinkingContent: [previous.thinkingContent, thinking].filter(Boolean).join('\n\n') || undefined,
          steps: [...(previous.steps ?? []), ...steps].length ? [...(previous.steps ?? []), ...steps] : undefined,
          edits: [...(previous.edits ?? []), ...(edits ?? [])].length ? [...(previous.edits ?? []), ...(edits ?? [])] : undefined,
        };
      } else {
        messages.push({
          id: nextId(),
          role: 'assistant',
          content,
          thinkingContent: thinking || undefined,
          steps: steps.length ? steps : undefined,
          edits: edits?.length ? edits : undefined,
        });
      }
    }
  }
  return messages;
}

/** 从索引条目生成标题：优先 Pi 会话名，其次首条用户消息预览。 */
export function titleFromIndexEntry(entry: PiSessionIndexEntry): string {
  if (entry.name && entry.name.trim()) return entry.name.trim();
  if (entry.preview) {
    const first = entry.preview.split('\n')[0].trim();
    if (first) return first.slice(0, 24);
  }
  const file = entry.sessionPath.split(/[\\/]/).pop() ?? entry.sessionPath;
  return file.replace(/\.jsonl$/, '').replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, '').slice(0, 24) || 'Pi 会话';
}

/**
 * 从 sessions 目录名反推工作目录（`--E--Tlegado--` → `E:\Tlegado`）。
 *
 * 注意：该编码是**有损**的——`:` 与 `\` 都映射为 `-`，因此含连字符的目录名
 * （如 `src-tauri`）无法可靠还原。仅作为 header 缺 `cwd` 时的兜底展示，
 * 权威来源始终是会话文件首行的 `cwd` 字段。
 */
export function cwdFromSessionPath(sessionPath: string): string | null {
  const parent = sessionPath.split(/[\\/]/).slice(-2, -1)[0];
  if (!parent || !/^--/.test(parent) || !parent.endsWith('--')) return null;
  const body = parent.slice(2, -2);
  if (!body) return null;
  const isWindowsDrive = /^[A-Za-z]--/.test(body);
  if (isWindowsDrive) {
    return `${body[0]}:\\${body.slice(3).replace(/-/g, '\\')}`;
  }
  return `/${body.replace(/-/g, '/')}`;
}

export { nextId as piRecordId };
