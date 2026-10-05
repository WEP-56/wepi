import { useEffect, useRef } from 'react';
import { Sparkles, SquareTerminal, Zap } from 'lucide-react';
import { cn } from '../utils/cn';
import type { SlashCommand } from '../lib/slashCommands';

/** 命令来源 → 图标：内置命令用闪电，技能用星花，其余用终端符。 */
function CommandIcon({ source }: { source: SlashCommand['source'] }) {
  if (source === 'builtin') return <Zap size={13} className="text-[var(--blue)]" />;
  if (source === 'skill') return <Sparkles size={13} className="text-[#c6a15b]" />;
  return <SquareTerminal size={13} className="text-[var(--text-2)]" />;
}

/**
 * 输入框上方的斜杠命令菜单。
 * 键盘导航（↑/↓/Enter/Tab/Esc）由 Composer 的 onKeyDown 驱动，
 * 这里只负责呈现与鼠标交互（hover 高亮、点击选中）。
 */
export function SlashMenu({
  query,
  commands,
  highlighted,
  onHighlight,
  onSelect,
}: {
  query: string;
  commands: readonly SlashCommand[];
  highlighted: number;
  onHighlight: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 高亮项滚入可视区：键盘上下移动时跟随。
  useEffect(() => {
    const list = listRef.current;
    if (!list || commands.length === 0) return;
    const item = list.querySelector<HTMLElement>(`[data-cmd-index="${highlighted}"]`);
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [highlighted, commands.length]);

  return (
    <div
      role="menu"
      aria-label="斜杠命令"
      className="fade-in absolute bottom-[calc(100%+8px)] left-0 z-40 w-[min(520px,100%)] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-2xl shadow-black/30"
    >
      <div className="px-2 pb-1 pt-0.5 text-[11px] text-[var(--text-3)]">命令</div>
      <div ref={listRef} className="scroll-thin max-h-72 overflow-y-auto">
        {commands.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-[12px] text-[var(--text-3)]">
            {query ? `没有匹配「${query}」的命令` : '没有可用命令'}
          </div>
        ) : (
          commands.map((command, index) => (
            <button
              key={`${command.source}:${command.name}`}
              type="button"
              role="menuitem"
              aria-current={index === highlighted ? 'true' : undefined}
              data-cmd-index={index}
              tabIndex={-1}
              // mousedown 会抢走 textarea 焦点导致光标丢失，先拦下。
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => onHighlight(index)}
              onClick={() => onSelect(command)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--text)]',
                index === highlighted ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]',
              )}
            >
              <span className="flex w-4 shrink-0 justify-center">
                <CommandIcon source={command.source} />
              </span>
              <span className="min-w-0 shrink-0 font-mono text-[12.5px] text-[var(--blue)]">/{command.name}</span>
              {command.description && (
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-3)]" title={command.description}>
                  {command.description}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}