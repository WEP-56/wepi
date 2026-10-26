import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, Camera, ChevronDown, Circle, Lock, Moon, Power, Smartphone, Square, Sun } from 'lucide-react';
import { IconBtn, MenuItem, Popover } from './ui';
import { cn } from '../utils/cn';
import { isDesktopRuntime } from '../lib/piRpc';
import { errorText } from '../lib/workspace';

/**
 * 模拟器面板：Android 模拟器的实时画面 + 点击/拖拽/滚轮/键盘输入 + 一排硬件按钮。
 *
 * 画面由 Rust 侧每 ~120ms 截一次并缩到 540 宽（JPEG），前端长轮询取帧。
 * 坐标换算：屏幕按 `object-contain` 铺在容器里，先把点击位置还原到图片矩形，
 * 再按 dp 尺寸映射——发出去的永远是 dp，和 agent 工具完全同一套坐标。
 */

export type SimDevice = { udid: string; name: string; runtime: string; state: string };
export type SimScreen = { width: number; height: number; scale: number };
export type SimStatus = {
  available: boolean;
  sdk: string;
  error: string | null;
  devices: SimDevice[];
  selected: string | null;
  screen: SimScreen | null;
};

const TAP_SLOP = 8;
const LONG_PRESS_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** `object-contain` 之后图片真正占的那块矩形（容器里可能留黑边）。 */
function drawn(rect: DOMRect, screen: SimScreen) {
  const scale = Math.min(rect.width / screen.width, rect.height / screen.height);
  const width = screen.width * scale;
  const height = screen.height * scale;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

export default function SimulatorView({ active }: { active: boolean }) {
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dark, setDark] = useState(false);
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number; on: boolean } | null>(null);
  const frameUrl = useRef<string | null>(null);
  const seq = useRef(0);
  const gesture = useRef<{ x: number; y: number; px: number; py: number; at: number; moved: boolean } | null>(null);
  const scroll = useRef({ dy: 0, at: { x: 0, y: 0 }, timer: 0 });
  const typing = useRef({ text: '', timer: 0 });

  const device = status?.devices.find((item) => item.udid === status.selected) ?? null;
  const running = device?.state === 'Running';

  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) {
      setStatus({ available: false, sdk: '', error: '模拟器只在 WEPI 桌面端可用', devices: [], selected: null, screen: null });
      return;
    }
    try {
      setStatus(await invoke<SimStatus>('simulator_status'));
    } catch (cause) {
      setNotice(errorText(cause));
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // 没在跑的时候轮询状态：用户可能在 Android Studio 里启动/关闭了模拟器，
  // 面板要自己跟上，而不是停在一个再也点不动的画面。
  useEffect(() => {
    if (!active || running) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [active, running, refresh]);

  // 帧泵：只在面板可见且设备在跑时转；Rust 侧 6 秒没人要帧就自己停。
  useEffect(() => {
    if (!active || !status?.selected || !running) return;
    const udid = status.selected;
    let cancelled = false;
    void (async () => {
      let failures = 0;
      while (!cancelled) {
        try {
          const data = await invoke<ArrayBuffer>('simulator_frame', { udid, after: seq.current });
          if (cancelled) return;
          if (data && data.byteLength > 8) {
            seq.current = Number(new DataView(data).getBigUint64(0, true));
            const url = URL.createObjectURL(new Blob([data.slice(8)], { type: 'image/jpeg' }));
            const previous = frameUrl.current;
            frameUrl.current = url;
            setFrame(url);
            if (previous) URL.revokeObjectURL(previous);
            failures = 0;
          }
        } catch (cause) {
          if (cancelled) return;
          if (++failures >= 3) {
            setNotice(errorText(cause));
            await sleep(2000);
            void refresh();
            return;
          }
          await sleep(500);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [active, status?.selected, running, refresh]);

  useEffect(() => () => {
    if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
  }, []);

  // 水波纹：下一帧再切到"扩散+淡出"，否则初始态和终态在同一帧里，CSS 不会过渡。
  useEffect(() => {
    if (!ripple || ripple.on) return;
    const handle = requestAnimationFrame(() => setRipple((old) => (old && old.key === ripple.key ? { ...old, on: true } : old)));
    return () => cancelAnimationFrame(handle);
  }, [ripple]);

  const send = async (input: unknown) => {
    if (!status?.selected) return;
    try {
      await invoke('simulator_input', { udid: status.selected, input });
    } catch (cause) {
      setNotice(errorText(cause));
    }
  };

  const flushTyping = () => {
    const text = typing.current.text;
    typing.current.text = '';
    window.clearTimeout(typing.current.timer);
    if (text) void send({ kind: 'type', text });
  };

  /** 屏幕坐标：把客户端坐标还原成 dp。落在画面外返回 null。 */
  const pointOf = (element: HTMLElement, clientX: number, clientY: number) => {
    const screen = status?.screen;
    if (!screen) return null;
    const box = drawn(element.getBoundingClientRect(), screen);
    if (box.width <= 0 || box.height <= 0) return null;
    const x = ((clientX - box.left) / box.width) * screen.width;
    const y = ((clientY - box.top) / box.height) * screen.height;
    if (x < 0 || y < 0 || x > screen.width || y > screen.height) return null;
    return { x, y };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!running) return;
    const point = pointOf(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    // 画面本身要等一次截图（~0.4s），先在本地画个水波纹：
    // 手指按下立刻有反馈，"跟手"的感觉大半来自这里。
    const box = event.currentTarget.getBoundingClientRect();
    setRipple({ x: event.clientX - box.left, y: event.clientY - box.top, key: Date.now(), on: false });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    gesture.current = { ...point, px: event.clientX, py: event.clientY, at: Date.now(), moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (Math.hypot(event.clientX - current.px, event.clientY - current.py) > TAP_SLOP) current.moved = true;
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current) return;
    const end = pointOf(event.currentTarget, event.clientX, event.clientY);
    if (!end) return;
    if (current.moved) {
      void send({ kind: 'swipe', x: current.x, y: current.y, endX: end.x, endY: end.y, durationMs: 220 });
    } else if (Date.now() - current.at >= LONG_PRESS_MS) {
      void send({ kind: 'longPress', x: current.x, y: current.y, durationMs: 800 });
    } else {
      void send({ kind: 'tap', x: current.x, y: current.y });
    }
  };

  // 滚轮不是真滚动：攒 90ms 合成一次 swipe（设备只认手势）。
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const screen = status?.screen;
    if (!running || !screen) return;
    const point = pointOf(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const state = scroll.current;
    if (!state.dy) state.at = point;
    state.dy += event.deltaY;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      const { dy, at } = state;
      state.dy = 0;
      const limit = screen.height * 0.38;
      const delta = Math.max(-limit, Math.min(limit, dy * 1.2));
      if (Math.abs(delta) < 8) return;
      const endY = Math.max(1, Math.min(screen.height - 1, at.y - delta));
      void send({ kind: 'swipe', x: at.x, y: at.y, endX: at.x, endY, durationMs: 220 });
    }, 90);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!running) return;
    const special: Record<string, string> = {
      Enter: 'return',
      Backspace: 'backspace',
      Tab: 'tab',
      Escape: 'escape',
      Delete: 'delete',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
      ' ': 'space',
    };
    const key = special[event.key];
    if (key) {
      event.preventDefault();
      flushTyping();
      void send({ kind: 'key', key });
      return;
    }
    // Android 的 input text 只吃可打印 ASCII；中文等输入法文本在这里直接忽略。
    if (event.key.length === 1 && /^[\x20-\x7e]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      typing.current.text += event.key;
      window.clearTimeout(typing.current.timer);
      typing.current.timer = window.setTimeout(flushTyping, 140);
    }
  };

  const power = async () => {
    if (!device) return;
    setBusy(true);
    setNotice(running ? '正在关机…' : '正在启动模拟器（首次可能要一分钟）…');
    try {
      setStatus(await invoke<SimStatus>('simulator_power', { udid: device.udid, on: !running }));
      setNotice('');
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const select = async (udid: string) => {
    try {
      setStatus(await invoke<SimStatus>('simulator_select', { udid }));
      setNotice('');
    } catch (cause) {
      setNotice(errorText(cause));
    }
  };

  const appearance = async () => {
    if (!device || !running) return;
    const next = !dark;
    setDark(next);
    try {
      await invoke('simulator_appearance', { udid: device.udid, mode: next ? 'dark' : 'light' });
    } catch (cause) {
      setNotice(errorText(cause));
    }
  };

  const capture = async () => {
    if (!device || !running) return;
    try {
      if (!navigator.clipboard) throw new Error('当前环境不支持写剪贴板');
      const data = await invoke<ArrayBuffer>('simulator_capture', { udid: device.udid });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([data], { type: 'image/png' }) })]);
      setNotice('截图已复制到剪贴板');
    } catch (cause) {
      setNotice(`复制截图失败：${errorText(cause)}`);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center border-b border-[var(--border)] px-2 pb-2">
        <Popover
          width={240}
          trigger={(opened, toggle) => (
            <button
              onClick={toggle}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-[var(--bg-hover)]"
              title="选择模拟器"
            >
              <Smartphone size={13} className="shrink-0 text-[var(--text-2)]" />
              <span className="truncate text-[12.5px] text-[var(--text)]">{device?.name ?? (status ? '没有模拟器' : '正在读取…')}</span>
              {device && (
                <span className="truncate text-[11px] text-[var(--text-3)]">
                  · {device.runtime} · {running ? 'Running' : 'Stopped'}
                </span>
              )}
              <ChevronDown size={13} className={cn('ml-auto shrink-0 text-[var(--text-3)] transition-transform', opened && 'rotate-180')} />
            </button>
          )}
        >
          {(close) =>
            status?.devices.length ? (
              status.devices.map((item) => (
                <MenuItem
                  key={item.udid}
                  selected={item.udid === status.selected}
                  onClick={() => { close(); void select(item.udid); }}
                  right={<span className="text-[11px] text-[var(--text-3)]">{item.state === 'Running' ? '运行中' : '已停止'}</span>}
                >
                  {item.name}
                </MenuItem>
              ))
            ) : (
              <div className="px-3 py-2 text-[12px] leading-[18px] text-[var(--text-3)]">没有可用的 AVD</div>
            )
          }
        </Popover>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-3">
        {running && frame ? (
          <div
            tabIndex={0}
            role="img"
            aria-label="模拟器屏幕"
            className="relative h-full w-full cursor-pointer outline-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { gesture.current = null; }}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          >
            <img src={frame} alt="" draggable={false} className="h-full w-full select-none object-contain" />
            {ripple && (
              <span
                key={ripple.key}
                className="pointer-events-none absolute rounded-full border-2 border-[#3b8bf6] bg-[#3b8bf6]/20"
                style={{
                  left: ripple.x - 15,
                  top: ripple.y - 15,
                  width: 30,
                  height: 30,
                  opacity: ripple.on ? 0 : 0.9,
                  transform: ripple.on ? 'scale(1.9)' : 'scale(0.45)',
                  transition: 'opacity 420ms ease-out, transform 420ms ease-out',
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex max-w-[260px] flex-col items-center gap-2.5 text-center text-[12px] leading-[18px] text-[var(--text-3)]">
            <Smartphone size={28} />
            <span className="whitespace-pre-wrap break-words">
              {status?.error ??
                (status
                  ? running
                    ? '正在获取画面…'
                    : device
                      ? `${device.name} 已停止`
                      : '没有模拟器'
                  : '正在读取模拟器…')}
            </span>
            {device && !running && (
              <button
                type="button"
                onClick={() => void power()}
                disabled={busy}
                className="rounded-md bg-[var(--bg-hover)] px-3 py-1 text-[12px] text-[var(--text)] hover:bg-[var(--bg-active)] disabled:opacity-50"
              >
                {busy ? '正在启动…' : '启动'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--border)] px-3 py-2">
        <div className="flex items-center justify-center gap-0.5 rounded-full border border-[var(--border-strong)] px-1.5 py-1">
          <IconBtn title={running ? '关机' : '启动'} onClick={() => void power()} disabled={!device || busy}>
            <Power size={15} />
          </IconBtn>
          <IconBtn title="返回" onClick={() => void send({ kind: 'button', button: 'back' })} disabled={!running}>
            <ArrowLeft size={15} />
          </IconBtn>
          <IconBtn title="主页" onClick={() => void send({ kind: 'button', button: 'home' })} disabled={!running}>
            <Circle size={14} />
          </IconBtn>
          <IconBtn title="最近任务" onClick={() => void send({ kind: 'button', button: 'recents' })} disabled={!running}>
            <Square size={14} />
          </IconBtn>
          <IconBtn title="锁屏" onClick={() => void send({ kind: 'button', button: 'lock' })} disabled={!running}>
            <Lock size={14} />
          </IconBtn>
          <IconBtn title="切换深浅色" onClick={() => void appearance()} disabled={!running}>
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </IconBtn>
          <IconBtn title="复制截图" onClick={() => void capture()} disabled={!running}>
            <Camera size={15} />
          </IconBtn>
        </div>
        {notice && (
          <p className="mt-1.5 max-h-16 overflow-auto whitespace-pre-wrap break-words text-center text-[11px] leading-[16px] text-[var(--text-3)]">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
