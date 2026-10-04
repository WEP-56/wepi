import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { efforts, type ModelOption, type ReasoningEffort } from '../data';
import { cn } from '../utils/cn';

export const effortLabel = (e: ReasoningEffort) => e.charAt(0).toUpperCase() + e.slice(1);

const hints: Record<ReasoningEffort, string> = {
  off: '关闭深度思考，响应最快',
  minimal: '轻量思考，适合简单问答',
  low: '响应最快，适合小改动与问答',
  medium: '速度与深度均衡，推荐日常使用',
  high: '更深入的推理，适合复杂任务',
  xhigh: '极深推理，响应会明显变慢',
  max: '最大推理深度，响应会明显变慢',
};

const THUMB = 26;
const PAD = THUMB / 2;
const LAST = efforts.length - 1;
/** 把 0–1 的比例换算成轨道内的位置（两端为滑块半径留白，滑块不会溢出轨道） */
const pos = (ratio: number) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${ratio})`;

function EffortSlider({ index, onChange }: { index: number; onChange: (i: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const ratio = index / LAST;
  const ultra = index === LAST;

  const pick = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const usable = Math.max(1, r.width - PAD * 2);
    const x = Math.min(Math.max(clientX - r.left - PAD, 0), usable);
    onChange(Math.round((x / usable) * LAST));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    setDragging(true);
    pick(e.clientX);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
    if (e.key in step) {
      e.preventDefault();
      onChange(Math.min(LAST, Math.max(0, index + step[e.key])));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onChange(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onChange(LAST);
    }
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={LAST}
      aria-valuenow={index}
      aria-valuetext={effortLabel(efforts[index])}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => dragging && pick(e.clientX)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={onKeyDown}
      className="group relative h-3 cursor-pointer touch-none select-none rounded-full bg-[var(--bg-active)] outline-none"
    >
      <div
        className={cn('absolute inset-y-0 left-0 rounded-full', !dragging && 'transition-[width] duration-200 ease-out')}
        style={{ width: pos(ratio), background: ultra ? 'var(--effort-gradient)' : 'var(--blue)' }}
      />
      {efforts.map((e, i) => (
        <span
          key={e}
          className={cn(
            'absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity',
            i < index ? 'bg-white/40' : 'bg-[var(--text-3)]/50',
            i === index && 'opacity-0',
          )}
          style={{ left: pos(i / LAST) }}
        />
      ))}
      <div
        className={cn(
          'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-1 ring-black/10',
          'shadow-[0_1px_2px_rgba(0,0,0,0.25),0_3px_10px_rgba(0,0,0,0.28)]',
          !dragging && 'transition-[left,transform] duration-200 ease-out',
          dragging ? 'scale-105' : 'group-hover:scale-105',
          'group-focus-visible:ring-2 group-focus-visible:ring-[var(--blue)]',
        )}
        style={{ left: pos(ratio), width: THUMB, height: THUMB }}
      />
    </div>
  );
}

export default function ModelEffortPanel({
  model,
  modelOptions,
  effort,
  effortOptions = efforts,
  onEffort,
  onModel,
}: {
  model: ModelOption | undefined;
  modelOptions: ModelOption[];
  effort: ReasoningEffort;
  effortOptions?: readonly ReasoningEffort[];
  onEffort: (e: ReasoningEffort) => void;
  onModel: (id: string) => void;
}) {
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const levels = effortOptions.length ? effortOptions : efforts;
  const index = Math.max(0, levels.indexOf(effort));
  const current = levels[index] ?? levels[0];
  const ultra = current === 'xhigh' || current === 'max';
  const providers = Array.from(new Set(modelOptions.map((m) => m.provider)));

  if (view === 'models')
    return (
      <div className="fade-in pb-1">
        <div className="flex items-center gap-1 px-1 pt-1">
          <button
            onClick={() => setView('effort')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-[13px] font-medium text-[var(--text)]">模型</span>
        </div>
        <div className="mx-2 my-1 h-px bg-[var(--border)]" />
        <div className="scroll-thin max-h-[300px] overflow-y-auto">
          {modelOptions.length === 0 && (
            <div className="px-2.5 py-3 text-[12.5px] leading-5 text-[var(--text-3)]">
              没有可用模型，请先在「提供商配置」中启用提供商并添加模型。
            </div>
          )}
          {providers.map((pv) => (
            <div key={pv}>
              <div className="px-2.5 pb-0.5 pt-1.5 text-[11px] text-[var(--text-3)]">{pv}</div>
              {modelOptions
                .filter((m) => m.provider === pv)
                .map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      onModel(m.id);
                      setView('effort');
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--bg-hover)]',
                      model?.id === m.id && 'bg-[var(--bg-active)]',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--text)]">{m.name}</span>
                    {model?.id === m.id && <Check size={14} className="shrink-0 text-[var(--text)]" />}
                  </button>
                ))}
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="fade-in px-3 pb-4 pt-3">
      <div className="relative">
        <button
          title="重置为 Medium"
          disabled={current === 'medium'}
          onClick={() => onEffort(levels.includes('medium') ? 'medium' : levels[0])}
          className="absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <RotateCcw size={14} />
        </button>
        <div
          key={current}
          className={cn(
            'fade-in text-center text-[16px] font-semibold leading-5 tracking-wide',
            ultra ? 'effort-ultra-text' : 'text-[var(--blue)]',
          )}
        >
          {effortLabel(current)}
        </div>
        <button
          onClick={() => setView('models')}
          className="mx-auto mt-1 flex max-w-full items-center gap-0.5 rounded-md py-0.5 pl-1.5 pr-0.5 text-[12.5px] text-[var(--text-2)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          <span className="truncate">{model ? model.name : '选择模型'}</span>
          <ChevronRight size={13} className="shrink-0" />
        </button>
      </div>

      <div className="mt-3 flex h-7 items-center justify-center">
        {ultra ? (
          <span
            key="ultra"
            className="fade-in rounded-lg border border-[var(--border-strong)] bg-[var(--bg-app)] px-3 py-1 text-[12px] font-medium text-[var(--text)] shadow-lg shadow-black/20"
          >
            {hints[current]}
          </span>
        ) : (
          <span key={current} className="fade-in text-[12px] text-[var(--text-3)]">
            {hints[current]}
          </span>
        )}
      </div>

      <div className="mt-2 px-0.5">
        <EffortSlider index={index} onChange={(i) => onEffort(levels[i])} />
      </div>
    </div>
  );
}
