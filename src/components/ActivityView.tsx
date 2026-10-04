import { memo, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  FileText,
  PencilLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  Copy,
  Check,
  RefreshCw,
  Layers,
} from 'lucide-react';
import type { TurnBlock } from '../data';
import { cn } from '../utils/cn';

/**
 * 回合过程时间线（对齐 pilo chat-activity 的呈现）。
 *
 * 结构：整个回合的工作过程收在一个可折叠组里——
 *   ▸ 用时 23s · 思考 + 读取 3 个文件 + 编辑 1 个文件        [spinner]
 * 展开后按 blocks 时序逐项：思考块（引用条）、工具行（图标 + 标签 + 详情）。
 * 正文 text 块不在这里（由 ChatView 直接渲染，保持阅读流）。
 */

/* ---------- 工具图标与动词 ---------- */

function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
  switch (toolName.toLowerCase()) {
    case 'bash':
    case 'powershell':
    case 'shell':
    case 'execute':
      return <Terminal className={className} />;
    case 'read':
    case 'ls':
    case 'find':
      return <BookOpen className={className} />;
    case 'write':
      return <FileText className={className} />;
    case 'edit':
      return <PencilLine className={className} />;
    case 'grep':
    case 'search':
      return <Search className={className} />;
    case '__compaction__':
      return <Layers className={className} />;
    default:
      return <Wrench className={className} />;
  }
}

function toolVerb(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case 'bash':
    case 'powershell':
    case 'shell':
    case 'execute':
      return '运行';
    case 'read':
      return '读取';
    case 'ls':
      return '列出';
    case 'write':
      return '写入';
    case 'edit':
      return '编辑';
    case 'grep':
    case 'search':
      return '搜索';
    case '__compaction__':
      return '压缩上下文';
    default:
      return toolName;
  }
}

/** 从 args 提取一行预览（命令/路径/查询优先）。 */
function argPreview(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of ['command', 'path', 'filePath', 'file_path', 'query', 'pattern', 'url']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const first = Object.values(record)[0];
  return typeof first === 'string' && first.trim() ? first.trim() : null;
}

function argFilePath(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'file_path']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/* ---------- 工具结果展开 ---------- */

function resultTextBlocks(result: unknown): { text: string; diff: string | null } {
  if (result === null || result === undefined) return { text: '', diff: null };
  const asRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  // 编辑类结果：details.diff / details.patch 优先呈现。
  if (asRecord(result)) {
    const details = result.details;
    if (asRecord(details)) {
      const diff = typeof details.diff === 'string' && details.diff.trim()
        ? details.diff
        : typeof details.patch === 'string' && details.patch.trim()
          ? details.patch
          : null;
      if (diff) return { text: '', diff };
    }
  }
  // 通用：content 数组里的 text 块 + 其余元数据。
  if (asRecord(result) && Array.isArray(result.content)) {
    const parts: string[] = [];
    for (const block of result.content) {
      if (typeof block === 'string') { parts.push(block); continue; }
      if (asRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    const metadata = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'content'));
    if (Object.keys(metadata).length) {
      try { parts.push(JSON.stringify(metadata, null, 2)); } catch { /* ignore */ }
    }
    return { text: parts.filter(Boolean).join('\n'), diff: null };
  }
  if (typeof result === 'string') return { text: result, diff: null };
  try { return { text: JSON.stringify(result, null, 2) ?? '', diff: null }; } catch { return { text: String(result), diff: null }; }
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-3)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
      title="复制"
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="scroll-thin max-h-64 overflow-auto rounded-lg bg-[var(--bg-code)] py-1 font-mono text-[11.5px] leading-[1.45]">
      {lines.map((line, i) => {
        const added = line.startsWith('+') && !line.startsWith('+++');
        const removed = line.startsWith('-') && !line.startsWith('---');
        const meta = line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++');
        return (
          <div
            key={i}
            className={cn(
              'grid min-h-[1.45em] grid-cols-[14px_minmax(0,1fr)] whitespace-pre-wrap break-words',
              added && 'bg-[#3fb950]/[0.08]',
              removed && 'bg-[#f85149]/[0.07]',
              meta && 'text-[var(--text-3)]',
            )}
          >
            <span className={cn('select-none text-center', added ? 'text-[#3fb950]' : removed ? 'text-[#f85149]' : 'invisible')}>
              {added ? '+' : removed ? '−' : ''}
            </span>
            <span className={cn('min-w-0', added && 'text-[#6fdc8c]', removed && 'text-[#ff8b85]', !added && !removed && 'text-[var(--text-2)]')}>
              {line.replace(/^[+-]/, '') || '\u00a0'}
            </span>
          </div>
        );
      })}
    </pre>
  );
}

/* ---------- 单个工具行 ---------- */

function ToolRow({ block }: { block: Extract<TurnBlock, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const preview = argPreview(block.args);
  const filePath = argFilePath(block.args);
  const basename = filePath ? filePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null;
  const { text, diff } = open ? resultTextBlocks(block.result) : { text: '', diff: null };
  const hasDetail = block.result !== undefined && !block.running;

  return (
    <div className="rounded-lg transition-colors hover:bg-[var(--bg-hover)]/50">
      <button
        onClick={() => hasDetail && setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-[5px] text-left',
          hasDetail ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        {hasDetail ? (
          <ChevronRight size={12} className={cn('shrink-0 text-[var(--text-3)] transition-transform duration-150', open && 'rotate-90')} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <ToolIcon toolName={block.toolName} className="size-3.5 shrink-0 text-[var(--text-3)]" />
        <span className="shrink-0 text-[12.5px] font-medium text-[var(--text-2)]">{toolVerb(block.toolName)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-3)]" title={preview ?? undefined}>
          {basename ?? preview ?? ''}
        </span>
        {block.running && <span className="size-3 shrink-0 animate-pulse rounded-full bg-[var(--blue)]" />}
        {block.isError && <CircleAlert size={12} className="shrink-0 text-[#f85149]" />}
      </button>
      {open && (diff || text) && (
        <div className="px-2 pb-2 pt-0.5">
          {diff && <DiffView diff={diff} />}
          {text && (
            <div className="relative">
              <pre className="scroll-thin max-h-56 overflow-auto rounded-lg bg-[var(--bg-code)] px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.5] text-[var(--text-2)]">
                {text.split('\n').slice(-80).join('\n')}
              </pre>
              <div className="absolute right-1.5 top-1.5">
                <CopyButton value={text} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- 思考块 ---------- */

function ThinkingBlock({ block }: { block: Extract<TurnBlock, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(block.running);
  // 运行中的思考默认展开；停止后自动折叠一次。
  const wasRunning = useRef(block.running);
  useEffect(() => {
    if (wasRunning.current && !block.running) setOpen(false);
    wasRunning.current = block.running;
  }, [block.running]);
  return (
    <div className="my-0.5">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-[5px] text-left"
      >
        <ChevronRight size={12} className={cn('shrink-0 text-[var(--text-3)] transition-transform duration-150', open && 'rotate-90')} />
        <Sparkles size={13} className={cn('shrink-0', block.running ? 'text-[var(--text-2)]' : 'text-[var(--text-3)]')} />
        <span className={cn('text-[12.5px] font-medium', block.running ? 'shimmer-text' : 'text-[var(--text-2)]')}>
          {block.running ? '正在思考…' : '已思考'}
        </span>
      </button>
      {open && block.text && (
        <div className="ml-[26px] mb-1 max-h-56 scroll-thin overflow-y-auto whitespace-pre-wrap border-l-2 border-[var(--border-strong)] py-0.5 pl-3 text-[12px] leading-5 text-[var(--text-3)]">
          {block.text}
        </div>
      )}
    </div>
  );
}

/* ---------- 叙述块（过程说明文字，折进时间线） ---------- */

function NarrationBlock({ block }: { block: Extract<TurnBlock, { kind: 'text' }> & { narration?: boolean } }) {
  return (
    <div className="px-2 py-1 text-[12.5px] leading-5 text-[var(--text-3)]">
      <span className="mr-1.5 inline-block h-1 w-1 translate-y-[-2px] rounded-full bg-[var(--text-3)]" />
      {block.text}
    </div>
  );
}

/* ---------- 过程摘要（pilo summarizeAssistantActivity 的口径） ---------- */

export function summarizeActivity(blocks: TurnBlock[]): string {
  const parts: string[] = [];
  const readPaths = new Set<string>();
  let writes = 0;
  let edits = 0;
  let commands = 0;
  let thought = false;
  for (const block of blocks) {
    if (block.kind === 'thinking') { thought = true; continue; }
    if (block.kind !== 'tool') continue;
    const name = block.toolName.toLowerCase();
    const path = argFilePath(block.args);
    if (name === 'read' || name === 'ls' || name === 'find') {
      if (path) readPaths.add(path); else readPaths.add(`#${readPaths.size + 1}`);
    } else if (name === 'write') writes += 1;
    else if (name === 'edit') edits += 1;
    else commands += 1;
  }
  if (thought) parts.push('思考');
  if (readPaths.size) parts.push(`读取 ${readPaths.size} 个文件`);
  if (writes) parts.push(`写入 ${writes} 个文件`);
  if (edits) parts.push(`编辑 ${edits} 个文件`);
  if (commands) parts.push(`运行 ${commands} 条命令`);
  return parts.join(' · ');
}

export function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/* ---------- 过程组（可折叠容器） ---------- */

/**
 * 回合过程呈现。
 * - streaming：默认展开（实时可见），无折叠按钮（避免跳动）。
 * - settled：默认折叠为摘要行；点击展开完整时间线。
 * - retrying：摘要行追加「第 n/N 次重试」。
 */
function ActivityTimelineBase({
  blocks,
  streaming,
  duration,
  retrying,
}: {
  blocks: TurnBlock[];
  streaming: boolean;
  duration?: number;
  retrying?: { attempt: number; maxAttempts: number } | null;
}) {
  // 时间线 = 思考 + 工具 + narration（过程叙述）；正文 text 不在此。
  const activity = blocks.filter(
    (block) => block.kind !== 'text' || (block as Extract<TurnBlock, { kind: 'text' }> & { narration?: boolean }).narration === true,
  );
  const hasBodyText = blocks.some(
    (block) => block.kind === 'text' && !(block as Extract<TurnBlock, { kind: 'text' }> & { narration?: boolean }).narration,
  );
  const [userOpen, setUserOpen] = useState(false);
  // 流式中强制展开；结束后回落到「默认折叠，除非没有正文」。
  const open = streaming ? true : userOpen || (!hasBodyText && activity.length > 0);
  const summary = summarizeActivity(blocks);

  if (activity.length === 0 && !streaming) return null;

  return (
    <div className="my-1">
      <button
        onClick={() => setUserOpen((value) => !value)}
        className="group/act flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[12px] text-[var(--text-3)] hover:text-[var(--text-2)]"
      >
        {streaming ? (
          <span className="size-3 shrink-0 animate-pulse rounded-full bg-[var(--blue)]" />
        ) : (
          <ChevronRight size={12} className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')} />
        )}
        <span className="min-w-0 flex-1 truncate">
          {duration !== undefined && <span className="text-[var(--text-2)]">用时 {formatDuration(duration)}</span>}
          {duration !== undefined && summary && <span className="mx-1 opacity-50">·</span>}
          {summary || '工作中…'}
          {retrying && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-[#d29922]">
              <RefreshCw size={10} className="animate-spin" /> 第 {retrying.attempt}/{retrying.maxAttempts} 次重试
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="ml-1 mt-0.5 space-y-px border-l border-[var(--border)] pl-1">
          {activity.map((block) =>
            block.kind === 'thinking' ? (
              <ThinkingBlock key={block.id} block={block} />
            ) : block.kind === 'tool' ? (
              <ToolRow key={block.id} block={block} />
            ) : (
              <NarrationBlock key={block.id} block={block as Extract<TurnBlock, { kind: 'text' }> & { narration?: boolean }} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

export const ActivityTimeline = memo(ActivityTimelineBase);

/** 由 blocks 推导流式标签（pilo getAssistantStreamingState 的口径）。 */
export function streamingLabelOf(blocks: TurnBlock[]): 'starting' | 'thinking' | 'processing' | null {
  if (blocks.length === 0) return 'starting';
  if (blocks.some((block) => block.kind === 'thinking' && block.running)) return 'thinking';
  return 'processing';
}
