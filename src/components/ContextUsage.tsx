import { useState } from 'react';
import { CircleHelp } from 'lucide-react';

export type UsageSnapshot = {
  contextPercent: number;
  contextTokens: number;
  contextWindow: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCost: number;
};

const compact = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
const money = (value: number) => `$ ${value.toFixed(4)}`;

export default function ContextUsage({ usage }: { usage: UsageSnapshot }) {
  const [open, setOpen] = useState(false);
  const percent = Math.min(100, Math.max(0, usage.contextPercent));
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {open && (
        <div className="absolute bottom-[calc(100%+10px)] right-0 z-40 w-[248px] rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] p-3 text-[12.5px] shadow-2xl shadow-black/20">
          <div className="flex items-center justify-between font-semibold text-[var(--text-2)]"><span>上下文</span><span>{percent.toFixed(1)}%</span></div>
          <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-[var(--border)]"><span className="bg-[var(--text-2)]" style={{ width: `${percent}%` }} /></div>
          <div className="mt-2 flex justify-between text-[var(--text-2)]"><span>{compact(usage.contextTokens)}</span><span>{compact(usage.contextWindow)}</span></div>
          <div className="my-2 border-t border-[var(--border)]" />
          <div className="mb-2 font-semibold text-[var(--text-2)]">TOKEN 用量</div>
          <div className="space-y-1 text-[var(--text-2)]"><div className="flex justify-between"><span>输入</span><span className="text-[var(--text)]">{compact(usage.inputTokens)}</span></div><div className="flex justify-between"><span>输出</span><span className="text-[var(--text)]">{compact(usage.outputTokens)}</span></div><div className="flex justify-between"><span>缓存命中率</span><span className="text-[var(--text)]">{usage.inputTokens ? Math.round(usage.cacheReadTokens / usage.inputTokens * 100) : 0}%</span></div></div>
          <div className="my-2 border-t border-[var(--border)]" />
          <div className="flex justify-between text-[var(--text-2)]"><span>总计</span><span className="text-[var(--text)]">{compact(usage.inputTokens + usage.outputTokens)}</span></div>
          <div className="mt-2 flex justify-between rounded-md bg-[var(--bg-hover)] px-2 py-1.5"><span className="text-[var(--text-2)]">总费用</span><span className="font-mono text-[var(--text)]">{money(usage.totalCost)}</span></div>
        </div>
      )}
      <button type="button" title="查看上下文和用量" className="flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[12px] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
        <span>{percent.toFixed(1)}%</span><span className="relative h-4 w-4 rounded-full" style={{ background: `conic-gradient(var(--text-2) ${percent}%, var(--border-strong) 0)` }}><span className="absolute inset-[2px] rounded-full bg-[var(--bg-main)]" /></span><CircleHelp size={12} className="text-[var(--text-3)]" />
      </button>
    </div>
  );
}
