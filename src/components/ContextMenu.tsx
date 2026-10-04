import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '../utils/cn';

export interface CtxItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick?: () => void;
  divider?: boolean;
  disabled?: boolean;
  checked?: boolean;
  submenu?: CtxItem[];
}

function Panel({ items, onClose, style }: { items: CtxItem[]; onClose: () => void; style?: CSSProperties }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <div
      style={style}
      className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-2xl shadow-black/40"
    >
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="mx-2 my-1 h-px bg-[var(--border)]" />
        ) : (
          <Row key={i} item={it} open={sub === i} onHover={() => setSub(it.submenu ? i : null)} onClose={onClose} />
        ),
      )}
    </div>
  );
}

function Row({
  item,
  open,
  onHover,
  onClose,
}: {
  item: CtxItem;
  open: boolean;
  onHover: () => void;
  onClose: () => void;
}) {
  return (
    <div className="relative" onMouseEnter={onHover}>
      <button
        disabled={item.disabled}
        onClick={() => {
          if (item.submenu) return;
          onClose();
          item.onClick?.();
        }}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:hover:bg-transparent',
          open && 'bg-[var(--bg-hover)]',
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-2)]">{item.icon}</span>
        <span className="flex-1 truncate">{item.label}</span>
        {item.checked && <Check size={14} className="shrink-0" />}
        {item.shortcut && <span className="ml-3 shrink-0 text-[11.5px] text-[var(--text-3)]">{item.shortcut}</span>}
        {item.submenu && <ChevronRight size={14} className="shrink-0 text-[var(--text-3)]" />}
      </button>
      {item.submenu && open && <SubMenu items={item.submenu} onClose={onClose} />}
    </div>
  );
}

function SubMenu({ items, onClose }: { items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState({ flip: false, dy: 0 });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setSt({
      flip: r.right > window.innerWidth - 6,
      dy: r.bottom > window.innerHeight - 6 ? window.innerHeight - 6 - r.bottom : 0,
    });
  }, []);
  return (
    <div
      ref={ref}
      className="absolute z-10 w-[212px]"
      style={{
        top: -5 + st.dy,
        ...(st.flip ? { right: 'calc(100% - 4px)' } : { left: 'calc(100% - 4px)' }),
      }}
    >
      <Panel items={items} onClose={onClose} />
    </div>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      top: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={pos}
      className="fade-in fixed z-[200] w-[236px]"
      // 保持输入框焦点与选区，便于「粘贴 / 全选」作用于原目标
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Panel items={items} onClose={onClose} />
    </div>
  );
}
