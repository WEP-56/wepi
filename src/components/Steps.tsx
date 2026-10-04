import { useState } from 'react';
import {
  ChevronDown,
  FileText,
  SquareTerminal,
  Pencil,
  Search,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import type { DiffLine, Step, StepDetail, TermLine } from '../data';
import Markdown from './Markdown';
import { cn } from '../utils/cn';

/** 1047 -> 17m 27s */
export function formatDuration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const stepIcon = (icon: Step['icon']) => {
  switch (icon) {
    case 'file':
      return FileText;
    case 'command':
      return SquareTerminal;
    case 'edit':
      return Pencil;
    case 'search':
      return Search;
    default:
      return Sparkles;
  }
};

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-3)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function Shell({ command, lines }: { command: string; lines: TermLine[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] text-[var(--text-3)]">
        Shell
        <span className="flex-1" />
        <CopyButton value={[command, ...lines.map((l) => l.s)].join('\n')} />
      </div>
      <div className="scroll-thin overflow-x-auto px-3 pb-3">
        <pre className="font-mono text-[12px] leading-[19px]">
          <div className="text-[var(--text)]">
            <span className="text-[var(--text-3)]">$ </span>
            {command}
          </div>
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-words',
                l.t === 'add' && 'text-[#3fb950]',
                l.t === 'del' && 'text-[#f85149]',
                l.t === 'err' && 'text-[#f85149]',
                l.t === 'cmd' && 'text-[var(--text)]',
                !l.t && 'text-[var(--text-2)]',
              )}
            >
              {l.s || '\u00a0'}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function ReadFile({ file, lines }: { file: string; lines: TermLine[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11.5px] text-[var(--text-2)]">
        <FileText size={12} className="text-[var(--text-3)]" />
        <span className="truncate font-mono">{file}</span>
        <span className="flex-1" />
        <CopyButton value={lines.map((l) => l.s).join('\n')} />
      </div>
      <div className="scroll-thin overflow-x-auto px-2 py-2">
        <pre className="font-mono text-[12px] leading-[19px]">
          {lines.map((l, i) => (
            <div key={i} className="flex">
              <span className="w-8 shrink-0 select-none text-right text-[var(--text-3)]">{i + 1}</span>
              <span className="pl-3 text-[var(--text-2)]">{l.s || '\u00a0'}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function DiffBlock({ file, add, del, diff }: { file: string; add: number; del: number; diff: DiffLine[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-[11.5px] text-[var(--text-2)]">
        <Pencil size={12} className="text-[var(--text-3)]" />
        <span className="truncate font-mono">{file}</span>
        <span className="flex-1" />
        <span className="text-[#3fb950]">+{add}</span>
        <span className="text-[#f85149]">-{del}</span>
      </div>
      <div className="scroll-thin overflow-x-auto py-1.5">
        <pre className="font-mono text-[12px] leading-[19px]">
          {diff.map((l, i) => (
            <div
              key={i}
              className={cn(
                'flex px-3',
                l.t === '+' && 'bg-[#3fb950]/12 text-[#3fb950]',
                l.t === '-' && 'bg-[#f85149]/12 text-[#f85149]',
                l.t === ' ' && 'text-[var(--text-2)]',
              )}
            >
              <span className="w-4 select-none text-[var(--text-3)]">{l.t === ' ' ? '' : l.t}</span>
              <span className="whitespace-pre">{l.s || '\u00a0'}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

function Detail({ detail }: { detail: StepDetail }) {
  if (detail.kind === 'command') return <Shell command={detail.command} lines={detail.lines} />;
  if (detail.kind === 'read') return <ReadFile file={detail.file} lines={detail.lines} />;
  if (detail.kind === 'edit') return <DiffBlock file={detail.file} add={detail.add} del={detail.del} diff={detail.diff} />;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2.5 text-[12.5px] leading-5 text-[var(--text-2)]">
      {detail.text}
    </div>
  );
}

function ActionRow({ step, defaultOpen }: { step: Step; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const Icon = stepIcon(step.icon);
  const expandable = !!step.detail;
  const edit = step.detail?.kind === 'edit' ? step.detail : null;

  return (
    <div className="task-action">
      <button
        onClick={() => expandable && setOpen(!open)}
        className={cn(
          'group/action -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 py-[4px] text-left transition-colors',
          expandable ? 'cursor-pointer hover:bg-[var(--bg-hover)]' : 'cursor-default',
          open && 'bg-[var(--bg-hover)]',
        )}
      >
        <Icon size={13} strokeWidth={1.7} className="shrink-0 text-[var(--text-3)]" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-2)] group-hover/action:text-[var(--text)]">
          {step.label}
        </span>
        {edit && (
          <span className="shrink-0 font-mono text-[11.5px]">
            <span className="text-[#3fb950]">+{edit.add}</span>{' '}
            <span className="text-[#f85149]">-{edit.del}</span>
          </span>
        )}
        {expandable && (
          <ChevronDown
            size={13}
            className={cn('shrink-0 text-[var(--text-3)] transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      {open && step.detail && (
        <div className="fade-in ml-5 mt-1.5">
          <Detail detail={step.detail} />
        </div>
      )}
    </div>
  );
}

/** 用时 17m 27s —— 展开后可见叙述与动作时间线 */
export function StepsDisclosure({
  open,
  onToggle,
  duration,
  steps,
  running,
}: {
  open: boolean;
  onToggle: () => void;
  duration?: number;
  steps: Step[];
  running?: boolean;
}) {
  const actions = steps.filter((s) => s.kind === 'action').length;
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        'group/dur flex w-full items-center gap-1 border-b border-[var(--border)] py-1.5 text-left text-[13px] text-[var(--text-3)] transition-colors hover:text-[var(--text-2)]',
        open && 'text-[var(--text-2)]',
      )}
    >
      {running ? (
        <span className="shimmer-text">执行中…</span>
      ) : (
        <span>用时 {formatDuration(duration ?? 0)}</span>
      )}
      <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
      {actions > 0 && (
        <span className="ml-1 text-[11.5px] text-[var(--text-3)] opacity-0 transition-opacity group-hover/dur:opacity-100">
          {actions} 个动作
        </span>
      )}
    </button>
  );
}

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <div className="scroll-thin my-2 max-h-[440px] space-y-0.5 overflow-y-auto pr-1">
      {steps.map((step, i) =>
        step.kind === 'text' ? (
          <div key={i} className="py-0.5 text-[13.5px] leading-[23px] text-[var(--text)]">
            <Markdown text={step.text ?? ''} />
          </div>
        ) : (
          <ActionRow key={i} step={step} />
        ),
      )}
    </div>
  );
}
