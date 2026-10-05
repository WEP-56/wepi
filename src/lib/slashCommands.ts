import { isDesktopRuntime, requestPiRpc } from './piRpc';

/* ------------------------------------------------------------------ */
/*  斜杠命令：数据模型与解析（对齐 pi 的命令语义，参考 pilo/PiDeck）     */
/* ------------------------------------------------------------------ */

export interface SlashCommand {
  /** 命令名（不含斜杠），如 new / compact / mcp */
  name: string;
  /** 菜单里的一句话说明 */
  description?: string;
  /** 来源：builtin=桌面接管，extension/prompt/skill=pi 上报 */
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
}

/**
 * 桌面接管的命令（不发给模型，由 WEPI 自己执行）。
 * pi 原生也有 /new /compact，但 RPC 模式下它们没有交互层实现，
 * 桌面端必须自己接管——与 pilo（RESERVED_NATIVE_COMMANDS）、
 * PiDeck（classifyComposerSlashCommand）的取舍一致。
 */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: '新建会话', source: 'builtin' },
  { name: 'compact', description: '压缩当前上下文（可选自定义提示词）', source: 'builtin' },
];

/** 解析后的输入框提交内容。 */
export type ComposerCommand =
  | { kind: 'builtin'; name: 'new' | 'compact'; rest: string }
  /** pi 扩展/提示词/技能注册的命令：原样作为 prompt 发给 pi 进程 */
  | { kind: 'pi'; name: string; text: string }
  | { kind: 'text' };

/**
 * 解析一条待发送文本是否是斜杠命令。
 * 只认「命令 + 参数」形态：/newx、/login-foo 不匹配名字相近的命令。
 */
export function parseSlashCommand(text: string, known: ReadonlyMap<string, SlashCommand>): ComposerCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { kind: 'text' };
  const name = trimmed.slice(1).split(/\s+/, 1)[0] ?? '';
  if (!name) return { kind: 'text' };
  const rest = trimmed.slice(1 + name.length).trim();
  const command = known.get(name);
  if (!command) return { kind: 'text' };
  if (command.source === 'builtin') return { kind: 'builtin', name: command.name as 'new' | 'compact', rest };
  return { kind: 'pi', name, text: trimmed };
}

/* ------------------------------------------------------------------ */
/*  命令目录：pi RPC get_commands + 桌面内置                           */
/* ------------------------------------------------------------------ */

export interface PiCommandInfo {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: { scope?: string; source?: string };
}

/** pi 的 RPC 命令目录里包含桌面已接管的内置命令，去重避免菜单里出现两项。 */
const reservedNative = new Set(BUILTIN_COMMANDS.map((command) => command.name));

function fromPi(entry: PiCommandInfo): SlashCommand {
  const source = entry.source === 'skill' ? 'skill' : entry.source === 'prompt' ? 'prompt' : 'extension';
  const scope = entry.sourceInfo?.scope;
  return {
    name: entry.name,
    description: entry.description || (scope ? `来自 ${scope}` : undefined),
    source,
  };
}

/**
 * 拉取 pi 上报的命令目录（扩展 / 提示词 / 技能）。
 * 需要 RPC 进程已就绪；失败时返回空目录（菜单仍显示内置命令）。
 */
export async function fetchPiCommands(sessionKey?: string): Promise<SlashCommand[]> {
  if (!isDesktopRuntime()) return [];
  try {
    const result = await requestPiRpc<{ commands?: PiCommandInfo[] }>({ type: 'get_commands' }, 10_000, sessionKey);
    const commands = (result.commands ?? []).filter((entry) => entry?.name && !reservedNative.has(entry.name));
    return commands.map(fromPi);
  } catch {
    return [];
  }
}

export function buildCommandMap(commands: readonly SlashCommand[]): Map<string, SlashCommand> {
  return new Map(commands.map((command) => [command.name, command]));
}

/* ------------------------------------------------------------------ */
/*  输入框触发解析                                                     */
/* ------------------------------------------------------------------ */

export interface SlashQuery {
  /** 查询串（斜杠后的部分，不含斜杠） */
  query: string;
  /** 斜杠在文本中的起始位置 */
  start: number;
  /** 光标位置 */
  end: number;
}

/**
 * 判断光标处是否有激活的斜杠命令查询。
 * 规则（对齐 pilo activeSuggestionQuery）：仅输入开头的斜杠触发命令菜单；
 * 斜杠后出现空格即视为命令结束（进入参数输入，不再弹菜单）。
 */
export function activeSlashQuery(value: string, caret: number): SlashQuery | null {
  if (!value.startsWith('/')) return null;
  const beforeCaret = value.slice(0, Math.min(caret, value.length));
  const token = beforeCaret.slice(1);
  if (token.includes(' ')) return null;
  return { query: token, start: 0, end: beforeCaret.length };
}

/** 过滤命令列表（大小写不敏感，label 与 description 都参与匹配）。 */
export function filterCommands(commands: readonly SlashCommand[], query: string, limit = 9): SlashCommand[] {
  const needle = query.toLowerCase();
  const scored = commands
    .map((command) => {
      const name = command.name.toLowerCase();
      let score = 0;
      if (!needle) score = 1;
      else if (name.startsWith(needle)) score = 100 + needle.length;
      else if (name.includes(needle)) score = 50 + needle.length;
      else if (command.description?.toLowerCase().includes(needle)) score = 10;
      return { command, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return scored.slice(0, limit).map((item) => item.command);
}
