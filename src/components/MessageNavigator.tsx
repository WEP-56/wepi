import { useId, useState, type CSSProperties } from 'react';
import { Bookmark } from 'lucide-react';
import type { Message } from '../data';

function plain(text: string) {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/gm, '')
    .trim();
}

function previewOf(message: Message) {
  const lines = plain(message.content).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0] ?? (message.thinking ? '正在思考…' : message.streaming ? '正在输入…' : '（空消息）');
  return { title: first.slice(0, 60), body: [first.slice(60), ...lines.slice(1)].filter(Boolean).join('\n') };
}

export default function MessageNavigator({ messages, activeIndex, onJump }: {
  messages: Message[];
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const previewId = useId();
  if (messages.length < 2) return null;
  const selected = hover === null ? undefined : messages[hover];
  const preview = selected ? previewOf(selected) : null;

  return (
    <nav
      aria-label="会话导航"
      className="message-nav"
      onMouseLeave={() => setHover(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHover(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { setHover(null); return; }
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
          : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
        if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
      }}
    >
      <div className="message-nav-track" style={{ height: messages.length * 10 }}>
        {messages.map((message, index) => {
          const distance = hover === null ? Infinity : Math.abs(index - hover);
          const width = distance < 4 ? [26, 20, 14, 9][distance] : 6;
          return (
            <button
              key={message.id}
              type="button"
              className="message-nav-mark"
              aria-label={`跳转到第 ${index + 1} 条消息：${plain(message.content).slice(0, 40)}`}
              aria-current={index === activeIndex ? 'location' : undefined}
              aria-describedby={index === hover ? previewId : undefined}
              data-hovered={index === hover || undefined}
              onMouseEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onClick={() => onJump(index)}
              style={{ '--mark-width': `${width}px` } as CSSProperties}
            >
              <span />
            </button>
          );
        })}
        {preview && hover !== null && (
          <div
            id={previewId}
            role="tooltip"
            className="message-nav-preview"
            style={{ top: `clamp(60px, ${(hover + 0.5) / messages.length * 100}%, max(60px, 100% - 60px))` }}
          >
            <div className="message-nav-preview-heading">
              <span>{preview.title}</span>
              <Bookmark size={14} strokeWidth={1.5} aria-hidden="true" />
            </div>
            {preview.body && <div className="message-nav-preview-body">{preview.body}</div>}
          </div>
        )}
      </div>
    </nav>
  );
}
