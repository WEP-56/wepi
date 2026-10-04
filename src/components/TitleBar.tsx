import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowLeft, ArrowRight, PanelLeft, Minus, Square, X, Copy } from 'lucide-react';
import { useClickOutside, MenuItem } from './ui';
import { cn } from '../utils/cn';

export interface MenuAction {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  divider?: boolean;
}

export default function TitleBar({
  onToggleSidebar,
  menus,
  canBack,
  canForward,
  onBack,
  onForward,
  onToast,
}: {
  onToggleSidebar: () => void;
  menus: Record<string, MenuAction[]>;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onToast: (s: string) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [max, setMax] = useState(false);
  const ref = useClickOutside(!!openMenu, () => setOpenMenu(null));
  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const syncMax = () => {
      void appWindow.isMaximized().then((value) => {
        if (!disposed) setMax(value);
      }).catch(console.error);
    };
    syncMax();
    const listener = appWindow.onResized(syncMax);
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(console.error);
    };
  }, []);

  const controlWindow = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!isTauri()) {
      onToast('请在桌面应用中使用窗口控制');
      return;
    }
    try {
      await getCurrentWindow()[action]();
    } catch (error) {
      console.error(error);
      onToast('窗口操作失败');
    }
  };

  return (
    <div className="flex h-9 shrink-0 select-none items-center bg-[var(--bg-app)] text-[var(--text-2)]">
      <div className="flex items-center gap-0.5 pl-2">
        <button
          onClick={onBack}
          disabled={!canBack}
          className="flex h-7 w-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          onClick={onForward}
          disabled={!canForward}
          className="flex h-7 w-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <ArrowRight size={15} />
        </button>
        <button
          onClick={onToggleSidebar}
          title="切换边栏 (Ctrl+B)"
          className="flex h-7 w-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
        >
          <PanelLeft size={15} />
        </button>
      </div>
      <div ref={ref} className="ml-3 flex items-center">
        {Object.keys(menus).map((name) => (
          <div key={name} className="relative">
            <button
              onClick={() => setOpenMenu(openMenu === name ? null : name)}
              onMouseEnter={() => openMenu && setOpenMenu(name)}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)]',
                openMenu === name && 'bg-[var(--bg-active)]',
              )}
            >
              {name}
            </button>
            {openMenu === name && (
              <div className="fade-in absolute left-0 top-full z-50 mt-1 w-60 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-2xl shadow-black/30">
                {menus[name].map((m, i) =>
                  m.divider ? (
                    <div key={i} className="mx-2 my-1 h-px bg-[var(--border)]" />
                  ) : (
                    <MenuItem
                      key={i}
                      right={m.shortcut}
                      onClick={() => {
                        setOpenMenu(null);
                        m.onClick?.();
                      }}
                    >
                      {m.label}
                    </MenuItem>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div data-tauri-drag-region className="h-full flex-1" />
      <div className="flex h-full items-stretch">
        <button aria-label="最小化" onClick={() => void controlWindow('minimize')} className="flex w-[46px] items-center justify-center hover:bg-[var(--bg-hover)]">
          <Minus size={15} strokeWidth={1.4} />
        </button>
        <button aria-label={max ? '还原' : '最大化'} onClick={() => void controlWindow('toggleMaximize')} className="flex w-[46px] items-center justify-center hover:bg-[var(--bg-hover)]">
          {max ? <Copy size={12} strokeWidth={1.4} className="-scale-x-100" /> : <Square size={12} strokeWidth={1.4} />}
        </button>
        <button aria-label="关闭" onClick={() => void controlWindow('close')} className="flex w-[46px] items-center justify-center hover:bg-[#e81123] hover:text-white">
          <X size={16} strokeWidth={1.4} />
        </button>
      </div>
    </div>
  );
}
