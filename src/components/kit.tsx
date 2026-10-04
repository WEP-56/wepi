import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';

export function Modal({
  onClose,
  title,
  children,
  width = 520,
}: {
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div
      className="fade-in fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{ width, maxWidth: '100%' }}
        className="scroll-thin max-h-full overflow-y-auto rounded-[22px] border border-[var(--border-strong)] bg-[var(--bg-elev)] p-6 shadow-2xl shadow-black/50"
      >
        <div className="mb-5 flex items-start">
          <h2 className="flex-1 text-[22px] font-semibold text-[var(--text)]">{title}</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <X size={17} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const variants = {
  primary: 'rounded-full bg-[var(--text)] px-5 py-2 text-[var(--bg-main)] hover:opacity-90',
  ghost: 'rounded-full px-4 py-2 text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]',
  outline: 'rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-[var(--text)] hover:bg-[var(--bg-hover)]',
  danger: 'rounded-lg border border-[#f85149]/40 px-3 py-1.5 text-[#f85149] hover:bg-[#f85149]/10',
};

export function Btn({
  variant = 'outline',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variants[variant],
        className,
      )}
    />
  );
}

export const inputCls =
  'h-10 w-full rounded-xl border border-[var(--border-strong)] bg-transparent px-3 text-[13.5px] text-[var(--text)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--blue)]';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <div className="mb-1.5 text-[13px] font-medium text-[var(--text)]">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[12px] text-[var(--text-3)]">{hint}</div>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-[var(--bg-hover)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1 text-[13px] text-[var(--text-2)] transition-colors hover:text-[var(--text)]',
            value === o.value && 'bg-[var(--bg-elev)] text-[var(--text)] shadow-sm',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PageShell({
  title,
  desc,
  actions,
  children,
}: {
  title: string;
  desc?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="scroll-thin min-w-0 flex-1 overflow-y-auto bg-[var(--bg-main)]">
      <div className="fade-in mx-auto max-w-[820px] px-10 pb-16 pt-12">
        <div className="mb-8 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[28px] font-medium text-[var(--text)]">{title}</h2>
            {desc && <p className="mt-2 max-w-[580px] text-[13.5px] leading-6 text-[var(--text-2)]">{desc}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]', className)}>{children}</div>
  );
}

/** 行内重命名输入框：Enter / 失焦提交，Esc 取消 */
export function RenameInput({
  initial,
  onSubmit,
  onCancel,
  className,
}: {
  initial: string;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    if (ok && v.trim() && v.trim() !== initial) onSubmit(v.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={v}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className={cn(
        'min-w-0 rounded-lg border border-[var(--blue)] bg-transparent px-2 py-[4px] text-[13.5px] text-[var(--text)] outline-none',
        className,
      )}
    />
  );
}
