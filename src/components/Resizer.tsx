import { cn } from '../utils/cn';

/**
 * 开始一次横向拖拽。onMove 收到 clientX；返回 false 表示结束本次拖拽（例如侧栏被拖到极限后直接隐藏）。
 */
export function startDrag(onMove: (clientX: number) => boolean | void) {
  const move = (ev: PointerEvent) => {
    if (onMove(ev.clientX) === false) stop();
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

export function ResizeHandle({ onStart, className }: { onStart: () => void; className?: string }) {
  return (
    <div
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        onStart();
      }}
      className={cn(
        'absolute top-0 z-30 h-full w-[6px] cursor-col-resize bg-transparent transition-colors hover:bg-[var(--blue)]/40 active:bg-[var(--blue)]/60',
        className,
      )}
    />
  );
}
