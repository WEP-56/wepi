import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../utils/cn';

export function Logo({ size = 52, className }: { size?: number; className?: string }) {
  // scalloped cloud with terminal prompt
  const n = 9;
  const R = 20;
  const cx = 26;
  const cy = 26;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  });
  const chord = 2 * R * Math.sin(Math.PI / n);
  const r = chord * 0.62;
  let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} `;
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n];
    d += `A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${p[0].toFixed(2)} ${p[1].toFixed(2)} `;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" fill="none" className={className}>
      <path d={d + 'Z'} stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
      <path d="M17 21.5 L22 26 L17 30.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M26 31 H34" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconBtn({
  children,
  onClick,
  title,
  active,
  className,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent',
        active && 'bg-[var(--bg-active)] text-[var(--text)]',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function useClickOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open, onClose]);
  return ref;
}

export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  width = 220,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          style={{ width }}
          className={cn(
            'fade-in absolute z-50 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-2xl shadow-black/30',
            align === 'left' ? 'left-0' : 'right-0',
            side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  right,
  icon,
  danger,
  selected,
}: {
  children: ReactNode;
  onClick?: () => void;
  right?: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  selected?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)]',
        danger && 'text-[var(--orange)]',
        selected && 'bg-[var(--bg-active)]',
      )}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center text-[var(--text-2)]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right && <span className="shrink-0 text-[11px] text-[var(--text-3)]">{right}</span>}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--text-2)]">{children}</span>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={cn(
        'relative h-[22px] w-[36px] shrink-0 rounded-full transition-colors',
        on ? 'bg-[var(--blue)]' : 'bg-[var(--border-strong)]',
      )}
    >
      <span
        className={cn(
          'absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all',
          on ? 'left-[17px]' : 'left-[3px]',
        )}
      />
    </button>
  );
}
