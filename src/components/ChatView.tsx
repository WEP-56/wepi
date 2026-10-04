import { memo, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import type { Message, Project, Thread, FileEdit, Step } from '../data';
import { StepList, StepsDisclosure } from './Steps';
import Markdown from './Markdown';
import MessageNavigator from './MessageNavigator';
import { Logo, IconBtn } from './ui';
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

/** 没有时间线数据时，用产物信息兜底生成一条简单时间线 */
function fallbackSteps(m: Message): Step[] {
  return (m.edits ?? []).map((e) => ({
    kind: 'action' as const,
    icon: 'edit' as const,
    label: `已编辑 ${e.file}`,
    detail: {
      kind: 'edit' as const,
      file: e.file,
      add: e.add,
      del: e.del,
      diff: [{ t: '+' as const, s: '（此处为示例界面，未包含完整差异）' }],
    },
  }));
}

function AssistantMsgBase({ m, onView, onToast }: { m: Message; onView: () => void; onToast: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const steps = m.steps ?? fallbackSteps(m);
  const hasSteps = steps.length > 0;
  // 回合进行中：过程默认展开，让工具调用实时可见（PiDeck 的 process 分组同思路）。
  const expanded = m.streaming ? true : open;
  return (
    <div className="group">
      {hasSteps && (
        <>
          <StepsDisclosure open={expanded} onToggle={() => setOpen((o) => !o)} duration={m.duration} steps={steps} running={m.streaming} />
          {expanded && <StepList steps={steps} />}
          {!m.streaming && <div className="my-3 h-px bg-[var(--border)]" />}
        </>
      )}
      {/* 思考是独立于正文的过程信息，折叠呈现；不再因为「正在思考」而隐藏已流出的正文。 */}
      {(m.thinking || m.thinkingContent) && (
        <div className="mb-2">
          <div className={cn('text-[13px]', m.thinking && 'shimmer-text font-medium')}>{m.thinking ? '正在思考…' : '已思考'}</div>
          {m.thinkingContent && (
            <details className="mt-1" open={!!m.thinking}>
              <summary className="cursor-default text-[12px] text-[var(--text-3)] hover:text-[var(--text-2)]">
                {m.thinking ? '' : '查看思考过程'}
              </summary>
              <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-[var(--border)] pl-2.5 text-[12.5px] leading-5 text-[var(--text-3)]">
                {m.thinkingContent}
              </div>
            </details>
          )}
        </div>
      )}
      <Markdown text={m.content} caret={m.streaming} />
      {m.edits && !m.streaming && <EditCard edits={m.edits} onView={onView} onToast={onToast} />}
      {!m.streaming && (
        <div className="mt-3 flex items-center gap-1 text-[var(--text-3)]">
          <button
            onClick={() => { navigator.clipboard?.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button onClick={() => onToast('已复制分享链接')} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
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
      <Logo size={50} className="text-[var(--text-2)]" />
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const msgEls = useRef(new Map<string, HTMLDivElement>());
  const stick = useRef(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const last = thread.messages[thread.messages.length - 1];

  useEffect(() => {
    stick.current = true;
    setActiveIdx(0);
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useEffect(() => {
    if (stick.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.messages.length]);

  useEffect(() => {
    if (stick.current) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [last?.content]);

  const updateActive = () => {
    const box = ref.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let idx = 0;
    thread.messages.forEach((m, i) => {
      const el = msgEls.current.get(m.id);
      if (!el) return;
      if (el.getBoundingClientRect().top - top <= 180) idx = i;
    });
    setActiveIdx(idx);
    stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  };

  const jumpTo = (index: number) => {
    const box = ref.current;
    const m = thread.messages[index];
    const el = m ? msgEls.current.get(m.id) : undefined;
    if (!el || !box) return;
    stick.current = index === thread.messages.length - 1;
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
        <div ref={ref} onScroll={updateActive} className="scroll-thin h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] pb-10 pl-12 pr-6 pt-6">
            {thread.messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} ref={setMsgRef(m.id)} className="fade-in my-8 flex scroll-mt-24 justify-end">
                  <div className="max-w-[78%] whitespace-pre-wrap rounded-[22px] bg-[var(--bg-bubble)] px-4 py-3 text-[14px] leading-[24px] text-[var(--text)]">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} ref={setMsgRef(m.id)} className="fade-in my-6 scroll-mt-24">
                  <AssistantMsg m={m} onView={onViewChanges} onToast={onToast} />
                </div>
              ),
            )}
          </div>
        </div>
        <MessageNavigator key={thread.id} messages={thread.messages} activeIndex={activeIdx} onJump={jumpTo} />
      </div>
    </div>
  );
}
