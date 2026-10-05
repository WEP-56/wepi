import { useEffect, useState } from 'react';
import { ImageOff, X } from 'lucide-react';
import type { Attachment } from '../data';
import { resolveImageSrc } from '../lib/attachments';
import { cn } from '../utils/cn';

/**
 * 异步解析图片源：草稿/消息里存的可能是 data URL，
 * 也可能是被持久化剥离后只剩磁盘 path 的图片，后者按需重新读取。
 */
function useImageSrc(att: Attachment | null) {
  const [src, setSrc] = useState<string | null>(att?.value || null);
  useEffect(() => {
    if (!att) {
      setSrc(null);
      return;
    }
    let alive = true;
    setSrc(att.value || null);
    void resolveImageSrc(att).then((next) => {
      if (alive) setSrc(next);
    });
    return () => {
      alive = false;
    };
  }, [att]);
  return src;
}

/** 图片缩略图；读不到时降级为占位图标而不是破图。 */
export function AttachmentThumb({
  att,
  className,
  onClick,
  title,
}: {
  att: Attachment;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  const src = useImageSrc(att);
  if (!src) {
    return (
      <span className={cn('flex items-center justify-center bg-[var(--bg-hover)] text-[var(--text-3)]', className)}>
        <ImageOff size={16} />
      </span>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title ?? att.name} className="block focus:outline-none">
        <img src={src} alt={att.name} className={className} draggable={false} />
      </button>
    );
  }
  return <img src={src} alt={att.name} title={title ?? att.name} className={className} draggable={false} />;
}

/** 查看原图：全屏浮层，Esc 或点击空白关闭。 */
export function ImageViewer({ att, onClose }: { att: Attachment | null; onClose: () => void }) {
  const src = useImageSrc(att);
  useEffect(() => {
    if (!att) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [att, onClose]);
  if (!att) return null;
  return (
    <div
      className="fade-in fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-black/80 p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {src ? (
        <img
          src={src}
          alt={att.name}
          className="max-h-[80vh] max-w-[90vw] rounded-xl object-contain shadow-2xl shadow-black/60"
          draggable={false}
        />
      ) : (
        <div className="rounded-xl bg-white/10 px-6 py-8 text-[13.5px] text-white/70">图片已不可用（源文件可能已被移动）</div>
      )}
      <div className="max-w-[70vw] truncate font-mono text-[12px] text-white/60">{att.path || att.name}</div>
      <button
        type="button"
        onClick={onClose}
        title="关闭（Esc）"
        className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
      >
        <X size={17} />
      </button>
    </div>
  );
}
