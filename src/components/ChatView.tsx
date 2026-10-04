import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Folder,
  MoreHorizontal,
  ListTodo,
  Copy,
  Share,
  FileDiff,
  Undo2,
  Check,
  SquarePlus,
  ArrowDown,
} from 'lucide-react';
import type { Message, Project, Thread, FileEdit, TurnBlock } from '../data';
import { ActivityTimeline, streamingLabelOf } from './ActivityView';
import Markdown from './Markdown';
import MessageNavigator from './MessageNavigator';
import { AppIcon, IconBtn } from './ui';
import { RenameInput } from './kit';
import { cn } from '../utils/cn';

function EditCard({ edits, onView, onToast }: { edits: FileEdit[]; onView: () => void; onToast: (s: string) => void }) {
  const [undone, setUndone] = useState(false);
  const add = edits.reduce((a, e) => a + e.add, 0);
  const del = edits.reduce((a, e) => a + e.del, 0);
  const title = edits.length === 1 ? edits[0].file.split('/').pop() : `${edits.length} 个文件`;
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-hover)] text-[var(--text)]">
        <FileDiff size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[14px] font-medium text-[var(--text)]', undone && 'line-through opacity-60')}>
          {undone ? '已撤销' : '已编辑'} {title}
        </div>
        <div className="text-[13px]">
          <span className="text-[#3fb950]">+{add}</span> <span className="text-[#f85149]">-{del}</span>
        </div>
      </div>
      <button
        onClick={() => { setUndone(!undone); onToast(undone ? '已重新应用变更' : '已撤销变更'); }}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)]"
      >
        {undone ? '重做' : '撤销'} <Undo2 size={13} className={undone ? '-scale-x-100' : ''} />
      </button>
      <button onClick={onView} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)]">
        查看变更
      </button>
    </div>
  );
}

/** 旧数据（steps 模型）降级为 blocks 模型渲染，历史消息不改存储。 */
function legacyBlocks(m: Message): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  if (m.thinkingContent) {
    blocks.push({ kind: 'thinking', id: `${m.id}-think`, text: m.thinkingContent, running: false });
  }
  for (const step of m.steps ?? []) {
    if (step.kind !== 'action') continue;
    const toolName =
      step.icon === 'command' ? 'bash' :
      step.icon === 'file' ? 'read' :
      step.icon === 'edit' ? 'edit' :
      step.icon === 'search' ? 'grep' : 'tool';
    blocks.push({
      kind: 'tool',
      id: step.id ?? `${m.id}-step-${blocks.length}`,
      toolName,
      running: !!step.pending,
      result: step.detail?.kind === 'command' ? { content: [{ type: 'text', text: step.detail.lines.map((l) => l.s).join('\n') }] } : undefined,
    });
  }
  if (m.content) blocks.push({ kind: 'text', id: `${m.id}-text`, text: m.content });
  return blocks;
}

function AssistantMsgBase({ m, onView, onToast, onLink }: { m: Message; onView: () => void; onToast: (s: string) => void; onLink: (href: string) => void }) {
  const [copied, setCopied] = useState(false);
  const blocks = m.blocks ?? legacyBlocks(m);
  const streaming = !!m.streaming;
  const label = streaming ? streamingLabelOf(blocks) : null;
  // 正文 = 非 narration 的 text 块；narration（过程叙述）由时间线呈现。
  const isNarration = (b: TurnBlock) => b.kind === 'text' && (b as Extract<TurnBlock, { kind: 'text' }> & { narration?: boolean }).narration === true;
  const bodyBlocks = blocks.filter((b) => !isNarration(b));
  const timelineBlocks = blocks; // 时间线内部自行过滤 narration

  return (
    <div className="group/msg">
      {/* 回合过程：思考/工具/叙述按到达时序收在可折叠时间线里 */}
      <ActivityTimeline blocks={timelineBlocks} streaming={streaming} duration={m.duration} />

      {/* 起步指示：还没有任何块时的等待提示（pilo 的 starting 语义） */}
      {streaming && blocks.length === 0 && (
        <div className="shimmer-text px-1 py-1 text-[13px] font-medium">正在连接…</div>
      )}

      {/* 正文：最终回答的 text 块逐段渲染，流式时带光标 */}
      {bodyBlocks.map((block) =>
        block.kind === 'text' ? (
          <Markdown
            key={block.id}
            text={block.text}
            caret={streaming}
            onLink={onLink}
          />
        ) : null,
      )}

      {/* 流式状态行：思考/处理中的行内提示（不打断已有正文） */}
      {streaming && label && blocks.length > 0 && (
        <div className="mt-1 px-1 text-[12px] text-[var(--text-3)]">
          <span className="shimmer-text">{label === 'thinking' ? '正在思考…' : '正在处理…'}</span>
        </div>
      )}

      {m.edits && !streaming && <EditCard edits={m.edits} onView={onView} onToast={onToast} />}
      {!streaming && (
        <div className="mt-2 flex items-center gap-1 text-[var(--text-3)] opacity-0 transition-opacity group-hover/msg:opacity-100">
          <button
            onClick={() => { navigator.clipboard?.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            title="复制全文"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button onClick={() => onToast('已复制分享链接')} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text)]" title="分享">
            <Share size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 只按消息对象判断是否需要重渲染：流式期间 updateMsg 会为未变动的消息
 * 保持对象标识，因此历史消息可以整段跳过 Markdown 解析与 DOM diff。
 * 回调（onView/onToast）行为恒定，不参与比较。
 */
const AssistantMsg = memo(AssistantMsgBase, (prev, next) => prev.m === next.m);

export function EmptyState({ project, rightOpen, onToggleRight }: { project: Project | null; rightOpen: boolean; onToggleRight: () => void }) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center pb-10">
      <div className="absolute right-3 top-3">
        <IconBtn title="打开侧边面板" active={rightOpen} onClick={onToggleRight}>
          <SquarePlus size={15} />
        </IconBtn>
      </div>
      <AppIcon size={50} className="opacity-90" />
      <h1 className="mt-5 text-center text-[28px] font-normal tracking-tight text-[var(--text)]">
        {project ? (
          <>
            你想让我们在{' '}
            <span className="border-b border-dashed border-[var(--text-3)]">{project.name}</span> 中构建什么？
          </>
        ) : (
          '我们要构建什么？'
        )}
      </h1>
      {project && <div className="mt-2 max-w-[80%] truncate font-mono text-[12px] text-[var(--text-3)]">{project.path}</div>}
    </div>
  );
}

export default function ChatView({
  thread,
  project,
  rightOpen,
  onToggleRight,
  onViewChanges,
  onMenu,
  renaming,
  onRenameSubmit,
  onRenameCancel,
  onToast,
  onOpenLink,
}: {
  thread: Thread;
  project: Project | null;
  rightOpen: boolean;
  onToggleRight: () => void;
  onViewChanges: () => void;
  onMenu: (x: number, y: number) => void;
  renaming: boolean;
  onRenameSubmit: (title: string) => void;
  onRenameCancel: () => void;
  onToast: (s: string) => void;
  onOpenLink: (href: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const msgEls = useRef(new Map<string, HTMLDivElement>());
  /** 粘滞跟随所有权：following = 跟随底部；reading = 用户在阅读历史 */
  const ownership = useRef<'following' | 'reading'>('following');
  const [showToLatest, setShowToLatest] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    ownership.current = 'following';
    setShowToLatest(false);
    setActiveIdx(0);
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  /** 单一滚动主人：ResizeObserver 在内容增长送达时同步钳制到 底部， */
  /// 避免流式增长先画出一帧离底再补滚的跳动（pilo 同款策略）。
  useEffect(() => {
    const viewport = ref.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const content = viewport.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    let contentHeight: number | null = null;
    let viewportHeight: number | null = null;
    const clamp = () => {
      if (ownership.current !== 'following') return;
      const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - max) > 1) viewport.scrollTop = max;
    };
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        if (entry.target === viewport) {
          if (viewportHeight === null) { viewportHeight = entry.contentRect.height; continue; }
          if (Math.abs(entry.contentRect.height - viewportHeight) >= 0.5) { viewportHeight = entry.contentRect.height; changed = true; }
        } else {
          if (contentHeight === null) { contentHeight = entry.contentRect.height; continue; }
          if (Math.abs(entry.contentRect.height - contentHeight) >= 0.5) { contentHeight = entry.contentRect.height; changed = true; }
        }
      }
      if (changed) clamp();
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /** 滚动事件：用户向上离开底部即交出跟随权；贴底则收回。 */
  const handleScroll = useCallback(() => {
    const box = ref.current;
    if (!box) return;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const distance = max - box.scrollTop;
    const atBottom = distance < 24;
    if (atBottom && ownership.current === 'reading') ownership.current = 'following';
    else if (!atBottom && ownership.current === 'following') ownership.current = 'reading';
    // 回到底部按钮的显隐（滞回阈值，避免临界抖动）。
    const show = ownership.current === 'reading' && distance >= 96;
    setShowToLatest((current) => (current !== show ? show : current));
    // 导航高亮。
    const top = box.getBoundingClientRect().top;
    let idx = 0;
    thread.messages.forEach((m, i) => {
      const el = msgEls.current.get(m.id);
      if (el && el.getBoundingClientRect().top - top <= 180) idx = i;
    });
    setActiveIdx(idx);
  }, [thread.messages]);

  const scrollToBottom = useCallback((smooth = false) => {
    const box = ref.current;
    if (!box) return;
    ownership.current = 'following';
    setShowToLatest(false);
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    box.scrollTo({ top: max, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const jumpTo = (index: number) => {
    const box = ref.current;
    const m = thread.messages[index];
    const el = m ? msgEls.current.get(m.id) : undefined;
    if (!el || !box) return;
    ownership.current = index === thread.messages.length - 1 ? 'following' : 'reading';
    setShowToLatest(ownership.current === 'reading');
    setActiveIdx(index);
    const top = box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - 90;
    box.scrollTo({ top, behavior: 'smooth' });
  };

  const setMsgRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) msgEls.current.set(id, el);
    else msgEls.current.delete(id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-4">
        <Folder size={15} className="shrink-0 text-[var(--text-2)]" />
        {project && (
          <>
            <span className="max-w-[160px] shrink-0 truncate text-[13.5px] text-[var(--text-3)]" title={project.path}>
              {project.name}
            </span>
            <span className="text-[var(--text-3)]">/</span>
          </>
        )}
        {renaming ? (
          <RenameInput initial={thread.title} onSubmit={onRenameSubmit} onCancel={onRenameCancel} className="w-[320px] max-w-full" />
        ) : (
          <span className="truncate text-[14px] font-medium text-[var(--text)]">{thread.title}</span>
        )}
        <div className="flex-1" />
        <button
          ref={moreRef}
          title="更多"
          onClick={() => {
            const r = moreRef.current!.getBoundingClientRect();
            onMenu(r.right - 236, r.bottom + 6);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          <MoreHorizontal size={16} />
        </button>
        <IconBtn title="切换侧边面板" active={rightOpen} onClick={onToggleRight}>
          <ListTodo size={16} />
        </IconBtn>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={ref} onScroll={handleScroll} className="scroll-thin h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] pb-10 pl-12 pr-6 pt-6">
            {thread.messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} ref={setMsgRef(m.id)} className="fade-in my-6 flex scroll-mt-24 justify-end">
                  <div className="group/u max-w-[78%]">
                    <div className="whitespace-pre-wrap rounded-[20px] border border-[var(--border-strong)]/60 bg-[var(--bg-bubble)] px-4 py-3 text-[14px] leading-[24px] text-[var(--text)]">
                      {m.content.length > 4000 ? `${m.content.slice(0, 4000)}…` : m.content}
                    </div>
                  </div>
                </div>
              ) : (
                <div key={m.id} ref={setMsgRef(m.id)} className="fade-in my-5 scroll-mt-24">
                  <AssistantMsg m={m} onView={onViewChanges} onToast={onToast} onLink={onOpenLink} />
                </div>
              ),
            )}
          </div>
        </div>

        {/* 回到底部按钮：仅跟随权在用户手里且离底较远时出现 */}
        {showToLatest && thread.messages.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center pr-10">
            <button
              onClick={() => scrollToBottom(true)}
              title="回到底部"
              className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-elev)] text-[var(--text-2)] shadow-lg shadow-black/20 transition-[transform,opacity] hover:text-[var(--text)] active:scale-95"
            >
              <ArrowDown size={15} />
            </button>
          </div>
        )}

        <MessageNavigator key={thread.id} messages={thread.messages} activeIndex={activeIdx} onJump={jumpTo} />
      </div>
    </div>
  );
}
